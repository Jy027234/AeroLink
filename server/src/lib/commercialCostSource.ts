import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { AppError } from '../middleware/errorHandler.js';
import { moneyValuesMatch, normalizeMoney, preferredMoneyValue } from './money.js';
import { assertUsdQuotationCurrency, normalizeQuotationCurrency, QUOTATION_CURRENCY } from './quotationApprovalPolicy.js';

export const COST_SOURCE_TYPES = ['SUPPLIER_QUOTE', 'INVENTORY_DETAIL', 'MANUAL'] as const;
export type CostSourceType = (typeof COST_SOURCE_TYPES)[number];

export const VERIFIED_CURRENCY_STATUS = 'VERIFIED';
export const HISTORICAL_CURRENCY_STATUS = 'HISTORICAL_UNVERIFIED';

type CostSourceInput = {
  costSourceType?: string | null;
  costSourceId?: string | null;
  costSourceReason?: string | null;
};

type RfqPartScope = {
  partNumber: string;
  quantity: number;
  alternatePartNumbers?: string | null;
};

type QuotationCostContext = CostSourceInput & {
  tx: Prisma.TransactionClient;
  rfqId: string;
  rfq: RfqPartScope;
  partNumber: string;
  quantity: number;
  costPrice: number;
  currency: unknown;
  quotationId?: string;
};

type CurrentQuotationCostContext = CostSourceInput & {
  id: string;
  rfqId?: string | null;
  partNumber: string;
  quantity: number;
  costPrice: number;
  currency: unknown;
  costSourceSnapshotJson?: string | null;
  costPriceDecimal?: Prisma.Decimal | null;
};

type CostSourceSnapshot = {
  type: CostSourceType;
  id: string | null;
  currency: typeof QUOTATION_CURRENCY;
  costPrice: number;
  partNumber: string | null;
  quantity: number | null;
  status: string | null;
  supplierId: string | null;
  capturedAt: string;
  reason: string | null;
};

function fail(message: string, statusCode = 400): never {
  throw new AppError(message, statusCode, 'BAD_REQUEST');
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeCostSourceType(value: unknown): CostSourceType | null {
  const normalized = normalizeText(value).toUpperCase();
  return COST_SOURCE_TYPES.includes(normalized as CostSourceType)
    ? normalized as CostSourceType
    : null;
}

export function parseAlternatePartNumbers(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }
  const text = normalizeText(value);
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(normalizeText).filter(Boolean);
  } catch {
    // Older records sometimes contain a comma-separated compatibility value.
  }
  return text.split(',').map(normalizeText).filter(Boolean);
}

export function isQuotationPartAllowed(partNumber: string, rfq: RfqPartScope) {
  return partNumber === rfq.partNumber || parseAlternatePartNumbers(rfq.alternatePartNumbers).includes(partNumber);
}

export function assertQuotationMatchesRfq(partNumber: string, quantity: number, rfq: RfqPartScope) {
  if (!isQuotationPartAllowed(partNumber, rfq)) {
    fail('报价件号必须与 RFQ 件号一致或明确属于 RFQ 的替代件号', 409);
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > rfq.quantity) {
    fail('报价数量不能超过 RFQ 需求数量', 409);
  }
}

function assertSourcePartMatchesQuotation(sourcePartNumber: string | null | undefined, partNumber: string, rfq: RfqPartScope) {
  if (!sourcePartNumber || sourcePartNumber !== partNumber || !isQuotationPartAllowed(sourcePartNumber, rfq)) {
    fail('报价成本来源件号与报价或 RFQ 替代件号不一致', 409);
  }
}

function sourceSnapshotHash(value: string | null | undefined) {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex');
}

export function hashCostSourceSnapshot(value: string | null | undefined) {
  return sourceSnapshotHash(value);
}

function parseSnapshot(value: string | null | undefined): CostSourceSnapshot | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as CostSourceSnapshot;
  } catch {
    return null;
  }
}

function buildSnapshot(args: {
  type: CostSourceType;
  id: string | null;
  costPrice: number;
  partNumber: string | null;
  quantity: number | null;
  status?: string | null;
  supplierId?: string | null;
  reason?: string | null;
}): CostSourceSnapshot {
  return {
    type: args.type,
    id: args.id,
    currency: QUOTATION_CURRENCY,
    costPrice: normalizeMoney(args.costPrice).toNumber(),
    partNumber: args.partNumber || null,
    quantity: args.quantity ?? null,
    status: args.status || null,
    supplierId: args.supplierId || null,
    capturedAt: new Date().toISOString(),
    reason: args.reason || null,
  };
}

