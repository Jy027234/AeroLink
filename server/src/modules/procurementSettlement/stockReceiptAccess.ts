import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { hasCapability, type CapabilityActor } from '../../lib/capabilityPolicy.js';

export async function assertStockReceiptOrderScope(tx: Prisma.TransactionClient, actor: CapabilityActor,
  orderId: string, action: 'read' | 'receive' | 'review' = 'read') {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: {
    id: true, lineItemsMode: true, status: true, version: true,
    quotation: { select: { createdBy: true, creator: { select: { department: true } } } },
  } });
  if (!order) throw new AppError('销售订单不存在', 404, 'RESOURCE_NOT_FOUND');
  const scope = { ownerId: order.quotation.createdBy, department: order.quotation.creator.department };
  const allowed = action === 'review' ? hasCapability(actor, 'quality_review', 'approve', scope)
    : hasCapability(actor, 'inventory', action === 'receive' ? 'manage' : 'read', scope);
  if (!allowed || !hasCapability(actor, 'order', 'read', scope)) {
    throw new AppError('当前用户无权处理此订单的收货质量事实', 403, 'AUTH_FORBIDDEN');
  }
  if (!order.lineItemsMode) throw new AppError('采购收货需要明确的现代订单行', 409, 'RESOURCE_CONFLICT');
  return { order, scope };
}

/** Operational fields only. Never include supplier prices, source snapshots,
 * purchase approval evidence, payment terms or inventory unitCost. */
export const stockReceiptReadSelect = {
  id: true, receiptNumber: true, purchaseCommitmentId: true, version: true,
  receivedById: true, receivedAt: true, supplierDeliveryReference: true, reason: true, evidence: true,
  createdAt: true, updatedAt: true,
  purchaseCommitment: { select: { orderId: true, commitmentNumber: true, supplierId: true } },
  lines: { orderBy: { lineNo: 'asc' as const }, select: {
    id: true, lineNo: true, purchaseCommitmentLineId: true, quantity: true, status: true, version: true,
    identitySnapshot: true, qualitySnapshot: true, evidence: true, reviewedById: true, reviewedAt: true,
    reviewReason: true, inventoryDetailId: true, createdAt: true, updatedAt: true,
  } },
} satisfies Prisma.StockReceiptSelect;

export async function getStockReceipt(args: { tx: Prisma.TransactionClient; actor: CapabilityActor; receiptId: string }) {
  const receipt = await args.tx.stockReceipt.findUnique({ where: { id: args.receiptId }, select: stockReceiptReadSelect });
  if (!receipt) throw new AppError('收货记录不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertStockReceiptOrderScope(args.tx, args.actor, receipt.purchaseCommitment.orderId);
  return receipt;
}

export async function getOrderStockReceipts(args: { tx: Prisma.TransactionClient; actor: CapabilityActor; orderId: string }) {
  await assertStockReceiptOrderScope(args.tx, args.actor, args.orderId);
  return { orderId: args.orderId, receipts: await args.tx.stockReceipt.findMany({
    where: { purchaseCommitment: { orderId: args.orderId } }, select: stockReceiptReadSelect, orderBy: { createdAt: 'desc' },
  }) };
}
