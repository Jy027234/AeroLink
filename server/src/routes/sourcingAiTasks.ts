import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import {
  SOURCING_AI_TASK_MAX_ATTEMPTS,
  SUPPLIER_QUOTE_EXTRACTION_TASK,
} from '../lib/sourcingAiTaskService.js';
import prisma from '../lib/prisma.js';

const router = Router();
const createSchema = z.object({
  type: z.literal(SUPPLIER_QUOTE_EXTRACTION_TASK),
  emailId: z.string().trim().min(1),
  inquiryId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict();

const taskSelect = {
  id: true,
  actorId: true,
  type: true,
  emailId: true,
  inquiryId: true,
  status: true,
  attempt: true,
  maxAttempts: true,
  draftId: true,
  errorSummary: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  cancelledAt: true,
  updatedAt: true,
} as const;

function isAdmin(req: AuthRequest) {
  return ['admin', 'administrator'].includes(req.user?.role.toLowerCase() ?? '');
}

function taskScope(req: AuthRequest) {
  return isAdmin(req) ? {} : { actorId: req.user!.id };
}

function publicTask(task: Record<string, unknown>) {
  const asIso = (value: unknown) => value instanceof Date ? value.toISOString() : null;
  return {
    id: task.id,
    actorId: task.actorId,
    type: task.type,
    emailId: task.emailId,
    inquiryId: task.inquiryId,
    status: task.status,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    draftId: task.draftId,
    errorSummary: task.errorSummary,
    createdAt: asIso(task.createdAt),
    startedAt: asIso(task.startedAt),
    completedAt: asIso(task.completedAt),
    cancelledAt: asIso(task.cancelledAt),
    updatedAt: asIso(task.updatedAt),
  };
}

function taskNotFound(): never {
  throw new AppError('任务不存在', 404, 'RESOURCE_NOT_FOUND');
}

router.post(
  '/',
  requireCapability('agent', 'run'),
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'create'),
  validateBody(createSchema),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const input = req.body as z.infer<typeof createSchema>;
    let task;
    let created = true;
    try {
      task = await prisma.sourcingAiTask.create({
        data: {
          actorId: req.user!.id,
          type: input.type,
          emailId: input.emailId,
          inquiryId: input.inquiryId,
          idempotencyKey: input.idempotencyKey,
          status: 'PENDING',
          attempt: 1,
          maxAttempts: SOURCING_AI_TASK_MAX_ATTEMPTS,
        },
        select: taskSelect,
      });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'P2002') throw error;
      task = await prisma.sourcingAiTask.findUnique({
        where: { actorId_idempotencyKey: { actorId: req.user!.id, idempotencyKey: input.idempotencyKey } },
        select: taskSelect,
      });
      if (!task) throw error;
      if (task.type !== input.type || task.emailId !== input.emailId || task.inquiryId !== input.inquiryId) {
        throw new AppError('幂等键已用于其他任务参数', 409, 'IDEMPOTENCY_KEY_REUSED');
      }
      created = false;
    }

    res.status(created ? 201 : 200).json({ success: true, data: publicTask(task) });
  }),
);

router.get(
  '/',
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const emailId = typeof req.query.emailId === 'string' ? req.query.emailId.trim() : '';
    const inquiryId = typeof req.query.inquiryId === 'string' ? req.query.inquiryId.trim() : '';
    if (Boolean(emailId) !== Boolean(inquiryId)) {
      throw new AppError('emailId 与 inquiryId 必须同时提供', 400, 'VALIDATION_ERROR');
    }
    const exactPairFilter = Boolean(emailId && inquiryId);
    const rawLimit = Number(req.query.limit ?? 50);
    const take = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 50;
    const tasks = await prisma.sourcingAiTask.findMany({
      where: { ...taskScope(req), ...(exactPairFilter ? { emailId, inquiryId } : {}) },
      orderBy: { createdAt: 'desc' },
      ...(!exactPairFilter || req.query.limit !== undefined ? { take } : {}),
      select: taskSelect,
    });
    res.json({ success: true, data: tasks.map((task) => publicTask(task)) });
  }),
);

router.get(
  '/:id',
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const task = await prisma.sourcingAiTask.findFirst({
      where: { id: req.params.id, ...taskScope(req) },
      select: taskSelect,
    });
    if (!task) taskNotFound();
    res.json({ success: true, data: publicTask(task) });
  }),
);

router.post(
  '/:id/retry',
  requireCapability('agent', 'run'),
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'create'),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const existing = await prisma.sourcingAiTask.findFirst({
      where: { id: req.params.id, ...taskScope(req) },
      select: taskSelect,
    });
    if (!existing) taskNotFound();
    if (existing.status !== 'FAILED' || existing.attempt >= existing.maxAttempts) {
      throw new AppError('当前任务不可重试', 409, 'STATE_CONFLICT');
    }
    const requeued = await prisma.sourcingAiTask.updateMany({
      where: {
        id: existing.id,
        actorId: existing.actorId,
        status: 'FAILED',
        maxAttempts: existing.maxAttempts,
        attempt: { equals: existing.attempt, lt: existing.maxAttempts },
      },
      data: {
        status: 'PENDING',
        attempt: { increment: 1 },
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        draftId: null,
        errorSummary: null,
      },
    });
    if (requeued.count !== 1) {
      throw new AppError('任务状态已变化，请重新加载', 409, 'STATE_CONFLICT');
    }
    const task = await prisma.sourcingAiTask.findUniqueOrThrow({ where: { id: existing.id }, select: taskSelect });
    res.json({ success: true, data: publicTask(task) });
  }),
);

router.post(
  '/:id/cancel',
  requireCapability('agent', 'run'),
  requireCapability('email', 'read'),
  requireCapability('supplier_quote', 'create'),
  asyncHandler(async (request, res) => {
    const req = request as AuthRequest;
    const existing = await prisma.sourcingAiTask.findFirst({
      where: { id: req.params.id, ...taskScope(req) },
      select: taskSelect,
    });
    if (!existing) taskNotFound();
    if (!['PENDING', 'FAILED', 'RUNNING'].includes(existing.status)) {
      throw new AppError('当前任务不可取消', 409, 'STATE_CONFLICT');
    }
    const cancelledAt = new Date();
    const update = await prisma.sourcingAiTask.updateMany({
      where: { id: existing.id, actorId: existing.actorId, status: existing.status },
      data: { status: 'CANCELLED', cancelledAt },
    });
    if (update.count !== 1) {
      throw new AppError('任务状态已变化，请重新加载', 409, 'STATE_CONFLICT');
    }
    const task = await prisma.sourcingAiTask.findUniqueOrThrow({ where: { id: existing.id }, select: taskSelect });
    res.json({ success: true, data: publicTask(task) });
  }),
);

export default router;
