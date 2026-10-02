/** Real loopback SMTP/MIME/IMAP and PostgreSQL acceptance for the 2026-10-02 batch.
 * Never loads dotenv. Fixtures are retained in the caller's disposable database.
 * Run only against the exact guarded database and GreenMail ports below.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createTransport } from 'nodemailer';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function main() {
  const database = new URL(process.env.DATABASE_URL || 'http://missing.invalid');
  assert(['postgres:', 'postgresql:'].includes(database.protocol)
    && database.hostname === '127.0.0.1' && database.port === '55435'
    && database.pathname === '/sourcing_next_batch_20261002'
    && process.env.SOURCING_MAIL_BATCH_CONFIRM === 'isolated',
  'Refusing anything except the explicitly authorized disposable loopback database');
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'mail-batch-isolated-access-only';
  process.env.JWT_REFRESH_SECRET = 'mail-batch-isolated-refresh-only';
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.EMAIL_MESSAGE_ID_DOMAIN = 'mailbatch.test';
  process.env.OBJECT_STORAGE_DRIVER = 'local';
  const workDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../../../work/sourcing-mail-next-batch-20261002');
  process.env.UPLOADS_DIR = path.join(workDirectory, 'objects');
  process.env.UPLOAD_STAGING_DIR = path.join(workDirectory, 'staging');

  const [
    { default: prisma }, { encrypt }, { authenticate, generateTokens }, { errorHandler },
    { default: inquiries }, { default: drafts }, { default: rfqs },
    { default: quotes }, { default: tasks }, { default: files },
    { processOutboxEvent, OutboxChannel }, { fetchMailboxMessages }, { syncEmailAccount },
  ] = await Promise.all([
    import('../lib/prisma.js'), import('../lib/crypto.js'), import('../middleware/auth.js'),
    import('../middleware/errorHandler.js'), import('../routes/inquiries.js'),
    import('../routes/supplierQuoteDrafts.js'), import('../routes/rfqs.js'),
    import('../routes/supplierQuotes.js'), import('../routes/sourcingActionTasks.js'),
    import('../routes/files.js'), import('../lib/outboxService.js'),
    import('../lib/emailService.js'), import('../lib/inboundEmailSyncService.js'),
  ]);
  let server: http.Server | undefined;
  try {
    assert(await prisma.user.count() === 0 && await prisma.rFQ.count() === 0,
      'Fixture database must be empty; do not reuse an acceptance run');
    const actor = await prisma.user.create({ data: {
      email: 'manager@mailbatch.test', name: 'Isolated acceptance manager',
      password: 'not-a-login-password', role: 'MANAGER', department: 'Sales',
    } });
    const customer = await prisma.customer.create({ data: {
      name: 'Isolated customer', contactName: 'Fixture', email: 'customer@mailbatch.test',
    } });
    const supplier = await prisma.supplier.create({ data: {
      name: 'Isolated supplier', email: 'supplier@mailbatch.test',
    } });
    const requiredDate = new Date('2030-12-01T00:00:00.000Z');
    const rfq = await prisma.rFQ.create({ data: {
      rfqNumber: 'RFQ-MAIL-BATCH-20261002', customerId: customer.id, createdBy: actor.id,
      partNumber: 'MAIL-BATCH-001', quantity: 2, requiredDate, lineItemsMode: true,
      lines: { create: [1, 2].map((lineNo) => ({
        lineNo, partNumber: `MAIL-BATCH-00${lineNo}`, quantity: 2, requiredDate,
        certificateRequired: false,
      })) },
    }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    const account = await prisma.emailAccount.create({ data: {
      email: 'buyer@mailbatch.test', displayName: 'Isolated buyer', accountType: 'custom',
      smtpServer: '127.0.0.1', smtpPort: '33025', imapServer: '127.0.0.1', imapPort: '33143',
      authCode: encrypt('fixture-only'), isDefault: true, isActive: true,
    } });
    const token = generateTokens(actor).accessToken;
    const app = express();
    app.use(express.json());
    app.use(authenticate);
    app.use('/api/inquiries', inquiries);
    app.use('/api/supplier-quote-drafts', drafts);
    app.use('/api/rfqs', rfqs);
    app.use('/api/supplier-quotes', quotes);
    app.use('/api/sourcing-action-tasks', tasks);
    app.use('/api/files', files);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string', 'Missing loopback HTTP address');
    const base = `http://127.0.0.1:${address.port}`;
    const request = async (method: string, route: string, body?: unknown, expected = 200) => {
      const response = await fetch(base + route, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      assert(response.status === expected,
        `${method} ${route}: expected ${expected}, got ${response.status} ${JSON.stringify(result)}`);
      return result.data;
    };
    const createInquiry = async () => {
      const rows = await request('POST', '/api/inquiries', {
        rfqId: rfq.id, supplierIds: [supplier.id], lineIds: rfq.lines.map((line) => line.id),
      }, 201);
      return String(rows[0].id);
    };
    const inquiryId = await createInquiry();
    const bytes = Buffer.from('PartNumber,Quantity\r\nMAIL-BATCH-001,2\r\nMAIL-BATCH-002,2\r\n');
    const upload = async (targetId: string) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'text/csv' }), 'inquiry-parts.csv');
      const response = await fetch(`${base}/api/inquiries/${targetId}/attachments`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      });
      const result = await response.json();
      assert(response.status === 201, `Upload failed: ${JSON.stringify(result)}`);
      return result.data.attachment;
    };
    const attachment = await upload(inquiryId);
    assert(attachment.sha256 === crypto.createHash('sha256').update(bytes).digest('hex'),
      'Upload digest does not describe the actual file');
    const download = await fetch(base + attachment.downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
    assert(download.status === 200 && Buffer.from(await download.arrayBuffer()).equals(bytes),
      'Authenticated attachment download changed bytes');
    const task = await request('POST', '/api/sourcing-action-tasks', {
      action: 'SEND_INQUIRY', targetId: inquiryId, idempotencyKey: crypto.randomUUID(),
      content: { subject: 'Inquiry MAIL-BATCH with actual CSV',
        textBody: 'Please quote MAIL-BATCH-001 and MAIL-BATCH-002. See attached CSV.', attachmentIds: [attachment.id] },
    }, 201);
    assert(task.contentSnapshot.attachments[0].sha256 === attachment.sha256,
      'Human preview did not freeze attachment metadata');
    const confirmedTask = await request('POST', `/api/sourcing-action-tasks/${task.id}/confirm`, {
      expectedVersion: task.version,
    });
    const outboundId = confirmedTask.outboundEmailId;
    const eventId = confirmedTask.result.outboxEventId;
    assert(await processOutboxEvent(eventId, 'isolated-mail-batch', { channels: [OutboxChannel.EMAIL] }),
      'Worker did not claim the inquiry');
    const outbound = await prisma.outboundEmail.findUniqueOrThrow({ where: { id: outboundId } });
    assert(outbound.status === 'SENT' && outbound.providerMessageId, 'SMTP did not accept the inquiry');
    const mailConfig = (email: string) => ({ ...account, email, authCode: 'fixture-only' });
    const inbox = await fetchMailboxMessages(mailConfig(supplier.email!), { afterUid: 0, limit: 20 });
    assert(inbox.emails.length === 1, 'Supplier received an unexpected message count');
    const received = inbox.emails[0].attachments;
    assert(received.length === 1 && received[0].filename === 'inquiry-parts.csv'
      && received[0].content.equals(bytes), 'Actual MIME attachment is missing or changed');

    const transport = createTransport({ host: '127.0.0.1', port: 33025, secure: false });
    await transport.sendMail({ from: supplier.email!, to: account.email,
      subject: `Re: ${outbound.subject}`, inReplyTo: outbound.providerMessageId,
      references: [outbound.providerMessageId], text:
        'MAIL-BATCH-001: offer quantity 2 EA, USD 845.20 each, NE, 14 days, certificate not required.\n'
        + 'MAIL-BATCH-002: stock 15, RMB 2560 each, NE, 5-10 days.\n',
    });
    transport.close();
    const sync = await syncEmailAccount(account.id, { force: true, workerId: 'isolated-mail-batch', batchSize: 20 });
    assert(sync.savedCount === 1, 'Real IMAP did not import the supplier reply');
    const email = await prisma.email.findFirstOrThrow({ where: { accountId: account.id } });
    const link = await prisma.inquiryEmailLink.findUniqueOrThrow({
      where: { emailId_inquiryId: { emailId: email.id, inquiryId } },
    });
    assert(link.confirmationStatus === 'CONFIRMED' && link.method === 'AUTO_MESSAGE_ID',
      'Supplier reply did not match the frozen inquiry Message-ID');
    const items = await prisma.inquiryItem.findMany({ where: { inquiryId }, orderBy: { lineNo: 'asc' } });
    const payload = { items: [
      { itemKey: 'valid-usd', inquiryItemId: items[0].id, partNumber: items[0].partNumber,
        quantity: 2, quantityUnit: 'EA', unitPrice: 845.2, currency: 'USD', leadTimeDays: 14,
        condition: 'NE', certificate: false, taxIncluded: false, freightIncluded: false,
        incoterm: 'EXW', validUntil: '2030-11-01', evidenceText: email.body.split('\n')[0] },
      { itemKey: 'pending-cny', inquiryItemId: items[1].id, partNumber: items[1].partNumber,
        quantity: null, quantityUnit: null, unitPrice: 2560, currency: 'CNY', leadTimeDays: null,
        leadTimeMinDays: 5, leadTimeMaxDays: 10, condition: 'NE', certificate: null },
    ] };
    const draft = await request('POST', '/api/supplier-quote-drafts', { emailId: email.id, inquiryId, payload }, 201);
    const partial = await request('POST', `/api/supplier-quote-drafts/${draft.id}/confirm`, {
      expectedVersion: draft.version, itemKeys: ['valid-usd'],
    });
    assert(partial.status === 'PARTIALLY_CONFIRMED' && partial.confirmedItemKeys.length === 1,
      'Selecting the valid row did not produce partial confirmation');
    const repeated = await request('POST', `/api/supplier-quote-drafts/${draft.id}/confirm`, {
      expectedVersion: draft.version, itemKeys: ['valid-usd'],
    });
    assert(repeated.reused && await prisma.supplierQuote.count() === 1,
      'Repeated row confirmation created duplicate formal quotes');
    const pendingTimeline = await request('GET', `/api/rfqs/${rfq.id}/sourcing-timeline`);
    assert(pendingTimeline.pendingQuoteRows.length === 1
      && pendingTimeline.pendingQuoteRows[0].itemKey === 'pending-cny'
      && pendingTimeline.pendingQuoteRows[0].currency === 'CNY',
    'Partial confirmation removed or converted the still-pending quote');
    const compare = await request('POST', '/api/supplier-quotes/compare', { rfqLineId: rfq.lines[0].id });
    assert(compare.quotes.length === 1 && compare.quotes[0].unitPrice === 845.2,
      'Valid confirmed row did not enter its own demand-line comparison');
    const mutated = structuredClone(payload);
    mutated.items[0].unitPrice = 1;
    await request('PATCH', `/api/supplier-quote-drafts/${draft.id}`, {
      expectedVersion: partial.version, payload: mutated,
    }, 409);
    await request('POST', '/api/supplier-quote-drafts', { emailId: email.id, inquiryId, payload }, 409);
    await request('POST', `/api/supplier-quote-drafts/${draft.id}/confirm`, {
      expectedVersion: partial.version, itemKeys: ['pending-cny'],
    }, 409);
    const patchedPayload = { items: payload.items.map((item, index) => index === 1
      ? { ...item, certificate: false } : item) };
    const patched = await request('PATCH', `/api/supplier-quote-drafts/${draft.id}`, {
      expectedVersion: partial.version, payload: patchedPayload,
    });
    assert(patched.status === 'PARTIALLY_CONFIRMED' && patched.confirmedItemKeys[0] === 'valid-usd',
      'Pending-row edit lost confirmed row provenance');
    const confirmAudits = await prisma.auditLog.findMany({
      where: { resourceType: 'SUPPLIER_QUOTE_DRAFT', resourceId: draft.id, action: 'CONFIRM' },
    });
    assert(confirmAudits.length === 1 && confirmAudits[0].userId === actor.id,
      'Partial confirmation lacks immutable actor/time audit');

    // Separate direct-send negative path: persisted frozen bytes must fail closed.
    const badInquiryId = await createInquiry();
    const badAttachment = await upload(badInquiryId);
    await request('POST', `/api/inquiries/${badInquiryId}/send`, { attachmentIds: [badAttachment.id] }, 202);
    const badEvent = await prisma.outboxEvent.findFirstOrThrow({
      where: { channel: 'EMAIL', aggregateId: badInquiryId },
    });
    await prisma.storedObject.update({ where: { id: badAttachment.storedObjectId }, data: { sha256: '0'.repeat(64) } });
    await processOutboxEvent(badEvent.id, 'isolated-mail-batch-negative', { channels: [OutboxChannel.EMAIL] });
    const failedOutbound = await prisma.outboundEmail.findFirstOrThrow({ where: { inquiryId: badInquiryId } });
    assert(failedOutbound.status !== 'SENT', 'Unavailable frozen attachment was falsely marked SENT');
    const inboxAfterFailure = await fetchMailboxMessages(mailConfig(supplier.email!), { afterUid: 0, limit: 20 });
    assert(inboxAfterFailure.emails.length === 1, 'Worker sent a text-only substitute for a bad attachment');
    console.log(JSON.stringify({ ok: true, environment: 'isolated-loopback-only',
      postgres: true, authenticatedUploadDownload: true, taskFrozenAttachment: true,
      actualSmtpMimeAttachmentBytes: true, realImapMessageIdMatch: true,
      partialConfirmIdempotency: true, pendingCnyRangePreserved: true,
      confirmedRowImmutable: true, confirmationAudit: true, lineComparison: true,
      attachmentFailureDoesNotSend: true, rfqId: rfq.id, retained: true }, null, 2));
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Acceptance failed'); process.exitCode = 1; });
