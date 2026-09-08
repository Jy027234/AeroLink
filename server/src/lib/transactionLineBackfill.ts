import { calculateMoneyTotal, normalizeMoney, type MoneyInput } from './money.js';
import {
  assessTransactionLineMigration,
  isExplicitDemandPart,
  type LinePreflightInput,
} from './transactionLinePreflight.js';
import { quotationLineStatus, rfqLineStatus } from './transactionLineStateProjection.js';

type LegacyRfq = LinePreflightInput['rfqs'][number] & {
  uom: string;
  conditionCode: string;
  description: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
  alternatePartNumbers: string | null;
  certificateType: string | null;
  leadTimeDays: number | null;
  targetPrice: number | null;
  status: string;
};

type LegacyInquiry = LinePreflightInput['inquiries'][number] & { rfqId: string | null };
type LegacyInquiryItem = LinePreflightInput['inquiryItems'][number] & { lineNo?: number; rfqLineId: string | null };
type LegacySupplierQuote = LinePreflightInput['supplierQuotes'][number] & {
  description: string | null;
  validUntil: Date | null;
  status: string;
  isWinner: boolean;
  rfqLineId: string | null;
  inquiryItemId: string | null;
};
type LegacyQuotation = LinePreflightInput['quotations'][number] & {
  reservedQuantity: number;
  inventoryDetailId: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
  status: string;
  costSourceType: string | null;
  costSourceId: string | null;
};
type LegacyOrder = LinePreflightInput['orders'][number] & {
  inventoryDetailId: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
  outboundStatus: string;
};

export type TransactionLineBackfillInput = {
  preflight: LinePreflightInput;
  rfqs: LegacyRfq[];
  inquiries: LegacyInquiry[];
  inquiryItems: LegacyInquiryItem[];
  supplierQuotes: LegacySupplierQuote[];
  quotations: LegacyQuotation[];
  orders: LegacyOrder[];
  existingRfqLines?: ExistingRfqLine[];
  existingQuotationLines?: ExistingQuotationLine[];
  existingOrderLines?: ExistingOrderLine[];
};

export type ExistingRfqLine = {
  id: string;
  rfqId: string;
  lineNo: number;
  partNumber: string;
  quantity: number;
  uom: string;
  conditionCode: string;
  description: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
  alternatePartNumbers: string | null;
  certificateRequired: boolean;
  certificateType: string | null;
  requiredDate: Date;
  leadTimeDays: number | null;
  targetPriceDecimal: MoneyInput | null;
  targetPriceCurrency: string;
  status: string;
};

export type ExistingQuotationLine = {
  id: string;
  quotationId: string;
  lineNo: number;
  rfqLineId: string;
  quantity: number;
  partNumber: string;
  description: string | null;
  uom: string;
  unitPrice: MoneyInput;
  costPrice: MoneyInput;
  lineTotal: MoneyInput;
  marginAmount: MoneyInput;
  marginPercent: MoneyInput;
  currency: string;
  status: string;
  acceptedQuantity: number;
  reservedQuantity: number;
  inventoryDetailId: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
  sourceSupplierQuoteId: string | null;
};

export type ExistingOrderLine = {
  id: string;
  orderId: string;
  lineNo: number;
  quotationLineId: string;
  partNumber: string;
  uom: string;
  quantity: number;
  unitPrice: MoneyInput;
  lineTotal: MoneyInput;
  currency: string;
  outboundQuantity: number;
  outboundStatus: string;
  inventoryDetailId: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
};

export type RfqLineCreate = Omit<ExistingRfqLine, 'id'> & { id: string };
export type QuotationLineCreate = Omit<ExistingQuotationLine, 'id'> & { id: string };
export type OrderLineCreate = Omit<ExistingOrderLine, 'id'> & { id: string };

export type TransactionLineBackfillIssue = {
  entity: string;
  id: string;
  code: string;
  severity: 'BLOCKER' | 'REVIEW';
  relatedIds?: string[];
};

export type TransactionLineBackfillPlan = {
  status: 'READY' | 'REVIEW_REQUIRED' | 'BLOCKED';
  preflight: ReturnType<typeof assessTransactionLineMigration>;
  issues: TransactionLineBackfillIssue[];
  rfqLines: RfqLineCreate[];
  quotationLines: QuotationLineCreate[];
  orderLines: OrderLineCreate[];
  inquiryItemLinks: Array<{ id: string; rfqLineId: string }>;
  supplierQuoteLinks: Array<{ id: string; rfqLineId?: string; inquiryItemId?: string }>;
  skippedExisting: { rfqLines: number; quotationLines: number; orderLines: number };
};

