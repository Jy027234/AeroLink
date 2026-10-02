import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { extractSupplierQuoteEmail } from './aiService.js';
import { supplierQuoteDraftPayloadSchema } from './validation.js';
import prisma from './prisma.js';
import { createOriginalAiCandidateSnapshot } from './sourcingAiCandidateSnapshot.js';
import { buildRfqReadScope } from './rfqAccess.js';
import { getCapabilityScope, hasCapability, type CapabilityActor } from './capabilityPolicy.js';
import { AppError, type ErrorCode } from '../middleware/errorHandler.js';

export const SUPPLIER_QUOTE_EXTRACTION_TASK = 'supplier_quote_extraction';
export const SOURCING_AI_TASK_MAX_ATTEMPTS = 3;

type DraftPayload = ReturnType<typeof supplierQuoteDraftPayloadSchema.parse>;

export const SOURCING_AI_TASK_LEASE_TIMEOUT_MS = 15 * 60 * 1000;

class SafeTaskFailure extends Error {
  constructor(
    readonly summary: string,
    readonly status = 409,
    readonly code: ErrorCode = 'STATE_CONFLICT',
  ) {
    super(summary);
  }
}

type SourcingTaskSourceDatabase = Pick<Prisma.TransactionClient, 'user' | 'email' | 'inquiry' | 'inquiryEmailLink'>;

type SourcingTaskSourceSnapshot = {
  email: {
    id: string;
    subject: string;
    body: string;
    type: string;
    processingStatus: string;
    discardedAt: Date | null;
    receivedAt: Date;
    rfq: { id: string } | null;
  };
  inquiry: {
    id: string;
    inquiryNumber: string;
    supplierId: string;
    rfqId: string | null;
    status: string;
    sentAt: Date | null;
    items: Array<{ id: string; lineNo: number; rfqLineId: string | null; partNumber: string; quantity: number }>;
    rfq: { id: string; createdBy: string; status: string; version: number; creator: { department: string | null } | null } | null;
  };
  link: {
    id: string;
    emailId: string;
    inquiryId: string;
    method: string;
    manualReason: string | null;
    confirmationStatus: string;
    confirmedAt: Date | null;
    confirmedById: string | null;
    createdAt: Date;
  };
};

function inquiryReadScope(actor: CapabilityActor): Prisma.InquiryWhereInput {
  const linked = { rfq: { is: buildRfqReadScope(actor) } } satisfies Prisma.InquiryWhereInput;
  // Match the inquiry routes: an unbound historical inquiry is only visible
  // when the actor's RFQ read capability spans all RFQs.
  return getCapabilityScope(actor, 'rfq.read') === 'all' ? { OR: [linked, { rfqId: null }] } : linked;
}

function assertSourcingTaskCapabilities(actor: CapabilityActor) {
  const required = [
    ['agent', 'run'],
    ['email', 'read'],
    ['supplier_quote', 'create'],
  ] as const;
  if (required.some(([resource, action]) => !hasCapability(actor, resource, action))) {
    throw new SafeTaskFailure('任务发起人当前无权执行报价邮件提取', 403, 'AUTH_FORBIDDEN');
  }
}

