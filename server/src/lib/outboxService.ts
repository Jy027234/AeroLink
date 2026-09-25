import crypto from 'node:crypto';
import type { OutboxEvent, Prisma } from '@prisma/client';
import { decrypt } from './crypto.js';
import { sendEmail, type EmailAccountConfig } from './emailService.js';
import { AppError } from '../middleware/errorHandler.js';
import { assertImmutableDocumentArtifact, parseQuotationRenderSnapshot, sha256 } from './documentRenderSnapshot.js';
import prisma from './prisma.js';
import { isQuotationTransitionAllowed } from './quotationStateMachine.js';
import * as socketEvents from './socketEvents.js';
import type { SocketEventScope } from './socketEvents.js';
import { sanitizeSocketData } from './socketPayload.js';
import { transitionQuotationStatus } from './transactionStateService.js';
import { preferredQuotationStatus } from './transactionStatusShadows.js';
import { queueWebhookEvent } from './webhookService.js';
import { logger } from './logger.js';
import { getRequestId, runWithContext } from './requestContext.js';
import { getTraceId, traceSpan } from './trace.js';
import { recordOperationalAlert } from './alerting.js';

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

export type OutboxChannelValue = (typeof OutboxChannel)[keyof typeof OutboxChannel];
type OutboxTransactionClient = Pick<Prisma.TransactionClient, 'outboxEvent'>;

export type SocketPayload = {
  room: string;
  event: string;
  data: Record<string, unknown>;
  scope?: SocketEventScope;
};

type EmailPayload = {
  outboundEmailId: string;
  includeQuotationPdf?: boolean;
  attachmentDocumentId?: string;
  attachmentSnapshotHash?: string;
};

export type EnqueueBusinessEventInput = {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  data: Record<string, unknown>;
  socket?: {
    room: string;
    event: string;
    scope?: SocketEventScope;
  };
  createdById?: string | null;
};

export type EnqueueOutboundEmailInput = {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  outboundEmailId: string;
  includeQuotationPdf?: boolean;
  /** Immutable GeneratedDocument containing the frozen customer-facing PDF. */
  attachmentDocumentId?: string;
  /** Hash of the immutable render snapshot stored by the caller. */
  attachmentSnapshotHash?: string;
  createdById?: string | null;
};

const OUTBOX_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const OUTBOX_LEASE_HEARTBEAT_MS = 60_000;
const MAX_ERROR_LENGTH = 2000;
const DEFAULT_WORKER_ID = process.env.WORKER_ID?.trim() || `worker-${crypto.randomUUID()}`;
export const API_OUTBOX_CHANNELS = [OutboxChannel.SOCKET] as const;
export const WORKER_OUTBOX_CHANNELS = [OutboxChannel.EMAIL, OutboxChannel.WEBHOOK] as const;
const P2_FAULT_INJECTION_ENABLED = ['1', 'true', 'yes'].includes((process.env.P2_FAULT_INJECTION ?? '').toLowerCase());
const P2_WORKER_CRASH_DELAY_MS = Math.max(0, Number.parseInt(process.env.P2_WORKER_CRASH_DELAY_MS ?? '25', 10) || 25);

type P2WorkerCrashPoint = 'before-dispatch' | 'during-side-effect' | 'before-finalize';

function terminateForP2FaultInjection(point: P2WorkerCrashPoint, outboxEventId: string, workerId?: string) {
  if (!P2_FAULT_INJECTION_ENABLED || process.env.P2_WORKER_CRASH_POINT?.trim() !== point) return;
  logger.error({ outboxEventId, workerId, crashPoint: point }, 'P2 fault injection terminating worker process');
  process.exit(70);
}

