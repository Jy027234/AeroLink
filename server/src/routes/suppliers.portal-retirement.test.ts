import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('supplier portal retirement', () => {
  let prismaMock: {
    supplier: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      supplier: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
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

  it('rejects a legacy supplier invitation without creating data or sending a registration flow', async () => {
    const app = await buildApp();

    const response = await request(app)
      .post('/api/suppliers/invite')
      .send({ email: 'supplier@example.com' });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({
      success: false,
      code: 'FEATURE_DISABLED',
      message: expect.stringContaining('供应商门户已停用'),
    });
    expect(prismaMock.supplier.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.supplier.create).not.toHaveBeenCalled();
  });

  it('does not expose historical portal activation fields from supplier details', async () => {
    prismaMock.supplier.findUnique.mockResolvedValue({
      id: 'supplier-legacy',
      name: 'Legacy Supplier',
      contactName: 'Jane Doe',
      email: 'legacy@example.com',
      phone: null,
      address: null,
      level: 'B',
      status: 'active',
      paymentTerms: null,
      leadTime: null,
      performanceScore: null,
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
      activationToken: 'legacy-token',
      activationTokenExpiresAt: new Date('2026-07-20T00:00:00.000Z'),
      inventory: [],
      inquiries: [],
    });
    const app = await buildApp();

    const response = await request(app).get('/api/suppliers/supplier-legacy');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: 'supplier-legacy',
      name: 'Legacy Supplier',
      inventory: [],
      inquiries: [],
    });
    expect(response.body.data).not.toHaveProperty('activationToken');
    expect(response.body.data).not.toHaveProperty('activationTokenExpiresAt');
    expect(response.body.data).not.toHaveProperty('portalUsers');
  });
});
