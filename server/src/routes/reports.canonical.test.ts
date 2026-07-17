import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('report canonical inventory reads', () => {
  let prismaMock: {
    inventory: {
      aggregate: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    inventoryDetail: { findMany: ReturnType<typeof vi.fn> };
    inventoryItem: { findMany: ReturnType<typeof vi.fn> };
    rFQ: { count: ReturnType<typeof vi.fn> };
    quotation: { count: ReturnType<typeof vi.fn> };
    order: { count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    customer: { count: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      inventory: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn() },
      inventoryDetail: { findMany: vi.fn() },
      inventoryItem: { findMany: vi.fn() },
      rFQ: { count: vi.fn() },
      quotation: { count: vi.fn() },
      order: { count: vi.fn(), findMany: vi.fn() },
      customer: { count: vi.fn() },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp() {
    const router = (await import('./reports.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin' } });
      next();
    });
    app.use('/api/reports', router);
    app.use(errorHandler);
    return app;
  }

  it('values non-scrapped detail stock and keeps reserved owned stock in the asset report', async () => {
    prismaMock.rFQ.count.mockResolvedValue(0);
    prismaMock.quotation.count.mockResolvedValue(0);
    prismaMock.order.count.mockResolvedValue(0);
    prismaMock.order.findMany.mockResolvedValue([]);
    prismaMock.customer.count.mockResolvedValue(2);
    prismaMock.inventoryDetail.findMany.mockResolvedValue([
      { quantity: 2, unitCost: 100, status: 'AVAILABLE' },
      { quantity: 1, unitCost: 80, status: 'RESERVED' },
      { quantity: 12, unitCost: 10, status: 'AVAILABLE' },
    ]);

    const app = await buildApp();
    const response = await request(app).get('/api/reports/summary');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalInventoryValue: 400,
      avgCustomerValue: 200,
      slowMovingValue: 120,
      slowMovingShare: 30,
      inventoryAlerts: 1,
    });
    expect(prismaMock.inventoryDetail.findMany).toHaveBeenCalledWith({
      where: { status: { not: 'SCRAPPED' } },
      select: { quantity: true, unitCost: true, status: true },
    });
    expect(prismaMock.inventory.aggregate).not.toHaveBeenCalled();
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
  });

  it('uses canonical part categories and non-scrapped detail counts for turnover coverage', async () => {
    prismaMock.inventoryItem.findMany.mockResolvedValue([
      { partCategory: 'ROTABLE', details: [{ id: 'detail-1' }, { id: 'detail-2' }] },
      { partCategory: 'STANDARD_PART', details: [{ id: 'detail-3' }] },
    ]);

    const app = await buildApp();
    const response = await request(app).get('/api/reports/inventory-turnover');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: '全部', days: 45, target: 45 }),
      expect.objectContaining({ category: '周转件', target: 45 }),
      expect.objectContaining({ category: '标准件', target: 45 }),
      { category: '可修件', days: 0, target: 45 },
    ]));
    expect(prismaMock.inventoryItem.findMany).toHaveBeenCalledWith({
      select: {
        partCategory: true,
        details: {
          where: { status: { not: 'SCRAPPED' } },
          select: { id: true },
        },
      },
    });
    expect(prismaMock.inventory.count).not.toHaveBeenCalled();
  });
});
