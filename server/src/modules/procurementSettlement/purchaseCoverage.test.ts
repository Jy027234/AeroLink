import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { assertAdditionalStockCoverage } from './purchaseCoverage.js';

describe('stock and purchase shared demand coverage', () => {
  function fixture() {
    const findMany = vi.fn().mockResolvedValue([{ id: 'purchase-line', quantity: 4, cancelledQuantity: 0, receivedQuantity: 0, directShippedQuantity: 0 }]);
    return { findMany, tx: { purchaseCommitmentLine: { findMany } } as unknown as Prisma.TransactionClient };
  }
  it('allows 6 stock plus 4 purchase against 10 and filters by exact order line and active states', async () => {
    const f = fixture();
    const result = await assertAdditionalStockCoverage(f.tx, { orderLineId: 'line', orderQuantity: 10, assignments: [], additionalAssignments: [{ quantity: 6, purchaseLineId: null }] });
    expect(result.coveredQuantity).toBe(10);
    expect(f.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      orderLineId: 'line', purchaseCommitment: { status: { in: ['PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED'] } },
    } }));
  });
  it('rejects a seventh stock unit when procurement has already occupied four', async () => {
    const f = fixture();
    await expect(assertAdditionalStockCoverage(f.tx, { orderLineId: 'line', orderQuantity: 10, assignments: [], additionalAssignments: [{ quantity: 7, purchaseLineId: null }] }))
      .rejects.toMatchObject({ code: 'ALLOCATION_INCONSISTENT' });
  });
  it('keeps consumed units covered and frees only released units', async () => {
    const f = fixture(); const args = { orderLineId: 'line', orderQuantity: 10,
      assignments: [{ assignedQuantity: 6, releasedQuantity: 0, consumedQuantity: 6 }], additionalAssignments: [{ quantity: 1, purchaseLineId: null }] };
    await expect(assertAdditionalStockCoverage(f.tx, args)).rejects.toMatchObject({ code: 'ALLOCATION_INCONSISTENT' });
    args.assignments[0] = { assignedQuantity: 6, releasedQuantity: 1, consumedQuantity: 5 };
    expect((await assertAdditionalStockCoverage(f.tx, args)).coveredQuantity).toBe(10);
  });
  it('counts received purchase stock once and returned resale as new own coverage', async () => {
    const f = fixture();
    f.findMany.mockResolvedValue([{ id: 'purchase-line', quantity: 4, cancelledQuantity: 0, receivedQuantity: 4, directShippedQuantity: 0 }]);
    const result = await assertAdditionalStockCoverage(f.tx, { orderLineId: 'line', orderQuantity: 5,
      assignments: [{ assignedQuantity: 3, releasedQuantity: 0, consumedQuantity: 3, purchaseLineId: 'purchase-line' }],
      additionalAssignments: [{ quantity: 1, purchaseLineId: 'purchase-line' }, { quantity: 1, purchaseLineId: null }] });
    expect(result.coveredQuantity).toBe(5);
    expect(result.ownStockCoverage).toBe(1);
    expect(result.purchases[0].assignedReceivedQuantity).toBe(4);
  });
});
