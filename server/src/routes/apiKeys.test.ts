import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('API key route authorization', () => {
  let prismaMock: {
    apiKey: {
      findMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      apiKey: {
        findMany: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp(role: string) {
    const apiKeysRouter = (await import('./apiKeys.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string; role: string } }).user = { id: 'user-1', role };
      next();
    });
    app.use('/api/api-keys', apiKeysRouter);
    app.use(errorHandler);
    return app;
  }

  it('rejects non-privileged users before reading global keys', async () => {
    const app = await buildApp('sales');
    const response = await request(app).get('/api/api-keys');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_FORBIDDEN');
    expect(prismaMock.apiKey.findMany).not.toHaveBeenCalled();
  });

  it('allows privileged users to list keys', async () => {
    prismaMock.apiKey.findMany.mockResolvedValue([]);
    const app = await buildApp('gm');
    const response = await request(app).get('/api/api-keys');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: [] });
    expect(prismaMock.apiKey.findMany).toHaveBeenCalledTimes(1);
  });
});
