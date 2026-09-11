import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const mocks = vi.hoisted(() => ({
  prisma: {
    aIModel: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  encrypt: vi.fn((value: string) => `cipher-${value}`),
  decrypt: vi.fn((value: string) => value),
  generateCompletion: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ default: mocks.prisma }));
vi.mock('../lib/crypto.js', () => ({ encrypt: mocks.encrypt, decrypt: mocks.decrypt }));
vi.mock('../lib/aiService.js', () => ({ generateCompletion: mocks.generateCompletion }));

import router from './models.js';
import { errorHandler } from '../middleware/errorHandler.js';

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    name: 'Test model',
    provider: 'openai',
    modelId: 'gpt-test',
    apiKey: null,
    baseUrl: null,
    isActive: true,
    isDefault: false,
    config: '{}',
    capabilities: '[]',
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
    updatedAt: new Date('2026-09-11T00:00:00.000Z'),
    ...overrides,
  };
}

function buildApp(role = 'manager') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: string; role: string } }).user = {
      id: 'manager-1',
      role,
    };
    next();
  });
  app.use('/api/models', router);
  app.use(errorHandler);
  return app;
}

describe('model routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.prisma.$transaction.mockImplementation(async (callback: (tx: typeof mocks.prisma) => Promise<unknown>) => callback(mocks.prisma));
    mocks.prisma.aIModel.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => model(data));
    mocks.prisma.aIModel.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => model(data));
    mocks.prisma.aIModel.findUnique.mockResolvedValue(model());
    mocks.generateCompletion.mockResolvedValue({ content: 'ok', model: 'gpt-test', latency: 4 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('encrypts API keys, uses one transaction for default creation and only exposes hasApiKey', async () => {
    const response = await request(buildApp()).post('/api/models').send({
      name: 'Configured model',
      provider: 'openai',
      modelId: 'gpt-test',
      apiKey: 'secret-key',
      isDefault: true,
      config: { temperature: 0.2, apiKey: 'must-not-persist-plaintext' },
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ provider: 'openai', hasApiKey: true });
    expect(response.body.data).not.toHaveProperty('apiKey');
    expect(response.body.data.config).not.toHaveProperty('apiKey');
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.$transaction.mock.contexts[0]).toBe(mocks.prisma);
    expect(mocks.prisma.aIModel.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true },
      data: { isDefault: false },
    });
    expect(mocks.prisma.aIModel.create.mock.calls[0][0].data).toMatchObject({ apiKey: 'enc:v1:cipher-secret-key' });
  });

  it('requires model.read for list and detail reads', async () => {
    mocks.prisma.aIModel.findMany.mockResolvedValue([model()]);

    const deniedList = await request(buildApp('viewer')).get('/api/models');
    expect(deniedList.status).toBe(403);
    expect(mocks.prisma.aIModel.findMany).not.toHaveBeenCalled();

    const allowedList = await request(buildApp('manager')).get('/api/models');
    expect(allowedList.status).toBe(200);
    expect(allowedList.body.data[0]).not.toHaveProperty('apiKey');

    const deniedDetail = await request(buildApp('viewer')).get('/api/models/model-1');
    expect(deniedDetail.status).toBe(403);

    const allowedDetail = await request(buildApp('manager')).get('/api/models/model-1');
    expect(allowedDetail.status).toBe(200);
    expect(allowedDetail.body.data).not.toHaveProperty('apiKey');
  });

  it('rejects remote HTTP model endpoints before writing', async () => {
    const response = await request(buildApp()).post('/api/models').send({
      name: 'Unsafe endpoint',
      provider: 'custom',
      modelId: 'custom-model',
      baseUrl: 'http://example.com/v1',
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(mocks.prisma.aIModel.create).not.toHaveBeenCalled();
  });

  it('clears other defaults atomically when updating a model to default', async () => {
    const response = await request(buildApp()).patch('/api/models/model-1').send({ isDefault: true });

    expect(response.status).toBe(200);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.aIModel.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true, id: { not: 'model-1' } },
      data: { isDefault: false },
    });
  });

  it('uses serializable transactions and retries conflicts on PostgreSQL', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/aerolink');
    const conflict = Object.assign(new Error('serialization failure'), { code: 'P2034' });
    mocks.prisma.$transaction
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(async (callback: (tx: typeof mocks.prisma) => Promise<unknown>) => callback(mocks.prisma));

    const response = await request(buildApp()).post('/api/models').send({
      name: 'Concurrent default',
      provider: 'openai',
      modelId: 'gpt-test',
      apiKey: 'secret-key',
      isDefault: true,
    });

    expect(response.status).toBe(201);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.$transaction.mock.calls[0][1]).toMatchObject({
      isolationLevel: 'Serializable',
      timeout: 20_000,
    });
  });

  it('redacts upstream failure details from the model test response', async () => {
    mocks.prisma.aIModel.findUnique.mockResolvedValue(model({ apiKey: 'legacy-secret' }));
    mocks.generateCompletion.mockRejectedValue(new Error('upstream leaked secret-key and https://provider.example/v1'));

    const response = await request(buildApp()).post('/api/models/model-1/test').send({});

    expect(response.status).toBe(502);
    expect(response.body.message).toBe('模型连接测试失败，请检查模型配置或上游服务');
    expect(JSON.stringify(response.body)).not.toContain('secret-key');
    expect(JSON.stringify(response.body)).not.toContain('provider.example');
  });
});
