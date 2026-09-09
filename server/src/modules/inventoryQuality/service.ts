import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { assertActiveQuotationRevision } from '../../lib/quotationRevisionPolicy.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { StateTransitionConflictError, transitionOrderStatus } from '../../lib/transactionStateService.js';
import { syncOrderLineState, syncQuotationLineState } from '../../lib/transactionLineService.js';
import { consumeFulfillmentReview } from './fulfillmentReview.js';
import {
  assertInventoryUseAllowed,
  assertNoOpenReturnHold,
  assertNoReturnHistory,
  assertReservationReleaseAllowed,
} from './returnGuards.js';

export function assertInventoryQuantityAdjustmentAllowed(status: string, quantityProvided: boolean) {
  if (quantityProvided && status !== 'AVAILABLE') {
    throw new AppError('预留或隔离库存不能直接调整数量', 409, 'RESOURCE_CONFLICT');
  }
}

function hasActiveAllocation(allocatedQuantity: unknown): allocatedQuantity is number {
  return typeof allocatedQuantity === 'number' && Number.isInteger(allocatedQuantity) && allocatedQuantity > 0;
}

function assertNoActiveAllocation(allocatedQuantity: unknown) {
  if (hasActiveAllocation(allocatedQuantity)) {
    throw new AppError('库存明细存在现代分配，不能使用旧库存入口处理数量或预留', 409, 'RESOURCE_CONFLICT');
  }
}

function assertLegacyInventorySource(detail: { stockLotKey?: string }) {
  if (detail.stockLotKey && detail.stockLotKey !== 'LEGACY') {
    throw new AppError('采购验收库存必须通过订单行分配及受控出入库流程处理', 409, 'RESOURCE_CONFLICT');
  }
}

function hasIdentityMutation(detailData: Prisma.InventoryDetailUncheckedUpdateInput) {
  return ['serialNumber', 'batchNumber', 'conditionCode'].some((field) => (
    Object.prototype.hasOwnProperty.call(detailData, field)
  ));
}

function hasStatusMutation(detailData: Prisma.InventoryDetailUncheckedUpdateInput) {
  return Object.prototype.hasOwnProperty.call(detailData, 'status');
}

function hasSharedItemIdentityMutation(itemData: Prisma.InventoryItemUpdateInput) {
  return ['partNumber', 'trackingType', 'unitOfMeasure'].some((field) => (
    Object.prototype.hasOwnProperty.call(itemData, field)
  ));
}

function hasProtectedDetailMutation(detailData: Prisma.InventoryDetailUncheckedUpdateInput) {
  return ['quantity', 'status', 'serialNumber', 'batchNumber', 'conditionCode'].some((field) => (
    Object.prototype.hasOwnProperty.call(detailData, field)
  ));
}

function requestedStatus(detailData: Prisma.InventoryDetailUncheckedUpdateInput) {
  const value = detailData.status;
  return typeof value === 'string' ? value.toUpperCase() : undefined;
}

function updateValue(value: unknown) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'set')) {
    return (value as { set?: unknown }).set;
  }
  return value;
}

function fieldChanged(existing: unknown, update: unknown) {
  return updateValue(update) !== existing;
}

function removeUnchangedDetailIdentity(
  existing: { serialNumber?: unknown; batchNumber?: unknown; conditionCode?: unknown },
  detailData: Prisma.InventoryDetailUncheckedUpdateInput,
) {
  const next = { ...detailData } as Record<string, unknown>;
  for (const field of ['serialNumber', 'batchNumber', 'conditionCode'] as const) {
    if (Object.prototype.hasOwnProperty.call(next, field)
      && !fieldChanged(existing[field], next[field])) {
      delete next[field];
    }
  }
  return next as Prisma.InventoryDetailUncheckedUpdateInput;
}

/**
 * Physical identity is an audit fact after an allocation or a legacy outbound.
 * Released/consumed allocations remain rows, so checking allocatedQuantity alone
 * is insufficient and would allow a caller to erase the identity history.
 */
