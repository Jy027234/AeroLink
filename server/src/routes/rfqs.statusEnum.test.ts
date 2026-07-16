import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('RFQ status enum shadows', () => {
  let app: express.Application;
  let rfqCreateMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    rfqCreateMock = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'rfq-enum-001',
      ...data,
      version: 1,
      requiredDate: new Date('2026-08-01T00:00:00.000Z'),
      responseDeadline: null,
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
      customer: { name: '中国国航' },
    }));
    const tx = {
      rFQ: { create: rfqCreateMock },
    };

    vi.doMock('../lib/prisma.js', () => ({ default: { rFQ: { findUnique: vi.fn() } } }));
    vi.doMock('../lib/idempotencyService.js', () => ({
      buildIdempotencyContext: vi.fn(() => ({ key: undefined })),
      applyIdempotencyHeaders: vi.fn(),
      runIdempotentOperation: vi.fn(async (_context: unknown, operation: (client: typeof tx) => Promise<{
        payload: unknown;
        statusCode?: number;
      }>) => {
        const result = await operation(tx);
        return { payload: result.payload, statusCode: result.statusCode ?? 200, replayed: false };
      }),
    }));
    vi.doMock('../lib/outboxService.js', () => ({ enqueueBusinessEvent: vi.fn() }));
    vi.doMock('../lib/transactionStateService.js', () => ({
      createInitialStatusHistory: vi.fn(),
      transitionRfqStatus: vi.fn(),
    }));

    const rfqsRouter = (await import('./rfqs.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'user-001', role: 'manager' } });
      next();
    });
    app.use('/api/rfqs', rfqsRouter);
    app.use(errorHandler);
  });

  it('dual-writes the initial PENDING enum and returns only the compatible status field', async () => {
    const response = await request(app)
      .post('/api/rfqs')
      .send({
        customerId: 'customer-001',
        partNumber: 'BAC31GK0020',
        quantity: 2,
        requiredDate: '2026-08-01',
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ id: 'rfq-enum-001', status: 'pending' });
    expect(response.body.data).not.toHaveProperty('statusEnum');
    const createData = rfqCreateMock.mock.calls[0][0].data;
    expect(createData.status).toBe('PENDING');
    expect(createData.statusEnum).toBe('PENDING');
  });
});