async function loadSourcingTaskSourceSnapshot(
  database: SourcingTaskSourceDatabase,
  actorId: string,
  emailId: string,
  inquiryId: string,
): Promise<SourcingTaskSourceSnapshot> {
  const actor = await database.user.findUnique({
    where: { id: actorId },
    select: { id: true, role: true, department: true, isActive: true },
  });
  if (!actor || !actor.isActive) {
    throw new SafeTaskFailure('任务发起人当前不可用', 403, 'AUTH_FORBIDDEN');
  }
  assertSourcingTaskCapabilities(actor);

  const [email, inquiry, link] = await Promise.all([
    database.email.findUnique({
      where: { id: emailId },
      select: {
        id: true, subject: true, body: true, type: true, processingStatus: true,
        discardedAt: true, receivedAt: true, rfq: { select: { id: true } },
      },
    }),
    database.inquiry.findFirst({
      where: { id: inquiryId, ...inquiryReadScope(actor) },
      select: {
        id: true,
        inquiryNumber: true,
        supplierId: true,
        rfqId: true,
        status: true,
        sentAt: true,
        items: {
          orderBy: { lineNo: 'asc' },
          select: { id: true, lineNo: true, rfqLineId: true, partNumber: true, quantity: true },
        },
        rfq: {
          select: {
            id: true,
            createdBy: true,
            status: true,
            version: true,
            creator: { select: { department: true } },
          },
        },
      },
    }),
    database.inquiryEmailLink.findUnique({
      where: { emailId_inquiryId: { emailId, inquiryId } },
      select: {
        id: true, emailId: true, inquiryId: true, method: true, manualReason: true,
        confirmationStatus: true, confirmedAt: true, confirmedById: true, createdAt: true,
      },
    }),
  ]);

  if (!email || !inquiry) {
    throw new SafeTaskFailure('源邮件或当前无权访问的询价单不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  if (inquiry.rfqId && !inquiry.rfq) {
    throw new SafeTaskFailure('关联 RFQ 不存在或当前无权访问', 404, 'RESOURCE_NOT_FOUND');
  }
  if (inquiry.rfq && !hasCapability(actor, 'rfq', 'read', {
    ownerId: inquiry.rfq.createdBy,
    department: inquiry.rfq.creator?.department,
  })) {
    throw new SafeTaskFailure('当前无权访问关联 RFQ', 404, 'RESOURCE_NOT_FOUND');
  }
  if (!inquiry.rfqId && getCapabilityScope(actor, 'rfq.read') !== 'all') {
    throw new SafeTaskFailure('当前无权访问未关联 RFQ 的询价单', 404, 'RESOURCE_NOT_FOUND');
  }
  if (email.discardedAt || email.processingStatus.trim().toUpperCase() === 'DISCARDED'
    || email.type.trim().toUpperCase() === 'SPAM') {
    throw new SafeTaskFailure('源邮件已丢弃或不可用于报价提取');
  }
  if (inquiry.status.trim().toUpperCase() !== 'SENT' || !inquiry.sentAt) {
    throw new SafeTaskFailure('只有已发送的询价单可用于报价邮件提取');
  }
  if (inquiry.rfq?.status.trim().toUpperCase() === 'CANCELLED') {
    throw new SafeTaskFailure('关联 RFQ 已取消，不能继续报价邮件提取');
  }
  if (email.rfq?.id && email.rfq.id !== inquiry.rfqId) {
    throw new SafeTaskFailure('源邮件与询价单关联的 RFQ 不一致');
  }
  if (!link || link.confirmationStatus.trim().toUpperCase() !== 'CONFIRMED' || !link.confirmedAt) {
    throw new SafeTaskFailure('邮件与询价单的关联尚未确认');
  }

  return { email, inquiry, link };
}

function sourceSnapshotToken(snapshot: SourcingTaskSourceSnapshot) {
  const date = (value: Date | null) => value?.toISOString() ?? null;
  const serialized = JSON.stringify({
    email: {
      id: snapshot.email.id,
      subject: snapshot.email.subject,
      body: snapshot.email.body,
      type: snapshot.email.type,
      processingStatus: snapshot.email.processingStatus,
      discardedAt: date(snapshot.email.discardedAt),
      receivedAt: date(snapshot.email.receivedAt),
      rfqId: snapshot.email.rfq?.id ?? null,
    },
    inquiry: {
      id: snapshot.inquiry.id,
      inquiryNumber: snapshot.inquiry.inquiryNumber,
      supplierId: snapshot.inquiry.supplierId,
      rfqId: snapshot.inquiry.rfqId,
      status: snapshot.inquiry.status,
      sentAt: date(snapshot.inquiry.sentAt),
      items: snapshot.inquiry.items.map((item) => [item.id, item.lineNo, item.rfqLineId, item.partNumber, item.quantity]),
      rfq: snapshot.inquiry.rfq
        ? [snapshot.inquiry.rfq.id, snapshot.inquiry.rfq.createdBy, snapshot.inquiry.rfq.status,
          snapshot.inquiry.rfq.version, snapshot.inquiry.rfq.creator?.department ?? null]
        : null,
    },
    link: {
      id: snapshot.link.id,
      emailId: snapshot.link.emailId,
      inquiryId: snapshot.link.inquiryId,
      method: snapshot.link.method,
      manualReason: snapshot.link.manualReason,
      confirmationStatus: snapshot.link.confirmationStatus,
      confirmedAt: date(snapshot.link.confirmedAt),
      confirmedById: snapshot.link.confirmedById,
      createdAt: date(snapshot.link.createdAt),
    },
  });
  return createHash('sha256').update(serialized).digest('hex');
}

/** Route-level source validation and fingerprint capture; caller maps safe errors to HTTP. */
export async function captureSourcingAiTaskSourceFingerprint(
  actorId: string,
  emailId: string,
  inquiryId: string,
  database: SourcingTaskSourceDatabase = prisma,
): Promise<string> {
  try {
    const snapshot = await loadSourcingTaskSourceSnapshot(database, actorId, emailId, inquiryId);
    return sourceSnapshotToken(snapshot);
  } catch (error) {
    if (error instanceof SafeTaskFailure) throw new AppError(error.summary, error.status, error.code);
    throw error;
  }
}

function safeFailureSummary(error: unknown) {
  if (error instanceof SafeTaskFailure) return error.summary;
  if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
    return '报价草稿已被并发创建，请重新加载草稿';
  }
  return 'AI 抽取失败，请稍后重试';
}

