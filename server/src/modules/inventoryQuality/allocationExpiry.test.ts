import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    inventoryAllocation: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  enqueueBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/prisma.js', () => ({ default: mocks.prisma }));
vi.mock('../../lib/outboxService.js', () => ({ enqueueBusinessEvent: mocks.enqueueBusinessEvent }));

import { expireUnassignedAllocations } from './allocationExpiry.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';

const now = new Date('2026-09-09T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enqueueBusinessEvent.mockResolvedValue(undefined);
});

function allocationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'allocation-expired-1',
    quotationLineId: 'line-1',
    inventoryDetailId: 'detail-1',
    allocatedQuantity: 5,
    releasedQuantity: 0,
    consumedQuantity: 0,
    version: 1,
    expiresAt: new Date('2026-09-08T00:00:00.000Z'),
    assignments: [],
    inventoryDetail: { id: 'detail-1', quantity: 10, allocatedQuantity: 5 },
    quotationLine: { id: 'line-1', quotationId: 'quote-1' },
    ...overrides,
  };
}

function transactionFixture(rows: unknown[]) {
  const tx = {
    inventoryAllocation: {
      findMany: vi.fn().mockResolvedValue(rows),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inventoryDetail: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    inventoryAllocationEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
    quotation: {
      findUnique: vi.fn().mockResolvedValue({ id: 'quote-1', version: 3, reservedQuantity: 7 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    quotationLine: {
      findMany: vi.fn().mockResolvedValue([{ id: 'line-1', quotationId: 'quote-1', reservedQuantity: 7 }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  };
  mocks.prisma.$transaction.mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>, options: unknown) => {
    expect(options).toMatchObject({ isolationLevel: 'Serializable' });
    return callback(tx);
  });
  return tx;
}

describe('expireUnassignedAllocations', () => {
  it('releases only expired unassigned parent quantities and preserves assignments and unexpired siblings', async () => {
    const expiredUnassigned = allocationFixture();
    const expiredPartiallyAssigned = allocationFixture({
      id: 'allocation-expired-2',
      inventoryDetailId: 'detail-2',
      allocatedQuantity: 6,
      assignments: [{ assignedQuantity: 4, releasedQuantity: 0, consumedQuantity: 0 }],
      inventoryDetail: { id: 'detail-2', quantity: 10, allocatedQuantity: 6 },
    });
    const unexpiredSibling = allocationFixture({
      id: 'allocation-future',
      expiresAt: new Date('2026-09-10T00:00:00.000Z'),
      inventoryDetailId: 'detail-3',
      inventoryDetail: { id: 'detail-3', quantity: 10, allocatedQuantity: 2 },
    });
    mocks.prisma.inventoryAllocation.findMany.mockResolvedValue([expiredUnassigned, expiredPartiallyAssigned, unexpiredSibling]);
    const tx = transactionFixture([expiredUnassigned, expiredPartiallyAssigned, unexpiredSibling]);

    const result = await expireUnassignedAllocations({ now, limit: 10 });

    expect(result).toEqual({ scanned: 2, releasedAllocations: 2, releasedQuantity: 7 });
    expect(mocks.prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.inventoryAllocation.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.inventoryDetail.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.quotationLine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'line-1', reservedQuantity: 7 }),
      data: { reservedQuantity: { decrement: 7 } },
    }));
    expect(tx.quotation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'quote-1', reservedQuantity: 7 }),
      data: expect.objectContaining({ reservedQuantity: { decrement: 7 } }),
    }));
    expect(tx.inventoryAllocationEvent.create).toHaveBeenCalledTimes(2);
    for (const call of tx.inventoryAllocationEvent.create.mock.calls) {
      expect(call[0].data).toMatchObject({ assignmentId: null, actorId: null, kind: 'RELEASE', eventNo: 1 });
      expect(call[0].data.commandId).toMatch(/^allocation-expiry:allocation-expired-/);
    }
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET CONSTRAINTS ALL IMMEDIATE');
    expect(enqueueBusinessEvent).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(enqueueBusinessEvent).mock.calls) {
      expect(call[0]).toBe(tx);
      expect(call[1]).toMatchObject({
        eventType: 'inventory.allocation.release',
        aggregateType: 'INVENTORY_ALLOCATION',
        data: {
          allocationId: expect.any(String),
          kind: 'RELEASE',
          allocationVersion: 2,
          refresh: true,
        },
        createdById: null,
      });
      expect(call[1].data).not.toHaveProperty('quantity');
      expect(call[1].data).not.toHaveProperty('quotationLineId');
      expect(call[1].data).not.toHaveProperty('inventoryDetailId');
    }
  });

  it('does not release an expired parent whose entire quantity is assigned', async () => {
    const fullyAssigned = allocationFixture({
      assignments: [{ assignedQuantity: 5, releasedQuantity: 0, consumedQuantity: 0 }],
    });
    mocks.prisma.inventoryAllocation.findMany.mockResolvedValue([fullyAssigned]);
    const tx = transactionFixture([fullyAssigned]);
    tx.quotation.findUnique.mockResolvedValue({ id: 'quote-1', version: 1, reservedQuantity: 0 });
    tx.quotationLine.findMany.mockResolvedValue([{ id: 'line-1', quotationId: 'quote-1', reservedQuantity: 0 }]);

    const result = await expireUnassignedAllocations({ now });

    expect(result).toEqual({ scanned: 0, releasedAllocations: 0, releasedQuantity: 0 });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('validates the time window and limit', async () => {
    await expect(expireUnassignedAllocations({ now: new Date('invalid') })).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    await expect(expireUnassignedAllocations({ limit: 0 })).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('retries a serialization failure with the same stable expiry command', async () => {
    const expired = allocationFixture();
    mocks.prisma.inventoryAllocation.findMany.mockResolvedValue([expired]);
    const tx = transactionFixture([expired]);
    mocks.prisma.$transaction
      .mockRejectedValueOnce(Object.assign(new Error('could not serialize access due to concurrent update'), { code: 'P2034' }))
      .mockImplementationOnce(async (callback: (value: typeof tx) => Promise<unknown>, options: unknown) => {
        expect(options).toMatchObject({ isolationLevel: 'Serializable' });
        return callback(tx);
      });

    const result = await expireUnassignedAllocations({ now });

    expect(result.releasedQuantity).toBe(5);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.inventoryAllocationEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commandId: 'allocation-expiry:allocation-expired-1', actorId: null }),
    }));
  });

  it('keeps scanning after an exhausted expired prefix until it finds an unassigned row', async () => {
    const exhausted = allocationFixture({
      id: 'allocation-exhausted',
      releasedQuantity: 5,
      inventoryDetail: { id: 'detail-1', quantity: 10, allocatedQuantity: 0 },
    });
    const later = allocationFixture({ id: 'allocation-later' });
    mocks.prisma.inventoryAllocation.findMany
      .mockResolvedValueOnce([exhausted])
      .mockResolvedValueOnce([later]);
    const tx = transactionFixture([later]);

    const result = await expireUnassignedAllocations({ now, limit: 1 });

    expect(result).toEqual({ scanned: 1, releasedAllocations: 1, releasedQuantity: 5 });
    expect(mocks.prisma.inventoryAllocation.findMany).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.inventoryAllocation.findMany.mock.calls[0][0]).toMatchObject({ take: 1 });
    expect(mocks.prisma.inventoryAllocation.findMany.mock.calls[1][0]).toMatchObject({
      cursor: { id: 'allocation-exhausted' },
      skip: 1,
      take: 1,
    });
    expect(enqueueBusinessEvent).toHaveBeenCalledTimes(1);
  });

  it('does not create a second event when a released row is scanned again', async () => {
    const expired = allocationFixture();
    const released = allocationFixture({
      releasedQuantity: 5,
      inventoryDetail: { id: 'detail-1', quantity: 10, allocatedQuantity: 0 },
    });
    mocks.prisma.inventoryAllocation.findMany
      .mockResolvedValueOnce([expired])
      .mockResolvedValueOnce([released]);
    const tx = transactionFixture([expired]);

    await expect(expireUnassignedAllocations({ now })).resolves.toMatchObject({ releasedQuantity: 5 });
    await expect(expireUnassignedAllocations({ now })).resolves.toEqual({
      scanned: 0,
      releasedAllocations: 0,
      releasedQuantity: 0,
    });

    expect(enqueueBusinessEvent).toHaveBeenCalledTimes(1);
    expect(tx.inventoryAllocationEvent.create).toHaveBeenCalledTimes(1);
  });
});
