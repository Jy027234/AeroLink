import { calculateMoneyTotal, normalizeMoney, type MoneyInput } from './money.js';

type Item = { id: string; partNumber: string; quantity: number };
type Demand = Item & { requiredDate: Date; certificateRequired: boolean; targetPriceCurrency: string; alternatePartNumbers?: string | null; lineItemsMode?: boolean };
type InquiryItem = Item & { inquiryId: string; requiredDate: Date; certificateRequired: boolean };
type Priced = Item & {
  unitPrice: number; unitPriceDecimal: MoneyInput | null;
  totalPrice: number; totalPriceDecimal: MoneyInput | null;
};
export type LinePreflightInput = {
  rfqs: Demand[];
  inquiries: { id: string; supplierId: string; rfqId?: string | null }[];
  inquiryItems: InquiryItem[];
  supplierQuotes: (Priced & { rfqId: string | null; inquiryId: string | null; supplierId: string })[];
  quotations: (Priced & { rfqId: string; currency: string; costPrice: number; costPriceDecimal: MoneyInput | null; lineItemsMode?: boolean })[];
  orders: (Item & { quotationId: string; totalAmount: number; totalAmountDecimal: MoneyInput | null; outboundQuantity: number; lineItemsMode?: boolean })[];
};
type Issue = { entity: keyof LinePreflightInput; id: string; code: string; severity: 'BLOCKER' | 'REVIEW'; relatedIds?: string[] };

export function isExplicitDemandPart(demand: Pick<Demand, 'partNumber' | 'alternatePartNumbers'>, partNumber: string) {
  if (partNumber === demand.partNumber) return true;
  if (!demand.alternatePartNumbers) return false;
  let alternates: unknown;
  try { alternates = JSON.parse(demand.alternatePartNumbers); }
  catch { alternates = demand.alternatePartNumbers.split(',').map(value => value.trim()); }
  return Array.isArray(alternates) && alternates.some(value => typeof value === 'string' && value === partNumber);
}

