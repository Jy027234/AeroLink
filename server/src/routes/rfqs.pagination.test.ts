import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('RFQ server-side pagination', () => {
  let prismaMock: {
    rFQ: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      groupBy: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      rFQ: {
        findMany: vi.fn(),
        count: vi.fn(),
        groupBy: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/webhookService.js', () => ({ emitWebhookEvent: vi.fn() }));
  });

  async function buildApp() {
    const rfqsRouter = (await import('./rfqs.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin' } });
      next();
    });
    app.use('/api/rfqs', rfqsRouter);
    app.use(errorHandler);
    return app;
  }

  it('pushes search and page boundaries into the database query', async () => {
    const rfq = {
      id: 'rfq-1',
      rfqNumber: 'RFQ-0001',
      customerId: 'customer-1',
      customer: { name: 'Skyline Aero' },
      creator: { name: 'Sales User' },
      partNumber: 'PN-100',
      quantity: 2,
      uom: 'EA',
      conditionCode: 'NE',
      description: 'Replacement part',
      serialNumber: null,
      batchNumber: null,
      ataChapter: null,
      aircraftType: null,
      aircraftModel: null,
      alternatePartNumbers: null,
      targetPrice: null,
      targetPriceCurrency: 'USD',
      certificateRequired: false,
      certificateType: null,
      requiredDate: new Date('2026-08-01T00:00:00.000Z'),
      responseDeadline: null,
      leadTimeDays: null,
      urgency: 'STANDARD',
      urgencyJustification: null,
      status: 'PENDING',
      notes: null,
      createdAt: new Date('2026-07-14T00:00:00.000Z'),
    };
    prismaMock.rFQ.findMany.mockResolvedValue([rfq]);
    prismaMock.rFQ.count.mockResolvedValue(11);
    prismaMock.rFQ.groupBy.mockResolvedValue([
      { status: 'PENDING', _count: { _all: 11 } },
    ]);

    const app = await buildApp();
    const response = await request(app)
      .get('/api/rfqs')
      .query({ search: 'pn-100', page: '2', limit: '10' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [{ id: 'rfq-1', partNumber: 'PN-100' }],
      summary: { total: 11, pending: 11, sourcing: 0, quoting: 0, won: 0, lost: 0 },
      pagination: { page: 2, limit: 10, total: 11, totalPages: 2 },
    });

    const findManyArgs = prismaMock.rFQ.findMany.mock.calls[0]?.[0];
    expect(findManyArgs).toEqual(expect.objectContaining({ skip: 10, take: 10 }));
    expect(findManyArgs.where).toEqual(expect.objectContaining({
      AND: expect.arrayContaining([
        {},
        {
          OR: expect.arrayContaining([
            { rfqNumber: { contains: 'pn-100', mode: 'insensitive' } },
            { partNumber: { contains: 'pn-100', mode: 'insensitive' } },
            { customer: { is: { name: { contains: 'pn-100', mode: 'insensitive' } } } },
          ]),
        },
      ]),
    }));
    expect(prismaMock.rFQ.count).toHaveBeenCalledWith({ where: findManyArgs.where });
  });
});
