import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { isRfqStatusTransitionAllowed, normalizeRfqStatus, toUiRfqStatus } from '../../lib/rfqStateMachine.js';
import { createInitialStatusHistory, transitionRfqStatus } from '../../lib/transactionStateService.js';
import { toRfqStatusEnum } from '../../lib/transactionStatusShadows.js';

export { createInitialStatusHistory, transitionRfqStatus, normalizeRfqStatus, toUiRfqStatus };

function buildRfqNumber() {
  return `RFQ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

export async function createRfqAggregate(
  tx: Prisma.TransactionClient,
  data: Omit<Prisma.RFQUncheckedCreateInput, 'rfqNumber' | 'status' | 'statusEnum' | 'version'>,
  actorId: string,
) {
  const created = await tx.rFQ.create({
    data: {
      ...data,
      rfqNumber: buildRfqNumber(),
      status: 'PENDING',
      statusEnum: toRfqStatusEnum('PENDING')!,
    },
    include: { customer: true },
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

export function updateRfqAggregate(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.RFQUpdateInput,
) {
  return tx.rFQ.update({
    where: { id },
    data,
    include: {
      customer: true,
      creator: { select: { id: true, name: true } },
    },
  });
}

export function assertRfqTransition(current: string, target: string) {
  const normalizedCurrent = normalizeRfqStatus(current);
  const normalizedTarget = normalizeRfqStatus(target);
  if (!normalizedCurrent || !normalizedTarget || !isRfqStatusTransitionAllowed(current, normalizedTarget)) {
    throw new AppError(`需求单状态不能从 ${normalizedCurrent || current} 转为 ${normalizedTarget || target}`, 409, 'INVALID_STATE_TRANSITION');
  }
  return normalizedTarget;
}
