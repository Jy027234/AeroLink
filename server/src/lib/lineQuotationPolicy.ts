import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { AppError } from '../middleware/errorHandler.js';
import {
  assertQuotationCostSourceSnapshot,
  assertQuotationMatchesRfq,
  captureQuotationCostSource,
  normalizeCostSourceType,
  parseAlternatePartNumbers,
} from './commercialCostSource.js';
import { moneyToNumber, type MoneyInput } from './money.js';
import { assertUsdQuotationCurrency } from './quotationApprovalPolicy.js';

/**
 * The line policy deliberately accepts the small, stable part of an RFQ line
 * instead of a Prisma model.  This lets the transaction service pass either a
 * full RfqLine row or a select projection without making the policy depend on
 * unrelated columns.
 */
export type QuotationRfqLineFacts = {
  id: string;
  rfqId: string;
  partNumber: string;
  quantity: number;
  alternatePartNumbers?: string | null;
};

export type QuotationLineCostInput = {
  partNumber: string;
  quantity: number;
  /** Optional display/commercial price carried by line service spreads. */
  unitPrice?: MoneyInput;
  costPrice: MoneyInput;
  currency?: unknown;
  costSourceType?: string | null;
  costSourceId?: string | null;
  costSourceReason?: string | null;
};

export type CaptureQuotationLineCostArgs = {
  tx: Prisma.TransactionClient;
  rfqId: string;
  rfqLine: QuotationRfqLineFacts;
  input: QuotationLineCostInput;
  quotationId?: string;
};

export type QuotationLineCostSnapshotRecord = QuotationLineCostInput & {
  /** Prisma relation projection; must mirror costSourceId when supplier-backed. */
  sourceSupplierQuoteId?: string | null;
  /** Existing fulfillment identity, retained here so cost-source projections can be checked together. */
  inventoryDetailId?: string | null;
  costSourceSnapshotJson?: string | null;
  costSourceCapturedAt?: Date | string | null;
};

/**
 * The line policy does not infer a source line from a part number.  A legacy
 * supplier quote with a NULL rfqLineId is accepted only when the RFQ currently
 * has exactly one line and that line is the line supplied by the caller.
 */
async function assertSupplierQuoteLineBinding(
  args: CaptureQuotationLineCostArgs,
  sourceId: string,
) {
  const source = await args.tx.supplierQuote.findUnique({
    where: { id: sourceId },
    select: {
      id: true,
      rfqId: true,
      rfqLineId: true,
    },
  });

  if (!source) {
    throw new AppError('供应商报价成本来源不存在', 409, 'RESOURCE_CONFLICT');
  }
  if (source.rfqId !== args.rfqId) {
    throw new AppError('供应商报价成本来源不属于当前 RFQ', 409, 'RESOURCE_CONFLICT');
  }
  if (source.rfqLineId) {
    if (source.rfqLineId !== args.rfqLine.id) {
      throw new AppError('供应商报价成本来源不属于当前 RFQ 行', 409, 'RESOURCE_CONFLICT');
    }
    return;
  }

  // A single supplier quote is not evidence that the RFQ has one line.  The
  // line cardinality is the only safe legacy disambiguation rule.
  const lineCount = await args.tx.rfqLine.count({ where: { rfqId: args.rfqId } });
  if (lineCount !== 1) {
    throw new AppError('历史供应商报价缺少 RFQ 行关联，当前 RFQ 多行时不能猜测来源行', 409, 'RESOURCE_CONFLICT');
  }
  const onlyLine = await args.tx.rfqLine.findFirst({
    where: { rfqId: args.rfqId },
    select: { id: true },
  });
  if (!onlyLine || onlyLine.id !== args.rfqLine.id) {
    throw new AppError('历史供应商报价不能明确绑定到当前 RFQ 行', 409, 'RESOURCE_CONFLICT');
  }
}

/**
 * Capture an immutable cost source for one quotation line.
 *
 * The existing quotation cost policy remains the source of truth for USD,
 * source validity, price, quantity and inventory reservation checks.  This
 * wrapper adds the line identity check before delegating to it.
 */
