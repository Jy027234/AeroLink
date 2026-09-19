import { Prisma } from '@prisma/client';
import {
  hasCapability,
  type CapabilityActor,
  type CapabilityResourceContext,
} from './capabilityPolicy.js';
import { parseQuotationApprovalSnapshot } from './quotationApprovalPolicy.js';

/**
 * The resource context used while shaping a response.  It deliberately only
 * contains the ownership facts needed by the capability policy; callers must
 * obtain it from the current record when replaying an idempotent request.
 */
export type ResponseResourceContext = CapabilityResourceContext;

const quotationCostFields = [
  'costPrice',
  'costPriceDecimal',
  'margin',
  'marginAmount',
  'marginPercent',
  'costTotal',
  'costTotalDecimal',
  'totalCost',
  'totalCostDecimal',
  // Cost-source identity and audit payload can reveal supplier pricing or
  // inventory cost even when the derived cost fields are removed.
  'costSourceType',
  'costSourceId',
  'costSourceReason',
  'costSourceSnapshotJson',
  'costSourceCapturedAt',
  'costSourceHash',
] as const;

const orderCostFields = [
  'importDuty',
  'importDutyDecimal',
  'vatAmount',
  'vatAmountDecimal',
  'totalLandCost',
  'totalLandCostDecimal',
  'exchangeCoreCharge',
  'exchangeCoreChargeDecimal',
  'exchangeCoreDueDate',
] as const;

// PDF bytes are a binary delivery artifact. They must never cross a JSON
// response projection, including for actors who can view commercial costs.
const binaryDocumentFields = ['pdfBytes'] as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function omitFields<T>(value: T, fields: readonly string[]): T {
  if (!isRecord(value)) return value;

  const projected = { ...value };
  for (const field of fields) {
    delete projected[field];
  }
  return projected as T;
}

function omitFieldsRecursively<T>(value: T, fields: readonly string[]): T {
  // Preserve scalar serializers: spreading Decimal exposes its internal d/e/s
  // representation and breaks line prices in both live and frozen responses.
  if (value instanceof Date || Prisma.Decimal.isDecimal(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => omitFieldsRecursively(item, fields)) as T;
  }
  if (!isRecord(value)) return value;

  const projected: RecordValue = {};
  for (const [key, nested] of Object.entries(value)) {
    if (fields.includes(key)) continue;
    projected[key] = omitFieldsRecursively(nested, fields);
  }
  return projected as T;
}

export function canViewQuotationCost(
  actor: CapabilityActor,
  resource: ResponseResourceContext,
) {
  return hasCapability(actor, 'quotation', 'view_cost', resource);
}

export function canViewOrderCost(
  actor: CapabilityActor,
  resource: ResponseResourceContext,
) {
  return hasCapability(actor, 'order', 'view_cost', resource);
}

/**
 * Removes quotation purchase cost and derived margin as one policy decision.
 * Keeping the decision here prevents list, detail, action and replay payloads
 * from drifting apart when a new response path is added.
 */
export function projectQuotationCost<T>(
  value: T,
  actor: CapabilityActor,
  resource: ResponseResourceContext,
): T {
  return canViewQuotationCost(actor, resource) ? value : omitFieldsRecursively(value, quotationCostFields);
}

/**
 * Approval snapshots are business evidence, not a bypass around the normal
 * quotation cost policy.  Keep the audit metadata and approver identity
 * useful while applying the same cost projection to the serialized snapshot.
 */
export function projectApprovalResponse<T>(
  value: T,
  actor: CapabilityActor,
  resource: ResponseResourceContext,
): T {
  if (!isRecord(value)) return value;

  const result = { ...(value as RecordValue) };
  if (isRecord(result.approver)) {
    result.approver = {
      id: result.approver.id,
      name: result.approver.name,
    };
  }

  if (typeof result.snapshotJson === 'string' && !canViewQuotationCost(actor, resource)) {
    const snapshot = parseQuotationApprovalSnapshot(result.snapshotJson);
    if (!snapshot) {
      delete result.snapshotJson;
    } else {
      result.snapshotJson = JSON.stringify(projectQuotationCost(snapshot, actor, resource));
    }
  }
  return result as T;
}

/**
 * Removes order landed cost fields as one policy decision.  The quotation
 * relation is handled by projectOrderResponse so nested costs cannot bypass
 * the order response policy.
 */
export function projectOrderCost<T>(
  value: T,
  actor: CapabilityActor,
  resource: ResponseResourceContext,
): T {
  return canViewOrderCost(actor, resource) ? value : omitFieldsRecursively(value, orderCostFields);
}

/**
 * Projects a quotation response and any order objects embedded in it.  The
 * resource context is intentionally supplied by the caller instead of being
 * inferred from a cached payload, which makes idempotent replays safe after a
 * role or ownership change.
 */
export function projectQuotationResponse<T>(
  value: T,
  actor: CapabilityActor,
  resource: ResponseResourceContext,
): T {
  const projected = omitFieldsRecursively(projectQuotationCost(value, actor, resource), binaryDocumentFields);
  if (!isRecord(projected)) return projected;

  const result = { ...(projected as RecordValue) };
  if (Array.isArray(result.orders)) {
    result.orders = result.orders.map((order) => projectOrderResponse(order, actor, resource));
  }
  if (isRecord(result.order)) {
    result.order = projectOrderResponse(result.order, actor, resource);
  }
  if (Array.isArray(result.approvals)) {
    result.approvals = result.approvals.map((approval) => projectApprovalResponse(approval, actor, resource));
  }
  return result as T;
}

/**
 * Projects an order response and its optional quotation relation.  This is
 * used for details, lists, mutation actions and cached idempotent responses.
 */
export function projectOrderResponse<T>(
  value: T,
  actor: CapabilityActor,
  resource: ResponseResourceContext,
): T {
  const projected = omitFieldsRecursively(projectOrderCost(value, actor, resource), binaryDocumentFields);
  if (!isRecord(projected)) return projected;

  const result = { ...(projected as RecordValue) };
  if (isRecord(result.quotation)) {
    result.quotation = projectQuotationResponse(result.quotation, actor, resource);
  }
  return result as T;
}
