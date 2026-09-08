import { describe, expect, it } from 'vitest';
import { buildTransactionLineBackfillPlan, type TransactionLineBackfillInput } from './transactionLineBackfill.js';

const requiredDate = new Date('2026-10-01T00:00:00.000Z');

function fixture(): TransactionLineBackfillInput {
  const rfq = {
    id: 'r1', partNumber: 'P1', quantity: 10, requiredDate, certificateRequired: true,
    targetPriceCurrency: 'USD', uom: 'EA', conditionCode: 'NE', description: 'one line',
    serialNumber: null, batchNumber: null, alternatePartNumbers: null, certificateType: null,
    leadTimeDays: 7, targetPrice: 12.5, status: 'PENDING',
  };
  const quotation = {
    id: 'q1', rfqId: 'r1', partNumber: 'P1', quantity: 4, unitPrice: 3.25,
    unitPriceDecimal: '3.2500', totalPrice: 13, totalPriceDecimal: '13.0000',
    costPrice: 2, costPriceDecimal: '2.0000', currency: 'USD', reservedQuantity: 0,
    inventoryDetailId: null, serialNumber: null, batchNumber: null, status: 'DRAFT',
    costSourceType: 'MANUAL', costSourceId: null,
  };
  const order = {
    id: 'o1', quotationId: 'q1', partNumber: 'P1', quantity: 2, totalAmount: 6.5,
    totalAmountDecimal: '6.5000', outboundQuantity: 0, inventoryDetailId: null,
    serialNumber: null, batchNumber: null, outboundStatus: 'PENDING',
  };
  return {
    preflight: {
      rfqs: [{ id: rfq.id, partNumber: rfq.partNumber, quantity: rfq.quantity, requiredDate, certificateRequired: true, targetPriceCurrency: rfq.targetPriceCurrency }],
      inquiries: [], inquiryItems: [], supplierQuotes: [],
      quotations: [{ id: quotation.id, rfqId: quotation.rfqId, partNumber: quotation.partNumber, quantity: quotation.quantity, unitPrice: quotation.unitPrice, unitPriceDecimal: quotation.unitPriceDecimal, totalPrice: quotation.totalPrice, totalPriceDecimal: quotation.totalPriceDecimal, costPrice: quotation.costPrice, costPriceDecimal: quotation.costPriceDecimal, currency: quotation.currency }],
      orders: [{ id: order.id, quotationId: order.quotationId, partNumber: order.partNumber, quantity: order.quantity, totalAmount: order.totalAmount, totalAmountDecimal: order.totalAmountDecimal, outboundQuantity: order.outboundQuantity }],
    },
    rfqs: [rfq], inquiries: [], inquiryItems: [], supplierQuotes: [], quotations: [quotation], orders: [order],
  };
}

