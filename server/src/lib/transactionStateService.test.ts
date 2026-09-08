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
    rfqLine: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({ id: 'rfq-line-1', status: 'OPEN' }),
    },
    supplierQuote: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    quotation: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ id: 'quotation-1', version: 4 }),
    },
    quotationLine: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({ id: 'quotation-line-1' }),
    },
    order: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ id: 'order-1', version: 8 }),
    },
    orderLine: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: 'order-line-1' }),
    },
    transactionStatusHistory: {
      create: vi.fn().mockResolvedValue({ id: 'history-1' }),
    },
  };
}

function createModernTransactionMock(options: {
  rfqLines?: Array<Record<string, unknown>>;
  quotationLines?: Array<Record<string, unknown>>;
} = {}) {
  const tx = createTransactionMock();
  const state = {
    rfqLines: [...(options.rfqLines ?? [])],
    quotationLines: [...(options.quotationLines ?? [])],
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  tx.rFQ.findUnique.mockResolvedValue({ id: 'rfq-1', version: 2, lineItemsMode: true });
  tx.rfqLine.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const matched = state.rfqLines.filter((line) => matches(line, where));
    matched.forEach((line) => Object.assign(line, data));
    return { count: matched.length };
  });
  tx.quotation.findUnique.mockResolvedValue({ id: 'quotation-1', version: 4, lineItemsMode: true });
  tx.quotationLine.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const matched = state.quotationLines.filter((line) => matches(line, where));
    matched.forEach((line) => Object.assign(line, data));
    return { count: matched.length };
  });
  return { tx, state };
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

  it('settles only open modern RFQ lines and preserves terminal line history', async () => {
    const completed = createModernTransactionMock({
      rfqLines: [
        { id: 'rfq-open', rfqId: 'rfq-1', status: 'OPEN' },
        { id: 'rfq-cancelled', rfqId: 'rfq-1', status: 'CANCELLED' },
        { id: 'rfq-completed', rfqId: 'rfq-1', status: 'COMPLETED' },
      ],
    });

    await transitionRfqStatus(completed.tx as never, {
      id: 'rfq-1', currentStatus: 'SOURCING', currentVersion: 1, nextStatus: 'COMPLETED',
      actorId: 'user-1', reasonCode: 'RFQ_COMPLETED',
    });

    expect(completed.state.rfqLines).toEqual([
      { id: 'rfq-open', rfqId: 'rfq-1', status: 'COMPLETED' },
      { id: 'rfq-cancelled', rfqId: 'rfq-1', status: 'CANCELLED' },
      { id: 'rfq-completed', rfqId: 'rfq-1', status: 'COMPLETED' },
    ]);
    expect(completed.tx.rfqLine.updateMany).toHaveBeenCalledWith({
      where: { rfqId: 'rfq-1', status: 'OPEN' }, data: { status: 'COMPLETED' },
    });

    const cancelled = createModernTransactionMock({
      rfqLines: [
        { id: 'rfq-open', rfqId: 'rfq-1', status: 'OPEN' },
        { id: 'rfq-cancelled', rfqId: 'rfq-1', status: 'CANCELLED' },
        { id: 'rfq-completed', rfqId: 'rfq-1', status: 'COMPLETED' },
      ],
    });

    await transitionRfqStatus(cancelled.tx as never, {
      id: 'rfq-1', currentStatus: 'SOURCING', currentVersion: 1, nextStatus: 'CANCELLED',
      actorId: 'user-1', reasonCode: 'RFQ_CANCELLED',
    });

    expect(cancelled.state.rfqLines).toEqual([
      { id: 'rfq-open', rfqId: 'rfq-1', status: 'CANCELLED' },
      { id: 'rfq-cancelled', rfqId: 'rfq-1', status: 'CANCELLED' },
      { id: 'rfq-completed', rfqId: 'rfq-1', status: 'COMPLETED' },
    ]);
  });

  it('cancels unaccepted modern quotation lines without writing the header-only WITHDRAWN value', async () => {
    const modern = createModernTransactionMock({
      quotationLines: [
        { id: 'quotation-line-open', quotationId: 'quotation-1', acceptedQuantity: 0, status: 'APPROVED' },
        { id: 'quotation-line-accepted', quotationId: 'quotation-1', acceptedQuantity: 2, status: 'ACCEPTED' },
      ],
    });

    await transitionQuotationStatus(modern.tx as never, {
      id: 'quotation-1', currentStatus: 'SENT', currentVersion: 3, nextStatus: 'WITHDRAWN',
      actorId: 'user-1', reasonCode: 'QUOTATION_WITHDRAWN',
    });

    expect(modern.state.quotationLines).toEqual([
      { id: 'quotation-line-open', quotationId: 'quotation-1', acceptedQuantity: 0, status: 'CANCELLED' },
      { id: 'quotation-line-accepted', quotationId: 'quotation-1', acceptedQuantity: 2, status: 'ACCEPTED' },
    ]);
    expect(modern.tx.quotationLine.updateMany).toHaveBeenCalledWith({
      where: { quotationId: 'quotation-1', acceptedQuantity: 0 }, data: { status: 'CANCELLED' },
    });
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
