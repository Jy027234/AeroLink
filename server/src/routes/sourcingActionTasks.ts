import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { runWithRequestContext } from '../lib/requestContext.js';
import { sendInquiryCommand } from '../lib/inquirySendCommand.js';
import { selectSupplierQuoteWinnerInTransaction } from '../lib/supplierQuoteSelectWinnerCommand.js';
import { assertWinnerTaskReadAccess, captureWinnerTargetVersion, SELECT_WINNER_ACTION } from '../lib/sourcingWinnerTaskService.js';
import {
  captureInquirySendTargetVersion,
  assertInquirySendTargetOpen,
  parseInquirySendContentSnapshot,
  SEND_INQUIRY_ACTION,
  SOURCING_ACTION_TASK_MAX_ATTEMPTS,
} from '../lib/sourcingActionTaskService.js';
import prisma from '../lib/prisma.js';

const router: ReturnType<typeof Router> = Router();
const contentSchema = z.object({
  subject: z.string().trim().min(1).max(255).refine(value =>
    !value.includes('\r') && !value.includes('\n') && !value.includes('\u0000'), '主题不能包含换行符'),
  textBody: z.string().trim().min(1).max(20_000).refine(value =>
    !value.includes('\u0000'), '正文包含无效字符'),
}).strict();
const createSendSchema = z.object({
  action: z.literal(SEND_INQUIRY_ACTION),
  targetId: z.string().trim().min(1).max(200),
  content: contentSchema,
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict();
const createWinnerSchema = z.object({
  action: z.literal(SELECT_WINNER_ACTION),
  targetId: z.string().trim().min(1).max(200),
  expectedUpdatedAt: z.string().datetime().optional(),
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict();
const createSchema = z.discriminatedUnion('action', [createSendSchema, createWinnerSchema]);
const confirmSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

const taskSelect = {
  id: true,
  actorId: true,
  action: true,
  targetType: true,
  targetId: true,
  targetInquiryId: true,
  targetSupplierQuoteId: true,
  targetVersion: true,
  version: true,
  contentSnapshotJson: true,
  requestId: true,
  idempotencyKey: true,
  status: true,
  attempt: true,
  maxAttempts: true,
  confirmedById: true,
  confirmedAt: true,
  retriedById: true,
  retryHistoryJson: true,
  cancelledById: true,
  outboundEmailId: true,
  resultJson: true,
  errorSummary: true,
  createdAt: true,
  completedAt: true,
  cancelledAt: true,
  updatedAt: true,
  outboundEmail: {
    select: { id: true, status: true, sentAt: true, createdAt: true, updatedAt: true },
  },
} as const;
type SelectedActionTask = Prisma.SourcingActionTaskGetPayload<{ select: typeof taskSelect }>;

function isAdmin(req: AuthRequest) {
  return ['admin', 'administrator'].includes(req.user?.role.toLowerCase() ?? '');
}

function taskScope(req: AuthRequest) {
  return isAdmin(req) ? {} : { actorId: req.user!.id };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : null;
}

function publicTask(task: SelectedActionTask) {
  const outboundEmail = task.outboundEmail;
  return {
    id: task.id,
    actorId: task.actorId,
    action: task.action,
    targetType: task.targetType,
    targetId: task.targetId,
    targetVersion: task.targetVersion,
    version: task.version,
    contentSnapshot: parseJson(task.contentSnapshotJson),
    requestId: task.requestId,
    idempotencyKey: task.idempotencyKey,
    status: task.status,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    confirmedById: task.confirmedById,
    confirmedAt: iso(task.confirmedAt),
    retriedById: task.retriedById,
    retryHistory: Array.isArray(parseJson(task.retryHistoryJson)) ? parseJson(task.retryHistoryJson) : [],
    cancelledById: task.cancelledById,
    outboundEmailId: task.outboundEmailId,
    result: parseJson(task.resultJson),
    errorSummary: task.errorSummary,
    outboundEmail: outboundEmail ? {
      id: outboundEmail.id,
      status: outboundEmail.status,
      deliveryIssue: outboundEmail.status === 'FAILED'
        ? '邮件投递失败，请检查邮件账户及服务端日志'
        : outboundEmail.status === 'NEEDS_VERIFICATION' ? '投递结果待人工核实' : null,
      sentAt: iso(outboundEmail.sentAt),
      createdAt: iso(outboundEmail.createdAt),
      updatedAt: iso(outboundEmail.updatedAt),
    } : null,
    createdAt: iso(task.createdAt),
    completedAt: iso(task.completedAt),
    cancelledAt: iso(task.cancelledAt),
    updatedAt: iso(task.updatedAt),
  };
}

function taskNotFound(): never {
  throw new AppError('任务不存在', 404, 'RESOURCE_NOT_FOUND');
}

async function canReadCurrentTarget(req: AuthRequest, task: SelectedActionTask) {
  try {
    await prisma.$transaction(async (tx) => {
      if (task.action === SEND_INQUIRY_ACTION) {
        await captureInquirySendTargetVersion(tx, req.user!, task.targetId, 'read');
      } else if (task.action === SELECT_WINNER_ACTION) {
        await assertWinnerTaskReadAccess(tx, req.user!, task.targetId);
      } else taskNotFound();
    });
    return true;
  } catch (error) {
    if (error instanceof AppError && ['RESOURCE_NOT_FOUND', 'AUTH_FORBIDDEN'].includes(error.code)) return false;
    throw error;
  }
}

function assertSelectWinnerTask(task: {
  action: string;
  targetType: string;
  targetInquiryId: string | null;
  targetSupplierQuoteId: string | null;
  targetId: string;
  outboundEmailId: string | null;
}) {
  if (task.action !== SELECT_WINNER_ACTION || task.targetType !== 'SUPPLIER_QUOTE'
    || !task.targetSupplierQuoteId || task.targetSupplierQuoteId !== task.targetId
    || task.targetInquiryId || task.outboundEmailId) {
    throw new AppError('任务动作或目标类型不受此接口支持', 409, 'STATE_CONFLICT');
  }
}

function assertCurrentActionCapability(req: AuthRequest, action: string) {
  if (action === SEND_INQUIRY_ACTION) assertCapability(req.user!, 'supplier_quote', 'create');
  else if (action === SELECT_WINNER_ACTION) assertCapability(req.user!, 'supplier_quote', 'update');
  else throw new AppError('任务动作不受支持', 409, 'STATE_CONFLICT');
}

function assertSendInquiryTask(task: {
  action: string;
  targetType: string;
  targetInquiryId: string | null;
  targetSupplierQuoteId: string | null;
  targetId: string;
}) {
  if (task.action !== SEND_INQUIRY_ACTION || task.targetType !== 'INQUIRY'
    || !task.targetInquiryId || task.targetInquiryId !== task.targetId || task.targetSupplierQuoteId) {
    throw new AppError('任务动作或目标类型不受此接口支持', 409, 'STATE_CONFLICT');
  }
}

function safeFailureSummary(error: AppError, action: string) {
  if (action === SELECT_WINNER_ACTION) return 'WINNER_PRECONDITION_FAILED';
  return error.code === 'RESOURCE_CONFLICT' ? 'SEND_CONFIGURATION_INVALID' : 'SEND_PRECONDITION_FAILED';
}

async function markFailedAfterRolledBackCommand(req: AuthRequest, taskId: string, action: string, error: unknown) {
  if (!(error instanceof AppError) || error.statusCode !== 409) return;
  await prisma.sourcingActionTask.updateMany({
    where: {
      id: taskId,
      ...taskScope(req),
      status: 'WAITING_HUMAN',
      outboundEmailId: null,
      resultJson: null,
    },
    data: { status: 'FAILED', errorSummary: safeFailureSummary(error, action) },
  });
}

async function replayCompletedTask(req: AuthRequest, taskId: string, expectedVersion: number) {
  const task = await prisma.sourcingActionTask.findFirst({
    where: { id: taskId, ...taskScope(req) },
    select: taskSelect,
  });
  if (!task) taskNotFound();
  if (task.status !== 'COMPLETED' || task.version !== expectedVersion) return null;
  assertCurrentActionCapability(req, task.action);
  if (task.action === SEND_INQUIRY_ACTION) {
    assertSendInquiryTask(task);
    if (!task.outboundEmailId || !task.resultJson) {
      throw new AppError('已完成任务缺少排队结果，需要人工核实', 409, 'STATE_CONFLICT');
    }
  } else {
    assertSelectWinnerTask(task);
    if (!task.resultJson) throw new AppError('已完成任务缺少中选结果，需要人工核实', 409, 'STATE_CONFLICT');
  }
  await prisma.$transaction(async (tx) => {
    if (task.action === SEND_INQUIRY_ACTION) await captureInquirySendTargetVersion(tx, req.user!, task.targetId, 'read');
    else await assertWinnerTaskReadAccess(tx, req.user!, task.targetId);
  });
  return task;
}

router.post(
  '/',
  validateBody(createSchema),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const input = req.body as z.infer<typeof createSchema>;
    assertCurrentActionCapability(req, input.action);
    const contentSnapshotJson = input.action === SEND_INQUIRY_ACTION ? JSON.stringify(input.content) : null;
    let task: SelectedActionTask;
    let created = true;
    const requestId = randomUUID();

    try {
      task = await prisma.$transaction(async (tx) => {
        let targetVersion: string;
        let targetType: 'INQUIRY' | 'SUPPLIER_QUOTE';
        if (input.action === SEND_INQUIRY_ACTION) {
          const { inquiry, targetVersion: inquiryVersion } = await captureInquirySendTargetVersion(tx, req.user!, input.targetId);
          assertInquirySendTargetOpen(inquiry);
          if (inquiry.status !== 'DRAFT') {
            throw new AppError('只有草稿询价可以创建发送任务', 409, 'STATE_CONFLICT');
          }
          if (!inquiry.items.length) throw new AppError('询价没有需求明细，无法创建发送任务', 409, 'STATE_CONFLICT');
          targetVersion = inquiryVersion;
          targetType = 'INQUIRY';
        } else {
          const prepared = await captureWinnerTargetVersion(tx, req.user!, input.targetId);
          if (input.expectedUpdatedAt && prepared.quote.updatedAt.toISOString() !== input.expectedUpdatedAt) {
            throw new AppError('报价版本已变化，请刷新比价后重新核对', 409, 'STATE_CONFLICT');
          }
          targetVersion = prepared.targetVersion;
          targetType = 'SUPPLIER_QUOTE';
        }
        return tx.sourcingActionTask.create({
          data: {
            actorId: req.user!.id,
            action: input.action,
            targetType,
            targetId: input.targetId,
            ...(targetType === 'INQUIRY'
              ? { targetInquiryId: input.targetId }
              : { targetSupplierQuoteId: input.targetId }),
            targetVersion,
            version: 1,
            contentSnapshotJson,
            requestId,
            idempotencyKey: input.idempotencyKey,
            status: 'WAITING_HUMAN',
            attempt: 1,
            maxAttempts: SOURCING_ACTION_TASK_MAX_ATTEMPTS,
          },
          select: taskSelect,
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'P2002') throw error;
      const existing = await prisma.sourcingActionTask.findUnique({
        where: { actorId_idempotencyKey: { actorId: req.user!.id, idempotencyKey: input.idempotencyKey } },
        select: taskSelect,
      });
      if (!existing) throw error;
      if (existing.action !== input.action || existing.targetId !== input.targetId
        || existing.contentSnapshotJson !== contentSnapshotJson) {
        throw new AppError('幂等键已用于其他任务参数', 409, 'IDEMPOTENCY_KEY_REUSED');
      }
      if (!await canReadCurrentTarget(req, existing)) taskNotFound();
      task = existing;
      created = false;
    }

    res.status(created ? 201 : 200).json({ success: true, data: publicTask(task) });
  }),
);

router.get(
  '/',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const targetId = typeof req.query.targetId === 'string' ? req.query.targetId.trim() : '';
    const rawLimit = Number(req.query.limit ?? 50);
    const take = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 50;
    const tasks = await prisma.sourcingActionTask.findMany({
      where: { ...taskScope(req), ...(targetId ? { targetId } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
      select: taskSelect,
    });
    const visible = await Promise.all(tasks.map(async (task) =>
      await canReadCurrentTarget(req, task) ? publicTask(task) : null));
    res.json({ success: true, data: visible.filter((task) => task !== null) });
  }),
);

router.get(
  '/:id',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const task = await prisma.sourcingActionTask.findFirst({
      where: { id: req.params.id, ...taskScope(req) },
      select: taskSelect,
    });
    if (!task) taskNotFound();
    if (!await canReadCurrentTarget(req, task)) taskNotFound();
    res.json({ success: true, data: publicTask(task) });
  }),
);

router.post(
  '/:id/confirm',
  validateBody(confirmSchema),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const expectedVersion = (req.body as z.infer<typeof confirmSchema>).expectedVersion;
    let task: SelectedActionTask;
    let attemptedBusinessCommand = false;
    let attemptedAction = '';
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const current = await tx.sourcingActionTask.findFirst({
          where: { id: req.params.id, ...taskScope(req) },
          select: taskSelect,
        });
        if (!current) taskNotFound();
        assertCurrentActionCapability(req, current.action);
        if (current.action === SEND_INQUIRY_ACTION) assertSendInquiryTask(current);
        else assertSelectWinnerTask(current);
        if (current.version !== expectedVersion) {
          throw new AppError('任务版本已变化，请重新加载后确认', 409, 'STATE_CONFLICT');
        }

        if (current.status === 'COMPLETED') {
          if (!current.resultJson || (current.action === SEND_INQUIRY_ACTION && !current.outboundEmailId)) {
            throw new AppError('已完成任务缺少执行结果，需要人工核实', 409, 'STATE_CONFLICT');
          }
          if (current.action === SEND_INQUIRY_ACTION) await captureInquirySendTargetVersion(tx, req.user!, current.targetId, 'read');
          else await assertWinnerTaskReadAccess(tx, req.user!, current.targetId);
          return { kind: 'task' as const, task: current };
        }
        if (current.status !== 'WAITING_HUMAN') {
          throw new AppError('当前任务不可确认', 409, 'STATE_CONFLICT');
        }

        let targetVersion: string;
        let winnerUpdatedAt: Date | null = null;
        if (current.action === SEND_INQUIRY_ACTION) {
          targetVersion = (await captureInquirySendTargetVersion(tx, req.user!, current.targetId)).targetVersion;
        } else {
          const captured = await captureWinnerTargetVersion(tx, req.user!, current.targetId);
          targetVersion = captured.targetVersion;
          winnerUpdatedAt = captured.quote.updatedAt;
        }
        if (targetVersion !== current.targetVersion) {
          const failed = await tx.sourcingActionTask.updateMany({
            where: {
              id: current.id,
              actorId: current.actorId,
              version: current.version,
              targetVersion: current.targetVersion,
              status: 'WAITING_HUMAN',
              outboundEmailId: null,
              resultJson: null,
            },
            data: { status: 'FAILED', errorSummary: 'SOURCE_VERSION_CHANGED' },
          });
          if (failed.count !== 1) throw new AppError('任务状态已变化，请重新加载', 409, 'STATE_CONFLICT');
          return { kind: 'stale' as const };
        }

        attemptedBusinessCommand = true;
        attemptedAction = current.action;
        const now = new Date();
        let outboundEmailId: string | null = null;
        let resultJson: string;
        if (current.action === SEND_INQUIRY_ACTION) {
          const content = parseInquirySendContentSnapshot(current.contentSnapshotJson ?? '');
          const { inquiry, queuedInquiry, outboundEmail, outboxEvent } = await runWithRequestContext(
            current.requestId,
            () => sendInquiryCommand(tx, req.user!, current.targetId, content),
          );
          outboundEmailId = outboundEmail.id;
          resultJson = JSON.stringify({
            inquiryId: inquiry.id,
            inquiryStatus: queuedInquiry.status,
            outboundEmailId: outboundEmail.id,
            outboundEmailStatus: outboundEmail.status,
            outboxEventId: outboxEvent.id,
          });
        } else {
          const winner = await selectSupplierQuoteWinnerInTransaction(
            tx, current.targetId, req.user!, winnerUpdatedAt!,
          );
          resultJson = JSON.stringify({
            supplierQuoteId: winner.id,
            rfqLineId: winner.rfqLineId,
            isWinner: winner.isWinner,
            status: winner.status,
          });
        }
        const updated = await tx.sourcingActionTask.updateMany({
          where: {
            id: current.id,
            actorId: current.actorId,
            version: current.version,
            targetVersion: current.targetVersion,
            status: 'WAITING_HUMAN',
            outboundEmailId: null,
            resultJson: null,
          },
          data: {
            status: 'COMPLETED',
            confirmedById: req.user!.id,
            confirmedAt: now,
            outboundEmailId,
            resultJson,
            errorSummary: null,
            completedAt: now,
          },
        });
        if (updated.count !== 1) throw new AppError('任务状态已变化，请重新加载', 409, 'STATE_CONFLICT');
        const completed = await tx.sourcingActionTask.findUniqueOrThrow({
          where: { id: current.id },
          select: taskSelect,
        });
        return { kind: 'task' as const, task: completed };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      if (outcome.kind === 'stale') {
        throw new AppError('任务来源在创建后已变化；请重新创建任务以确认新版本', 409, 'STATE_CONFLICT');
      }
      task = outcome.task;
    } catch (error) {
      if (attemptedBusinessCommand) await markFailedAfterRolledBackCommand(req, req.params.id, attemptedAction, error);
      const replay = await replayCompletedTask(req, req.params.id, expectedVersion);
      if (replay) task = replay;
      else throw error;
    }
    res.json({ success: true, data: publicTask(task) });
  }),
);

