import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('pricing BI cost visibility', () => {
  let prismaMock: {
    quotation: { count: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> };
    order: { count: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('FEATURE_PRICING_BI', 'true');
    prismaMock = {
      quotation: {
        count: vi.fn().mockResolvedValue(5),
        aggregate: vi.fn().mockResolvedValue({ _avg: { margin: 18 } }),
      },
      order: { count: vi.fn().mockResolvedValue(2) },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  it('returns operational counts but suppresses margin for viewer', async () => {
    const router = (await import('./pricingBI.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'viewer-1', role: 'viewer' } });
      next();
    });
    app.use('/api/pricing-bi', router);
    app.use(errorHandler);

    const response = await request(app).get('/api/pricing-bi/summary');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      totalQuotes: 5,
      wonDeals: 2,
      avgMargin: null,
      marginTrend: null,
    });
    expect(prismaMock.quotation.aggregate).not.toHaveBeenCalled();
  });
});
