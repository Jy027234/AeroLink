import { describe, expect, it } from 'vitest';
import {
  deriveReceiptDecision,
  deriveReceiptQuantities,
  type PurchaseReceiptLine,
  type PurchaseReceiptPurchaseLine,
} from './receiptQuantities.js';

const purchase = (overrides: Partial<PurchaseReceiptPurchaseLine> = {}): PurchaseReceiptPurchaseLine => ({
  id: 'purchase-line-1', quantity: 10, cancelledQuantity: 1, receivedQuantity: 3, directShippedQuantity: 1, ...overrides,
});

const receipt = (overrides: Partial<PurchaseReceiptLine> = {}): PurchaseReceiptLine => ({
  id: 'receipt-1', purchaseLineId: 'purchase-line-1', quantity: 3, status: 'ACCEPTED', ...overrides,
});

describe('purchase receipt quantities', () => {
  it('derives repeated arrivals for one purchase line and keeps rejected history out of occupancy', () => {
    const result = deriveReceiptQuantities({
      purchaseLines: [purchase()],
      receiptLines: [
        receipt({ id: 'accepted-1', quantity: 1 }),
        receipt({ id: 'accepted-2', quantity: 2 }),
        receipt({ id: 'pending-1', quantity: 2, status: 'PENDING_REVIEW' }),
        receipt({ id: 'rejected-1', quantity: 4, status: 'REJECTED' }),
      ],
    });

    expect(result.perPurchaseLine).toEqual([{
      purchaseLineId: 'purchase-line-1', purchaseQuantity: 10, cancelledQuantity: 1,
      directShippedQuantity: 1, outstandingArrival: 3, pendingReview: 2, accepted: 3, rejected: 4,
    }]);
    expect(result.headTotals).toMatchObject({
      purchaseQuantity: 10, cancelledQuantity: 1, directShippedQuantity: 1,
      outstandingArrival: 3, pendingReview: 2, accepted: 3, rejected: 4, receiptLineCount: 4,
    });
  });

  it('supports multiple purchase lines sharing one purchase head and aggregates totals', () => {
    const result = deriveReceiptQuantities({
      purchaseLines: [
        purchase({ id: 'purchase-line-1', quantity: 5, cancelledQuantity: 0, receivedQuantity: 2, directShippedQuantity: 0 }),
        purchase({ id: 'purchase-line-2', quantity: 4, cancelledQuantity: 1, receivedQuantity: 1, directShippedQuantity: 1 }),
      ],
      receiptLines: [
        receipt({ id: 'line-1-receipt', purchaseLineId: 'purchase-line-1', quantity: 2 }),
        receipt({ id: 'line-2-receipt', purchaseLineId: 'purchase-line-2', quantity: 1 }),
        receipt({ id: 'line-2-pending', purchaseLineId: 'purchase-line-2', quantity: 1, status: 'PENDING_REVIEW' }),
      ],
    });

    expect(result.perPurchaseLine.map(line => line.outstandingArrival)).toEqual([3, 0]);
    expect(result.headTotals).toMatchObject({
      purchaseQuantity: 9, cancelledQuantity: 1, directShippedQuantity: 1,
      outstandingArrival: 3, pendingReview: 1, accepted: 3, rejected: 0,
    });
  });

  it('allows replacement stock after rejection without treating rejection as return or refund', () => {
    const result = deriveReceiptQuantities({
      purchaseLines: [purchase({ quantity: 5, cancelledQuantity: 0, receivedQuantity: 5, directShippedQuantity: 0 })],
      receiptLines: [
        receipt({ id: 'rejected-batch', quantity: 5, status: 'REJECTED' }),
        receipt({ id: 'replacement-batch', quantity: 5, status: 'ACCEPTED' }),
      ],
    });

    expect(result.perPurchaseLine[0]).toMatchObject({ accepted: 5, rejected: 5, outstandingArrival: 0 });
  });

  it('requires accepted facts to reconcile exactly to PurchaseLine.receivedQuantity', () => {
    expect(() => deriveReceiptQuantities({
      purchaseLines: [purchase({ receivedQuantity: 2 })],
      receiptLines: [receipt({ quantity: 3 })],
    })).toThrowError(expect.objectContaining({ code: 'RECEIVED_QUANTITY_MISMATCH' }));
  });

  it('rejects accepted and pending quantities that exceed the purchase after cancellation and direct shipment', () => {
    expect(() => deriveReceiptQuantities({
      purchaseLines: [purchase({ quantity: 5, cancelledQuantity: 1, receivedQuantity: 3, directShippedQuantity: 0 })],
      receiptLines: [receipt({ quantity: 3 }), receipt({ id: 'pending', quantity: 2, status: 'PENDING_REVIEW' })],
    })).toThrowError(expect.objectContaining({ code: 'RECEIPT_COVERAGE_EXCEEDED' }));
  });

  it('rejects a direct and cancelled total beyond the purchase even without receipts', () => {
    expect(() => deriveReceiptQuantities({
      purchaseLines: [purchase({ quantity: 3, cancelledQuantity: 2, receivedQuantity: 0, directShippedQuantity: 2 })],
      receiptLines: [],
    })).toThrowError(expect.objectContaining({ code: 'RECEIPT_COVERAGE_EXCEEDED' }));
  });

  it('rejects unknown sources and duplicate purchase or receipt identities', () => {
    expect(() => deriveReceiptQuantities({
      purchaseLines: [purchase()],
      receiptLines: [receipt({ purchaseLineId: 'missing' })],
    })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_PURCHASE_LINE' }));
    expect(() => deriveReceiptQuantities({
      purchaseLines: [purchase(), purchase({ id: 'purchase-line-1' })],
      receiptLines: [],
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_PURCHASE_LINE_ID' }));
    expect(() => deriveReceiptQuantities({
      purchaseLines: [purchase()],
      receiptLines: [receipt(), receipt()],
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_RECEIPT_LINE_ID' }));
  });

  it('rejects zero, fractional, negative, non-finite and over-Int32 quantities', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => deriveReceiptQuantities({
        purchaseLines: [purchase({ quantity: 10, receivedQuantity: 0 })],
        receiptLines: [receipt({ quantity })],
      })).toThrow();
    }
  });

  it('projects a decision without mutating the historical receipt fact', () => {
    const pending = receipt({ status: 'PENDING_REVIEW', quantity: 2 });
    const accepted = deriveReceiptDecision(pending, 'ACCEPTED');
    expect(accepted).toEqual({ ...pending, status: 'ACCEPTED' });
    expect(pending.status).toBe('PENDING_REVIEW');
    expect(() => deriveReceiptDecision(accepted, 'REJECTED')).toThrowError(expect.objectContaining({ code: 'INVALID_DECISION' }));
  });

  it('rejects an invalid status instead of silently treating it as rejected history', () => {
    expect(() => deriveReceiptQuantities({
      purchaseLines: [purchase({ receivedQuantity: 0 })],
      receiptLines: [receipt({ quantity: 1, status: 'RETURNED' as PurchaseReceiptLine['status'] })],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT_STATUS' }));
  });
});
