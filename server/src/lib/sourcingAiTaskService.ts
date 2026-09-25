import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { extractSupplierQuoteEmail } from './aiService.js';
import { supplierQuoteDraftPayloadSchema } from './validation.js';
import prisma from './prisma.js';

export const SUPPLIER_QUOTE_EXTRACTION_TASK = 'supplier_quote_extraction';
export const SOURCING_AI_TASK_MAX_ATTEMPTS = 3;

type DraftPayload = ReturnType<typeof supplierQuoteDraftPayloadSchema.parse>;

export const SOURCING_AI_TASK_LEASE_TIMEOUT_MS = 15 * 60 * 1000;

class SafeTaskFailure extends Error {
  constructor(readonly summary: string) {
    super(summary);
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
      select: { id: true, emailId: true, inquiryId: true },
    });
    if (!task) throw new SafeTaskFailure('任务状态发生变化，请重试');

    const [email, inquiry, link] = await Promise.all([
      prisma.email.findUnique({
        where: { id: task.emailId },
        select: { id: true, subject: true, body: true },
      }),
      prisma.inquiry.findUnique({
        where: { id: task.inquiryId },
        select: {
          id: true,
          inquiryNumber: true,
          supplierId: true,
          items: { orderBy: { lineNo: 'asc' }, select: { id: true, partNumber: true, quantity: true } },
        },
      }),
      prisma.inquiryEmailLink.findUnique({
        where: { emailId_inquiryId: { emailId: task.emailId, inquiryId: task.inquiryId } },
        select: { confirmationStatus: true },
      }),
    ]);
    if (!email || !inquiry) throw new SafeTaskFailure('源邮件或询价单不存在');
    if (!link || link.confirmationStatus !== 'CONFIRMED') {
      throw new SafeTaskFailure('邮件与询价单的关联尚未确认');
    }

    let extracted: Awaited<ReturnType<typeof extractSupplierQuoteEmail>>;
    try {
      extracted = await extractSupplierQuoteEmail(
        email.subject,
        email.body,
        {
          inquiryId: inquiry.id,
          inquiryNumber: inquiry.inquiryNumber,
          items: inquiry.items.map((item) => ({
            inquiryItemId: item.id,
            partNumber: item.partNumber,
            quantity: item.quantity,
          })),
        },
        { actorId, action: 'business.extract-supplier-quote-email' },
      );
    } catch {
      throw new SafeTaskFailure('AI 抽取失败，请稍后重试');
    }
    const payload = buildDraftPayload(extracted.items, inquiry.items);

    return await prisma.$transaction(async (tx) => {
      const currentTask = await tx.sourcingAiTask.findFirst({
        where: claimWhere,
        select: { id: true },
      });
      if (!currentTask) throw new SafeTaskFailure('任务状态发生变化，请重试');

      const [currentEmail, currentInquiry, currentLink] = await Promise.all([
        tx.email.findUnique({ where: { id: task.emailId }, select: { id: true } }),
        tx.inquiry.findUnique({ where: { id: task.inquiryId }, select: { id: true, supplierId: true } }),
        tx.inquiryEmailLink.findUnique({
          where: { emailId_inquiryId: { emailId: task.emailId, inquiryId: task.inquiryId } },
          select: { confirmationStatus: true },
        }),
      ]);
      if (!currentEmail || !currentInquiry) throw new SafeTaskFailure('源邮件或询价单不存在');
      if (!currentLink || currentLink.confirmationStatus !== 'CONFIRMED') {
        throw new SafeTaskFailure('邮件与询价单的关联尚未确认');
      }

      const latestDraft = await tx.supplierQuoteDraft.findFirst({
        where: { emailId: email.id, inquiryId: inquiry.id },
        orderBy: { version: 'desc' },
        select: { version: true, status: true },
      });
      if (latestDraft?.status === 'DRAFT') {
        throw new SafeTaskFailure('已有未确认报价草稿，请在草稿中继续编辑');
      }

      const draft = await tx.supplierQuoteDraft.create({
        data: {
          emailId: email.id,
          inquiryId: inquiry.id,
          supplierId: currentInquiry.supplierId,
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
