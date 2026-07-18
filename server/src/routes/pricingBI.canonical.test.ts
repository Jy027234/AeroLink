import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('pricing BI data availability', () => {
  let prismaMock: {
    quotation: {
      count: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
    };
    order: { count: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    prismaMock = {
      quotation: {
        count: vi.fn(),
        aggregate: vi.fn(),
      },
      order: { count: vi.fn() },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function buildApp() {
    const router = (await import('./pricingBI.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin' } });
      next();
    });
    app.use('/api/pricing-bi', router);
    app.use(errorHandler);
    return app;
  }

  it('keeps pricing BI disabled by default without querying business data', async () => {
    const app = await buildApp();
    const response = await request(app).get('/api/pricing-bi/summary');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        feature: { key: 'pricingBi', enabled: false },
        avgMargin: null,
        totalQuotes: null,
        metadata: { status: 'disabled', sampleSize: 0 },
      },
    });
    expect(prismaMock.quotation.count).not.toHaveBeenCalled();
    expect(prismaMock.quotation.aggregate).not.toHaveBeenCalled();
    expect(prismaMock.order.count).not.toHaveBeenCalled();
  });

  it('calculates only traceable internal summary values when explicitly enabled', async () => {
    vi.stubEnv('FEATURE_PRICING_BI', 'true');
    prismaMock.quotation.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(2);
    prismaMock.order.count.mockResolvedValue(6);
    prismaMock.quotation.aggregate
      .mockResolvedValueOnce({ _avg: { margin: 18.5 } })
      .mockResolvedValueOnce({ _avg: { margin: 20 } })
      .mockResolvedValueOnce({ _avg: { margin: 15 } });

    const app = await buildApp();
    const response = await request(app).get('/api/pricing-bi/summary');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        feature: { key: 'pricingBi', enabled: true },
        avgMargin: 18.5,
        marginTrend: 5,
        totalQuotes: 10,
        wonDeals: 6,
        lostDeals: 2,
        winRate: 60,
        priceCompetitiveness: null,
        potentialUpside: null,
        metadata: {
          status: 'available',
          source: 'AeroLink quotation and order records',
          sampleSize: 10,
        },
      },
    });
  });

  it('does not manufacture market intelligence when the experimental feature is enabled', async () => {
    vi.stubEnv('FEATURE_PRICING_BI', 'true');
    const app = await buildApp();
    const response = await request(app).get('/api/pricing-bi/market-intelligence');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        feature: { key: 'pricingBi', enabled: true },
        items: [],
        metadata: { status: 'unavailable', sampleSize: 0 },
      },
    });
    expect(prismaMock.quotation.count).not.toHaveBeenCalled();
    expect(prismaMock.quotation.aggregate).not.toHaveBeenCalled();
    expect(prismaMock.order.count).not.toHaveBeenCalled();
  });
});
