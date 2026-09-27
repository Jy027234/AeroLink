import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('inquiry email dispatch', () => {
  const dueDate = new Date('2026-10-15T00:00:00.000Z');
  let actor = { id: 'sales-1', role: 'sales', department: 'Sales' };
  let inquiry: any;
  let tx: any;
  let prismaMock: any;
  let buildIdempotencyContextMock: ReturnType<typeof vi.fn>;
  let applyIdempotencyHeadersMock: ReturnType<typeof vi.fn>;
  let runIdempotentOperationMock: ReturnType<typeof vi.fn>;
  let enqueueOutboundEmailMock: ReturnType<typeof vi.fn>;
  let cache: Map<string, any>;

  beforeEach(() => {
    vi.resetModules();
    cache = new Map();
    actor = { id: 'sales-1', role: 'sales', department: 'Sales' };
    inquiry = {
      id: 'i1', inquiryNumber: 'INQ-2026-ABC123', supplierId: 's1', rfqId: 'r1', notes: 'internal only',
      isAOG: true, status: 'DRAFT', createdAt: dueDate, sentAt: null,
      supplier: { id: 's1', name: 'Supplier One', email: 'quotes@supplier.example' },
      rfq: { id: 'r1', rfqNumber: 'RFQ-2026-42', status: 'SOURCING', createdBy: actor.id, creator: { department: actor.department } },
      items: [{ id: 'ii1', lineNo: 1, rfqLineId: 'rl1', partNumber: 'PN-100', quantity: 4, requiredDate: dueDate, certificateRequired: true }],
    };
    tx = {
      inquiry: {
        findFirst: vi.fn(async () => inquiry),
        update: vi.fn(async ({ data }) => {
          inquiry = { ...inquiry, ...data };
          return { id: inquiry.id, status: inquiry.status, sentAt: inquiry.sentAt };
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      emailAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'acct-1' }) },
      rfqLine: { findMany: vi.fn().mockResolvedValue([{ id: 'rl1', rfqId: 'r1', status: 'OPEN' }]) },
      outboundEmail: { create: vi.fn().mockResolvedValue({ id: 'mail-1', status: 'PENDING', errorMessage: null, sentAt: null }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-send-1' }) },
      outboxEvent: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'outbox-1', status: 'PENDING', attemptCount: 0,
          payload: JSON.stringify({ outboundEmailId: 'mail-1', includeQuotationPdf: false }), workerId: null, lockedAt: null,
        }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      outboundEmailUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    tx.outboundEmail.updateMany = tx.outboundEmailUpdateMany;
    prismaMock = {
      inquiry: {
        findFirst: vi.fn().mockResolvedValue({ id: 'i1' }),
        findMany: vi.fn(),
      },
      outboxEvent: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (operation: (transaction: any) => Promise<unknown>) => operation(tx)),
    };
    enqueueOutboundEmailMock = vi.fn().mockResolvedValue({
      id: 'outbox-1', status: 'PENDING', attemptCount: 0, payload: JSON.stringify({ outboundEmailId: 'mail-1' }), workerId: null, lockedAt: null,
    });
    buildIdempotencyContextMock = vi.fn((req: express.Request, actorId: string, scope: string) => ({
      actorId,
      scope,
      key: req.get('Idempotency-Key'),
      requestHash: 'request-hash',
    }));
    applyIdempotencyHeadersMock = vi.fn((res: express.Response, execution: { key?: string; replayed: boolean }) => {
      if (execution.key) res.setHeader('Idempotency-Key', execution.key);
      if (execution.replayed) res.setHeader('Idempotency-Replayed', 'true');
    });
    runIdempotentOperationMock = vi.fn(async (context: any, operation: (transaction: any) => Promise<any>) => {
      if (context.key && cache.has(context.key)) return { ...cache.get(context.key), replayed: true };
      const result = await operation(tx);
      const execution = { ...result, replayed: false, key: context.key };
      if (context.key) cache.set(context.key, execution);
      return execution;
    });
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/idempotencyService.js', () => ({
      buildIdempotencyContext: buildIdempotencyContextMock,
      applyIdempotencyHeaders: applyIdempotencyHeadersMock,
      runIdempotentOperation: runIdempotentOperationMock,
    }));
    vi.doMock('../lib/outboxService.js', () => ({ enqueueOutboundEmail: enqueueOutboundEmailMock }));
  });

  async function app() {
    const router = (await import('./inquiries.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { Object.assign(req, { user: actor }); next(); });
    instance.use(router);
    instance.use(errorHandler);
    return instance;
  }

  it('queues a reviewable plain-text AOG email and leaves SENT to the worker', async () => {
    const response = await request(await app()).post('/i1/send').send({});

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      id: 'i1', status: 'queued', deliveryStatus: 'queued',
      latestOutboundEmail: { id: 'mail-1', status: 'pending', error: null, sentAt: null },
    });
    expect(JSON.stringify(response.body)).not.toContain('quotes@supplier.example');
    expect(tx.inquiry.update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'QUEUED' } });
    expect(tx.outboundEmail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purpose: 'INQUIRY_SEND', inquiryId: 'i1', accountId: 'acct-1',
        toEmail: 'quotes@supplier.example', status: 'PENDING',
        subject: expect.stringContaining('INQ-2026-ABC123'),
        textBody: expect.stringContaining('PN-100'),
      }),
      select: { id: true, status: true, errorMessage: true, sentAt: true },
    });
    const emailData = tx.outboundEmail.create.mock.calls[0][0].data;
    expect(emailData.subject).toContain('AOG');
    expect(emailData.textBody).toContain('数量 4');
    expect(emailData.textBody).toContain('RFQ-2026-42');
    expect(enqueueOutboundEmailMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      eventType: 'inquiry.email.send', aggregateType: 'INQUIRY', aggregateId: 'i1',
      outboundEmailId: 'mail-1', createdById: actor.id,
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: actor.id, action: 'APPROVE', resourceType: 'OUTBOUND_EMAIL', resourceId: 'mail-1',
    }) });
  });

  it('accepts an explicit subject and body after strict validation', async () => {
    const response = await request(await app()).post('/i1/send').send({ subject: 'Quote request', textBody: 'Please quote PN-100.' });
    expect(response.status).toBe(202);
    expect(tx.outboundEmail.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subject: 'Quote request', textBody: 'Please quote PN-100.' }),
    }));

    const invalid = await request(await app()).post('/i1/send').send({ subject: 'x'.repeat(256) });
    expect(invalid.status).toBe(400);
  });

  it('reports a missing enabled default email account without changing inquiry state', async () => {
    tx.emailAccount.findFirst.mockResolvedValue(null);
    const response = await request(await app()).post('/i1/send').send({});
    expect(response.status).toBe(409);
    expect(response.body.message).toContain('默认邮箱账户');
    expect(tx.outboundEmail.create).not.toHaveBeenCalled();
    expect(tx.inquiry.update).not.toHaveBeenCalled();
    expect(enqueueOutboundEmailMock).not.toHaveBeenCalled();
  });

  it('rejects sending after the RFQ or selected demand line closes', async () => {
    inquiry.rfq.status = 'COMPLETED';
    const closedRfq = await request(await app()).post('/i1/send').send({});
    expect(closedRfq.status).toBe(409);
    expect(closedRfq.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(tx.outboundEmail.create).not.toHaveBeenCalled();

    inquiry.rfq.status = 'SOURCING';
    tx.rfqLine.findMany.mockResolvedValue([{ id: 'rl1', rfqId: 'r1', status: 'CANCELLED' }]);
    const closedLine = await request(await app()).post('/i1/send').send({});
    expect(closedLine.status).toBe(409);
    expect(closedLine.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(tx.outboundEmail.create).not.toHaveBeenCalled();

    tx.rfqLine.findMany.mockResolvedValue([{ id: 'rl1', rfqId: 'other-rfq', status: 'OPEN' }]);
    const foreignLine = await request(await app()).post('/i1/send').send({});
    expect(foreignLine.status).toBe(409);
    expect(foreignLine.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(tx.outboundEmail.create).not.toHaveBeenCalled();
  });

  it('reports a missing supplier email without creating a queued delivery', async () => {
    inquiry.supplier.email = null;
    const response = await request(await app()).post('/i1/send').send({});
    expect(response.status).toBe(409);
    expect(response.body.message).toContain('供应商');
    expect(tx.emailAccount.findFirst).not.toHaveBeenCalled();
    expect(tx.outboundEmail.create).not.toHaveBeenCalled();
    expect(tx.inquiry.update).not.toHaveBeenCalled();
  });

  it('reports a malformed supplier email without creating a queued delivery', async () => {
    inquiry.supplier.email = 'not-an-email';
    const response = await request(await app()).post('/i1/send').send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RESOURCE_CONFLICT');
    expect(response.body.message).toContain('没有有效的询价邮箱');
    expect(tx.emailAccount.findFirst).not.toHaveBeenCalled();
    expect(tx.outboundEmail.create).not.toHaveBeenCalled();
    expect(tx.inquiry.update).not.toHaveBeenCalled();
    expect(enqueueOutboundEmailMock).not.toHaveBeenCalled();
  });

  it('reports a confirmed delivery failure without requiring delivery verification', async () => {
    prismaMock.inquiry.findFirst.mockResolvedValue({
      ...inquiry,
      status: 'QUEUED',
      outboundEmails: [{
        id: 'mail-failed', status: 'FAILED', errorMessage: 'smtp authCode=super-secret from: sales@example.invalid', sentAt: null,
      }],
    });
    const response = await request(await app()).get('/i1');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      deliveryStatus: 'failed',
      latestOutboundEmail: {
        id: 'mail-failed', status: 'failed', error: expect.any(String), sentAt: null,
        manualVerificationRequired: false, manualVerificationMessage: null, canCancel: false,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('super-secret');
    expect(response.body.data.latestOutboundEmail).not.toHaveProperty('toEmail');
    expect(response.body.data.latestOutboundEmail).not.toHaveProperty('textBody');
  });

  it('keeps an uncertain delivery distinct and requires manual verification', async () => {
    prismaMock.inquiry.findFirst.mockResolvedValue({
      ...inquiry,
      status: 'QUEUED',
      outboundEmails: [{
        id: 'mail-uncertain', status: 'NEEDS_VERIFICATION', errorMessage: 'transport outcome unknown', sentAt: null,
      }],
    });

    const response = await request(await app()).get('/i1');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      deliveryStatus: 'needs_verification',
      latestOutboundEmail: {
        id: 'mail-uncertain', status: 'needs_verification', manualVerificationRequired: true, canCancel: false,
      },
    });
    expect(response.body.data.latestOutboundEmail.manualVerificationMessage).toContain('投递结果不确定');
    expect(JSON.stringify(response.body)).not.toContain('transport outcome unknown');
  });

  it('preserves legacy inquiry delivery status when no outbound email history exists', async () => {
    prismaMock.inquiry.findFirst.mockResolvedValue({
      ...inquiry,
      status: 'SENT',
      sentAt: dueDate,
      outboundEmails: [],
    });

    const response = await request(await app()).get('/i1');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ deliveryStatus: 'smtp_accepted', latestOutboundEmail: null });
  });

  it('replays the same Idempotency-Key without creating a second email', async () => {
    const appInstance = await app();
    const first = await request(appInstance).post('/i1/send').set('Idempotency-Key', 'send-i1').send({});
    const replay = await request(appInstance).post('/i1/send').set('Idempotency-Key', 'send-i1').send({});
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(first.headers['idempotency-key']).toBe('send-i1');
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(replay.headers['idempotency-key']).toBe('send-i1');
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(buildIdempotencyContextMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ id: 'i1' }) }),
      actor.id,
      'POST:/inquiries/i1/send',
    );
    expect(runIdempotentOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: actor.id, scope: 'POST:/inquiries/i1/send', key: 'send-i1' }),
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
    expect(applyIdempotencyHeadersMock).toHaveBeenCalledTimes(2);
    expect(tx.outboundEmail.create).toHaveBeenCalledTimes(1);
    expect(enqueueOutboundEmailMock).toHaveBeenCalledTimes(1);
  });

  it('keeps SMTP acceptance as a completed transport boundary', async () => {
    prismaMock.inquiry.findFirst.mockResolvedValue({
      ...inquiry,
      status: 'QUEUED',
      outboundEmails: [{ id: 'mail-sent', status: 'SENT', errorMessage: null, sentAt: dueDate }],
    });

    const response = await request(await app()).get('/i1');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      deliveryStatus: 'smtp_accepted',
      latestOutboundEmail: { id: 'mail-sent', manualVerificationRequired: false, canCancel: false },
    });
  });

  it('keeps SENDING out of cancellation and manual verification states', async () => {
    prismaMock.inquiry.findFirst.mockResolvedValue({
      ...inquiry,
      status: 'QUEUED',
      outboundEmails: [{ id: 'mail-sending', status: 'SENDING', errorMessage: null, sentAt: null }],
    });

    const response = await request(await app()).get('/i1');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      deliveryStatus: 'processing',
      latestOutboundEmail: { id: 'mail-sending', manualVerificationRequired: false, canCancel: false },
    });
  });

  it('keeps a claimed PENDING email non-cancellable and in verification when no event can prove it is still queued', async () => {
    prismaMock.inquiry.findFirst.mockResolvedValue({
      ...inquiry,
      status: 'QUEUED',
      outboundEmails: [{ id: 'mail-pending', status: 'PENDING', errorMessage: null, sentAt: null }],
    });

    const response = await request(await app()).get('/i1');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      deliveryStatus: 'needs_verification',
      latestOutboundEmail: { id: 'mail-pending', manualVerificationRequired: true, canCancel: false },
    });
  });

  it('rejects a normal retry after the inquiry is already queued', async () => {
    const appInstance = await app();
    const first = await request(appInstance).post('/i1/send').send({});
    const retry = await request(appInstance).post('/i1/send').send({});
    expect(first.status).toBe(202);
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('STATE_CONFLICT');
    expect(tx.outboundEmail.create).toHaveBeenCalledTimes(1);
    expect(enqueueOutboundEmailMock).toHaveBeenCalledTimes(1);
  });

  it('cancels only a pending inquiry outbox event that has never been claimed and preserves its email snapshot', async () => {
    inquiry.status = 'QUEUED';
    inquiry.outboundEmails = [{ id: 'mail-1', status: 'PENDING', errorMessage: null, sentAt: null }];
    const response = await request(await app()).post('/i1/cancel-send').send({});

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: 'draft',
      deliveryStatus: 'cancelled',
      latestOutboundEmail: { id: 'mail-1', status: 'withdrawn', canCancel: false, manualVerificationRequired: false },
    });
    expect(tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'outbox-1', channel: 'EMAIL', status: 'PENDING', attemptCount: 0, workerId: null, lockedAt: null },
      data: expect.objectContaining({ status: 'CANCELLED', nextRetryAt: null }),
    });
    expect(tx.outboundEmail.updateMany).toHaveBeenCalledWith({
      where: { id: 'mail-1', inquiryId: 'i1', purpose: 'INQUIRY_SEND', status: 'PENDING' },
      data: expect.objectContaining({ status: 'WITHDRAWN', withdrawnAt: expect.any(Date) }),
    });
    expect(tx.outboundEmail.updateMany.mock.calls[0][0].data).not.toHaveProperty('subject');
    expect(tx.outboundEmail.updateMany.mock.calls[0][0].data).not.toHaveProperty('textBody');
    expect(tx.inquiry.updateMany).toHaveBeenCalledWith({ where: { id: 'i1', status: 'QUEUED' }, data: { status: 'DRAFT' } });
  });

  it('loses cancellation safely when the worker claims the inquiry first', async () => {
    inquiry.status = 'QUEUED';
    inquiry.outboundEmails = [{ id: 'mail-1', status: 'PENDING', errorMessage: null, sentAt: null }];
    tx.outboxEvent.updateMany.mockResolvedValue({ count: 0 });

    const response = await request(await app()).post('/i1/cancel-send').send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(response.body.message).toContain('Worker 已领取');
    expect(tx.outboundEmail.updateMany).not.toHaveBeenCalled();
    expect(tx.inquiry.updateMany).not.toHaveBeenCalled();
  });

  it('does not cancel a claimed or attempted inquiry and requires a delivery check', async () => {
    inquiry.status = 'QUEUED';
    inquiry.outboundEmails = [{ id: 'mail-1', status: 'PENDING', errorMessage: null, sentAt: null }];
    tx.outboxEvent.findMany.mockResolvedValueOnce([{
      id: 'outbox-1', status: 'RETRYING', attemptCount: 1,
      payload: JSON.stringify({ outboundEmailId: 'mail-1' }), workerId: null, lockedAt: null,
    }]);

    const response = await request(await app()).post('/i1/cancel-send').send({});

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('无法安全取消');
    expect(tx.outboxEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.outboundEmail.updateMany).not.toHaveBeenCalled();
  });

  it('checks inquiry source ownership before canceling', async () => {
    actor = { ...actor, id: 'other-sales' };
    inquiry.status = 'QUEUED';
    inquiry.outboundEmails = [{ id: 'mail-1', status: 'PENDING', errorMessage: null, sentAt: null }];

    const response = await request(await app()).post('/i1/cancel-send').send({});

    expect(response.status).toBe(403);
    expect(tx.outboxEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.outboundEmail.updateMany).not.toHaveBeenCalled();
  });
});
