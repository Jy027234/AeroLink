import crypto from 'node:crypto';
import type { EmailAccount, EmailSyncCursor, Prisma } from '@prisma/client';
import { decrypt } from './crypto.js';
import {
  autoClassifyEmail,
  fetchMailboxMessages,
  type EmailAccountConfig,
  type SyncedEmail,
} from './emailService.js';
import { logger } from './logger.js';
import prisma from './prisma.js';

const DEFAULT_MAILBOX = 'INBOX';
const CURSOR_LEASE_TIMEOUT_MS = 2 * 60 * 1000;
const CURSOR_HEARTBEAT_MS = 30 * 1000;
const MAX_RETRY_COUNT = 5;

export interface InboundEmailSyncResult {
  claimed: boolean;
  accountId: string;
  mailbox: string;
  fetchedCount: number;
  savedCount: number;
  lastUid: number;
  uidValidity: string | null;
  cursorReset: boolean;
  lastSyncAt: Date | null;
}

function toAccountConfig(account: EmailAccount): EmailAccountConfig {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    imapServer: account.imapServer,
    imapPort: account.imapPort,
    smtpServer: account.smtpServer,
    smtpPort: account.smtpPort,
    authCode: decrypt(account.authCode),
    accountType: account.accountType,
  };
}

function retryDelayMs(retryCount: number) {
  return Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, retryCount - 1)));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

async function persistMessage(
  tx: Prisma.TransactionClient,
  accountId: string,
  message: SyncedEmail,
) {
  const existingByMessageId = message.messageId
    ? await tx.email.findUnique({
      where: {
        emailAccountMessageId: {
          accountId,
          messageId: message.messageId,
        },
      },
      select: { id: true },
    })
    : null;

  if (existingByMessageId) return false;

  const existingByUid = await tx.email.findUnique({
    where: {
      emailAccountMailboxUid: {
        accountId,
        mailbox: message.mailbox,
        imapUidValidity: message.uidValidity,
        imapUid: message.uid,
      },
    },
    select: { id: true },
  });

  if (existingByUid) return false;

  await tx.email.create({
    data: {
      accountId,
      messageId: message.messageId,
      mailbox: message.mailbox,
      imapUid: message.uid,
      imapUidValidity: message.uidValidity,
      from: message.from,
      fromName: message.fromName,
      subject: message.subject,
      body: message.body,
      type: await autoClassifyEmail(message.subject, message.body),
      isRead: false,
      attachments: message.attachments.join(','),
      rawHeaders: message.rawHeaders,
      receivedAt: message.receivedAt,
      processingStatus: 'PENDING',
    },
  });

  return true;
}

async function ensureCursor(accountId: string, mailbox: string) {
  return prisma.emailSyncCursor.upsert({
    where: { accountId_mailbox: { accountId, mailbox } },
    update: {},
    create: { accountId, mailbox },
  });
}

function claimFilter(cursor: EmailSyncCursor, force: boolean, now: Date) {
  const staleBefore = new Date(now.getTime() - CURSOR_LEASE_TIMEOUT_MS);
  if (force) {
    return {
      id: cursor.id,
      OR: [
        { status: { not: 'SYNCING' } },
        { status: 'SYNCING', lockedAt: { lt: staleBefore } },
      ],
    } satisfies Prisma.EmailSyncCursorWhereInput;
  }

  return {
    id: cursor.id,
    OR: [
      {
        status: { in: ['IDLE', 'RETRYING'] },
        nextSyncAt: { lte: now },
      },
      { status: 'SYNCING', lockedAt: { lt: staleBefore } },
    ],
  } satisfies Prisma.EmailSyncCursorWhereInput;
}

