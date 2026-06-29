import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = Router();

function serializeTransaction(transaction: {
  id: string;
  inventoryDetailId: string;
  type: string;
  quantity: number;
  beforeQuantity: number;
  afterQuantity: number;
  orderId: string | null;
  quotationId: string | null;
  referenceNo: string | null;
  referenceType: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
}) {
  return {
    ...transaction,
    orderId: transaction.orderId || undefined,
    quotationId: transaction.quotationId || undefined,
    referenceNo: transaction.referenceNo || undefined,
    referenceType: transaction.referenceType || undefined,
    notes: transaction.notes || undefined,
    createdAt: transaction.createdAt.toISOString(),
  };
}

router.get(
  '/detail/:detailId',
  asyncHandler(async (req, res) => {
    const transactions = await prisma.inventoryTransaction.findMany({
      where: { inventoryDetailId: req.params.detailId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: transactions.map(serializeTransaction),
    });
  })
);

router.get(
  '/order/:orderId',
  asyncHandler(async (req, res) => {
    const transactions = await prisma.inventoryTransaction.findMany({
      where: { orderId: req.params.orderId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: transactions.map(serializeTransaction),
    });
  })
);

router.post(
  '/outbound',
  asyncHandler(async (req: AuthRequest, res) => {
    const { inventoryDetailId, orderId, quantity, notes } = req.body as {
      inventoryDetailId?: string;
      orderId?: string;
      quantity?: number;
      notes?: string;
    };

    if (!inventoryDetailId || !orderId || !quantity || quantity <= 0) {
      throw new AppError('出库参数不完整', 400, 'VALIDATION_ERROR');
    }

    const detail = await prisma.inventoryDetail.findUnique({
      where: { id: inventoryDetailId },
    });
    if (!detail) {
      throw new AppError('库存明细不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) {
      throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (detail.quantity < quantity) {
      throw new AppError('库存数量不足', 400, 'BAD_REQUEST');
    }

    const beforeQuantity = detail.quantity;
    const afterQuantity = beforeQuantity - quantity;
    const nextOutboundQuantity = (order.outboundQuantity || 0) + quantity;
    const nextOutboundStatus =
      nextOutboundQuantity >= order.quantity
        ? 'COMPLETED'
        : nextOutboundQuantity > 0
          ? 'PARTIAL'
          : 'PENDING';
    const nextStatus =
      nextOutboundStatus === 'COMPLETED' && (order.status === 'SO_CREATED' || order.status === 'PO_CREATED')
        ? 'SHIPPED'
        : order.status;

    const transaction = await prisma.$transaction(async (tx) => {
      await tx.inventoryDetail.update({
        where: { id: inventoryDetailId },
        data: { quantity: afterQuantity },
      });

      const created = await tx.inventoryTransaction.create({
        data: {
          inventoryDetailId,
          type: 'OUTBOUND',
          quantity: -quantity,
          beforeQuantity,
          afterQuantity,
          orderId,
          referenceNo: order.orderNumber,
          referenceType: 'ORDER',
          notes: notes || null,
          createdBy: req.user!.id,
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: {
          outboundQuantity: nextOutboundQuantity,
          outboundStatus: nextOutboundStatus,
          status: nextStatus,
        },
      });

      return created;
    });

    res.status(201).json({
      success: true,
      data: serializeTransaction(transaction),
    });
  })
);

export default router;
