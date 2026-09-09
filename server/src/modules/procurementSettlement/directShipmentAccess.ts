import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { hasCapability, type CapabilityActor } from '../../lib/capabilityPolicy.js';

export async function assertDirectShipmentOrderScope(tx: Prisma.TransactionClient, actor: CapabilityActor,
  orderId: string, action: 'read' | 'manage' | 'review' = 'read') {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: {
    id: true, version: true, status: true, lineItemsMode: true, quantity: true, outboundQuantity: true, directShippedQuantity: true,
    quotation: { select: { createdBy: true, creator: { select: { department: true } } } },
  } });
  if (!order) throw new AppError('销售订单不存在', 404, 'RESOURCE_NOT_FOUND');
  const scope = { ownerId: order.quotation.createdBy, department: order.quotation.creator.department };
  const permitted = action === 'review' ? hasCapability(actor, 'quality_review', 'approve', scope)
    : hasCapability(actor, 'inventory', action === 'manage' ? 'manage' : 'read', scope);
  if (!permitted || !hasCapability(actor, 'order', 'read', scope)) {
    throw new AppError('当前用户无权处理此订单的供应商直发', 403, 'AUTH_FORBIDDEN');
  }
  if (!order.lineItemsMode) throw new AppError('供应商直发需要明确的现代销售行', 409, 'RESOURCE_CONFLICT');
  return { order, scope };
}

/** Explicit operational projection. Supplier costs and purchase approval data
 * must never travel through a quality, logistics or receipt response. */
export const directShipmentReadSelect = {
  id: true, shipmentNumber: true, purchaseCommitmentId: true, orderId: true, carrier: true,
  trackingNumber: true, origin: true, destination: true, reason: true, evidence: true,
  status: true, version: true, createdById: true, createdAt: true, updatedAt: true,
  dispatchedById: true, dispatchedAt: true, cancelledById: true, cancelledAt: true, cancellationReason: true,
  lines: { orderBy: { lineNo: 'asc' as const }, select: { id: true, lineNo: true,
    purchaseCommitmentLineId: true, quantity: true, physicalSnapshot: true, reviewStatus: true,
    reviewedById: true, reviewedAt: true, reviewReason: true, checks: true, reviewEvidence: true,
    receivedQuantity: true, version: true, createdAt: true, updatedAt: true } },
} satisfies Prisma.SupplierDirectShipmentSelect;

export async function getDirectShipment(args: { tx: Prisma.TransactionClient; actor: CapabilityActor; shipmentId: string }) {
  const shipment = await args.tx.supplierDirectShipment.findUnique({ where: { id: args.shipmentId }, select: directShipmentReadSelect });
  if (!shipment) throw new AppError('供应商直发记录不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertDirectShipmentOrderScope(args.tx, args.actor, shipment.orderId);
  return shipment;
}

export async function getOrderDirectShipments(args: { tx: Prisma.TransactionClient; actor: CapabilityActor; orderId: string }) {
  await assertDirectShipmentOrderScope(args.tx, args.actor, args.orderId);
  return { orderId: args.orderId, shipments: await args.tx.supplierDirectShipment.findMany({ where: { orderId: args.orderId },
    select: directShipmentReadSelect, orderBy: { createdAt: 'desc' } }) };
}