const safeSourceReviewCodes = new Set([
  'UNCONFIRMED_SOURCE_CANDIDATE',
  'NO_SINGLE_SOURCE_ITEM',
  'NO_SOURCE_CANDIDATE',
  'AMBIGUOUS_SOURCE_CANDIDATES',
  'LEGACY_UNLINKED',
  'INQUIRY_ITEM_UNRESOLVED',
  // RFQ target-price currency is an independent historical fact. Preserve it
  // on RfqLine and report non-USD for review; never convert or reject the row.
  'NON_USD_TARGET',
]);

function issue(
  issues: TransactionLineBackfillIssue[],
  entity: string,
  id: string,
  code: string,
  severity: TransactionLineBackfillIssue['severity'] = 'BLOCKER',
  relatedIds?: string[],
) {
  issues.push({ entity, id, code, severity, ...(relatedIds ? { relatedIds } : {}) });
}

function moneyText(value: MoneyInput): string {
  return normalizeMoney(value).toFixed(4);
}

function optionalMoneyText(value: MoneyInput | null | undefined): string | null {
  return value === null || value === undefined ? null : moneyText(value);
}

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function sameRfqLine(existing: ExistingRfqLine, expected: RfqLineCreate): boolean {
  return existing.rfqId === expected.rfqId
    && existing.lineNo === expected.lineNo
    && existing.partNumber === expected.partNumber
    && existing.quantity === expected.quantity
    && existing.uom === expected.uom
    && existing.conditionCode === expected.conditionCode
    && existing.description === expected.description
    && existing.serialNumber === expected.serialNumber
    && existing.batchNumber === expected.batchNumber
    && existing.alternatePartNumbers === expected.alternatePartNumbers
    && existing.certificateRequired === expected.certificateRequired
    && existing.certificateType === expected.certificateType
    && sameDate(existing.requiredDate, expected.requiredDate)
    && existing.leadTimeDays === expected.leadTimeDays
    && optionalMoneyText(existing.targetPriceDecimal) === optionalMoneyText(expected.targetPriceDecimal)
    && existing.targetPriceCurrency === expected.targetPriceCurrency
    && existing.status === expected.status;
}

function sameQuotationLine(existing: ExistingQuotationLine, expected: QuotationLineCreate): boolean {
  return existing.quotationId === expected.quotationId
    && existing.lineNo === expected.lineNo
    && existing.rfqLineId === expected.rfqLineId
    && existing.quantity === expected.quantity
    && existing.partNumber === expected.partNumber
    && existing.description === expected.description
    && existing.uom === expected.uom
    && moneyText(existing.unitPrice) === moneyText(expected.unitPrice)
    && moneyText(existing.costPrice) === moneyText(expected.costPrice)
    && moneyText(existing.lineTotal) === moneyText(expected.lineTotal)
    && moneyText(existing.marginAmount) === moneyText(expected.marginAmount)
    && moneyText(existing.marginPercent) === moneyText(expected.marginPercent)
    && existing.currency === expected.currency
    && existing.status === expected.status
    && existing.acceptedQuantity === expected.acceptedQuantity
    && existing.reservedQuantity === expected.reservedQuantity
    && existing.inventoryDetailId === expected.inventoryDetailId
    && existing.serialNumber === expected.serialNumber
    && existing.batchNumber === expected.batchNumber
    && existing.sourceSupplierQuoteId === expected.sourceSupplierQuoteId;
}

function sameOrderLine(existing: ExistingOrderLine, expected: OrderLineCreate): boolean {
  return existing.orderId === expected.orderId
    && existing.lineNo === expected.lineNo
    && existing.quotationLineId === expected.quotationLineId
    && existing.partNumber === expected.partNumber
    && existing.uom === expected.uom
    && existing.quantity === expected.quantity
    && moneyText(existing.unitPrice) === moneyText(expected.unitPrice)
    && moneyText(existing.lineTotal) === moneyText(expected.lineTotal)
    && existing.currency === expected.currency
    && existing.outboundQuantity === expected.outboundQuantity
    && existing.outboundStatus === expected.outboundStatus
    && existing.inventoryDetailId === expected.inventoryDetailId
    && existing.serialNumber === expected.serialNumber
    && existing.batchNumber === expected.batchNumber;
}

