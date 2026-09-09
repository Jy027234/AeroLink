import { calculateMoneyTotal, normalizeMoney, type MoneyInput } from './money.js';
import { isExplicitDemandPart } from './transactionLinePreflight.js';
import { assertLineCostSnapshot } from './lineQuotationPolicy.js';
import {
  reconcileDirectDeliveryProjection,
  type DirectDeliveryLine,
  type DirectDeliveryLocalReceipt,
  type DirectDeliveryPurchaseLine,
} from './directDeliveryReconciliation.js';

export type ReconciliationIssue = {
  entity: string;
  id: string;
  code: string;
  severity: 'BLOCKER' | 'REVIEW';
  relatedIds?: string[];
  expected?: number | string;
  actual?: number | string;
};

type PhysicalIdentity = { inventoryDetailId: string | null; serialNumber: string | null; batchNumber: string | null };
type DemandTerms = {
  description: string | null; serialNumber: string | null; batchNumber: string | null;
  alternatePartNumbers: string | null; certificateType: string | null; leadTimeDays: number | null;
  requiredDate: Date; certificateRequired: boolean;
};

export type RfqLineReconciliationRow = DemandTerms & {
  id: string;
  rfqId: string;
  lineNo: number;
  partNumber: string;
  quantity: number;
  uom: string;
  conditionCode: string;
  requiredDate: Date;
  certificateRequired: boolean;
  targetPriceDecimal: MoneyInput | null;
  targetPriceCurrency: string;
};

export type RfqReconciliationRow = DemandTerms & {
  id: string;
  partNumber: string;
  quantity: number;
  uom: string;
  conditionCode: string;
  targetPrice: number | null;
  targetPriceCurrency: string;
  alternatePartNumbers?: string | null;
  lines: RfqLineReconciliationRow[];
  lineItemsMode?: boolean;
};

export type InquiryReconciliationRow = { id: string; supplierId: string; rfqId: string | null };
export type InquiryItemReconciliationRow = {
  id: string;
  inquiryId: string;
  lineNo: number;
  rfqLineId: string | null;
  partNumber: string;
  quantity: number;
  requiredDate: Date;
  certificateRequired: boolean;
};
export type SupplierQuoteReconciliationRow = {
  id: string;
  inquiryId: string | null;
  rfqId: string | null;
  rfqLineId: string | null;
  inquiryItemId: string | null;
  supplierId: string;
  partNumber: string;
  quantity: number;
  unitPrice: number;
  unitPriceDecimal: MoneyInput | null;
  totalPrice: number;
  totalPriceDecimal: MoneyInput | null;
  currency: string | null;
};

export type QuotationLineReconciliationRow = PhysicalIdentity & {
  id: string;
  quotationId: string;
  lineNo: number;
  rfqLineId: string;
  sourceSupplierQuoteId: string | null;
  partNumber: string;
  quantity: number;
  unitPrice: MoneyInput;
  costPrice: MoneyInput;
  lineTotal: MoneyInput;
  marginAmount: MoneyInput;
  marginPercent: MoneyInput;
  currency: string;
  acceptedQuantity: number;
  reservedQuantity: number;
  costSourceType?: string | null;
  costSourceId?: string | null;
  costSourceReason?: string | null;
  costSourceSnapshotJson?: string | null;
  costSourceCapturedAt?: Date | null;
};
export type QuotationReconciliationRow = PhysicalIdentity & {
  id: string;
  rfqId: string;
  partNumber: string;
  quantity: number;
  unitPrice: number;
  unitPriceDecimal: MoneyInput | null;
  totalPrice: number;
  totalPriceDecimal: MoneyInput | null;
  costPrice: number;
  costPriceDecimal: MoneyInput | null;
  currency: string;
  reservedQuantity: number;
  costSourceType: string | null;
  costSourceId: string | null;
  lines: QuotationLineReconciliationRow[];
  lineItemsMode?: boolean;
};

