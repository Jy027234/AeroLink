import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EmailAccount, EmailSyncCursor, Prisma } from '@prisma/client';
import { decrypt } from './crypto.js';
import {
  autoClassifyEmail,
  fetchMailboxMessages,
  type EmailAccountConfig,
  type SyncedEmailAttachment,
  type SyncedEmail,
} from './emailService.js';
import { logger } from './logger.js';
import { objectStorage } from './objectStorage.js';
import prisma from './prisma.js';

const DEFAULT_MAILBOX = 'INBOX';
const CURSOR_LEASE_TIMEOUT_MS = 2 * 60 * 1000;
const CURSOR_HEARTBEAT_MS = 30 * 1000;
const MAX_RETRY_COUNT = 5;
export const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_INBOUND_ATTACHMENTS_BYTES = 50 * 1024 * 1024;

const DANGEROUS_ATTACHMENT_EXTENSIONS = new Set([
  '.apk', '.app', '.bat', '.bash', '.cmd', '.com', '.cpl', '.dll', '.dmg', '.exe', '.hta',
  '.htm', '.html', '.jar', '.js', '.jse', '.mjs', '.cjs', '.msi', '.msp', '.pif', '.ps1',
  '.psm1', '.scr', '.sh', '.svg', '.vbe', '.vbs', '.wsf', '.wsh', '.xhtml', '.docm', '.xlsm', '.pptm',
]);

const DANGEROUS_ATTACHMENT_CONTENT_TYPES = new Set([
  'application/java-archive',
  'application/javascript',
  'application/vnd.android.package-archive',
  'application/vnd.microsoft.portable-executable',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-msdownload',
  'application/x-sh',
  'application/x-shellscript',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/html',
  'text/javascript',
]);

export function normalizeMessageId(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, '').replace(/^<+/, '').replace(/>+$/, '');
  return normalized || null;
}

function messageReferenceIds(message: SyncedEmail) {
  return [...new Set([
    normalizeMessageId(message.inReplyTo),
    ...message.references.map((reference) => normalizeMessageId(reference)),
  ].filter((value): value is string => Boolean(value)))];
}

function normalizeEmailAddress(value: string | null | undefined) {
  if (!value) return '';
  const address = value.match(/<([^<>]+)>/)?.[1] ?? value;
  return address.trim().replace(/^<|>$/g, '').toLowerCase();
}

type AttachmentIngestionStatus = 'NONE' | 'STORED' | 'PARTIAL' | 'REJECTED';

interface AttachmentIngestionPlan {
  attachments: SyncedEmailAttachment[];
  status: AttachmentIngestionStatus;
  error: string | null;
}

