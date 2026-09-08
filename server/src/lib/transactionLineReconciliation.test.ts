import { describe, expect, it } from 'vitest';
import { reconcileTransactionLines, type TransactionLineReconciliationInput } from './transactionLineReconciliation.js';

const requiredDate = new Date('2026-10-01T00:00:00.000Z');
const identity = { inventoryDetailId: null, serialNumber: null, batchNumber: null };
const demandTerms = { description: null, serialNumber: null, batchNumber: null, alternatePartNumbers: null as string | null, certificateType: null, leadTimeDays: null, requiredDate, certificateRequired: true };

function fixture(): TransactionLineReconciliationInput {
  const rfqLine = {
    ...demandTerms,
    id: 'rl1', rfqId: 'r1', lineNo: 1, partNumber: 'P1', quantity: 10, uom: 'EA', conditionCode: 'NE',
    requiredDate, certificateRequired: true, targetPriceDecimal: '12.5000', targetPriceCurrency: 'USD',
  };
  const quotationLine = {
    ...identity,
    id: 'ql1', quotationId: 'q1', lineNo: 1, rfqLineId: 'rl1', sourceSupplierQuoteId: null,
    partNumber: 'P1', quantity: 4, unitPrice: '3.2500', costPrice: '2.0000', lineTotal: '13.0000',
    marginAmount: '5.0000', marginPercent: '38.4615', currency: 'USD', acceptedQuantity: 2, reservedQuantity: 0,
  };
  const orderLine = {
    ...identity,
    id: 'ol1', orderId: 'o1', lineNo: 1, quotationLineId: 'ql1', partNumber: 'P1', quantity: 2,
    unitPrice: '3.2500', lineTotal: '6.5000', currency: 'USD', outboundQuantity: 0, outboundStatus: 'PENDING',
  };
  return {
    rfqs: [{ ...demandTerms, id: 'r1', partNumber: 'P1', quantity: 10, uom: 'EA', conditionCode: 'NE', targetPrice: 12.5, targetPriceCurrency: 'USD', lines: [rfqLine] }],
    inquiries: [], inquiryItems: [], supplierQuotes: [],
    quotations: [{ ...identity, costSourceType: null, costSourceId: null, reservedQuantity: 0, id: 'q1', rfqId: 'r1', partNumber: 'P1', quantity: 4, unitPrice: 3.25, unitPriceDecimal: '3.2500', totalPrice: 13, totalPriceDecimal: '13.0000', costPrice: 2, costPriceDecimal: '2.0000', currency: 'USD', lines: [quotationLine] }],
    orders: [{ ...identity, outboundQuantity: 0, outboundStatus: 'PENDING', id: 'o1', quotationId: 'q1', partNumber: 'P1', quantity: 2, totalAmount: 6.5, totalAmountDecimal: '6.5000', lines: [orderLine] }],
  };
}