/** Pure read-only assessment. Candidate matches are evidence for review, never authorization to link records. */
export function assessTransactionLineMigration(input: LinePreflightInput) {
  const issues: Issue[] = [];
  const add = (entity: Issue['entity'], id: string, code: string, severity: Issue['severity'] = 'BLOCKER', relatedIds?: string[]) =>
    issues.push({ entity, id, code, severity, ...(relatedIds ? { relatedIds } : {}) });
  const modernRfqIds = new Set(input.rfqs.filter(row => row.lineItemsMode).map(row => row.id));
  const modernQuotationIds = new Set(input.quotations.filter(row => row.lineItemsMode).map(row => row.id));
  const modernOrderIds = new Set(input.orders.filter(row => row.lineItemsMode).map(row => row.id));
  const modernInquiryIds = new Set(
    input.inquiries
      .filter(row => row.rfqId && modernRfqIds.has(row.rfqId))
      .map(row => row.id),
  );
  const legacyInput: LinePreflightInput = {
    rfqs: input.rfqs.filter(row => !modernRfqIds.has(row.id)),
    inquiries: input.inquiries.filter(row => !modernInquiryIds.has(row.id)),
    inquiryItems: input.inquiryItems.filter(row => !modernInquiryIds.has(row.inquiryId)),
    supplierQuotes: input.supplierQuotes.filter(row =>
      !modernRfqIds.has(row.rfqId || '') && !modernInquiryIds.has(row.inquiryId || '')),
    quotations: input.quotations.filter(row => !modernQuotationIds.has(row.id)),
    orders: input.orders.filter(row => !modernOrderIds.has(row.id)),
  };
  const rfqs = new Map(legacyInput.rfqs.map(row => [row.id, row]));
  const inquiries = new Map(legacyInput.inquiries.map(row => [row.id, row]));
  const quotations = new Map(legacyInput.quotations.map(row => [row.id, row]));
  const itemGroups = new Map<string, InquiryItem[]>();
  for (const item of legacyInput.inquiryItems) itemGroups.set(item.inquiryId, [...(itemGroups.get(item.inquiryId) ?? []), item]);
  const sameDemand = (item: InquiryItem, rfq: Demand) =>
    item.partNumber === rfq.partNumber && item.quantity === rfq.quantity &&
    Number.isFinite(item.requiredDate.getTime()) && item.requiredDate.getTime() === rfq.requiredDate.getTime() &&
    item.certificateRequired === rfq.certificateRequired;
  const money = (entity: Issue['entity'], id: string, field: string, decimal: MoneyInput | null, legacy: number) => {
    try {
      const preferred = normalizeMoney(decimal ?? legacy);
      if (preferred.isNegative()) add(entity, id, `NEGATIVE_${field}`);
      if (decimal === null) add(entity, id, `MISSING_${field}_SHADOW`, 'REVIEW');
      else if (!preferred.equals(normalizeMoney(legacy))) add(entity, id, `${field}_SHADOW_MISMATCH`);
      return preferred;
    } catch { add(entity, id, `INVALID_${field}`); return null; }
  };
  for (const entity of ['rfqs', 'inquiryItems', 'supplierQuotes', 'quotations', 'orders'] as const) {
    for (const row of legacyInput[entity]) {
      if (!Number.isSafeInteger(row.quantity) || row.quantity <= 0) add(entity, row.id, 'INVALID_QUANTITY');
      if (!row.partNumber.trim()) add(entity, row.id, 'MISSING_PART_NUMBER');
    }
  }
  for (const rfq of legacyInput.rfqs) {
    if (!Number.isFinite(rfq.requiredDate.getTime())) add('rfqs', rfq.id, 'INVALID_REQUIRED_DATE');
    if (rfq.targetPriceCurrency !== 'USD') add('rfqs', rfq.id, 'NON_USD_TARGET', 'REVIEW');
  }
  const inquiryCandidates = legacyInput.inquiries.map(inquiry => {
    const items = itemGroups.get(inquiry.id) ?? [];
    const candidates = items.length === 1 ? legacyInput.rfqs.filter(rfq => sameDemand(items[0], rfq)).map(rfq => rfq.id) : [];
    // The old schema did not persist a source relation. Even a unique field match is unproven.
    add('inquiries', inquiry.id, items.length !== 1 ? 'NO_SINGLE_SOURCE_ITEM' : candidates.length === 0 ? 'NO_SOURCE_CANDIDATE' : candidates.length === 1 ? 'UNCONFIRMED_SOURCE_CANDIDATE' : 'AMBIGUOUS_SOURCE_CANDIDATES', 'REVIEW', candidates);
    return { inquiryId: inquiry.id, candidateRfqIds: candidates, automaticLinkAllowed: false as const };
  });
  for (const item of legacyInput.inquiryItems) {
    if (!inquiries.has(item.inquiryId)) add('inquiryItems', item.id, 'MISSING_INQUIRY');
    if (!Number.isFinite(item.requiredDate.getTime())) add('inquiryItems', item.id, 'INVALID_REQUIRED_DATE');
  }
  for (const entity of ['supplierQuotes', 'quotations'] as const) {
    for (const quote of legacyInput[entity]) {
      const unit = money(entity, quote.id, 'UNIT_PRICE', quote.unitPriceDecimal, quote.unitPrice);
      const total = money(entity, quote.id, 'TOTAL_PRICE', quote.totalPriceDecimal, quote.totalPrice);
      if (unit && total && Number.isSafeInteger(quote.quantity) && quote.quantity > 0 && !calculateMoneyTotal(unit, quote.quantity).equals(total)) add(entity, quote.id, 'LINE_TOTAL_MISMATCH');
      const rfq = quote.rfqId ? rfqs.get(quote.rfqId) : null;
      if (quote.rfqId && !rfq) add(entity, quote.id, 'MISSING_RFQ');
      if (rfq && !isExplicitDemandPart(rfq, quote.partNumber)) add(entity, quote.id, 'RFQ_PART_MISMATCH');
      if (rfq && quote.quantity > rfq.quantity) add(entity, quote.id, 'QUANTITY_EXCEEDS_DEMAND');
    }
  }
  for (const quote of legacyInput.supplierQuotes) {
    const inquiry = quote.inquiryId ? inquiries.get(quote.inquiryId) : null;
    if (!quote.rfqId && !quote.inquiryId) add('supplierQuotes', quote.id, 'LEGACY_UNLINKED', 'REVIEW');
    if (quote.inquiryId && !inquiry) add('supplierQuotes', quote.id, 'MISSING_INQUIRY');
    if (inquiry && inquiry.supplierId !== quote.supplierId) add('supplierQuotes', quote.id, 'INQUIRY_SUPPLIER_MISMATCH');
    if (inquiry) {
      const matchingItems = (itemGroups.get(inquiry.id) ?? []).filter(item => item.partNumber === quote.partNumber && quote.quantity <= item.quantity);
      if (matchingItems.length !== 1) add('supplierQuotes', quote.id, 'INQUIRY_ITEM_UNRESOLVED', 'REVIEW', matchingItems.map(item => item.id));
      const rfq = quote.rfqId ? rfqs.get(quote.rfqId) : null;
      if (rfq && matchingItems.length === 1 && !sameDemand(matchingItems[0], rfq)) add('supplierQuotes', quote.id, 'SOURCE_PATH_CONFLICT');
    }
  }
  for (const quote of legacyInput.quotations) {
    money('quotations', quote.id, 'COST_PRICE', quote.costPriceDecimal, quote.costPrice);
    if (quote.currency !== 'USD') add('quotations', quote.id, 'NON_USD_QUOTATION', 'REVIEW');
  }
  const ordered = new Map<string, number>();
  for (const order of legacyInput.orders) {
    ordered.set(order.quotationId, (ordered.get(order.quotationId) ?? 0) + order.quantity);
    const total = money('orders', order.id, 'TOTAL_AMOUNT', order.totalAmountDecimal, order.totalAmount);
    const quote = quotations.get(order.quotationId);
    if (!quote) add('orders', order.id, 'MISSING_QUOTATION');
    else {
      if (order.partNumber !== quote.partNumber) add('orders', order.id, 'QUOTATION_PART_MISMATCH');
      try {
        if (total && !calculateMoneyTotal(quote.unitPriceDecimal ?? quote.unitPrice, order.quantity).equals(total)) add('orders', order.id, 'ORDER_PRICE_DIFFERS_FROM_QUOTATION', 'REVIEW');
      } catch { add('orders', order.id, 'INVALID_QUOTATION_PRICE'); }
    }
    if (!Number.isSafeInteger(order.outboundQuantity) || order.outboundQuantity < 0 || order.outboundQuantity > order.quantity) add('orders', order.id, 'INVALID_OUTBOUND_QUANTITY');
  }
  for (const [id, quantity] of ordered) {
    const quote = quotations.get(id);
    if (quote && quantity > quote.quantity) add('quotations', id, 'ORDERED_QUANTITY_EXCEEDS_QUOTATION');
  }
  const blockers = issues.filter(issue => issue.severity === 'BLOCKER').length;
  return {
    status: blockers ? 'BLOCKED' : issues.length ? 'REVIEW_REQUIRED' : 'PASS',
    counts: Object.fromEntries(Object.entries(legacyInput).map(([entity, rows]) => [entity, rows.length])),
    skippedModern: {
      rfqs: modernRfqIds.size,
      quotations: modernQuotationIds.size,
      orders: modernOrderIds.size,
    },
    blockers, reviews: issues.length - blockers, issues, inquiryCandidates,
    migrationApplied: false,
  };
}
