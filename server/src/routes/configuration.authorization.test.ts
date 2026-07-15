import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

function attachUser(role: string) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string; role: string } }).user = {
      id: 'user-1',
      role,
    };
    next();
  };
}

async function getErrorHandler() {
  return (await import('../middleware/errorHandler.js')).errorHandler;
}

describe('configuration route authorization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../lib/prisma.js', () => ({ default: {} }));
  });

  it('only allows manager-level users to create agents', async () => {
    const agentsRouter = (await import('./agents.js')).default;
    const app = express();
    app.use(express.json());
    app.use(attachUser('sales'));
    app.use('/api/agents', agentsRouter);
    app.use(await getErrorHandler());

    const response = await request(app).post('/api/agents').send({});

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_FORBIDDEN');
  });

  it('only allows manager-level users to create AI models', async () => {
    const modelsRouter = (await import('./models.js')).default;
    const app = express();
    app.use(express.json());
    app.use(attachUser('sales'));
    app.use('/api/models', modelsRouter);
    app.use(await getErrorHandler());

    const response = await request(app).post('/api/models').send({});

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_FORBIDDEN');
  });

  it('only allows manager-level users to create workflow definitions', async () => {
    vi.doMock('../middleware/auth.js', () => ({
      authenticate: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    }));
    const workflowsRouter = (await import('./workflows.js')).default;
    const app = express();
    app.use(express.json());
    app.use(attachUser('sales'));
    app.use('/api/workflows', workflowsRouter);
    app.use(await getErrorHandler());

    const response = await request(app).post('/api/workflows/definitions').send({});

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_FORBIDDEN');
  });

  it('keeps manager-level configuration requests behind validation', async () => {
    vi.doMock('../middleware/auth.js', () => ({
      authenticate: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    }));
    const workflowsRouter = (await import('./workflows.js')).default;
    const app = express();
    app.use(express.json());
    app.use(attachUser('manager'));
    app.use('/api/workflows', workflowsRouter);
    app.use(await getErrorHandler());

    const response = await request(app).post('/api/workflows/definitions').send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('accepts the legacy administrator role alias for configuration management', async () => {
    vi.doMock('../middleware/auth.js', () => ({
      authenticate: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    }));
    const workflowsRouter = (await import('./workflows.js')).default;
    const app = express();
    app.use(express.json());
    app.use(attachUser('administrator'));
    app.use('/api/workflows', workflowsRouter);
    app.use(await getErrorHandler());

    const response = await request(app).post('/api/workflows/definitions').send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });
});
