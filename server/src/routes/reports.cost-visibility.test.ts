import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('report cost visibility', () => {
  let prismaMock: {
    rFQ: { count: ReturnType<typeof vi.fn> };
    quotation: { count: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    order: { count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    customer: { count: ReturnType<typeof vi.fn> };
    inventoryDetail: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      rFQ: { count: vi.fn().mockResolvedValue(2) },
      quotation: {
        count: vi.fn().mockResolvedValue(3),
        aggregate: vi.fn().mockResolvedValue({ _avg: { margin: 22 } }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      order: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([{ totalAmount: 100 }]),
      },
      customer: { count: vi.fn().mockResolvedValue(4) },
      inventoryDetail: {
        findMany: vi.fn().mockResolvedValue([{ quantity: 2, unitCost: 900, status: 'AVAILABLE' }]),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp(role = 'viewer') {
    const router = (await import('./reports.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: `${role}-1`, role } });
      next();
    });
    app.use('/api/reports', router);
    app.use(errorHandler);
    return app;
  }

  it('keeps quantity and operational counts while hiding inventory valuation', async () => {
    const app = await buildApp('viewer');
    const response = await request(app).get('/api/reports/summary');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalInventoryValue: null,
      inventoryAlerts: 1,
      activeCustomers: 4,
      ordersThisMonth: 1,
    });
  });

  it('does not query or return margin for a report reader without report.view_cost', async () => {
    const app = await buildApp('quality_manager');
    const response = await request(app).get('/api/reports/conversion');

    expect(response.status).toBe(200);
    expect(response.body.avgMargin).toBeNull();
    expect(prismaMock.quotation.aggregate).not.toHaveBeenCalled();
  });
});