export async function assertInventoryDetailIdentityMutable(
  tx: Prisma.TransactionClient,
  detailId: string,
) {
  const [allocation, outbound] = await Promise.all([
    tx.inventoryAllocation.findFirst({
      where: { inventoryDetailId: detailId },
      select: { id: true },
    }),
    tx.inventoryTransaction.findFirst({
      where: { inventoryDetailId: detailId, type: 'OUTBOUND' },
      select: { id: true },
    }),
  ]);
  if (allocation || outbound) {
    throw new AppError('库存明细已有分配或出库历史，不能修改序列号、批次或条件状态', 409, 'RESOURCE_CONFLICT');
  }
}

/**
 * InventoryItem is shared by all of its details. Once any detail has a
 * allocation or inventory ledger row, changing the shared part identity would
 * rewrite the meaning of historical records for sibling details as well.
 */
export async function assertInventoryItemIdentityMutable(
  tx: Prisma.TransactionClient,
  inventoryItemId: string,
) {
  const [allocation, transaction] = await Promise.all([
    tx.inventoryAllocation.findFirst({
      where: { inventoryDetail: { inventoryItemId } },
      select: { id: true },
    }),
    tx.inventoryTransaction.findFirst({
      where: { inventoryDetail: { inventoryItemId } },
      select: { id: true },
    }),
  ]);
  if (allocation || transaction) {
    throw new AppError('同一件号下已有分配或库存流水，不能修改共享主件件号、追踪类型或单位', 409, 'RESOURCE_CONFLICT');
  }
}

export function normalizeInventoryCode(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : fallback;
}

export async function createInventoryAggregate(
  tx: Prisma.TransactionClient,
  args: {
    item: Prisma.InventoryItemUncheckedCreateInput;
    detail: Omit<Prisma.InventoryDetailUncheckedCreateInput, 'inventoryItemId'>;
    include: Prisma.InventoryDetailInclude;
    actorId: string;
    notes?: string;
    /** Internal receipt command only; never populated from generic inventory DTOs. */
    receipt?: { stockReceiptLineId: string; receiptNumber: string };
  },
) {
  // A stock receipt must not silently overwrite the shared part master;
  // master changes are explicit through PATCH /inventory/:id.
  const item = await tx.inventoryItem.upsert({
    where: { partNumber: args.item.partNumber },
    create: args.item,
    update: {},
  });
  const detail = await tx.inventoryDetail.create({
    // Allocation ownership is established only by the server-side allocation
    // service. A receipt can never seed a client-supplied modern allocation.
    data: { ...args.detail, allocatedQuantity: 0, inventoryItemId: item.id,
      stockLotKey: args.receipt?.stockReceiptLineId ?? 'LEGACY' },
    include: args.include,
  });

  if (detail.quantity > 0) {
    await tx.inventoryTransaction.create({
      data: {
        inventoryDetailId: detail.id,
        type: 'INBOUND',
        quantity: detail.quantity,
        beforeQuantity: 0,
        afterQuantity: detail.quantity,
        referenceType: args.receipt ? 'PURCHASE_RECEIPT' : 'MANUAL',
        ...(args.receipt ? { stockReceiptLineId: args.receipt.stockReceiptLineId,
          referenceNo: args.receipt.receiptNumber } : {}),
        notes: args.notes?.trim() || 'Manual inventory receipt.',
        createdBy: args.actorId,
      },
    });
  }

  return detail;
}

