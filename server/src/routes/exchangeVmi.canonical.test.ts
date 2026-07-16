import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('exchange VMI canonical inventory reads', () => {
  let prismaMock: {
    inventory: { findMany: ReturnType<typeof vi.fn> };
    order: { findMany: ReturnType<typeof vi.fn> };
    vMIAgreement: { findMany: ReturnType<typeof vi.fn> };
  };
  let loadAvailableInventoryBalancesMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      inventory: { findMany: vi.fn() },
      order: { findMany: vi.fn() },
      vMIAgreement: { findMany: vi.fn() },
    };
    loadAvailableInventoryBalancesMock = vi.fn();
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/canonicalInventoryBalances.js', () => ({
      loadAvailableInventoryBalances: loadAvailableInventoryBalancesMock,
    }));
  });

  async function buildApp() {
    const router = (await import('./exchangeVmi.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use('/api/exchange-vmi', router);
    app.use(errorHandler);
    return app;
  }

  it('bases restock suggestions on sellable canonical balance rather than legacy Inventory', async () => {
    prismaMock.vMIAgreement.findMany.mockResolvedValue([
      {
        id: 'agreement-1',
        customerId: 'customer-1',
        customer: { name: 'Skyline Aero' },
        partNumber: 'VMI-PN-1',
        minStock: 2,
        maxStock: 12,
        reorderPoint: 5,
        reorderQty: 7,
      },
      {
        id: 'agreement-2',
        customerId: 'customer-2',
        customer: { name: 'Second Operator' },
        partNumber: 'VMI-PN-1',
        minStock: 1,
        maxStock: 10,
        reorderPoint: 4,
        reorderQty: 6,
      },
    ]);
    loadAvailableInventoryBalancesMock.mockResolvedValue(new Map([
      ['VMI-PN-1', { quantity: 3, value: 1200, detailCount: 1 }],
    ]));

    const app = await buildApp();
    const response = await request(app).get('/api/exchange-vmi/restock-suggestions');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [
        { id: 'agreement-1', currentStock: 3, suggestedQty: 9, reason: '当前可用库存低于补货点 5 EA' },
        { id: 'agreement-2', currentStock: 3, suggestedQty: 7, reason: '当前可用库存低于补货点 4 EA' },
      ],
    });
    expect(loadAvailableInventoryBalancesMock).toHaveBeenCalledWith(['VMI-PN-1']);
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
  });

  it('deduplicates part values in VMI statistics while retaining agreement-level restock signals', async () => {
    prismaMock.order.findMany.mockResolvedValue([]);
    prismaMock.vMIAgreement.findMany.mockResolvedValue([
      { id: 'agreement-1', customerId: 'customer-1', partNumber: 'VMI-PN-1', reorderPoint: 5 },
      { id: 'agreement-2', customerId: 'customer-2', partNumber: 'VMI-PN-1', reorderPoint: 4 },
      { id: 'agreement-3', customerId: 'customer-2', partNumber: 'VMI-PN-2', reorderPoint: 2 },
    ]);
    loadAvailableInventoryBalancesMock.mockResolvedValue(new Map([
      ['VMI-PN-1', { quantity: 3, value: 1200, detailCount: 1 }],
      ['VMI-PN-2', { quantity: 3, value: 800, detailCount: 1 }],
    ]));

    const app = await buildApp();
    const response = await request(app).get('/api/exchange-vmi/stats');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        vmiCustomers: 2,
        vmiPartNumbers: 2,
        pendingRestock: 2,
        totalVmiInventoryValue: 2000,
      },
    });
    expect(loadAvailableInventoryBalancesMock).toHaveBeenCalledWith(['VMI-PN-1', 'VMI-PN-2']);
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
  });
});
