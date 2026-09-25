import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const extractSupplierQuoteEmail = vi.fn();

describe('sourcing AI task routes', () => {
  let app: express.Application;
  let prismaMock: Record<string, any>;
  let tasks: Array<Record<string, any>>;
  let drafts: Array<Record<string, any>>;
  let activeUser = { id: 'sales-1', email: 'sales@example.com', name: 'Sales', role: 'sales' };

  function matches(task: Record<string, any>, where: Record<string, any> = {}) {
    if (where.id && task.id !== where.id) return false;
    if (where.actorId && task.actorId !== where.actorId) return false;
    if (where.emailId && task.emailId !== where.emailId) return false;
    if (where.inquiryId && task.inquiryId !== where.inquiryId) return false;
    if (where.status) {
      if (typeof where.status === 'string' && task.status !== where.status) return false;
      if (typeof where.status === 'object' && where.status.in && !where.status.in.includes(task.status)) return false;
    }
    if (where.attempt?.lt !== undefined && !(task.attempt < where.attempt.lt)) return false;
    if (where.attempt?.equals !== undefined && task.attempt !== where.attempt.equals) return false;
    if (where.maxAttempts !== undefined && task.maxAttempts !== where.maxAttempts) return false;
    return true;
  }

  function updateTask(task: Record<string, any>, data: Record<string, any>) {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) task[key] += value.increment;
      else task[key] = value;
    }
    task.updatedAt = new Date();
  }

  function taskRecord(overrides: Record<string, unknown> = {}) {
    const now = new Date('2026-09-22T00:00:00.000Z');
    return {
      id: 'task-seeded',
      actorId: 'sales-1',
      type: 'supplier_quote_extraction',
      emailId: 'email-1',
      inquiryId: 'inquiry-1',
      status: 'PENDING',
      attempt: 1,
      maxAttempts: 3,
      idempotencyKey: 'seeded-key',
      draftId: null,
      errorSummary: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      updatedAt: now,
      ...overrides,
    };
  }

  async function initializeApp() {
    vi.resetModules();
    tasks = [];
    drafts = [];
    activeUser = { id: 'sales-1', email: 'sales@example.com', name: 'Sales', role: 'sales' };
    extractSupplierQuoteEmail.mockReset().mockResolvedValue({
      items: [{
        partNumber: 'PN-1',
        quantity: 2,
        unitPrice: 100,
        currency: 'USD',
        leadTimeDays: 5,
        validUntil: null,
        condition: null,
        certificate: null,
        taxIncluded: true,
        freightIncluded: false,
        incoterm: 'fca',
        evidenceText: 'USD 100, five days',
      }],
      ai: { agentId: 'agent-quote', promptVersion: 3, model: 'model-x' },
    });

    const taskModel = {
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        if (tasks.some((task) => task.actorId === data.actorId && task.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const task = taskRecord({
          id: `task-${tasks.length + 1}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        tasks.push(task);
        return task;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        if (where.id) return tasks.find((task) => task.id === where.id) ?? null;
        const compound = where.actorId_idempotencyKey;
        if (compound) return tasks.find((task) => task.actorId === compound.actorId && task.idempotencyKey === compound.idempotencyKey) ?? null;
        return null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const task = tasks.find((item) => item.id === where.id);
        if (!task) throw new Error('missing task');
        return task;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => tasks.find((task) => matches(task, where)) ?? null),
      findMany: vi.fn(async ({ where, take }: { where?: Record<string, any>; take?: number }) => {
        const matching = tasks.filter((task) => matches(task, where ?? {}))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
        return take === undefined ? matching : matching.slice(0, take);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const task = tasks.find((item) => matches(item, where));
        if (!task) return { count: 0 };
        updateTask(task, data);
        return { count: 1 };
      }),
    };
    const email = { id: 'email-1', subject: 'Vendor quote', body: 'private email body' };
    const inquiry = {
      id: 'inquiry-1',
      inquiryNumber: 'INQ-001',
      supplierId: 'supplier-1',
      items: [{ id: 'item-1', partNumber: 'PN-1', quantity: 4 }],
    };
    prismaMock = {
      sourcingAiTask: taskModel,
      email: { findUnique: vi.fn(async () => email) },
      inquiry: { findUnique: vi.fn(async () => inquiry) },
      inquiryEmailLink: { findUnique: vi.fn(async () => ({ confirmationStatus: 'CONFIRMED' })) },
      supplierQuoteDraft: {
        findFirst: vi.fn(async () => [...drafts].sort((a, b) => b.version - a.version)[0] ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          const draft = { id: `draft-${drafts.length + 1}`, ...data };
          drafts.push(draft);
          return { id: draft.id };
        }),
      },
      supplierQuote: { create: vi.fn() },
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/aiService.js', () => ({ extractSupplierQuoteEmail }));

    const router = (await import('./sourcingAiTasks.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: typeof activeUser }).user = activeUser;
      next();
    });
    app.use('/api/sourcing-ai-tasks', router);
    app.use(errorHandler);
  }

  beforeEach(async () => initializeApp());
  afterEach(() => vi.resetModules());

  it('persists a pending task and replays its idempotency key without running the model', async () => {
    const input = {
      type: 'supplier_quote_extraction',
      emailId: 'email-1',
      inquiryId: 'inquiry-1',
      idempotencyKey: 'request-1',
    };
    const first = await request(app).post('/api/sourcing-ai-tasks').send(input);
    const replay = await request(app).post('/api/sourcing-ai-tasks').send(input);

    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      actorId: 'sales-1',
      type: 'supplier_quote_extraction',
      status: 'PENDING',
      attempt: 1,
      maxAttempts: 3,
      draftId: null,
    });
    expect(first.body.data).not.toHaveProperty('idempotencyKey');
    expect(JSON.stringify(first.body)).not.toContain('private email body');
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(tasks).toHaveLength(1);
    expect(drafts).toHaveLength(0);
    expect(extractSupplierQuoteEmail).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('does not reveal another actor’s tasks, while an admin can inspect them', async () => {
    tasks.push(taskRecord({ id: 'owned-task', actorId: 'sales-1' }));
    tasks.push(taskRecord({ id: 'other-task', actorId: 'sales-2', idempotencyKey: 'other-key' }));

    const hidden = await request(app).get('/api/sourcing-ai-tasks/other-task');
    const own = await request(app).get('/api/sourcing-ai-tasks/owned-task');
    const ownList = await request(app).get('/api/sourcing-ai-tasks');
    expect(hidden.status).toBe(404);
    expect(own.status).toBe(200);
    expect(own.body.data.id).toBe('owned-task');
    expect(ownList.body.data.map((task: { id: string }) => task.id)).toEqual(['owned-task']);

    activeUser = { id: 'admin-1', email: 'admin@example.com', name: 'Admin', role: 'administrator' };
    const admin = await request(app).get('/api/sourcing-ai-tasks/other-task');
    const adminList = await request(app).get('/api/sourcing-ai-tasks');
    expect(admin.status).toBe(200);
    expect(adminList.body.data.map((task: { id: string }) => task.id)).toContain('other-task');
  });

  it('filters by the exact email and inquiry pair, preserves actor scope, and returns all matching history', async () => {
    for (let index = 0; index < 55; index += 1) {
      tasks.push(taskRecord({
        id: `pair-${index}`,
        emailId: 'email-match',
        inquiryId: 'inquiry-match',
        createdAt: new Date(Date.UTC(2020, 0, 1) + index * 1_000),
      }));
    }
    tasks.push(taskRecord({
      id: 'other-actor-pair', actorId: 'sales-2', emailId: 'email-match', inquiryId: 'inquiry-match',
    }));
    tasks.push(taskRecord({ id: 'other-inquiry', emailId: 'email-match', inquiryId: 'inquiry-other' }));
    tasks.push(taskRecord({ id: 'other-email', emailId: 'email-other', inquiryId: 'inquiry-match' }));
    for (let index = 0; index < 55; index += 1) {
      tasks.push(taskRecord({
        id: `recent-${index}`,
        emailId: 'different-email',
        inquiryId: 'different-inquiry',
        createdAt: new Date(Date.UTC(2025, 0, 1) + index * 1_000),
      }));
    }

    const own = await request(app).get('/api/sourcing-ai-tasks')
      .query({ emailId: 'email-match', inquiryId: 'inquiry-match' });
    expect(own.status).toBe(200);
    expect(own.body.data).toHaveLength(55);
    expect(own.body.data.every((task: { emailId: string; inquiryId: string; actorId: string }) =>
      task.emailId === 'email-match' && task.inquiryId === 'inquiry-match' && task.actorId === 'sales-1')).toBe(true);

    const partial = await request(app).get('/api/sourcing-ai-tasks').query({ emailId: 'email-match' });
    expect(partial.status).toBe(400);

    activeUser = { id: 'admin-1', email: 'admin@example.com', name: 'Admin', role: 'administrator' };
    const admin = await request(app).get('/api/sourcing-ai-tasks')
      .query({ emailId: 'email-match', inquiryId: 'inquiry-match' });
    expect(admin.status).toBe(200);
    expect(admin.body.data).toHaveLength(56);
    expect(admin.body.data.map((task: { id: string }) => task.id)).toContain('other-actor-pair');
  });

  it('atomically retries a failed task by returning it to pending and increasing its attempt', async () => {
    tasks.push(taskRecord({ id: 'retry-task', status: 'FAILED', errorSummary: 'AI 抽取失败，请稍后重试' }));
    const retried = await request(app).post('/api/sourcing-ai-tasks/retry-task/retry');
    expect(retried.status).toBe(200);
    expect(retried.body.data).toMatchObject({ status: 'PENDING', attempt: 2, draftId: null, errorSummary: null });
    expect(tasks).toHaveLength(1);
    expect(drafts).toHaveLength(0);
    expect(extractSupplierQuoteEmail).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
    const retryAgain = await request(app).post('/api/sourcing-ai-tasks/retry-task/retry');
    expect(retryAgain.status).toBe(409);
  });

  it('allows cancellation of running tasks and enforces the retry ceiling', async () => {
    tasks.push(taskRecord({ id: 'pending-task', status: 'PENDING' }));
    tasks.push(taskRecord({ id: 'failed-task', status: 'FAILED', idempotencyKey: 'failed-key' }));
    tasks.push(taskRecord({ id: 'running-task', status: 'RUNNING', startedAt: new Date(), idempotencyKey: 'running-key' }));
    tasks.push(taskRecord({ id: 'done-task', status: 'COMPLETED', idempotencyKey: 'done-key' }));
    tasks.push(taskRecord({ id: 'exhausted-task', status: 'FAILED', attempt: 3, maxAttempts: 3, idempotencyKey: 'exhausted-key' }));

    const cancelPending = await request(app).post('/api/sourcing-ai-tasks/pending-task/cancel');
    const cancelFailed = await request(app).post('/api/sourcing-ai-tasks/failed-task/cancel');
    const cancelRunning = await request(app).post('/api/sourcing-ai-tasks/running-task/cancel');
    const cancelCompleted = await request(app).post('/api/sourcing-ai-tasks/done-task/cancel');
    const retryExhausted = await request(app).post('/api/sourcing-ai-tasks/exhausted-task/retry');
    expect(cancelPending.status).toBe(200);
    expect(cancelPending.body.data).toMatchObject({ status: 'CANCELLED', cancelledAt: expect.any(String) });
    expect(cancelFailed.status).toBe(200);
    expect(cancelFailed.body.data.status).toBe('CANCELLED');
    expect(cancelRunning.status).toBe(200);
    expect(cancelRunning.body.data.status).toBe('CANCELLED');
    expect(cancelCompleted.status).toBe(409);
    expect(retryExhausted.status).toBe(409);
  });

});
