import crypto from 'crypto';
import { type Prisma, WebhookDelivery, WebhookEndpoint, WebhookSubscription } from '@prisma/client';
import prisma from './prisma.js';
import { decrypt, encrypt } from './crypto.js';
import {
  buildJsonArrayShadow,
  buildJsonObjectShadow,
  preferredJsonArray,
  preferredJsonObject,
} from './jsonConfigurationShadows.js';
import { logger } from './logger.js';

const DEFAULT_WEBHOOK_WORKER_ID = process.env.WORKER_ID?.trim() || `worker-${crypto.randomUUID()}`;
const WEBHOOK_LEASE_HEARTBEAT_MS = 60_000;

export const SUPPORTED_WEBHOOK_EVENTS = [
  'rfq.created',
  'rfq.status.changed',
  'quotation.created',
  'quotation.submitted',
  'quotation.approved',
  'quotation.rejected',
  'quotation.sent',
  'quotation.withdrawn',
  'order.created',
  'order.status.changed',
  'inventory.created',
  'inventory.updated',
  'inventory.adjusted',
  'inventory.deleted',
  'inventory.reserved',
  'inventory.reservation.released',
  'inventory.outbound',
  'certificate.issued',
  'agent.task.completed',
  'agent.task.failed',
] as const;

export interface WebhookEventEnvelope {
  id: string;
  type: string;
  occurred_at: string;
  version: string;
  source: string;
  data: Record<string, unknown>;
}

export interface QueueWebhookEventOptions {
  /** Stable identifier supplied by the transactional outbox when applicable. */
  eventId?: string;
  /** Links each delivery to an outbox event for idempotent re-dispatch. */
  outboxEventId?: string;
  /** Preserve the business commit time rather than the worker execution time. */
  occurredAt?: Date;
  /** Legacy direct callers can still request immediate webhook delivery. */
  deliverImmediately?: boolean;
  /** Internal correlation only; never included in the external webhook body. */
  requestId?: string;
}

interface EndpointHeaders {
  [key: string]: string;
}