function adoptOrCreate<T extends { id: string }>(
  expected: T,
  existing: T | undefined,
  same: (existing: T, expected: T) => boolean,
  entity: string,
  issues: TransactionLineBackfillIssue[],
): { value: T; created: boolean } {
  if (!existing) return { value: expected, created: true };
  if (!same(existing, expected)) {
    issue(issues, entity, existing.id, 'EXISTING_LINE_MISMATCH');
  }
  return { value: { ...expected, id: existing.id }, created: false };
}

export function canApplyTransactionLinePreflight(report: ReturnType<typeof assessTransactionLineMigration>) {
  const blocking = report.issues.filter((entry) => entry.severity === 'BLOCKER' || !safeSourceReviewCodes.has(entry.code));
  return {
    allowed: blocking.length === 0,
    blockingIssues: blocking,
    unresolvedSourceReviews: report.issues.filter((entry) => !blocking.includes(entry)),
  };
}

export function buildTransactionLineBackfillPlan(
  input: TransactionLineBackfillInput,
  idFactory: (kind: 'rfq' | 'quotation' | 'order', parentId: string) => string = (kind, parentId) => `${kind}-line-${parentId}`,
): TransactionLineBackfillPlan {
  const preflight = assessTransactionLineMigration(input.preflight);
  const issues: TransactionLineBackfillIssue[] = [];
  const gate = canApplyTransactionLinePreflight(preflight);
  if (!gate.allowed) {
    return {
      status: 'BLOCKED',
      preflight,
      issues: gate.blockingIssues,
      rfqLines: [],
      quotationLines: [],
      orderLines: [],
      inquiryItemLinks: [],
      supplierQuoteLinks: [],
      skippedExisting: { rfqLines: 0, quotationLines: 0, orderLines: 0 },
    };
  }

  const existingRfqByParent = new Map(
    (input.existingRfqLines ?? []).filter((line) => line.lineNo === 1).map((line) => [line.rfqId, line]),
  );
  const existingQuotationByParent = new Map(
    (input.existingQuotationLines ?? []).filter((line) => line.lineNo === 1).map((line) => [line.quotationId, line]),
  );
  const existingOrderByParent = new Map(
    (input.existingOrderLines ?? []).filter((line) => line.lineNo === 1).map((line) => [line.orderId, line]),
  );
  const rfqLineByRfqId = new Map<string, RfqLineCreate>();
  const quotationLineByQuotationId = new Map<string, QuotationLineCreate>();
  const orderLineByOrderId = new Map<string, OrderLineCreate>();
  let skippedRfqLines = 0;
  let skippedQuotationLines = 0;
  let skippedOrderLines = 0;

  for (const rfq of input.rfqs) {
    let targetPriceDecimal: string | null = null;
    if (rfq.targetPrice !== null && rfq.targetPrice !== undefined) {
      try {
        targetPriceDecimal = moneyText(rfq.targetPrice);
      } catch {
        issue(issues, 'rfqs', rfq.id, 'INVALID_TARGET_PRICE');
      }
    }
    const expected: RfqLineCreate = {
      id: idFactory('rfq', rfq.id),
      rfqId: rfq.id,
      lineNo: 1,
      partNumber: rfq.partNumber,
      quantity: rfq.quantity,
      uom: rfq.uom,
      conditionCode: rfq.conditionCode,
      description: rfq.description,
      serialNumber: rfq.serialNumber,
      batchNumber: rfq.batchNumber,
      alternatePartNumbers: rfq.alternatePartNumbers,
      certificateRequired: rfq.certificateRequired,
      certificateType: rfq.certificateType,
      requiredDate: rfq.requiredDate,
      leadTimeDays: rfq.leadTimeDays,
      targetPriceDecimal,
      targetPriceCurrency: rfq.targetPriceCurrency,
      status: rfqLineStatus(rfq.status),
    };
    const adopted = adoptOrCreate(expected, existingRfqByParent.get(rfq.id), sameRfqLine, 'rfqLines', issues);
    if (!adopted.created) skippedRfqLines += 1;
    rfqLineByRfqId.set(rfq.id, adopted.value);
  }

  const inquiryById = new Map(input.inquiries.map((inquiry) => [inquiry.id, inquiry]));
  const itemsByInquiry = new Map<string, LegacyInquiryItem[]>();
  for (const item of input.inquiryItems) {
    itemsByInquiry.set(item.inquiryId, [...(itemsByInquiry.get(item.inquiryId) ?? []), item]);
  }
  const inquiryItemLinks: Array<{ id: string; rfqLineId: string }> = [];
  const effectiveInquiryItemLineById = new Map<string, string>();
  for (const item of input.inquiryItems) {
    const inquiry = inquiryById.get(item.inquiryId);
    if (!inquiry?.rfqId) continue;
    const line = rfqLineByRfqId.get(inquiry.rfqId);
    if (!line || line.partNumber !== item.partNumber || line.quantity !== item.quantity || !sameDate(line.requiredDate, item.requiredDate) || line.certificateRequired !== item.certificateRequired) {
      issue(issues, 'inquiryItems', item.id, 'EXPLICIT_INQUIRY_SOURCE_MISMATCH');
      continue;
    }
    if (item.rfqLineId && item.rfqLineId !== line.id) {
      issue(issues, 'inquiryItems', item.id, 'EXISTING_INQUIRY_LINE_MISMATCH');
      continue;
    }
    effectiveInquiryItemLineById.set(item.id, line.id);
    if (!item.rfqLineId) inquiryItemLinks.push({ id: item.id, rfqLineId: line.id });
  }

  for (const quotation of input.quotations) {
    const rfqLine = rfqLineByRfqId.get(quotation.rfqId);
    if (!rfqLine) {
      issue(issues, 'quotations', quotation.id, 'MISSING_RFQ_LINE');
      continue;
    }
    if (quotation.currency !== 'USD') issue(issues, 'quotations', quotation.id, 'NON_USD_QUOTATION');
    if (quotation.unitPriceDecimal === null || quotation.costPriceDecimal === null || quotation.totalPriceDecimal === null) {
      issue(issues, 'quotations', quotation.id, 'MISSING_AMOUNT_SHADOW');
      continue;
    }
    try {
      const unitPrice = normalizeMoney(quotation.unitPriceDecimal);
      const costPrice = normalizeMoney(quotation.costPriceDecimal);
      const lineTotal = normalizeMoney(quotation.totalPriceDecimal);
      const expectedLineTotal = calculateMoneyTotal(unitPrice, quotation.quantity);
      if (!lineTotal.equals(expectedLineTotal)) {
        issue(issues, 'quotations', quotation.id, 'QUOTATION_LINE_TOTAL_MISMATCH');
        continue;
      }
      const acceptedQuantity = input.orders
        .filter((order) => order.quotationId === quotation.id)
        .reduce((sum, order) => sum + order.quantity, 0);
      if (acceptedQuantity > quotation.quantity) issue(issues, 'quotations', quotation.id, 'ACCEPTED_QUANTITY_EXCEEDS_QUOTATION');
      if (acceptedQuantity === 0 && ['ACCEPTED', 'ORDERED', 'COMPLETED'].includes(quotation.status.toUpperCase())) {
        issue(issues, 'quotations', quotation.id, 'ACCEPTED_WITHOUT_ORDER');
      }
      const reservedQuantity = quotation.reservedQuantity ?? 0;
      if (reservedQuantity < 0 || reservedQuantity > quotation.quantity) issue(issues, 'quotations', quotation.id, 'RESERVED_QUANTITY_INVALID');
      const costTotal = calculateMoneyTotal(costPrice, quotation.quantity);
      const marginAmount = lineTotal.minus(costTotal);
      const marginPercent = lineTotal.isZero() ? normalizeMoney(0) : marginAmount.div(lineTotal).mul(100).toDecimalPlaces(4);
      const sourceType = String(quotation.costSourceType || '').trim().toUpperCase();
      let sourceSupplierQuoteId: string | null = null;
      if (sourceType === 'SUPPLIER_QUOTE' && !quotation.costSourceId) {
        issue(issues, 'quotations', quotation.id, 'SUPPLIER_QUOTE_COST_SOURCE_MISSING');
      } else if (sourceType === 'SUPPLIER_QUOTE' && quotation.costSourceId) {
        const source = input.supplierQuotes.find((candidate) => candidate.id === quotation.costSourceId);
        const sourceInquiry = source?.inquiryId ? inquiryById.get(source.inquiryId) : undefined;
        const sourceRfqId = source?.rfqId || sourceInquiry?.rfqId || null;
        if (!source || sourceRfqId !== quotation.rfqId || (source.rfqLineId && source.rfqLineId !== rfqLine.id) || source.partNumber !== quotation.partNumber) {
          issue(issues, 'quotations', quotation.id, 'SUPPLIER_QUOTE_COST_SOURCE_MISMATCH', 'BLOCKER', [quotation.costSourceId]);
        } else {
          sourceSupplierQuoteId = source.id;
        }
      }
      const expected: QuotationLineCreate = {
        id: idFactory('quotation', quotation.id),
        quotationId: quotation.id,
        lineNo: 1,
        rfqLineId: rfqLine.id,
        partNumber: quotation.partNumber,
        description: rfqLine.description,
        uom: rfqLine.uom,
        quantity: quotation.quantity,
        unitPrice: unitPrice.toFixed(4),
        costPrice: costPrice.toFixed(4),
        lineTotal: lineTotal.toFixed(4),
        marginAmount: marginAmount.toFixed(4),
        marginPercent: marginPercent.toFixed(4),
        currency: quotation.currency,
        status: quotationLineStatus(quotation.status, acceptedQuantity, quotation.quantity),
        acceptedQuantity,
        reservedQuantity,
        inventoryDetailId: quotation.inventoryDetailId,
        serialNumber: quotation.serialNumber,
        batchNumber: quotation.batchNumber,
        sourceSupplierQuoteId,
      };
      const adopted = adoptOrCreate(expected, existingQuotationByParent.get(quotation.id), sameQuotationLine, 'quotationLines', issues);
      if (!adopted.created) skippedQuotationLines += 1;
      quotationLineByQuotationId.set(quotation.id, adopted.value);
    } catch {
      issue(issues, 'quotations', quotation.id, 'INVALID_AMOUNT');
    }
  }

  const supplierQuoteLinks: Array<{ id: string; rfqLineId?: string; inquiryItemId?: string }> = [];
  for (const quote of input.supplierQuotes) {
    const links: { rfqLineId?: string; inquiryItemId?: string } = {};
    if (quote.rfqId) {
      const line = rfqLineByRfqId.get(quote.rfqId);
      const rfq = input.rfqs.find(row => row.id === quote.rfqId);
      if (line && rfq && isExplicitDemandPart(rfq, quote.partNumber) && quote.quantity <= line.quantity) links.rfqLineId = line.id;
    }
    if (quote.inquiryId) {
      const items = (itemsByInquiry.get(quote.inquiryId) ?? []).filter((item) => item.partNumber === quote.partNumber && item.quantity >= quote.quantity);
      if (items.length === 1 && inquiryById.get(quote.inquiryId)?.supplierId === quote.supplierId) {
        links.inquiryItemId = items[0].id;
        const itemLine = effectiveInquiryItemLineById.get(items[0].id);
        if (itemLine && links.rfqLineId && itemLine !== links.rfqLineId) issue(issues, 'supplierQuotes', quote.id, 'SUPPLIER_QUOTE_SOURCE_PATH_CONFLICT');
        if (itemLine && !links.rfqLineId) links.rfqLineId = itemLine;
      }
    }
    if (quote.rfqId && !links.rfqLineId && !quote.inquiryId) issue(issues, 'supplierQuotes', quote.id, 'EXPLICIT_RFQ_SOURCE_MISMATCH');
    if (quote.rfqLineId && links.rfqLineId !== quote.rfqLineId) {
      issue(issues, 'supplierQuotes', quote.id, 'EXISTING_SUPPLIER_QUOTE_LINE_MISMATCH');
    }
    if (quote.inquiryItemId && links.inquiryItemId !== quote.inquiryItemId) {
      issue(issues, 'supplierQuotes', quote.id, 'EXISTING_SUPPLIER_QUOTE_ITEM_MISMATCH');
    }
    const pendingLinks: { id: string; rfqLineId?: string; inquiryItemId?: string } = { id: quote.id };
    if (!quote.rfqLineId && links.rfqLineId) pendingLinks.rfqLineId = links.rfqLineId;
    if (!quote.inquiryItemId && links.inquiryItemId) pendingLinks.inquiryItemId = links.inquiryItemId;
    if (Object.keys(pendingLinks).length > 1) supplierQuoteLinks.push(pendingLinks);
  }

  for (const order of input.orders) {
    const quotationLine = quotationLineByQuotationId.get(order.quotationId);
    const quotation = input.quotations.find((row) => row.id === order.quotationId);
    if (!quotationLine || !quotation) {
      issue(issues, 'orders', order.id, 'MISSING_QUOTATION_LINE');
      continue;
    }
    if (order.outboundQuantity < 0 || order.outboundQuantity > order.quantity) {
      issue(issues, 'orders', order.id, 'INVALID_OUTBOUND_QUANTITY');
    }
    if (order.totalAmountDecimal === null) {
      issue(issues, 'orders', order.id, 'MISSING_AMOUNT_SHADOW');
      continue;
    }
    try {
      if (quotation.unitPriceDecimal === null) {
        issue(issues, 'orders', order.id, 'MISSING_QUOTATION_UNIT_PRICE_SHADOW');
        continue;
      }
      const unitPrice = normalizeMoney(quotation.unitPriceDecimal);
      const lineTotal = normalizeMoney(order.totalAmountDecimal);
      if (!lineTotal.equals(calculateMoneyTotal(unitPrice, order.quantity))) {
        issue(issues, 'orders', order.id, 'ORDER_LINE_TOTAL_MISMATCH');
      }
      const expected: OrderLineCreate = {
        id: idFactory('order', order.id),
        orderId: order.id,
        lineNo: 1,
        quotationLineId: quotationLine.id,
        partNumber: order.partNumber,
        uom: rfqLineByRfqId.get(quotation.rfqId)?.uom ?? 'EA',
        quantity: order.quantity,
        unitPrice: unitPrice.toFixed(4),
        lineTotal: lineTotal.toFixed(4),
        currency: quotation.currency,
        outboundQuantity: order.outboundQuantity,
        outboundStatus: order.outboundStatus,
        inventoryDetailId: order.inventoryDetailId,
        serialNumber: order.serialNumber,
        batchNumber: order.batchNumber,
      };
      const adopted = adoptOrCreate(expected, existingOrderByParent.get(order.id), sameOrderLine, 'orderLines', issues);
      if (!adopted.created) skippedOrderLines += 1;
      orderLineByOrderId.set(order.id, adopted.value);
    } catch {
      issue(issues, 'orders', order.id, 'INVALID_AMOUNT');
    }
  }

  const blockingIssues = issues.filter((entry) => entry.severity === 'BLOCKER');
  const hasReviews = gate.unresolvedSourceReviews.length > 0 || issues.some((entry) => entry.severity === 'REVIEW');
  return {
    status: blockingIssues.length > 0 ? 'BLOCKED' : hasReviews ? 'REVIEW_REQUIRED' : 'READY',
    preflight,
    issues: [...gate.unresolvedSourceReviews.map((entry) => ({
      entity: entry.entity,
      id: entry.id,
      code: entry.code,
      severity: 'REVIEW' as const,
      ...(entry.relatedIds ? { relatedIds: entry.relatedIds } : {}),
    })), ...issues],
    rfqLines: blockingIssues.length > 0 ? [] : Array.from(rfqLineByRfqId.values()).filter((line) => !(input.existingRfqLines ?? []).some((existing) => existing.id === line.id)),
    quotationLines: blockingIssues.length > 0 ? [] : Array.from(quotationLineByQuotationId.values()).filter((line) => !(input.existingQuotationLines ?? []).some((existing) => existing.id === line.id)),
    orderLines: blockingIssues.length > 0 ? [] : Array.from(orderLineByOrderId.values()).filter((line) => !(input.existingOrderLines ?? []).some((existing) => existing.id === line.id)),
    inquiryItemLinks: blockingIssues.length > 0 ? [] : inquiryItemLinks,
    supplierQuoteLinks: blockingIssues.length > 0 ? [] : supplierQuoteLinks,
    skippedExisting: { rfqLines: skippedRfqLines, quotationLines: skippedQuotationLines, orderLines: skippedOrderLines },
  };
}
