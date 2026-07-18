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
    quotation: {
      count: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
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
      quotation: { count: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
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

  it('values non-scrapped detail stock but reports unavailable financial metrics as null', async () => {
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
      rfqTrend: null,
      quoteTrend: null,
      orderTrend: null,
      revenueTrend: null,
      customerRetention: null,
      avgCustomerValue: null,
      avgTurnoverDays: null,
      slowMovingValue: null,
      slowMovingShare: null,
      inventoryAlerts: 1,
      metadata: {
        source: 'AeroLink RFQ, quotation, order, customer and inventory-detail records',
        sampleSize: 3,
      },
    });
    expect(prismaMock.inventoryDetail.findMany).toHaveBeenCalledWith({
      where: { status: { not: 'SCRAPPED' } },
      select: { quantity: true, unitCost: true, status: true },
    });
    expect(prismaMock.inventory.aggregate).not.toHaveBeenCalled();
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
  });

  it('keeps canonical category coverage while refusing to invent turnover days or targets', async () => {
    prismaMock.inventoryItem.findMany.mockResolvedValue([
      { partCategory: 'ROTABLE', details: [{ id: 'detail-1' }, { id: 'detail-2' }] },
      { partCategory: 'STANDARD_PART', details: [{ id: 'detail-3' }] },
    ]);

    const app = await buildApp();
    const response = await request(app).get('/api/reports/inventory-turnover');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      items: expect.arrayContaining([
        { category: '全部', days: null, target: null, sampleSize: 3 },
        { category: '周转件', days: null, target: null, sampleSize: 2 },
        { category: '标准件', days: null, target: null, sampleSize: 1 },
        { category: '可修件', days: null, target: null, sampleSize: 0 },
      ]),
      metadata: { status: 'insufficient_data', sampleSize: 3 },
    });
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

  it('calculates conversion values only from linked RFQ, quotation and order records', async () => {
    prismaMock.rFQ.count.mockResolvedValue(4);
    prismaMock.order.count.mockResolvedValue(2);
    prismaMock.order.findMany.mockResolvedValue([
      { totalAmount: 100 },
      { totalAmount: 300 },
    ]);
    prismaMock.quotation.aggregate.mockResolvedValue({ _avg: { margin: 12.5 } });
    prismaMock.quotation.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-07-03T00:00:00.000Z'),
        rfq: { createdAt: new Date('2026-07-01T00:00:00.000Z') },
      },
      {
        createdAt: new Date('2026-07-07T00:00:00.000Z'),
        rfq: { createdAt: new Date('2026-07-05T00:00:00.000Z') },
      },
    ]);

    const app = await buildApp();
    const response = await request(app).get('/api/reports/conversion');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      overallRate: 50,
      avgOrderValue: 200,
      avgMargin: 12.5,
      avgResponseTime: 2,
      lostReasons: [],
      metadata: {
        source: 'AeroLink RFQ, quotation and order records',
        sampleSize: 4,
      },
    });
  });

  it('marks conversion metrics unavailable when their record denominator is absent', async () => {
    prismaMock.rFQ.count.mockResolvedValue(0);
    prismaMock.order.count.mockResolvedValue(0);
    prismaMock.order.findMany.mockResolvedValue([]);
    prismaMock.quotation.aggregate.mockResolvedValue({ _avg: { margin: null } });
    prismaMock.quotation.findMany.mockResolvedValue([]);

    const app = await buildApp();
    const response = await request(app).get('/api/reports/conversion');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      overallRate: null,
      avgOrderValue: null,
      avgMargin: null,
      avgResponseTime: null,
      metadata: { status: 'insufficient_data' },
    });
  });
});
