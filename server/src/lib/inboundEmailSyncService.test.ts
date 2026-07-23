import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    email: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    emailSyncCursor: {
      updateMany: vi.fn(),
    },
    emailAccount: {
      update: vi.fn(),
    },
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
  };
});

vi.mock('./prisma.js', () => ({ default: mocks.prisma }));
vi.mock('./crypto.js', () => ({ decrypt: vi.fn((value: string) => value) }));
vi.mock('./emailService.js', () => ({
  fetchMailboxMessages: mocks.fetchMailboxMessages,
  autoClassifyEmail: mocks.autoClassifyEmail,
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

describe('inbound email sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.emailAccount.findUnique.mockResolvedValue(account);
    mocks.prisma.emailSyncCursor.upsert.mockResolvedValue(cursor);
    mocks.prisma.emailSyncCursor.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.emailSyncCursor.findUniqueOrThrow.mockResolvedValue({ ...cursor, status: 'SYNCING' });
    mocks.tx.email.findUnique.mockResolvedValue(null);
    mocks.tx.email.create.mockResolvedValue({ id: 'email-1' });
    mocks.tx.emailSyncCursor.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.emailAccount.update.mockResolvedValue(account);
  });

  it('persists provider identity and advances the cursor in the same transaction', async () => {
    mocks.fetchMailboxMessages.mockResolvedValue({
      uidValidity: '10',
      highestUid: 41,
      cursorReset: false,
      emails: [{
        uid: 41,
        uidValidity: '10',
        mailbox: 'INBOX',
        messageId: '<message-41@example.com>',
        from: 'buyer@example.com',
        fromName: 'Buyer',
        subject: 'RFQ PN ABC-123',
        body: 'Qty: 2',
        receivedAt: new Date('2026-07-22T01:00:00.000Z'),
        attachments: ['request.pdf'],
        rawHeaders: 'Message-ID: <message-41@example.com>',
      }],
    });

    const { syncEmailAccount } = await import('./inboundEmailSyncService.js');
    const result = await syncEmailAccount(account.id, { workerId: 'worker-1', force: true });

    expect(result).toMatchObject({ claimed: true, fetchedCount: 1, savedCount: 1, lastUid: 41 });
    expect(mocks.tx.email.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: account.id,
        messageId: '<message-41@example.com>',
        imapUid: 41,
        imapUidValidity: '10',
        processingStatus: 'PENDING',
      }),
    });
    expect(mocks.tx.emailSyncCursor.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: cursor.id, status: 'SYNCING', workerId: 'worker-1' },
      data: expect.objectContaining({ lastUid: 41, uidValidity: '10', status: 'IDLE' }),
    }));
  });

  it('does not duplicate a replayed Message-ID but still advances the cursor', async () => {
    mocks.tx.email.findUnique.mockResolvedValueOnce({ id: 'existing-email' });
    mocks.fetchMailboxMessages.mockResolvedValue({
      uidValidity: '11',
      highestUid: 1,
      cursorReset: true,
      emails: [{
        uid: 1,
        uidValidity: '11',
        mailbox: 'INBOX',
        messageId: '<same-message@example.com>',
        from: 'buyer@example.com',
        fromName: 'Buyer',
        subject: 'Repeated RFQ',
        body: 'Qty: 1',
        receivedAt: new Date('2026-07-22T01:00:00.000Z'),
        attachments: [],
        rawHeaders: 'Message-ID: <same-message@example.com>',
      }],
    });

    const { syncEmailAccount } = await import('./inboundEmailSyncService.js');
    const result = await syncEmailAccount(account.id, { workerId: 'worker-2', force: true });

    expect(result.savedCount).toBe(0);
    expect(result.cursorReset).toBe(true);
    expect(mocks.tx.email.create).not.toHaveBeenCalled();
    expect(mocks.tx.emailSyncCursor.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastUid: 1, uidValidity: '11' }),
    }));
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