function assertCurrentSourceSnapshot(quotation: {
  costSourceType?: string | null;
  costSourceId?: string | null;
  costSourceReason?: string | null;
  costSourceSnapshotJson?: string | null;
  costPrice: number;
  costPriceDecimal?: Prisma.Decimal | null;
}) {
  const sourceType = normalizeCostSourceType(quotation.costSourceType);
  if (!sourceType || !quotation.costSourceSnapshotJson) {
    fail('报价缺少可复核的成本来源，不能审批', 409);
  }
  if (sourceType === 'MANUAL' && !normalizeText(quotation.costSourceReason)) {
    fail('人工成本必须填写来源原因，不能审批', 409);
  }
  const snapshot = parseSnapshot(quotation.costSourceSnapshotJson);
  if (!snapshot || snapshot.type !== sourceType || snapshot.id !== (quotation.costSourceId || null)) {
    fail('报价成本来源快照不可复核，不能审批', 409);
  }
  const quotationCost = preferredMoneyValue(quotation.costPriceDecimal, quotation.costPrice);
  if (quotationCost == null || !moneyValuesMatch(snapshot.costPrice, quotationCost)) {
    fail('报价成本与成本来源快照不一致，请重新建立报价', 409);
  }
}

async function reservedQuantityByOthers(
  tx: Prisma.TransactionClient,
  inventoryDetailId: string,
  quotationId?: string,
) {
  const reservations = await tx.quotation.findMany({
    where: {
      inventoryDetailId,
      reservedQuantity: { gt: 0 },
      ...(quotationId ? { id: { not: quotationId } } : {}),
      status: { notIn: ['WITHDRAWN', 'REJECTED', 'CANCELLED'] },
    },
    select: { reservedQuantity: true },
  });
  return reservations.reduce((total, quotation) => total + quotation.reservedQuantity, 0);
}

async function captureSupplierQuote(args: QuotationCostContext): Promise<CostSourceSnapshot> {
  const sourceId = normalizeText(args.costSourceId);
  if (!sourceId) fail('供应商报价成本来源必须提供 supplier quote ID');
  const source = await args.tx.supplierQuote.findUnique({
    where: { id: sourceId },
    select: {
      id: true,
      rfqId: true,
      supplierId: true,
      partNumber: true,
      quantity: true,
      unitPrice: true,
      unitPriceDecimal: true,
      currency: true,
      currencyReviewStatus: true,
      validUntil: true,
      status: true,
      statusEnum: true,
    },
  });
  if (!source) fail('供应商报价成本来源不存在', 409);
  if (source.rfqId !== args.rfqId) fail('供应商报价成本来源不属于当前 RFQ', 409);
  if (normalizeQuotationCurrency(source.currency) !== QUOTATION_CURRENCY
    || source.currencyReviewStatus !== VERIFIED_CURRENCY_STATUS) {
    fail('历史供应商报价币种待核，不能作为审批成本来源', 409);
  }
  const sourceStatus = String(source.statusEnum || source.status || '').toLowerCase();
  if (sourceStatus === 'rejected' || sourceStatus === 'expired') {
    fail('供应商报价成本来源已失效，不能作为审批成本来源', 409);
  }
  if (source.validUntil && source.validUntil.getTime() <= Date.now()) {
    fail('供应商报价成本来源已过期，不能作为审批成本来源', 409);
  }
  assertSourcePartMatchesQuotation(source.partNumber, args.partNumber, args.rfq);
  if (source.quantity < args.quantity) fail('供应商报价来源数量不足', 409);
  const sourceUnitPrice = preferredMoneyValue(source.unitPriceDecimal, source.unitPrice) ?? 0;
  if (!moneyValuesMatch(sourceUnitPrice, args.costPrice)) {
    fail('报价成本必须等于供应商报价来源单价', 409);
  }
  return buildSnapshot({
    type: 'SUPPLIER_QUOTE',
    id: source.id,
    costPrice: sourceUnitPrice,
    partNumber: source.partNumber,
    quantity: source.quantity,
    status: sourceStatus,
    supplierId: source.supplierId,
  });
}

async function captureInventoryDetail(args: QuotationCostContext): Promise<CostSourceSnapshot> {
  const sourceId = normalizeText(args.costSourceId);
  if (!sourceId) fail('库存成本来源必须提供 inventory detail ID');
  const source = await args.tx.inventoryDetail.findUnique({
    where: { id: sourceId },
    include: { inventoryItem: { select: { partNumber: true } } },
  });
  if (!source) fail('库存成本来源不存在', 409);
  if (!['AVAILABLE', 'RESERVED'].includes(source.status)) {
    fail('库存成本来源当前不可用', 409);
  }
  if (String(source.type).toUpperCase() !== 'OWN') {
    fail('虚拟或在途库存不能直接作为自有成本来源', 409);
  }
  assertSourcePartMatchesQuotation(source.inventoryItem.partNumber, args.partNumber, args.rfq);
  const reservedByOthers = await reservedQuantityByOthers(args.tx, source.id, args.quotationId);
  if (source.quantity - reservedByOthers < args.quantity) {
    fail('库存成本来源可用数量不足（已排除当前报价自身预留）', 409);
  }
  if (!moneyValuesMatch(source.unitCost, args.costPrice)) {
    fail('报价成本必须等于库存成本来源单价', 409);
  }
  return buildSnapshot({
    type: 'INVENTORY_DETAIL',
    id: source.id,
    costPrice: source.unitCost,
    partNumber: source.inventoryItem.partNumber,
    quantity: source.quantity,
    status: source.status,
    supplierId: source.supplierId,
  });
}

