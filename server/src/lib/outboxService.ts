import type { OutboxEvent, Prisma } from '@prisma/client';
import { decrypt } from './crypto.js';
import { sendEmail, type EmailAccountConfig } from './emailService.js';
import { AppError } from '../middleware/errorHandler.js';
import { preferredMoneyValue } from './money.js';
import { generateQuotationPDF } from './pdfService.js';
import prisma from './prisma.js';
import { isQuotationTransitionAllowed } from './quotationStateMachine.js';
import { emitToRoom } from './socketEvents.js';
import { transitionQuotationStatus } from './transactionStateService.js';
import { queueWebhookEvent } from './webhookService.js';
import { logger } from './logger.js';

export const OutboxChannel = {
  WEBHOOK: 'WEBHOOK',
  SOCKET: 'SOCKET',
  EMAIL: 'EMAIL',
} as const;

export const OutboxStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  RETRYING: 'RETRYING',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

type OutboxChannelValue = (typeof OutboxChannel)[keyof typeof OutboxChannel];
type OutboxTransactionClient = Pick<Prisma.TransactionClient, 'outboxEvent'>;

type SocketPayload = {
  room: string;
  event: string;
  data: Record<string, unknown>;
};

type EmailPayload = {
  outboundEmailId: string;
  includeQuotationPdf?: boolean;
};

export type EnqueueBusinessEventInput = {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  data: Record<string, unknown>;
  socket?: {
    room: string;
    event: string;
  };
  createdById?: string | null;
};

export type EnqueueOutboundEmailInput = {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  outboundEmailId: string;
  includeQuotationPdf?: boolean;
  createdById?: string | null;
};

const OUTBOX_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ERROR_LENGTH = 2000;

function serializePayload(payload: Record<string, unknown>) {
  return JSON.stringify(payload);
}