export async function updateInventoryAggregate(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    itemData: Prisma.InventoryItemUpdateInput;
    detailData: Prisma.InventoryDetailUncheckedUpdateInput;
    include: Prisma.InventoryDetailInclude;
    quantityProvided: boolean;
    quantity?: number;
    actorId: string;
    notes?: string;
  },
) {
  const existing = await tx.inventoryDetail.findUnique({ where: { id: args.id }, include: args.include });
  if (!existing) throw new AppError('库存不存在', 404, 'RESOURCE_NOT_FOUND');
  if (Object.prototype.hasOwnProperty.call(args.detailData, 'allocatedQuantity')
    || Object.prototype.hasOwnProperty.call(args.detailData, 'stockLotKey')) {
    throw new AppError('库存分配量与来源只能由服务端受控流程维护', 400, 'VALIDATION_ERROR');
  }

  // Supplying the current identity value is a no-op. Remove it before the
  // protected update so an active allocation is not rejected for an identity
  // write that does not actually change anything.
  const detailData = removeUnchangedDetailIdentity(existing, args.detailData);
  const quantityProvided = args.quantityProvided || Object.prototype.hasOwnProperty.call(detailData, 'quantity');
  if (quantityProvided || hasIdentityMutation(detailData)) assertLegacyInventorySource(existing);
  assertInventoryQuantityAdjustmentAllowed(existing.status, quantityProvided);
  const protectedDetailMutation = hasProtectedDetailMutation(detailData);
  const detailIdentityMutation = hasIdentityMutation(detailData);
  let itemIdentityMutation = false;
  if (hasSharedItemIdentityMutation(args.itemData)) {
    const itemIdentity = (existing as typeof existing & {
      inventoryItem?: { partNumber?: unknown; trackingType?: unknown; unitOfMeasure?: unknown } | null;
    }).inventoryItem ?? await tx.inventoryItem.findUnique({
      where: { id: existing.inventoryItemId },
      select: { partNumber: true, trackingType: true, unitOfMeasure: true },
    });
    itemIdentityMutation = (['partNumber', 'trackingType', 'unitOfMeasure'] as const).some((field) => (
      Object.prototype.hasOwnProperty.call(args.itemData, field)
      && fieldChanged(itemIdentity?.[field], args.itemData[field])
    ));
  }
  const identityMutation = detailIdentityMutation || itemIdentityMutation;
  const statusMutation = hasStatusMutation(detailData);
  const nextStatus = requestedStatus(detailData);
  const activeAllocation = hasActiveAllocation(existing.allocatedQuantity);
  const safeQuarantineStatusMutation = activeAllocation
    && statusMutation
    && nextStatus === 'QUARANTINED'
    && !quantityProvided
    && !identityMutation;
  if (activeAllocation && statusMutation && !safeQuarantineStatusMutation) {
    throw new AppError('存在现代分配时只能将库存标记为 QUARANTINED，不能伪造预留或释放状态', 409, 'RESOURCE_CONFLICT');
  }
  if ((quantityProvided || identityMutation) && hasActiveAllocation(existing.allocatedQuantity)) {
    throw new AppError('库存明细存在现代分配，不能修改数量或物理身份', 409, 'RESOURCE_CONFLICT');
  }

  if (protectedDetailMutation || itemIdentityMutation) {
    await assertNoOpenReturnHold(tx, args.id);
  }

  if (detailIdentityMutation) {
    await assertInventoryDetailIdentityMutable(tx, args.id);
  }

  if (itemIdentityMutation) {
    const activeDetail = await tx.inventoryDetail.findFirst({
      where: { inventoryItemId: existing.inventoryItemId, allocatedQuantity: { gt: 0 } },
      select: { id: true },
    });
    if (activeDetail) {
      throw new AppError('同一件号下已有现代分配，不能修改共享主件身份', 409, 'RESOURCE_CONFLICT');
    }
    await assertInventoryItemIdentityMutable(tx, existing.inventoryItemId);
  }

  if (Object.keys(args.itemData).length > 0) {
    await tx.inventoryItem.update({ where: { id: existing.inventoryItemId }, data: args.itemData });
  }

  let updated;
  if (Object.keys(detailData).length === 0) {
    updated = existing;
  } else if (protectedDetailMutation) {
    const detailWhere: Prisma.InventoryDetailWhereInput = {
      id: args.id,
      allocatedQuantity: safeQuarantineStatusMutation ? { gt: 0 } : 0,
      ...(quantityProvided ? { quantity: existing.quantity } : {}),
      ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : {}),
    };
    const updatedDetail = await tx.inventoryDetail.updateMany({
      where: detailWhere,
      data: detailData,
    });
    if (updatedDetail.count !== 1) throw new StateTransitionConflictError();
    updated = await tx.inventoryDetail.findUnique({ where: { id: args.id }, include: args.include });
    if (!updated) throw new StateTransitionConflictError();
  } else {
    updated = await tx.inventoryDetail.update({
      where: { id: args.id },
      data: detailData,
      include: args.include,
    });
  }
  if (!updated) throw new StateTransitionConflictError();
  const quantityDelta = args.quantity === undefined ? 0 : args.quantity - existing.quantity;
  if (quantityDelta !== 0) {
    await tx.inventoryTransaction.create({
      data: {
        inventoryDetailId: updated.id,
        type: 'ADJUSTMENT',
        quantity: quantityDelta,
        beforeQuantity: existing.quantity,
        afterQuantity: updated.quantity,
        referenceType: 'MANUAL',
        notes: args.notes?.trim() || 'Manual inventory adjustment.',
        createdBy: args.actorId,
      },
    });
  }

  return { existing, updated, quantityDelta };
}

