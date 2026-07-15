import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Order server-side pagination', () => {
  let prismaMock: {
    order: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      groupBy: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      order: {
        findMany: vi.fn(),
        count: vi.fn(),
        groupBy: vi.fn(),
        aggregate: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/webhookService.js', () => ({ emitWebhookEvent: vi.fn() }));
  });

  async function buildApp() {
    const ordersRouter = (await import('./orders.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use('/api/orders', ordersRouter);
    app.use(errorHandler);
    return app;
  }

  it('maps product status tabs and pushes search/page boundaries to the database', async () => {
    const order = {
      id: 'order-1',
      orderNumber: 'SO-0001',
      soNumber: 'SO-0001',
      poNumber: null,
      quotationId: 'quotation-1',
      customerId: 'customer-1',
      customer: { name: 'Skyline Aero' },
      partNumber: 'PN-100',
      quantity: 2,
      totalAmount: 5000,
      status: 'SO_CREATED',
      createdAt: new Date('2026-07-14T00:00:00.000Z'),
      deliveryDate: null,
      trackingNumber: null,
      carrier: null,
      generatedDocuments: [],
      saleType: 'Sale',
      incoterm: null,
      incotermLocation: null,
      shipToId: null,
      shipForId: null,
      warrantyDays: null,
      warrantyStartDate: null,
      certificateRequired: true,
      certificateType: null,
      certificateDelivered: false,
      packagingStandard: null,
      shippingMethod: null,
      carrierAccount: null,
      inspectionRequired: false,
      inspectionPassed: null,
      inspectionDate: null,
      customsClearanceRequired: false,
      customsDeclarationNo: null,
      importDuty: null,
      vatAmount: null,
      totalLandCost: null,
      exchangeCoreCharge: null,
      exchangeCoreDueDate: null,
      eSignatureCustomer: null,
      eSignatureSupplier: null,
    };
    prismaMock.order.findMany.mockResolvedValue([order]);
    prismaMock.order.count.mockResolvedValue(12);
    prismaMock.order.groupBy.mockResolvedValue([
      { status: 'SO_CREATED', _count: { _all: 12 } },
    ]);
    prismaMock.order.aggregate.mockResolvedValue({ _sum: { totalAmount: 5000 } });

    const app = await buildApp();
    const response = await request(app)
      .get('/api/orders')
      .query({ status: 'in_progress', search: 'pn-100', page: '2', limit: '10' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [{ id: 'order-1', orderNumber: 'SO-0001', partNumber: 'PN-100' }],
      summary: { total: 12, inProgress: 12, completed: 0, totalValue: 5000 },
      pagination: { page: 2, limit: 10, total: 12, totalPages: 2 },
    });

    const findManyArgs = prismaMock.order.findMany.mock.calls[0]?.[0];
    expect(findManyArgs).toEqual(expect.objectContaining({ skip: 10, take: 10 }));
    expect(findManyArgs.where).toEqual(expect.objectContaining({
      status: { notIn: ['COMPLETED', 'DELIVERED'] },
      OR: expect.arrayContaining([
        { orderNumber: { contains: 'pn-100', mode: 'insensitive' } },
        { partNumber: { contains: 'pn-100', mode: 'insensitive' } },
        { customer: { is: { name: { contains: 'pn-100', mode: 'insensitive' } } } },
      ]),
    }));
    expect(prismaMock.order.count).toHaveBeenCalledWith({ where: findManyArgs.where });
  });
});
