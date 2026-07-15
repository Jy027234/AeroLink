import { beforeEach, describe, expect, it, vi } from 'vitest';

function createOutboxEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'outbox-1',
    channel: 'WEBHOOK',
    eventType: 'rfq.created',
    aggregateType: 'RFQ',
    aggregateId: 'rfq-1',
    payload: JSON.stringify({ rfqId: 'rfq-1' }),
    status: 'PROCESSING',
    attemptCount: 1,
    maxAttempts: 5,
    nextRetryAt: null,
    lockedAt: new Date(),
    deliveredAt: null,
    lastError: null,
    createdById: 'user-1',
    createdAt: new Date('2026-07-16T00:00:00.000Z'),
    updatedAt: new Date('2026-07-16T00:00:00.000Z'),
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    outboxEvent: { create: vi.fn(), update: vi.fn() },
    outboundEmail: { updateMany: vi.fn() },
    notification: { create: vi.fn() },
    quotation: { findUnique: vi.fn() },
    transactionStatusHistory: { create: vi.fn() },
  };

  return {
    outboxEvent: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    outboundEmail: { findUnique: vi.fn() },
    customer: { findUnique: vi.fn() },
    $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    __tx: tx,
  };
}

describe('outboxService', () => {
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let queueWebhookEventMock: ReturnType<typeof vi.fn>;
  let emitToRoomMock: ReturnType<typeof vi.fn>;
  let sendEmailMock: ReturnType<typeof vi.fn>;
  let enqueueBusinessEvent: typeof import('./outboxService.js').enqueueBusinessEvent;
  let processOutboxEvent: typeof import('./outboxService.js').processOutboxEvent;

  beforeEach(async () => {
    vi.resetModules();
    prismaMock = createPrismaMock();
    queueWebhookEventMock = vi.fn().mockResolvedValue({ eventId: 'outbox-1', queued: 1 });
    emitToRoomMock = vi.fn().mockReturnValue(true);
    sendEmailMock = vi.fn();

    vi.doMock('./prisma.js', () => ({ default: prismaMock }));
    vi.doMock('./webhookService.js', () => ({ queueWebhookEvent: queueWebhookEventMock }));
    vi.doMock('./socketEvents.js', () => ({ emitToRoom: emitToRoomMock }));
    vi.doMock('./emailService.js', () => ({ sendEmail: sendEmailMock }));
    vi.doMock('./crypto.js', () => ({ decrypt: vi.fn((value: string) => value) }));
    vi.doMock('./pdfService.js', () => ({ generateQuotationPDF: vi.fn() }));

    ({ enqueueBusinessEvent, processOutboxEvent } = await import('./outboxService.js'));
  });

  it('writes webhook and socket work items through the caller transaction', async () => {
    prismaMock.__tx.outboxEvent.create
      .mockResolvedValueOnce({ id: 'webhook-event' })
      .mockResolvedValueOnce({ id: 'socket-event' });

    const result = await enqueueBusinessEvent(prismaMock.__tx as never, {
      eventType: 'rfq.created',
      aggregateType: 'RFQ',
      aggregateId: 'rfq-1',
      data: { rfqId: 'rfq-1' },
      socket: { room: 'rfqs', event: 'rfq:created' },
      createdById: 'user-1',
    });

    expect(result).toEqual({ webhookEvent: { id: 'webhook-event' }, socketEvent: { id: 'socket-event' } });
    expect(prismaMock.__tx.outboxEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        channel: 'WEBHOOK',
        eventType: 'rfq.created',
        aggregateType: 'RFQ',
        aggregateId: 'rfq-1',
        payload: JSON.stringify({ rfqId: 'rfq-1' }),
      }),
    });
    expect(prismaMock.__tx.outboxEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        channel: 'SOCKET',
        payload: JSON.stringify({ room: 'rfqs', event: 'rfq:created', data: { rfqId: 'rfq-1' } }),
      }),
    });
  });

  it('marks a webhook event delivered after materializing idempotent delivery records', async () => {
    const event = createOutboxEvent();
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.outboxEvent.update.mockResolvedValue({ ...event, status: 'DELIVERED' });

    const delivered = await processOutboxEvent(event.id);

    expect(delivered).toBe(true);
    expect(queueWebhookEventMock).toHaveBeenCalledWith(
      'rfq.created',
      { rfqId: 'rfq-1' },
      expect.objectContaining({
        eventId: 'outbox-1',
        outboxEventId: 'outbox-1',
        deliverImmediately: false,
      }),
    );
    expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: expect.objectContaining({ status: 'DELIVERED', lockedAt: null, lastError: null }),
    });
  });

  it('compensates a terminal email failure by marking the email failed and notifying its requester', async () => {
    const event = createOutboxEvent({
      channel: 'EMAIL',
      eventType: 'quotation.email.send',
      payload: JSON.stringify({ outboundEmailId: 'mail-1', includeQuotationPdf: false }),
      maxAttempts: 1,
      attemptCount: 1,
    });
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.outboundEmail.findUnique.mockResolvedValue({
      id: 'mail-1',
      status: 'PENDING',
      purpose: 'QUOTATION_SEND',
      quotationId: 'q001',
      toEmail: 'procurement@airchina.com',
      subject: 'Quote',
      textBody: 'Body',
      htmlBody: null,
      account: {
        id: 'acct-1',
        email: 'sales@aerolink.com',
        displayName: null,
        imapServer: 'imap.example.com',
        imapPort: '993',
        smtpServer: 'smtp.example.com',
        smtpPort: '465',
        authCode: 'secret',
        accountType: 'IMAP_SMTP',
        isActive: true,
      },
      quotation: { id: 'q001', status: 'APPROVED' },
    });
    sendEmailMock.mockRejectedValue(new Error('SMTP unavailable'));
    prismaMock.__tx.outboxEvent.update.mockResolvedValue({ ...event, status: 'FAILED' });
    prismaMock.__tx.outboundEmail.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.__tx.notification.create.mockResolvedValue({ id: 'notification-1' });

    const delivered = await processOutboxEvent(event.id);

    expect(delivered).toBe(false);
    expect(prismaMock.__tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: event.id },
      data: expect.objectContaining({ status: 'FAILED', nextRetryAt: null, lastError: 'SMTP unavailable' }),
    });
    expect(prismaMock.__tx.outboundEmail.updateMany).toHaveBeenCalledWith({
      where: { id: 'mail-1', status: { notIn: ['SENT', 'WITHDRAWN'] } },
      data: { status: 'FAILED', errorMessage: 'SMTP unavailable' },
    });
    expect(prismaMock.__tx.notification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-1', title: '异步邮件投递失败' }),
    }));
  });

  it('marks a malformed terminal email event failed instead of leaving its worker lock stuck', async () => {
    const event = createOutboxEvent({
      channel: 'EMAIL',
      eventType: 'quotation.email.send',
      payload: '{}',
      maxAttempts: 1,
      attemptCount: 1,
    });
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.__tx.outboxEvent.update.mockResolvedValue({ ...event, status: 'FAILED' });

    await expect(processOutboxEvent(event.id)).resolves.toBe(false);

    expect(prismaMock.__tx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: event.id },
      data: expect.objectContaining({ status: 'FAILED', nextRetryAt: null }),
    });
    expect(prismaMock.__tx.outboundEmail.updateMany).not.toHaveBeenCalled();
  });
});
