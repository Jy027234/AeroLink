import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Webhook Phase2 DLQ pagination and filters', () => {
  let dlqMock: {
    listQuarantined: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    dlqMock = {
      listQuarantined: vi.fn(),
    };
    vi.doMock('../lib/dlqService.js', () => ({ dlqService: dlqMock }));
    vi.doMock('../lib/prisma.js', () => ({ default: {} }));
    vi.doMock('../lib/filterEngine.js', () => ({
      filterEngine: { evaluate: vi.fn() },
      validateFilterConfig: vi.fn(() => []),
    }));
    vi.doMock('../lib/bulkReplayService.js', () => ({
      bulkReplayService: {
        query: vi.fn(),
        estimate: vi.fn(),
        replay: vi.fn(),
        getProgress: vi.fn(),
        listBatches: vi.fn(),
        cancelBatch: vi.fn(),
      },
    }));
    vi.doMock('../middleware/auth.js', () => ({
      authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    vi.doMock('../middleware/rbac.js', () => ({
      requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    vi.doMock('../middleware/webhookAudit.js', () => ({
      webhookAudit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    vi.doMock('../middleware/validate.js', () => ({
      validateBody: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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

  it('passes DLQ filters and preserves quarantine fields in the response', async () => {
    dlqMock.listQuarantined.mockResolvedValue({
      deliveries: [
        {
          id: 'delivery-1',
          endpointId: 'endpoint-1',
          failureReason: 'timeout',
          quarantineAt: new Date('2026-07-14T10:00:00.000Z'),
          attemptCount: 5,
          lastError: 'ETIMEDOUT',
        },
      ],
      total: 6,
    });

    const app = await buildApp();
    const response = await request(app)
      .get('/api/webhooks/phase2/dlq')
      .query({ endpointId: 'endpoint-1', failureReason: 'timeout', limit: '10', offset: '20' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: [
        {
          id: 'delivery-1',
          endpointId: 'endpoint-1',
          failureReason: 'timeout',
          attemptCount: 5,
          lastError: 'ETIMEDOUT',
        },
      ],
      pagination: { limit: 10, offset: 20, total: 6 },
    });
    expect(response.body.data[0].quarantineAt).toBe('2026-07-14T10:00:00.000Z');
    expect(dlqMock.listQuarantined).toHaveBeenCalledWith({
      limit: 10,
      offset: 20,
      endpointId: 'endpoint-1',
      failureReason: 'timeout',
    });
  });
});
