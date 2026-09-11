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

  it('reconciles an active supplier-direct line against the purchase and order projections', () => {
    const input = fixture();
    input.orders[0].directShippedQuantity = 1;
    input.orders[0].lines[0].directShippedQuantity = 1;
    input.directPurchaseLines = [{
      id: 'pcl1', purchaseCommitmentId: 'pc1', orderLineId: 'ol1', quantity: 1,
      cancelledQuantity: 0, receivedQuantity: 0, directShippedQuantity: 1, fulfillmentMode: 'SUPPLIER_DIRECT',
    }];
    input.directShipmentLines = [{
      id: 'dsl1', shipmentId: 'ds1', shipmentStatus: 'DISPATCHED', orderId: 'o1', orderLineId: 'ol1',
      purchaseCommitmentId: 'pc1', purchaseCommitmentLineId: 'pcl1', quantity: 1, receivedQuantity: 0, reviewStatus: 'APPROVED',
    }];
    expect(reconcileTransactionLines(input)).toMatchObject({ status: 'PASS', blockers: 0 });
  });

  it('blocks direct projection drift even when legacy local outbound facts still match', () => {
    const input = fixture();
    input.orders[0].directShippedQuantity = 1;
    input.orders[0].lines[0].directShippedQuantity = 0;
    input.directPurchaseLines = [{
      id: 'pcl1', purchaseCommitmentId: 'pc1', orderLineId: 'ol1', quantity: 1,
      cancelledQuantity: 0, receivedQuantity: 0, directShippedQuantity: 0, fulfillmentMode: 'SUPPLIER_DIRECT',
    }];
    input.directShipmentLines = [{
      id: 'dsl1', shipmentId: 'ds1', shipmentStatus: 'DISPATCHED', orderId: 'o1', orderLineId: 'ol1',
      purchaseCommitmentId: 'pc1', purchaseCommitmentLineId: 'pcl1', quantity: 1, receivedQuantity: 0, reviewStatus: 'APPROVED',
    }];
    const report = reconcileTransactionLines(input);
    expect(report.status).toBe('BLOCKED');
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'DIRECT_SHIPPED_PURCHASE_LINE_MISMATCH',
      'DIRECT_SHIPPED_LINE_MISMATCH',
    ]));
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

  function modernFixture(): TransactionLineReconciliationInput {
    const modernDemand = (id: string, lineNo: number, partNumber: string, quantity: number) => ({
      ...demandTerms,
      id,
      rfqId: 'modern-rfq',
      lineNo,
      partNumber,
      quantity,
      uom: 'EA',
      conditionCode: 'NE',
      targetPriceDecimal: '10.0000',
      targetPriceCurrency: 'USD',
    });
    const manualSnapshot = (partNumber: string, quantity: number, costPrice: number, reason: string) => JSON.stringify({
      type: 'MANUAL', id: null, currency: 'USD', costPrice, partNumber, quantity,
      status: null, supplierId: null, capturedAt: '2026-09-08T00:00:00.000Z', reason,
    });
    const quotationLines = [
      {
        ...identity,
        id: 'modern-ql1', quotationId: 'modern-q', lineNo: 1, rfqLineId: 'modern-rl1', sourceSupplierQuoteId: null,
        partNumber: 'P1', quantity: 2, unitPrice: '10.0000', costPrice: '6.0000', lineTotal: '20.0000',
        marginAmount: '8.0000', marginPercent: '40.0000', currency: 'USD', acceptedQuantity: 1, reservedQuantity: 2,
        costSourceType: 'MANUAL', costSourceId: null, costSourceReason: 'line cost sheet',
        costSourceSnapshotJson: manualSnapshot('P1', 2, 6, 'line cost sheet'),
      },
      {
        ...identity,
        id: 'modern-ql2', quotationId: 'modern-q', lineNo: 2, rfqLineId: 'modern-rl2', sourceSupplierQuoteId: null,
        partNumber: 'P2', quantity: 3, unitPrice: '20.0000', costPrice: '10.0000', lineTotal: '60.0000',
        marginAmount: '30.0000', marginPercent: '50.0000', currency: 'USD', acceptedQuantity: 2, reservedQuantity: 0,
        costSourceType: 'MANUAL', costSourceId: null, costSourceReason: 'line cost sheet',
        costSourceSnapshotJson: manualSnapshot('P2', 3, 10, 'line cost sheet'),
      },
    ];
    const orderLines = [
      {
        ...identity,
        id: 'modern-ol1', orderId: 'modern-o', lineNo: 1, quotationLineId: 'modern-ql1', partNumber: 'P1', quantity: 1,
        unitPrice: '10.0000', lineTotal: '10.0000', currency: 'USD', outboundQuantity: 0, outboundStatus: 'PENDING',
      },
      {
        ...identity,
        id: 'modern-ol2', orderId: 'modern-o', lineNo: 2, quotationLineId: 'modern-ql2', partNumber: 'P2', quantity: 2,
        unitPrice: '20.0000', lineTotal: '40.0000', currency: 'USD', outboundQuantity: 0, outboundStatus: 'PENDING',
      },
    ];
    return {
      rfqs: [{
        ...demandTerms, id: 'modern-rfq', partNumber: 'P1', quantity: 5, uom: 'EA', conditionCode: 'NE', targetPrice: 10,
        targetPriceCurrency: 'USD', lineItemsMode: true, lines: [
          modernDemand('modern-rl1', 1, 'P1', 4), modernDemand('modern-rl2', 2, 'P2', 6),
        ],
      }],
      inquiries: [], inquiryItems: [], supplierQuotes: [],
      quotations: [{
        ...identity, id: 'modern-q', lineItemsMode: true, rfqId: 'modern-rfq', partNumber: 'P1', quantity: 5,
        unitPrice: 0, unitPriceDecimal: '0.0000', totalPrice: 80, totalPriceDecimal: '80.0000', costPrice: 0,
        costPriceDecimal: '0.0000', currency: 'USD', reservedQuantity: 0, costSourceType: null, costSourceId: null,
        lines: quotationLines,
      }],
      orders: [{
        ...identity, id: 'modern-o', lineItemsMode: true, quotationId: 'modern-q', partNumber: 'P1', quantity: 3,
        totalAmount: 50, totalAmountDecimal: '50.0000', outboundQuantity: 0, outboundStatus: 'PENDING', lines: orderLines,
      }],
    };
  }

  it('reconciles modern multi-line commercial totals and accepted quantities per line', () => {
    const input = modernFixture();
    expect(reconcileTransactionLines(input)).toMatchObject({ status: 'PASS', blockers: 0 });

    // Reservation/partial acceptance are mutable state and must not make the
    // immutable commercial line or cost snapshot fail reconciliation.
    input.quotations[0].lines[0].reservedQuantity = 0;
    expect(reconcileTransactionLines(input)).toMatchObject({ status: 'PASS', blockers: 0 });
  });

  it('blocks a modern quotation line whose supplier source points at another RFQ line', () => {
    const input = modernFixture();
    input.quotations[0].lines[0].sourceSupplierQuoteId = 'sq-cross-line';
    input.quotations[0].lines[0].costSourceType = 'SUPPLIER_QUOTE';
    input.quotations[0].lines[0].costSourceId = 'sq-cross-line';
    input.quotations[0].lines[0].costSourceReason = null;
    input.quotations[0].lines[0].costSourceSnapshotJson = JSON.stringify({
      type: 'SUPPLIER_QUOTE', id: 'sq-cross-line', currency: 'USD', costPrice: 6,
      partNumber: 'P1', quantity: 2, status: 'pending', supplierId: 'supplier-1',
      capturedAt: '2026-09-08T00:00:00.000Z', reason: null,
    });
    input.supplierQuotes = [{
      id: 'sq-cross-line', inquiryId: null, rfqId: 'modern-rfq', rfqLineId: 'modern-rl2', inquiryItemId: null,
      supplierId: 'supplier-1', partNumber: 'P1', quantity: 2, unitPrice: 6, unitPriceDecimal: '6.0000',
      totalPrice: 12, totalPriceDecimal: '12.0000', currency: 'USD',
    }];
    const report = reconcileTransactionLines(input);
    expect(report.status).toBe('BLOCKED');
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_QUOTE_MISMATCH', id: 'modern-ql1' }));
    // A correctly linked source may change price/availability after approval.
    // Historical line costs remain governed by the captured evidence.
    Object.assign(input.supplierQuotes[0], {
      rfqLineId: 'modern-rl1', quantity: 1, unitPrice: 7, unitPriceDecimal: '7.0000', totalPrice: 7, totalPriceDecimal: '7.0000',
    });
    expect(reconcileTransactionLines(input)).toMatchObject({ status: 'PASS', blockers: 0 });
    const captured = JSON.parse(input.quotations[0].lines[0].costSourceSnapshotJson!);
    input.quotations[0].lines[0].costSourceSnapshotJson = JSON.stringify({ ...captured, costPrice: 7 });
    expect(reconcileTransactionLines(input).issues).toContainEqual(expect.objectContaining({ code: 'LINE_COST_SNAPSHOT_INVALID' }));
  });

  it('blocks a modern line whose supplier relation disagrees with its cost source projection', () => {
    const input = modernFixture();
    const line = input.quotations[0].lines[0];
    line.costSourceType = 'SUPPLIER_QUOTE';
    line.costSourceId = 'sq-cost-source';
    line.sourceSupplierQuoteId = 'sq-relation';
    line.costSourceReason = null;
    line.costSourceSnapshotJson = JSON.stringify({
      type: 'SUPPLIER_QUOTE', id: 'sq-cost-source', currency: 'USD', costPrice: 6,
      partNumber: 'P1', quantity: 2, status: 'pending', supplierId: 'supplier-1',
      capturedAt: '2026-09-08T00:00:00.000Z', reason: null,
    });
    const report = reconcileTransactionLines(input);
    expect(report.status).toBe('BLOCKED');
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_QUOTE_COST_SOURCE_MISMATCH', id: 'modern-ql1' }));
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'LINE_COST_SNAPSHOT_INVALID', id: 'modern-ql1' }));
  });

  it('blocks modern lines without an immutable cost snapshot', () => {
    const input = modernFixture();
    input.quotations[0].lines[1].costSourceSnapshotJson = null;
    const report = reconcileTransactionLines(input);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'MISSING_LINE_COST_SNAPSHOT', id: 'modern-ql2' }));
  });
});