export async function deleteInventoryAggregate(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    include: Prisma.InventoryDetailInclude;
  },
) {
  const detail = await tx.inventoryDetail.findUnique({ where: { id: args.id }, include: args.include });
  if (!detail) throw new AppError('库存不存在', 404, 'RESOURCE_NOT_FOUND');
  if (detail.quantity !== 0) {
    throw new AppError('库存数量不为零，不能物理删除；请先通过调整流水清零', 409, 'RESOURCE_CONFLICT');
  }

  const [legacyRecord, transaction, certificate] = await Promise.all([
    tx.inventory.findUnique({ where: { id: detail.id } }),
    tx.inventoryTransaction.findFirst({ where: { inventoryDetailId: detail.id } }),
    tx.certificate.findFirst({ where: { inventoryDetailId: detail.id } }),
  ]);
  if (legacyRecord) {
    throw new AppError('迁移自旧库存的记录只读保留，请使用隔离或报废状态归档', 409, 'RESOURCE_CONFLICT');
  }
  if (transaction || certificate) {
    throw new AppError('库存明细已有流水或证书关联，不能物理删除', 409, 'RESOURCE_CONFLICT');
  }

  await assertNoReturnHistory(tx, detail.id);

  const allocation = await tx.inventoryAllocation.findFirst({
    where: { inventoryDetailId: detail.id },
    select: { id: true },
  });
  if (allocation) {
    throw new AppError('库存明细已有现代分配历史，不能物理删除', 409, 'RESOURCE_CONFLICT');
  }

  await tx.inventoryDetail.delete({ where: { id: detail.id } });
  const remainingDetails = await tx.inventoryDetail.count({ where: { inventoryItemId: detail.inventoryItemId } });
  if (remainingDetails === 0) {
    await tx.inventoryItem.delete({ where: { id: detail.inventoryItemId } });
  }

  return detail;
}

const RESERVABLE_QUOTATION_STATUSES = new Set(['APPROVED', 'SENT', 'ACCEPTED']);
const OUTBOUND_ORDER_STATUSES = new Set(['SO_CREATED', 'PO_CREATED']);

function assertPartNumberMatches(inventoryPartNumber: string, documentPartNumber: string, documentName: string) {
  if (inventoryPartNumber !== documentPartNumber) {
    throw new AppError(`库存件号与${documentName}件号不一致，不能继续处理`, 409, 'RESOURCE_CONFLICT');
  }
}

/**
 * Reserve one canonical inventory detail for a quotation (and its order, when
 * one already exists).  The route intentionally remains a thin HTTP adapter;
 * all cross-aggregate reads, optimistic writes, ledger creation and outbox
 * emission happen in this transaction service.
 */