router.post(
  '/:id/retry',
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const task = await prisma.$transaction(async (tx) => {
      const existing = await tx.sourcingActionTask.findFirst({
        where: { id: req.params.id, ...taskScope(req) },
        select: taskSelect,
      });
      if (!existing) taskNotFound();
      assertCurrentActionCapability(req, existing.action);
      if (existing.action === SEND_INQUIRY_ACTION) assertSendInquiryTask(existing);
      else assertSelectWinnerTask(existing);
      if (existing.status !== 'FAILED' || existing.outboundEmailId || existing.resultJson
        || existing.confirmedById || existing.attempt >= existing.maxAttempts) {
        throw new AppError('当前任务不可安全重试', 409, 'STATE_CONFLICT');
      }
      const { targetVersion } = existing.action === SEND_INQUIRY_ACTION
        ? await captureInquirySendTargetVersion(tx, req.user!, existing.targetId)
        : await captureWinnerTargetVersion(tx, req.user!, existing.targetId);
      if (targetVersion !== existing.targetVersion) {
        throw new AppError('任务来源已变化，必须创建新任务确认新版本', 409, 'STATE_CONFLICT');
      }
      const updated = await tx.sourcingActionTask.updateMany({
        where: {
          id: existing.id,
          actorId: existing.actorId,
          status: 'FAILED',
          version: existing.version,
          targetVersion: existing.targetVersion,
          outboundEmailId: null,
          resultJson: null,
          confirmedById: null,
          attempt: { equals: existing.attempt, lt: existing.maxAttempts },
        },
      data: {
          status: 'WAITING_HUMAN',
          attempt: { increment: 1 },
          version: { increment: 1 },
          retriedById: req.user!.id,
          retryHistoryJson: JSON.stringify([
            ...(Array.isArray(parseJson(existing.retryHistoryJson)) ? parseJson(existing.retryHistoryJson) as unknown[] : []),
            { actorId: req.user!.id, attempt: existing.attempt + 1, occurredAt: new Date().toISOString() },
          ]),
          errorSummary: null,
          cancelledAt: null,
          completedAt: null,
        },
      });
      if (updated.count !== 1) throw new AppError('任务状态已变化，请重新加载', 409, 'STATE_CONFLICT');
      return tx.sourcingActionTask.findUniqueOrThrow({ where: { id: existing.id }, select: taskSelect });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.json({ success: true, data: publicTask(task) });
  }),
);