export async function captureQuotationLineCost(args: CaptureQuotationLineCostArgs) {
  if (args.rfqId !== args.rfqLine.rfqId) {
    throw new AppError('RFQ 行不属于当前 RFQ', 409, 'RESOURCE_CONFLICT');
  }
  if (!Number.isSafeInteger(args.rfqLine.quantity) || args.rfqLine.quantity <= 0) {
    throw new AppError('RFQ 行数量必须为正整数', 409, 'RESOURCE_CONFLICT');
  }

  const sourceType = normalizeCostSourceType(args.input.costSourceType);
  if (sourceType === 'SUPPLIER_QUOTE') {
    const sourceId = String(args.input.costSourceId || '').trim();
    if (!sourceId) {
      throw new AppError('供应商报价成本来源必须提供 supplier quote ID', 409, 'RESOURCE_CONFLICT');
    }
    await assertSupplierQuoteLineBinding(args, sourceId);
  }

  assertQuotationMatchesRfq(
    args.input.partNumber,
    args.input.quantity,
    {
      partNumber: args.rfqLine.partNumber,
      quantity: args.rfqLine.quantity,
      alternatePartNumbers: args.rfqLine.alternatePartNumbers,
    },
  );

  const captured = await captureQuotationCostSource({
    tx: args.tx,
    rfqId: args.rfqId,
    rfq: {
      partNumber: args.rfqLine.partNumber,
      quantity: args.rfqLine.quantity,
      alternatePartNumbers: args.rfqLine.alternatePartNumbers,
    },
    partNumber: args.input.partNumber,
    quantity: args.input.quantity,
    costPrice: moneyToNumber(args.input.costPrice),
    currency: args.input.currency,
    costSourceType: args.input.costSourceType,
    costSourceId: args.input.costSourceId,
    costSourceReason: args.input.costSourceReason,
    quotationId: args.quotationId,
  });

  return {
    ...captured,
    sourceSupplierQuoteId: sourceType === 'SUPPLIER_QUOTE'
      ? String(args.input.costSourceId)
      : null,
  };
}

/** Alias used by line creation code to make the immutable capture explicit. */
export const captureLineCostSnapshot = captureQuotationLineCost;

/**
 * Re-check a source during first approval.  The result is intentionally
 * discarded by callers: approving must not replace the original capturedAt or
 * source snapshot.  Later send/accept/order paths use assertLineCostSnapshot.
 */
export async function assertLineCostSourceCurrent(args: CaptureQuotationLineCostArgs) {
  await captureQuotationLineCost(args);
}

function parseLineSnapshot(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Check only the captured, immutable cost evidence.  No source row or current
 * quantity is queried here, so consuming/reserving the source after approval
 * cannot invalidate an already approved commercial line.
 */
export function assertLineCostSnapshot(line: QuotationLineCostSnapshotRecord) {
  assertUsdQuotationCurrency(line.currency);
  const snapshot = parseLineSnapshot(line.costSourceSnapshotJson);
  if (!snapshot) {
    throw new AppError('报价行缺少可复核的成本来源快照', 409, 'RESOURCE_CONFLICT');
  }

  const sourceType = normalizeCostSourceType(line.costSourceType);
  if (!sourceType || snapshot.type !== sourceType) {
    throw new AppError('报价行成本来源快照类型不一致', 409, 'RESOURCE_CONFLICT');
  }
  const expectedSourceId = sourceType === 'MANUAL' ? null : String(line.costSourceId || '');
  if ((snapshot.id || null) !== (expectedSourceId || null)) {
    throw new AppError('报价行成本来源快照 ID 不一致', 409, 'RESOURCE_CONFLICT');
  }
  const sourceSupplierQuoteId = line.sourceSupplierQuoteId ?? null;
  if (sourceType === 'SUPPLIER_QUOTE') {
    if (sourceSupplierQuoteId !== expectedSourceId) {
      throw new AppError('报价行供应商报价外键与成本来源 ID 不一致', 409, 'RESOURCE_CONFLICT');
    }
  } else if (sourceSupplierQuoteId !== null) {
    throw new AppError('非供应商成本来源不能携带供应商报价外键', 409, 'RESOURCE_CONFLICT');
  }
  if (snapshot.currency !== 'USD') {
    throw new AppError('报价行成本来源快照币种待核', 409, 'RESOURCE_CONFLICT');
  }
  if (snapshot.partNumber !== line.partNumber) {
    throw new AppError('报价行成本来源快照件号不一致', 409, 'RESOURCE_CONFLICT');
  }
  if (snapshot.quantity !== null && snapshot.quantity !== undefined
    && Number(snapshot.quantity) < line.quantity) {
    throw new AppError('报价行成本来源快照数量不足', 409, 'RESOURCE_CONFLICT');
  }
  if (sourceType === 'MANUAL') {
    const reason = String(line.costSourceReason || '').trim();
    if (!reason || snapshot.reason !== reason) {
      throw new AppError('报价行人工成本依据不一致', 409, 'RESOURCE_CONFLICT');
    }
  }

  // Reuse the established cost/price/source consistency check without
  // reaching back to the live supplier or inventory source.
  assertQuotationCostSourceSnapshot({
    costSourceType: line.costSourceType,
    costSourceId: line.costSourceId,
    costSourceReason: line.costSourceReason,
    costSourceSnapshotJson: line.costSourceSnapshotJson,
    costPrice: moneyToNumber(line.costPrice),
    costPriceDecimal: line.costPrice as Prisma.Decimal,
  });
  return snapshot;
}

const DYNAMIC_COMMERCIAL_KEYS = new Set([
  'version',
  'status',
  'statusenum',
  'reservedquantity',
  'acceptedquantity',
  'outboundquantity',
  'outboundstatus',
  'createdat',
  'updatedat',
  'approvedby',
  'approvedat',
  'sentat',
  'acceptedat',
  'withdrawnat',
  'withdrawalreason',
  'orderid',
  'ordernumber',
  'approvals',
  'approval',
  'approver',
  'approverid',
  'approvalid',
  'action',
  'reviewedversion',
  'iswinner',
  'lastemailstatus',
  'lastemailsentat',
  'snapshotjson',
]);

const MONEY_KEYS = new Set([
  'unitprice',
  'totalprice',
  'costprice',
  'margin',
  'linetotal',
  'linetotaldecimal',
  'marginamount',
  'marginpercent',
  'targetprice',
  'targetpricedecimal',
]);

function normalizedKey(key: string) {
  return key.replace(/[_-]/g, '').toLowerCase();
}

function canonicalDate(value: Date) {
  return value.toISOString();
}

function isDecimalLike(value: object) {
  const name = (value as { constructor?: { name?: string } }).constructor?.name || '';
  return name.toLowerCase().includes('decimal') && typeof (value as { toString?: unknown }).toString === 'function';
}

function canonicalizeJsonText(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    // A captured source snapshot is immutable evidence.  Sort and normalize
    // its representation, but do not apply the quotation lifecycle filter to
    // fields such as the source's captured status or quantity.
    return JSON.stringify(canonicalizeValue(parsed, undefined, false));
  } catch {
    return value;
  }
}

