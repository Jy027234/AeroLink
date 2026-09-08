import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { isRfqStatusTransitionAllowed, normalizeRfqStatus, toUiRfqStatus } from '../../lib/rfqStateMachine.js';
import { createInitialStatusHistory, StateTransitionConflictError, transitionRfqStatus } from '../../lib/transactionStateService.js';
import { toRfqStatusEnum } from '../../lib/transactionStatusShadows.js';
import { legacyRfqLineData, changesLegacyRfqLine } from './legacyLine.js';

export { createInitialStatusHistory, transitionRfqStatus, normalizeRfqStatus, toUiRfqStatus };

function buildRfqNumber() {
  return `RFQ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

export async function createRfqAggregate(
  tx: Prisma.TransactionClient,
  data: Omit<Prisma.RFQUncheckedCreateInput, 'rfqNumber' | 'status' | 'statusEnum' | 'version' | 'lines'>,
  actorId: string,
) {
  const created = await tx.rFQ.create({
    data: {
      ...data,
      rfqNumber: buildRfqNumber(),
      status: 'PENDING',
      statusEnum: toRfqStatusEnum('PENDING')!,
      lines: { create: legacyRfqLineData(data) },
    },
    include: { customer: true, lines: { orderBy: { lineNo: 'asc' } } },
  });

  await createInitialStatusHistory(tx, {
    entityType: 'RFQ',
    entityId: created.id,
    toStatus: created.status,
    reasonCode: 'RFQ_CREATED',
    actorId,
    version: created.version,
  });

  if (created.emailId) {
    await tx.email.update({
      where: { id: created.emailId },
      data: {
        processingStatus: 'PROCESSED',
        processedAt: new Date(),
        discardedAt: null,
        isRead: true,
      },
    });
  }

  return created;
}

export async function updateRfqAggregate(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.RFQUpdateInput,
) {
  const existing = await tx.rFQ.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNo: 'asc' } }, _count: { select: { quotations: true, inquiries: true, supplierQuotes: true } } },
  });
  if (!existing) throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
  const changesLine = changesLegacyRfqLine(existing, data);
  const customerChange = ('customerId' in data && (data as Record<string, unknown>).customerId !== existing.customerId)
    || (data.customer !== undefined && data.customer.connect?.id !== existing.customerId);
  if (changesLine && existing.lines.length > 1) {
    throw new AppError('多行需求必须按需求行修改，不能使用旧单行编辑入口', 409, 'LINE_ID_REQUIRED');
  }
  if ((changesLine || customerChange) && (existing._count.quotations > 0 || existing._count.inquiries > 0 || existing._count.supplierQuotes > 0)) {
    throw new AppError('已有询价或报价引用该需求，请建立新的需求版本以修改客户、件号、数量或交付要求', 409, 'RFQ_SOURCE_ALREADY_USED');
  }
  const updated = await tx.rFQ.update({
    where: { id, version: existing.version },
    data: { ...data, version: { increment: 1 } },
    include: {
      customer: true,
      creator: { select: { id: true, name: true } },
      lines: { orderBy: { lineNo: 'asc' } },
    },
  }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
      throw new StateTransitionConflictError();
    }
    throw error;
  });
  if (changesLine || updated.lines.length === 0) {
    const lineData = legacyRfqLineData(updated);
    const line = await tx.rfqLine.upsert({
      where: { rfqId_lineNo: { rfqId: id, lineNo: 1 } },
      create: { ...lineData, rfqId: id },
      update: lineData,
    });
    return { ...updated, lines: [line] };
  }
  return updated;
}

export function assertRfqTransition(current: string, target: string) {
  const normalizedCurrent = normalizeRfqStatus(current);
  const normalizedTarget = normalizeRfqStatus(target);
  if (!normalizedCurrent || !normalizedTarget || !isRfqStatusTransitionAllowed(current, normalizedTarget)) {
    throw new AppError(`需求单状态不能从 ${normalizedCurrent || current} 转为 ${normalizedTarget || target}`, 409, 'INVALID_STATE_TRANSITION');
  }
  return normalizedTarget;
}
