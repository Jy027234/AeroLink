import type { Prisma } from '@prisma/client';
import { AppError } from '../middleware/errorHandler.js';

/** Supplier dispatch is a separate delivery fact. Never translate these
 * quantities into warehouse OUTBOUND transactions or allocation consumption. */
export async function readDirectDeliveryProjection(tx: Prisma.TransactionClient, orderLineIds: string[]) {
  const lines = await tx.supplierDirectShipmentLine.findMany({ where: {
    purchaseCommitmentLine: { orderLineId: { in: orderLineIds } },
    shipment: { status: { in: ['DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED'] } },
  }, select: { quantity: true, receivedQuantity: true, reviewStatus: true,
    purchaseCommitmentLine: { select: { orderLineId: true } } } });
  const result = new Map<string, { dispatched: number; received: number }>();
  for (const line of lines) {
    if (line.reviewStatus !== 'APPROVED' || line.quantity < 1 || line.receivedQuantity < 0 || line.receivedQuantity > line.quantity) {
      throw new AppError('供应商直发数量或质量事实不一致', 409, 'ALLOCATION_INCONSISTENT');
    }
    const id = line.purchaseCommitmentLine.orderLineId;
    const current = result.get(id) ?? { dispatched: 0, received: 0 };
    const next = { dispatched: current.dispatched + line.quantity, received: current.received + line.receivedQuantity };
    if (next.dispatched > 2147483647 || next.received > 2147483647) throw new AppError('直发数量超过订单可表示范围', 409, 'ALLOCATION_INCONSISTENT');
    result.set(id, next);
  }
  return result;
}
