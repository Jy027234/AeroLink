import type { Prisma } from '@prisma/client';
import { AppError } from '../middleware/errorHandler.js';
import {
  toOrderStatusEnum,
  toQuotationStatusEnum,
  toRfqStatusEnum,
} from './transactionStatusShadows.js';

export const TRANSACTION_STATUS_ENTITY_TYPES = ['RFQ', 'QUOTATION', 'ORDER'] as const;
export type TransactionStatusEntityType = (typeof TRANSACTION_STATUS_ENTITY_TYPES)[number];

type StateTransactionClient = Pick<
  Prisma.TransactionClient,
  'rFQ' | 'quotation' | 'order' | 'transactionStatusHistory'
>;

type TransitionMetadata = {
  actorId?: string | null;
  reasonCode: string;
  reason?: string | null;
  expectedVersion?: number;
};

type RfqTransition = TransitionMetadata & {
  id: string;
  currentStatus: string;
  currentVersion: number;
  nextStatus: string;
  data?: Omit<Prisma.RFQUpdateManyMutationInput, 'status' | 'statusEnum' | 'version'>;
};

type QuotationTransition = TransitionMetadata & {
  id: string;
  currentStatus: string;
  currentVersion: number;
  nextStatus: string;
  data?: Omit<Prisma.QuotationUncheckedUpdateManyInput, 'status' | 'statusEnum' | 'version'>;
};

type OrderTransition = TransitionMetadata & {
  id: string;
  currentStatus: string;
  currentVersion: number;
  nextStatus: string;
  data?: Omit<Prisma.OrderUpdateManyMutationInput, 'status' | 'statusEnum' | 'version'>;
};

type InitialStatusHistory = {
  entityType: TransactionStatusEntityType;
  entityId: string;
  toStatus: string;
  reasonCode: string;
  reason?: string | null;
  actorId?: string | null;
  version: number;
};

export class StateTransitionConflictError extends AppError {
  constructor() {
    super('该单据状态已被其他操作更新，请刷新后重试', 409, 'STATE_CONFLICT');
  }
}

function assertExpectedVersion(currentVersion: number, expectedVersion?: number) {
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    throw new StateTransitionConflictError();
  }
}

async function recordStatusHistory(
  tx: StateTransactionClient,
  entry: InitialStatusHistory & { fromStatus?: string | null },
) {
  return tx.transactionStatusHistory.create({
    data: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      fromStatus: entry.fromStatus ?? null,
      toStatus: entry.toStatus,
      reasonCode: entry.reasonCode,
      reason: entry.reason?.trim() || null,
      actorId: entry.actorId ?? null,
      version: entry.version,
    },
  });
}

export async function createInitialStatusHistory(
  tx: StateTransactionClient,
  entry: InitialStatusHistory,
) {
  return recordStatusHistory(tx, entry);
}

export async function transitionRfqStatus(tx: StateTransactionClient, transition: RfqTransition) {
  assertExpectedVersion(transition.currentVersion, transition.expectedVersion);
  const nextStatus = toRfqStatusEnum(transition.nextStatus);
  if (!nextStatus) {
    throw new AppError('RFQ状态无效', 400, 'INVALID_STATE_TRANSITION');
  }

  const result = await tx.rFQ.updateMany({
    where: {
      id: transition.id,
      status: transition.currentStatus,
      version: transition.currentVersion,
    },
    data: {
      ...transition.data,
      status: nextStatus,
      statusEnum: nextStatus,
      version: { increment: 1 },
    },
  });

  if (result.count !== 1) {
    throw new StateTransitionConflictError();
  }

  const updated = await tx.rFQ.findUnique({ where: { id: transition.id } });
  if (!updated) {
    throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
  }

  await recordStatusHistory(tx, {
    entityType: 'RFQ',
    entityId: updated.id,
    fromStatus: transition.currentStatus,
    toStatus: nextStatus,
    reasonCode: transition.reasonCode,
    reason: transition.reason,
    actorId: transition.actorId,
    version: updated.version,
  });

  return updated;
}

export async function transitionQuotationStatus(tx: StateTransactionClient, transition: QuotationTransition) {
  assertExpectedVersion(transition.currentVersion, transition.expectedVersion);
  const nextStatus = toQuotationStatusEnum(transition.nextStatus);
  if (!nextStatus) {
    throw new AppError('报价状态无效', 400, 'INVALID_STATE_TRANSITION');
  }

  const result = await tx.quotation.updateMany({
    where: {
      id: transition.id,
      status: transition.currentStatus,
      version: transition.currentVersion,
    },
    data: {
      ...transition.data,
      status: nextStatus,
      statusEnum: nextStatus,
      version: { increment: 1 },
    },
  });

  if (result.count !== 1) {
    throw new StateTransitionConflictError();
  }

  const updated = await tx.quotation.findUnique({ where: { id: transition.id } });
  if (!updated) {
    throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
  }

  await recordStatusHistory(tx, {
    entityType: 'QUOTATION',
    entityId: updated.id,
    fromStatus: transition.currentStatus,
    toStatus: nextStatus,
    reasonCode: transition.reasonCode,
    reason: transition.reason,
    actorId: transition.actorId,
    version: updated.version,
  });

  return updated;
}

export async function transitionOrderStatus(tx: StateTransactionClient, transition: OrderTransition) {
  assertExpectedVersion(transition.currentVersion, transition.expectedVersion);
  const nextStatus = toOrderStatusEnum(transition.nextStatus);
  if (!nextStatus) {
    throw new AppError('订单状态无效', 400, 'INVALID_STATE_TRANSITION');
  }

  const result = await tx.order.updateMany({
    where: {
      id: transition.id,
      status: transition.currentStatus,
      version: transition.currentVersion,
    },
    data: {
      ...transition.data,
      status: nextStatus,
      statusEnum: nextStatus,
      version: { increment: 1 },
    },
  });

  if (result.count !== 1) {
    throw new StateTransitionConflictError();
  }

  const updated = await tx.order.findUnique({ where: { id: transition.id } });
  if (!updated) {
    throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
  }

  await recordStatusHistory(tx, {
    entityType: 'ORDER',
    entityId: updated.id,
    fromStatus: transition.currentStatus,
    toStatus: nextStatus,
    reasonCode: transition.reasonCode,
    reason: transition.reason,
    actorId: transition.actorId,
    version: updated.version,
  });

  return updated;
}
