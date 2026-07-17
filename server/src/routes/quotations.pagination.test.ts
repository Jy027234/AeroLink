import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Quotation server-side pagination', () => {
  let prismaMock: {
    quotation: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      groupBy: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      quotation: {
        findMany: vi.fn(),
        count: vi.fn(),
        groupBy: vi.fn(),
        aggregate: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/webhookService.js', () => ({ emitWebhookEvent: vi.fn() }));
  });

  async function buildApp(user: { id: string; role: string; department?: string } = { id: 'admin-1', role: 'admin' }) {
    const quotationsRouter = (await import('./quotations.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user });
      next();
    });
    app.use('/api/quotations', quotationsRouter);
    app.use(errorHandler);
    return app;
  }

  it('pushes status, search, and page boundaries into the database query', async () => {
    const quotation = {
      id: 'quotation-1',
      quoteNumber: 'QT-0001',
      rfqId: 'rfq-1',
      customerId: 'customer-1',
      customer: { name: 'Skyline Aero', email: 'buyer@example.com', contactName: 'Buyer' },
      creator: { name: 'Sales User' },
      approver: null,
      partNumber: 'PN-100',
      quantity: 2,
      unitPrice: 1250,
      totalPrice: 2500,
      costPrice: 1000,
      margin: 20,
      certificateFiles: null,
      template: 'STANDARD',
      status: 'APPROVED',
      validityDays: 30,
      saleType: 'SALE',
      incoterm: null,
      incotermLocation: null,
      leadTimeDays: 14,
      leadTimeBasis: null,
      moq: null,
      mpq: null,
      priceBasis: null,
      taxIncluded: true,
      taxRate: 13,
      warrantyDays: 90,
      warrantyTerms: null,
      packagingRequirement: null,
      shippingMethod: null,
      countryOfOrigin: 'US',
      hsCode: null,
      eccn: null,
      dualUse: false,
      ccRecipients: '[]',
      commonNote: null,
      eSignatureStatus: 'UNSIGNED',
      createdAt: new Date('2026-07-14T00:00:00.000Z'),
      approvedBy: null,
      approvedAt: null,
      sentAt: null,
      acceptedAt: null,
      withdrawnAt: null,
      withdrawalReason: null,
      customerConfirmationNote: null,
      expiryDate: new Date('2026-08-13T00:00:00.000Z'),
      orders: [],
      generatedDocuments: [],
      outboundEmails: [],
      rfq: { urgency: 'AOG' },
    };
    prismaMock.quotation.findMany.mockResolvedValue([quotation]);
    prismaMock.quotation.count.mockResolvedValue(21);
    prismaMock.quotation.groupBy.mockResolvedValue([
      { status: 'APPROVED', _count: { _all: 21 } },
    ]);
    prismaMock.quotation.aggregate.mockResolvedValue({ _sum: { totalPrice: 2500 } });

    const app = await buildApp();
    const response = await request(app)
      .get('/api/quotations')
      .query({ status: 'approved', search: 'pn-100', page: '3', limit: '10' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [{ id: 'quotation-1', quoteNumber: 'QT-0001', partNumber: 'PN-100' }],
      summary: { total: 21, pending: 0, approved: 21, sent: 0, accepted: 0, withdrawn: 0, totalValue: 2500 },
      pagination: { page: 3, limit: 10, total: 21, totalPages: 3 },
    });

    const findManyArgs = prismaMock.quotation.findMany.mock.calls[0]?.[0];
    expect(findManyArgs).toEqual(expect.objectContaining({ skip: 20, take: 10 }));
    expect(findManyArgs.where).toEqual(expect.objectContaining({
      AND: expect.arrayContaining([
        {},
        { status: 'APPROVED' },
        {
          OR: expect.arrayContaining([
            { quoteNumber: { contains: 'pn-100', mode: 'insensitive' } },
            { partNumber: { contains: 'pn-100', mode: 'insensitive' } },
            { customer: { is: { name: { contains: 'pn-100', mode: 'insensitive' } } } },
          ]),
        },
      ]),
    }));
    expect(prismaMock.quotation.count).toHaveBeenCalledWith({ where: findManyArgs.where });
  });

  it('pushes the sales owner scope into collection queries', async () => {
    prismaMock.quotation.findMany.mockResolvedValue([]);
    prismaMock.quotation.count.mockResolvedValue(0);
    prismaMock.quotation.groupBy.mockResolvedValue([]);
    prismaMock.quotation.aggregate.mockResolvedValue({ _sum: { totalPrice: null } });

    const app = await buildApp({ id: 'sales-1', role: 'sales', department: 'Sales' });
    const response = await request(app).get('/api/quotations');

    expect(response.status).toBe(200);
    expect(prismaMock.quotation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { createdBy: 'sales-1' },
    }));
    expect(prismaMock.quotation.count).toHaveBeenCalledWith({ where: { createdBy: 'sales-1' } });
  });

  it('combines manager ownership and department scope in collection queries', async () => {
    prismaMock.quotation.findMany.mockResolvedValue([]);
    prismaMock.quotation.count.mockResolvedValue(0);
    prismaMock.quotation.groupBy.mockResolvedValue([]);
    prismaMock.quotation.aggregate.mockResolvedValue({ _sum: { totalPrice: null } });

    const app = await buildApp({ id: 'manager-1', role: 'manager', department: 'Sales' });
    const response = await request(app).get('/api/quotations');

    const expectedScope = {
      OR: [
        { createdBy: 'manager-1' },
        { creator: { is: { department: 'Sales' } } },
      ],
    };
    expect(response.status).toBe(200);
    expect(prismaMock.quotation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedScope }));
    expect(prismaMock.quotation.count).toHaveBeenCalledWith({ where: expectedScope });
  });
});
