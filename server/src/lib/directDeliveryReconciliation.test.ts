import { describe, expect, it } from 'vitest';
import { reconcileDirectDeliveryProjection, type DirectDeliveryReconciliationInput } from './directDeliveryReconciliation.js';

function fixture(): DirectDeliveryReconciliationInput {
  return {
    orders: [{
      id: 'o1', quantity: 5, outboundQuantity: 1, directShippedQuantity: 2, lineItemsMode: true, status: 'SHIPPED',
      lines: [{ id: 'ol1', orderId: 'o1', quantity: 5, outboundQuantity: 1, directShippedQuantity: 2 }],
    }],
    purchaseLines: [{
      id: 'pcl1', purchaseCommitmentId: 'pc1', orderLineId: 'ol1', quantity: 2,
      cancelledQuantity: 0, receivedQuantity: 0, directShippedQuantity: 2, fulfillmentMode: 'SUPPLIER_DIRECT',
    }],
    directLines: [{
      id: 'dl1', shipmentId: 'ds1', shipmentStatus: 'PARTIALLY_RECEIVED', orderId: 'o1', orderLineId: 'ol1',
      purchaseCommitmentId: 'pc1', purchaseCommitmentLineId: 'pcl1', quantity: 2, receivedQuantity: 1, reviewStatus: 'APPROVED',
    }],
    localReceipts: [{ orderLineId: 'ol1', receivedQuantity: 1 }],
  };
}

describe('direct delivery reconciliation', () => {
  it('reconciles a mixed local and direct delivery without merging local outbound facts', () => {
    const report = reconcileDirectDeliveryProjection(fixture());
    expect(report).toMatchObject({ status: 'PASS', blockers: 0 });
    expect(report.byOrderLine).toEqual([expect.objectContaining({
      orderLineId: 'ol1', directShippedQuantity: 2, directReceivedQuantity: 1,
      localReceivedQuantity: 1, totalReceivedQuantity: 2, requiredQuantity: 5, complete: false,
    })]);
  });

  it('blocks drift in active line, purchase line, order line, and order header projections', () => {
    const input = fixture();
    input.orders[0].directShippedQuantity = 1;
    input.orders[0].lines[0].directShippedQuantity = 1;
    input.purchaseLines![0].directShippedQuantity = 1;
    const report = reconcileDirectDeliveryProjection(input);
    expect(report.status).toBe('BLOCKED');
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'DIRECT_SHIPPED_PURCHASE_LINE_MISMATCH',
      'DIRECT_SHIPPED_LINE_MISMATCH',
      'DIRECT_SHIPPED_ACTIVE_HEADER_MISMATCH',
    ]));
  });

  it('blocks local plus direct quantity overlap and mixed over-receipt', () => {
    const input = fixture();
    input.orders[0].lines[0].outboundQuantity = 4;
    input.localReceipts = [{ orderLineId: 'ol1', receivedQuantity: 5 }];
    const report = reconcileDirectDeliveryProjection(input);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'LOCAL_DIRECT_QUANTITY_OVERLAP',
      'MIXED_RECEIVED_QUANTITY_EXCEEDED',
    ]));
  });

  it('keeps each receipt source bounded by its own shipped projection', () => {
    const input = fixture();
    input.localReceipts = [{ orderLineId: 'ol1', receivedQuantity: 2 }];
    input.directLines[0].receivedQuantity = 3;
    const report = reconcileDirectDeliveryProjection(input);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'LOCAL_RECEIVED_EXCEEDS_OUTBOUND',
      'INVALID_DIRECT_LINE_RECEIVED_QUANTITY',
    ]));
  });

  it('blocks an active unapproved line and a stock purchase line used for direct shipment', () => {
    const input = fixture();
    input.directLines[0].reviewStatus = 'PENDING_REVIEW';
    input.purchaseLines![0].fulfillmentMode = 'STOCK_RECEIPT';
    const report = reconcileDirectDeliveryProjection(input);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'ACTIVE_DIRECT_LINE_NOT_APPROVED',
      'DIRECT_PURCHASE_MODE_MISMATCH',
    ]));
  });

  it('blocks a terminal order whose mixed delivery is incomplete', () => {
    const input = fixture();
    input.orders[0].status = 'DELIVERED';
    const report = reconcileDirectDeliveryProjection(input);
    expect(report.issues.map(issue => issue.code)).toContain('MIXED_DELIVERY_STATUS_MISMATCH');
  });

  it('blocks a direct shipment status that disagrees with its receipt quantity', () => {
    const input = fixture();
    input.directLines[0].shipmentStatus = 'DELIVERED';
    const report = reconcileDirectDeliveryProjection(input);
    expect(report.issues.map(issue => issue.code)).toContain('DIRECT_SHIPMENT_STATUS_MISMATCH');
  });

  it('treats omitted direct projections as legacy zero values', () => {
    const input = fixture();
    delete input.orders[0].directShippedQuantity;
    delete input.orders[0].lines[0].directShippedQuantity;
    input.directLines = [];
    input.purchaseLines = [];
    input.localReceipts = [];
    const report = reconcileDirectDeliveryProjection(input);
    expect(report.status).toBe('PASS');
  });
});
