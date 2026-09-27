import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const sendInquiryCommand = vi.fn();
const captureWinnerTargetVersion = vi.fn();
const assertWinnerTaskReadAccess = vi.fn();
const selectSupplierQuoteWinnerInTransaction = vi.fn();

describe('sourcing action task routes', () => {
  let app: express.Application;
  let prismaMock: Record<string, any>;
  let tasks: Array<Record<string, any>>;
  let outboundEmails: Array<Record<string, any>>;
  let activeUser: Record<string, string | null>;
  let sourceInquiry: Record<string, any>;
  let targetVisible: boolean;
  let winnerSourceVersion: string;

  const payload = (idempotencyKey = 'send-request-1') => ({
    action: 'SEND_INQUIRY',
    targetId: 'inquiry-1',
    content: { subject: '  Updated RFQ request  ', textBody: '  Please quote PN-1.  ' },
    idempotencyKey,
  });

  function matches(row: Record<string, any>, where: Record<string, any> = {}) {
    for (const [key, expected] of Object.entries(where)) {
      if (key === 'attempt' && expected && typeof expected === 'object') {
        if ('equals' in expected && row.attempt !== expected.equals) return false;
        if ('lt' in expected && !(row.attempt < expected.lt)) return false;
        continue;
      }
      if (key === 'status' && expected && typeof expected === 'object') {
        if ('in' in expected && !expected.in.includes(row.status)) return false;
        continue;
      }
      if (row[key] !== expected) return false;
    }
    return true;
  }

  function materialize(row: Record<string, any>) {
    return {
      ...row,
      outboundEmail: row.outboundEmailId
        ? outboundEmails.find((email) => email.id === row.outboundEmailId) ?? null
        : null,
    };
  }

  function applyUpdate(row: Record<string, any>, data: Record<string, any>) {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment;
      else row[key] = value;
    }
    row.updatedAt = new Date();
  }

  async function initializeApp() {
    vi.resetModules();
    tasks = [];
    outboundEmails = [];
    activeUser = { id: 'sales-1', email: 'sales@example.com', name: 'Sales', role: 'sales', department: 'Sales' };
    targetVisible = true;
    winnerSourceVersion = 'winner-source-v1';
    sourceInquiry = {
      id: 'inquiry-1',
      inquiryNumber: 'INQ-001',
      supplierId: 'supplier-1',
      rfqId: 'rfq-1',
      notes: 'Need current stock and delivery date.',
      isAOG: false,
      status: 'DRAFT',
      supplier: { id: 'supplier-1', name: 'Vendor One', email: 'vendor@example.com' },
      items: [{
        id: 'item-1', lineNo: 1, rfqLineId: 'line-1', partNumber: 'PN-1', quantity: 4,
        requiredDate: new Date('2026-10-01T00:00:00.000Z'), certificateRequired: true,
      }],
      rfq: {
        id: 'rfq-1', rfqNumber: 'RFQ-001', createdBy: 'sales-1', status: 'QUOTING',
        creator: { department: 'Sales' }, lines: [{ id: 'line-1', status: 'OPEN' }],
      },
    };

    const actionTaskModel = {
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        if (tasks.some((row) => row.actorId === data.actorId && row.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const now = new Date('2026-09-27T00:00:00.000Z');
        const row = {
          id: `action-${tasks.length + 1}`,
          targetSupplierQuoteId: null,
          confirmedById: null,
          confirmedAt: null,
          retriedById: null,
          retryHistoryJson: '[]',
          cancelledById: null,
          outboundEmailId: null,
          resultJson: null,
          errorSummary: null,
          completedAt: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        tasks.push(row);
        return materialize(row);
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        if (where.id) return tasks.find((row) => row.id === where.id) ? materialize(tasks.find((row) => row.id === where.id)!) : null;
        const compound = where.actorId_idempotencyKey;
        const row = compound ? tasks.find((candidate) => candidate.actorId === compound.actorId && candidate.idempotencyKey === compound.idempotencyKey) : null;
        return row ? materialize(row) : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const row = tasks.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('missing task');
        return materialize(row);
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const row = tasks.find((candidate) => matches(candidate, where));
        return row ? materialize(row) : null;
      }),
      findMany: vi.fn(async ({ where, take }: { where?: Record<string, any>; take?: number }) => {
        const rows = tasks.filter((row) => matches(row, where ?? {}))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
        return (take === undefined ? rows : rows.slice(0, take)).map(materialize);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const row = tasks.find((candidate) => matches(candidate, where));
        if (!row) return { count: 0 };
        applyUpdate(row, data);
        return { count: 1 };
      }),
    };
    prismaMock = {
      sourcingActionTask: actionTaskModel,
      inquiry: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) =>
          targetVisible && where.id === sourceInquiry.id ? sourceInquiry : null),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
    };
    sendInquiryCommand.mockReset().mockImplementation(async (tx: unknown, actor: Record<string, unknown>, inquiryId: string, content: Record<string, string>) => {
      if (inquiryId !== sourceInquiry.id) throw new Error('wrong Inquiry');
      const outboundEmail = {
        id: `outbound-${outboundEmails.length + 1}`, status: 'PENDING', errorMessage: null,
        sentAt: null, createdAt: new Date(), updatedAt: new Date(),
      };
      outboundEmails.push(outboundEmail);
      sourceInquiry.status = 'QUEUED';
      return {
        inquiry: { ...sourceInquiry, status: 'DRAFT' },
        queuedInquiry: { ...sourceInquiry },
        outboundEmail,
        outboxEvent: { id: `outbox-${outboundEmails.length}` },
        tx,
        actor,
        content,
      };
    });
    captureWinnerTargetVersion.mockReset().mockImplementation(async () => ({
      targetVersion: winnerSourceVersion,
      quote: { id: 'quote-1', updatedAt: new Date('2026-09-27T00:00:00.000Z') },
    }));
    assertWinnerTaskReadAccess.mockReset().mockImplementation(async () => {
      if (!targetVisible) {
        const { AppError } = await import('../middleware/errorHandler.js');
        throw new AppError('报价不可见', 404, 'RESOURCE_NOT_FOUND');
      }
      return { id: 'quote-1' };
    });
    selectSupplierQuoteWinnerInTransaction.mockReset().mockResolvedValue({
      id: 'quote-1', rfqLineId: 'line-1', isWinner: true, status: 'accepted',
    });

    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/inquirySendCommand.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/inquirySendCommand.js')>();
      return { ...actual, sendInquiryCommand };
    });
    vi.doMock('../lib/sourcingWinnerTaskService.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/sourcingWinnerTaskService.js')>();
      return { ...actual, captureWinnerTargetVersion, assertWinnerTaskReadAccess };
    });
    vi.doMock('../lib/supplierQuoteSelectWinnerCommand.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/supplierQuoteSelectWinnerCommand.js')>();
      return { ...actual, selectSupplierQuoteWinnerInTransaction };
    });
    const router = (await import('./sourcingActionTasks.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: typeof activeUser }).user = activeUser;
      next();
    });
    app.use('/api/sourcing-action-tasks', router);
    app.use(errorHandler);
  }

  beforeEach(async () => initializeApp());
  afterEach(() => vi.resetModules());

  it('stages an immutable human-review task and replays its stable idempotency key', async () => {
    const input = payload();
    const created = await request(app).post('/api/sourcing-action-tasks').send(input);
    const replay = await request(app).post('/api/sourcing-action-tasks').send(input);

    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      actorId: 'sales-1', action: 'SEND_INQUIRY', targetType: 'INQUIRY', targetId: 'inquiry-1',
      status: 'WAITING_HUMAN', version: 1, attempt: 1,
      contentSnapshot: { subject: 'Updated RFQ request', textBody: 'Please quote PN-1.' },
    });
    expect(created.body.data.targetVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(created.body.data.requestId).toEqual(expect.any(String));
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(created.body.data.id);
    expect(replay.body.data.requestId).toBe(created.body.data.requestId);
    expect(tasks).toHaveLength(1);
    expect(sendInquiryCommand).not.toHaveBeenCalled();
  });

  it('confirms only the captured version, queues once, and replays the persisted result', async () => {
    const created = await request(app).post('/api/sourcing-action-tasks').send(payload()).expect(201);
    const first = await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`).send({ expectedVersion: 1 }).expect(200);
    const replay = await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`).send({ expectedVersion: 1 }).expect(200);

    expect(first.body.data).toMatchObject({
      status: 'COMPLETED', confirmedById: 'sales-1', outboundEmailId: 'outbound-1',
      result: { inquiryStatus: 'QUEUED', outboundEmailStatus: 'PENDING', outboxEventId: 'outbox-1' },
      outboundEmail: { id: 'outbound-1', status: 'PENDING' },
    });
    expect(replay.body.data.outboundEmailId).toBe('outbound-1');
    expect(sendInquiryCommand).toHaveBeenCalledTimes(1);
    expect(sendInquiryCommand.mock.calls[0][0]).toBe(prismaMock);
    expect(sendInquiryCommand.mock.calls[0][1]).toMatchObject({ id: 'sales-1' });
    expect(sendInquiryCommand.mock.calls[0][3]).toEqual({ subject: 'Updated RFQ request', textBody: 'Please quote PN-1.' });
    expect(prismaMock.$transaction.mock.calls.some((call: unknown[]) =>
      JSON.stringify(call[1]) === JSON.stringify({ isolationLevel: 'Serializable' }))).toBe(true);
  });

  it('fails a stale source snapshot and requires a new task instead of refreshing it', async () => {
    const created = await request(app).post('/api/sourcing-action-tasks').send(payload()).expect(201);
    sourceInquiry.items[0].quantity = 5;

    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`).send({ expectedVersion: 1 }).expect(409);
    expect(tasks[0]).toMatchObject({ status: 'FAILED', errorSummary: 'SOURCE_VERSION_CHANGED', targetVersion: created.body.data.targetVersion });
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/retry`).expect(409);
    expect(tasks[0].status).toBe('FAILED');
    expect(sendInquiryCommand).not.toHaveBeenCalled();
  });

  it('records retry and cancellation actors and invalidates pre-transition confirmation versions', async () => {
    const created = await request(app).post('/api/sourcing-action-tasks').send(payload()).expect(201);
    tasks[0].status = 'FAILED';
    tasks[0].errorSummary = 'SEND_CONFIGURATION_INVALID';
    activeUser = { id: 'admin-1', email: 'admin@example.com', name: 'Admin', role: 'administrator', department: null };

    const retried = await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/retry`).expect(200);
    expect(retried.body.data).toMatchObject({
      status: 'WAITING_HUMAN', attempt: 2, version: 2, retriedById: 'admin-1',
      retryHistory: [{ actorId: 'admin-1', attempt: 2 }],
    });
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`).send({ expectedVersion: 1 }).expect(409);
    expect(sendInquiryCommand).not.toHaveBeenCalled();
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/cancel`).expect(200)
      .then((response) => expect(response.body.data).toMatchObject({ status: 'CANCELLED', version: 3, cancelledById: 'admin-1' }));
  });

  it('allows a safe retry only after a rolled back command failure with the same source', async () => {
    const { AppError } = await import('../middleware/errorHandler.js');
    const created = await request(app).post('/api/sourcing-action-tasks').send(payload()).expect(201);
    sendInquiryCommand.mockRejectedValueOnce(new AppError('mail account is unavailable', 409, 'RESOURCE_CONFLICT'));
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`).send({ expectedVersion: 1 }).expect(409);
    expect(tasks[0]).toMatchObject({ status: 'FAILED', errorSummary: 'SEND_CONFIGURATION_INVALID', outboundEmailId: null, resultJson: null });

    activeUser = { id: 'admin-1', email: 'admin@example.com', name: 'Admin', role: 'administrator', department: null };
    const retried = await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/retry`).expect(200);
    expect(retried.body.data).toMatchObject({ status: 'WAITING_HUMAN', version: 2, attempt: 2, retriedById: 'admin-1' });
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`).send({ expectedVersion: 1 }).expect(409);
    const confirmed = await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`).send({ expectedVersion: 2 }).expect(200);
    expect(confirmed.body.data).toMatchObject({ status: 'COMPLETED', confirmedById: 'admin-1', version: 2 });
    expect(sendInquiryCommand).toHaveBeenCalledTimes(2);
  });

  it('rejects staging when the RFQ or selected demand line is closed', async () => {
    sourceInquiry.rfq.status = 'COMPLETED';
    await request(app).post('/api/sourcing-action-tasks').send(payload('rfq-closed')).expect(409);
    sourceInquiry.rfq.status = 'QUOTING';
    sourceInquiry.rfq.lines[0].status = 'CLOSED';
    await request(app).post('/api/sourcing-action-tasks').send(payload('line-closed')).expect(409);
    expect(tasks).toHaveLength(0);
  });

  it('hides snapshots after target access is revoked and redacts raw SMTP errors', async () => {
    const created = await request(app).post('/api/sourcing-action-tasks').send(payload()).expect(201);
    targetVisible = false;
    await request(app).get(`/api/sourcing-action-tasks/${created.body.data.id}`).expect(404);
    const hiddenList = await request(app).get('/api/sourcing-action-tasks').expect(200);
    expect(hiddenList.body.data).toEqual([]);

    targetVisible = true;
    tasks[0].status = 'COMPLETED';
    tasks[0].outboundEmailId = 'outbound-manual';
    tasks[0].resultJson = JSON.stringify({ inquiryId: 'inquiry-1', inquiryStatus: 'QUEUED', outboundEmailId: 'outbound-manual', outboundEmailStatus: 'PENDING', outboxEventId: 'outbox-manual' });
    outboundEmails.push({ id: 'outbound-manual', status: 'FAILED', errorMessage: 'smtp://account:super-secret@example.com', sentAt: null, createdAt: new Date(), updatedAt: new Date() });
    const visible = await request(app).get(`/api/sourcing-action-tasks/${created.body.data.id}`).expect(200);
    expect(JSON.stringify(visible.body)).not.toContain('super-secret');
    expect(visible.body.data.outboundEmail.deliveryIssue).toContain('邮件投递失败');
  });

  it('requires current user capability for human confirmation', async () => {
    const created = await request(app).post('/api/sourcing-action-tasks').send(payload()).expect(201);
    activeUser = { id: 'sales-1', email: 'sales@example.com', name: 'Sales', role: 'viewer', department: 'Sales' };
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`).send({ expectedVersion: 1 }).expect(403);
    expect(sendInquiryCommand).not.toHaveBeenCalled();
  });

  it('stages and confirms one winner through the shared transaction command', async () => {
    const created = await request(app).post('/api/sourcing-action-tasks').send({
      action: 'SELECT_WINNER', targetId: 'quote-1', idempotencyKey: 'winner-1',
    }).expect(201);
    expect(created.body.data).toMatchObject({
      action: 'SELECT_WINNER', targetType: 'SUPPLIER_QUOTE', targetVersion: 'winner-source-v1',
      status: 'WAITING_HUMAN', contentSnapshot: null,
    });
    const first = await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`)
      .send({ expectedVersion: 1 }).expect(200);
    const replay = await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`)
      .send({ expectedVersion: 1 }).expect(200);
    expect(first.body.data).toMatchObject({
      status: 'COMPLETED', confirmedById: 'sales-1', outboundEmailId: null,
      result: { supplierQuoteId: 'quote-1', rfqLineId: 'line-1', isWinner: true, status: 'accepted' },
    });
    expect(replay.body.data.id).toBe(created.body.data.id);
    expect(selectSupplierQuoteWinnerInTransaction).toHaveBeenCalledTimes(1);
    expect(selectSupplierQuoteWinnerInTransaction.mock.calls[0]).toMatchObject([
      prismaMock, 'quote-1', { id: 'sales-1' }, new Date('2026-09-27T00:00:00.000Z'),
    ]);
    expect(sendInquiryCommand).not.toHaveBeenCalled();
  });

  it('fails stale winner source and never invokes the winner command', async () => {
    const created = await request(app).post('/api/sourcing-action-tasks').send({
      action: 'SELECT_WINNER', targetId: 'quote-1', idempotencyKey: 'winner-stale',
    }).expect(201);
    winnerSourceVersion = 'winner-source-v2';
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`)
      .send({ expectedVersion: 1 }).expect(409);
    expect(tasks[0]).toMatchObject({ status: 'FAILED', errorSummary: 'SOURCE_VERSION_CHANGED' });
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/retry`).expect(409);
    expect(selectSupplierQuoteWinnerInTransaction).not.toHaveBeenCalled();
  });

  it('rejects a winner task staged against an outdated displayed quote version', async () => {
    await request(app).post('/api/sourcing-action-tasks').send({
      action: 'SELECT_WINNER', targetId: 'quote-1',
      expectedUpdatedAt: '2026-09-26T00:00:00.000Z', idempotencyKey: 'winner-old-display',
    }).expect(409);
    expect(tasks).toHaveLength(0);
    expect(selectSupplierQuoteWinnerInTransaction).not.toHaveBeenCalled();
  });

  it('hides winner tasks when target scope is revoked and records cancellation', async () => {
    const created = await request(app).post('/api/sourcing-action-tasks').send({
      action: 'SELECT_WINNER', targetId: 'quote-1', idempotencyKey: 'winner-cancel',
    }).expect(201);
    targetVisible = false;
    await request(app).get(`/api/sourcing-action-tasks/${created.body.data.id}`).expect(404);
    const hidden = await request(app).get('/api/sourcing-action-tasks').expect(200);
    expect(hidden.body.data).toEqual([]);
    targetVisible = true;
    const cancelled = await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/cancel`).expect(200);
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancelledById: 'sales-1', version: 2 });
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`)
      .send({ expectedVersion: 1 }).expect(409);
  });

  it('rechecks winner permission at confirmation and supports a bounded retry after command rejection', async () => {
    const { AppError } = await import('../middleware/errorHandler.js');
    const created = await request(app).post('/api/sourcing-action-tasks').send({
      action: 'SELECT_WINNER', targetId: 'quote-1', idempotencyKey: 'winner-retry',
    }).expect(201);
    activeUser = { id: 'sales-1', email: 'sales@example.com', name: 'Sales', role: 'viewer', department: 'Sales' };
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`)
      .send({ expectedVersion: 1 }).expect(403);
    expect(selectSupplierQuoteWinnerInTransaction).not.toHaveBeenCalled();

    activeUser = { id: 'sales-1', email: 'sales@example.com', name: 'Sales', role: 'sales', department: 'Sales' };
    selectSupplierQuoteWinnerInTransaction.mockRejectedValueOnce(new AppError('quote no longer selectable', 409, 'STATE_CONFLICT'));
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`)
      .send({ expectedVersion: 1 }).expect(409);
    expect(tasks[0]).toMatchObject({ status: 'FAILED', errorSummary: 'WINNER_PRECONDITION_FAILED' });
    const retried = await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/retry`).expect(200);
    expect(retried.body.data).toMatchObject({ status: 'WAITING_HUMAN', attempt: 2, version: 2 });
    await request(app).post(`/api/sourcing-action-tasks/${created.body.data.id}/confirm`)
      .send({ expectedVersion: 2 }).expect(200);
    expect(selectSupplierQuoteWinnerInTransaction).toHaveBeenCalledTimes(2);
  });
});
