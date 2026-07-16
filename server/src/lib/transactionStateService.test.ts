import { describe, expect, it, vi } from 'vitest';
import {
  createInitialStatusHistory,
  transitionOrderStatus,
  transitionQuotationStatus,
  transitionRfqStatus,
} from './transactionStateService.js';

function createTransactionMock() {
  return {
    rFQ: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ id: 'rfq-1', version: 2 }),
    },
    quotation: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ id: 'quotation-1', version: 4 }),
    },
    order: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ id: 'order-1', version: 8 }),
    },
    transactionStatusHistory: {
      create: vi.fn().mockResolvedValue({ id: 'history-1' }),
    },
  };
}

describe('transaction state service', () => {
  it('uses RFQ status and version as mutation conditions and writes an audit record', async () => {
    const tx = createTransactionMock();

    const updated = await transitionRfqStatus(tx as never, {
      id: 'rfq-1',
      currentStatus: 'PENDING',
      currentVersion: 1,
      nextStatus: 'SOURCING',
      expectedVersion: 1,
      actorId: 'user-1',
      reasonCode: 'MANUAL_STATUS_UPDATE',
      reason: 'Supplier outreach started.',
    });

    expect(updated.version).toBe(2);
    expect(tx.rFQ.updateMany).toHaveBeenCalledWith({
      where: { id: 'rfq-1', status: 'PENDING', version: 1 },
      data: {
        status: 'SOURCING',
        statusEnum: 'SOURCING',
        version: { increment: 1 },
      },
    });
    expect(tx.transactionStatusHistory.create).toHaveBeenCalledWith({
      data: {
        entityType: 'RFQ',
        entityId: 'rfq-1',
        fromStatus: 'PENDING',
        toStatus: 'SOURCING',
        reasonCode: 'MANUAL_STATUS_UPDATE',
        reason: 'Supplier outreach started.',
        actorId: 'user-1',
        version: 2,
      },
    });
  });

  it('rejects a stale version before mutating a quotation', async () => {
    const tx = createTransactionMock();

    await expect(transitionQuotationStatus(tx as never, {
      id: 'quotation-1',
      currentStatus: 'PENDING_APPROVAL',
      currentVersion: 3,
      nextStatus: 'APPROVED',
      expectedVersion: 2,
      actorId: 'manager-1',
      reasonCode: 'QUOTATION_APPROVED',
    })).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      statusCode: 409,
    });

    expect(tx.quotation.updateMany).not.toHaveBeenCalled();
    expect(tx.transactionStatusHistory.create).not.toHaveBeenCalled();
  });

  it('records quotation transition metadata after a conditional update', async () => {
    const tx = createTransactionMock();

    await transitionQuotationStatus(tx as never, {
      id: 'quotation-1',
      currentStatus: 'PENDING_APPROVAL',
      currentVersion: 3,
      nextStatus: 'APPROVED',
      expectedVersion: 3,
      actorId: 'manager-1',
      reasonCode: 'QUOTATION_APPROVED',
      reason: 'Margin is within the approval threshold.',
      data: {
        approvedBy: 'manager-1',
      },
    });

    expect(tx.quotation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'quotation-1', status: 'PENDING_APPROVAL', version: 3 },
      data: expect.objectContaining({
        status: 'APPROVED',
        statusEnum: 'APPROVED',
        version: { increment: 1 },
        approvedBy: 'manager-1',
      }),
    }));
    expect(tx.transactionStatusHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        entityType: 'QUOTATION',
        entityId: 'quotation-1',
        fromStatus: 'PENDING_APPROVAL',
        toStatus: 'APPROVED',
        actorId: 'manager-1',
        version: 4,
      }),
    }));
  });

  it('surfaces a concurrent conditional-update failure for orders without writing history', async () => {
    const tx = createTransactionMock();
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(transitionOrderStatus(tx as never, {
      id: 'order-1',
      currentStatus: 'SO_CREATED',
      currentVersion: 7,
      nextStatus: 'PO_CREATED',
      actorId: 'user-1',
      reasonCode: 'MANUAL_STATUS_UPDATE',
    })).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      statusCode: 409,
    });

    expect(tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PO_CREATED', statusEnum: 'PO_CREATED' }),
    }));
    expect(tx.transactionStatusHistory.create).not.toHaveBeenCalled();
  });

  it('writes initial history without a previous state', async () => {
    const tx = createTransactionMock();

    await createInitialStatusHistory(tx as never, {
      entityType: 'ORDER',
      entityId: 'order-1',
      toStatus: 'SO_CREATED',
      reasonCode: 'ORDER_CREATED_FROM_QUOTATION',
      actorId: 'user-1',
      version: 1,
    });

    expect(tx.transactionStatusHistory.create).toHaveBeenCalledWith({
      data: {
        entityType: 'ORDER',
        entityId: 'order-1',
        fromStatus: null,
        toStatus: 'SO_CREATED',
        reasonCode: 'ORDER_CREATED_FROM_QUOTATION',
        reason: null,
        actorId: 'user-1',
        version: 1,
      },
    });
  });
});