export type OrderLineReconciliationRow = PhysicalIdentity & {
  id: string;
  orderId: string;
  lineNo: number;
  quotationLineId: string;
  partNumber: string;
  quantity: number;
  unitPrice: MoneyInput;
  lineTotal: MoneyInput;
  currency: string;
  outboundQuantity: number;
  outboundStatus: string;
  /** Supplier-direct quantity is optional for legacy fixtures/rows. */
  directShippedQuantity?: number;
};
export type OrderReconciliationRow = PhysicalIdentity & {
  id: string;
  quotationId: string;
  partNumber: string;
  quantity: number;
  totalAmount: number;
  totalAmountDecimal: MoneyInput | null;
  outboundQuantity: number;
  outboundStatus: string;
  /** Supplier-direct quantity is optional for legacy fixtures/rows. */
  directShippedQuantity?: number;
  status?: string;
  lines: OrderLineReconciliationRow[];
  lineItemsMode?: boolean;
};

export type TransactionLineReconciliationInput = {
  rfqs: RfqReconciliationRow[];
  inquiries: InquiryReconciliationRow[];
  inquiryItems: InquiryItemReconciliationRow[];
  supplierQuotes: SupplierQuoteReconciliationRow[];
  quotations: QuotationReconciliationRow[];
  orders: OrderReconciliationRow[];
  /** Direct projections are absent from pre-D14 fixtures and then mean zero. */
  directPurchaseLines?: DirectDeliveryPurchaseLine[];
  directShipmentLines?: DirectDeliveryLine[];
  localShipmentReceipts?: DirectDeliveryLocalReceipt[];
};

function sameMoney(left: MoneyInput | null | undefined, right: MoneyInput | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  try {
    return normalizeMoney(left).equals(normalizeMoney(right));
  } catch {
    return false;
  }
}

function calculatedMarginPercent(lineTotal: MoneyInput, marginAmount: MoneyInput): MoneyInput {
  const total = normalizeMoney(lineTotal);
  return total.isZero() ? normalizeMoney(0) : normalizeMoney(marginAmount).div(total).mul(100).toDecimalPlaces(4);
}

function oneLine<T extends { lineNo: number }>(
  rows: T[],
  entity: string,
  id: string,
  issues: ReconciliationIssue[],
): T | null {
  const primary = rows.filter(row => row.lineNo === 1);
  if (rows.length !== 1 || primary.length !== 1) {
    issues.push({ entity, id, code: 'LINE_CARDINALITY_NOT_ONE', severity: 'BLOCKER' });
    return primary[0] ?? null;
  }
  return primary[0];
}

/**
 * Read-only checks for the M1/M2 one-row compatibility window. It validates
 * ownership and money facts without repairing any legacy or line data.
 */
