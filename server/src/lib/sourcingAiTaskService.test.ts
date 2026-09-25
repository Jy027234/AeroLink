import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, prismaMock, extractSupplierQuoteEmail } = vi.hoisted(() => {
  const state = {
    tasks: [] as Array<Record<string, any>>,
    drafts: [] as Array<Record<string, any>>,
  };
  const matches = (task: Record<string, any>, where: Record<string, any> = {}) => {
    if (where.id && task.id !== where.id) return false;
    if (where.actorId && task.actorId !== where.actorId) return false;
    if (where.status && task.status !== where.status) return false;
    if (where.startedAt instanceof Date && task.startedAt?.getTime() !== where.startedAt.getTime()) return false;
    if (where.startedAt === null && task.startedAt !== null) return false;
    if (where.startedAt?.lte && !(task.startedAt instanceof Date && task.startedAt <= where.startedAt.lte)) return false;
    if (where.attempt !== undefined && task.attempt !== where.attempt) return false;
    if (where.maxAttempts !== undefined && task.maxAttempts !== where.maxAttempts) return false;
    return true;
  };
  const updateTask = (task: Record<string, any>, data: Record<string, any>) => {
    for (const [key, value] of Object.entries(data)) {
      task[key] = value && typeof value === 'object' && 'increment' in value
        ? task[key] + value.increment
        : value;
    }
    task.updatedAt = new Date();
  };
  const prismaMock: Record<string, any> = {
    sourcingAiTask: {
      findMany: vi.fn(async ({ where, take }: { where?: Record<string, any>; take?: number }) => {
        const found = state.tasks.filter((task) => matches(task, where));
        return take ? found.slice(0, take) : found;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => state.tasks.find((task) => matches(task, where)) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const task = state.tasks.find((item) => item.id === where.id);
        if (!task) throw new Error('missing task');
        return task;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const task = state.tasks.find((item) => matches(item, where));
        if (!task) return { count: 0 };
        updateTask(task, data);
        return { count: 1 };
      }),
    },
    email: { findUnique: vi.fn(async () => ({ id: 'email-1', subject: 'Vendor quote', body: 'private vendor email' })) },
    inquiry: {
      findUnique: vi.fn(async () => ({
        id: 'inquiry-1', inquiryNumber: 'INQ-001', supplierId: 'supplier-1',
        items: [{ id: 'item-1', partNumber: 'PN-1', quantity: 3 }],
      })),
    },
    inquiryEmailLink: { findUnique: vi.fn(async () => ({ confirmationStatus: 'CONFIRMED' })) },
    supplierQuoteDraft: {
      findFirst: vi.fn(async () => state.drafts[0] ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const draft = { id: `draft-${state.drafts.length + 1}`, ...data };
        state.drafts.push(draft);
        return { id: draft.id };
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
  };
  return { state, prismaMock, extractSupplierQuoteEmail: vi.fn() };
});

vi.mock('./prisma.js', () => ({ default: prismaMock }));
vi.mock('./aiService.js', () => ({ extractSupplierQuoteEmail }));

describe('sourcing AI task worker service', () => {
  const extraction = {
    items: [{
      partNumber: 'PN-1', quantity: 2, unitPrice: 100, currency: 'USD', leadTimeDays: 5,
      validUntil: null, condition: null, certificate: null, taxIncluded: true,
      freightIncluded: false, incoterm: 'fca', evidenceText: 'USD 100, five days',
    }],
    ai: { agentId: 'agent-quote', promptVersion: 3, model: 'model-x' },
  };

  function taskRecord(overrides: Record<string, unknown> = {}) {
    const now = new Date('2026-09-22T00:00:00.000Z');
    return {
      id: 'task-1', actorId: 'sales-1', type: 'supplier_quote_extraction', emailId: 'email-1',
      inquiryId: 'inquiry-1', status: 'PENDING', attempt: 1, maxAttempts: 3,
      idempotencyKey: 'key-1', draftId: null, errorSummary: null, createdAt: now,
      startedAt: null, completedAt: null, cancelledAt: null, updatedAt: now,
      ...overrides,
    };
  }

  beforeEach(() => {
    state.tasks.length = 0;
    state.drafts.length = 0;
    extractSupplierQuoteEmail.mockReset().mockResolvedValue(extraction);
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('claims a pending task and creates a draft only in the worker', async () => {
    state.tasks.push(taskRecord());

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    const result = await processPendingSourcingAiTasks(10);

    expect(result).toEqual({ recovered: 0, processed: 1 });
    expect(extractSupplierQuoteEmail).toHaveBeenCalledTimes(1);
    expect(state.tasks[0]).toMatchObject({ status: 'COMPLETED', attempt: 1, draftId: 'draft-1' });
    expect(state.drafts).toHaveLength(1);
    expect(JSON.parse(state.drafts[0].payloadJson).items[0]).toMatchObject({
      taxIncluded: true, freightIncluded: false, incoterm: 'FCA',
    });
  });

  it('stores only a safe error summary when model execution fails', async () => {
    state.tasks.push(taskRecord());
    extractSupplierQuoteEmail.mockRejectedValueOnce(new Error('secret API key and vendor email body'));

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    await processPendingSourcingAiTasks(10);

    expect(state.tasks[0]).toMatchObject({ status: 'FAILED', errorSummary: 'AI 抽取失败，请稍后重试' });
    expect(JSON.stringify(state.tasks[0])).not.toContain('secret API key');
    expect(state.drafts).toHaveLength(0);
  });

  it('requeues an expired claim with another attempt and fails an exhausted claim', async () => {
    const staleDate = new Date(Date.now() - 60_000);
    state.tasks.push(taskRecord({ id: 'recoverable', status: 'RUNNING', startedAt: staleDate }));
    state.tasks.push(taskRecord({
      id: 'exhausted', status: 'RUNNING', attempt: 3, startedAt: staleDate, idempotencyKey: 'key-2',
    }));

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    const result = await processPendingSourcingAiTasks(10, 1_000);

    expect(result).toEqual({ recovered: 2, processed: 1 });
    expect(state.tasks[0]).toMatchObject({ status: 'COMPLETED', attempt: 2 });
    expect(state.tasks[1]).toMatchObject({
      status: 'FAILED', attempt: 3, errorSummary: 'AI 任务执行超时，已达到最大尝试次数',
    });
    expect(extractSupplierQuoteEmail).toHaveBeenCalledTimes(1);
  });

  it('does not let a cancelled in-flight claim commit a draft', async () => {
    state.tasks.push(taskRecord());
    let resolveExtraction!: (value: typeof extraction) => void;
    extractSupplierQuoteEmail.mockReturnValueOnce(new Promise((resolve) => { resolveExtraction = resolve; }));

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    const processing = processPendingSourcingAiTasks(10);
    await vi.waitFor(() => expect(extractSupplierQuoteEmail).toHaveBeenCalledTimes(1));
    state.tasks[0].status = 'CANCELLED';
    state.tasks[0].cancelledAt = new Date();
    resolveExtraction(extraction);
    await processing;

    expect(state.tasks[0].status).toBe('CANCELLED');
    expect(state.drafts).toHaveLength(0);
  });

  it('rejects a stale model response after the task has a newer claim token', async () => {
    state.tasks.push(taskRecord());
    let resolveExtraction!: (value: typeof extraction) => void;
    extractSupplierQuoteEmail.mockReturnValueOnce(new Promise((resolve) => { resolveExtraction = resolve; }));

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    const processing = processPendingSourcingAiTasks(10);
    await vi.waitFor(() => expect(extractSupplierQuoteEmail).toHaveBeenCalledTimes(1));
    state.tasks[0].status = 'PENDING';
    state.tasks[0].startedAt = null;
    const newerClaim = new Date(Date.now() + 1_000);
    state.tasks[0].status = 'RUNNING';
    state.tasks[0].startedAt = newerClaim;
    resolveExtraction(extraction);
    await processing;

    expect(state.tasks[0]).toMatchObject({ status: 'RUNNING', startedAt: newerClaim });
    expect(state.drafts).toHaveLength(0);
  });

  it('does not claim an over-budget pending task', async () => {
    state.tasks.push(taskRecord({ attempt: 4, maxAttempts: 3 }));

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    await processPendingSourcingAiTasks(10);

    expect(state.tasks[0]).toMatchObject({ status: 'FAILED', errorSummary: 'AI 任务已达到最大尝试次数' });
    expect(extractSupplierQuoteEmail).not.toHaveBeenCalled();
  });
});