function buildDraftPayload(
  items: Awaited<ReturnType<typeof extractSupplierQuoteEmail>>['items'],
  inquiryItems: Array<{ id: string; partNumber: string; quantity: number }>,
): DraftPayload {
  return supplierQuoteDraftPayloadSchema.parse({
    items: items.map((item) => {
      const extractedPartNumber = item.partNumber?.trim().toUpperCase() ?? null;
      const exactMatches = extractedPartNumber
        ? inquiryItems.filter((inquiryItem) => inquiryItem.partNumber.trim().toUpperCase() === extractedPartNumber)
        : [];
      return {
        itemKey: randomUUID(),
        inquiryItemId: exactMatches.length === 1 ? exactMatches[0].id : null,
        partNumber: exactMatches.length === 1 ? exactMatches[0].partNumber : item.partNumber ?? null,
        quantityUnit: item.quantityUnit ?? null,
        quantity: item.quantity ?? null,
        unitPrice: item.unitPrice ?? null,
        currency: item.currency ?? null,
        leadTimeDays: item.leadTimeDays ?? null,
        leadTimeMinDays: item.leadTimeMinDays ?? null,
        leadTimeMaxDays: item.leadTimeMaxDays ?? null,
        validUntil: item.validUntil ?? null,
        condition: item.condition ?? null,
        certificate: item.certificate ?? null,
        taxIncluded: item.taxIncluded ?? null,
        freightIncluded: item.freightIncluded ?? null,
        incoterm: item.incoterm ?? null,
        evidenceText: item.evidenceText,
      };
    }),
  });
}