function planAttachmentIngestion(attachments: SyncedEmailAttachment[]): AttachmentIngestionPlan {
  if (attachments.length === 0) {
    return { attachments: [], status: 'NONE', error: null };
  }

  const normalized = attachments.map((attachment) => {
    const filename = attachment.filename || 'unnamed';
    const content = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(attachment.content);
    const contentType = (attachment.contentType || 'application/octet-stream')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    const extension = path.extname(filename.split(/[\\/]/).pop() || '').toLowerCase();
    let rejectionReason: string | null = null;

    if (content.byteLength === 0) rejectionReason = 'EMPTY_FILE';
    else if (content.byteLength > MAX_INBOUND_ATTACHMENT_BYTES) rejectionReason = 'PER_FILE_SIZE_LIMIT';
    else if (DANGEROUS_ATTACHMENT_EXTENSIONS.has(extension)
      || DANGEROUS_ATTACHMENT_CONTENT_TYPES.has(contentType)) rejectionReason = 'DANGEROUS_TYPE';

    return { attachment: { ...attachment, filename, content, contentType }, rejectionReason };
  });
  const totalBytes = normalized.reduce((total, item) => total + item.attachment.content.byteLength, 0);
  const totalLimitExceeded = totalBytes > MAX_INBOUND_ATTACHMENTS_BYTES;
  const acceptedAttachments: SyncedEmailAttachment[] = [];
  const rejected: Array<{ filename: string; reason: string }> = [];

  for (const item of normalized) {
    const reason = item.rejectionReason || (totalLimitExceeded ? 'TOTAL_SIZE_LIMIT' : null);
    if (reason) {
      rejected.push({
        filename: [...item.attachment.filename]
          .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
          .join('')
          .slice(0, 120),
        reason,
      });
    } else {
      acceptedAttachments.push(item.attachment);
    }
  }

  const status = rejected.length === 0
    ? 'STORED'
    : acceptedAttachments.length === 0
      ? 'REJECTED'
      : 'PARTIAL';
  const error = rejected.length > 0
    ? rejected.slice(0, 20).map(({ filename, reason }) => `${filename || 'unnamed'}:${reason}`).join('; ').slice(0, 2_000)
    : null;

  return { attachments: acceptedAttachments, status, error };
}

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
  uploadedObjectKeys: string[],
) {
  const normalizedMessageId = normalizeMessageId(message.messageId);
  if (normalizedMessageId) {
    const messageIdVariants = [...new Set([
      normalizedMessageId,
      message.messageId?.trim(),
      `<${normalizedMessageId}>`,
    ].filter((value): value is string => Boolean(value)))];
    for (const messageId of messageIdVariants) {
      const existingByMessageId = await tx.email.findUnique({
        where: {
          emailAccountMessageId: { accountId, messageId },
        },
        select: { id: true },
      });
      if (existingByMessageId) return false;
    }
  }

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

  const attachmentPlan = planAttachmentIngestion(message.attachments);

  const references = [...new Set(message.references
    .map((reference) => normalizeMessageId(reference))
    .filter((reference): reference is string => Boolean(reference)))];
  const email = await tx.email.create({
    data: {
      accountId,
      messageId: normalizedMessageId,
      inReplyTo: normalizeMessageId(message.inReplyTo),
      references: references.length > 0 ? JSON.stringify(references) : null,
      threadMatchStatus: 'PENDING',
      threadMatchReason: null,
      attachmentStatus: attachmentPlan.status,
      attachmentError: attachmentPlan.error,
      mailbox: message.mailbox,
      imapUid: message.uid,
      imapUidValidity: message.uidValidity,
      from: message.from,
      fromName: message.fromName,
      subject: message.subject,
      body: message.body,
      type: await autoClassifyEmail(message.subject, message.body),
      isRead: false,
      attachments: message.attachments.map((attachment) => attachment.filename || 'unnamed').join(','),
      rawHeaders: message.rawHeaders,
      receivedAt: message.receivedAt,
      processingStatus: 'PENDING',
    },
  });

  await persistAttachments(tx, email.id, attachmentPlan.attachments, uploadedObjectKeys);
  await matchInboundEmailThread(tx, email.id, message);

  return true;
}