export async function reserveInventoryForQuotation(
  tx: Prisma.TransactionClient,
  args: { inventoryDetailId: string; quotationId: string; quantity: number; notes?: string; actorId: string },
) {
  const [detail, quotation] = await Promise.all([
    tx.inventoryDetail.findUnique({
      where: { id: args.inventoryDetailId },
      include: { inventoryItem: true },
    }),
    tx.quotation.findUnique({ where: { id: args.quotationId } }),
  ]);

  if (!detail) throw new AppError('库存明细不存在', 404, 'RESOURCE_NOT_FOUND');
  if (!quotation) throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
  assertNoActiveAllocation(detail.allocatedQuantity);
  assertLegacyInventorySource(detail);
  await assertInventoryUseAllowed(tx, detail);
  assertActiveQuotationRevision(quotation);
  if (quotation.lineItemsMode) throw new AppError('多行报价需要行级数量分配，暂不能使用旧整单库存接口', 409, 'RESOURCE_CONFLICT');
  if (!RESERVABLE_QUOTATION_STATUSES.has(quotation.status)) {
    throw new AppError('只有已审批、已发送或已接受的报价可以预留库存', 409, 'INVALID_STATE_TRANSITION');
  }
  assertPartNumberMatches(detail.inventoryItem.partNumber, quotation.partNumber, '报价');
  if (args.quantity > quotation.quantity) {
    throw new AppError('预留数量不能超过报价数量', 409, 'RESOURCE_CONFLICT');
  }
  if (quotation.reservedQuantity > 0) {
    throw new AppError('该报价已经存在未释放的库存预留', 409, 'RESOURCE_CONFLICT');
  }
  if (quotation.inventoryDetailId && quotation.inventoryDetailId !== detail.id) {
    throw new AppError('该报价已绑定其他库存明细，不能切换预留库存', 409, 'RESOURCE_CONFLICT');
  }
  if (detail.status !== 'AVAILABLE') {
    throw new AppError('当前库存明细不可预留', 409, 'RESOURCE_CONFLICT');
  }
  if (detail.quantity < args.quantity) {
    throw new AppError('库存数量不足', 409, 'RESOURCE_CONFLICT');
  }

  const order = await tx.order.findFirst({ where: { quotationId: quotation.id } });
  if (order) {
    assertPartNumberMatches(detail.inventoryItem.partNumber, order.partNumber, '订单');
    if (!OUTBOUND_ORDER_STATUSES.has(order.status)) {
      throw new AppError('当前订单状态不能预留库存', 409, 'INVALID_STATE_TRANSITION');
    }
    if (order.inventoryDetailId && order.inventoryDetailId !== detail.id) {
      throw new AppError('该订单已绑定其他库存明细，不能切换预留库存', 409, 'RESOURCE_CONFLICT');
    }
    if (args.quantity > order.quantity - order.outboundQuantity) {
      throw new AppError('预留数量不能超过订单待出库数量', 409, 'RESOURCE_CONFLICT');
    }
  }

  const reservedDetail = await tx.inventoryDetail.updateMany({
    where: { id: detail.id, status: 'AVAILABLE', allocatedQuantity: 0, quantity: { gte: args.quantity } },
    data: { status: 'RESERVED' },
  });
  if (reservedDetail.count !== 1) throw new StateTransitionConflictError();

  const updatedQuotation = await tx.quotation.updateMany({
    where: {
      id: quotation.id,
      status: quotation.status,
      version: quotation.version,
      inventoryDetailId: quotation.inventoryDetailId,
      reservedQuantity: 0,
    },
    data: {
      inventoryDetailId: detail.id,
      serialNumber: detail.serialNumber,
      batchNumber: detail.batchNumber,
      reservedQuantity: args.quantity,
      version: { increment: 1 },
    },
  });
  if (updatedQuotation.count !== 1) throw new StateTransitionConflictError();

  if (order) {
    const updatedOrder = await tx.order.updateMany({
      where: {
        id: order.id,
        quotationId: quotation.id,
        status: order.status,
        version: order.version,
        inventoryDetailId: order.inventoryDetailId,
      },
      data: {
        inventoryDetailId: detail.id,
        serialNumber: detail.serialNumber,
        batchNumber: detail.batchNumber,
        version: { increment: 1 },
      },
    });
    if (updatedOrder.count !== 1) throw new StateTransitionConflictError();

    await syncOrderLineState(tx, {
      ...order,
      inventoryDetailId: detail.id,
      serialNumber: detail.serialNumber,
      batchNumber: detail.batchNumber,
    });
  }

  await syncQuotationLineState(tx, {
    ...quotation,
    inventoryDetailId: detail.id,
    serialNumber: detail.serialNumber,
    batchNumber: detail.batchNumber,
    reservedQuantity: args.quantity,
  });

  const transaction = await tx.inventoryTransaction.create({
    data: {
      inventoryDetailId: detail.id,
      type: 'RESERVATION',
      quantity: 0,
      beforeQuantity: detail.quantity,
      afterQuantity: detail.quantity,
      orderId: order?.id || null,
      quotationId: quotation.id,
      referenceNo: quotation.quoteNumber,
      referenceType: 'QUOTATION',
      notes: args.notes?.trim() || null,
      createdBy: args.actorId,
    },
  });

  await enqueueBusinessEvent(tx, {
    eventType: 'inventory.reserved',
    aggregateType: 'INVENTORY_DETAIL',
    aggregateId: detail.id,
    data: {
      inventoryDetailId: detail.id,
      partNumber: detail.inventoryItem.partNumber,
      status: 'RESERVED',
      quantity: detail.quantity,
      reservedQuantity: args.quantity,
      quotationId: quotation.id,
      quoteNumber: quotation.quoteNumber,
      orderId: order?.id || null,
      transactionId: transaction.id,
      reservedBy: args.actorId,
    },
    socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED },
    createdById: args.actorId,
  });

  return {
    transaction,
    inventoryStatus: 'RESERVED',
    inventoryQuantity: detail.quantity,
    reservedQuantity: args.quantity,
    quotationVersion: quotation.version + 1,
    orderVersion: order ? order.version + 1 : undefined,
  };
}