function tryParseHeaders(
  headers: string,
  headersJson?: Prisma.JsonValue | null,
): EndpointHeaders {
  return Object.entries(preferredJsonObject(headersJson, headers)).reduce<EndpointHeaders>((acc, [key, value]) => {
    if (typeof value === 'string' && key.trim()) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function scheduleNextRetry(attemptCount: number): Date {
  const seconds = Math.min(3600, 60 * Math.pow(2, Math.max(0, attemptCount - 1)));
  return new Date(Date.now() + seconds * 1000);
}

function buildSignature(secret: string, timestamp: string, payload: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.${payload}`);
  return hmac.digest('hex');
}

function getBodyPreview(input: string, maxLength = 2000): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength)}...(truncated)`;
}

function serializeEndpoint(endpoint: WebhookEndpoint) {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    method: endpoint.method,
    authType: endpoint.authType,
    customHeaders: tryParseHeaders(endpoint.customHeaders, endpoint.customHeadersJson),
    timeoutMs: endpoint.timeoutMs,
    maxRetries: endpoint.maxRetries,
    isActive: endpoint.isActive,
    lastSuccessAt: endpoint.lastSuccessAt,
    lastFailureAt: endpoint.lastFailureAt,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}

export function getSupportedWebhookEvents(): readonly string[] {
  return SUPPORTED_WEBHOOK_EVENTS;
}

export async function listWebhookEndpoints() {
  const endpoints = await prisma.webhookEndpoint.findMany({
    include: {
      subscriptions: {
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return endpoints.map((endpoint) => ({
    ...serializeEndpoint(endpoint),
    subscriptions: endpoint.subscriptions.map((s) => ({
      id: s.id,
      eventTypes: preferredJsonArray(s.eventTypesJson, s.eventTypes),
      isActive: s.isActive,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
  }));
}

export async function getWebhookEndpointById(id: string) {
  const endpoint = await prisma.webhookEndpoint.findUnique({
    where: { id },
    include: {
      subscriptions: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!endpoint) {
    return null;
  }

  return {
    ...serializeEndpoint(endpoint),
    subscriptions: endpoint.subscriptions.map(projectWebhookSubscription),
  };
}

export async function createWebhookEndpoint(input: {
  name: string;
  url: string;
  method?: 'POST' | 'PUT';
  authType?: 'none' | 'bearer';
  authToken?: string;
  secret?: string;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  isActive?: boolean;
}) {
  const customHeaders = buildJsonObjectShadow(input.customHeaders ?? {});
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      name: input.name,
      url: input.url,
      method: input.method ?? 'POST',
      authType: input.authType ?? 'none',
      authToken: input.authToken ? encrypt(input.authToken) : null,
      secret: input.secret ? encrypt(input.secret) : null,
      customHeaders: customHeaders.legacy,
      customHeadersJson: customHeaders.shadow,
      timeoutMs: input.timeoutMs ?? 10000,
      maxRetries: input.maxRetries ?? 3,
      isActive: input.isActive ?? true,
    },
  });

  return serializeEndpoint(endpoint);
}

export async function updateWebhookEndpoint(id: string, input: {
  name?: string;
  url?: string;
  method?: 'POST' | 'PUT';
  authType?: 'none' | 'bearer';
  authToken?: string;
  secret?: string;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  isActive?: boolean;
}) {
  const customHeaders = input.customHeaders === undefined
    ? undefined
    : buildJsonObjectShadow(input.customHeaders);
  const updateData: Record<string, unknown> = {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.url !== undefined && { url: input.url }),
    ...(input.method !== undefined && { method: input.method }),
    ...(input.authType !== undefined && { authType: input.authType }),
    ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
    ...(input.maxRetries !== undefined && { maxRetries: input.maxRetries }),
    ...(input.isActive !== undefined && { isActive: input.isActive }),
    ...(customHeaders && {
      customHeaders: customHeaders.legacy,
      customHeadersJson: customHeaders.shadow,
    }),
  };

  if (input.authToken !== undefined) {
    updateData.authToken = input.authToken ? encrypt(input.authToken) : null;
  }
  if (input.secret !== undefined) {
    updateData.secret = input.secret ? encrypt(input.secret) : null;
  }

  const endpoint = await prisma.webhookEndpoint.update({
    where: { id },
    data: updateData,
  });

  return serializeEndpoint(endpoint);
}

export async function replaceWebhookSubscriptions(endpointId: string, eventTypes: string[]) {
  const uniqueEventTypes = Array.from(new Set(eventTypes.map((e) => e.trim()).filter(Boolean)));
  const eventTypesJson = buildJsonArrayShadow(uniqueEventTypes);
  const filtersJson = buildJsonObjectShadow({ logic: 'AND', rules: [] });

  await prisma.$transaction(async (tx) => {
    await tx.webhookSubscription.deleteMany({ where: { endpointId } });
    if (uniqueEventTypes.length > 0) {
      await tx.webhookSubscription.create({
        data: {
          endpointId,
          eventTypes: eventTypesJson.legacy,
          eventTypesJson: eventTypesJson.shadow,
          filters: filtersJson.legacy,
          filtersJson: filtersJson.shadow,
          isActive: true,
        },
      });
    }
  });

  return prisma.webhookSubscription.findMany({
    where: { endpointId },
    orderBy: { createdAt: 'asc' },
  });
}

function buildDefaultEnvelope(
  eventType: string,
  data: Record<string, unknown>,
  options: Pick<QueueWebhookEventOptions, 'eventId' | 'occurredAt'> = {},
): WebhookEventEnvelope {
  return {
    id: options.eventId || crypto.randomUUID(),
    type: eventType,
    occurred_at: (options.occurredAt || new Date()).toISOString(),
    version: 'v1',
    source: 'aerolink',
    data,
  };
}

async function deliverOnce(delivery: WebhookDelivery & { endpoint: WebhookEndpoint }, workerId?: string) {
  const payload = delivery.payload;
  const endpoint = delivery.endpoint;
  const attemptCount = delivery.attemptCount + 1;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...tryParseHeaders(endpoint.customHeaders, endpoint.customHeadersJson),
  };

  const timestamp = Math.floor(Date.now() / 1000).toString();
  headers['X-Webhook-Id'] = delivery.eventId;
  headers['X-Webhook-Event'] = delivery.eventType;
  headers['X-Webhook-Timestamp'] = timestamp;

  if (endpoint.authType === 'bearer' && endpoint.authToken) {
    headers.Authorization = `Bearer ${decrypt(endpoint.authToken)}`;
  }

  if (endpoint.secret) {
    const signature = buildSignature(decrypt(endpoint.secret), timestamp, payload);
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);
  const deliveryWhere: Prisma.WebhookDeliveryWhereInput = workerId
    ? { id: delivery.id, status: 'processing', workerId }
    : { id: delivery.id };
  const finalize = async (
    data: Prisma.WebhookDeliveryUpdateManyMutationInput,
    endpointData: Prisma.WebhookEndpointUpdateInput,
  ) => prisma.$transaction(async (tx) => {
    const released = await tx.webhookDelivery.updateMany({ where: deliveryWhere, data });
    if (released.count !== 1) return false;
    await tx.webhookEndpoint.update({ where: { id: endpoint.id }, data: endpointData });
    return true;
  });

  try {
    const response = await fetch(endpoint.url, {
      method: endpoint.method || 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    });

    const responseText = await response.text();
    const requestHeaders = buildJsonObjectShadow(headers);
    const commonData = {
      attemptCount,
      requestHeaders: requestHeaders.legacy,
      requestHeadersJson: requestHeaders.shadow,
      responseStatus: response.status,
      responseBody: getBodyPreview(responseText),
      lastError: null,
      updatedAt: new Date(),
    };

    if (response.ok) {
      await finalize({
        ...commonData,
        status: 'success',
        deliveredAt: new Date(),
        nextRetryAt: null,
        lockedAt: null,
        workerId: null,
      }, { lastSuccessAt: new Date() });
      return;
    }

    const shouldRetry = attemptCount <= endpoint.maxRetries;
    await finalize({
      ...commonData,
      status: shouldRetry ? 'retrying' : 'failed',
      nextRetryAt: shouldRetry ? scheduleNextRetry(attemptCount) : null,
      deliveredAt: null,
      lockedAt: null,
      workerId: null,
      lastError: `HTTP_${response.status}`,
    }, { lastFailureAt: new Date() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const shouldRetry = attemptCount <= endpoint.maxRetries;
    const requestHeaders = buildJsonObjectShadow(headers);

    await finalize({
      attemptCount,
      requestHeaders: requestHeaders.legacy,
      requestHeadersJson: requestHeaders.shadow,
      status: shouldRetry ? 'retrying' : 'failed',
      nextRetryAt: shouldRetry ? scheduleNextRetry(attemptCount) : null,
      deliveredAt: null,
      lockedAt: null,
      workerId: null,
      responseStatus: null,
      responseBody: null,
      lastError: message,
      updatedAt: new Date(),
    }, { lastFailureAt: new Date() });
  } finally {
    clearTimeout(timer);
  }
}

async function deliverById(deliveryId: string, workerId?: string) {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });

  if (!delivery) {
    return;
  }

  if (workerId && (delivery.status !== 'processing' || delivery.workerId !== workerId)) {
    return;
  }

  if (!delivery.endpoint.isActive) {
    await prisma.webhookDelivery.updateMany({
      where: workerId ? { id: delivery.id, status: 'processing', workerId } : { id: delivery.id },
      data: {
        status: 'failed',
        lastError: 'Endpoint is inactive',
        nextRetryAt: null,
        lockedAt: null,
        workerId: null,
      },
    });
    return;
  }

  await deliverOnce(delivery, workerId);
}

/**
 * Materializes subscribed webhook deliveries. Outbox callers pass an
 * `outboxEventId`, making this operation safe to repeat after a worker crash.
 */
export async function queueWebhookEvent(
  eventType: string,
  data: Record<string, unknown>,
  options: QueueWebhookEventOptions = {},
) {
  const envelope = buildDefaultEnvelope(eventType, data, options);
  const payload = JSON.stringify(envelope);

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { isActive: true },
    include: {
      subscriptions: {
        where: { isActive: true },
      },
    },
  });

  const targets = endpoints.filter((endpoint) =>
    endpoint.subscriptions.some((subscription) => {
      const types = preferredJsonArray(subscription.eventTypesJson, subscription.eventTypes);
      return types.some((type) => type === eventType);
    })
  );

  if (targets.length === 0) {
    return { eventId: envelope.id, queued: 0 };
  }

  const deliveries = await prisma.$transaction(
    targets.map((endpoint) => {
      const requestHeaders = buildJsonObjectShadow({});
      const data = {
        endpointId: endpoint.id,
        outboxEventId: options.outboxEventId ?? null,
        eventId: envelope.id,
        eventType,
        payload,
        requestHeaders: requestHeaders.legacy,
        requestHeadersJson: requestHeaders.shadow,
        status: 'pending',
      };

      if (!options.outboxEventId) {
        return prisma.webhookDelivery.create({ data });
      }

      return prisma.webhookDelivery.upsert({
        where: {
          endpointId_outboxEventId: {
            endpointId: endpoint.id,
            outboxEventId: options.outboxEventId,
          },
        },
        create: data,
        update: {},
      });
    })
  );

  if (options.deliverImmediately) {
    for (const delivery of deliveries) {
      try {
        await deliverById(delivery.id);
      } catch (error) {
        logger.error({ error, deliveryId: delivery.id, eventType }, 'Webhook delivery execution failed');
      }
    }
  }

  return { eventId: envelope.id, queued: deliveries.length };
}

export function projectWebhookSubscription(subscription: WebhookSubscription) {
  const { eventTypesJson: _eventTypesJson, filtersJson: _filtersJson, ...legacySubscription } = subscription;
  return legacySubscription;
}

export function projectWebhookDelivery(delivery: WebhookDelivery) {
  const { requestHeadersJson: _requestHeadersJson, ...legacyDelivery } = delivery;
  return legacyDelivery;
}

/** Legacy convenience API for non-outbox routes. */
export async function emitWebhookEvent(eventType: string, data: Record<string, unknown>) {
  return queueWebhookEvent(eventType, data, { deliverImmediately: true });
}

export async function sendWebhookPing(endpointId: string) {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
  if (!endpoint) {
    return null;
  }

  const envelope = buildDefaultEnvelope('webhook.ping', {
    message: 'AeroLink webhook test event',
  });
  const requestHeaders = buildJsonObjectShadow({});

  const delivery = await prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      eventId: envelope.id,
      eventType: envelope.type,
      payload: JSON.stringify(envelope),
      requestHeaders: requestHeaders.legacy,
      requestHeadersJson: requestHeaders.shadow,
      status: 'pending',
    },
  });

  await deliverById(delivery.id);
  return delivery.id;
}

export async function listWebhookDeliveries(endpointId: string, page = 1, limit = 20) {
  const pageNum = Math.max(1, page);
  const pageSize = Math.min(100, Math.max(1, limit));
  const skip = (pageNum - 1) * pageSize;

  const [items, total] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where: { endpointId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.webhookDelivery.count({ where: { endpointId } }),
  ]);

  return {
    items: items.map(projectWebhookDelivery),
    pagination: {
      page: pageNum,
      limit: pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

export async function retryWebhookDelivery(deliveryId: string) {
  const existing = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!existing) {
    return null;
  }

  const requestHeaders = buildJsonObjectShadow({});
  const cloned = await prisma.webhookDelivery.create({
    data: {
      endpointId: existing.endpointId,
      eventId: existing.eventId,
      eventType: existing.eventType,
      payload: existing.payload,
      requestHeaders: requestHeaders.legacy,
      requestHeadersJson: requestHeaders.shadow,
      status: 'pending',
      attemptCount: 0,
      nextRetryAt: null,
    },
  });

  await deliverById(cloned.id);
  return cloned.id;
}

export async function processPendingWebhookRetries(limit = 50, workerId = DEFAULT_WEBHOOK_WORKER_ID) {
  const now = new Date();
  const staleLeaseCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  await prisma.webhookDelivery.updateMany({
    where: {
      status: 'processing',
      OR: [
        { lockedAt: { lt: staleLeaseCutoff } },
        { lockedAt: null, updatedAt: { lt: staleLeaseCutoff } },
      ],
    },
      data: {
        status: 'retrying',
        nextRetryAt: now,
        lockedAt: null,
        workerId: null,
      lastError: 'Recovered stale webhook worker claim',
    },
  });

  const jobs = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ['pending', 'retrying'] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  for (const job of jobs) {
    const claim = await prisma.webhookDelivery.updateMany({
      where: {
        id: job.id,
        status: { in: ['pending', 'retrying'] },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      data: { status: 'processing', workerId, lockedAt: new Date(), updatedAt: new Date() },
    });
    if (claim.count !== 1) continue;

    const heartbeat = workerId
      ? setInterval(() => {
          void prisma.webhookDelivery.updateMany({
            where: { id: job.id, status: 'processing', workerId },
            data: { lockedAt: new Date(), updatedAt: new Date() },
          }).catch((error) => {
            logger.warn({ error, deliveryId: job.id, workerId }, 'Webhook lease heartbeat failed');
          });
        }, WEBHOOK_LEASE_HEARTBEAT_MS)
      : undefined;

    try {
      await deliverById(job.id, workerId);
    } catch (error) {
      logger.error({ error, deliveryId: job.id }, 'Retry worker failed to process webhook delivery');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  return jobs.length;
}
