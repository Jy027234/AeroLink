import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../middleware/errorHandler.js';

const { state, prismaMock, extractSupplierQuoteEmail } = vi.hoisted(() => {
  const state = {
    tasks: [] as Array<Record<string, any>>,
    drafts: [] as Array<Record<string, any>>,
    actor: {} as Record<string, any>,
    email: {} as Record<string, any>,
    inquiry: {} as Record<string, any>,
    link: {} as Record<string, any>,
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
    user: { findUnique: vi.fn(async ({ where }: { where: Record<string, any> }) => where.id === state.actor.id ? state.actor : null) },
    email: { findUnique: vi.fn(async ({ where }: { where: Record<string, any> }) => where.id === state.email.id ? state.email : null) },
    inquiry: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, any> }) => where.id === state.inquiry.id ? state.inquiry : null),
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => where.id === state.inquiry.id ? state.inquiry : null),
    },
    inquiryEmailLink: { findUnique: vi.fn(async () => state.link) },
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

let validSourceFingerprint = '';

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
      sourceFingerprint: validSourceFingerprint,
      startedAt: null, completedAt: null, cancelledAt: null, updatedAt: now,
      ...overrides,
    };
  }

  beforeEach(async () => {
    state.tasks.length = 0;
    state.drafts.length = 0;
    state.actor = { id: 'sales-1', role: 'sales', department: 'Sales', isActive: true };
    state.email = {
      id: 'email-1', subject: 'Vendor quote', body: 'private vendor email', type: 'INQUIRY',
      processingStatus: 'PENDING', discardedAt: null, receivedAt: new Date('2026-09-20T00:00:00.000Z'), rfq: null,
    };
    state.inquiry = {
      id: 'inquiry-1', inquiryNumber: 'INQ-001', supplierId: 'supplier-1', rfqId: 'rfq-1',
      status: 'SENT', sentAt: new Date('2026-09-19T00:00:00.000Z'),
      items: [{ id: 'item-1', lineNo: 1, rfqLineId: 'line-1', partNumber: 'PN-1', quantity: 3 }],
      rfq: {
        id: 'rfq-1', createdBy: 'sales-1', status: 'QUOTING', version: 1,
        creator: { department: 'Sales' },
      },
    };
    state.link = {
      id: 'link-1', emailId: 'email-1', inquiryId: 'inquiry-1', method: 'MANUAL', manualReason: null,
      confirmationStatus: 'CONFIRMED', confirmedAt: new Date('2026-09-20T01:00:00.000Z'),
      confirmedById: 'sales-1', createdAt: new Date('2026-09-20T01:00:00.000Z'),
    };
    extractSupplierQuoteEmail.mockReset().mockResolvedValue(extraction);
    vi.clearAllMocks();
    const { captureSourcingAiTaskSourceFingerprint } = await import('./sourcingAiTaskService.js');
    validSourceFingerprint = await captureSourcingAiTaskSourceFingerprint('sales-1', 'email-1', 'inquiry-1');
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
    const metadata = JSON.parse(state.drafts[0].aiMetadataJson);
    expect(metadata.originalAiCandidates).toMatchObject({
      schemaVersion: 1,
      candidateCount: 1,
      truncated: false,
      items: [{
        itemKey: expect.any(String), inquiryItemId: 'item-1', partNumber: 'PN-1',
        quantity: 2, unitPrice: 100, currency: 'USD', leadTimeDays: 5,
        taxIncluded: true, freightIncluded: false, incoterm: 'FCA',
      }],
    });
    expect(JSON.stringify(metadata.originalAiCandidates)).not.toContain('USD 100, five days');
  });

  it('does not create another AI draft over a partially confirmed draft', async () => {
    state.tasks.push(taskRecord());
    state.drafts.push({ id: 'draft-existing', status: 'PARTIALLY_CONFIRMED', version: 3 });

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    await processPendingSourcingAiTasks(10);

    expect(state.tasks[0]).toMatchObject({ status: 'FAILED', draftId: null });
    expect(state.drafts).toHaveLength(1);
    expect(state.drafts[0].id).toBe('draft-existing');
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

  it.each([
    ['AI_PROVIDER_TIMEOUT', '模型服务请求超时，请稍后重新执行抽取'],
    ['AI_PROVIDER_CONNECTION_ERROR', '模型服务连接失败，请检查网络后重新执行抽取'],
    ['AI_QUOTE_OUTPUT_INVALID', '模型返回的报价格式无效；可重试或核对原文后手工建稿'],
    ['AI_QUOTE_EVIDENCE_INVALID', '报价依据无法在本次回信中核实，可能来自引用历史；请核对原文或手工建稿'],
  ] as const)('stores an actionable safe summary for %s', async (code, errorSummary) => {
    state.tasks.push(taskRecord());
    extractSupplierQuoteEmail.mockRejectedValueOnce(new AppError(
      'private provider URL, prompt and credentials', 502, code,
    ));

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    await processPendingSourcingAiTasks(10);

    expect(state.tasks[0]).toMatchObject({ status: 'FAILED', errorSummary });
    expect(JSON.stringify(state.tasks[0])).not.toContain('private provider');
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

  it('rechecks the current actor capabilities before invoking the model', async () => {
    state.tasks.push(taskRecord());
    state.actor.role = 'viewer';

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    await processPendingSourcingAiTasks(10);

    expect(extractSupplierQuoteEmail).not.toHaveBeenCalled();
    expect(state.tasks[0]).toMatchObject({ status: 'FAILED', errorSummary: '任务发起人当前无权执行报价邮件提取' });
    expect(state.drafts).toHaveLength(0);
  });

  it('fails an enqueued task before the model when its source changed before the first worker read', async () => {
    state.tasks.push(taskRecord());
    state.email.body = 'human-edited after enqueue';

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    await processPendingSourcingAiTasks(10);

    expect(extractSupplierQuoteEmail).not.toHaveBeenCalled();
    expect(state.tasks[0]).toMatchObject({
      status: 'FAILED', errorSummary: '来源在任务入队后已变化，请重新创建任务',
    });
    expect(state.drafts).toHaveLength(0);
  });

  it('safely fails legacy tasks without an enqueue fingerprint before invoking the model', async () => {
    state.tasks.push(taskRecord({ sourceFingerprint: null }));

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    await processPendingSourcingAiTasks(10);

    expect(extractSupplierQuoteEmail).not.toHaveBeenCalled();
    expect(state.tasks[0]).toMatchObject({
      status: 'FAILED', errorSummary: '任务未记录来源版本，请重新创建任务',
    });
    expect(state.drafts).toHaveLength(0);
  });

  it('does not save a draft when permissions or a source version changes while the model is running', async () => {
    state.tasks.push(taskRecord());
    extractSupplierQuoteEmail.mockImplementationOnce(async () => {
      state.actor.role = 'viewer';
      state.inquiry.rfq.version += 1;
      return extraction;
    });

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    await processPendingSourcingAiTasks(10);

    expect(extractSupplierQuoteEmail).toHaveBeenCalledTimes(1);
    expect(state.tasks[0]).toMatchObject({ status: 'FAILED', errorSummary: '任务发起人当前无权执行报价邮件提取' });
    expect(state.drafts).toHaveLength(0);
  });

  it('does not save a draft when the email or confirmed association changes while the model is running', async () => {
    state.tasks.push(taskRecord());
    extractSupplierQuoteEmail.mockImplementationOnce(async () => {
      state.email.body = 'human-edited body';
      state.link.confirmedAt = new Date('2026-09-21T00:00:00.000Z');
      return extraction;
    });

    const { processPendingSourcingAiTasks } = await import('./sourcingAiTaskService.js');
    await processPendingSourcingAiTasks(10);

    expect(state.tasks[0]).toMatchObject({
      status: 'FAILED', errorSummary: '源邮件、询价单或关联版本已变化，未保存提取草稿',
    });
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