async function waitForP2SideEffectCrash(outboxEventId: string, workerId: string) {
  if (!P2_FAULT_INJECTION_ENABLED || process.env.P2_WORKER_CRASH_POINT?.trim() !== 'during-side-effect') return;
  await new Promise<void>((resolve) => setTimeout(resolve, P2_WORKER_CRASH_DELAY_MS));
  terminateForP2FaultInjection('during-side-effect', outboxEventId, workerId);
}

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
  if (
    typeof parsed.room !== 'string'
    || typeof parsed.event !== 'string'
    || !parsed.data
    || typeof parsed.data !== 'object'
    || Array.isArray(parsed.data)
  ) {
    throw new Error('Invalid socket outbox payload');
  }
  const parsedScope = parsed.scope;
  const scope = parsedScope && typeof parsedScope === 'object' && !Array.isArray(parsedScope)
    ? parsedScope as Record<string, unknown>
    : undefined;
  return {
    room: parsed.room,
    event: parsed.event,
    data: (sanitizeSocketData(parsed.data) ?? {}) as Record<string, unknown>,
    ...(scope ? {
      scope: {
        ...(typeof scope.capability === 'string' ? { capability: scope.capability } : {}),
        ...(typeof scope.ownerId === 'string' ? { ownerId: scope.ownerId } : {}),
        ...(typeof scope.department === 'string' ? { department: scope.department } : {}),
        ...(Array.isArray(scope.userIds)
          ? { userIds: scope.userIds.filter((value): value is string => typeof value === 'string') }
          : {}),
      },
    } : {}),
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
    ...(parsed.attachmentDocumentId === undefined
      ? {}
      : typeof parsed.attachmentDocumentId === 'string' && parsed.attachmentDocumentId
        ? { attachmentDocumentId: parsed.attachmentDocumentId }
        : (() => { throw new Error('Invalid email attachment document id'); })()),
    ...(parsed.attachmentSnapshotHash === undefined
      ? {}
      : typeof parsed.attachmentSnapshotHash === 'string' && parsed.attachmentSnapshotHash
        ? { attachmentSnapshotHash: parsed.attachmentSnapshotHash }
        : (() => { throw new Error('Invalid email attachment snapshot hash'); })()),
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

function inferSocketCapability(eventType: string, aggregateType: string) {
  const eventResource = eventType.trim().toLowerCase().split(/[.:]/)[0];
  if (eventResource) return `${eventResource}.read`;
  const aggregateResource = aggregateType.trim().toLowerCase().split(/[.:]/)[0];
  return aggregateResource ? `${aggregateResource}.read` : undefined;
}

function inferSocketOwner(data: Record<string, unknown>) {
  for (const key of ['ownerId', 'userId']) {
    const value = data[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function isAuthoritativeAggregateType(aggregateType: string) {
  const normalized = aggregateType.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return normalized === 'RFQ' || normalized === 'QUOTATION' || normalized === 'ORDER';
}

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
      requestId: getRequestId() ?? null,
      traceId: getTraceId() ?? null,
    },
  });

  if (!input.socket) {
    return { webhookEvent, socketEvent: null };
  }

  const hasAuthoritativeOwner = isAuthoritativeAggregateType(input.aggregateType);
  const ownerHint = input.socket.scope?.ownerId ?? inferSocketOwner(input.data);
  const departmentHint = input.socket.scope?.department
    ?? (typeof input.data.department === 'string' ? input.data.department : undefined);

  const socketEvent = await tx.outboxEvent.create({
    data: {
      channel: OutboxChannel.SOCKET,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: serializePayload({
        room: input.socket.room,
        event: input.socket.event,
        data: (sanitizeSocketData(input.data) ?? {}) as Record<string, unknown>,
        scope: {
          capability: input.socket.scope?.capability ?? inferSocketCapability(input.eventType, input.aggregateType),
          // RFQ, quotation, and order ownership is reloaded from the current
          // aggregate at dispatch.  Never persist the action actor as a
          // document owner.  Explicit user scope remains for user-only events.
          ...(!hasAuthoritativeOwner && ownerHint ? { ownerId: ownerHint } : {}),
          ...(!hasAuthoritativeOwner && departmentHint ? { department: departmentHint } : {}),
          ...(input.socket.scope?.userIds ? { userIds: input.socket.scope.userIds } : {}),
        },
      }),
      createdById,
      requestId: getRequestId() ?? null,
      traceId: getTraceId() ?? null,
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
        ...(input.attachmentDocumentId ? { attachmentDocumentId: input.attachmentDocumentId } : {}),
        ...(input.attachmentSnapshotHash ? { attachmentSnapshotHash: input.attachmentSnapshotHash } : {}),
      }),
      createdById: input.createdById ?? null,
      requestId: getRequestId() ?? null,
      traceId: getTraceId() ?? null,
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

type GeneratedDocumentSnapshotRecord = {
  id: string;
  title: string;
  documentType: string;
  quotationId?: string | null;
  customerId?: string | null;
  contentHtml: string;
  generatedAt: Date;
  generatedById?: string | null;
  payloadJson?: string | null;
  contentSha256?: string | null;
  // These fields are added by the immutable-document migration.  Keeping the
  // adapter structural lets this worker compile while that migration lands.
  pdfBytes?: Buffer | Uint8Array | null;
  pdfSha256?: string | null;
  snapshotHash?: string | null;
};

async function buildDocumentSnapshotAttachment(
  documentId: string,
  expectedQuotationId: string,
  expectedSnapshotHash?: string,
) {
  const document = await prisma.generatedDocument.findUnique({ where: { id: documentId } }) as GeneratedDocumentSnapshotRecord | null;
  if (!document) {
    throw new CancelledOutboxEventError('Immutable quotation document no longer exists');
  }

  const dynamicDocument = document as GeneratedDocumentSnapshotRecord;
  if (dynamicDocument.documentType !== 'QUOTATION_PDF') {
    throw new CancelledOutboxEventError('Outbound quotation attachment is not a quotation PDF');
  }
  if (!dynamicDocument.quotationId || dynamicDocument.quotationId !== expectedQuotationId) {
    throw new CancelledOutboxEventError('Outbound quotation attachment belongs to a different quotation');
  }
  if (!dynamicDocument.snapshotHash) {
    throw new CancelledOutboxEventError('Historical quotation document has no immutable snapshot marker');
  }
  if (expectedSnapshotHash && expectedSnapshotHash !== dynamicDocument.snapshotHash) {
    throw new Error('Quotation document snapshot hash does not match outbox payload');
  }
  if (!dynamicDocument.payloadJson) {
    throw new CancelledOutboxEventError('Quotation PDF attachment snapshot payload is missing');
  }
  let snapshot;
  try {
    snapshot = parseQuotationRenderSnapshot(dynamicDocument.payloadJson);
  } catch {
    throw new CancelledOutboxEventError('Quotation PDF attachment snapshot payload is invalid');
  }
  if (snapshot.source.quotationId !== dynamicDocument.quotationId || snapshot.snapshotHash !== dynamicDocument.snapshotHash) {
    throw new CancelledOutboxEventError('Quotation PDF attachment snapshot source does not match the document');
  }
  if (!dynamicDocument.contentSha256 || sha256(dynamicDocument.contentHtml) !== dynamicDocument.contentSha256) {
    throw new CancelledOutboxEventError('Quotation PDF attachment HTML snapshot integrity failed');
  }
  if (!dynamicDocument.pdfBytes || dynamicDocument.pdfBytes.byteLength === 0) {
    throw new CancelledOutboxEventError('Immutable quotation PDF bytes are missing');
  }
  if (!dynamicDocument.pdfSha256) {
    throw new CancelledOutboxEventError('Immutable quotation PDF hash is missing');
  }
  const content = Buffer.from(dynamicDocument.pdfBytes);

  const snapshotHash = dynamicDocument.snapshotHash;
  const artifact = {
    filename: `${document.title}.pdf`,
    content,
    contentType: 'application/pdf' as const,
    sha256: sha256(content),
    sizeBytes: content.byteLength,
    snapshotHash,
  };
  assertImmutableDocumentArtifact(artifact, {
    sha256: dynamicDocument.pdfSha256,
    snapshotHash: expectedSnapshotHash || dynamicDocument.snapshotHash,
  });
  return artifact;
}

async function deliverOutboundEmailEvent(event: OutboxEvent) {
  const payload = parseEmailPayload(event.payload);
  const email = await prisma.outboundEmail.findUnique({
    where: { id: payload.outboundEmailId },
    include: {
      account: true,
      quotation: true,
      inquiry: true,
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
  if (
    email.purpose === 'QUOTATION_SEND'
    && (!email.quotation || preferredQuotationStatus(email.quotation.statusEnum, email.quotation.status) === 'WITHDRAWN')
  ) {
    throw new CancelledOutboxEventError('Quotation was withdrawn before email delivery');
  }
  if (email.purpose === 'QUOTATION_SEND' && (email.quotation as ({ supersededAt?: Date | null } | null) | null)?.supersededAt) {
    throw new CancelledOutboxEventError('Quotation was superseded before email delivery');
  }

  let attachments;
  if (payload.includeQuotationPdf) {
    if (!payload.attachmentDocumentId) {
      throw new CancelledOutboxEventError('Quotation PDF attachment snapshot is missing');
    }
    if (!email.quotationId) {
      throw new CancelledOutboxEventError('Outbound quotation email has no quotation binding');
    }
    attachments = [await buildDocumentSnapshotAttachment(payload.attachmentDocumentId, email.quotationId, payload.attachmentSnapshotHash)];
  }
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

    if (updateResult.count !== 1) {
      return;
    }

    if (email.purpose === 'INQUIRY_SEND' && email.inquiryId) {
      await tx.inquiry.updateMany({
        where: { id: email.inquiryId },
        data: { status: 'SENT', sentAt },
      });
      return;
    }

    if (email.purpose !== 'QUOTATION_SEND' || !email.quotationId) return;

    const currentQuotation = await tx.quotation.findUnique({ where: { id: email.quotationId } });
    const currentQuotationStatus = currentQuotation
      ? preferredQuotationStatus(currentQuotation.statusEnum, currentQuotation.status)
      : null;
    if (!currentQuotation || currentQuotationStatus === 'WITHDRAWN' || currentQuotationStatus === 'SENT') {
      return;
    }
    if (!isQuotationTransitionAllowed(currentQuotationStatus, 'SENT')) {
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
        status: preferredQuotationStatus(updatedQuotation.statusEnum, updatedQuotation.status),
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
      requestId: event.requestId ?? undefined,
    });
    // The injected pause models a worker dying while the external side-effect
    // boundary is still in progress. It is reachable only in the explicitly
    // enabled crash-recovery harness and never in normal deployments.
    await waitForP2SideEffectCrash(event.id, process.env.WORKER_ID?.trim() || 'worker-unknown');
    return;
  }

  if (event.channel === OutboxChannel.SOCKET) {
    const payload = parseSocketPayload(event.payload);
    const scope = payload.scope ?? {
      capability: inferSocketCapability(event.eventType, event.aggregateType),
    };
    // There is no unrestricted room fallback: a missing scoped emitter is a
    // deployment/configuration error and must fail the outbox item visibly.
    const emitted = await socketEvents.emitScopedSocketEvent({
      event: payload.event,
      data: payload.data,
      scope,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
    });
    if (!emitted) throw new Error('Socket.IO is not initialized or event dispatch failed');
    return;
  }

  if (event.channel === OutboxChannel.EMAIL) {
    await deliverOutboundEmailEvent(event);
    return;
  }

  throw new Error(`Unsupported outbox channel: ${event.channel}`);
}

async function markOutboxFailure(event: OutboxEvent, workerId: string, error: unknown) {
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
    const released = await tx.outboxEvent.updateMany({
      where: { id: event.id, status: OutboxStatus.PROCESSING, workerId },
      data: {
        status: nextStatus,
        nextRetryAt: terminal ? null : scheduleNextRetry(event.attemptCount),
        lockedAt: null,
        workerId: null,
        lastError: message,
      },
    });

    // A stale lease may have been recovered by another worker while the
    // external side effect was running. Never let the old worker overwrite
    // the newer claim or emit a duplicate compensation notification.
    if (released.count !== 1) return;

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
          link: event.aggregateType === 'INQUIRY' ? '/sourcing' : '/quotations',
        },
      });
    }
  });

  if (terminal) {
    recordOperationalAlert({
      key: `worker.outbox.retry-exhausted.${event.id}`,
      severity: 'critical',
      title: 'Outbox retry exhausted',
      message: 'An asynchronous outbox event reached its retry limit and requires controlled replay or compensation.',
      source: 'worker.outbox',
      metadata: { outboxEventId: event.id, attemptCount: event.attemptCount, channel: event.channel },
    });
  }
}

