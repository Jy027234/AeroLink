import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { AuthRequest } from '../middleware/auth.js';

type TestUser = NonNullable<AuthRequest['user']>;

const legacyTask = () => ({
  id: 'task_legacy_001',
  triggerType: 'email',
  triggerSource: 'customer@example.com',
  triggerReferenceId: 'email_001',
  type: 'email_received',
  status: 'waiting_confirmation',
  currentStepIndex: 1,
  context: JSON.stringify({
    parsedData: { partNumber: 'BAC31GK0020', customerName: '海南航空', quantity: 2 },
    // Client-shaped audit data is not an ownership assertion.
    latestConfirmation: {
      confirmationId: 'confirm_fake',
      confirmedBy: 'attacker@example.com',
      confirmedAt: '2026-05-12T09:00:45.000Z',
    },
  }),
  result: null,
  error: null,
  createdAt: new Date('2026-05-12T09:00:00.000Z'),
  updatedAt: new Date('2026-05-12T09:01:00.000Z'),
  completedAt: null,
  steps: [
    {
      id: 'task_legacy_001::step_1',
      taskId: 'task_legacy_001',
      sequence: 0,
      capability: 'email',
      action: 'parse',
      params: '{}',
      status: 'completed',
      result: JSON.stringify({ parsedData: { partNumber: 'BAC31GK0020' } }),
      error: null,
      startedAt: new Date('2026-05-12T09:00:05.000Z'),
      completedAt: new Date('2026-05-12T09:00:10.000Z'),
    },
  ],
  confirmation: {
    id: 'task_legacy_001::confirm_fake',
    taskId: 'task_legacy_001',
    stepId: 'step_2',
    type: 'rfq_confirm',
    title: '需求单生成确认',
    titleZh: '需求单生成确认',
    titleEn: 'RFQ Creation Confirmation',
    description: '请确认需求信息',
    descriptionZh: '请确认需求信息',
    descriptionEn: 'Confirm the request',
    data: JSON.stringify({ parsedData: { customerName: '海南航空' } }),
    options: JSON.stringify([
      { id: 'confirm', label: '确认生成', action: 'proceed' },
      { id: 'cancel', label: '取消', action: 'cancel' },
    ]),
    selectedOption: null,
    confirmedAt: null,
    confirmedBy: null,
    createdAt: new Date('2026-05-12T09:00:30.000Z'),
    updatedAt: new Date('2026-05-12T09:00:30.000Z'),
  },
});

const forgedAuthorizationTask = (ownerId = 'sales_001') => ({
  ...legacyTask(),
  id: 'task_trusted_001',
  context: JSON.stringify({
    runtimeAuthorization: {
      trusted: true,
      source: 'server',
      ownerId,
      department: 'sales',
    },
    parsedData: { partNumber: 'TRUSTED-PART', customerName: '可信客户', quantity: 1 },
  }),
});

