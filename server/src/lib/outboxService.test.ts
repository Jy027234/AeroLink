import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQuotationRenderSnapshot, serializeQuotationRenderSnapshot } from './documentRenderSnapshot.js';

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

function frozenQuotationSnapshot(quotationId: string, commonNote = 'Frozen terms') {
  return buildQuotationRenderSnapshot({
    quotation: {
      id: quotationId,
      quoteNumber: 'QT-001',
      partNumber: 'PN-100',
      quantity: 2,
      unitPrice: 125,
      totalPrice: 250,
      validityDays: 7,
      currency: 'USD',
      commonNote,
      createdAt: '2026-09-08T02:00:00.000Z',
      expiryDate: '2026-09-15T02:00:00.000Z',
      commercialRevision: 1,
      version: 2,
    },
    customer: { id: 'customer-1', name: '原客户' },
    capturedAt: '2026-09-08T02:30:00.000Z',
  });
}

function createPrismaMock() {
  const tx = {
    outboxEvent: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
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
    generatedDocument: { findUnique: vi.fn() },
    customer: { findUnique: vi.fn() },
    $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    __tx: tx,
  };
}

describe('outboxService', () => {
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let queueWebhookEventMock: ReturnType<typeof vi.fn>;
  let emitToRoomMock: ReturnType<typeof vi.fn>;
  let emitScopedSocketEventMock: ReturnType<typeof vi.fn>;
  let sendEmailMock: ReturnType<typeof vi.fn>;
  let enqueueBusinessEvent: typeof import('./outboxService.js').enqueueBusinessEvent;
  let processOutboxEvent: typeof import('./outboxService.js').processOutboxEvent;
  let processPendingOutboxEvents: typeof import('./outboxService.js').processPendingOutboxEvents;
  let retryOutboxEvent: typeof import('./outboxService.js').retryOutboxEvent;
  let cancelOutboxEvent: typeof import('./outboxService.js').cancelOutboxEvent;

  beforeEach(async () => {
    vi.resetModules();
    prismaMock = createPrismaMock();
    queueWebhookEventMock = vi.fn().mockResolvedValue({ eventId: 'outbox-1', queued: 1 });
    emitToRoomMock = vi.fn().mockReturnValue(true);
    emitScopedSocketEventMock = vi.fn().mockResolvedValue(true);
    sendEmailMock = vi.fn();

    vi.doMock('./prisma.js', () => ({ default: prismaMock }));
    vi.doMock('./webhookService.js', () => ({ queueWebhookEvent: queueWebhookEventMock }));
    vi.doMock('./socketEvents.js', () => ({
      emitToRoom: emitToRoomMock,
      emitScopedSocketEvent: emitScopedSocketEventMock,
    }));
    vi.doMock('./emailService.js', () => ({ sendEmail: sendEmailMock }));
    vi.doMock('./crypto.js', () => ({ decrypt: vi.fn((value: string) => value) }));
    vi.doMock('./pdfService.js', () => ({ generateQuotationPDF: vi.fn(), generatePDF: vi.fn().mockResolvedValue(Buffer.from('rendered-pdf')) }));

    ({ enqueueBusinessEvent, processOutboxEvent, processPendingOutboxEvents, retryOutboxEvent, cancelOutboxEvent } = await import('./outboxService.js'));
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
        payload: JSON.stringify({
          room: 'rfqs',
          event: 'rfq:created',
          data: { rfqId: 'rfq-1' },
          scope: { capability: 'rfq.read' },
        }),
      }),
    });
  });

  it('stores the request correlation id on asynchronous work without exposing it in payload data', async () => {
    prismaMock.__tx.outboxEvent.create.mockResolvedValue({ id: 'webhook-event' });
    const { runWithRequestContext } = await import('./requestContext.js');

    await runWithRequestContext('request-123', () => enqueueBusinessEvent(prismaMock.__tx as never, {
      eventType: 'rfq.created',
      aggregateType: 'RFQ',
      aggregateId: 'rfq-1',
      data: { rfqId: 'rfq-1' },
      createdById: 'user-1',
    }));

    expect(prismaMock.__tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requestId: 'request-123', payload: JSON.stringify({ rfqId: 'rfq-1' }) }),
    });
  });

  it('marks a webhook event delivered after materializing idempotent delivery records', async () => {
    const event = createOutboxEvent();
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

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
    expect(prismaMock.outboxEvent.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'outbox-1', status: 'PROCESSING', workerId: expect.stringMatching(/^worker-/) },
      data: expect.objectContaining({ status: 'DELIVERED', lockedAt: null, lastError: null }),
    });
  });

  it('allows only one concurrent worker to claim an outbox event', async () => {
    const event = createOutboxEvent();
    prismaMock.outboxEvent.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);

    const results = await Promise.all([
      processOutboxEvent(event.id, 'worker-a'),
      processOutboxEvent(event.id, 'worker-b'),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(queueWebhookEventMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: event.id, status: 'PROCESSING', workerId: 'worker-a' },
    }));
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
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.__tx.outboundEmail.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.__tx.notification.create.mockResolvedValue({ id: 'notification-1' });

    const delivered = await processOutboxEvent(event.id);

    expect(delivered).toBe(false);
    expect(prismaMock.__tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: 'PROCESSING', workerId: expect.stringMatching(/^worker-/) },
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

  it('fails closed when a customer quotation email has no immutable attachment document', async () => {
    const event = createOutboxEvent({
      channel: 'EMAIL',
      eventType: 'quotation.email.send',
      payload: JSON.stringify({ outboundEmailId: 'mail-immutable', includeQuotationPdf: true }),
      maxAttempts: 1,
      attemptCount: 1,
    });
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.outboundEmail.findUnique.mockResolvedValue({
      id: 'mail-immutable',
      status: 'PENDING',
      purpose: 'QUOTATION_SEND',
      quotationId: 'q001',
      toEmail: 'procurement@airchina.com',
      subject: 'Quote',
      textBody: 'Body',
      htmlBody: null,
      account: { id: 'acct-1', email: 'sales@aerolink.com', displayName: null, imapServer: 'imap.example.com', imapPort: '993', smtpServer: 'smtp.example.com', smtpPort: '465', authCode: 'secret', accountType: 'IMAP_SMTP', isActive: true },
      quotation: { id: 'q001', status: 'APPROVED', supersededAt: null },
    });
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    await expect(processOutboxEvent(event.id)).resolves.toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(prismaMock.__tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: 'PROCESSING', workerId: expect.stringMatching(/^worker-/) },
      data: expect.objectContaining({ status: 'CANCELLED', lastError: 'Quotation PDF attachment snapshot is missing' }),
    });
    expect(prismaMock.__tx.outboundEmail.updateMany).toHaveBeenCalledWith({
      where: { id: 'mail-immutable', status: { notIn: ['SENT', 'WITHDRAWN'] } },
      data: { status: 'FAILED', errorMessage: 'Quotation PDF attachment snapshot is missing' },
    });
  });

  it('replays an immutable document attachment without reading current quotation/customer values', async () => {
    const snapshot = frozenQuotationSnapshot('q001', '客户承担运输成本');
    const frozenHtml = '<p>Frozen customer: 原客户</p><p>客户承担运输成本</p>';
    const event = createOutboxEvent({
      channel: 'EMAIL',
      eventType: 'quotation.email.send',
      payload: JSON.stringify({
        outboundEmailId: 'mail-immutable',
        includeQuotationPdf: true,
        attachmentDocumentId: 'document-1',
        attachmentSnapshotHash: snapshot.snapshotHash,
      }),
    });
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.outboundEmail.findUnique.mockResolvedValue({
      id: 'mail-immutable',
      status: 'PENDING',
      purpose: 'QUOTATION_SEND',
      quotationId: 'q001',
      toEmail: 'procurement@airchina.com',
      subject: 'Quote',
      textBody: 'Body',
      htmlBody: null,
      account: { id: 'acct-1', email: 'sales@aerolink.com', displayName: null, imapServer: 'imap.example.com', imapPort: '993', smtpServer: 'smtp.example.com', smtpPort: '465', authCode: 'secret', accountType: 'IMAP_SMTP', isActive: true },
      // These live values must not be consulted to build the attachment.
      quotation: { id: 'q001', status: 'APPROVED', supersededAt: null, quoteNumber: 'LATEST-QUOTE' },
    });
    prismaMock.generatedDocument.findUnique.mockResolvedValue({
      id: 'document-1',
      title: 'QT-001',
      documentType: 'QUOTATION_PDF',
      quotationId: 'q001',
      contentHtml: frozenHtml,
      generatedAt: new Date('2026-09-08T02:30:00.000Z'),
      payloadJson: serializeQuotationRenderSnapshot(snapshot),
      contentSha256: crypto.createHash('sha256').update(frozenHtml).digest('hex'),
      snapshotHash: snapshot.snapshotHash,
      pdfBytes: Buffer.from('rendered-pdf'),
      pdfSha256: crypto.createHash('sha256').update('rendered-pdf').digest('hex'),
    });
    sendEmailMock.mockResolvedValue({ messageId: 'provider-1' });
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.__tx.outboundEmail.updateMany.mockResolvedValue({ count: 1 });

    await expect(processOutboxEvent(event.id)).resolves.toBe(true);
    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      attachments: [expect.objectContaining({
        filename: 'QT-001.pdf',
        content: Buffer.from('rendered-pdf'),
        contentType: 'application/pdf',
        snapshotHash: snapshot.snapshotHash,
      })],
    }));
  });

  it('does not present a legacy document without a snapshot marker as historical evidence', async () => {
    const event = createOutboxEvent({
      channel: 'EMAIL',
      eventType: 'quotation.email.send',
      payload: JSON.stringify({ outboundEmailId: 'mail-legacy', includeQuotationPdf: true, attachmentDocumentId: 'legacy-document' }),
    });
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.outboundEmail.findUnique.mockResolvedValue({
      id: 'mail-legacy',
      status: 'PENDING',
      purpose: 'QUOTATION_SEND',
      quotationId: 'q-legacy',
      toEmail: 'customer@example.com',
      subject: 'Legacy quote',
      textBody: 'Body',
      htmlBody: null,
      account: { id: 'acct-1', email: 'sales@aerolink.com', displayName: null, imapServer: 'imap.example.com', imapPort: '993', smtpServer: 'smtp.example.com', smtpPort: '465', authCode: 'secret', accountType: 'IMAP_SMTP', isActive: true },
      quotation: { id: 'q-legacy', status: 'APPROVED', supersededAt: null },
    });
    prismaMock.generatedDocument.findUnique.mockResolvedValue({
      id: 'legacy-document',
      title: 'QT-LEGACY',
      documentType: 'QUOTATION_PDF',
      quotationId: 'q-legacy',
      contentHtml: '<p>Current live data</p>',
      generatedAt: new Date('2026-09-08T02:30:00.000Z'),
      snapshotHash: null,
      pdfBytes: Buffer.from('legacy-pdf'),
      pdfSha256: crypto.createHash('sha256').update('legacy-pdf').digest('hex'),
    });
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    await expect(processOutboxEvent(event.id)).resolves.toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(prismaMock.__tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: 'PROCESSING', workerId: expect.stringMatching(/^worker-/) },
      data: expect.objectContaining({ status: 'CANCELLED', lastError: 'Historical quotation document has no immutable snapshot marker' }),
    });
  });

  it('does not regenerate a snapshot document when its final PDF bytes are unavailable', async () => {
    const snapshot = frozenQuotationSnapshot('q-no-bytes');
    const frozenHtml = '<p>Frozen HTML</p>';
    const event = createOutboxEvent({
      channel: 'EMAIL',
      eventType: 'quotation.email.send',
      payload: JSON.stringify({ outboundEmailId: 'mail-no-bytes', includeQuotationPdf: true, attachmentDocumentId: 'document-no-bytes' }),
    });
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.outboundEmail.findUnique.mockResolvedValue({
      id: 'mail-no-bytes',
      status: 'PENDING',
      purpose: 'QUOTATION_SEND',
      quotationId: 'q-no-bytes',
      toEmail: 'customer@example.com',
      subject: 'Quote',
      textBody: 'Body',
      htmlBody: null,
      account: { id: 'acct-1', email: 'sales@aerolink.com', displayName: null, imapServer: 'imap.example.com', imapPort: '993', smtpServer: 'smtp.example.com', smtpPort: '465', authCode: 'secret', accountType: 'IMAP_SMTP', isActive: true },
      quotation: { id: 'q-no-bytes', status: 'APPROVED', supersededAt: null },
    });
    prismaMock.generatedDocument.findUnique.mockResolvedValue({
      id: 'document-no-bytes',
      title: 'QT-NO-BYTES',
      documentType: 'QUOTATION_PDF',
      quotationId: 'q-no-bytes',
      contentHtml: frozenHtml,
      generatedAt: new Date('2026-09-08T02:30:00.000Z'),
      payloadJson: serializeQuotationRenderSnapshot(snapshot),
      contentSha256: crypto.createHash('sha256').update(frozenHtml).digest('hex'),
      snapshotHash: snapshot.snapshotHash,
      pdfBytes: null,
      pdfSha256: null,
    });
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    await expect(processOutboxEvent(event.id)).resolves.toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(prismaMock.__tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: 'PROCESSING', workerId: expect.stringMatching(/^worker-/) },
      data: expect.objectContaining({ status: 'CANCELLED', lastError: 'Immutable quotation PDF bytes are missing' }),
    });
  });

  it('rejects an attachment frozen for a different quotation', async () => {
    const snapshot = frozenQuotationSnapshot('q-other');
    const bytes = Buffer.from('wrong-quotation-pdf');
    const event = createOutboxEvent({
      channel: 'EMAIL',
      eventType: 'quotation.email.send',
      payload: JSON.stringify({ outboundEmailId: 'mail-wrong-source', includeQuotationPdf: true, attachmentDocumentId: 'document-wrong-source', attachmentSnapshotHash: snapshot.snapshotHash }),
    });
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.outboundEmail.findUnique.mockResolvedValue({
      id: 'mail-wrong-source',
      status: 'PENDING',
      purpose: 'QUOTATION_SEND',
      quotationId: 'q-current',
      toEmail: 'customer@example.com',
      subject: 'Quote',
      textBody: 'Body',
      htmlBody: null,
      account: { id: 'acct-1', email: 'sales@aerolink.com', displayName: null, imapServer: 'imap.example.com', imapPort: '993', smtpServer: 'smtp.example.com', smtpPort: '465', authCode: 'secret', accountType: 'IMAP_SMTP', isActive: true },
      quotation: { id: 'q-current', status: 'APPROVED', supersededAt: null },
    });
    const otherHtml = '<p>Frozen other quotation</p>';
    prismaMock.generatedDocument.findUnique.mockResolvedValue({
      id: 'document-wrong-source',
      title: 'QT-OTHER',
      documentType: 'QUOTATION_PDF',
      quotationId: 'q-other',
      contentHtml: otherHtml,
      generatedAt: new Date('2026-09-08T02:30:00.000Z'),
      payloadJson: serializeQuotationRenderSnapshot(snapshot),
      contentSha256: crypto.createHash('sha256').update(otherHtml).digest('hex'),
      snapshotHash: snapshot.snapshotHash,
      pdfBytes: bytes,
      pdfSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    await expect(processOutboxEvent(event.id)).resolves.toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(prismaMock.__tx.outboundEmail.updateMany).toHaveBeenCalledWith({
      where: { id: 'mail-wrong-source', status: { notIn: ['SENT', 'WITHDRAWN'] } },
      data: { status: 'FAILED', errorMessage: 'Outbound quotation attachment belongs to a different quotation' },
    });
  });

  it('cancels a pending quotation email after its quotation is superseded', async () => {
    const event = createOutboxEvent({
      channel: 'EMAIL',
      eventType: 'quotation.email.send',
      payload: JSON.stringify({ outboundEmailId: 'mail-old', includeQuotationPdf: true, attachmentDocumentId: 'document-old' }),
    });
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.outboundEmail.findUnique.mockResolvedValue({
      id: 'mail-old',
      status: 'PENDING',
      purpose: 'QUOTATION_SEND',
      quotationId: 'q-old',
      toEmail: 'customer@example.com',
      subject: 'Old quote',
      textBody: 'Body',
      htmlBody: null,
      account: { id: 'acct-1', email: 'sales@aerolink.com', displayName: null, imapServer: 'imap.example.com', imapPort: '993', smtpServer: 'smtp.example.com', smtpPort: '465', authCode: 'secret', accountType: 'IMAP_SMTP', isActive: true },
      quotation: { id: 'q-old', status: 'APPROVED', supersededAt: new Date('2026-09-08T03:00:00.000Z') },
    });
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    await expect(processOutboxEvent(event.id)).resolves.toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(prismaMock.__tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: 'PROCESSING', workerId: expect.stringMatching(/^worker-/) },
      data: expect.objectContaining({ status: 'CANCELLED', lastError: 'Quotation was superseded before email delivery' }),
    });
    expect(prismaMock.__tx.outboundEmail.updateMany).toHaveBeenCalledWith({
      where: { id: 'mail-old', status: { notIn: ['SENT', 'WITHDRAWN'] } },
      data: { status: 'FAILED', errorMessage: 'Quotation was superseded before email delivery' },
    });
  });

  it('does not mark the linked email when an expired worker loses the cancellation lease CAS', async () => {
    const event = createOutboxEvent({
      channel: 'EMAIL',
      eventType: 'quotation.email.send',
      payload: JSON.stringify({ outboundEmailId: 'mail-stale', includeQuotationPdf: true }),
    });
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.outboundEmail.findUnique.mockResolvedValue({
      id: 'mail-stale',
      status: 'PENDING',
      purpose: 'QUOTATION_SEND',
      quotationId: 'q-stale',
      toEmail: 'customer@example.com',
      subject: 'Quote',
      textBody: 'Body',
      htmlBody: null,
      account: { id: 'acct-1', email: 'sales@aerolink.com', displayName: null, imapServer: 'imap.example.com', imapPort: '993', smtpServer: 'smtp.example.com', smtpPort: '465', authCode: 'secret', accountType: 'IMAP_SMTP', isActive: true },
      quotation: { id: 'q-stale', status: 'APPROVED', supersededAt: new Date('2026-09-08T03:00:00.000Z') },
    });
    // Initial claim succeeds; the later cancellation CAS loses to a newer
    // worker that recovered the lease.
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(processOutboxEvent(event.id)).resolves.toBe(false);
    expect(prismaMock.__tx.outboundEmail.updateMany).not.toHaveBeenCalled();
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
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    await expect(processOutboxEvent(event.id)).resolves.toBe(false);

    expect(prismaMock.__tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: 'PROCESSING', workerId: expect.stringMatching(/^worker-/) },
      data: expect.objectContaining({ status: 'FAILED', nextRetryAt: null }),
    });
    expect(prismaMock.__tx.outboundEmail.updateMany).not.toHaveBeenCalled();
  });

  it('dispatches socket events through the scoped emitter with a current-policy payload', async () => {
    const event = createOutboxEvent({
      channel: 'SOCKET',
      eventType: 'rfq.updated',
      payload: JSON.stringify({
        room: 'rfqs',
        event: 'rfq:updated',
        data: { rfqId: 'rfq-1', totalPrice: 99, status: 'SUBMITTED' },
        scope: { capability: 'rfq.read', ownerId: 'user-1', department: 'Sales' },
      }),
    });
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(event);

    await expect(processOutboxEvent(event.id, 'api-socket', { channels: ['SOCKET'] })).resolves.toBe(true);
    expect(emitScopedSocketEventMock).toHaveBeenCalledWith({
      event: 'rfq:updated',
      data: { rfqId: 'rfq-1', status: 'SUBMITTED' },
      scope: { capability: 'rfq.read', ownerId: 'user-1', department: 'Sales' },
      aggregateType: 'RFQ',
      aggregateId: 'rfq-1',
    });
    expect(emitToRoomMock).not.toHaveBeenCalled();
  });

  it('releases a claim when the event disappears before dispatch', async () => {
    prismaMock.outboxEvent.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMock.outboxEvent.findUnique.mockResolvedValue(null);

    await expect(processOutboxEvent('missing-event', 'worker-missing')).resolves.toBe(false);

    expect(prismaMock.outboxEvent.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'missing-event', status: 'PROCESSING', workerId: 'worker-missing' },
      data: expect.objectContaining({
        status: 'RETRYING',
        lockedAt: null,
        workerId: null,
        lastError: 'Outbox event disappeared after claim',
      }),
    });
  });

  it('claims only events from the channel owned by the caller', async () => {
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(processOutboxEvent('webhook-event', 'api-socket', {
      channels: ['SOCKET'],
    })).resolves.toBe(false);

    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ channel: { in: ['SOCKET'] } }),
    }));
    expect(prismaMock.outboxEvent.findUnique).not.toHaveBeenCalled();
  });

  it('recovers stale claims and scans only the selected channel', async () => {
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.outboxEvent.findMany.mockResolvedValue([]);

    await expect(processPendingOutboxEvents(10, 'api-socket', {
      channels: ['SOCKET'],
    })).resolves.toEqual({ processed: 0, delivered: 0 });

    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        channel: { in: ['SOCKET'] },
        status: 'PROCESSING',
      }),
    }));
    expect(prismaMock.outboxEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ channel: { in: ['SOCKET'] } }),
    }));
  });

  it('can constrain standalone processing to EMAIL and WEBHOOK channels', async () => {
    prismaMock.outboxEvent.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.outboxEvent.findMany.mockResolvedValue([]);

    await processPendingOutboxEvents(10, 'standalone-worker', {
      channels: ['EMAIL', 'WEBHOOK'],
    });

    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ channel: { in: ['EMAIL', 'WEBHOOK'] } }),
    }));
    expect(prismaMock.outboxEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ channel: { in: ['EMAIL', 'WEBHOOK'] } }),
    }));
  });

  it('resets a failed event for explicit manual replay so its owning consumer can claim it', async () => {
    const event = createOutboxEvent({
      channel: 'SOCKET',
      status: 'FAILED',
      attemptCount: 5,
      payload: JSON.stringify({
        room: 'rfqs',
        event: 'rfq:updated',
        data: { rfqId: 'rfq-1' },
        scope: { capability: 'rfq.read', ownerId: 'user-1' },
      }),
    });
    prismaMock.outboxEvent.findUnique
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce({ ...event, status: 'PENDING', attemptCount: 0 });
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    await expect(retryOutboxEvent(event.id)).resolves.toMatchObject({
      id: event.id,
      status: 'PENDING',
    });
    expect(prismaMock.__tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: { in: ['FAILED', 'RETRYING'] },
      },
      data: expect.objectContaining({
        status: 'PENDING',
        attemptCount: 0,
        lockedAt: null,
        workerId: null,
      }),
    });
  });

  it('marks a linked pending or previously failed outbound email failed when an email event is cancelled manually', async () => {
    const event = createOutboxEvent({
      channel: 'EMAIL',
      status: 'PENDING',
      eventType: 'quotation.email.send',
      payload: JSON.stringify({ outboundEmailId: 'mail-manual-cancel' }),
    });
    prismaMock.__tx.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.__tx.outboundEmail.updateMany.mockResolvedValue({ count: 1 });

    await expect(cancelOutboxEvent(event.id, '报价已修订')).resolves.toBeUndefined();

    expect(prismaMock.__tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        status: { in: ['PENDING', 'RETRYING', 'FAILED'] },
      },
      data: expect.objectContaining({
        status: 'CANCELLED',
        lastError: '报价已修订',
        lockedAt: null,
        workerId: null,
      }),
    });
    expect(prismaMock.__tx.outboundEmail.updateMany).toHaveBeenCalledWith({
      where: { id: 'mail-manual-cancel', status: { notIn: ['SENT', 'WITHDRAWN'] } },
      data: { status: 'FAILED', errorMessage: '报价已修订' },
    });
  });

  it('rejects manual cancellation after a worker has claimed the event and leaves the linked email unchanged', async () => {
    const event = createOutboxEvent({
      channel: 'EMAIL',
      status: 'PROCESSING',
      eventType: 'quotation.email.send',
      payload: JSON.stringify({ outboundEmailId: 'mail-processing' }),
    });
    prismaMock.__tx.outboxEvent.findUnique.mockResolvedValue(event);
    prismaMock.__tx.outboxEvent.updateMany.mockResolvedValue({ count: 0 });

    await expect(cancelOutboxEvent(event.id, '手工取消')).rejects.toMatchObject({
      statusCode: 409,
      code: 'STATE_CONFLICT',
    });

    expect(prismaMock.__tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: event.id, status: { in: ['PENDING', 'RETRYING', 'FAILED'] } },
      data: expect.objectContaining({ status: 'CANCELLED' }),
    });
    expect(prismaMock.__tx.outboundEmail.updateMany).not.toHaveBeenCalled();
  });
});