/** Release a quotation reservation before an order exists. */
export async function releaseInventoryReservation(
  tx: Prisma.TransactionClient,
  args: { quotationId: string; notes?: string; actorId: string; updateQuotation?: boolean },
) {
  const quotation = await tx.quotation.findUnique({ where: { id: args.quotationId } });
  if (!quotation) throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
  if (quotation.lineItemsMode) throw new AppError('多行报价需要行级数量分配，暂不能使用旧整单库存接口', 409, 'RESOURCE_CONFLICT');
  if (!['APPROVED', 'SENT'].includes(quotation.status)) {
    throw new AppError('当前报价状态不能释放库存预留', 409, 'INVALID_STATE_TRANSITION');
  }
  if (!quotation.inventoryDetailId || quotation.reservedQuantity <= 0) {
    throw new AppError('该报价没有可释放的库存预留', 409, 'RESOURCE_CONFLICT');
  }

  const [detail, existingOrder] = await Promise.all([
    tx.inventoryDetail.findUnique({
      where: { id: quotation.inventoryDetailId },
      include: { inventoryItem: true },
    }),
    tx.order.findFirst({ where: { quotationId: quotation.id } }),
  ]);
  if (!detail) throw new AppError('预留库存明细不存在', 404, 'RESOURCE_NOT_FOUND');
  assertNoActiveAllocation(detail.allocatedQuantity);
  assertLegacyInventorySource(detail);
  await assertReservationReleaseAllowed(tx, detail);
  if (existingOrder) throw new AppError('报价已生成订单，不能直接释放库存预留', 409, 'INVALID_STATE_TRANSITION');
  if (detail.status !== 'RESERVED') throw new AppError('库存明细不是预留状态，无法释放', 409, 'RESOURCE_CONFLICT');
  assertPartNumberMatches(detail.inventoryItem.partNumber, quotation.partNumber, '报价');

  const releasedDetail = await tx.inventoryDetail.updateMany({
    where: { id: detail.id, status: 'RESERVED', allocatedQuantity: 0 },
    data: { status: 'AVAILABLE' },
  });
  if (releasedDetail.count !== 1) throw new StateTransitionConflictError();

  if (args.updateQuotation !== false) {
    const releasedQuotation = await tx.quotation.updateMany({
      where: {
        id: quotation.id,
        status: quotation.status,
        version: quotation.version,
        inventoryDetailId: detail.id,
        reservedQuantity: quotation.reservedQuantity,
      },
      data: { reservedQuantity: 0, version: { increment: 1 } },
    });
    if (releasedQuotation.count !== 1) throw new StateTransitionConflictError();

    await syncQuotationLineState(tx, {
      ...quotation,
      reservedQuantity: 0,
    });
  }

  const transaction = await tx.inventoryTransaction.create({
    data: {
      inventoryDetailId: detail.id,
      type: 'RESERVATION_RELEASE',
      quantity: 0,
      beforeQuantity: detail.quantity,
      afterQuantity: detail.quantity,
      quotationId: quotation.id,
      referenceNo: quotation.quoteNumber,
      referenceType: 'QUOTATION',
      notes: args.notes?.trim() || null,
      createdBy: args.actorId,
    },
  });

  await enqueueBusinessEvent(tx, {
    eventType: 'inventory.reservation.released',
    aggregateType: 'INVENTORY_DETAIL',
    aggregateId: detail.id,
    data: {
      inventoryDetailId: detail.id,
      partNumber: detail.inventoryItem.partNumber,
      status: 'AVAILABLE',
      quantity: detail.quantity,
      releasedQuantity: quotation.reservedQuantity,
      quotationId: quotation.id,
      quoteNumber: quotation.quoteNumber,
      transactionId: transaction.id,
      releasedBy: args.actorId,
      reason: args.notes?.trim() || undefined,
    },
    socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED },
    createdById: args.actorId,
  });

  return {
    transaction,
    inventoryDetailId: detail.id,
    partNumber: detail.inventoryItem.partNumber,
    inventoryStatus: 'AVAILABLE',
    inventoryQuantity: detail.quantity,
    releasedQuantity: quotation.reservedQuantity,
    reservedQuantity: 0,
    quotationVersion: quotation.version + 1,
  };
}

