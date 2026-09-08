import { createHash } from 'node:crypto';
import { AppError } from '../middleware/errorHandler.js';
import { preferredMoneyValue } from './money.js';
import { normalizeRole } from './capabilityPolicy.js';
import { assertSupportedSaleType } from './commercialScope.js';

/**
 * The approval rules are intentionally small and explicit for the first USD
 * only release.  A policy version is stored with every decision so a future
 * rule change cannot silently make an old decision look current.
 */
export const QUOTATION_APPROVAL_POLICY_VERSION = '2026-09-08-usd-tier-v1';
export const QUOTATION_CURRENCY = 'USD';

export type QuotationApprovalLevel = 'MANAGER' | 'FINANCE' | 'GM';

export type QuotationApprovalActor = {
  actorId: string;
  actorRole?: string | null;
  creatorId: string;
  totalPrice: number;
  currency?: unknown;
};

export type QuotationApprovalSnapshot = {
  quoteNumber: string | null;
  rfqId: string | null;
  customerId: string | null;
  partNumber: string | null;
  quantity: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
  costPrice: number | null;
  margin: number | null;
  currency: string;
  template: string | null;
  saleType: string | null;
  shipToId: string | null;
  shipForId: string | null;
  incoterm: string | null;
  incotermLocation: string | null;
  leadTimeDays: number | null;
  leadTimeBasis: string | null;
  moq: number | null;
  mpq: number | null;
  priceBasis: string | null;
  taxIncluded: boolean | null;
  taxRate: number | null;
  warrantyDays: number | null;
  warrantyTerms: string | null;
  packagingRequirement: string | null;
  shippingMethod: string | null;
  countryOfOrigin: string | null;
  hsCode: string | null;
  eccn: string | null;
  dualUse: boolean | null;
  certificateFiles: string | null;
  commonNote: string | null;
  expiryDate: string | null;
  validityDeadline: string | null;
  rfqUrgency: string | null;
  costSourceType: string | null;
  costSourceId: string | null;
  costSourceReason: string | null;
  costSourceHash: string | null;
};

type QuotationApprovalSource = {
  quoteNumber?: unknown;
  rfqId?: unknown;
  customerId?: unknown;
  partNumber?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  unitPriceDecimal?: unknown;
  totalPrice?: unknown;
  totalPriceDecimal?: unknown;
  costPrice?: unknown;
  costPriceDecimal?: unknown;
  margin?: unknown;
  currency?: unknown;
  template?: unknown;
  saleType?: unknown;
  shipToId?: unknown;
  shipForId?: unknown;
  incoterm?: unknown;
  incotermLocation?: unknown;
  leadTimeDays?: unknown;
  leadTimeBasis?: unknown;
  moq?: unknown;
  mpq?: unknown;
  priceBasis?: unknown;
  taxIncluded?: unknown;
  taxRate?: unknown;
  warrantyDays?: unknown;
  warrantyTerms?: unknown;
  packagingRequirement?: unknown;
  shippingMethod?: unknown;
  countryOfOrigin?: unknown;
  hsCode?: unknown;
  eccn?: unknown;
  dualUse?: unknown;
  certificateFiles?: unknown;
  commonNote?: unknown;
  expiryDate?: unknown;
  validityDeadline?: unknown;
  rfq?: { urgency?: unknown } | null;
  costSourceType?: unknown;
  costSourceId?: unknown;
  costSourceReason?: unknown;
  costSourceSnapshotJson?: unknown;
};

export type QuotationApprovalRecord = {
  action?: unknown;
  level?: unknown;
  requiredLevel?: unknown;
  policyVersion?: unknown;
  snapshotJson?: unknown;
  createdAt?: unknown;
};

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableBoolean(value: unknown) {
  return value === null || value === undefined ? null : Boolean(value);
}

