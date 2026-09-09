import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { resolveReceiptAllocationSource } from './receiptAllocationAccess.js';

function fixture() {
  const receipt = { id: 'receipt', inventoryDetailId: 'detail', quantity: 5, status: 'ACCEPTED',
    purchaseCommitmentLineId: 'purchase', purchaseCommitmentLine: { orderLineId: 'original-order' } };
  const allocation = { id: 'original', inventoryDetailId: 'detail', stockReceiptLineId: 'receipt', sourceReturnHoldId: null,
    allocatedQuantity: 5, releasedQuantity: 0, consumedQuantity: 5,
    assignments: [{ id: 'assigned', orderLineId: 'original-order', assignedQuantity: 5, releasedQuantity: 0, consumedQuantity: 5 }] };
  const mocks = { stockReceiptLine: { findMany: vi.fn().mockResolvedValue([receipt]) },
    returnHold: { findMany: vi.fn().mockResolvedValue([{ id: 'returned', inventoryDetailId: 'detail', quantity: 1, status: 'RELEASED' }]) },
    inventoryAllocation: { findMany: vi.fn().mockResolvedValue([allocation]) } };
  return { mocks, tx: mocks as unknown as Prisma.TransactionClient };
}
describe('receipt inventory allocation source adapter', () => {
  it('resells only the released return pool while the original five units remain consumed', async () => {
    const f = fixture();
    expect(await resolveReceiptAllocationSource(f.tx, { inventoryDetailId: 'detail', sourceReturnHoldId: 'returned',
      quantity: 1, orderLineId: 'resale-order' })).toEqual({ stockReceiptLineId: null, sourceReturnHoldId: 'returned', purchaseLineId: null });
    await expect(resolveReceiptAllocationSource(f.tx, { inventoryDetailId: 'detail', stockReceiptLineId: 'receipt',
      quantity: 1, orderLineId: 'original-order' })).rejects.toThrow(/超过验收量/);
  });
  it('preserves the purchase demand identity for remaining original inventory', async () => {
    const f = fixture(); f.mocks.inventoryAllocation.findMany.mockResolvedValue([]);
    expect(await resolveReceiptAllocationSource(f.tx, { inventoryDetailId: 'detail', stockReceiptLineId: 'receipt',
      quantity: 5, orderLineId: 'original-order' })).toEqual({ stockReceiptLineId: 'receipt', sourceReturnHoldId: null, purchaseLineId: 'purchase' });
    await expect(resolveReceiptAllocationSource(f.tx, { inventoryDetailId: 'detail', stockReceiptLineId: 'receipt',
      quantity: 1, orderLineId: 'other-order' })).rejects.toThrow(/对应的销售行/);
  });
  it('requires an explicit source for receipt stock and direct original order assignment', async () => {
    const f = fixture();
    await expect(resolveReceiptAllocationSource(f.tx, { inventoryDetailId: 'detail', quantity: 1 })).rejects.toThrow(/不能省略/);
    await expect(resolveReceiptAllocationSource(f.tx, { inventoryDetailId: 'detail', stockReceiptLineId: 'receipt', quantity: 1 }))
      .rejects.toThrow(/直接分配到原销售行/);
  });
  it('does not allow another detail or invented return to impersonate the source', async () => {
    const f = fixture(); f.mocks.stockReceiptLine.findMany.mockResolvedValue([]);
    f.mocks.returnHold.findMany.mockResolvedValue([]); f.mocks.inventoryAllocation.findMany.mockResolvedValue([]);
    await expect(resolveReceiptAllocationSource(f.tx, { inventoryDetailId: 'other-detail', sourceReturnHoldId: 'returned', quantity: 1 }))
      .rejects.toThrow(/同一实物/);
    expect(await resolveReceiptAllocationSource(f.tx, { inventoryDetailId: 'other-detail', quantity: 1 }))
      .toEqual({ stockReceiptLineId: null, sourceReturnHoldId: null, purchaseLineId: null });
    expect(f.mocks.returnHold.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { inventoryDetailId: 'other-detail' } }));
  });
});