function captureManual(args: QuotationCostContext): CostSourceSnapshot {
  if (normalizeText(args.costSourceId)) fail('人工成本不能填写伪造的来源 ID');
  const reason = normalizeText(args.costSourceReason);
  if (!reason) fail('人工成本必须填写来源原因');
  return buildSnapshot({
    type: 'MANUAL',
    id: null,
    costPrice: args.costPrice,
    partNumber: args.partNumber,
    quantity: args.quantity,
    reason,
  });
}

export async function captureQuotationCostSource(args: QuotationCostContext) {
  assertUsdQuotationCurrency(args.currency);
  assertQuotationMatchesRfq(args.partNumber, args.quantity, args.rfq);
  const sourceType = normalizeCostSourceType(args.costSourceType);
  if (!sourceType) fail('新报价必须明确可复核的成本来源');

  const snapshot = sourceType === 'SUPPLIER_QUOTE'
    ? await captureSupplierQuote(args)
    : sourceType === 'INVENTORY_DETAIL'
      ? await captureInventoryDetail(args)
      : captureManual(args);
  return {
    costSourceType: sourceType,
    costSourceId: snapshot.id,
    costSourceReason: snapshot.reason,
    costSourceSnapshotJson: JSON.stringify(snapshot),
    costSourceCapturedAt: new Date(snapshot.capturedAt),
  };
}

export function assertQuotationCostSourceSnapshot(quotation: Parameters<typeof assertCurrentSourceSnapshot>[0]) {
  assertCurrentSourceSnapshot(quotation);
}

export async function assertQuotationCostSourceCurrent(
  tx: Prisma.TransactionClient,
  quotation: CurrentQuotationCostContext,
) {
  assertCurrentSourceSnapshot(quotation);
  const sourceType = normalizeCostSourceType(quotation.costSourceType)!;
  const snapshot = parseSnapshot(quotation.costSourceSnapshotJson)!;
  if (sourceType === 'MANUAL') return;

  if (sourceType === 'SUPPLIER_QUOTE') {
    const current = await tx.supplierQuote.findUnique({
      where: { id: quotation.costSourceId! },
      select: {
        id: true, rfqId: true, supplierId: true, partNumber: true, quantity: true,
        unitPrice: true, unitPriceDecimal: true, currency: true,
        currencyReviewStatus: true, validUntil: true, status: true, statusEnum: true,
      },
    });
    if (!current) fail('报价成本来源已不存在，需重新建立报价', 409);
    if (current.rfqId !== quotation.rfqId
      || current.partNumber !== quotation.partNumber
      || normalizeQuotationCurrency(current.currency) !== QUOTATION_CURRENCY
      || current.currencyReviewStatus !== VERIFIED_CURRENCY_STATUS
      || ['rejected', 'expired'].includes(String(current.statusEnum || current.status || '').toLowerCase())) {
      fail('供应商报价成本来源已变化或待核，需重新建立报价', 409);
    }
    if (current.validUntil && current.validUntil.getTime() <= Date.now()) {
      fail('供应商报价成本来源已过期，需重新建立报价', 409);
    }
    if (current.quantity < quotation.quantity) {
      fail('供应商报价来源当前数量不足，不能审批', 409);
    }
    const currentPrice = preferredMoneyValue(current.unitPriceDecimal, current.unitPrice) ?? 0;
    if (!moneyValuesMatch(currentPrice, quotation.costPrice)) {
      fail('供应商报价成本来源已变价，需重新建立报价', 409);
    }
  } else {
    const current = await tx.inventoryDetail.findUnique({
      where: { id: quotation.costSourceId! },
      include: { inventoryItem: { select: { partNumber: true } } },
    });
    if (!current) fail('报价成本来源已不存在，需重新建立报价', 409);
    if (current.inventoryItem.partNumber !== quotation.partNumber
      || !['AVAILABLE', 'RESERVED'].includes(current.status)
      || String(current.type).toUpperCase() !== 'OWN') {
      fail('库存成本来源已变化或不可用，需重新建立报价', 409);
    }
    const reservedByOthers = await reservedQuantityByOthers(tx, current.id, quotation.id);
    if (current.quantity - reservedByOthers < quotation.quantity) {
      fail('库存成本来源当前可用数量不足，不能审批', 409);
    }
    if (!moneyValuesMatch(current.unitCost, quotation.costPrice)) {
      fail('库存成本来源已变价，需重新建立报价', 409);
    }
  }

  // This current-source check runs during the approval decision, so it does
  // compare the source quantity and availability above. Once approval has
  // succeeded, send/accept/order paths validate only the immutable snapshot;
  // later source consumption therefore does not change the approved cost.
  if (snapshot.currency !== QUOTATION_CURRENCY) {
    fail('报价成本来源快照币种待核，需重新建立报价', 409);
  }
}

export function supplierQuoteCurrencyStatus(currency: unknown, reviewStatus: unknown) {
  return normalizeQuotationCurrency(currency) === QUOTATION_CURRENCY
    && reviewStatus === VERIFIED_CURRENCY_STATUS
    ? VERIFIED_CURRENCY_STATUS
    : HISTORICAL_CURRENCY_STATUS;
}
