import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { requestLogger } from './logger.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { getTraceSpans, resetTraceSpans } from './trace.js';

afterEach(() => resetTraceSpans());

describe('request observability middleware', () => {
  it('propagates a safe request id and replaces unsafe ids', async () => {
    resetTraceSpans();
    const app = express();
    app.use(requestLogger);
    app.get('/health', (_req, res) => res.json({ ok: true }));

    const supplied = await request(app)
      .get('/health?token=secret')
      .set('X-Request-Id', 'client-req-1')
      .set('X-Trace-Id', 'client-trace-1');
    expect(supplied.headers['x-request-id']).toBe('client-req-1');
    expect(supplied.headers['x-trace-id']).toBe('client-trace-1');
    expect(getTraceSpans()[0]?.traceId).toBe('client-trace-1');

    const generated = await request(app).get('/health').set('X-Request-Id', 'bad id with spaces');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not echo an unsafe request id from an error response', async () => {
    resetTraceSpans();
    const app = express();
    app.use(requestLogger);
    app.get('/broken', (_req, _res, next) => next(new Error('boom')));
    app.use(errorHandler);

    const response = await request(app).get('/broken').set('X-Request-Id', 'unsafe id');
    expect(response.status).toBe(500);
    expect(response.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });
});