function nullableDate(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nullableHash(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return createHash('sha256').update(value).digest('hex');
}

function moneyValue(decimalValue: unknown, legacyValue: unknown) {
  try {
    return preferredMoneyValue(decimalValue as never, nullableNumber(legacyValue));
  } catch {
    return nullableNumber(legacyValue);
  }
}

export function normalizeQuotationCurrency(value: unknown): string {
  if (value === null || value === undefined || value === '') return QUOTATION_CURRENCY;
  return String(value).trim().toUpperCase();
}

export function assertUsdQuotationCurrency(value: unknown): 'USD' {
  const currency = normalizeQuotationCurrency(value);
  if (currency !== QUOTATION_CURRENCY) {
    throw new AppError('首期报价仅支持 USD 币种', 400, 'BAD_REQUEST');
  }
  return QUOTATION_CURRENCY;
}

export function requiredQuotationApprovalLevel(totalPrice: number): QuotationApprovalLevel {
  if (!Number.isFinite(totalPrice) || totalPrice < 0) {
    throw new AppError('报价总额必须是有效的非负金额', 400, 'BAD_REQUEST');
  }
  if (totalPrice <= 5_000) return 'MANAGER';
  if (totalPrice <= 50_000) return 'FINANCE';
  return 'GM';
}

export function isQuotationApprovalLevelSufficient(
  actorRole: string | null | undefined,
  requiredLevel: QuotationApprovalLevel,
) {
  const role = normalizeRole(actorRole);
  // System administration is deliberately separate from commercial approval
  // authority.  Only an explicitly designated GM may approve every tier.
  if (role === 'gm') return true;
  if (role === 'finance') return requiredLevel === 'MANAGER' || requiredLevel === 'FINANCE';
  return role === 'manager' && requiredLevel === 'MANAGER';
}

export function assertQuotationApprovalActor(args: QuotationApprovalActor): QuotationApprovalLevel {
  assertUsdQuotationCurrency(args.currency);
  if (args.actorId === args.creatorId) {
    throw new AppError('报价创建人不能审批自己的报价', 403, 'SELF_APPROVAL_FORBIDDEN');
  }
  const requiredLevel = requiredQuotationApprovalLevel(args.totalPrice);
  if (!isQuotationApprovalLevelSufficient(args.actorRole, requiredLevel)) {
    throw new AppError(`当前角色无权审批 ${requiredLevel} 级别报价`, 403, 'AUTH_FORBIDDEN');
  }
  return requiredLevel;
}

/**
 * The snapshot contains the immutable commercial inputs that determine the
 * customer promise and approval tier.  The mutable concurrency version is
 * deliberately absent; it is stored separately on Approval for audit only.
 */
export function buildQuotationApprovalSnapshot(source: QuotationApprovalSource): QuotationApprovalSnapshot {
  return {
    quoteNumber: nullableString(source.quoteNumber),
    rfqId: nullableString(source.rfqId),
    customerId: nullableString(source.customerId),
    partNumber: nullableString(source.partNumber),
    quantity: nullableNumber(source.quantity),
    unitPrice: moneyValue(source.unitPriceDecimal, source.unitPrice),
    totalPrice: moneyValue(source.totalPriceDecimal, source.totalPrice),
    costPrice: moneyValue(source.costPriceDecimal, source.costPrice),
    margin: nullableNumber(source.margin),
    currency: normalizeQuotationCurrency(source.currency),
    template: nullableString(source.template),
    saleType: nullableString(source.saleType),
    shipToId: nullableString(source.shipToId),
    shipForId: nullableString(source.shipForId),
    incoterm: nullableString(source.incoterm),
    incotermLocation: nullableString(source.incotermLocation),
    leadTimeDays: nullableNumber(source.leadTimeDays),
    leadTimeBasis: nullableString(source.leadTimeBasis),
    moq: nullableNumber(source.moq),
    mpq: nullableNumber(source.mpq),
    priceBasis: nullableString(source.priceBasis),
    taxIncluded: nullableBoolean(source.taxIncluded),
    taxRate: nullableNumber(source.taxRate),
    warrantyDays: nullableNumber(source.warrantyDays),
    warrantyTerms: nullableString(source.warrantyTerms),
    packagingRequirement: nullableString(source.packagingRequirement),
    shippingMethod: nullableString(source.shippingMethod),
    countryOfOrigin: nullableString(source.countryOfOrigin),
    hsCode: nullableString(source.hsCode),
    eccn: nullableString(source.eccn),
    dualUse: nullableBoolean(source.dualUse),
    certificateFiles: nullableString(source.certificateFiles),
    commonNote: nullableString(source.commonNote),
    expiryDate: nullableDate(source.expiryDate),
    validityDeadline: nullableDate(source.validityDeadline),
    rfqUrgency: nullableString(source.rfq?.urgency)?.toUpperCase() ?? null,
    costSourceType: nullableString(source.costSourceType),
    costSourceId: nullableString(source.costSourceId),
    costSourceReason: nullableString(source.costSourceReason),
    costSourceHash: nullableHash(source.costSourceSnapshotJson),
  };
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function hashQuotationApprovalSnapshot(snapshot: QuotationApprovalSnapshot | QuotationApprovalSource) {
  const normalized = 'unitPriceDecimal' in snapshot || 'totalPriceDecimal' in snapshot || 'costPriceDecimal' in snapshot
    ? buildQuotationApprovalSnapshot(snapshot)
    : snapshot;
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(normalized)))
    .digest('hex');
}

