import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { deriveReceiptAllocationSources, type SourcedAllocation } from './receiptAllocationSources.js';

export type AllocationSourceInput = { stockReceiptLineId?: string; sourceReturnHoldId?: string };

/** The caller owns a Serializable transaction and the inventory quantity CAS.
 * A source is an explicit immutable fact, never guessed from a PN or supplier.
 * Physical availability is checked separately by the inventory service. */
export async function resolveReceiptAllocationSource(tx: Prisma.TransactionClient, input: AllocationSourceInput & {
  inventoryDetailId: string; quantity: number; orderLineId?: string;
}) {
  const [receipts, returns, allocations] = await Promise.all([
    tx.stockReceiptLine.findMany({ where: { inventoryDetailId: input.inventoryDetailId },
      include: { purchaseCommitmentLine: { select: { orderLineId: true } } } }),
    tx.returnHold.findMany({ where: { inventoryDetailId: input.inventoryDetailId },
      select: { id: true, inventoryDetailId: true, quantity: true, status: true } }),
    tx.inventoryAllocation.findMany({ where: { inventoryDetailId: input.inventoryDetailId }, include: { assignments: true } }),
  ]);
  const stockReceiptLineId = input.stockReceiptLineId ?? null;
  const sourceReturnHoldId = input.sourceReturnHoldId ?? null;
  if (stockReceiptLineId && !input.orderLineId) {
    throw new AppError('采购验收库存须直接分配到原销售行', 409, 'RESOURCE_CONFLICT');
  }
  const proposedId = randomUUID();
  const proposed: SourcedAllocation = {
    id: proposedId, inventoryDetailId: input.inventoryDetailId, stockReceiptLineId, sourceReturnHoldId,
    allocatedQuantity: input.quantity, releasedQuantity: 0, consumedQuantity: 0,
    assignments: input.orderLineId ? [{ id: `${proposedId}:assignment`, orderLineId: input.orderLineId,
      assignedQuantity: input.quantity, releasedQuantity: 0, consumedQuantity: 0 }] : [],
  };
  const result = deriveReceiptAllocationSources({
    receipts: receipts.map(row => ({ ...row, orderLineId: row.purchaseCommitmentLine.orderLineId })),
    returns, allocations: [...allocations, proposed],
  });
  return { stockReceiptLineId, sourceReturnHoldId,
    purchaseLineId: result.assignments.find(row => row.assignmentId === `${proposedId}:assignment`)?.purchaseLineId ?? null };
}