function parseRecordPayload(payload: string): Record<string, unknown> {
  const parsed = JSON.parse(payload) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Outbox payload must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function parseSocketPayload(payload: string): SocketPayload {
  const parsed = parseRecordPayload(payload);
  if (typeof parsed.room !== 'string' || typeof parsed.event !== 'string' || !parsed.data || typeof parsed.data !== 'object') {
    throw new Error('Invalid socket outbox payload');
  }
  return {
    room: parsed.room,
    event: parsed.event,
    data: parsed.data as Record<string, unknown>,
  };
}

function parseEmailPayload(payload: string): EmailPayload {
  const parsed = parseRecordPayload(payload);
  if (typeof parsed.outboundEmailId !== 'string' || !parsed.outboundEmailId) {
    throw new Error('Invalid email outbox payload');
  }
  return {
    outboundEmailId: parsed.outboundEmailId,
    includeQuotationPdf: parsed.includeQuotationPdf === true,
  };
}

function scheduleNextRetry(attemptCount: number) {
  const delayMs = Math.min(60 * 60 * 1000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
  return new Date(Date.now() + delayMs);
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function buildMessageId(outboxEventId: string) {
  const configuredDomain = process.env.EMAIL_MESSAGE_ID_DOMAIN?.trim().toLowerCase();
  const domain = configuredDomain && /^[a-z0-9.-]+$/.test(configuredDomain)
    ? configuredDomain
    : 'aerolink.local';
  return `<${outboxEventId}@${domain}>`;
}

class CancelledOutboxEventError extends Error {}

/** Queue a Webhook and optional Socket message in the same business transaction. */
export async function enqueueBusinessEvent(tx: OutboxTransactionClient, input: EnqueueBusinessEventInput) {
  const createdById = input.createdById ?? null;
  const webhookEvent = await tx.outboxEvent.create({
    data: {
      channel: OutboxChannel.WEBHOOK,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: serializePayload(input.data),
      createdById,
    },
  });

  if (!input.socket) {
    return { webhookEvent, socketEvent: null };
  }

  const socketEvent = await tx.outboxEvent.create({
    data: {
      channel: OutboxChannel.SOCKET,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: serializePayload({
        room: input.socket.room,
        event: input.socket.event,
        data: input.data,
      }),
      createdById,
    },
  });

  return { webhookEvent, socketEvent };
}

/** Queue an SMTP delivery. Credentials are intentionally never stored in payload. */
export async function enqueueOutboundEmail(tx: OutboxTransactionClient, input: EnqueueOutboundEmailInput) {
  return tx.outboxEvent.create({
    data: {
      channel: OutboxChannel.EMAIL,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: serializePayload({
        outboundEmailId: input.outboundEmailId,
        includeQuotationPdf: input.includeQuotationPdf === true,
      }),
      createdById: input.createdById ?? null,
    },
  });
}

function buildEmailAccountConfig(account: {
  id: string;
  email: string;
  displayName: string | null;
  imapServer: string;
  imapPort: string;
  smtpServer: string;
  smtpPort: string;
  authCode: string;
  accountType: string;
}): EmailAccountConfig {
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

async function buildQuotationAttachment(quotation: NonNullable<Awaited<ReturnType<typeof prisma.quotation.findUnique>>>) {
  const customer = await prisma.customer.findUnique({ where: { id: quotation.customerId } });
  if (!customer) {
    throw new Error('Quotation customer no longer exists');
  }

  const pdfBuffer = await generateQuotationPDF({
    quoteNumber: quotation.quoteNumber,
    customerName: customer.name,
    partNumber: quotation.partNumber,
    quantity: quotation.quantity,
    unitPrice: preferredMoneyValue(quotation.unitPriceDecimal, quotation.unitPrice) ?? 0,
    totalPrice: preferredMoneyValue(quotation.totalPriceDecimal, quotation.totalPrice) ?? 0,
    costPrice: preferredMoneyValue(quotation.costPriceDecimal, quotation.costPrice) ?? 0,
    margin: quotation.margin,
    validityDays: quotation.validityDays,
    saleType: quotation.saleType,
    incoterm: quotation.incoterm || '',
    incotermLocation: quotation.incotermLocation || '',
    leadTimeDays: quotation.leadTimeDays || undefined,
    leadTimeBasis: quotation.leadTimeBasis || '',
    moq: quotation.moq || undefined,
    mpq: quotation.mpq || undefined,
    priceBasis: quotation.priceBasis || '',
    taxIncluded: quotation.taxIncluded,
    taxRate: quotation.taxRate || undefined,
    warrantyDays: quotation.warrantyDays,
    warrantyTerms: quotation.warrantyTerms || '',
    packagingRequirement: quotation.packagingRequirement || '',
    shippingMethod: quotation.shippingMethod || '',
    commonNote: quotation.commonNote || '',
    certificateFiles: quotation.certificateFiles?.split(',').filter(Boolean),
    createdAt: quotation.createdAt.toISOString(),
    expiryDate: quotation.expiryDate.toISOString().split('T')[0],
    createdBy: quotation.createdBy,
  });

  return {
    filename: `${quotation.quoteNumber}.pdf`,
    content: pdfBuffer,
    contentType: 'application/pdf',
  };
}

async function deliverOutboundEmailEvent(event: OutboxEvent) {
  const payload = parseEmailPayload(event.payload);
  const email = await prisma.outboundEmail.findUnique({
    where: { id: payload.outboundEmailId },
    include: {
      account: true,
      quotation: true,
    },
  });

  if (!email) {
    throw new CancelledOutboxEventError('Outbound email no longer exists');
  }
  if (email.status === 'SENT') {
    return;
  }
  if (email.status === 'WITHDRAWN') {
    throw new CancelledOutboxEventError('Outbound email was withdrawn');
  }
  if (!email.account || !email.account.isActive) {
    throw new Error('Outbound email account is unavailable');
  }
  if (email.purpose === 'QUOTATION_SEND' && (!email.quotation || email.quotation.status === 'WITHDRAWN')) {
    throw new CancelledOutboxEventError('Quotation was withdrawn before email delivery');
  }

  const attachments = payload.includeQuotationPdf && email.quotation
    ? [await buildQuotationAttachment(email.quotation)]
    : undefined;
  const sentResult = await sendEmail(buildEmailAccountConfig(email.account), {
    to: email.toEmail,
    subject: email.subject,
    body: email.textBody,
    html: email.htmlBody || undefined,
    attachments,
    messageId: buildMessageId(event.id),
  });
  const sentAt = new Date();

  await prisma.$transaction(async (tx) => {
    const updateResult = await tx.outboundEmail.updateMany({
      where: {
        id: email.id,
        status: { not: 'WITHDRAWN' },
      },
      data: {
        status: 'SENT',
        sentAt,
        providerMessageId: sentResult.messageId ?? buildMessageId(event.id),
        errorMessage: null,
      },
    });

    if (updateResult.count !== 1 || email.purpose !== 'QUOTATION_SEND' || !email.quotationId) {
      return;
    }

    const currentQuotation = await tx.quotation.findUnique({ where: { id: email.quotationId } });
    if (!currentQuotation || currentQuotation.status === 'WITHDRAWN' || currentQuotation.status === 'SENT') {
      return;
    }
    if (!isQuotationTransitionAllowed(currentQuotation.status, 'SENT')) {
      throw new Error(`Quotation ${currentQuotation.id} cannot transition to SENT after email delivery`);
    }

    const updatedQuotation = await transitionQuotationStatus(tx, {
      id: currentQuotation.id,
      currentStatus: currentQuotation.status,
      currentVersion: currentQuotation.version,
      nextStatus: 'SENT',
      actorId: event.createdById,
      reasonCode: 'QUOTATION_EMAIL_DELIVERED',
      reason: `Outbound email ${email.id} delivered by transactional outbox.`,
      data: { sentAt },
    });

    await enqueueBusinessEvent(tx, {
      eventType: 'quotation.sent',
      aggregateType: 'QUOTATION',
      aggregateId: updatedQuotation.id,
      data: {
        quotationId: updatedQuotation.id,
        quoteNumber: updatedQuotation.quoteNumber,
        status: updatedQuotation.status,
        sentAt: updatedQuotation.sentAt?.toISOString(),
        outboundEmailId: email.id,
        toEmail: email.toEmail,
      },
      socket: {
        room: 'quotations',
        event: 'quotation:sent',
      },
      createdById: event.createdById,
    });
  });
}

async function dispatchOutboxEvent(event: OutboxEvent) {
  if (event.channel === OutboxChannel.WEBHOOK) {
    await queueWebhookEvent(event.eventType, parseRecordPayload(event.payload), {
      eventId: event.id,
      outboxEventId: event.id,
      occurredAt: event.createdAt,
      deliverImmediately: false,
    });
    return;
  }

  if (event.channel === OutboxChannel.SOCKET) {
    const payload = parseSocketPayload(event.payload);
    if (!emitToRoom(payload.room, payload.event, payload.data)) {
      throw new Error('Socket.IO is not initialized');
    }
    return;
  }

  if (event.channel === OutboxChannel.EMAIL) {
    await deliverOutboundEmailEvent(event);
    return;
  }

  throw new Error(`Unsupported outbox channel: ${event.channel}`);
}

async function markOutboxFailure(event: OutboxEvent, error: unknown) {
  const message = errorMessage(error);
  const terminal = event.attemptCount >= event.maxAttempts;
  const nextStatus = terminal ? OutboxStatus.FAILED : OutboxStatus.RETRYING;
  let emailPayload: EmailPayload | null = null;

  if (terminal && event.channel === OutboxChannel.EMAIL) {
    try {
      emailPayload = parseEmailPayload(event.payload);
    } catch (payloadError) {
      logger.error({ payloadError, outboxEventId: event.id }, 'Unable to parse failed email outbox payload for compensation');
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: nextStatus,
        nextRetryAt: terminal ? null : scheduleNextRetry(event.attemptCount),
        lockedAt: null,
        lastError: message,
      },
    });

    if (!emailPayload) {
      return;
    }

    await tx.outboundEmail.updateMany({
      where: {
        id: emailPayload.outboundEmailId,
        status: { notIn: ['SENT', 'WITHDRAWN'] },
      },
      data: {
        status: 'FAILED',
        errorMessage: message,
      },
    });

    if (event.createdById) {
      await tx.notification.create({
        data: {
          userId: event.createdById,
          title: '异步邮件投递失败',
          message: `邮件投递已重试 ${event.attemptCount} 次仍未成功：${message}`,
          type: 'error',
          link: '/quotations',
        },
      });
    }
  });
}

async function markOutboxCancelled(event: OutboxEvent, error: CancelledOutboxEventError) {
  await prisma.outboxEvent.update({
    where: { id: event.id },
    data: {
      status: OutboxStatus.CANCELLED,
      nextRetryAt: null,
      lockedAt: null,
      lastError: errorMessage(error),
    },
  });
}

export async function processOutboxEvent(id: string): Promise<boolean> {
  const now = new Date();
  const claim = await prisma.outboxEvent.updateMany({
    where: {
      id,
      status: { in: [OutboxStatus.PENDING, OutboxStatus.RETRYING] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    data: {
      status: OutboxStatus.PROCESSING,
      attemptCount: { increment: 1 },
      lockedAt: now,
    },
  });

  if (claim.count !== 1) {
    return false;
  }

  const event = await prisma.outboxEvent.findUnique({ where: { id } });
  if (!event) {
    return false;
  }

  try {
    await dispatchOutboxEvent(event);
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: OutboxStatus.DELIVERED,
        deliveredAt: new Date(),
        nextRetryAt: null,
        lockedAt: null,
        lastError: null,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof CancelledOutboxEventError) {
      await markOutboxCancelled(event, error);
      return false;
    }
    await markOutboxFailure(event, error);
    logger.warn({ error, outboxEventId: event.id, channel: event.channel, eventType: event.eventType }, 'Outbox event dispatch failed');
    return false;
  }
}

/** Recover stale claims and process due events. Safe for multiple server replicas. */
export async function processPendingOutboxEvents(limit = 50) {
  const now = new Date();
  await prisma.outboxEvent.updateMany({
    where: {
      status: OutboxStatus.PROCESSING,
      lockedAt: { lt: new Date(now.getTime() - OUTBOX_LOCK_TIMEOUT_MS) },
    },
    data: {
      status: OutboxStatus.RETRYING,
      lockedAt: null,
      nextRetryAt: now,
      lastError: 'Recovered stale outbox worker claim',
    },
  });

  const candidates = await prisma.outboxEvent.findMany({
    where: {
      status: { in: [OutboxStatus.PENDING, OutboxStatus.RETRYING] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(100, Math.max(1, limit)),
    select: { id: true },
  });

  let delivered = 0;
  for (const candidate of candidates) {
    if (await processOutboxEvent(candidate.id)) {
      delivered += 1;
    }
  }

  return { processed: candidates.length, delivered };
}

export async function retryOutboxEvent(id: string) {
  const event = await prisma.outboxEvent.findUnique({ where: { id } });
  if (!event) {
    throw new AppError('Outbox 事件不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  if (event.status !== OutboxStatus.FAILED && event.status !== OutboxStatus.RETRYING) {
    throw new AppError('只有失败或等待重试的 Outbox 事件可以人工重试', 409, 'STATE_CONFLICT');
  }

  await prisma.$transaction(async (tx) => {
    await tx.outboxEvent.update({
      where: { id },
      data: {
        status: OutboxStatus.PENDING,
        attemptCount: 0,
        nextRetryAt: null,
        lockedAt: null,
        lastError: null,
      },
    });

    if (event.channel === OutboxChannel.EMAIL) {
      const payload = parseEmailPayload(event.payload);
      await tx.outboundEmail.updateMany({
        where: { id: payload.outboundEmailId, status: 'FAILED' },
        data: { status: 'PENDING', errorMessage: null },
      });
    }
  });

  return prisma.outboxEvent.findUnique({ where: { id } });
}

export async function cancelOutboxEvent(id: string, reason?: string) {
  const result = await prisma.outboxEvent.updateMany({
    where: {
      id,
      status: { in: [OutboxStatus.PENDING, OutboxStatus.RETRYING, OutboxStatus.FAILED] },
    },
    data: {
      status: OutboxStatus.CANCELLED,
      nextRetryAt: null,
      lockedAt: null,
      lastError: reason?.trim().slice(0, MAX_ERROR_LENGTH) || 'Cancelled manually',
    },
  });

  if (result.count !== 1) {
    throw new AppError('Outbox 事件不存在或无法取消', 409, 'STATE_CONFLICT');
  }
}

export async function getOutboxStats() {
  const rows = await prisma.outboxEvent.groupBy({
    by: ['channel', 'status'],
    _count: { _all: true },
  });

  return rows.reduce<Record<string, Record<string, number>>>((summary, row) => {
    if (!summary[row.channel]) {
      summary[row.channel] = {};
    }
    summary[row.channel][row.status] = row._count._all;
    return summary;
  }, {});
}

export function isOutboxChannel(value: unknown): value is OutboxChannelValue {
  return typeof value === 'string' && Object.values(OutboxChannel).includes(value as OutboxChannelValue);
}
