import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Outbox manual replay safety', () => {
  let retryOutboxEvent: ReturnType<typeof vi.fn>;
  let createAuditLog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    retryOutboxEvent = vi.fn();
    createAuditLog = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../lib/outboxService.js', () => ({
      cancelOutboxEvent: vi.fn(),
      getOutboxStats: vi.fn(),
      isOutboxChannel: vi.fn(() => true),
      OutboxStatus: {
        PENDING: 'PENDING',
        PROCESSING: 'PROCESSING',
        RETRYING: 'RETRYING',
        DELIVERED: 'DELIVERED',
        FAILED: 'FAILED',
        CANCELLED: 'CANCELLED',
      },
      retryOutboxEvent,
    }));
    vi.doMock('../lib/prisma.js', () => ({ default: {} }));
    vi.doMock('../middleware/auditLogger.js', () => ({ createAuditLog }));
  });

  async function buildApp(role: string) {
    const outboxRoutes = (await import('./outbox.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string; name: string; role: string } }).user = {
        id: 'user-1',
        name: 'Replay operator',
        role,
      };
      next();
    });
    app.use('/api/outbox', outboxRoutes);
    app.use(errorHandler);
    return app;
  }

  it('requires an explicit replay confirmation before touching the event', async () => {
    const app = await buildApp('gm');
    const response = await request(app)
      .post('/api/outbox/event-1/retry')
      .send({ confirm: 'REPLAY' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('OUTBOX_REPLAY_CONFIRMATION_REQUIRED');
    expect(retryOutboxEvent).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('requires outbox manage capability even when confirmation is supplied', async () => {
    const app = await buildApp('sales');
    const response = await request(app)
      .post('/api/outbox/event-1/retry')
      .send({ confirm: 'replay' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_FORBIDDEN');
    expect(retryOutboxEvent).not.toHaveBeenCalled();
  });

  it('audits a confirmed replay without recording the event payload', async () => {
    retryOutboxEvent.mockResolvedValue({ id: 'event-1', status: 'PENDING' });
    const app = await buildApp('gm');
    const response = await request(app)
      .post('/api/outbox/event-1/retry')
      .send({ confirm: 'replay' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ id: 'event-1', status: 'PENDING' });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'REPLAY',
      resourceType: 'OUTBOX',
      resourceId: 'event-1',
    }));
    expect(createAuditLog.mock.calls[0][0].req.body).toEqual({ confirm: 'replay' });
    expect(createAuditLog.mock.calls[0][0]).not.toHaveProperty('payload');
  });

  it('audits rejected replays before returning the service error', async () => {
    retryOutboxEvent.mockRejectedValue(new Error('event is not failed'));
    const app = await buildApp('gm');
    const response = await request(app)
      .post('/api/outbox/event-1/retry')
      .send({ confirm: 'replay' });

    expect(response.status).toBe(500);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'REPLAY',
      resourceType: 'OUTBOX',
      resourceId: 'event-1',
      status: 'FAILURE',
      errorMessage: 'event is not failed',
    }));
  });
});
