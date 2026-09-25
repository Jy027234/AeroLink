import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SyncedEmail, SyncedEmailAttachment } from './emailService.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    email: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    storedObject: { create: vi.fn() },
    emailAttachment: { create: vi.fn() },
    inquiryEmailLink: { create: vi.fn() },
    outboundEmail: { findMany: vi.fn() },
    emailSyncCursor: { updateMany: vi.fn() },
    emailAccount: { update: vi.fn() },
  };
  const prisma = {
    emailAccount: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    emailSyncCursor: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return {
    prisma,
    tx,
    fetchMailboxMessages: vi.fn(),
    autoClassifyEmail: vi.fn(async () => 'INQUIRY'),
    putFile: vi.fn(),
    deleteObject: vi.fn(),
    objectContents: new Map<string, Buffer>(),
    nextEmailId: 1,
    nextStoredObjectId: 1,
  };
});

vi.mock('./prisma.js', () => ({ default: mocks.prisma }));
vi.mock('./crypto.js', () => ({ decrypt: vi.fn((value: string) => value) }));
vi.mock('./emailService.js', () => ({
  fetchMailboxMessages: mocks.fetchMailboxMessages,
  autoClassifyEmail: mocks.autoClassifyEmail,
}));
vi.mock('./objectStorage.js', () => ({
  objectStorage: { putFile: mocks.putFile, delete: mocks.deleteObject },
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const account = {
  id: 'account-1',
  email: 'ops@example.com',
  displayName: 'Operations',
  imapServer: 'imap.example.com',
  imapPort: '993',
  smtpServer: 'smtp.example.com',
  smtpPort: '465',
  authCode: 'encrypted-secret',
  isActive: true,
  isDefault: true,
  accountType: 'custom',
  lastSyncAt: null,
  syncInterval: 5,
  createdAt: new Date('2026-07-22T00:00:00.000Z'),
  updatedAt: new Date('2026-07-22T00:00:00.000Z'),
};

const cursor = {
  id: 'cursor-1',
  accountId: account.id,
  mailbox: 'INBOX',
  uidValidity: '10',
  lastUid: 40,
  status: 'IDLE',
  retryCount: 0,
  nextSyncAt: new Date('2026-07-22T00:00:00.000Z'),
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  lockedAt: null,
  workerId: null,
  createdAt: new Date('2026-07-22T00:00:00.000Z'),
  updatedAt: new Date('2026-07-22T00:00:00.000Z'),
};

function makeMessage(overrides: Partial<SyncedEmail> = {}): SyncedEmail {
  return {
    uid: 41,
    uidValidity: '10',
    mailbox: 'INBOX',
    messageId: '<message-41@example.com>',
    inReplyTo: null,
    references: [],
    from: 'buyer@example.com',
    fromName: 'Buyer',
    subject: 'RFQ PN ABC-123',
    body: 'Qty: 2',
    receivedAt: new Date('2026-07-22T01:00:00.000Z'),
    attachments: [],
    rawHeaders: 'Message-ID: <message-41@example.com>',
    ...overrides,
  };
}

function makeAttachment(
  filename: string,
  content: Buffer,
  contentType = 'application/pdf',
  contentId: string | null = null,
): SyncedEmailAttachment {
  return { filename, content, contentType, contentId };
}

function configureFetchedMessages(emails: SyncedEmail[]) {
  mocks.fetchMailboxMessages.mockResolvedValue({
    uidValidity: emails[0]?.uidValidity ?? '10',
    highestUid: emails.reduce((highest, message) => Math.max(highest, message.uid), cursor.lastUid),
    cursorReset: false,
    emails,
  });
}

async function runSync(emails: SyncedEmail[], workerId = 'worker-1') {
  configureFetchedMessages(emails);
  const { syncEmailAccount } = await import('./inboundEmailSyncService.js');
  return syncEmailAccount(account.id, { workerId, force: true });
}

describe('inbound email sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.objectContents.clear();
    mocks.nextEmailId = 1;
    mocks.nextStoredObjectId = 1;
    mocks.prisma.emailAccount.findUnique.mockResolvedValue(account);
    mocks.prisma.emailSyncCursor.upsert.mockResolvedValue(cursor);
    mocks.prisma.emailSyncCursor.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.emailSyncCursor.findUniqueOrThrow.mockResolvedValue({ ...cursor, status: 'SYNCING' });
    mocks.tx.email.findUnique.mockResolvedValue(null);
    mocks.tx.email.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `email-${mocks.nextEmailId++}`,
      ...data,
    }));
    mocks.tx.email.update.mockResolvedValue({ id: 'email-1' });
    mocks.tx.storedObject.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `stored-${mocks.nextStoredObjectId++}`,
      ...data,
    }));
    mocks.tx.emailAttachment.create.mockResolvedValue({ id: 'attachment-1' });
    mocks.tx.inquiryEmailLink.create.mockResolvedValue({ id: 'link-1' });
    mocks.tx.outboundEmail.findMany.mockResolvedValue([]);
    mocks.tx.emailSyncCursor.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.emailAccount.update.mockResolvedValue(account);
    mocks.putFile.mockImplementation(async (input: {
      sourcePath: string;
      objectKey: string;
      mimeType: string;
      originalName?: string;
      domain?: string;
      resourceId?: string;
    }) => {
      const content = await readFile(input.sourcePath);
      const sha256 = createHash('sha256').update(content).digest('hex');
      mocks.objectContents.set(input.objectKey, Buffer.from(content));
      return {
        objectKey: input.objectKey,
        version: 1,
        sha256,
        sizeBytes: content.byteLength,
        mimeType: input.mimeType,
        originalName: input.originalName,
        domain: input.domain,
        resourceId: input.resourceId,
      };
    });
    mocks.deleteObject.mockImplementation(async (objectKey: string) => {
      mocks.objectContents.delete(objectKey);
    });
  });

  it('persists normalized provider identity and advances the cursor in the same transaction', async () => {
    const result = await runSync([makeMessage({
      messageId: ' <message-41@example.com> ',
      inReplyTo: ' <outbound-40@example.com> ',
      references: [' <root@example.com> ', '<outbound-40@example.com>'],
    })]);

    expect(result).toMatchObject({ claimed: true, fetchedCount: 1, savedCount: 1, lastUid: 41 });
    expect(mocks.tx.email.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: account.id,
        messageId: 'message-41@example.com',
        inReplyTo: 'outbound-40@example.com',
        references: '["root@example.com","outbound-40@example.com"]',
        imapUid: 41,
        imapUidValidity: '10',
        processingStatus: 'PENDING',
        attachmentStatus: 'NONE',
      }),
    });
    expect(mocks.tx.email.update).toHaveBeenCalledWith({
      where: { id: 'email-1' },
      data: { threadMatchStatus: 'UNMATCHED', threadMatchReason: 'NO_OUTBOUND_MESSAGE_ID_MATCH' },
    });
    expect(mocks.tx.emailSyncCursor.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: cursor.id, status: 'SYNCING', workerId: 'worker-1' },
      data: expect.objectContaining({ lastUid: 41, uidValidity: '10', status: 'IDLE' }),
    }));
  });

  it('does not duplicate a replayed Message-ID but still advances the cursor', async () => {
    mocks.tx.email.findUnique.mockResolvedValueOnce({ id: 'existing-email' });
    const result = await runSync([makeMessage({ messageId: '<same-message@example.com>' })], 'worker-2');

    expect(result.savedCount).toBe(0);
    expect(mocks.tx.email.create).not.toHaveBeenCalled();
    expect(mocks.putFile).not.toHaveBeenCalled();
    expect(mocks.tx.emailSyncCursor.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastUid: 41, uidValidity: '10' }),
    }));
  });

  it('auto-links a unique message-id match only when the sender is the inquiry supplier', async () => {
    mocks.tx.outboundEmail.findMany.mockResolvedValue([{
      id: 'outbound-1',
      providerMessageId: '<outbound-1@example.com>',
      inquiry: { id: 'inquiry-1', supplier: { email: 'SUPPLIER@example.com' } },
    }]);
    await runSync([makeMessage({
      from: 'supplier@example.com',
      inReplyTo: ' <outbound-1@example.com> ',
      references: [],
    })]);

    expect(mocks.tx.inquiryEmailLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        emailId: 'email-1',
        inquiryId: 'inquiry-1',
        method: 'AUTO_MESSAGE_ID',
        confirmationStatus: 'CONFIRMED',
        confirmedById: null,
      }),
    });
    expect(mocks.tx.email.update).toHaveBeenCalledWith({
      where: { id: 'email-1' },
      data: { threadMatchStatus: 'MATCHED', threadMatchReason: 'MESSAGE_ID_AND_SUPPLIER_EMAIL_MATCH' },
    });
  });

  it('leaves an ordinary email unmatched and pending when it has no reply headers', async () => {
    await runSync([makeMessage({ inReplyTo: null, references: [] })]);

    expect(mocks.tx.outboundEmail.findMany).not.toHaveBeenCalled();
    expect(mocks.tx.inquiryEmailLink.create).not.toHaveBeenCalled();
    expect(mocks.tx.email.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ processingStatus: 'PENDING', threadMatchStatus: 'PENDING' }),
    });
    expect(mocks.tx.email.update).toHaveBeenCalledWith({
      where: { id: 'email-1' },
      data: { threadMatchStatus: 'UNMATCHED', threadMatchReason: 'NO_REPLY_MESSAGE_ID' },
    });
  });

  it('marks a sender mismatch for review without creating an automatic inquiry link', async () => {
    mocks.tx.outboundEmail.findMany.mockResolvedValue([{
      id: 'outbound-1',
      providerMessageId: 'outbound-1@example.com',
      inquiry: { id: 'inquiry-1', supplier: { email: 'supplier@example.com' } },
    }]);
    await runSync([makeMessage({ from: 'forwarder@example.com', inReplyTo: '<outbound-1@example.com>' })]);

    expect(mocks.tx.inquiryEmailLink.create).not.toHaveBeenCalled();
    expect(mocks.tx.email.update).toHaveBeenCalledWith({
      where: { id: 'email-1' },
      data: { threadMatchStatus: 'NEEDS_REVIEW', threadMatchReason: 'SUPPLIER_EMAIL_MISMATCH' },
    });
  });

  it('marks multiple outbound message-id candidates for review', async () => {
    mocks.tx.outboundEmail.findMany.mockResolvedValue([
      { id: 'outbound-1', providerMessageId: '<first@example.com>', inquiry: { id: 'inquiry-1', supplier: { email: 'buyer@example.com' } } },
      { id: 'outbound-2', providerMessageId: '<second@example.com>', inquiry: { id: 'inquiry-2', supplier: { email: 'buyer@example.com' } } },
    ]);
    await runSync([makeMessage({
      inReplyTo: '<first@example.com>',
      references: ['<second@example.com>'],
    })]);

    expect(mocks.tx.inquiryEmailLink.create).not.toHaveBeenCalled();
    expect(mocks.tx.email.update).toHaveBeenCalledWith({
      where: { id: 'email-1' },
      data: { threadMatchStatus: 'NEEDS_REVIEW', threadMatchReason: 'AMBIGUOUS_OUTBOUND_MESSAGE_ID_MATCH' },
    });
  });

  it('stores original attachment bytes once and reuses object metadata on duplicate sync', async () => {
    const originalBytes = Buffer.from([0, 1, 2, 3, 0xff, 0x00]);
    const email = makeMessage({
      attachments: [
        makeAttachment('quote.pdf', originalBytes, 'application/pdf', 'part-1@example.com'),
        makeAttachment('quote-copy.pdf', originalBytes, 'application/pdf', 'part-2@example.com'),
      ],
    });
    await runSync([email]);

    expect(mocks.putFile).toHaveBeenCalledTimes(1);
    const [putInput] = mocks.putFile.mock.calls[0];
    expect(putInput).toMatchObject({ domain: 'email', resourceId: 'email-1', mimeType: 'application/pdf' });
    expect(mocks.objectContents.get(putInput.objectKey)).toEqual(originalBytes);
    expect(mocks.tx.storedObject.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.emailAttachment.create).toHaveBeenCalledTimes(2);
    expect(mocks.tx.emailAttachment.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ filename: 'quote.pdf', sizeBytes: originalBytes.byteLength, contentId: 'part-1@example.com' }),
    });
    expect(mocks.tx.emailAttachment.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ storedObjectId: 'stored-1', filename: 'quote-copy.pdf', contentId: 'part-2@example.com' }),
    });

    mocks.tx.email.findUnique.mockResolvedValueOnce({ id: 'email-1' });
    const duplicateResult = await runSync([email], 'worker-2');
    expect(duplicateResult.savedCount).toBe(0);
    expect(mocks.putFile).toHaveBeenCalledTimes(1);
    expect(mocks.tx.emailAttachment.create).toHaveBeenCalledTimes(2);
    expect(mocks.objectContents.size).toBe(1);
  });

  it('archives unsafe and over-size attachments without blocking later messages or the cursor', async () => {
    const { MAX_INBOUND_ATTACHMENT_BYTES } = await import('./inboundEmailSyncService.js');
    const oversize = makeMessage({
      uid: 41,
      attachments: [makeAttachment('oversize.pdf', Buffer.alloc(MAX_INBOUND_ATTACHMENT_BYTES + 1))],
    });
    const dangerous = makeMessage({
      uid: 42,
      messageId: '<message-42@example.com>',
      attachments: [makeAttachment('setup.exe', Buffer.from('executable'), 'application/octet-stream')],
    });
    const nextMessage = makeMessage({ uid: 43, messageId: '<message-43@example.com>', attachments: [] });
    const result = await runSync([oversize, dangerous, nextMessage]);

    expect(result).toMatchObject({ savedCount: 3, lastUid: 43 });
    const createCalls = mocks.tx.email.create.mock.calls;
    expect(createCalls[0][0].data).toMatchObject({ attachmentStatus: 'REJECTED', attachmentError: expect.stringContaining('PER_FILE_SIZE_LIMIT') });
    expect(createCalls[1][0].data).toMatchObject({ attachmentStatus: 'REJECTED', attachmentError: expect.stringContaining('DANGEROUS_TYPE') });
    expect(createCalls[2][0].data).toMatchObject({ attachmentStatus: 'NONE', attachmentError: null });
    expect(mocks.tx.storedObject.create).not.toHaveBeenCalled();
    expect(mocks.tx.emailAttachment.create).not.toHaveBeenCalled();
    expect(mocks.putFile).not.toHaveBeenCalled();
    expect(mocks.tx.emailSyncCursor.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastUid: 43, status: 'IDLE' }),
    }));
  });

  it('rejects the attachment set when its total size exceeds the cap', async () => {
    const { MAX_INBOUND_ATTACHMENT_BYTES } = await import('./inboundEmailSyncService.js');
    const maxSized = Buffer.alloc(MAX_INBOUND_ATTACHMENT_BYTES);
    await runSync([makeMessage({
      attachments: [
        makeAttachment('one.pdf', maxSized),
        makeAttachment('two.pdf', maxSized),
        makeAttachment('three.pdf', Buffer.from([1])),
      ],
    })]);

    expect(mocks.tx.email.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attachmentStatus: 'REJECTED',
        attachmentError: expect.stringContaining('TOTAL_SIZE_LIMIT'),
      }),
    });
    expect(mocks.putFile).not.toHaveBeenCalled();
    expect(mocks.tx.storedObject.create).not.toHaveBeenCalled();
  });

  it('deletes stored objects when the database transaction fails after upload', async () => {
    mocks.tx.storedObject.create.mockRejectedValue(new Error('StoredObject insert failed'));
    await expect(runSync([makeMessage({
      attachments: [makeAttachment('quote.pdf', Buffer.from('original quote'))],
    })])).rejects.toThrow('StoredObject insert failed');

    expect(mocks.putFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteObject).toHaveBeenCalledWith(mocks.putFile.mock.calls[0][0].objectKey);
    expect(mocks.objectContents.size).toBe(0);
    expect(mocks.tx.emailAttachment.create).not.toHaveBeenCalled();
  });

  it('keeps the old cursor and schedules a retry when provider fetch fails', async () => {
    mocks.fetchMailboxMessages.mockRejectedValue(new Error('IMAP unavailable'));
    const { syncEmailAccount } = await import('./inboundEmailSyncService.js');
    await expect(syncEmailAccount(account.id, { workerId: 'worker-3', force: true }))
      .rejects.toThrow('IMAP unavailable');

    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.emailSyncCursor.updateMany).toHaveBeenLastCalledWith({
      where: { id: cursor.id, status: 'SYNCING', workerId: 'worker-3' },
      data: expect.objectContaining({
        status: 'RETRYING',
        retryCount: 1,
        lastError: 'IMAP unavailable',
        lockedAt: null,
        workerId: null,
      }),
    });
  });
});