export async function syncEmailAccount(
  accountId: string,
  options: {
    workerId?: string;
    mailbox?: string;
    batchSize?: number;
    force?: boolean;
  } = {},
): Promise<InboundEmailSyncResult> {
  const mailbox = options.mailbox?.trim() || DEFAULT_MAILBOX;
  const workerId = options.workerId?.trim() || `email-sync-${crypto.randomUUID()}`;
  const batchSize = Math.min(100, Math.max(1, options.batchSize ?? 50));
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });

  if (!account) throw new Error('邮箱账户不存在');
  if (!account.isActive) throw new Error('邮箱账户已停用');

  const initialCursor = await ensureCursor(accountId, mailbox);
  const now = new Date();
  const claim = await prisma.emailSyncCursor.updateMany({
    where: claimFilter(initialCursor, options.force === true, now),
    data: {
      status: 'SYNCING',
      lockedAt: now,
      workerId,
      lastAttemptAt: now,
      lastError: null,
    },
  });

  if (claim.count !== 1) {
    return {
      claimed: false,
      accountId,
      mailbox,
      fetchedCount: 0,
      savedCount: 0,
      lastUid: initialCursor.lastUid,
      uidValidity: initialCursor.uidValidity,
      cursorReset: false,
      lastSyncAt: account.lastSyncAt,
    };
  }

  const cursor = await prisma.emailSyncCursor.findUniqueOrThrow({ where: { id: initialCursor.id } });
  const heartbeat = setInterval(() => {
    void prisma.emailSyncCursor.updateMany({
      where: { id: cursor.id, status: 'SYNCING', workerId },
      data: { lockedAt: new Date() },
    }).catch((error) => {
      logger.warn({ error, accountId, mailbox, workerId }, 'Inbound email cursor heartbeat failed');
    });
  }, CURSOR_HEARTBEAT_MS);

  try {
    const fetched = await fetchMailboxMessages(toAccountConfig(account), {
      mailbox,
      afterUid: cursor.lastUid,
      expectedUidValidity: cursor.uidValidity,
      limit: batchSize,
    });
    const completedAt = new Date();
    const nextSyncAt = fetched.emails.length >= batchSize
      ? completedAt
      : new Date(completedAt.getTime() + Math.max(1, account.syncInterval) * 60_000);
    let savedCount = 0;

    await prisma.$transaction(async (tx) => {
      for (const message of fetched.emails) {
        if (await persistMessage(tx, accountId, message)) savedCount += 1;
      }

      const released = await tx.emailSyncCursor.updateMany({
        where: { id: cursor.id, status: 'SYNCING', workerId },
        data: {
          uidValidity: fetched.uidValidity,
          lastUid: fetched.highestUid,
          status: 'IDLE',
          retryCount: 0,
          nextSyncAt,
          lastSuccessAt: completedAt,
          lastError: null,
          lockedAt: null,
          workerId: null,
        },
      });

      if (released.count !== 1) {
        throw new Error('邮箱同步租约已丢失，拒绝推进游标');
      }

      await tx.emailAccount.update({
        where: { id: accountId },
        data: { lastSyncAt: completedAt },
      });
    });

    logger.info({
      accountId,
      mailbox,
      fetchedCount: fetched.emails.length,
      savedCount,
      lastUid: fetched.highestUid,
      cursorReset: fetched.cursorReset,
    }, 'Inbound email sync completed');

    return {
      claimed: true,
      accountId,
      mailbox,
      fetchedCount: fetched.emails.length,
      savedCount,
      lastUid: fetched.highestUid,
      uidValidity: fetched.uidValidity,
      cursorReset: fetched.cursorReset,
      lastSyncAt: completedAt,
    };
  } catch (error) {
    const retryCount = cursor.retryCount + 1;
    const retryExhausted = retryCount >= MAX_RETRY_COUNT;
    await prisma.emailSyncCursor.updateMany({
      where: { id: cursor.id, status: 'SYNCING', workerId },
      data: {
        status: retryExhausted ? 'FAILED' : 'RETRYING',
        retryCount,
        nextSyncAt: retryExhausted ? null : new Date(Date.now() + retryDelayMs(retryCount)),
        lastError: errorMessage(error),
        lockedAt: null,
        workerId: null,
      },
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function processDueEmailSyncs(limit = 10, workerId = `email-worker-${crypto.randomUUID()}`) {
  const now = new Date();
  const accounts = await prisma.emailAccount.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  for (const account of accounts) {
    await ensureCursor(account.id, DEFAULT_MAILBOX);
  }

  const staleBefore = new Date(now.getTime() - CURSOR_LEASE_TIMEOUT_MS);
  const candidates = await prisma.emailSyncCursor.findMany({
    where: {
      account: { isActive: true },
      OR: [
        {
          status: { in: ['IDLE', 'RETRYING'] },
          nextSyncAt: { lte: now },
        },
        { status: 'SYNCING', lockedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { nextSyncAt: 'asc' },
    take: Math.min(50, Math.max(1, limit)),
    select: { accountId: true, mailbox: true },
  });

  let succeeded = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await syncEmailAccount(candidate.accountId, {
        workerId,
        mailbox: candidate.mailbox,
      });
      if (result.claimed) succeeded += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ error, accountId: candidate.accountId, mailbox: candidate.mailbox }, 'Inbound email sync attempt failed');
    }
  }

  return { processed: candidates.length, succeeded, failed };
}
