import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { assertInventoryQuantityAdjustmentAllowed, normalizeInventoryCode } from './index.js';
import {
  createInventoryAggregate,
  deleteInventoryAggregate,
  reserveInventoryForQuotation,
  updateInventoryAggregate,
} from './service.js';

vi.mock('../../lib/outboxService.js', () => ({
  enqueueBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));

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
    const existing = { id: 'detail-1', inventoryItemId: 'item-1', quantity: 5, status: 'AVAILABLE' };
    const updated = { ...existing, quantity: 3 };
    const tx = {
      inventoryItem: { update: vi.fn().mockResolvedValue({ id: 'item-1' }) },
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      },
      inventoryTransaction: { create: vi.fn().mockResolvedValue({ id: 'tx-2' }) },
    } as unknown as Prisma.TransactionClient;

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
    expect(tx.inventoryDetail.update).toHaveBeenCalledOnce();
    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'ADJUSTMENT', quantity: -2, beforeQuantity: 5, afterQuantity: 3 }),
    });
  });

  it('protects legacy, ledger-linked, and non-empty details before deleting the aggregate', async () => {
    const txMock = {
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue({ id: 'detail-1', inventoryItemId: 'item-1', quantity: 0 }),
        delete: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(0),
      },
      inventory: { findUnique: vi.fn().mockResolvedValue(null) },
      inventoryTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
      certificate: { findFirst: vi.fn().mockResolvedValue(null) },
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
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue(detail),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      quotation: {
        findUnique: vi.fn().mockResolvedValue(quotation),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      order: { findUnique: vi.fn().mockResolvedValue(null) },
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
      where: { id: 'detail-1', status: 'AVAILABLE', quantity: { gte: 2 } },
      data: { status: 'RESERVED' },
    });
    expect(tx.quotation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'quotation-1', version: 4, reservedQuantity: 0 }),
      data: expect.objectContaining({ reservedQuantity: 2 }),
    }));
  });
});