describe('transaction line backfill plan', () => {
  it('plans one compatible line per legacy document and is idempotent', () => {
    const input = fixture();
    const before = structuredClone(input);
    const first = buildTransactionLineBackfillPlan(input);
    expect(first.status).toBe('READY');
    expect(first.rfqLines).toHaveLength(1);
    expect(first.quotationLines).toHaveLength(1);
    expect(first.orderLines).toHaveLength(1);
    expect(first.orderLines[0].uom).toBe('EA');
    expect(input).toEqual(before);

    const second = buildTransactionLineBackfillPlan({
      ...input,
      existingRfqLines: first.rfqLines,
      existingQuotationLines: first.quotationLines,
      existingOrderLines: first.orderLines,
    });
    expect(second.status).toBe('READY');
    expect(second.rfqLines).toEqual([]);
    expect(second.quotationLines).toEqual([]);
    expect(second.orderLines).toEqual([]);
    expect(second.skippedExisting).toEqual({ rfqLines: 1, quotationLines: 1, orderLines: 1 });
  });

  it('keeps historical Inquiry source unlinked and reports review even with one candidate', () => {
    const input = fixture();
    input.inquiries = [{ id: 'i1', supplierId: 's1', rfqId: null }];
    input.inquiryItems = [{ id: 'ii1', inquiryId: 'i1', lineNo: 1, rfqLineId: null, partNumber: 'P1', quantity: 10, requiredDate, certificateRequired: true }];
    input.preflight.inquiries = [{ id: 'i1', supplierId: 's1' }];
    input.preflight.inquiryItems = [{ id: 'ii1', inquiryId: 'i1', partNumber: 'P1', quantity: 10, requiredDate, certificateRequired: true }];

    const plan = buildTransactionLineBackfillPlan(input);
    expect(plan.status).toBe('REVIEW_REQUIRED');
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'UNCONFIRMED_SOURCE_CANDIDATE', severity: 'REVIEW' }));
    expect(plan.inquiryItemLinks).toEqual([]);
    expect(plan.rfqLines).toHaveLength(1);
  });

  it('links an InquiryItem only after an explicit Inquiry.rfqId and exact row evidence', () => {
    const input = fixture();
    input.inquiries = [{ id: 'i1', supplierId: 's1', rfqId: 'r1' }];
    input.inquiryItems = [{ id: 'ii1', inquiryId: 'i1', lineNo: 1, rfqLineId: null, partNumber: 'P1', quantity: 10, requiredDate, certificateRequired: true }];
    input.preflight.inquiries = [{ id: 'i1', supplierId: 's1' }];
    input.preflight.inquiryItems = [{ id: 'ii1', inquiryId: 'i1', partNumber: 'P1', quantity: 10, requiredDate, certificateRequired: true }];

    const plan = buildTransactionLineBackfillPlan(input);
    expect(plan.inquiryItemLinks).toEqual([{ id: 'ii1', rfqLineId: 'rfq-line-r1' }]);
  });

  it('blocks amount corruption without repairing the legacy fact', () => {
    const input = fixture();
    input.quotations[0].totalPriceDecimal = '99.0000';
    input.preflight.quotations[0].totalPriceDecimal = '99.0000';
    const plan = buildTransactionLineBackfillPlan(input);
    expect(plan.status).toBe('BLOCKED');
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'LINE_TOTAL_MISMATCH' }));
    expect(plan.rfqLines).toEqual([]);
    expect(input.quotations[0].totalPriceDecimal).toBe('99.0000');
  });

  it('preserves non-USD RFQ target-price currency as a review, while commercial lines stay USD-only', () => {
    const input = fixture();
    input.rfqs[0].targetPriceCurrency = 'EUR';
    input.preflight.rfqs[0].targetPriceCurrency = 'EUR';
    const plan = buildTransactionLineBackfillPlan(input);
    expect(plan.status).toBe('REVIEW_REQUIRED');
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'NON_USD_TARGET', severity: 'REVIEW' }));
    expect(plan.rfqLines[0].targetPriceCurrency).toBe('EUR');
    expect(plan.quotationLines).toHaveLength(1);
    expect(plan.quotationLines[0].currency).toBe('USD');
  });

  it('links a supplier quote by exact RFQ row and blocks a forged existing link', () => {
    const input = fixture();
    const supplierQuote = {
      id: 'sq1', rfqId: 'r1', inquiryId: null, supplierId: 's1', partNumber: 'P1', quantity: 2,
      unitPrice: 2, unitPriceDecimal: '2.0000', totalPrice: 4, totalPriceDecimal: '4.0000',
      description: null, validUntil: null, status: 'pending', isWinner: false, rfqLineId: null as string | null, inquiryItemId: null as string | null,
    };
    input.supplierQuotes = [supplierQuote];
    input.preflight.supplierQuotes = [{ id: 'sq1', rfqId: 'r1', inquiryId: null, supplierId: 's1', partNumber: 'P1', quantity: 2, unitPrice: 2, unitPriceDecimal: '2.0000', totalPrice: 4, totalPriceDecimal: '4.0000' }];
    expect(buildTransactionLineBackfillPlan(input).supplierQuoteLinks).toEqual([{ id: 'sq1', rfqLineId: 'rfq-line-r1' }]);

    supplierQuote.rfqLineId = 'forged';
    expect(buildTransactionLineBackfillPlan(input).status).toBe('BLOCKED');
    expect(buildTransactionLineBackfillPlan(input).issues).toContainEqual(expect.objectContaining({ code: 'EXISTING_SUPPLIER_QUOTE_LINE_MISMATCH' }));
  });

  it('keeps an explicit supplier source link when its live quantity later falls', () => {
    const input = fixture();
    const source = {
      id: 'sq-approved', rfqId: 'r1', inquiryId: null, supplierId: 's1', partNumber: 'P1', quantity: 1,
      unitPrice: 2, unitPriceDecimal: '2.0000', totalPrice: 2, totalPriceDecimal: '2.0000',
      description: null, validUntil: null, status: 'accepted', isWinner: true, rfqLineId: 'rfq-line-r1', inquiryItemId: null as string | null,
    };
    input.quotations[0].costSourceType = 'SUPPLIER_QUOTE';
    input.quotations[0].costSourceId = source.id;
    input.supplierQuotes = [source];
    input.preflight.supplierQuotes = [{ id: source.id, rfqId: source.rfqId, inquiryId: null, supplierId: source.supplierId, partNumber: source.partNumber, quantity: source.quantity, unitPrice: source.unitPrice, unitPriceDecimal: source.unitPriceDecimal, totalPrice: source.totalPrice, totalPriceDecimal: source.totalPriceDecimal }];

    const plan = buildTransactionLineBackfillPlan(input);
    expect(plan.status).not.toBe('BLOCKED');
    expect(plan.quotationLines[0].sourceSupplierQuoteId).toBe(source.id);
  });

  it('blocks an explicit supplier source type without a source id', () => {
    const input = fixture();
    input.quotations[0].costSourceType = 'SUPPLIER_QUOTE';
    input.quotations[0].costSourceId = null;
    const plan = buildTransactionLineBackfillPlan(input);
    expect(plan.status).toBe('BLOCKED');
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'SUPPLIER_QUOTE_COST_SOURCE_MISSING' }));
  });

  it('rejects conflicting effective source paths in the same apply plan', () => {
    const input = fixture();
    input.rfqs.push({ ...input.rfqs[0], id: 'r2' });
    input.preflight.rfqs.push({ ...input.preflight.rfqs[0], id: 'r2' });
    input.inquiries = [{ id: 'i1', supplierId: 's1', rfqId: 'r2' }];
    input.inquiryItems = [{ id: 'ii1', inquiryId: 'i1', lineNo: 1, rfqLineId: null, partNumber: 'P1', quantity: 10, requiredDate, certificateRequired: true }];
    input.preflight.inquiries = [{ id: 'i1', supplierId: 's1' }];
    input.preflight.inquiryItems = [{ id: 'ii1', inquiryId: 'i1', partNumber: 'P1', quantity: 10, requiredDate, certificateRequired: true }];
    const supplierQuote = {
      id: 'sq-conflict', rfqId: 'r1', inquiryId: 'i1', supplierId: 's1', partNumber: 'P1', quantity: 2,
      unitPrice: 2, unitPriceDecimal: '2.0000', totalPrice: 4, totalPriceDecimal: '4.0000',
      description: null, validUntil: null, status: 'pending', isWinner: false, rfqLineId: null as string | null, inquiryItemId: null as string | null,
    };
    input.supplierQuotes = [supplierQuote];
    input.preflight.supplierQuotes = [{ id: supplierQuote.id, rfqId: supplierQuote.rfqId, inquiryId: supplierQuote.inquiryId, supplierId: supplierQuote.supplierId, partNumber: supplierQuote.partNumber, quantity: supplierQuote.quantity, unitPrice: supplierQuote.unitPrice, unitPriceDecimal: supplierQuote.unitPriceDecimal, totalPrice: supplierQuote.totalPrice, totalPriceDecimal: supplierQuote.totalPriceDecimal }];
    const plan = buildTransactionLineBackfillPlan(input);
    expect(plan.status).toBe('BLOCKED');
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'SUPPLIER_QUOTE_SOURCE_PATH_CONFLICT' }));
    expect(plan.supplierQuoteLinks).toEqual([]);
  });
});
