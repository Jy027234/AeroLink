import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Supplier server-side pagination', () => {
  let prismaMock: {
    supplier: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      groupBy: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      supplier: {
        findMany: vi.fn(),
        count: vi.fn(),
        groupBy: vi.fn(),
        aggregate: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp() {
    const suppliersRouter = (await import('./suppliers.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin' } });
      next();
    });
    app.use('/api/suppliers', suppliersRouter);
    app.use(errorHandler);
    return app;
  }

  it('pushes level, search, follow-up, and page boundaries into the database query', async () => {
    const supplier = {
      id: 'supplier-1',
      name: 'Skyline Aero',
      contactName: 'Supplier User',
      email: 'supplier@example.com',
      phone: null,
      address: null,
      level: 'A',
      status: 'active',
      paymentTerms: 'Net 30',
      leadTime: 7,
      performanceScore: 90,
      lastOrderAt: null,
      supplierType: 'Distributor',
      cageCode: null,
      caac145CertificateNo: null,
      caac145CertificateUrl: null,
      pmaHolder: false,
      ctsoaHolder: false,
      oemAuthorized: false,
      oemAuthorizationUrl: null,
      qualityApprovalExpiry: null,
      lastAuditDate: null,
      nextAuditDue: null,
      approvedPartCategories: null,
      specializesInAircraft: null,
      incotermsOffered: null,
      leadTimeAverage: null,
      onTimeDeliveryRate: null,
      certificateTypesProvided: null,
      moqPolicy: null,
      warrantyPolicy: null,
      returnPolicy: null,
      bankAccountInfo: null,
    };
    prismaMock.supplier.findMany.mockResolvedValue([supplier]);
    prismaMock.supplier.count.mockResolvedValue(11);
    prismaMock.supplier.groupBy.mockResolvedValue([
      { level: 'A', _count: { _all: 11 } },
    ]);
    prismaMock.supplier.aggregate.mockResolvedValue({ _avg: { performanceScore: 90 } });

    const app = await buildApp();
    const response = await request(app)
      .get('/api/suppliers')
      .query({
        level: 'a',
        search: 'skyline',
        followUpFilter: 'waiting_quote',
        page: '2',
        limit: '10',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [{ id: 'supplier-1', name: 'Skyline Aero', level: 'A' }],
      summary: { total: 11, s: 0, a: 11, b: 0, c: 0, avgScore: 90 },
      pagination: { page: 2, limit: 10, total: 11, totalPages: 2 },
    });

    const findManyArgs = prismaMock.supplier.findMany.mock.calls[0]?.[0];
    expect(findManyArgs).toEqual(expect.objectContaining({ skip: 10, take: 10 }));
    expect(findManyArgs.where).toEqual(expect.objectContaining({
      level: 'A',
      followUpLogs: { some: { outcome: 'contacted_waiting_quote' } },
      OR: expect.arrayContaining([
        { name: { contains: 'skyline', mode: 'insensitive' } },
        { contactName: { contains: 'skyline', mode: 'insensitive' } },
      ]),
    }));
    expect(prismaMock.supplier.count).toHaveBeenCalledWith({ where: findManyArgs.where });
  });
});
