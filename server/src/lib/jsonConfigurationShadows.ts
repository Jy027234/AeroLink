import type { Prisma } from '@prisma/client';

export type JsonShape = 'object' | 'array';

type JsonContainer = Prisma.JsonObject | Prisma.JsonArray;

function isJsonObject(value: unknown): value is Prisma.JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isJsonArray(value: unknown): value is Prisma.JsonArray {
  return Array.isArray(value);
}

function matchesShape(value: unknown, shape: JsonShape): value is JsonContainer {
  return shape === 'object' ? isJsonObject(value) : isJsonArray(value);
}

export function parseLegacyJson(
  legacyValue: string | null | undefined,
  shape: JsonShape,
): JsonContainer | null {
  if (typeof legacyValue !== 'string') return null;

  try {
    const parsed: unknown = JSON.parse(legacyValue);
    return matchesShape(parsed, shape) ? parsed : null;
  } catch {
    return null;
  }
}

export function preferredJsonObject(
  shadowValue: Prisma.JsonValue | null | undefined,
  legacyValue: string | null | undefined,
): Prisma.JsonObject {
  if (isJsonObject(shadowValue)) return shadowValue;
  const legacy = parseLegacyJson(legacyValue, 'object');
  return isJsonObject(legacy) ? legacy : {};
}

export function preferredJsonArray(
  shadowValue: Prisma.JsonValue | null | undefined,
  legacyValue: string | null | undefined,
): Prisma.JsonArray {
  if (isJsonArray(shadowValue)) return shadowValue;
  const legacy = parseLegacyJson(legacyValue, 'array');
  return isJsonArray(legacy) ? legacy : [];
}

function buildJsonShadow(value: unknown, shape: JsonShape) {
  const legacy = JSON.stringify(value);
  const normalized = parseLegacyJson(legacy, shape);
  if (!normalized) {
    throw new TypeError(`Expected a JSON ${shape} value`);
  }
  return { legacy, normalized };
}

export function buildJsonObjectShadow(value: Record<string, unknown>) {
  const { legacy, normalized } = buildJsonShadow(value, 'object');
  return {
    legacy,
    shadow: normalized as Prisma.InputJsonObject,
  };
}

export function buildJsonArrayShadow(value: unknown[]) {
  const { legacy, normalized } = buildJsonShadow(value, 'array');
  return {
    legacy,
    shadow: normalized as Prisma.InputJsonArray,
  };
}

function canonicalJson(value: Prisma.JsonValue): Prisma.JsonValue {
  if (isJsonArray(value)) {
    return value.map((entry) => canonicalJson(entry)) as Prisma.JsonArray;
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry as Prisma.JsonValue)]),
    ) as Prisma.JsonObject;
  }
  return value;
}

function canonicalJsonString(value: JsonContainer): string {
  return JSON.stringify(canonicalJson(value));
}

export type JsonConfigurationShadowEntity =
  | 'webhookEndpoint'
  | 'webhookSubscription'
  | 'webhookDelivery'
  | 'webhookReplayBatch'
  | 'workflowInstance'
  | 'workflowAction'
  | 'apiKey';

export interface JsonConfigurationShadowRecord {
  entity: JsonConfigurationShadowEntity;
  id: string;
  field: string;
  shape: JsonShape;
  legacyValue: string;
  shadowValue: Prisma.JsonValue | null | undefined;
}

export interface JsonConfigurationShadowIssue extends JsonConfigurationShadowRecord {
  reason: 'MISSING_SHADOW' | 'INVALID_LEGACY_JSON' | 'INVALID_SHADOW_JSON' | 'MISMATCH';
}

export interface JsonConfigurationShadowReconciliationResult {
  status: 'PASS' | 'FAIL';
  checkedValues: number;
  missingShadows: number;
  invalidLegacyJson: number;
  invalidShadowJson: number;
  mismatchedValues: number;
  issues: JsonConfigurationShadowIssue[];
}

