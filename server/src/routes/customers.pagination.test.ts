import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Customer server-side pagination', () => {
  let prismaMock: {
    customer: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      groupBy: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      customer: {
        findMany: vi.fn(),
        count: vi.fn(),
        groupBy: vi.fn(),
        aggregate: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp() {
    const customersRouter = (await import('./customers.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin' } });
      next();
    });
    app.use('/api/customers', customersRouter);
    app.use(errorHandler);
    return app;
  }

  it('pushes status, search, and page boundaries into the database query', async () => {
    const customer = {
      id: 'customer-1',
      name: 'Skyline Aero',
      buyerType: 'MRO',
      businessDescription: null,
      contactName: 'Buyer',
      email: 'buyer@example.com',
      phone: null,
      registeredAddress: null,
      shipToAddress: null,
      shipForAddress: null,
      shippingContactName: null,
      shippingContactPhone: null,
      creditLimit: 100000,
      creditRating: 'A',
      paymentTerms: 'Net 30',
      paymentMethod: 'BANK',
      annualRevenue: 250000,
      vatNumber: null,
      iataCode: null,
      icaoCode: null,
      aocNumber: null,
      preferredIncoterm: null,
      customsBroker: null,
      qualityApprovalStatus: 'Approved',
      status: 'ACTIVE',
      lastOrderAt: null,
      createdAt: new Date('2026-07-14T00:00:00.000Z'),
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
      decisionMakers: [],
      contacts: [],
      competitorListings: [],
    };
    prismaMock.customer.findMany.mockResolvedValue([customer]);
    prismaMock.customer.count.mockResolvedValue(11);
    prismaMock.customer.groupBy.mockResolvedValue([
      { status: 'ACTIVE', _count: { _all: 11 } },
    ]);
    prismaMock.customer.aggregate.mockResolvedValue({ _sum: { annualRevenue: 250000 } });

    const app = await buildApp();
    const response = await request(app)
      .get('/api/customers')
      .query({ status: 'active', search: 'skyline', page: '2', limit: '10' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [{ id: 'customer-1', name: 'Skyline Aero', status: 'active' }],
      summary: { total: 11, active: 11, atRisk: 0, inactive: 0, totalRevenue: 250000 },
      pagination: { page: 2, limit: 10, total: 11, totalPages: 2 },
    });

    const findManyArgs = prismaMock.customer.findMany.mock.calls[0]?.[0];
    expect(findManyArgs).toEqual(expect.objectContaining({ skip: 10, take: 10 }));
    expect(findManyArgs.where).toEqual(expect.objectContaining({
      status: 'ACTIVE',
      OR: expect.arrayContaining([
        { name: { contains: 'skyline', mode: 'insensitive' } },
        { contactName: { contains: 'skyline', mode: 'insensitive' } },
      ]),
    }));
    expect(prismaMock.customer.count).toHaveBeenCalledWith({ where: findManyArgs.where });
  });
});
