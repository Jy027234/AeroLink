import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  actor: { id: 'manager-1', role: 'MANAGER', department: 'Operations' },
  prisma: {
    inventoryItem: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    inventoryAllocation: {
      findFirst: vi.fn(),
    },
    inventoryTransaction: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: mocks.prisma }));

import { errorHandler } from '../middleware/errorHandler.js';
import router from './inventoryItems.js';

const updatedAt = new Date('2026-09-09T00:00:00.000Z');

function itemFixture(details: Array<{ id: string; allocatedQuantity: number }> = []) {
  return {
    id: 'item-1',
    partNumber: 'PN-1',
    trackingType: 'BATCH',
    updatedAt,
    details,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { user: mocks.actor });
    next();
  });
  app.use('/api/inventory-items', router);
  app.use(errorHandler);
  return app;
}

describe('inventory item PATCH boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor.role = 'MANAGER';
    mocks.prisma.$transaction.mockImplementation(async (operation: (tx: typeof mocks.prisma) => Promise<unknown>) => operation(mocks.prisma));
    mocks.prisma.inventoryItem.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.inventoryAllocation.findFirst.mockReset().mockResolvedValue(null);
    mocks.prisma.inventoryTransaction.findFirst.mockReset().mockResolvedValue(null);
  });

  it('rejects nested relation, id, and timestamp writes before opening a transaction', async () => {
    const response = await request(buildApp())
      .patch('/api/inventory-items/item-1')
      .send({
        id: 'forged-item',
        details: [{ allocatedQuantity: 999 }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: updatedAt.toISOString(),
        description: 'attempted nested write',
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.inventoryItem.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { partNumber: 'PN-2' },
    { trackingType: 'SERIAL' },
  ])('rejects active allocation identity mutation %j', async mutation => {
    mocks.prisma.inventoryItem.findUnique.mockResolvedValueOnce(itemFixture([{ id: 'detail-1', allocatedQuantity: 2 }]));

    const response = await request(buildApp())
      .patch('/api/inventory-items/item-1')
      .send(mutation);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RESOURCE_CONFLICT');
    expect(mocks.prisma.inventoryItem.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'released allocation history',
      allocation: { id: 'allocation-history' },
      transaction: null,
      mutation: { partNumber: 'PN-2' },
    },
    {
      label: 'legacy OUTBOUND history',
      allocation: null,
      transaction: { id: 'outbound-history' },
      mutation: { trackingType: 'SERIAL' },
    },
  ])('rejects shared identity changes after $label even when no allocation is active', async ({ allocation, transaction, mutation }) => {
    mocks.prisma.inventoryItem.findUnique.mockResolvedValueOnce(itemFixture());
    mocks.prisma.inventoryAllocation.findFirst.mockResolvedValueOnce(allocation);
    mocks.prisma.inventoryTransaction.findFirst.mockResolvedValueOnce(transaction);

    const response = await request(buildApp())
      .patch('/api/inventory-items/item-1')
      .send(mutation);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RESOURCE_CONFLICT');
    expect(mocks.prisma.inventoryItem.updateMany).not.toHaveBeenCalled();
  });

  it('allows the same part identity value even when history exists', async () => {
    const existing = itemFixture();
    const updated = { ...existing };
    mocks.prisma.inventoryItem.findUnique
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(updated);
    mocks.prisma.inventoryAllocation.findFirst.mockResolvedValueOnce({ id: 'allocation-history' });
    mocks.prisma.inventoryTransaction.findFirst.mockResolvedValueOnce({ id: 'outbound-history' });

    const response = await request(buildApp())
      .patch('/api/inventory-items/item-1')
      .send({ partNumber: existing.partNumber, trackingType: existing.trackingType });

    expect(response.status).toBe(200);
    expect(mocks.prisma.inventoryAllocation.findFirst).not.toHaveBeenCalled();
    expect(mocks.prisma.inventoryTransaction.findFirst).not.toHaveBeenCalled();
  });

  it('allows metadata edits while an allocation exists and uses updatedAt as the CAS predicate', async () => {
    const existing = itemFixture([{ id: 'detail-1', allocatedQuantity: 2 }]);
    const updated = { ...existing, description: 'Updated metadata', manufacturer: 'ACME' };
    mocks.prisma.inventoryItem.findUnique
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(updated);

    const response = await request(buildApp())
      .patch('/api/inventory-items/item-1')
      .send({ description: 'Updated metadata', manufacturer: 'ACME' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 'item-1', description: 'Updated metadata' });
    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(mocks.prisma.inventoryItem.updateMany).toHaveBeenCalledWith({
      where: { id: existing.id, updatedAt: existing.updatedAt },
      data: { description: 'Updated metadata', manufacturer: 'ACME' },
    });
  });

  it('allows identity changes when no modern allocation is active', async () => {
    const existing = itemFixture();
    const updated = { ...existing, partNumber: 'PN-2', trackingType: 'SERIAL' };
    mocks.prisma.inventoryItem.findUnique
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(updated);

    const response = await request(buildApp())
      .patch('/api/inventory-items/item-1')
      .send({ partNumber: 'PN-2', trackingType: 'SERIAL' });

    expect(response.status).toBe(200);
    expect(mocks.prisma.inventoryItem.updateMany).toHaveBeenCalledWith({
      where: { id: existing.id, updatedAt: existing.updatedAt },
      data: { partNumber: 'PN-2', trackingType: 'SERIAL' },
    });
  });

  it('returns a state conflict when the updatedAt CAS loses a race', async () => {
    const existing = itemFixture();
    mocks.prisma.inventoryItem.findUnique.mockResolvedValueOnce(existing);
    mocks.prisma.inventoryItem.updateMany.mockResolvedValue({ count: 0 });

    const response = await request(buildApp())
      .patch('/api/inventory-items/item-1')
      .send({ description: 'stale write' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(mocks.prisma.inventoryItem.findUnique).toHaveBeenCalledTimes(1);
  });

  it('requires inventory manage capability for item mutation', async () => {
    mocks.actor.role = 'SALES';

    const response = await request(buildApp())
      .patch('/api/inventory-items/item-1')
      .send({ description: 'sales must not edit shared stock identity' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_FORBIDDEN');
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('projects the accepted purchase receipt source for allocation clients', async () => {
    mocks.prisma.inventoryItem.findFirst.mockResolvedValueOnce({
      id: 'item-1',
      partNumber: 'PN-1',
      details: [{
        id: 'detail-1',
        quantity: 1,
        allocatedQuantity: 0,
        status: 'AVAILABLE',
        stockReceiptLines: [{ id: 'receipt-line-1' }],
      }],
    });

    const response = await request(buildApp()).get('/api/inventory-items/part/PN-1');

    expect(response.status).toBe(200);
    expect(response.body.details[0]).toMatchObject({ id: 'detail-1', stockReceiptLineId: 'receipt-line-1' });
    expect(response.body.details[0]).not.toHaveProperty('stockReceiptLines');
    expect(mocks.prisma.inventoryItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { partNumber: 'PN-1' },
      include: {
        details: {
          include: {
            stockReceiptLines: {
              where: { status: 'ACCEPTED' },
              select: { id: true },
            },
          },
        },
      },
    }));
  });
});