async function markOutboxCancelled(event: OutboxEvent, workerId: string, error: CancelledOutboxEventError) {
  await prisma.$transaction(async (tx) => {
    const released = await tx.outboxEvent.updateMany({
      where: { id: event.id, status: OutboxStatus.PROCESSING, workerId },
      data: {
        status: OutboxStatus.CANCELLED,
        nextRetryAt: null,
        lockedAt: null,
        workerId: null,
        lastError: errorMessage(error),
      },
    });

    // A stale worker may discover that a newer worker already recovered and
    // claimed this event.  The lease CAS above is the boundary: only its
    // winner may mutate the linked email status.
    if (released.count !== 1 || event.channel !== OutboxChannel.EMAIL) return;

    let emailPayload: EmailPayload;
    try {
      emailPayload = parseEmailPayload(event.payload);
    } catch (payloadError) {
      logger.warn({ payloadError, outboxEventId: event.id }, 'Unable to parse cancelled email outbox payload');
      return;
    }

    await tx.outboundEmail.updateMany({
      where: {
        id: emailPayload.outboundEmailId,
        status: { notIn: ['SENT', 'WITHDRAWN'] },
      },
      data: {
        status: 'FAILED',
        errorMessage: errorMessage(error),
      },
    });
  });
}

export type OutboxProcessingOptions = {
  channels?: readonly OutboxChannelValue[];
};

