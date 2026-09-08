import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { assertInventoryQuantityAdjustmentAllowed, normalizeInventoryCode } from './index.js';
import {
  createInventoryAggregate,
  deleteInventoryAggregate,
  outboundInventoryForOrder,
  reserveInventoryForQuotation,
  releaseInventoryReservation,
  updateInventoryAggregate,
} from './service.js';

vi.mock('../../lib/outboxService.js', () => ({
  enqueueBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));

function noReturnHold() {
  return {
    returnHold: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

describe('inventoryQuality service policy', () => {
  it('rejects quantity changes for reserved inventory and normalizes codes', () => {
    expect(() => assertInventoryQuantityAdjustmentAllowed('RESERVED', true)).toThrowError(/不能直接调整数量/);
    expect(() => assertInventoryQuantityAdjustmentAllowed('AVAILABLE', true)).not.toThrow();
    expect(normalizeInventoryCode(' ne ', 'NONE')).toBe('NE');
    expect(normalizeInventoryCode('', 'NONE')).toBe('NONE');
  });

  it('keeps receipt writes and the inbound ledger in one aggregate service', async () => {
    const tx = {
      inventoryItem: { upsert: vi.fn().mockResolvedValue({ id: 'item-1' }) },
      inventoryDetail: {
        create: vi.fn().mockResolvedValue({ id: 'detail-1', quantity: 5 }),
      },
      inventoryTransaction: { create: vi.fn().mockResolvedValue({ id: 'tx-1' }) },
    } as unknown as Prisma.TransactionClient;

    const detail = await createInventoryAggregate(tx, {
      item: { partNumber: 'PN-1', description: 'Part' } as Prisma.InventoryItemUncheckedCreateInput,
      detail: { quantity: 5, status: 'AVAILABLE' } as Omit<Prisma.InventoryDetailUncheckedCreateInput, 'inventoryItemId'>,
      include: {},
      actorId: 'user-1',
      notes: '  receipt  ',
    });

    expect(detail.id).toBe('detail-1');
    expect(tx.inventoryItem.upsert).toHaveBeenCalledOnce();
    expect(tx.inventoryDetail.create).toHaveBeenCalledOnce();
    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'INBOUND', quantity: 5, notes: 'receipt', createdBy: 'user-1' }),
    });
  });

  it('updates the detail, part master, and adjustment ledger through one service', async () => {
    const existing = {
      id: 'detail-1',
      inventoryItemId: 'item-1',
      quantity: 5,
      status: 'AVAILABLE',
      allocatedQuantity: 0,
      updatedAt: new Date('2026-09-09T00:00:00.000Z'),
    };
    const updated = { ...existing, quantity: 3 };
    const txMock = {
      ...noReturnHold(),
      inventoryItem: { update: vi.fn().mockResolvedValue({ id: 'item-1' }) },
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(updated),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryTransaction: { create: vi.fn().mockResolvedValue({ id: 'tx-2' }) },
    };
    const tx = txMock as unknown as Prisma.TransactionClient;

    const result = await updateInventoryAggregate(tx, {
      id: 'detail-1',
      itemData: { description: 'Updated part' },
      detailData: { quantity: 3 },
      include: {},
      quantityProvided: true,
      quantity: 3,
      actorId: 'user-1',
    });

    expect(result.quantityDelta).toBe(-2);
    expect(tx.inventoryItem.update).toHaveBeenCalledWith({ where: { id: 'item-1' }, data: { description: 'Updated part' } });
    expect(txMock.inventoryDetail.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'detail-1',
        allocatedQuantity: 0,
        quantity: 5,
        updatedAt: existing.updatedAt,
      },
      data: { quantity: 3 },
    });
    expect(txMock.inventoryDetail.update).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'ADJUSTMENT', quantity: -2, beforeQuantity: 5, afterQuantity: 3 }),
    });
  });

  it('protects legacy, ledger-linked, and non-empty details before deleting the aggregate', async () => {
    const txMock = {
      ...noReturnHold(),
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue({ id: 'detail-1', inventoryItemId: 'item-1', quantity: 0 }),
        delete: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(0),
      },
      inventory: { findUnique: vi.fn().mockResolvedValue(null) },
      inventoryTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
      certificate: { findFirst: vi.fn().mockResolvedValue(null) },
      inventoryAllocation: { findFirst: vi.fn().mockResolvedValue(null) },
      inventoryItem: { delete: vi.fn().mockResolvedValue(undefined) },
    };
    const tx = txMock as unknown as Prisma.TransactionClient;

    const deleted = await deleteInventoryAggregate(tx, { id: 'detail-1', include: {} });

    expect(deleted.id).toBe('detail-1');
    expect(txMock.inventoryDetail.delete).toHaveBeenCalledWith({ where: { id: 'detail-1' } });
    expect(txMock.inventoryItem.delete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
  });

  it('keeps reservation state, ledger and outbox writes inside the inventory service', async () => {
    const detail = {
      id: 'detail-1',
      quantity: 5,
      status: 'AVAILABLE',
      allocatedQuantity: 0,
      serialNumber: null,
      batchNumber: null,
      inventoryItem: { partNumber: 'PN-1' },
    };
    const quotation = {
      id: 'quotation-1',
      status: 'APPROVED',
      version: 4,
      partNumber: 'PN-1',
      quantity: 5,
      reservedQuantity: 0,
      inventoryDetailId: null,
      quoteNumber: 'Q-1',
    };
    const transaction = {
      id: 'transaction-1',
      inventoryDetailId: 'detail-1',
      type: 'RESERVATION',
      quantity: 0,
      beforeQuantity: 5,
      afterQuantity: 5,
      orderId: null,
      quotationId: 'quotation-1',
      referenceNo: 'Q-1',
      referenceType: 'QUOTATION',
      notes: null,
      createdBy: 'user-1',
      createdAt: new Date(),
    };
    const tx = {
      ...noReturnHold(),
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue(detail),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      quotation: {
        findUnique: vi.fn().mockResolvedValue(quotation),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      order: { findFirst: vi.fn().mockResolvedValue(null) },
      rfqLine: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
      supplierQuote: { findUnique: vi.fn().mockResolvedValue(null) },
      quotationLine: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
      orderLine: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
      inventoryTransaction: { create: vi.fn().mockResolvedValue(transaction) },
    } as unknown as Prisma.TransactionClient;

    const result = await reserveInventoryForQuotation(tx, {
      inventoryDetailId: 'detail-1',
      quotationId: 'quotation-1',
      quantity: 2,
      notes: '  reserve  ',
      actorId: 'user-1',
    });

    expect(result.transaction.id).toBe('transaction-1');
    expect(result.inventoryStatus).toBe('RESERVED');
    expect(result.reservedQuantity).toBe(2);
    expect(tx.inventoryDetail.updateMany).toHaveBeenCalledWith({
      where: { id: 'detail-1', status: 'AVAILABLE', allocatedQuantity: 0, quantity: { gte: 2 } },
      data: { status: 'RESERVED' },
    });
    expect(tx.quotation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'quotation-1', version: 4, reservedQuantity: 0 }),
      data: expect.objectContaining({ reservedQuantity: 2 }),
    }));
  });

  it('rejects legacy quantity and identity changes while a modern allocation is active', async () => {
    const existing = {
      id: 'detail-1',
      inventoryItemId: 'item-1',
      quantity: 5,
      status: 'AVAILABLE',
      allocatedQuantity: 2,
    };
    const txMock = {
      ...noReturnHold(),
      inventoryItem: { update: vi.fn() },
      inventoryDetail: { findUnique: vi.fn().mockResolvedValue(existing), update: vi.fn(), updateMany: vi.fn() },
    };
    const tx = txMock as unknown as Prisma.TransactionClient;

    await expect(updateInventoryAggregate(tx, {
      id: existing.id,
      itemData: {},
      detailData: { quantity: 4 },
      include: {},
      quantityProvided: true,
      quantity: 4,
      actorId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });

    await expect(updateInventoryAggregate(tx, {
      id: existing.id,
      itemData: {},
      detailData: { conditionCode: 'AR' },
      include: {},
      quantityProvided: false,
      actorId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });

    expect(txMock.inventoryItem.update).not.toHaveBeenCalled();
    expect(txMock.inventoryDetail.update).not.toHaveBeenCalled();
    expect(txMock.inventoryDetail.updateMany).not.toHaveBeenCalled();
  });

  it('allows quality evidence updates while preserving the allocation quantity guard', async () => {
    const existing = {
      id: 'detail-1',
      inventoryItemId: 'item-1',
      quantity: 5,
      status: 'AVAILABLE',
      allocatedQuantity: 2,
    };
    const updated = { ...existing, remainingHours: 100 };
    const txMock = {
      ...noReturnHold(),
      inventoryItem: { update: vi.fn() },
      inventoryDetail: { findUnique: vi.fn().mockResolvedValue(existing), update: vi.fn().mockResolvedValue(updated) },
      inventoryTransaction: { create: vi.fn() },
    };
    const tx = txMock as unknown as Prisma.TransactionClient;

    const result = await updateInventoryAggregate(tx, {
      id: existing.id,
      itemData: {},
      detailData: { remainingHours: 100 },
      include: {},
      quantityProvided: false,
      actorId: 'user-1',
    });

    expect(result.updated).toEqual(updated);
    expect(txMock.inventoryDetail.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: { remainingHours: 100 },
      include: {},
    });
  });

  it('allows only QUARANTINED status changes while a modern allocation is active', async () => {
    const existing = {
      id: 'detail-1',
      inventoryItemId: 'item-1',
      quantity: 5,
      status: 'AVAILABLE',
      allocatedQuantity: 2,
      updatedAt: new Date('2026-09-09T00:00:00.000Z'),
    };
    const updated = { ...existing, status: 'QUARANTINED' };
    const txMock = {
      ...noReturnHold(),
      inventoryItem: { update: vi.fn() },
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const tx = txMock as unknown as Prisma.TransactionClient;

    const result = await updateInventoryAggregate(tx, {
      id: existing.id,
      itemData: {},
      detailData: { status: 'QUARANTINED' },
      include: {},
      quantityProvided: false,
      actorId: 'user-1',
    });

    expect(result.updated.status).toBe('QUARANTINED');
    expect(txMock.inventoryDetail.updateMany).toHaveBeenCalledWith({
      where: {
        id: existing.id,
        allocatedQuantity: { gt: 0 },
        updatedAt: existing.updatedAt,
      },
      data: { status: 'QUARANTINED' },
    });

    const reservedDetail = { ...existing, status: 'RESERVED' };
    txMock.inventoryDetail.findUnique.mockReset();
    txMock.inventoryDetail.findUnique.mockResolvedValue(reservedDetail);
    await expect(updateInventoryAggregate(tx, {
      id: existing.id,
      itemData: {},
      detailData: { status: 'RESERVED' },
      include: {},
      quantityProvided: false,
      actorId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
  });

  it.each([
    {
      label: 'released or consumed allocation history',
      allocation: { id: 'allocation-history' },
      outbound: null,
      detailData: { serialNumber: null },
    },
    {
      label: 'legacy OUTBOUND history',
      allocation: null,
      outbound: { id: 'outbound-history' },
      detailData: { conditionCode: 'AR' },
    },
  ])('rejects physical identity erasure after $label even when allocated quantity is zero', async ({ allocation, outbound, detailData }) => {
    const existing = {
      id: 'detail-history',
      inventoryItemId: 'item-1',
      quantity: 1,
      allocatedQuantity: 0,
      status: 'AVAILABLE',
      serialNumber: 'SN-HISTORY',
      batchNumber: 'B-HISTORY',
      conditionCode: 'NE',
      updatedAt: new Date('2026-09-09T00:00:00.000Z'),
    };
    const txMock = {
      ...noReturnHold(),
      inventoryItem: { update: vi.fn() },
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue(existing),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      inventoryAllocation: { findFirst: vi.fn().mockResolvedValue(allocation) },
      inventoryTransaction: { findFirst: vi.fn().mockResolvedValue(outbound) },
    };

    await expect(updateInventoryAggregate(txMock as unknown as Prisma.TransactionClient, {
      id: existing.id,
      itemData: {},
      detailData,
      include: {},
      quantityProvided: false,
      actorId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });

    expect(txMock.inventoryDetail.update).not.toHaveBeenCalled();
    expect(txMock.inventoryDetail.updateMany).not.toHaveBeenCalled();
  });

  it('allows an identity write that repeats the current value while an allocation is active', async () => {
    const existing = {
      id: 'detail-same',
      inventoryItemId: 'item-1',
      quantity: 1,
      allocatedQuantity: 1,
      status: 'AVAILABLE',
      serialNumber: 'SN-SAME',
      batchNumber: 'B-SAME',
      conditionCode: 'NE',
    };
    const updated = { ...existing };
    const txMock = {
      inventoryItem: { update: vi.fn() },
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(updated),
        update: vi.fn().mockResolvedValue(updated),
        updateMany: vi.fn(),
      },
    };

    const result = await updateInventoryAggregate(txMock as unknown as Prisma.TransactionClient, {
      id: existing.id,
      itemData: {},
      detailData: { serialNumber: 'SN-SAME', batchNumber: 'B-SAME', conditionCode: 'NE' },
      include: {},
      quantityProvided: false,
      actorId: 'user-1',
    });

    expect(result.updated).toEqual(updated);
    expect(txMock.inventoryDetail.update).not.toHaveBeenCalled();
    expect(txMock.inventoryDetail.updateMany).not.toHaveBeenCalled();
  });

  it('blocks shared part identity changes when an inactive detail retains allocation history', async () => {
    const selectedDetail = {
      id: 'detail-unallocated',
      inventoryItemId: 'item-history',
      quantity: 5,
      status: 'AVAILABLE',
      allocatedQuantity: 0,
      inventoryItem: { partNumber: 'PN-HISTORY', trackingType: 'BATCH' },
    };
    const txMock = {
      ...noReturnHold(),
      inventoryItem: {
        update: vi.fn(),
      },
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue(selectedDetail),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      inventoryAllocation: { findFirst: vi.fn().mockResolvedValue({ id: 'released-allocation' }) },
      inventoryTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
    };

    await expect(updateInventoryAggregate(txMock as unknown as Prisma.TransactionClient, {
      id: selectedDetail.id,
      itemData: { partNumber: 'PN-REWRITTEN' },
      detailData: {},
      include: {},
      quantityProvided: false,
      actorId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });

    expect(txMock.inventoryItem.update).not.toHaveBeenCalled();
  });

  it('blocks shared part identity changes when a sibling detail is actively allocated', async () => {
    const selectedDetail = {
      id: 'detail-unallocated',
      inventoryItemId: 'item-1',
      quantity: 5,
      status: 'AVAILABLE',
      allocatedQuantity: 0,
    };
    const txMock = {
      ...noReturnHold(),
      inventoryItem: {
        findUnique: vi.fn().mockResolvedValue({ partNumber: 'PN-1', trackingType: 'BATCH' }),
        update: vi.fn(),
      },
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue(selectedDetail),
        findFirst: vi.fn().mockResolvedValue({ id: 'detail-allocated' }),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const tx = txMock as unknown as Prisma.TransactionClient;

    await expect(updateInventoryAggregate(tx, {
      id: selectedDetail.id,
      itemData: { partNumber: 'PN-NEW' },
      detailData: {},
      include: {},
      quantityProvided: false,
      actorId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });

    await expect(updateInventoryAggregate(tx, {
      id: selectedDetail.id,
      itemData: { trackingType: 'SERIAL' },
      detailData: {},
      include: {},
      quantityProvided: false,
      actorId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });

    expect(txMock.inventoryItem.update).not.toHaveBeenCalled();
    expect(txMock.inventoryDetail.findFirst).toHaveBeenCalledWith({
      where: { inventoryItemId: 'item-1', allocatedQuantity: { gt: 0 } },
      select: { id: true },
    });
  });

  it('rejects legacy reservation when the detail has active modern allocation', async () => {
    const detail = {
      id: 'detail-1',
      quantity: 5,
      allocatedQuantity: 1,
      status: 'AVAILABLE',
      serialNumber: null,
      batchNumber: null,
      inventoryItem: { partNumber: 'PN-1' },
    };
    const quotation = {
      id: 'quotation-1',
      status: 'APPROVED',
      lineItemsMode: false,
      version: 1,
      partNumber: 'PN-1',
      quantity: 2,
      reservedQuantity: 0,
      inventoryDetailId: null,
      quoteNumber: 'Q-1',
    };
    const tx = {
      ...noReturnHold(),
      inventoryDetail: { findUnique: vi.fn().mockResolvedValue(detail), updateMany: vi.fn() },
      quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
    } as unknown as Prisma.TransactionClient;

    await expect(reserveInventoryForQuotation(tx, {
      inventoryDetailId: detail.id,
      quotationId: quotation.id,
      quantity: 1,
      actorId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
  });

  it('rejects legacy release when the detail has active modern allocation', async () => {
    const quotation = {
      id: 'quotation-1',
      status: 'APPROVED',
      lineItemsMode: false,
      inventoryDetailId: 'detail-1',
      reservedQuantity: 2,
      quoteNumber: 'Q-1',
      partNumber: 'PN-1',
      version: 2,
    };
    const tx = {
      ...noReturnHold(),
      quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'detail-1',
          quantity: 5,
          allocatedQuantity: 1,
          status: 'RESERVED',
          inventoryItem: { partNumber: 'PN-1' },
        }),
        updateMany: vi.fn(),
      },
      order: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as Prisma.TransactionClient;

    await expect(releaseInventoryReservation(tx, {
      quotationId: quotation.id,
      actorId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
  });

  it('rejects legacy outbound when the detail has active modern allocation', async () => {
    const detail = {
      id: 'detail-1',
      quantity: 5,
      allocatedQuantity: 1,
      status: 'AVAILABLE',
      inventoryItem: { partNumber: 'PN-1' },
    };
    const order = {
      id: 'order-1',
      status: 'PO_CREATED',
      lineItemsMode: false,
      partNumber: 'PN-1',
      quantity: 2,
      outboundQuantity: 0,
      inventoryDetailId: detail.id,
      version: 1,
      quotationId: 'quotation-1',
      quotation: {
        id: 'quotation-1',
        inventoryDetailId: detail.id,
        reservedQuantity: 0,
        status: 'APPROVED',
        version: 1,
      },
    };
    const tx = {
      ...noReturnHold(),
      inventoryDetail: { findUnique: vi.fn().mockResolvedValue(detail), updateMany: vi.fn() },
      order: { findUnique: vi.fn().mockResolvedValue(order) },
    } as unknown as Prisma.TransactionClient;

    await expect(outboundInventoryForOrder(tx, {
      inventoryDetailId: detail.id,
      orderId: order.id,
      quantity: 1,
      actorId: 'user-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
  });

  it('rejects deletion when any modern allocation history exists', async () => {
    const tx = {
      ...noReturnHold(),
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue({ id: 'detail-1', inventoryItemId: 'item-1', quantity: 0, allocatedQuantity: 0 }),
        delete: vi.fn(),
      },
      inventory: { findUnique: vi.fn().mockResolvedValue(null) },
      inventoryTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
      certificate: { findFirst: vi.fn().mockResolvedValue(null) },
      inventoryAllocation: { findFirst: vi.fn().mockResolvedValue({ id: 'allocation-1' }) },
    } as unknown as Prisma.TransactionClient;

    await expect(deleteInventoryAggregate(tx, { id: 'detail-1', include: {} }))
      .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
  });
});
