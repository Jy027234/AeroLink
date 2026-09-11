import { describe, expect, it } from 'vitest';
import { deriveProcurementCoverage, type ProcurementStockAssignment, type PurchaseQuantityFact } from './procurementQuantities.js';

const purchase = (overrides: Partial<PurchaseQuantityFact> = {}): PurchaseQuantityFact => ({
  id: 'purchase', quantity: 3, cancelledQuantity: 0, receivedQuantity: 0, directShippedQuantity: 0, ...overrides,
});
const assignment = (overrides: Partial<ProcurementStockAssignment> = {}): ProcurementStockAssignment => ({
  id: 'assignment', purchaseLineId: null, assignedQuantity: 2, releasedQuantity: 0, consumedQuantity: 0, ...overrides,
});

describe('sales demand and purchase coverage', () => {
  it('covers one sales line with both owned stock and a supplier commitment', () => {
    expect(deriveProcurementCoverage({ orderQuantity: 6, purchases: [purchase()], assignments: [assignment()] }))
      .toMatchObject({ ownStockCoverage: 2, committedPurchaseQuantity: 3, uncoveredQuantity: 1, fulfilledQuantity: 0 });
  });
  it('does not count receiving and consuming purchased inventory as a second commitment', () => {
    const result = deriveProcurementCoverage({ orderQuantity: 5, purchases: [purchase({ receivedQuantity: 3 })],
      assignments: [assignment({ consumedQuantity: 2 }), assignment({ id: 'purchased-stock', purchaseLineId: 'purchase', assignedQuantity: 3, consumedQuantity: 2 })] });
    expect(result).toMatchObject({ coveredQuantity: 5, uncoveredQuantity: 0, fulfilledQuantity: 4, remainingToFulfill: 1 });
    expect(result.purchases[0]).toMatchObject({ outstandingQuantity: 0, unassignedReceivedQuantity: 0, consumedReceivedQuantity: 2 });
  });
  it('separates actual direct shipment from stock receipt on a partially fulfilled commitment', () => {
    const result = deriveProcurementCoverage({ orderQuantity: 5, purchases: [purchase({ quantity: 5, receivedQuantity: 1, directShippedQuantity: 2 })],
      assignments: [assignment({ purchaseLineId: 'purchase', assignedQuantity: 1, consumedQuantity: 1 })] });
    expect(result).toMatchObject({ coveredQuantity: 5, fulfilledQuantity: 3, remainingToFulfill: 2 });
    expect(result.purchases[0].outstandingQuantity).toBe(2);
  });
  it('reopens demand after a valid cancellation while preserving received and consumed history', () => {
    const result = deriveProcurementCoverage({ orderQuantity: 3, purchases: [purchase({ cancelledQuantity: 1, receivedQuantity: 2 })],
      assignments: [assignment({ purchaseLineId: 'purchase', consumedQuantity: 1, releasedQuantity: 1 })] });
    expect(result).toMatchObject({ coveredQuantity: 2, uncoveredQuantity: 1, fulfilledQuantity: 1 });
    expect(result.purchases[0].unassignedReceivedQuantity).toBe(1);
  });
  it('rejects procurement that duplicates existing stock coverage', () => {
    expect(() => deriveProcurementCoverage({ orderQuantity: 4, purchases: [purchase()], assignments: [assignment()] })).toThrow(/超过销售行/);
  });
  it.each([
    purchase({ cancelledQuantity: 2, receivedQuantity: 2 }),
    purchase({ directShippedQuantity: 2, receivedQuantity: 2 }),
    purchase({ quantity: 0 }), purchase({ quantity: 2147483648 }), purchase({ receivedQuantity: -1 }),
  ])('rejects impossible or out-of-range purchase facts %#', fact => {
    expect(() => deriveProcurementCoverage({ orderQuantity: 3, purchases: [fact], assignments: [] })).toThrow();
  });
  it('rejects allocating an unreceived supplier promise as physical stock', () => {
    expect(() => deriveProcurementCoverage({ orderQuantity: 3, purchases: [purchase()],
      assignments: [assignment({ purchaseLineId: 'purchase' })] })).toThrow(/实际收货/);
  });
  it('rejects unknown provenance and duplicate facts', () => {
    expect(() => deriveProcurementCoverage({ orderQuantity: 3, purchases: [], assignments: [assignment({ purchaseLineId: 'missing' })] })).toThrow(/未知采购行/);
    expect(() => deriveProcurementCoverage({ orderQuantity: 6, purchases: [purchase(), purchase()], assignments: [] })).toThrow(/重复/);
    expect(() => deriveProcurementCoverage({ orderQuantity: 6, purchases: [], assignments: [assignment(), assignment()] })).toThrow(/重复/);
  });
  it('rejects over-consumption even when total demand is large', () => {
    expect(() => deriveProcurementCoverage({ orderQuantity: 10, purchases: [], assignments: [assignment({ consumedQuantity: 2, releasedQuantity: 1 })] })).toThrow(/分配初始数量/);
  });
});