function canonicalizeValue(value: unknown, key?: string, stripDynamic = true): unknown {
  if (value instanceof Date) return canonicalDate(value);
  if (value && typeof value === 'object' && isDecimalLike(value)) {
    if (key && MONEY_KEYS.has(normalizedKey(key))) {
      try {
        return moneyToNumber(String(value));
      } catch {
        return String(value);
      }
    }
    return String(value);
  }
  if (typeof value === 'string' && key && normalizedKey(key).endsWith('snapshotjson')) {
    return canonicalizeJsonText(value);
  }
  if (Array.isArray(value)) return value.map((item) => canonicalizeValue(item, undefined, stripDynamic));
  if (!value || typeof value !== 'object') {
    if (key && MONEY_KEYS.has(normalizedKey(key)) && (typeof value === 'number' || typeof value === 'string')) {
      try {
        return moneyToNumber(value as MoneyInput);
      } catch {
        return value;
      }
    }
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([entryKey]) => !stripDynamic || !DYNAMIC_COMMERCIAL_KEYS.has(normalizedKey(entryKey)))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, entryValue]) => [entryKey, canonicalizeValue(entryValue, entryKey, stripDynamic)]),
  );
}

function stableLineSort(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftNo = Number(left.lineNo);
  const rightNo = Number(right.lineNo);
  if (Number.isFinite(leftNo) && Number.isFinite(rightNo) && leftNo !== rightNo) return leftNo - rightNo;
  if (Number.isFinite(leftNo) !== Number.isFinite(rightNo)) return Number.isFinite(leftNo) ? -1 : 1;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

export type CommercialApprovalSnapshot = {
  headerTerms: Record<string, unknown>;
  lines: Record<string, unknown>[];
};

export type CommercialApprovalSnapshotInput = {
  headerTerms: Record<string, unknown>;
  lines: readonly Record<string, unknown>[];
};

/**
 * Build the immutable commercial evidence used by multi-line approval.  The
 * caller may pass full Prisma records; lifecycle and reservation fields are
 * removed recursively while prices, source IDs and captured source evidence
 * remain available to finance/GM audit projections.
 */
export function buildCommercialApprovalSnapshot(
  input: CommercialApprovalSnapshotInput,
): CommercialApprovalSnapshot {
  const headerTerms = canonicalizeValue(input.headerTerms) as Record<string, unknown>;
  const lines = input.lines
    .map((line) => canonicalizeValue(line) as Record<string, unknown>)
    .sort(stableLineSort);
  return { headerTerms, lines };
}

export function hashCommercialApprovalSnapshot(
  input: CommercialApprovalSnapshot | CommercialApprovalSnapshotInput,
) {
  const snapshot = 'headerTerms' in input && 'lines' in input
    ? input
    : buildCommercialApprovalSnapshot(input);
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeValue(snapshot)))
    .digest('hex');
}

export function isCommercialApprovalSnapshotCurrent(
  snapshot: CommercialApprovalSnapshot,
  current: CommercialApprovalSnapshotInput,
) {
  return hashCommercialApprovalSnapshot(snapshot) === hashCommercialApprovalSnapshot(
    buildCommercialApprovalSnapshot(current),
  );
}

export function assertCommercialApprovalSnapshotCurrent(
  snapshot: CommercialApprovalSnapshot,
  current: CommercialApprovalSnapshotInput,
) {
  if (!isCommercialApprovalSnapshotCurrent(snapshot, current)) {
    throw new AppError('报价商业条款或报价行已变化，需要重新审批', 409, 'RESOURCE_CONFLICT');
  }
  return snapshot;
}

/** Exposed for tests and callers that need to validate alternate matching. */
export function isLinePartAllowed(line: QuotationRfqLineFacts, partNumber: string) {
  return line.partNumber === partNumber || parseAlternatePartNumbers(line.alternatePartNumbers).includes(partNumber);
}
