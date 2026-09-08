import { Prisma } from '@prisma/client';
import { deriveProcurementCoverage, type ProcurementStockAssignment } from './procurementQuantities.js';

/** Lock before any inventory row writes; the database triggers protect callers
 * outside this service and serialize all changes to the same demand. */
export async function lockPurchaseCoverageLines(tx: Prisma.TransactionClient, ids: string[]) {
  if (!ids.length) return;
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "order_lines" WHERE "id" IN (${Prisma.join([...new Set(ids)].sort())}) ORDER BY "id" FOR UPDATE`);
}

export async function assertAdditionalStockCoverage(tx: Prisma.TransactionClient, args: {
  orderLineId: string; orderQuantity: number;
  assignments: Array<Omit<ProcurementStockAssignment, 'id' | 'purchaseLineId'>>;
  additionalQuantity: number;
}) {
  const purchases = await tx.purchaseCommitmentLine.findMany({ where: { orderLineId: args.orderLineId,
    purchaseCommitment: { status: { in: ['PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED'] } } },
    select: { id: true, quantity: true, cancelledQuantity: true, receivedQuantity: true, directShippedQuantity: true } });
  return deriveProcurementCoverage({ orderQuantity: args.orderQuantity, purchases,
    assignments: [...args.assignments.map((row, index) => ({ ...row, id: `existing:${index}`, purchaseLineId: null })),
      { id: 'requested', purchaseLineId: null, assignedQuantity: args.additionalQuantity, releasedQuantity: 0, consumedQuantity: 0 }] });
}