/** Ship inventory for an order and close the order when its quantity is met. */
export async function outboundInventoryForOrder(
  tx: Prisma.TransactionClient,
  args: { inventoryDetailId: string; orderId: string; quantity: number; notes?: string; actorId: string },
) {
  const [detail, order] = await Promise.all([
    tx.inventoryDetail.findUnique({
      where: { id: args.inventoryDetailId },
      include: { inventoryItem: true },
    }),
    tx.order.findUnique({
      where: { id: args.orderId },
      include: { quotation: true },
    }),
  ]);

  if (!detail) throw new AppError('库存明细不存在', 404, 'RESOURCE_NOT_FOUND');
  if (!order) throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
  assertNoActiveAllocation(detail.allocatedQuantity);
  assertLegacyInventorySource(detail);
  await assertInventoryUseAllowed(tx, detail);
  if (order.lineItemsMode) throw new AppError('多行订单需要行级质量审核与出库，暂不能使用旧整单库存接口', 409, 'RESOURCE_CONFLICT');
  if (!OUTBOUND_ORDER_STATUSES.has(order.status)) {
    throw new AppError('当前订单状态不能执行出库', 409, 'INVALID_STATE_TRANSITION');
  }
  assertPartNumberMatches(detail.inventoryItem.partNumber, order.partNumber, '订单');
  if (order.inventoryDetailId !== detail.id || order.quotation.inventoryDetailId !== detail.id) {
    throw new AppError('订单未绑定当前库存明细，请先完成库存预留', 409, 'RESOURCE_CONFLICT');
  }

  const remainingOrderQuantity = order.quantity - order.outboundQuantity;
  if (args.quantity > remainingOrderQuantity) {
    throw new AppError('出库数量不能超过订单待出库数量', 409, 'RESOURCE_CONFLICT');
  }

  const isReservedForOrder = detail.status === 'RESERVED';
  if (detail.status !== 'AVAILABLE' && !isReservedForOrder) {
    throw new AppError('当前库存明细不可出库', 409, 'RESOURCE_CONFLICT');
  }
  if (detail.quantity < args.quantity) throw new AppError('库存数量不足', 409, 'RESOURCE_CONFLICT');
  if (isReservedForOrder && order.quotation.reservedQuantity < args.quantity) {
    throw new AppError('本次出库数量超过该订单已预留数量', 409, 'RESOURCE_CONFLICT');
  }

  await consumeFulfillmentReview(tx, order.id, args.quantity);

  const beforeQuantity = detail.quantity;
  const afterQuantity = beforeQuantity - args.quantity;
  const nextReservedQuantity = isReservedForOrder
    ? order.quotation.reservedQuantity - args.quantity
    : order.quotation.reservedQuantity;
  const nextInventoryStatus = isReservedForOrder && nextReservedQuantity === 0 ? 'AVAILABLE' : detail.status;
  const nextOutboundQuantity = order.outboundQuantity + args.quantity;
  const nextOutboundStatus = nextOutboundQuantity === order.quantity ? 'COMPLETED' : 'PARTIAL';
  const shouldShipOrder = nextOutboundStatus === 'COMPLETED';

  const updatedDetail = await tx.inventoryDetail.updateMany({
    where: {
      id: detail.id,
      status: detail.status,
      quantity: detail.quantity,
      allocatedQuantity: 0,
      updatedAt: detail.updatedAt,
    },
    data: { quantity: afterQuantity, status: nextInventoryStatus },
  });
  if (updatedDetail.count !== 1) throw new StateTransitionConflictError();

  if (isReservedForOrder) {
    const updatedQuotation = await tx.quotation.updateMany({
      where: {
        id: order.quotation.id,
        status: order.quotation.status,
        version: order.quotation.version,
        inventoryDetailId: detail.id,
        reservedQuantity: order.quotation.reservedQuantity,
      },
      data: { reservedQuantity: nextReservedQuantity, version: { increment: 1 } },
    });
    if (updatedQuotation.count !== 1) throw new StateTransitionConflictError();

    await syncQuotationLineState(tx, {
      ...order.quotation,
      reservedQuantity: nextReservedQuantity,
    });
  }

  const transaction = await tx.inventoryTransaction.create({
    data: {
      inventoryDetailId: detail.id,
      type: 'OUTBOUND',
      quantity: -args.quantity,
      beforeQuantity,
      afterQuantity,
      orderId: order.id,
      quotationId: order.quotationId,
      referenceNo: order.orderNumber,
      referenceType: 'ORDER',
      notes: args.notes?.trim() || null,
      createdBy: args.actorId,
    },
  });

  const updatedOrder = shouldShipOrder
    ? await transitionOrderStatus(tx, {
      id: order.id,
      currentStatus: order.status,
      currentVersion: order.version,
      nextStatus: 'SHIPPED',
      actorId: args.actorId,
      reasonCode: 'OUTBOUND_COMPLETED',
      reason: args.notes?.trim() || 'Inventory outbound completed.',
      data: { outboundQuantity: nextOutboundQuantity, outboundStatus: nextOutboundStatus },
    })
    : await (async () => {
      const result = await tx.order.updateMany({
        where: { id: order.id, status: order.status, version: order.version, inventoryDetailId: detail.id },
        data: {
          outboundQuantity: nextOutboundQuantity,
          outboundStatus: nextOutboundStatus,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) throw new StateTransitionConflictError();
      return {
        ...order,
        outboundQuantity: nextOutboundQuantity,
        outboundStatus: nextOutboundStatus,
        version: order.version + 1,
      };
    })();

  if (!shouldShipOrder) {
    await syncOrderLineState(tx, updatedOrder);
  }

  await enqueueBusinessEvent(tx, {
    eventType: 'inventory.outbound',
    aggregateType: 'INVENTORY_DETAIL',
    aggregateId: detail.id,
    data: {
      inventoryDetailId: detail.id,
      partNumber: detail.inventoryItem.partNumber,
      status: nextInventoryStatus,
      beforeQuantity,
      afterQuantity,
      outboundQuantity: args.quantity,
      transactionId: transaction.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      quotationId: order.quotationId,
      shippedBy: args.actorId,
    },
    socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED },
    createdById: args.actorId,
  });
  if (shouldShipOrder) {
    await enqueueBusinessEvent(tx, {
      eventType: 'order.status.changed',
      aggregateType: 'ORDER',
      aggregateId: order.id,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        oldStatus: order.status,
        newStatus: updatedOrder.status,
        changedAt: new Date().toISOString(),
        reasonCode: 'OUTBOUND_COMPLETED',
      },
      socket: { room: SocketRooms.ORDERS, event: SocketEvents.ORDER_STATUS_CHANGED },
      createdById: args.actorId,
    });
  }

  return {
    transaction,
    inventoryStatus: nextInventoryStatus,
    outboundQuantity: nextOutboundQuantity,
    outboundStatus: nextOutboundStatus,
    orderStatus: updatedOrder.status.toLowerCase(),
    orderVersion: updatedOrder.version,
    reservedQuantity: nextReservedQuantity,
  };
}
