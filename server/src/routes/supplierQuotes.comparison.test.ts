import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

function buildQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'supplier-quote-1',
    partNumber: '3214-567-100',
    unitPrice: 100,
    unitPriceDecimal: null,
    totalPrice: 100,
    totalPriceDecimal: null,
    leadTimeDays: 7,
    status: 'pending',
    statusEnum: null,
    isWinner: false,
    supplier: {
      id: 'supplier-1',
      name: 'Aviation Parts Inc.',
      level: 'A',
      performanceScore: 90,
    },
    ...overrides,
  };
}

describe('supplier quote rule comparison', () => {
  let prismaMock: {
    supplierQuote: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      supplierQuote: { findMany: vi.fn() },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp() {
    const router = (await import('./supplierQuotes.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin' } });
      next();
    });
    app.use('/api/supplier-quotes', router);
    app.use(errorHandler);
    return app;
  }

  it('requires a scoped RFQ or inquiry instead of comparing every supplier quote', async () => {
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(prismaMock.supplierQuote.findMany).not.toHaveBeenCalled();
  });

  it('returns an explicit unavailable state when no scoped quotes exist', async () => {
    prismaMock.supplierQuote.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqId: 'rfq-1' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        quotes: [],
        topRanked: null,
        summary: { totalQuotes: 0, lowestPrice: null, averagePrice: null },
        metadata: { status: 'unavailable', sampleSize: 0 },
      },
    });
  });

  it('ranks only complete, recorded price, lead-time and performance fields', async () => {
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote(),
      buildQuote({
        id: 'supplier-quote-2',
        unitPrice: 120,
        totalPrice: 120,
        leadTimeDays: 10,
        supplier: {
          id: 'supplier-2',
          name: 'Global Aero Supply',
          level: 'B',
          performanceScore: 80,
        },
      }),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqId: 'rfq-1' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        topRanked: { id: 'supplier-quote-1', ruleScore: 98 },
        metadata: {
          status: 'available',
          source: 'AeroLink supplier quote and supplier master records',
          algorithmVersion: 'supplier-quote-rule-v2',
          sampleSize: 2,
        },
      },
    });
    expect(response.body.data.quotes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'supplier-quote-1',
        ruleScore: 98,
        scoreComponents: { price: 100, leadTime: 100, supplierPerformance: 90 },
      }),
      expect.objectContaining({
        id: 'supplier-quote-2',
        ruleScore: 41.5,
        scoreComponents: { price: 0, leadTime: 85, supplierPerformance: 80 },
      }),
    ]));
  });

  it('does not infer missing supplier performance or emit a ranking', async () => {
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote({ supplier: { id: 'supplier-1', name: 'Aviation Parts Inc.', level: 'A', performanceScore: null } }),
      buildQuote({
        id: 'supplier-quote-2',
        supplier: { id: 'supplier-2', name: 'Global Aero Supply', level: 'B', performanceScore: 80 },
      }),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqId: 'rfq-1' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        topRanked: null,
        metadata: { status: 'insufficient_data', sampleSize: 2 },
      },
    });
    expect(response.body.data.quotes).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleScore: null }),
    ]));
  });
});