router.post(
  '/:id/cancel',
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const task = await prisma.$transaction(async (tx) => {
      const existing = await tx.sourcingActionTask.findFirst({
        where: { id: req.params.id, ...taskScope(req) },
        select: taskSelect,
      });
      if (!existing) taskNotFound();
      assertCurrentActionCapability(req, existing.action);
      if (existing.action === SEND_INQUIRY_ACTION) assertSendInquiryTask(existing);
      else assertSelectWinnerTask(existing);
      if (!['WAITING_HUMAN', 'FAILED'].includes(existing.status)
        || existing.outboundEmailId || existing.resultJson) {
        throw new AppError('当前任务不可取消', 409, 'STATE_CONFLICT');
      }
      if (existing.action === SEND_INQUIRY_ACTION) await captureInquirySendTargetVersion(tx, req.user!, existing.targetId, 'read');
      else await assertWinnerTaskReadAccess(tx, req.user!, existing.targetId);
      const cancelledAt = new Date();
      const cancelled = await tx.sourcingActionTask.updateMany({
        where: {
          id: existing.id,
          actorId: existing.actorId,
          version: existing.version,
          status: existing.status,
          outboundEmailId: null,
          resultJson: null,
        },
        data: {
          status: 'CANCELLED',
          cancelledAt,
          cancelledById: req.user!.id,
          version: { increment: 1 },
        },
      });
      if (cancelled.count !== 1) throw new AppError('任务状态已变化，请重新加载', 409, 'STATE_CONFLICT');
      return tx.sourcingActionTask.findUniqueOrThrow({ where: { id: existing.id }, select: taskSelect });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.json({ success: true, data: publicTask(task) });
  }),
);

export default router;
