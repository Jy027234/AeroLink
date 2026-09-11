import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AuthRequest } from '../middleware/auth.js';

const agentRow = () => ({
  id: 'builtin-rfq_extraction',
  name: 'RFQ需求提取',
  type: 'RFQ_EXTRACTION',
  description: 'extract',
  isActive: true,
  builtinKey: 'rfq_extraction',
  draftRevision: 1,
  publishedVersion: 1,
  config: JSON.stringify({ modelId: null, temperature: 0.1, maxTokens: 1024 }),
  prompts: JSON.stringify([
    { role: 'system', content: 'extract' },
    { role: 'user', content: '{{subject}} {{body}}' },
  ]),
  createdAt: new Date('2026-09-11T00:00:00Z'),
  updatedAt: new Date('2026-09-11T00:00:00Z'),
});

describe('AI agent registry routes', () => {
  let app: express.Application;
  let current: ReturnType<typeof agentRow>;
  let prismaMock: any;
  let executeAgentMock: ReturnType<typeof vi.fn>;
  let currentUserRole = 'admin';

  beforeEach(async () => {
    vi.resetModules();
    current = agentRow();
    currentUserRole = 'admin';
    executeAgentMock = vi.fn().mockResolvedValue({
      output: 'ok', model: 'mock-model', latency: 3, promptVersion: 1, agentId: current.id,
    });
    prismaMock = {
      aIAgent: {
        findMany: vi.fn().mockResolvedValue([current]),
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where.id === current.id) return current;
          return null;
        }),
        create: vi.fn().mockResolvedValue(current),
        update: vi.fn().mockImplementation(async ({ data }: any) => Object.assign(current, data)),
        updateMany: vi.fn().mockImplementation(async ({ where, data }: any) => {
          if (where.draftRevision !== undefined && where.draftRevision !== current.draftRevision) return { count: 0 };
          if (where.publishedVersion !== undefined && where.publishedVersion !== current.publishedVersion) return { count: 0 };
          if (data.draftRevision?.increment) current.draftRevision += data.draftRevision.increment;
          if (data.publishedVersion !== undefined) current.publishedVersion = data.publishedVersion;
          if (data.isActive !== undefined) current.isActive = data.isActive;
          if (data.prompts !== undefined) current.prompts = data.prompts;
          if (data.config !== undefined) current.config = data.config;
          return { count: 1 };
        }),
        delete: vi.fn(),
      },
      aIAgentVersion: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'version-1', agentId: current.id, version: 1,
          prompts: current.prompts, config: current.config,
          createdBy: null, createdAt: new Date('2026-09-11T00:00:00Z'),
        }]),
        findUnique: vi.fn().mockResolvedValue({
          id: 'version-1', agentId: current.id, version: 1,
          prompts: current.prompts, config: current.config,
          createdBy: null, createdAt: new Date('2026-09-11T00:00:00Z'),
        }),
        create: vi.fn(),
      },
      $transaction: vi.fn().mockImplementation(async (callback: any) => callback(prismaMock)),
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/aiAgentExecution.js', () => ({ executeAgent: executeAgentMock }));
    const router = (await import('./agents.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthRequest).user = {
        id: 'admin-1', email: 'admin@example.com', name: 'Admin', role: currentUserRole, department: 'management', avatar: null,
      };
      next();
    });
    app.use('/api/agents', router);
    app.use(errorHandler);
  });

  it('requires the draft revision and rejects stale patches atomically', async () => {
    prismaMock.aIAgent.updateMany.mockResolvedValue({ count: 0 });
    const response = await request(app)
      .patch(`/api/agents/${current.id}`)
      .send({ expectedRevision: 1, prompts: [{ role: 'user', content: 'new' }] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RESOURCE_CONFLICT');
    expect(prismaMock.aIAgent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: current.id, draftRevision: 1 },
    }));
  });

  it('requires agent.read before exposing prompt and version projections', async () => {
    currentUserRole = 'viewer';

    const list = await request(app).get('/api/agents');
    expect(list.status).toBe(403);
    expect(prismaMock.aIAgent.findMany).not.toHaveBeenCalled();

    const versions = await request(app).get(`/api/agents/${current.id}/versions`);
    expect(versions.status).toBe(403);
    expect(prismaMock.aIAgentVersion.findMany).not.toHaveBeenCalled();
  });

  it('publishes an immutable snapshot and returns its prompt revision', async () => {
    const response = await request(app)
      .post(`/api/agents/${current.id}/publish`)
      .send({ expectedRevision: 1 });

    expect(response.status).toBe(200);
    expect(response.body.data.publishedVersion).toBe(2);
    expect(prismaMock.aIAgentVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ agentId: current.id, version: 2, createdBy: 'admin-1' }),
    }));
  });

  it('restores a version into a new draft without changing the published pointer', async () => {
    const response = await request(app)
      .post(`/api/agents/${current.id}/restore`)
      .send({ version: 1, expectedRevision: 1 });

    expect(response.status).toBe(200);
    expect(response.body.data.publishedVersion).toBe(1);
    expect(response.body.data.draftRevision).toBe(2);
    expect(prismaMock.aIAgent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ prompts: current.prompts, config: current.config }),
    }));
  });

  it('requires both manage and run capabilities for test execution and passes actor identity', async () => {
    const response = await request(app)
      .post(`/api/agents/${current.id}/test`)
      .send({ input: { subject: 'RFQ', body: 'BAC31GK0020 x 2' } });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ output: 'ok', promptVersion: 1, agentId: current.id });
    expect(executeAgentMock).toHaveBeenCalledWith(current.id, { subject: 'RFQ', body: 'BAC31GK0020 x 2' }, {
      actorId: 'admin-1', action: 'test',
    });
  });

  it('does not accept input.systemPrompt as a runtime configuration override', async () => {
    const response = await request(app)
      .post(`/api/agents/${current.id}/run`)
      .send({ task: 'classify_email', input: { subject: 'RFQ', body: 'text', systemPrompt: 'unsafe' } });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BAD_REQUEST');
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it('rejects unknown run envelope fields instead of silently ignoring them', async () => {
    const response = await request(app)
      .post(`/api/agents/${current.id}/run`)
      .send({ task: 'classify_email', input: { subject: 'RFQ', body: 'text' }, actorId: 'forged' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it('keeps built-in records and history undeletable while allowing disable through a revisioned toggle', async () => {
    const deleted = await request(app).delete(`/api/agents/${current.id}`);
    expect(deleted.status).toBe(400);
    expect(prismaMock.aIAgent.delete).not.toHaveBeenCalled();

    const toggled = await request(app)
      .post(`/api/agents/${current.id}/toggle`)
      .send({ expectedRevision: 1 });
    expect(toggled.status).toBe(200);
    expect(toggled.body.data.draftRevision).toBe(2);
    expect(prismaMock.aIAgent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: current.id, draftRevision: 1 },
      data: expect.objectContaining({ isActive: false, draftRevision: { increment: 1 } }),
    }));
  });
});
