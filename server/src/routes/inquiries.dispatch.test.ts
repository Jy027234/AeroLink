import express from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());

it('never records SENT without a real dispatch result', async () => {
  const update = vi.fn();
  vi.doMock('../lib/prisma.js', () => ({ default: {
    inquiry: { findFirst: vi.fn().mockResolvedValue({ id: 'i1', status: 'DRAFT' }), update },
  } }));
  const router = (await import('./inquiries.js')).default;
  const { errorHandler } = await import('../middleware/errorHandler.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { user: { id: 'u1', role: 'sales' } }); next(); });
  app.use(router);
  app.use(errorHandler);
  const response = await request(app).post('/i1/send').send({ status: 'SENT', sentAt: '2026-09-08' });
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('MANUAL_WORKFLOW_REQUIRED');
  expect(update).not.toHaveBeenCalled();
});