export function reconcileJsonConfigurationShadows(
  records: JsonConfigurationShadowRecord[],
): JsonConfigurationShadowReconciliationResult {
  const issues: JsonConfigurationShadowIssue[] = [];
  let missingShadows = 0;
  let invalidLegacyJson = 0;
  let invalidShadowJson = 0;
  let mismatchedValues = 0;

  for (const record of records) {
    const legacy = parseLegacyJson(record.legacyValue, record.shape);
    if (!legacy) {
      invalidLegacyJson += 1;
      issues.push({ ...record, reason: 'INVALID_LEGACY_JSON' });
      continue;
    }

    if (record.shadowValue === null || record.shadowValue === undefined) {
      missingShadows += 1;
      issues.push({ ...record, reason: 'MISSING_SHADOW' });
      continue;
    }

    if (!matchesShape(record.shadowValue, record.shape)) {
      invalidShadowJson += 1;
      issues.push({ ...record, reason: 'INVALID_SHADOW_JSON' });
      continue;
    }

    if (canonicalJsonString(legacy) !== canonicalJsonString(record.shadowValue)) {
      mismatchedValues += 1;
      issues.push({ ...record, reason: 'MISMATCH' });
    }
  }

  return {
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    checkedValues: records.length,
    missingShadows,
    invalidLegacyJson,
    invalidShadowJson,
    mismatchedValues,
    issues,
  };
}

export async function loadJsonConfigurationShadowReconciliation() {
  const { default: prisma } = await import('./prisma.js');
  const [
    endpoints,
    subscriptions,
    deliveries,
    replayBatches,
    workflowInstances,
    workflowActions,
    apiKeys,
  ] = await Promise.all([
    prisma.webhookEndpoint.findMany({ select: { id: true, customHeaders: true, customHeadersJson: true } }),
    prisma.webhookSubscription.findMany({ select: { id: true, eventTypes: true, eventTypesJson: true, filters: true, filtersJson: true } }),
    prisma.webhookDelivery.findMany({ select: { id: true, requestHeaders: true, requestHeadersJson: true } }),
    prisma.webhookReplayBatch.findMany({ select: { id: true, filterQuery: true, filterQueryJson: true, deliveryIds: true, deliveryIdsJson: true } }),
    prisma.workflowInstance.findMany({ select: { id: true, context: true, contextJson: true } }),
    prisma.workflowAction.findMany({ select: { id: true, payload: true, payloadJson: true } }),
    prisma.apiKey.findMany({ select: { id: true, scopes: true, scopesJson: true } }),
  ]);

  return reconcileJsonConfigurationShadows([
    ...endpoints.map((endpoint) => ({
      entity: 'webhookEndpoint' as const,
      id: endpoint.id,
      field: 'customHeaders',
      shape: 'object' as const,
      legacyValue: endpoint.customHeaders,
      shadowValue: endpoint.customHeadersJson,
    })),
    ...subscriptions.flatMap((subscription) => [
      {
        entity: 'webhookSubscription' as const,
        id: subscription.id,
        field: 'eventTypes',
        shape: 'array' as const,
        legacyValue: subscription.eventTypes,
        shadowValue: subscription.eventTypesJson,
      },
      {
        entity: 'webhookSubscription' as const,
        id: subscription.id,
        field: 'filters',
        shape: 'object' as const,
        legacyValue: subscription.filters,
        shadowValue: subscription.filtersJson,
      },
    ]),
    ...deliveries.map((delivery) => ({
      entity: 'webhookDelivery' as const,
      id: delivery.id,
      field: 'requestHeaders',
      shape: 'object' as const,
      legacyValue: delivery.requestHeaders,
      shadowValue: delivery.requestHeadersJson,
    })),
    ...replayBatches.flatMap((batch) => [
      {
        entity: 'webhookReplayBatch' as const,
        id: batch.id,
        field: 'filterQuery',
        shape: 'object' as const,
        legacyValue: batch.filterQuery,
        shadowValue: batch.filterQueryJson,
      },
      {
        entity: 'webhookReplayBatch' as const,
        id: batch.id,
        field: 'deliveryIds',
        shape: 'array' as const,
        legacyValue: batch.deliveryIds,
        shadowValue: batch.deliveryIdsJson,
      },
    ]),
    ...workflowInstances.map((instance) => ({
      entity: 'workflowInstance' as const,
      id: instance.id,
      field: 'context',
      shape: 'object' as const,
      legacyValue: instance.context,
      shadowValue: instance.contextJson,
    })),
    ...workflowActions.map((action) => ({
      entity: 'workflowAction' as const,
      id: action.id,
      field: 'payload',
      shape: 'object' as const,
      legacyValue: action.payload,
      shadowValue: action.payloadJson,
    })),
    ...apiKeys.map((apiKey) => ({
      entity: 'apiKey' as const,
      id: apiKey.id,
      field: 'scopes',
      shape: 'array' as const,
      legacyValue: apiKey.scopes,
      shadowValue: apiKey.scopesJson,
    })),
  ]);
}
