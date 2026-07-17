import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Webhook Phase2 replay controls', () => {
  let bulkReplayMock: {
    query: ReturnType<typeof vi.fn>;
    estimate: ReturnType<typeof vi.fn>;
    replay: ReturnType<typeof vi.fn>;
    getProgress: ReturnType<typeof vi.fn>;
    listBatches: ReturnType<typeof vi.fn>;
    cancelBatch: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    bulkReplayMock = {
      query: vi.fn(),
      estimate: vi.fn(),
      replay: vi.fn(),
      getProgress: vi.fn(),
      listBatches: vi.fn(),
      cancelBatch: vi.fn(),
    };
    vi.doMock('../lib/dlqService.js', () => ({ dlqService: {} }));
    vi.doMock('../lib/prisma.js', () => ({ default: {} }));
    vi.doMock('../lib/filterEngine.js', () => ({
      filterEngine: { evaluate: vi.fn() },
      validateFilterConfig: vi.fn(() => []),
    }));
    vi.doMock('../lib/bulkReplayService.js', () => ({ bulkReplayService: bulkReplayMock }));
    vi.doMock('../middleware/auth.js', () => ({
      authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    vi.doMock('../middleware/capability.js', () => ({
      requireCapability: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    vi.doMock('../middleware/webhookAudit.js', () => ({
      webhookAudit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
  });

  async function buildApp() {
    const phase2Router = (await import('./webhooks-phase2.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use('/api/webhooks/phase2', phase2Router);
    app.use(errorHandler);
    return app;
  }

  it('passes bounded replay query filters to the service', async () => {
    bulkReplayMock.query.mockResolvedValue([
      { id: 'delivery-1', eventType: 'rfq.created', endpointId: '11111111-1111-4111-8111-111111111111', payload: '{}', status: 'failed', deliveredAt: null },
    ]);
    const app = await buildApp();

    const response = await request(app).post('/api/webhooks/phase2/replay/query').send({
      startDate: '2026-07-01T00:00:00.000Z',
      endDate: '2026-07-02T00:00:00.000Z',
      eventTypes: ['rfq.created'],
      endpointIds: ['11111111-1111-4111-8111-111111111111'],
      status: 'failed',
      limit: 1000,
    });

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    expect(bulkReplayMock.query).toHaveBeenCalledWith({
      startDate: new Date('2026-07-01T00:00:00.000Z'),
      endDate: new Date('2026-07-02T00:00:00.000Z'),
      eventTypes: ['rfq.created'],
      endpointIds: ['11111111-1111-4111-8111-111111111111'],
      status: 'failed',
      limit: 1000,
    });
  });

  it('rejects invalid date ranges before querying or replaying', async () => {
    const app = await buildApp();
    const response = await request(app).post('/api/webhooks/phase2/replay/query').send({
      startDate: '2026-07-03T00:00:00.000Z',
      endDate: '2026-07-02T00:00:00.000Z',
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(bulkReplayMock.query).not.toHaveBeenCalled();
  });

  it('requires unique, non-empty delivery IDs before estimating', async () => {
    const app = await buildApp();
    const id = '22222222-2222-4222-8222-222222222222';
    const response = await request(app).post('/api/webhooks/phase2/replay/estimate').send({ deliveryIds: [id, id] });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(bulkReplayMock.estimate).not.toHaveBeenCalled();
  });
});
