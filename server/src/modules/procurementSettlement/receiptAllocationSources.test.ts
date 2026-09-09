import { describe, expect, it } from 'vitest';
import { deriveReceiptAllocationSources, type ReceiptStockSource, type SourcedAllocation } from './receiptAllocationSources.js';

const receipt: ReceiptStockSource = { id: 'receipt', purchaseCommitmentLineId: 'purchase-line', orderLineId: 'order-line',
  inventoryDetailId: 'detail', quantity: 5, status: 'ACCEPTED' };
const returned = { id: 'return', inventoryDetailId: 'detail', quantity: 1, status: 'RELEASED' };
const allocation = (id: string, quantity: number, consumed = 0): SourcedAllocation => ({ id, inventoryDetailId: 'detail', stockReceiptLineId: 'receipt',
  sourceReturnHoldId: null, allocatedQuantity: quantity, releasedQuantity: 0, consumedQuantity: consumed,
  assignments: [{ id: `${id}-assignment`, orderLineId: 'order-line', assignedQuantity: quantity, releasedQuantity: 0, consumedQuantity: consumed }] });
describe('original purchase stock and return resale provenance', () => {
  it('keeps original procurement usage and a released return in separate source pools', () => {
    const original = allocation('original', 5, 5);
    const resale = allocation('resale', 1); resale.stockReceiptLineId = null; resale.sourceReturnHoldId = 'return';
    resale.assignments[0].orderLineId = 'new-order-line';
    const result = deriveReceiptAllocationSources({ receipts: [receipt], returns: [returned], allocations: [original, resale] });
    expect(result.assignments).toEqual([
      { assignmentId: 'original-assignment', purchaseLineId: 'purchase-line', orderLineId: 'order-line' },
      { assignmentId: 'resale-assignment', purchaseLineId: null, orderLineId: 'new-order-line' },
    ]);
    expect(result.receipts[0].remainingQuantity).toBe(0); expect(result.returns[0].remainingQuantity).toBe(0);
  });
  it('does not let a physical return refill already-consumed procurement source', () => {
    expect(() => deriveReceiptAllocationSources({ receipts: [receipt], returns: [returned],
      allocations: [allocation('original', 5, 5), allocation('forged', 1)] })).toThrow(/超过验收量/);
  });
  it('cannot spend quarantined returns or repeat a released return allocation', () => {
    const resale = allocation('resale', 2); resale.stockReceiptLineId = null; resale.sourceReturnHoldId = 'return';
    expect(() => deriveReceiptAllocationSources({ receipts: [receipt], returns: [returned], allocations: [resale] })).toThrow(/超过真实放行/);
    resale.allocatedQuantity = 1; resale.assignments[0].assignedQuantity = 1;
    expect(() => deriveReceiptAllocationSources({ receipts: [receipt], returns: [{ ...returned, status: 'QUARANTINED' }], allocations: [resale] })).toThrow(/已放行退货/);
  });
  it('prevents diverting original back-to-back stock to another sales line', () => {
    const item = allocation('original', 2); item.assignments[0].orderLineId = 'other-order-line';
    expect(() => deriveReceiptAllocationSources({ receipts: [receipt], returns: [], allocations: [item] })).toThrow(/对应的销售行/);
  });
  it('requires explicit accepted lineage and disallows claiming two sources', () => {
    const item = allocation('original', 2);
    expect(() => deriveReceiptAllocationSources({ receipts: [{ ...receipt, status: 'PENDING_REVIEW' }], returns: [], allocations: [item] })).toThrow(/验收收货/);
    item.stockReceiptLineId = null;
    expect(() => deriveReceiptAllocationSources({ receipts: [receipt], returns: [], allocations: [item] })).toThrow(/不能省略/);
    item.stockReceiptLineId = 'receipt'; item.sourceReturnHoldId = 'return';
    expect(() => deriveReceiptAllocationSources({ receipts: [receipt], returns: [returned], allocations: [item] })).toThrow(/同时消费/);
  });
  it('released reservations free source capacity while consumption remains historical', () => {
    const item = allocation('first', 5, 3); item.releasedQuantity = 2; item.assignments[0].releasedQuantity = 2;
    const result = deriveReceiptAllocationSources({ receipts: [receipt], returns: [], allocations: [item, allocation('second', 2)] });
    expect(result.receipts[0].committedQuantity).toBe(5);
  });
  it('does not permit unassigned or partially assigned original receipt allocations', () => {
    const empty = allocation('empty', 2); empty.assignments = [];
    const partial = allocation('partial', 2); partial.assignments[0].assignedQuantity = 1;
    for (const item of [empty, partial]) {
      expect(() => deriveReceiptAllocationSources({ receipts: [receipt], returns: [], allocations: [item] })).toThrow(/完整绑定原销售行/);
    }
    const released = allocation('released', 2); released.releasedQuantity = 2; released.assignments[0].releasedQuantity = 2;
    expect(deriveReceiptAllocationSources({ receipts: [receipt], returns: [], allocations: [released] }).receipts[0].remainingQuantity).toBe(5);
  });
});