export function reconcileTransactionLines(input: TransactionLineReconciliationInput) {
  const issues: ReconciliationIssue[] = [];
  const add = (entity: string, id: string, code: string, severity: ReconciliationIssue['severity'] = 'BLOCKER', relatedIds?: string[]) =>
    issues.push({ entity, id, code, severity, ...(relatedIds ? { relatedIds } : {}) });
  const rfqById = new Map(input.rfqs.map(row => [row.id, row]));
  const rfqLineById = new Map<string, RfqLineReconciliationRow>();
  const inquiryById = new Map(input.inquiries.map(row => [row.id, row]));
  const itemById = new Map(input.inquiryItems.map(row => [row.id, row]));
  const quotationById = new Map(input.quotations.map(row => [row.id, row]));
  const quotationLineById = new Map<string, QuotationLineReconciliationRow>();
  const supplierQuoteById = new Map(input.supplierQuotes.map(row => [row.id, row]));
  const modernRfqIds = new Set(input.rfqs.filter(row => row.lineItemsMode).map(row => row.id));
  const modernRfqLineIds = new Set(
    input.rfqs.filter(row => row.lineItemsMode).flatMap(row => row.lines.map(line => line.id)),
  );
  const acceptedByQuotationLine = new Map<string, number>();
  const acceptedByQuotation = new Map<string, number>();
  for (const order of input.orders) {
    acceptedByQuotation.set(order.quotationId, (acceptedByQuotation.get(order.quotationId) ?? 0) + order.quantity);
    for (const line of order.lines) {
      acceptedByQuotationLine.set(line.quotationLineId, (acceptedByQuotationLine.get(line.quotationLineId) ?? 0) + line.quantity);
    }
  }

  for (const rfq of input.rfqs) {
    if (rfq.lineItemsMode) {
      if (rfq.lines.length === 0) {
        add('rfqs', rfq.id, 'MODERN_RFQ_LINES_MISSING');
        continue;
      }
      const lineNumbers = new Set<number>();
      const lineIds = new Set<string>();
      for (const line of rfq.lines) {
        if (lineIds.has(line.id)) add('rfqLines', line.id, 'DUPLICATE_RFQ_LINE_ID');
        lineIds.add(line.id);
        if (lineNumbers.has(line.lineNo)) add('rfqLines', line.id, 'DUPLICATE_RFQ_LINE_NO');
        lineNumbers.add(line.lineNo);
        rfqLineById.set(line.id, line);
        if (line.rfqId !== rfq.id) add('rfqLines', line.id, 'RFQ_OWNER_MISMATCH');
        if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) add('rfqLines', line.id, 'INVALID_QUANTITY');
        if (!line.partNumber.trim()) add('rfqLines', line.id, 'MISSING_PART_NUMBER');
        if (line.targetPriceCurrency !== 'USD') add('rfqLines', line.id, 'NON_USD_TARGET', 'REVIEW');
        if (!Number.isFinite(line.requiredDate.getTime())) add('rfqLines', line.id, 'INVALID_REQUIRED_DATE');
      }
      continue;
    }
    const line = oneLine(rfq.lines, 'rfqs', rfq.id, issues);
    if (!line) continue;
    rfqLineById.set(line.id, line);
    if (line.rfqId !== rfq.id) add('rfqLines', line.id, 'RFQ_OWNER_MISMATCH');
    if (line.partNumber !== rfq.partNumber) add('rfqLines', line.id, 'RFQ_PART_MISMATCH');
    if (line.quantity !== rfq.quantity) add('rfqLines', line.id, 'RFQ_QUANTITY_MISMATCH');
    if (line.uom !== rfq.uom) add('rfqLines', line.id, 'RFQ_UOM_MISMATCH');
    if (line.conditionCode !== rfq.conditionCode) add('rfqLines', line.id, 'RFQ_CONDITION_MISMATCH');
    if (line.targetPriceCurrency !== rfq.targetPriceCurrency) add('rfqLines', line.id, 'RFQ_TARGET_CURRENCY_MISMATCH');
    if (!sameMoney(rfq.targetPrice, line.targetPriceDecimal)) {
      add('rfqLines', line.id, 'RFQ_TARGET_PRICE_MISMATCH');
    }
    const termFields = ['description', 'serialNumber', 'batchNumber', 'alternatePartNumbers', 'certificateType', 'certificateRequired', 'leadTimeDays'] as const;
    if (termFields.some(field => line[field] !== rfq[field]) || line.requiredDate.getTime() !== rfq.requiredDate.getTime()) {
      add('rfqLines', line.id, 'RFQ_DEMAND_TERMS_MISMATCH');
    }
  }

  const itemsByInquiry = new Map<string, InquiryItemReconciliationRow[]>();
  for (const item of input.inquiryItems) {
    itemsByInquiry.set(item.inquiryId, [...(itemsByInquiry.get(item.inquiryId) ?? []), item]);
    if (!inquiryById.has(item.inquiryId)) add('inquiryItems', item.id, 'MISSING_INQUIRY');
    if (item.rfqLineId) {
      const line = rfqLineById.get(item.rfqLineId);
      const inquiry = inquiryById.get(item.inquiryId);
      if (!line) add('inquiryItems', item.id, 'MISSING_RFQ_LINE');
      else {
        if (inquiry?.rfqId !== line.rfqId) add('inquiryItems', item.id, 'INQUIRY_RFQ_LINE_OWNER_MISMATCH');
        if (item.partNumber !== line.partNumber || item.quantity > line.quantity || item.requiredDate.getTime() !== line.requiredDate.getTime() || item.certificateRequired !== line.certificateRequired) {
          add('inquiryItems', item.id, 'INQUIRY_RFQ_LINE_FACT_MISMATCH');
        }
      }
    }
  }
  for (const inquiry of input.inquiries) {
    if (inquiry.rfqId && !rfqById.has(inquiry.rfqId)) add('inquiries', inquiry.id, 'MISSING_RFQ');
    if (!inquiry.rfqId && (itemsByInquiry.get(inquiry.id)?.length ?? 0) > 0) {
      add('inquiries', inquiry.id, 'LEGACY_INQUIRY_SOURCE_UNRESOLVED', 'REVIEW');
    }
  }

  for (const quote of input.supplierQuotes) {
    if (quote.currency === null) add('supplierQuotes', quote.id, 'SUPPLIER_QUOTE_CURRENCY_UNREVIEWED', 'REVIEW');
    else if (quote.currency !== 'USD') add('supplierQuotes', quote.id, 'NON_USD_SUPPLIER_QUOTE');
    if (quote.rfqId && modernRfqIds.has(quote.rfqId) && !quote.rfqLineId && rfqById.get(quote.rfqId)?.lines.length !== 1) {
      add('supplierQuotes', quote.id, 'SUPPLIER_QUOTE_LINE_REQUIRED');
    }
    if (quote.rfqLineId) {
      const line = rfqLineById.get(quote.rfqLineId);
      if (!line) add('supplierQuotes', quote.id, 'MISSING_RFQ_LINE');
      else {
        const rfq = rfqById.get(line.rfqId);
        if (quote.rfqId !== line.rfqId) add('supplierQuotes', quote.id, 'SUPPLIER_QUOTE_RFQ_OWNER_MISMATCH');
        const partAllowed = modernRfqLineIds.has(line.id)
          ? isExplicitDemandPart(line, quote.partNumber)
          : Boolean(rfq && isExplicitDemandPart(rfq, quote.partNumber));
        if (!partAllowed || quote.quantity > line.quantity) add('supplierQuotes', quote.id, 'SUPPLIER_QUOTE_RFQ_FACT_MISMATCH');
      }
    }
    if (quote.inquiryItemId) {
      const item = itemById.get(quote.inquiryItemId);
      const inquiry = quote.inquiryId ? inquiryById.get(quote.inquiryId) : undefined;
      if (!item) add('supplierQuotes', quote.id, 'MISSING_INQUIRY_ITEM');
      else {
        if (item.inquiryId !== quote.inquiryId) add('supplierQuotes', quote.id, 'SUPPLIER_QUOTE_INQUIRY_OWNER_MISMATCH');
        if (!inquiry || inquiry.supplierId !== quote.supplierId) add('supplierQuotes', quote.id, 'SUPPLIER_QUOTE_SUPPLIER_MISMATCH');
        if (quote.partNumber !== item.partNumber || quote.quantity > item.quantity) add('supplierQuotes', quote.id, 'SUPPLIER_QUOTE_INQUIRY_FACT_MISMATCH');
      }
      if (item?.rfqLineId && quote.rfqLineId && item.rfqLineId !== quote.rfqLineId) add('supplierQuotes', quote.id, 'SUPPLIER_QUOTE_SOURCE_PATH_CONFLICT');
    }
    if (!quote.rfqLineId && !quote.inquiryItemId) add('supplierQuotes', quote.id, 'LEGACY_UNLINKED', 'REVIEW');
    if (quote.unitPriceDecimal === null || quote.totalPriceDecimal === null) {
      add('supplierQuotes', quote.id, 'MISSING_AMOUNT_SHADOW');
    } else {
      try {
        if (!sameMoney(calculateMoneyTotal(quote.unitPriceDecimal, quote.quantity), quote.totalPriceDecimal)) add('supplierQuotes', quote.id, 'LINE_TOTAL_MISMATCH');
      } catch {
        add('supplierQuotes', quote.id, 'INVALID_AMOUNT');
      }
    }
  }

  for (const quotation of input.quotations) {
    if (quotation.lineItemsMode) {
      const rfq = rfqById.get(quotation.rfqId);
      if (!rfq) add('quotations', quotation.id, 'MISSING_RFQ');
      if (quotation.lines.length === 0) {
        add('quotations', quotation.id, 'MODERN_QUOTATION_LINES_MISSING');
        continue;
      }
      if (quotation.currency !== 'USD') add('quotations', quotation.id, 'NON_USD_QUOTATION');
      let quantityTotal = 0;
      let priceTotal = normalizeMoney(0);
      const lineNumbers = new Set<number>();
      for (const line of quotation.lines) {
        quotationLineById.set(line.id, line);
        if (lineNumbers.has(line.lineNo)) add('quotationLines', line.id, 'DUPLICATE_QUOTATION_LINE_NO');
        lineNumbers.add(line.lineNo);
        quantityTotal += line.quantity;
        const rfqLine = rfqLineById.get(line.rfqLineId);
        if (line.quotationId !== quotation.id) add('quotationLines', line.id, 'QUOTATION_OWNER_MISMATCH');
        if (!rfqLine || rfqLine.rfqId !== quotation.rfqId) add('quotationLines', line.id, 'QUOTATION_RFQ_LINE_OWNER_MISMATCH');
        if (rfqLine && !isExplicitDemandPart(rfqLine, line.partNumber)) add('quotationLines', line.id, 'QUOTATION_PART_NOT_IN_RFQ');
        if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) add('quotationLines', line.id, 'INVALID_QUANTITY');
        if (rfqLine && line.quantity > rfqLine.quantity) add('quotationLines', line.id, 'QUOTATION_QUANTITY_EXCEEDS_RFQ_LINE');
        if (line.currency !== 'USD' || line.currency !== quotation.currency) add('quotationLines', line.id, 'NON_USD_OR_CURRENCY_MISMATCH');
        const expectedSourceSupplierQuoteId = line.costSourceType === 'SUPPLIER_QUOTE' ? line.costSourceId : null;
        if ((line.sourceSupplierQuoteId ?? null) !== (expectedSourceSupplierQuoteId ?? null)) {
          add('quotationLines', line.id, 'SOURCE_QUOTE_COST_SOURCE_MISMATCH');
        }
        if (line.acceptedQuantity < 0 || line.acceptedQuantity > line.quantity) add('quotationLines', line.id, 'INVALID_ACCEPTED_QUANTITY');
        if (line.reservedQuantity < 0 || line.reservedQuantity > line.quantity) add('quotationLines', line.id, 'INVALID_RESERVED_QUANTITY');
        const accepted = acceptedByQuotationLine.get(line.id) ?? 0;
        if (line.acceptedQuantity !== accepted) add('quotationLines', line.id, 'ACCEPTED_QUANTITY_ORDER_MISMATCH');
        try {
          const expectedTotal = calculateMoneyTotal(line.unitPrice, line.quantity);
          const expectedCost = calculateMoneyTotal(line.costPrice, line.quantity);
          const expectedMargin = normalizeMoney(expectedTotal).minus(expectedCost);
          priceTotal = priceTotal.plus(expectedTotal);
          if (!sameMoney(line.lineTotal, expectedTotal)) add('quotationLines', line.id, 'LINE_TOTAL_MISMATCH');
          if (!sameMoney(line.marginAmount, expectedMargin)) add('quotationLines', line.id, 'MARGIN_AMOUNT_MISMATCH');
          if (!sameMoney(line.marginPercent, calculatedMarginPercent(line.lineTotal, line.marginAmount))) add('quotationLines', line.id, 'MARGIN_PERCENT_MISMATCH');
        } catch {
          add('quotationLines', line.id, 'INVALID_AMOUNT');
        }
        if (!line.costSourceSnapshotJson) {
          add('quotationLines', line.id, 'MISSING_LINE_COST_SNAPSHOT');
        } else {
          try {
            assertLineCostSnapshot(line);
          } catch {
            add('quotationLines', line.id, 'LINE_COST_SNAPSHOT_INVALID');
          }
        }
        if (line.sourceSupplierQuoteId) {
          const source = supplierQuoteById.get(line.sourceSupplierQuoteId);
          const sourceLineMatches = source?.rfqLineId === line.rfqLineId
            || (source?.rfqLineId === null && rfq?.lines.length === 1 && rfq.lines[0].id === line.rfqLineId);
          if (!source
            || source.rfqId !== quotation.rfqId
            || !sourceLineMatches
            || source.partNumber !== line.partNumber) {
            add('quotationLines', line.id, 'SOURCE_QUOTE_MISMATCH');
          }
        }
      }
      if (quantityTotal !== quotation.quantity) add('quotations', quotation.id, 'QUOTATION_QUANTITY_LINES_MISMATCH');
      if (quotation.totalPriceDecimal === null) {
        add('quotations', quotation.id, 'MISSING_AMOUNT_SHADOW');
      } else if (!sameMoney(priceTotal, quotation.totalPriceDecimal)) {
        add('quotations', quotation.id, 'QUOTATION_TOTAL_LINES_MISMATCH');
      }
      continue;
    }
    const line = oneLine(quotation.lines, 'quotations', quotation.id, issues);
    if (!line) continue;
    quotationLineById.set(line.id, line);
    const rfq = rfqById.get(quotation.rfqId);
    const rfqLine = rfq?.lines.find(candidate => candidate.id === line.rfqLineId);
    if (!rfq) add('quotations', quotation.id, 'MISSING_RFQ');
    if (!rfqLine) add('quotationLines', line.id, 'QUOTATION_RFQ_LINE_OWNER_MISMATCH');
    if (line.partNumber !== quotation.partNumber || line.quantity !== quotation.quantity) add('quotationLines', line.id, 'QUOTATION_HEADER_FACT_MISMATCH');
    if (rfq && !isExplicitDemandPart(rfq, line.partNumber)) add('quotationLines', line.id, 'QUOTATION_PART_NOT_IN_RFQ');
    if (line.currency !== 'USD' || quotation.currency !== 'USD' || line.currency !== quotation.currency) add('quotationLines', line.id, 'NON_USD_OR_CURRENCY_MISMATCH');
    if (quotation.unitPriceDecimal === null || quotation.costPriceDecimal === null || quotation.totalPriceDecimal === null) add('quotations', quotation.id, 'MISSING_AMOUNT_SHADOW');
    else {
      if (!sameMoney(line.unitPrice, quotation.unitPriceDecimal)) add('quotationLines', line.id, 'UNIT_PRICE_MISMATCH');
      if (!sameMoney(line.costPrice, quotation.costPriceDecimal)) add('quotationLines', line.id, 'COST_PRICE_MISMATCH');
      if (!sameMoney(line.lineTotal, quotation.totalPriceDecimal)) add('quotationLines', line.id, 'LINE_TOTAL_HEADER_MISMATCH');
    }
    try {
      const expectedTotal = calculateMoneyTotal(line.unitPrice, line.quantity);
      const expectedCost = calculateMoneyTotal(line.costPrice, line.quantity);
      const expectedMargin = normalizeMoney(expectedTotal).minus(expectedCost);
      if (!sameMoney(line.lineTotal, expectedTotal)) add('quotationLines', line.id, 'LINE_TOTAL_MISMATCH');
      if (!sameMoney(line.marginAmount, expectedMargin)) add('quotationLines', line.id, 'MARGIN_AMOUNT_MISMATCH');
      if (!sameMoney(line.marginPercent, calculatedMarginPercent(line.lineTotal, line.marginAmount))) add('quotationLines', line.id, 'MARGIN_PERCENT_MISMATCH');
    } catch {
      add('quotationLines', line.id, 'INVALID_AMOUNT');
    }
    if (line.acceptedQuantity < 0 || line.acceptedQuantity > line.quantity) add('quotationLines', line.id, 'INVALID_ACCEPTED_QUANTITY');
    if (line.reservedQuantity < 0 || line.reservedQuantity > line.quantity) add('quotationLines', line.id, 'INVALID_RESERVED_QUANTITY');
    if (line.reservedQuantity !== quotation.reservedQuantity) add('quotationLines', line.id, 'RESERVED_QUANTITY_HEADER_MISMATCH');
    const sourceId = quotation.costSourceType === 'SUPPLIER_QUOTE' ? quotation.costSourceId : null;
    if (line.sourceSupplierQuoteId !== sourceId) add('quotationLines', line.id, 'SOURCE_QUOTE_HEADER_MISMATCH');
    if (line.inventoryDetailId !== quotation.inventoryDetailId || line.serialNumber !== quotation.serialNumber || line.batchNumber !== quotation.batchNumber) {
      add('quotationLines', line.id, 'INVENTORY_IDENTITY_HEADER_MISMATCH');
    }
    const accepted = acceptedByQuotation.get(quotation.id) ?? 0;
    if (line.acceptedQuantity !== accepted) add('quotationLines', line.id, 'ACCEPTED_QUANTITY_ORDER_MISMATCH');
    if (line.sourceSupplierQuoteId) {
      const quote = supplierQuoteById.get(line.sourceSupplierQuoteId);
      // Source availability may change after approval. Reconcile the stable
      // relationship here; the captured commercial snapshot owns historic cost.
      if (!quote || quote.rfqLineId !== line.rfqLineId || quote.partNumber !== line.partNumber) add('quotationLines', line.id, 'SOURCE_QUOTE_MISMATCH');
    }
  }

  for (const order of input.orders) {
    if (order.lineItemsMode) {
      const quotation = quotationById.get(order.quotationId);
      if (!quotation) add('orders', order.id, 'MISSING_QUOTATION');
      if (order.lines.length === 0) {
        add('orders', order.id, 'MODERN_ORDER_LINES_MISSING');
        continue;
      }
      let quantityTotal = 0;
      let amountTotal = normalizeMoney(0);
      let outboundTotal = 0;
      const lineNumbers = new Set<number>();
      for (const line of order.lines) {
        if (lineNumbers.has(line.lineNo)) add('orderLines', line.id, 'DUPLICATE_ORDER_LINE_NO');
        lineNumbers.add(line.lineNo);
        quantityTotal += line.quantity;
        outboundTotal += line.outboundQuantity;
        const quotationLine = quotationLineById.get(line.quotationLineId);
        if (line.orderId !== order.id) add('orderLines', line.id, 'ORDER_OWNER_MISMATCH');
        if (!quotationLine || quotationLine.quotationId !== order.quotationId) add('orderLines', line.id, 'ORDER_QUOTATION_LINE_OWNER_MISMATCH');
        if (quotationLine && line.partNumber !== quotationLine.partNumber) add('orderLines', line.id, 'ORDER_PART_MISMATCH');
        if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) add('orderLines', line.id, 'INVALID_QUANTITY');
        if (quotationLine && line.quantity > quotationLine.quantity) add('orderLines', line.id, 'ORDER_QUANTITY_EXCEEDS_QUOTATION_LINE');
        if (line.currency !== 'USD') add('orderLines', line.id, 'NON_USD_ORDER_LINE');
        try {
          const expectedTotal = calculateMoneyTotal(line.unitPrice, line.quantity);
          amountTotal = amountTotal.plus(expectedTotal);
          if (!sameMoney(line.lineTotal, expectedTotal)) add('orderLines', line.id, 'LINE_TOTAL_MISMATCH');
        } catch {
          add('orderLines', line.id, 'INVALID_AMOUNT');
        }
        if (line.outboundQuantity < 0 || line.outboundQuantity > line.quantity) add('orderLines', line.id, 'INVALID_OUTBOUND_QUANTITY');
        if (!['PENDING', 'PARTIAL', 'COMPLETED'].includes(line.outboundStatus)) add('orderLines', line.id, 'INVALID_OUTBOUND_STATUS');
        const expectedOutboundStatus = line.outboundQuantity === 0 ? 'PENDING' : line.outboundQuantity === line.quantity ? 'COMPLETED' : 'PARTIAL';
        if (line.outboundStatus !== expectedOutboundStatus) add('orderLines', line.id, 'OUTBOUND_STATUS_QUANTITY_MISMATCH');
      }
      if (quantityTotal !== order.quantity) add('orders', order.id, 'ORDER_QUANTITY_LINES_MISMATCH');
      if (order.totalAmountDecimal === null) {
        add('orders', order.id, 'MISSING_AMOUNT_SHADOW');
      } else if (!sameMoney(amountTotal, order.totalAmountDecimal)) {
        add('orders', order.id, 'ORDER_TOTAL_LINES_MISMATCH');
      }
      if (outboundTotal !== order.outboundQuantity) add('orders', order.id, 'OUTBOUND_HEADER_MISMATCH');
      const expectedOrderOutboundStatus = outboundTotal === 0 ? 'PENDING' : outboundTotal === order.quantity ? 'COMPLETED' : 'PARTIAL';
      if (order.outboundStatus !== expectedOrderOutboundStatus) add('orders', order.id, 'OUTBOUND_STATUS_QUANTITY_MISMATCH');
      continue;
    }
    const line = oneLine(order.lines, 'orders', order.id, issues);
    if (!line) continue;
    const quotation = quotationById.get(order.quotationId);
    const quotationLine = quotationLineById.get(line.quotationLineId);
    if (!quotation) add('orders', order.id, 'MISSING_QUOTATION');
    if (!quotationLine || quotationLine.quotationId !== order.quotationId) add('orderLines', line.id, 'ORDER_QUOTATION_LINE_OWNER_MISMATCH');
    if (line.partNumber !== order.partNumber || line.quantity !== order.quantity) add('orderLines', line.id, 'ORDER_HEADER_FACT_MISMATCH');
    if (line.currency !== 'USD') add('orderLines', line.id, 'NON_USD_ORDER_LINE');
    if (order.totalAmountDecimal === null) add('orders', order.id, 'MISSING_AMOUNT_SHADOW');
    else {
      if (!sameMoney(line.lineTotal, order.totalAmountDecimal)) add('orderLines', line.id, 'ORDER_LINE_TOTAL_HEADER_MISMATCH');
      if (!sameMoney(order.totalAmountDecimal, order.totalAmount)) add('orders', order.id, 'TOTAL_AMOUNT_SHADOW_MISMATCH');
    }
    try {
      if (!sameMoney(line.lineTotal, calculateMoneyTotal(line.unitPrice, line.quantity))) add('orderLines', line.id, 'LINE_TOTAL_MISMATCH');
    } catch {
      add('orderLines', line.id, 'INVALID_AMOUNT');
    }
    if (line.outboundQuantity < 0 || line.outboundQuantity > line.quantity) add('orderLines', line.id, 'INVALID_OUTBOUND_QUANTITY');
    if (!['PENDING', 'PARTIAL', 'COMPLETED'].includes(line.outboundStatus)) add('orderLines', line.id, 'INVALID_OUTBOUND_STATUS');
    if (line.outboundQuantity !== order.outboundQuantity || line.outboundStatus !== order.outboundStatus) add('orderLines', line.id, 'OUTBOUND_HEADER_MISMATCH');
    const expectedOutboundStatus = line.outboundQuantity === 0 ? 'PENDING' : line.outboundQuantity === line.quantity ? 'COMPLETED' : 'PARTIAL';
    if (line.outboundStatus !== expectedOutboundStatus) add('orderLines', line.id, 'OUTBOUND_STATUS_QUANTITY_MISMATCH');
    if (line.inventoryDetailId !== order.inventoryDetailId || line.serialNumber !== order.serialNumber || line.batchNumber !== order.batchNumber) {
      add('orderLines', line.id, 'INVENTORY_IDENTITY_HEADER_MISMATCH');
    }
  }

  const directReport = reconcileDirectDeliveryProjection({
    orders: input.orders.map(order => ({
      id: order.id,
      quantity: order.quantity,
      outboundQuantity: order.outboundQuantity,
      directShippedQuantity: order.directShippedQuantity,
      lineItemsMode: order.lineItemsMode,
      status: order.status,
      lines: order.lines.map(line => ({
        id: line.id,
        orderId: line.orderId,
        quantity: line.quantity,
        outboundQuantity: line.outboundQuantity,
        directShippedQuantity: line.directShippedQuantity,
      })),
    })),
    purchaseLines: input.directPurchaseLines,
    directLines: input.directShipmentLines ?? [],
    localReceipts: input.localShipmentReceipts,
  });
  for (const issue of directReport.issues) {
    issues.push({
      entity: issue.entity,
      id: issue.id,
      code: issue.code,
      severity: issue.severity,
      ...(issue.relatedIds ? { relatedIds: issue.relatedIds } : {}),
      ...(issue.expected === undefined ? {} : { expected: issue.expected }),
      ...(issue.actual === undefined ? {} : { actual: issue.actual }),
    });
  }

  const blockers = issues.filter(issue => issue.severity === 'BLOCKER').length;
  return {
    status: blockers > 0 ? 'BLOCKED' : issues.length > 0 ? 'REVIEW_REQUIRED' : 'PASS',
    blockers,
    reviews: issues.length - blockers,
    issues,
    migrationApplied: false as const,
    counts: {
      rfqs: input.rfqs.length,
      rfqLines: input.rfqs.reduce((sum, row) => sum + row.lines.length, 0),
      inquiries: input.inquiries.length,
      inquiryItems: input.inquiryItems.length,
      supplierQuotes: input.supplierQuotes.length,
      quotations: input.quotations.length,
      quotationLines: input.quotations.reduce((sum, row) => sum + row.lines.length, 0),
      orders: input.orders.length,
      orderLines: input.orders.reduce((sum, row) => sum + row.lines.length, 0),
      directPurchaseLines: input.directPurchaseLines?.length ?? 0,
      directShipmentLines: input.directShipmentLines?.length ?? 0,
    },
  };
}
