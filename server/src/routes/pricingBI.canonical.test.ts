import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('pricing BI canonical inventory reads', () => {
  let prismaMock: {
    inventory: { findMany: ReturnType<typeof vi.fn> };
    inventoryDetail: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      inventory: { findMany: vi.fn() },
      inventoryDetail: { findMany: vi.fn() },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp() {
    const router = (await import('./pricingBI.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use('/api/pricing-bi', router);
    app.use(errorHandler);
    return app;
  }

  it('projects market intelligence from non-scrapped canonical detail cost', async () => {
    prismaMock.inventoryDetail.findMany.mockResolvedValue([
      { unitCost: 1200, inventoryItem: { partNumber: 'PRICE-PN-1' } },
    ]);

    const app = await buildApp();
    const response = await request(app).get('/api/pricing-bi/market-intelligence');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [{
        partNumber: 'PRICE-PN-1',
        ourPrice: 1200,
        marketLow: 1020,
        marketHigh: 1380,
        competitorAvg: 1260,
      }],
    });
    expect(prismaMock.inventoryDetail.findMany).toHaveBeenCalledWith({
      where: { status: { not: 'SCRAPPED' } },
      select: {
        unitCost: true,
        inventoryItem: { select: { partNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
  });
});