describe('transaction line reconciliation', () => {
  it('passes a complete one-row chain without changing input', () => {
    const input = fixture();
    const before = structuredClone(input);
    expect(reconcileTransactionLines(input)).toMatchObject({ status: 'PASS', blockers: 0, migrationApplied: false });
    expect(input).toEqual(before);
  });

  it('blocks missing or duplicate one-row records and cross-document ownership', () => {
    const input = fixture();
    input.quotations[0].lines.push({ ...input.quotations[0].lines[0], id: 'ql2', lineNo: 2 });
    input.orders[0].lines[0].quotationLineId = 'other';
    const report = reconcileTransactionLines(input);
    expect(report.status).toBe('BLOCKED');
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['LINE_CARDINALITY_NOT_ONE', 'ORDER_QUOTATION_LINE_OWNER_MISMATCH']));
  });

  it('reports unresolved legacy source paths for review, but blocks forged source ownership', () => {
    const input = fixture();
    input.inquiries = [{ id: 'i1', supplierId: 's1', rfqId: null }];
    input.inquiryItems = [{ id: 'ii1', inquiryId: 'i1', lineNo: 1, rfqLineId: null, partNumber: 'P1', quantity: 10, requiredDate, certificateRequired: true }];
    input.supplierQuotes = [{ id: 'sq1', inquiryId: 'i1', rfqId: null, rfqLineId: null, inquiryItemId: null, supplierId: 's1', partNumber: 'P1', quantity: 2, unitPrice: 2, unitPriceDecimal: '2.0000', totalPrice: 4, totalPriceDecimal: '4.0000', currency: null }];
    const review = reconcileTransactionLines(input);
    expect(review.status).toBe('REVIEW_REQUIRED');
    expect(review.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['LEGACY_INQUIRY_SOURCE_UNRESOLVED', 'LEGACY_UNLINKED', 'SUPPLIER_QUOTE_CURRENCY_UNREVIEWED']));

    input.supplierQuotes[0].rfqLineId = 'rl1';
    input.supplierQuotes[0].rfqId = 'wrong-rfq';
    expect(reconcileTransactionLines(input).issues).toContainEqual(expect.objectContaining({ code: 'SUPPLIER_QUOTE_RFQ_OWNER_MISMATCH', severity: 'BLOCKER' }));
  });

  it('blocks amount mismatch instead of correcting the legacy/header facts', () => {
    const input = fixture();
    input.quotations[0].totalPriceDecimal = '14.0000';
    const before = input.quotations[0].totalPriceDecimal;
    const report = reconcileTransactionLines(input);
    expect(report.status).toBe('BLOCKED');
    expect(report.issues.map(issue => issue.code)).toContain('LINE_TOTAL_HEADER_MISMATCH');
    expect(input.quotations[0].totalPriceDecimal).toBe(before);
  });

  it('accepts an explicitly listed alternate part without using substring matching', () => {
    const input = fixture();
    input.rfqs[0].alternatePartNumbers = '["ALT-P1"]';
    input.rfqs[0].lines[0].alternatePartNumbers = '["ALT-P1"]';
    input.quotations[0].partNumber = 'ALT-P1';
    input.quotations[0].lines[0].partNumber = 'ALT-P1';
    input.orders[0].partNumber = 'ALT-P1';
    input.orders[0].lines[0].partNumber = 'ALT-P1';
    input.supplierQuotes = [{ id: 'sq1', inquiryId: null, rfqId: 'r1', rfqLineId: 'rl1', inquiryItemId: null, supplierId: 's1', partNumber: 'ALT-P1', quantity: 4, unitPrice: 2, unitPriceDecimal: '2.0000', totalPrice: 8, totalPriceDecimal: '8.0000', currency: 'USD' }];
    input.quotations[0].lines[0].sourceSupplierQuoteId = 'sq1';
    input.quotations[0].costSourceType = 'SUPPLIER_QUOTE';
    input.quotations[0].costSourceId = 'sq1';
    const report = reconcileTransactionLines(input);
    expect(report.status).toBe('PASS');
  });

  it('blocks missing target price, altered certificate terms and divergent fulfillment projections', () => {
    const input = fixture();
    input.rfqs[0].lines[0].targetPriceDecimal = null;
    input.rfqs[0].lines[0].certificateRequired = false;
    input.quotations[0].lines[0].reservedQuantity = 1;
    input.quotations[0].lines[0].acceptedQuantity = 0;
    input.quotations[0].costSourceType = 'SUPPLIER_QUOTE';
    input.quotations[0].costSourceId = 'missing-projection';
    input.orders[0].lines[0].outboundQuantity = 1;
    input.orders[0].lines[0].serialNumber = 'wrong-serial';
    expect(reconcileTransactionLines(input).issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'RFQ_TARGET_PRICE_MISMATCH', 'RFQ_DEMAND_TERMS_MISMATCH', 'RESERVED_QUANTITY_HEADER_MISMATCH',
      'ACCEPTED_QUANTITY_ORDER_MISMATCH', 'OUTBOUND_HEADER_MISMATCH', 'OUTBOUND_STATUS_QUANTITY_MISMATCH', 'INVENTORY_IDENTITY_HEADER_MISMATCH',
      'SOURCE_QUOTE_HEADER_MISMATCH',
    ]));
  });
});