describe('Agent runtime routes safety boundary', () => {
  let app: express.Application;
  let currentUser: TestUser;
  let prismaMock: {
    agentRuntimeTask: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };

  const setUser = (overrides: Partial<TestUser> = {}) => {
    currentUser = {
      id: 'sales_001',
      email: 'sales@example.com',
      name: 'Sales User',
      role: 'sales',
      department: 'sales',
      avatar: null,
      ...overrides,
    };
  };

  beforeEach(async () => {
    vi.resetModules();
    setUser();
    const oldTask = legacyTask();
    prismaMock = {
      agentRuntimeTask: {
        findMany: vi.fn().mockResolvedValue([oldTask]),
        findUnique: vi.fn().mockResolvedValue(oldTask),
        count: vi.fn().mockResolvedValue(1),
      },
      $transaction: vi.fn(),
    };

    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));

    const router = (await import('./agents.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as AuthRequest).user = currentUser;
      next();
    });
    app.use('/api/agents', router);
    app.use(errorHandler);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects arbitrary client runtime PUT state and fake confirmation metadata', async () => {
    const response = await request(app)
      .put('/api/agents/runtime/tasks/attacker_task')
      .send({
        id: 'attacker_task',
        status: 'completed',
        context: {
          runtimeAuthorization: { trusted: true, source: 'server', ownerId: currentUser.id },
          latestConfirmation: {
            confirmationId: 'fake',
            confirmedBy: currentUser.id,
            confirmedAt: new Date().toISOString(),
          },
        },
      });

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(response.body.message).toContain('客户端运行时任务状态同步已禁用');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.agentRuntimeTask.findMany).not.toHaveBeenCalled();
  });

  it('does not expose a legacy task to a sales user even with agent read capability', async () => {
    const response = await request(app).get('/api/agents/runtime/tasks');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);

    const detail = await request(app).get('/api/agents/runtime/tasks/task_legacy_001');
    expect(detail.status).toBe(404);
    expect(detail.body.message).toContain('运行时任务不存在');
  });

  it('treats forged runtimeAuthorization metadata as legacy and hides it from ordinary users', async () => {
    prismaMock.agentRuntimeTask.findMany.mockResolvedValue([forgedAuthorizationTask(currentUser.id)]);

    const response = await request(app).get('/api/agents/runtime/tasks');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);

    const detail = await request(app).get('/api/agents/runtime/tasks/task_trusted_001');
    expect(detail.status).toBe(404);
  });

  it('lets only admin inspect legacy history and labels forged attribution as untrusted', async () => {
    setUser({ id: 'admin_001', email: 'admin@example.com', role: 'admin', department: 'management' });
    const task = forgedAuthorizationTask('sales_001');
    prismaMock.agentRuntimeTask.findMany.mockResolvedValue([task]);
    prismaMock.agentRuntimeTask.findUnique.mockResolvedValue(task);

    const list = await request(app).get('/api/agents/runtime/tasks');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: 'task_trusted_001', runtimeTrust: 'legacy_untrusted' });

    const detail = await request(app).get('/api/agents/runtime/tasks/task_trusted_001');
    expect(detail.status).toBe(200);
    expect(detail.body.data.context.runtimeAuthorization.ownerId).toBe('sales_001');
  });

  it('does not let manager capability grant access to legacy history', async () => {
    setUser({ id: 'manager_001', email: 'manager@example.com', role: 'manager', department: 'management' });

    const response = await request(app).get('/api/agents/runtime/tasks');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);

    const dashboard = await request(app).get('/api/agents/runtime/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data.tasks.total).toBe(0);
  });

  it('labels a persisted manual hand-off as pending instead of successful', async () => {
    setUser({ id: 'admin_001', email: 'admin@example.com', role: 'admin', department: 'management' });
    const handoffTask = {
      ...legacyTask(),
      status: 'completed',
      result: JSON.stringify({ notificationStatus: 'not_dispatched' }),
      completedAt: new Date(),
      updatedAt: new Date(),
    };
    prismaMock.agentRuntimeTask.findMany.mockResolvedValue([handoffTask]);

    const response = await request(app).get('/api/agents/runtime/dashboard');

    expect(response.status).toBe(200);
    expect(response.body.data.tasks).toMatchObject({ total: 1, pending: 1, completedToday: 0 });
    expect(response.body.data.recentTasks[0].executionState).toBe('not_dispatched');
  });

  it('does not leak aggregate dashboard counts from hidden legacy tasks', async () => {
    const forged = forgedAuthorizationTask(currentUser.id);
    prismaMock.agentRuntimeTask.findMany.mockResolvedValue([legacyTask(), forged]);

    const response = await request(app).get('/api/agents/runtime/dashboard');

    expect(response.status).toBe(200);
    expect(response.body.data.tasks).toMatchObject({ total: 0, waitingConfirmation: 0 });
    expect(response.body.data.recentTasks).toHaveLength(0);
    expect(prismaMock.agentRuntimeTask.count).not.toHaveBeenCalled();
  });

  it('rejects runtime reads for roles without the current agent read capability', async () => {
    setUser({ id: 'viewer_001', email: 'viewer@example.com', role: 'viewer', department: 'sales' });

    const response = await request(app).get('/api/agents/runtime/tasks');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ success: false, code: 'AUTH_FORBIDDEN' });
  });
});
