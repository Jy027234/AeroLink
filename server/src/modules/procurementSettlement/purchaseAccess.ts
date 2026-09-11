import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { hasCapability, type CapabilityAction, type CapabilityActor } from '../../lib/capabilityPolicy.js';

export async function assertPurchaseOrderScope(
  tx: Prisma.TransactionClient, actor: CapabilityActor, orderId: string,
  action: CapabilityAction = 'read',
) {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: {
    id: true, lineItemsMode: true, status: true, version: true,
    quotation: { select: { createdBy: true, creator: { select: { department: true } } } },
  } });
  if (!order) throw new AppError('销售订单不存在', 404, 'RESOURCE_NOT_FOUND');
  const scope = { ownerId: order.quotation.createdBy, department: order.quotation.creator.department };
  if (!hasCapability(actor, 'purchase_commitment', action, scope) || !hasCapability(actor, 'order', 'read', scope)) {
    throw new AppError('当前用户无权处理此订单的采购承诺', 403, 'AUTH_FORBIDDEN');
  }
  if (!order.lineItemsMode) throw new AppError('采购承诺需要明确的现代订单行，不能自动推断旧订单来源', 409, 'RESOURCE_CONFLICT');
  return { order, scope, canViewCost: hasCapability(actor, 'purchase_commitment', 'view_cost', scope) };
}

export const purchaseReadInclude = {
  supplier: { select: { name: true } },
  lines: { orderBy: { lineNo: 'asc' as const } },
} satisfies Prisma.PurchaseCommitmentInclude;
type Purchase = Prisma.PurchaseCommitmentGetPayload<{ include: typeof purchaseReadInclude }>;

/** Cost and commercial evidence are selected explicitly, never removed by key-name heuristics. */
export function projectPurchaseCommitment(purchase: Purchase, canViewCost: boolean) {
  return {
    id: purchase.id, commitmentNumber: purchase.commitmentNumber,
    orderId: purchase.orderId, supplierId: purchase.supplierId, supplierName: purchase.supplier.name,
    status: purchase.status, version: purchase.version, createdAt: purchase.createdAt,
    submittedAt: purchase.submittedAt, approvedAt: purchase.approvedAt, confirmedAt: purchase.confirmedAt,
    ...(canViewCost ? { currency: purchase.currency, totalCost: purchase.totalCost.toFixed(4),
      paymentTerms: purchase.paymentTerms, supplierReferenceNo: purchase.supplierReferenceNo,
      approvalLevel: purchase.approvalLevel, approvalPolicyVersion: purchase.approvalPolicyVersion,
      approvalSnapshot: purchase.approvalSnapshot, confirmationEvidence: purchase.confirmationEvidence } : {}),
    lines: purchase.lines.map(line => ({
      id: line.id, lineNo: line.lineNo, orderLineId: line.orderLineId,
      partNumber: line.partNumber, uom: line.uom, quantity: line.quantity,
      cancelledQuantity: line.cancelledQuantity, receivedQuantity: line.receivedQuantity,
      directShippedQuantity: line.directShippedQuantity, version: line.version,
      promisedDate: line.promisedDate, fulfillmentMode: line.fulfillmentMode,
      ...(canViewCost ? { currency: line.currency, unitCost: line.unitCost.toFixed(4),
        lineTotal: line.lineTotal.toFixed(4), sourceSupplierQuoteId: line.sourceSupplierQuoteId,
        sourceSnapshot: line.sourceSnapshot } : {}),
    })),
  };
}

export async function getOrderPurchaseCommitments(args: {
  tx: Prisma.TransactionClient; actor: CapabilityActor; orderId: string;
}) {
  const access = await assertPurchaseOrderScope(args.tx, args.actor, args.orderId);
  const purchases = await args.tx.purchaseCommitment.findMany({ where: { orderId: access.order.id },
    include: purchaseReadInclude, orderBy: { createdAt: 'desc' } });
  return { orderId: access.order.id, purchases: purchases.map(purchase => projectPurchaseCommitment(purchase, access.canViewCost)) };
}

export async function getPurchaseCommitment(args: {
  tx: Prisma.TransactionClient; actor: CapabilityActor; purchaseCommitmentId: string;
}) {
  const purchase = await args.tx.purchaseCommitment.findUnique({ where: { id: args.purchaseCommitmentId }, include: purchaseReadInclude });
  if (!purchase) throw new AppError('采购承诺不存在', 404, 'RESOURCE_NOT_FOUND');
  const access = await assertPurchaseOrderScope(args.tx, args.actor, purchase.orderId);
  return projectPurchaseCommitment(purchase, access.canViewCost);
}