export function parseQuotationApprovalSnapshot(value: unknown): QuotationApprovalSnapshot | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as QuotationApprovalSnapshot;
  } catch {
    return null;
  }
}

function latestApproval(approvals: QuotationApprovalRecord[] | undefined) {
  return approvals?.slice().sort((left, right) => {
    const leftTime = left.createdAt ? new Date(String(left.createdAt)).getTime() : 0;
    const rightTime = right.createdAt ? new Date(String(right.createdAt)).getTime() : 0;
    return rightTime - leftTime;
  })[0];
}

/**
 * Checks the newest approval against the current immutable commercial inputs.
 * A missing or legacy record fails closed and can be repaired by approving
 * again while the quotation remains APPROVED.
 */
export function hasCurrentQuotationApproval(
  quotation: QuotationApprovalSource & { approvals?: QuotationApprovalRecord[] },
) {
  const approval = latestApproval(quotation.approvals);
  if (!approval || String(approval.action).toUpperCase() !== 'APPROVE') return false;
  if (approval.policyVersion !== QUOTATION_APPROVAL_POLICY_VERSION) return false;

  const currency = assertUsdQuotationCurrency(quotation.currency);
  const totalPrice = moneyValue(quotation.totalPriceDecimal, quotation.totalPrice) ?? Number.NaN;
  const requiredLevel = requiredQuotationApprovalLevel(totalPrice);
  if (approval.requiredLevel !== requiredLevel && approval.level !== requiredLevel) return false;

  const snapshot = parseQuotationApprovalSnapshot(approval.snapshotJson);
  if (!snapshot || normalizeQuotationCurrency(snapshot.currency) !== currency) return false;
  return hashQuotationApprovalSnapshot(snapshot) === hashQuotationApprovalSnapshot(buildQuotationApprovalSnapshot(quotation));
}

export function assertQuotationCommercialTerms(
  quotation: QuotationApprovalSource & { approvals?: QuotationApprovalRecord[] },
  now = new Date(),
) {
  assertSupportedSaleType(quotation.saleType);
  assertUsdQuotationCurrency(quotation.currency);
  const expiryDate = quotation.expiryDate || quotation.validityDeadline;
  const expiry = expiryDate ? new Date(String(expiryDate)) : null;
  if (!expiry || Number.isNaN(expiry.getTime()) || expiry.getTime() <= now.getTime()) {
    throw new AppError('报价已过期，不能继续发送、接受或创建订单', 409, 'BAD_REQUEST');
  }
  if (!hasCurrentQuotationApproval(quotation)) {
    throw new AppError('报价需要按当前审批策略重新审批后才能继续', 409, 'BAD_REQUEST');
  }
}