/** Execute only the claim represented by status=RUNNING and its startedAt token. */
async function executeClaimedSourcingAiTask(taskId: string, actorId: string, claimStartedAt: Date) {
  const claimWhere = { id: taskId, actorId, status: 'RUNNING', startedAt: claimStartedAt };
  try {
    const task = await prisma.sourcingAiTask.findFirst({
      where: claimWhere,
      select: { id: true, emailId: true, inquiryId: true, sourceFingerprint: true },
    });
    if (!task) throw new SafeTaskFailure('任务状态发生变化，请重试');
    const snapshot = await loadSourcingTaskSourceSnapshot(prisma, actorId, task.emailId, task.inquiryId);
    const sourceVersion = sourceSnapshotToken(snapshot);
    if (!task.sourceFingerprint) {
      throw new SafeTaskFailure('任务未记录来源版本，请重新创建任务');
    }
    if (sourceVersion !== task.sourceFingerprint) {
      throw new SafeTaskFailure('来源在任务入队后已变化，请重新创建任务');
    }

    let extracted: Awaited<ReturnType<typeof extractSupplierQuoteEmail>>;
    try {
      extracted = await extractSupplierQuoteEmail(
        snapshot.email.subject,
        snapshot.email.body,
        {
          inquiryId: snapshot.inquiry.id,
          inquiryNumber: snapshot.inquiry.inquiryNumber,
          items: snapshot.inquiry.items.map((item) => ({
            inquiryItemId: item.id,
            partNumber: item.partNumber,
            quantity: item.quantity,
          })),
        },
        { actorId, action: 'business.extract-supplier-quote-email' },
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'AI_PROVIDER_TIMEOUT') {
        throw new SafeTaskFailure('模型服务请求超时，请稍后重新执行抽取');
      }
      if (error instanceof AppError && error.code === 'AI_PROVIDER_CONNECTION_ERROR') {
        throw new SafeTaskFailure('模型服务连接失败，请检查网络后重新执行抽取');
      }
      if (error instanceof AppError && error.code === 'AI_QUOTE_OUTPUT_INVALID') {
        throw new SafeTaskFailure('模型返回的报价格式无效；可重试或核对原文后手工建稿');
      }
      if (error instanceof AppError && error.code === 'AI_QUOTE_EVIDENCE_INVALID') {
        throw new SafeTaskFailure('报价依据无法在本次回信中核实，可能来自引用历史；请核对原文或手工建稿');
      }
      throw new SafeTaskFailure('AI 抽取失败，请稍后重试');
    }
    const payload = buildDraftPayload(extracted.items, snapshot.inquiry.items);

    return await prisma.$transaction(async (tx) => {
      const currentTask = await tx.sourcingAiTask.findFirst({
        where: claimWhere,
        select: { id: true },
      });
      if (!currentTask) throw new SafeTaskFailure('任务状态发生变化，请重试');

      const currentSnapshot = await loadSourcingTaskSourceSnapshot(tx, actorId, task.emailId, task.inquiryId);
      const currentSourceVersion = sourceSnapshotToken(currentSnapshot);
      if (currentSourceVersion !== sourceVersion || currentSourceVersion !== task.sourceFingerprint) {
        throw new SafeTaskFailure('源邮件、询价单或关联版本已变化，未保存提取草稿');
      }

      const latestDraft = await tx.supplierQuoteDraft.findFirst({
        where: { emailId: snapshot.email.id, inquiryId: snapshot.inquiry.id },
        orderBy: { version: 'desc' },
        select: { version: true, status: true },
      });
      if (latestDraft && ['DRAFT', 'PARTIALLY_CONFIRMED'].includes(latestDraft.status)) {
        throw new SafeTaskFailure('已有未确认报价草稿，请在草稿中继续编辑');
      }

      const draft = await tx.supplierQuoteDraft.create({
        data: {
          emailId: currentSnapshot.email.id,
          inquiryId: currentSnapshot.inquiry.id,
          supplierId: currentSnapshot.inquiry.supplierId,
          status: 'DRAFT',
          version: (latestDraft?.version ?? 0) + 1,
          payloadJson: JSON.stringify({
            items: payload.items.map((item) => ({ ...item, itemKey: item.itemKey || randomUUID() })),
          }),
          aiModel: extracted.ai.model,
          aiPromptVersion: String(extracted.ai.promptVersion),
          aiMetadataJson: JSON.stringify({
            agentId: extracted.ai.agentId,
            candidateCount: extracted.items.length,
            createdById: actorId,
            originalAiCandidates: createOriginalAiCandidateSnapshot(payload.items),
          }),
        },
        select: { id: true },
      });
      const completed = await tx.sourcingAiTask.updateMany({
        where: claimWhere,
        data: {
          status: 'COMPLETED',
          draftId: draft.id,
          errorSummary: null,
          completedAt: new Date(),
        },
      });
      if (completed.count !== 1) throw new SafeTaskFailure('任务状态发生变化，请重试');
      return tx.sourcingAiTask.findUniqueOrThrow({ where: { id: taskId } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    await prisma.sourcingAiTask.updateMany({
      where: claimWhere,
      data: { status: 'FAILED', errorSummary: safeFailureSummary(error) },
    });
    return prisma.sourcingAiTask.findUniqueOrThrow({ where: { id: taskId } });
  }
}

/** Recover expired claims and execute a bounded batch of persisted pending tasks. */
export async function processPendingSourcingAiTasks(
  limit = 10,
  leaseTimeoutMs = SOURCING_AI_TASK_LEASE_TIMEOUT_MS,
) {
  const batchLimit = Math.max(1, Math.floor(limit));
  const staleBefore = new Date(Date.now() - Math.max(1, leaseTimeoutMs));
  const staleTasks = await prisma.sourcingAiTask.findMany({
    where: { status: 'RUNNING', startedAt: { lte: staleBefore } },
    orderBy: { startedAt: 'asc' },
    take: batchLimit,
    select: { id: true, attempt: true, maxAttempts: true, startedAt: true },
  });
  let recovered = 0;

  for (const task of staleTasks) {
    if (!task.startedAt) continue;
    const exhausted = task.attempt >= task.maxAttempts;
    const recovery = await prisma.sourcingAiTask.updateMany({
      where: { id: task.id, status: 'RUNNING', startedAt: task.startedAt },
      data: exhausted
        ? { status: 'FAILED', errorSummary: 'AI 任务执行超时，已达到最大尝试次数' }
        : { status: 'PENDING', attempt: { increment: 1 }, startedAt: null, errorSummary: null },
    });
    recovered += recovery.count;
  }

  const pendingTasks = await prisma.sourcingAiTask.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: batchLimit,
    select: { id: true, actorId: true, attempt: true, maxAttempts: true },
  });
  let processed = 0;

  for (const task of pendingTasks) {
    if (task.attempt > task.maxAttempts) {
      await prisma.sourcingAiTask.updateMany({
        where: { id: task.id, status: 'PENDING', attempt: task.attempt },
        data: { status: 'FAILED', errorSummary: 'AI 任务已达到最大尝试次数' },
      });
      continue;
    }

    const claimStartedAt = new Date();
    const claim = await prisma.sourcingAiTask.updateMany({
      where: {
        id: task.id,
        actorId: task.actorId,
        status: 'PENDING',
        startedAt: null,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
      },
      data: { status: 'RUNNING', startedAt: claimStartedAt, errorSummary: null },
    });
    if (claim.count !== 1) continue;

    processed += 1;
    await executeClaimedSourcingAiTask(task.id, task.actorId, claimStartedAt);
  }

  return { recovered, processed };
}