function normalizedChannels(options?: OutboxProcessingOptions) {
  if (!options?.channels) return undefined;
  return Array.from(new Set(options.channels.filter(isOutboxChannel)));
}

export async function processOutboxEvent(
  id: string,
  workerId = DEFAULT_WORKER_ID,
  options?: OutboxProcessingOptions,
): Promise<boolean> {
  const channels = normalizedChannels(options);
  if (channels && channels.length === 0) return false;
  const now = new Date();
  const claim = await prisma.outboxEvent.updateMany({
    where: {
      id,
      ...(channels ? { channel: { in: channels } } : {}),
      status: { in: [OutboxStatus.PENDING, OutboxStatus.RETRYING] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    data: {
      status: OutboxStatus.PROCESSING,
      attemptCount: { increment: 1 },
      lockedAt: now,
      workerId,
    },
  });

  if (claim.count !== 1) {
    return false;
  }

  const event = await prisma.outboxEvent.findUnique({ where: { id } });
  if (!event) {
    // The event may have been deleted by an administrative cleanup between
    // the atomic claim and the read. Do not leave a phantom PROCESSING lease
    // behind if the row still exists; the conditional predicate also keeps a
    // newer worker from being overwritten in the unlikely race.
    await prisma.outboxEvent.updateMany({
      where: { id, status: OutboxStatus.PROCESSING, workerId },
      data: {
        status: OutboxStatus.RETRYING,
        nextRetryAt: new Date(),
        lockedAt: null,
        workerId: null,
        lastError: 'Outbox event disappeared after claim',
      },
    });
    logger.warn({ outboxEventId: id, workerId }, 'Outbox event disappeared after claim');
    return false;
  }

  terminateForP2FaultInjection('before-dispatch', event.id, workerId);

  const heartbeat = setInterval(() => {
    void prisma.outboxEvent.updateMany({
      where: { id, status: OutboxStatus.PROCESSING, workerId },
      data: { lockedAt: new Date() },
    }).catch((error) => {
      logger.warn({ error, outboxEventId: id, workerId }, 'Outbox lease heartbeat failed');
    });
  }, OUTBOX_LEASE_HEARTBEAT_MS);

  try {
    return await runWithContext({
      requestId: event.requestId ?? `worker:${workerId}`,
      traceId: event.traceId ?? crypto.randomUUID(),
    }, () => traceSpan('outbox.process', {
      outboxEventId: event.id,
      channel: event.channel,
      eventType: event.eventType,
    }, async () => {
      await dispatchOutboxEvent(event);
      terminateForP2FaultInjection('before-finalize', event.id, workerId);
      const released = await prisma.outboxEvent.updateMany({
        where: { id: event.id, status: OutboxStatus.PROCESSING, workerId },
        data: {
          status: OutboxStatus.DELIVERED,
          deliveredAt: new Date(),
          nextRetryAt: null,
          lockedAt: null,
          workerId: null,
          lastError: null,
        },
      });
      return released.count === 1;
    }));
  } catch (error) {
    if (error instanceof CancelledOutboxEventError) {
      await markOutboxCancelled(event, workerId, error);
      return false;
    }
    await markOutboxFailure(event, workerId, error);
    logger.warn({ error, outboxEventId: event.id, channel: event.channel, eventType: event.eventType, requestId: event.requestId, traceId: event.traceId }, 'Outbox event dispatch failed');
    return false;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Recover stale claims and process due events for an owned channel set.  The
 * current production topology is one API process (SOCKET) plus one Worker
 * process (EMAIL/WEBHOOK); channel-scoped leases prevent either process from
 * consuming the other process's queue.  This does not solve delivery to
 * Socket.IO connections spread across multiple API replicas.
 */
export async function processPendingOutboxEvents(
  limit = 50,
  workerId = DEFAULT_WORKER_ID,
  options?: OutboxProcessingOptions,
) {
  // Direct maintenance/fault-probe callers retain an all-channel default;
  // actual runtimes always pass their owned set from worker.ts.
  const channels = normalizedChannels(options) ?? Object.values(OutboxChannel);
  if (channels.length === 0) return { processed: 0, delivered: 0 };
  const now = new Date();
  await prisma.outboxEvent.updateMany({
    where: {
      channel: { in: channels },
      status: OutboxStatus.PROCESSING,
      lockedAt: { lt: new Date(now.getTime() - OUTBOX_LOCK_TIMEOUT_MS) },
    },
    data: {
      status: OutboxStatus.RETRYING,
      lockedAt: null,
      workerId: null,
      nextRetryAt: now,
      lastError: 'Recovered stale outbox worker claim',
    },
  });

  const candidates = await prisma.outboxEvent.findMany({
    where: {
      channel: { in: channels },
      status: { in: [OutboxStatus.PENDING, OutboxStatus.RETRYING] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(100, Math.max(1, limit)),
    select: { id: true },
  });

  let delivered = 0;
  for (const candidate of candidates) {
    if (await processOutboxEvent(candidate.id, workerId, { channels })) {
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
    const reset = await tx.outboxEvent.updateMany({
      where: {
        id,
        status: { in: [OutboxStatus.FAILED, OutboxStatus.RETRYING] },
      },
      data: {
        status: OutboxStatus.PENDING,
        attemptCount: 0,
        nextRetryAt: null,
        lockedAt: null,
        workerId: null,
        lastError: null,
      },
    });
    if (reset.count !== 1) {
      throw new AppError('Outbox 事件已被其他 Worker 领取，无法人工重试', 409, 'STATE_CONFLICT');
    }

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
  const cancellationReason = reason?.trim().slice(0, MAX_ERROR_LENGTH) || 'Cancelled manually';

  await prisma.$transaction(async (tx) => {
    // Read the payload inside the same transaction as the conditional status
    // update.  A worker can claim the event between an outside read and the
    // CAS, so only the CAS winner may compensate a linked outbound email.
    const event = await tx.outboxEvent.findUnique({ where: { id } });
    if (!event) {
      throw new AppError('Outbox 事件不存在或无法取消', 409, 'STATE_CONFLICT');
    }

    const result = await tx.outboxEvent.updateMany({
      where: {
        id,
        status: { in: [OutboxStatus.PENDING, OutboxStatus.RETRYING, OutboxStatus.FAILED] },
      },
      data: {
        status: OutboxStatus.CANCELLED,
        nextRetryAt: null,
        lockedAt: null,
        workerId: null,
        lastError: cancellationReason,
      },
    });

    if (result.count !== 1) {
      throw new AppError('Outbox 事件不存在或无法取消', 409, 'STATE_CONFLICT');
    }

    if (event.channel !== OutboxChannel.EMAIL) return;

    let emailPayload: EmailPayload;
    try {
      emailPayload = parseEmailPayload(event.payload);
    } catch (payloadError) {
      logger.warn({ payloadError, outboxEventId: event.id }, 'Unable to parse manually cancelled email outbox payload');
      return;
    }

    await tx.outboundEmail.updateMany({
      where: {
        id: emailPayload.outboundEmailId,
        status: { notIn: ['SENT', 'WITHDRAWN'] },
      },
      data: {
        status: 'FAILED',
        errorMessage: cancellationReason,
      },
    });
  });
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