async function persistAttachments(
  tx: Prisma.TransactionClient,
  emailId: string,
  attachments: SyncedEmailAttachment[],
  uploadedObjectKeys: string[],
) {
  if (attachments.length === 0) return;

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-email-'));
  const objectsByHash = new Map<string, { id: string }>();

  try {
    for (const [index, attachment] of attachments.entries()) {
      const content = Buffer.isBuffer(attachment.content)
        ? attachment.content
        : Buffer.from(attachment.content);
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      let storedObject = objectsByHash.get(sha256);

      if (!storedObject) {
        const contentType = (attachment.contentType || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
        const filename = attachment.filename || 'unnamed';
        const sourcePath = path.join(temporaryDirectory, String(index));
        await fs.writeFile(sourcePath, content);
        const requestedObjectKey = `email/${emailId}/${crypto.randomUUID()}`;
        uploadedObjectKeys.push(requestedObjectKey);
        const object = await objectStorage.putFile({
          sourcePath,
          objectKey: requestedObjectKey,
          mimeType: contentType,
          originalName: filename,
          domain: 'email',
          resourceId: emailId,
        });
        if (object.objectKey !== requestedObjectKey) uploadedObjectKeys.push(object.objectKey);
        storedObject = await tx.storedObject.create({
          data: {
            objectKey: object.objectKey,
            version: object.version,
            sha256: object.sha256,
            sizeBytes: object.sizeBytes,
            mimeType: object.mimeType,
            originalName: object.originalName,
            domain: object.domain,
            resourceId: object.resourceId,
            ownerId: object.ownerId,
          },
          select: { id: true },
        });
        objectsByHash.set(sha256, storedObject);
      }

      await tx.emailAttachment.create({
        data: {
          emailId,
          storedObjectId: storedObject.id,
          filename: attachment.filename || 'unnamed',
          contentType: (attachment.contentType || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase(),
          sizeBytes: content.byteLength,
          sha256,
          contentId: attachment.contentId,
        },
      });
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function setThreadMatch(
  tx: Prisma.TransactionClient,
  emailId: string,
  status: 'MATCHED' | 'NEEDS_REVIEW' | 'UNMATCHED',
  reason: string,
) {
  await tx.email.update({
    where: { id: emailId },
    data: { threadMatchStatus: status, threadMatchReason: reason },
  });
}

async function matchInboundEmailThread(
  tx: Prisma.TransactionClient,
  emailId: string,
  message: SyncedEmail,
) {
  const referenceIds = messageReferenceIds(message);
  if (referenceIds.length === 0) {
    await setThreadMatch(tx, emailId, 'UNMATCHED', 'NO_REPLY_MESSAGE_ID');
    return;
  }

  const lookupValues = [...new Set(referenceIds.flatMap((id) => [
    id,
    `<${id}>`,
    ` ${id} `,
    ` <${id}> `,
  ]))];
  const outboundEmails = await tx.outboundEmail.findMany({
    where: { providerMessageId: { in: lookupValues } },
    select: {
      id: true,
      providerMessageId: true,
      inquiry: {
        select: {
          id: true,
          supplier: { select: { email: true } },
        },
      },
    },
  });
  const referenceSet = new Set(referenceIds);
  const matchingOutboundEmails = new Map(outboundEmails
    .filter((outbound) => {
      const providerMessageId = normalizeMessageId(outbound.providerMessageId);
      return providerMessageId && referenceSet.has(providerMessageId);
    })
    .map((outbound) => [outbound.id, outbound]));

  if (matchingOutboundEmails.size === 0) {
    await setThreadMatch(tx, emailId, 'UNMATCHED', 'NO_OUTBOUND_MESSAGE_ID_MATCH');
    return;
  }
  if (matchingOutboundEmails.size !== 1) {
    await setThreadMatch(tx, emailId, 'NEEDS_REVIEW', 'AMBIGUOUS_OUTBOUND_MESSAGE_ID_MATCH');
    return;
  }

  const outbound = [...matchingOutboundEmails.values()][0];
  if (!outbound.inquiry) {
    await setThreadMatch(tx, emailId, 'NEEDS_REVIEW', 'OUTBOUND_INQUIRY_MISSING');
    return;
  }

  const supplierEmail = outbound.inquiry.supplier.email;
  if (!supplierEmail) {
    await setThreadMatch(tx, emailId, 'NEEDS_REVIEW', 'SUPPLIER_EMAIL_MISSING');
    return;
  }
  if (normalizeEmailAddress(message.from) !== normalizeEmailAddress(supplierEmail)) {
    await setThreadMatch(tx, emailId, 'NEEDS_REVIEW', 'SUPPLIER_EMAIL_MISMATCH');
    return;
  }

  await tx.inquiryEmailLink.create({
    data: {
      emailId,
      inquiryId: outbound.inquiry.id,
      method: 'AUTO_MESSAGE_ID',
      confirmationStatus: 'CONFIRMED',
      confirmedAt: new Date(),
      confirmedById: null,
    },
  });
  await setThreadMatch(tx, emailId, 'MATCHED', 'MESSAGE_ID_AND_SUPPLIER_EMAIL_MATCH');
}

async function cleanupUploadedObjects(objectKeys: string[]) {
  await Promise.all([...new Set(objectKeys)].map(async (objectKey) => {
    try {
      await objectStorage.delete(objectKey);
    } catch (error) {
      logger.error({ error, objectKey }, 'Failed to clean up inbound email attachment object');
    }
  }));
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
    const uploadedObjectKeys: string[] = [];

    try {
      await prisma.$transaction(async (tx) => {
        for (const message of fetched.emails) {
          if (await persistMessage(tx, accountId, message, uploadedObjectKeys)) savedCount += 1;
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
    } catch (error) {
      await cleanupUploadedObjects(uploadedObjectKeys);
      throw error;
    }

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
