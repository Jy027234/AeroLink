import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Inbound Webhook list pagination and filters', () => {
  let prismaMock: {
    inboundWebhookDelivery: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    webhookAuditLog: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      inboundWebhookDelivery: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
      webhookAuditLog: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../middleware/auth.js', () => ({
      authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    vi.doMock('../middleware/rbac.js', () => ({
      requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    vi.doMock('../middleware/webhookAudit.js', () => ({
      webhookAudit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
  });

  async function buildApp() {
    const inboundWebhooksRouter = (await import('./inboundWebhooks.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin' } });
      next();
    });
    app.use('/api/inbound-webhooks', inboundWebhooksRouter);
    app.use(errorHandler);
    return app;
  }

  it('pushes delivery status and offset boundaries into the database query', async () => {
    prismaMock.inboundWebhookDelivery.findMany.mockResolvedValue([]);
    prismaMock.inboundWebhookDelivery.count.mockResolvedValue(5);

    const app = await buildApp();
    const response = await request(app)
      .get('/api/inbound-webhooks/deliveries')
      .query({ endpointId: 'endpoint-1', status: 'failed', limit: '2', offset: '2' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [],
      pagination: { limit: 2, offset: 2, total: 5 },
    });

    const findManyArgs = prismaMock.inboundWebhookDelivery.findMany.mock.calls[0]?.[0];
    expect(findManyArgs).toEqual(expect.objectContaining({ skip: 2, take: 2 }));
    expect(findManyArgs.where).toEqual({ endpointId: 'endpoint-1', status: 'failed' });
    expect(prismaMock.inboundWebhookDelivery.count).toHaveBeenCalledWith({
      where: { endpointId: 'endpoint-1', status: 'failed' },
    });
  });

  it('pushes audit action, resource and date boundaries into the database query', async () => {
    prismaMock.webhookAuditLog.findMany.mockResolvedValue([]);
    prismaMock.webhookAuditLog.count.mockResolvedValue(3);

    const app = await buildApp();
    const response = await request(app)
      .get('/api/inbound-webhooks/audit')
      .query({
        action: 'RETRY',
        resourceType: 'dlq_message',
        startDate: '2026-07-01T00:00:00.000Z',
        endDate: '2026-07-14T23:59:59.999Z',
        limit: '10',
        offset: '10',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [],
      pagination: { limit: 10, offset: 10, total: 3 },
    });

    const findManyArgs = prismaMock.webhookAuditLog.findMany.mock.calls[0]?.[0];
    expect(findManyArgs).toEqual(expect.objectContaining({ skip: 10, take: 10 }));
    expect(findManyArgs.where).toEqual({
      action: 'RETRY',
      resourceType: 'dlq_message',
      createdAt: {
        gte: new Date('2026-07-01T00:00:00.000Z'),
        lte: new Date('2026-07-14T23:59:59.999Z'),
      },
    });
    expect(prismaMock.webhookAuditLog.count).toHaveBeenCalledWith({ where: findManyArgs.where });
  });

  it('rejects invalid audit date filters before querying', async () => {
    const app = await buildApp();
    const response = await request(app)
      .get('/api/inbound-webhooks/audit')
      .query({ startDate: 'not-a-date' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ message: 'startDate must be a valid date', code: 'BAD_REQUEST' });
    expect(prismaMock.webhookAuditLog.findMany).not.toHaveBeenCalled();
  });
});
