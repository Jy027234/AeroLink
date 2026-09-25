import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('inquiry email dispatch', () => {
  const dueDate = new Date('2026-10-15T00:00:00.000Z');
  const actor = { id: 'sales-1', role: 'sales', department: 'Sales' };
  let inquiry: any;
  let tx: any;
  let prismaMock: any;
  let runIdempotentOperationMock: ReturnType<typeof vi.fn>;
  let enqueueOutboundEmailMock: ReturnType<typeof vi.fn>;
  let cache: Map<string, any>;

  beforeEach(() => {
    vi.resetModules();
    cache = new Map();
    inquiry = {
      id: 'i1', inquiryNumber: 'INQ-2026-ABC123', supplierId: 's1', rfqId: 'r1', notes: 'internal only',
      isAOG: true, status: 'DRAFT', createdAt: dueDate, sentAt: null,
      supplier: { id: 's1', name: 'Supplier One', email: 'quotes@supplier.example' },
      rfq: { id: 'r1', rfqNumber: 'RFQ-2026-42', createdBy: actor.id, creator: { department: actor.department } },
      items: [{ id: 'ii1', lineNo: 1, rfqLineId: 'rl1', partNumber: 'PN-100', quantity: 4, requiredDate: dueDate, certificateRequired: true }],
    };
    tx = {
      inquiry: {
        findFirst: vi.fn(async () => inquiry),
        update: vi.fn(async ({ data }) => {
          inquiry = { ...inquiry, ...data };
          return { id: inquiry.id, status: inquiry.status, sentAt: inquiry.sentAt };
        }),
      },
      emailAccount: { findFirst: vi.fn().mockResolvedValue({ id: 'acct-1' }) },
      outboundEmail: { create: vi.fn().mockResolvedValue({ id: 'mail-1', status: 'PENDING', errorMessage: null, sentAt: null }) },
    };
    prismaMock = {
      inquiry: {
        findFirst: vi.fn().mockResolvedValue({ id: 'i1' }),
        findMany: vi.fn(),
      },
    };
    enqueueOutboundEmailMock = vi.fn().mockResolvedValue({ id: 'outbox-1' });
    runIdempotentOperationMock = vi.fn(async (context: any, operation: (transaction: any) => Promise<any>) => {
      if (context.key && cache.has(context.key)) return cache.get(context.key);
      const result = await operation(tx);
      const execution = { ...result, replayed: false, key: context.key };
      if (context.key) cache.set(context.key, execution);
      return execution;
    });
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/idempotencyService.js', () => ({
      buildIdempotencyContext: vi.fn((req: express.Request) => ({ key: req.get('Idempotency-Key') })),
      applyIdempotencyHeaders: vi.fn(),
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

  it('reports a missing supplier email without creating a queued delivery', async () => {
    inquiry.supplier.email = null;
    const response = await request(await app()).post('/i1/send').send({});
    expect(response.status).toBe(409);
    expect(response.body.message).toContain('供应商');
    expect(tx.emailAccount.findFirst).not.toHaveBeenCalled();
    expect(tx.outboundEmail.create).not.toHaveBeenCalled();
    expect(tx.inquiry.update).not.toHaveBeenCalled();
  });

  it('serializes the latest delivery result without exposing raw transport details', async () => {
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
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('super-secret');
    expect(response.body.data.latestOutboundEmail).not.toHaveProperty('toEmail');
    expect(response.body.data.latestOutboundEmail).not.toHaveProperty('textBody');
  });

  it('replays the same Idempotency-Key without creating a second email', async () => {
    const appInstance = await app();
    const first = await request(appInstance).post('/i1/send').set('Idempotency-Key', 'send-i1').send({});
    const replay = await request(appInstance).post('/i1/send').set('Idempotency-Key', 'send-i1').send({});
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(tx.outboundEmail.create).toHaveBeenCalledTimes(1);
    expect(enqueueOutboundEmailMock).toHaveBeenCalledTimes(1);
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
});
