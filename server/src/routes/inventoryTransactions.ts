import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { enqueueBusinessEvent } from '../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../lib/socketEvents.js';
import { StateTransitionConflictError, transitionOrderStatus } from '../lib/transactionStateService.js';
import prisma from '../lib/prisma.js';

const router = Router();
const requireInventoryMutationRole = requireRole('manager', 'admin');

const RESERVABLE_QUOTATION_STATUSES = new Set(['APPROVED', 'SENT', 'ACCEPTED']);
const OUTBOUND_ORDER_STATUSES = new Set(['SO_CREATED', 'PO_CREATED']);

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

function assertPositiveInteger(value: unknown, message: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AppError(message, 400, 'VALIDATION_ERROR');
  }
}

function assertPartNumberMatches(inventoryPartNumber: string, documentPartNumber: string, documentName: string) {
  if (inventoryPartNumber !== documentPartNumber) {
    throw new AppError(
      `库存件号与${documentName}件号不一致，不能继续处理`,
      409,
      'RESOURCE_CONFLICT',
    );
  }
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

/**
 * Reserves one inventory detail for a quotation. The existing schema models a
 * single reservation per quotation, so a RESERVED detail is intentionally
 * exclusive until its reserved quantity has been shipped or released.
 */
router.post(
  '/reserve',
  requireInventoryMutationRole,
  asyncHandler(async (req: AuthRequest, res) => {
    const { inventoryDetailId, quotationId, quantity, notes } = req.body as {
      inventoryDetailId?: string;
      quotationId?: string;
      quantity?: unknown;
      notes?: string;
    };
    const actorId = req.user!.id;

    if (!inventoryDetailId || !quotationId) {
      throw new AppError('库存预留参数不完整', 400, 'VALIDATION_ERROR');
    }
    assertPositiveInteger(quantity, '预留数量必须是大于 0 的整数');

    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/inventory-transactions/reserve'),
      async (tx) => {
        const [detail, quotation] = await Promise.all([
          tx.inventoryDetail.findUnique({
            where: { id: inventoryDetailId },
            include: { inventoryItem: true },
          }),
          tx.quotation.findUnique({ where: { id: quotationId } }),
        ]);

        if (!detail) {
          throw new AppError('库存明细不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (!quotation) {
          throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (!RESERVABLE_QUOTATION_STATUSES.has(quotation.status)) {
          throw new AppError('只有已审批、已发送或已接受的报价可以预留库存', 409, 'INVALID_STATE_TRANSITION');
        }
        assertPartNumberMatches(detail.inventoryItem.partNumber, quotation.partNumber, '报价');
        if (quantity > quotation.quantity) {
          throw new AppError('预留数量不能超过报价数量', 409, 'RESOURCE_CONFLICT');
        }
        if (quotation.reservedQuantity > 0) {
          throw new AppError('该报价已经存在未释放的库存预留', 409, 'RESOURCE_CONFLICT');
        }
        if (quotation.inventoryDetailId && quotation.inventoryDetailId !== detail.id) {
          throw new AppError('该报价已绑定其他库存明细，不能切换预留库存', 409, 'RESOURCE_CONFLICT');
        }
        if (detail.status !== 'AVAILABLE') {
          throw new AppError('当前库存明细不可预留', 409, 'RESOURCE_CONFLICT');
        }
        if (detail.quantity < quantity) {
          throw new AppError('库存数量不足', 409, 'RESOURCE_CONFLICT');
        }

        const order = await tx.order.findUnique({
          where: { quotationId: quotation.id },
        });
        if (order) {
          assertPartNumberMatches(detail.inventoryItem.partNumber, order.partNumber, '订单');
          if (!OUTBOUND_ORDER_STATUSES.has(order.status)) {
            throw new AppError('当前订单状态不能预留库存', 409, 'INVALID_STATE_TRANSITION');
          }
          if (order.inventoryDetailId && order.inventoryDetailId !== detail.id) {
            throw new AppError('该订单已绑定其他库存明细，不能切换预留库存', 409, 'RESOURCE_CONFLICT');
          }
          if (quantity > order.quantity - order.outboundQuantity) {
            throw new AppError('预留数量不能超过订单待出库数量', 409, 'RESOURCE_CONFLICT');
          }
        }

        const reservedDetail = await tx.inventoryDetail.updateMany({
          where: {
            id: detail.id,
            status: 'AVAILABLE',
            quantity: { gte: quantity },
          },
          data: { status: 'RESERVED' },
        });
        if (reservedDetail.count !== 1) {
          throw new StateTransitionConflictError();
        }

        const updatedQuotation = await tx.quotation.updateMany({
          where: {
            id: quotation.id,
            status: quotation.status,
            version: quotation.version,
            inventoryDetailId: quotation.inventoryDetailId,
            reservedQuantity: 0,
          },
          data: {
            inventoryDetailId: detail.id,
            serialNumber: detail.serialNumber,
            batchNumber: detail.batchNumber,
            reservedQuantity: quantity,
            version: { increment: 1 },
          },
        });
        if (updatedQuotation.count !== 1) {
          throw new StateTransitionConflictError();
        }

        if (order) {
          const updatedOrder = await tx.order.updateMany({
            where: {
              id: order.id,
              quotationId: quotation.id,
              status: order.status,
              version: order.version,
              inventoryDetailId: order.inventoryDetailId,
            },
            data: {
              inventoryDetailId: detail.id,
              serialNumber: detail.serialNumber,
              batchNumber: detail.batchNumber,
              version: { increment: 1 },
            },
          });
          if (updatedOrder.count !== 1) {
            throw new StateTransitionConflictError();
          }
        }

        const transaction = await tx.inventoryTransaction.create({
          data: {
            inventoryDetailId: detail.id,
            type: 'RESERVATION',
            quantity: 0,
            beforeQuantity: detail.quantity,
            afterQuantity: detail.quantity,
            orderId: order?.id || null,
            quotationId: quotation.id,
            referenceNo: quotation.quoteNumber,
            referenceType: 'QUOTATION',
            notes: notes?.trim() || null,
            createdBy: actorId,
          },
        });

        await enqueueBusinessEvent(tx, {
          eventType: 'inventory.reserved',
          aggregateType: 'INVENTORY_DETAIL',
          aggregateId: detail.id,
          data: {
            inventoryDetailId: detail.id,
            partNumber: detail.inventoryItem.partNumber,
            status: 'RESERVED',
            quantity: detail.quantity,
            reservedQuantity: quantity,
            quotationId: quotation.id,
            quoteNumber: quotation.quoteNumber,
            orderId: order?.id || null,
            transactionId: transaction.id,
            reservedBy: actorId,
          },
          socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED },
          createdById: actorId,
        });

        return {
          payload: {
            ...serializeTransaction(transaction),
            inventoryStatus: 'RESERVED',
            inventoryQuantity: detail.quantity,
            reservedQuantity: quantity,
            quotationVersion: quotation.version + 1,
            orderVersion: order ? order.version + 1 : undefined,
          },
          statusCode: 201,
          resourceType: 'INVENTORY_TRANSACTION',
          resourceId: transaction.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.post(
  '/release',
  requireInventoryMutationRole,
  asyncHandler(async (req: AuthRequest, res) => {
    const { quotationId, notes } = req.body as {
      quotationId?: string;
      notes?: string;
    };
    const actorId = req.user!.id;

    if (!quotationId) {
      throw new AppError('库存预留释放参数不完整', 400, 'VALIDATION_ERROR');
    }

    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/inventory-transactions/release'),
      async (tx) => {
        const quotation = await tx.quotation.findUnique({ where: { id: quotationId } });
        if (!quotation) {
          throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (!['APPROVED', 'SENT'].includes(quotation.status)) {
          throw new AppError('当前报价状态不能释放库存预留', 409, 'INVALID_STATE_TRANSITION');
        }
        if (!quotation.inventoryDetailId || quotation.reservedQuantity <= 0) {
          throw new AppError('该报价没有可释放的库存预留', 409, 'RESOURCE_CONFLICT');
        }

        const [detail, existingOrder] = await Promise.all([
          tx.inventoryDetail.findUnique({
            where: { id: quotation.inventoryDetailId },
            include: { inventoryItem: true },
          }),
          tx.order.findUnique({ where: { quotationId: quotation.id } }),
        ]);
        if (!detail) {
          throw new AppError('预留库存明细不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (existingOrder) {
          throw new AppError('报价已生成订单，不能直接释放库存预留', 409, 'INVALID_STATE_TRANSITION');
        }
        if (detail.status !== 'RESERVED') {
          throw new AppError('库存明细不是预留状态，无法释放', 409, 'RESOURCE_CONFLICT');
        }
        assertPartNumberMatches(detail.inventoryItem.partNumber, quotation.partNumber, '报价');

        const releasedDetail = await tx.inventoryDetail.updateMany({
          where: { id: detail.id, status: 'RESERVED' },
          data: { status: 'AVAILABLE' },
        });
        if (releasedDetail.count !== 1) {
          throw new StateTransitionConflictError();
        }

        const releasedQuotation = await tx.quotation.updateMany({
          where: {
            id: quotation.id,
            status: quotation.status,
            version: quotation.version,
            inventoryDetailId: detail.id,
            reservedQuantity: quotation.reservedQuantity,
          },
          data: {
            reservedQuantity: 0,
            version: { increment: 1 },
          },
        });
        if (releasedQuotation.count !== 1) {
          throw new StateTransitionConflictError();
        }

        const transaction = await tx.inventoryTransaction.create({
          data: {
            inventoryDetailId: detail.id,
            type: 'RESERVATION_RELEASE',
            quantity: 0,
            beforeQuantity: detail.quantity,
            afterQuantity: detail.quantity,
            quotationId: quotation.id,
            referenceNo: quotation.quoteNumber,
            referenceType: 'QUOTATION',
            notes: notes?.trim() || null,
            createdBy: actorId,
          },
        });

        await enqueueBusinessEvent(tx, {
          eventType: 'inventory.reservation.released',
          aggregateType: 'INVENTORY_DETAIL',
          aggregateId: detail.id,
          data: {
            inventoryDetailId: detail.id,
            partNumber: detail.inventoryItem.partNumber,
            status: 'AVAILABLE',
            quantity: detail.quantity,
            releasedQuantity: quotation.reservedQuantity,
            quotationId: quotation.id,
            quoteNumber: quotation.quoteNumber,
            transactionId: transaction.id,
            releasedBy: actorId,
          },
          socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED },
          createdById: actorId,
        });

        return {
          payload: {
            ...serializeTransaction(transaction),
            inventoryStatus: 'AVAILABLE',
            inventoryQuantity: detail.quantity,
            releasedQuantity: quotation.reservedQuantity,
            reservedQuantity: 0,
            quotationVersion: quotation.version + 1,
          },
          statusCode: 201,
          resourceType: 'INVENTORY_TRANSACTION',
          resourceId: transaction.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.post(
  '/outbound',
  requireInventoryMutationRole,
  asyncHandler(async (req: AuthRequest, res) => {
    const { inventoryDetailId, orderId, quantity, notes } = req.body as {
      inventoryDetailId?: string;
      orderId?: string;
      quantity?: unknown;
      notes?: string;
    };
    const actorId = req.user!.id;

    if (!inventoryDetailId || !orderId) {
      throw new AppError('出库参数不完整', 400, 'VALIDATION_ERROR');
    }
    assertPositiveInteger(quantity, '出库数量必须是大于 0 的整数');

    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/inventory-transactions/outbound'),
      async (tx) => {
        const [detail, order] = await Promise.all([
          tx.inventoryDetail.findUnique({
            where: { id: inventoryDetailId },
            include: { inventoryItem: true },
          }),
          tx.order.findUnique({
            where: { id: orderId },
            include: { quotation: true },
          }),
        ]);

        if (!detail) {
          throw new AppError('库存明细不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (!order) {
          throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (!OUTBOUND_ORDER_STATUSES.has(order.status)) {
          throw new AppError('当前订单状态不能执行出库', 409, 'INVALID_STATE_TRANSITION');
        }
        assertPartNumberMatches(detail.inventoryItem.partNumber, order.partNumber, '订单');
        if (order.inventoryDetailId !== detail.id || order.quotation.inventoryDetailId !== detail.id) {
          throw new AppError('订单未绑定当前库存明细，请先完成库存预留', 409, 'RESOURCE_CONFLICT');
        }

        const remainingOrderQuantity = order.quantity - order.outboundQuantity;
        if (quantity > remainingOrderQuantity) {
          throw new AppError('出库数量不能超过订单待出库数量', 409, 'RESOURCE_CONFLICT');
        }

        const isReservedForOrder = detail.status === 'RESERVED';
        if (detail.status !== 'AVAILABLE' && !isReservedForOrder) {
          throw new AppError('当前库存明细不可出库', 409, 'RESOURCE_CONFLICT');
        }
        if (detail.quantity < quantity) {
          throw new AppError('库存数量不足', 409, 'RESOURCE_CONFLICT');
        }
        if (isReservedForOrder && order.quotation.reservedQuantity < quantity) {
          throw new AppError('本次出库数量超过该订单已预留数量', 409, 'RESOURCE_CONFLICT');
        }

        const beforeQuantity = detail.quantity;
        const afterQuantity = beforeQuantity - quantity;
        const nextReservedQuantity = isReservedForOrder
          ? order.quotation.reservedQuantity - quantity
          : order.quotation.reservedQuantity;
        const nextInventoryStatus = isReservedForOrder && nextReservedQuantity === 0
          ? 'AVAILABLE'
          : detail.status;
        const nextOutboundQuantity = order.outboundQuantity + quantity;
        const nextOutboundStatus = nextOutboundQuantity === order.quantity
          ? 'COMPLETED'
          : 'PARTIAL';
        const shouldShipOrder = nextOutboundStatus === 'COMPLETED';

        const updatedDetail = await tx.inventoryDetail.updateMany({
          where: {
            id: detail.id,
            status: detail.status,
            quantity: { gte: quantity },
          },
          data: {
            quantity: afterQuantity,
            status: nextInventoryStatus,
          },
        });
        if (updatedDetail.count !== 1) {
          throw new StateTransitionConflictError();
        }

        if (isReservedForOrder) {
          const updatedQuotation = await tx.quotation.updateMany({
            where: {
              id: order.quotation.id,
              status: order.quotation.status,
              version: order.quotation.version,
              inventoryDetailId: detail.id,
              reservedQuantity: order.quotation.reservedQuantity,
            },
            data: {
              reservedQuantity: nextReservedQuantity,
              version: { increment: 1 },
            },
          });
          if (updatedQuotation.count !== 1) {
            throw new StateTransitionConflictError();
          }
        }

        const transaction = await tx.inventoryTransaction.create({
          data: {
            inventoryDetailId: detail.id,
            type: 'OUTBOUND',
            quantity: -quantity,
            beforeQuantity,
            afterQuantity,
            orderId: order.id,
            quotationId: order.quotationId,
            referenceNo: order.orderNumber,
            referenceType: 'ORDER',
            notes: notes?.trim() || null,
            createdBy: actorId,
          },
        });

        const updatedOrder = shouldShipOrder
          ? await transitionOrderStatus(tx, {
            id: order.id,
            currentStatus: order.status,
            currentVersion: order.version,
            nextStatus: 'SHIPPED',
            actorId,
            reasonCode: 'OUTBOUND_COMPLETED',
            reason: notes?.trim() || 'Inventory outbound completed.',
            data: {
              outboundQuantity: nextOutboundQuantity,
              outboundStatus: nextOutboundStatus,
            },
          })
          : await (async () => {
            const result = await tx.order.updateMany({
              where: {
                id: order.id,
                status: order.status,
                version: order.version,
                inventoryDetailId: detail.id,
              },
              data: {
                outboundQuantity: nextOutboundQuantity,
                outboundStatus: nextOutboundStatus,
                version: { increment: 1 },
              },
            });
            if (result.count !== 1) {
              throw new StateTransitionConflictError();
            }
            return {
              ...order,
              outboundQuantity: nextOutboundQuantity,
              outboundStatus: nextOutboundStatus,
              version: order.version + 1,
            };
          })();

        await enqueueBusinessEvent(tx, {
          eventType: 'inventory.outbound',
          aggregateType: 'INVENTORY_DETAIL',
          aggregateId: detail.id,
          data: {
            inventoryDetailId: detail.id,
            partNumber: detail.inventoryItem.partNumber,
            status: nextInventoryStatus,
            beforeQuantity,
            afterQuantity,
            outboundQuantity: quantity,
            transactionId: transaction.id,
            orderId: order.id,
            orderNumber: order.orderNumber,
            quotationId: order.quotationId,
            shippedBy: actorId,
          },
          socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED },
          createdById: actorId,
        });
        if (shouldShipOrder) {
          await enqueueBusinessEvent(tx, {
            eventType: 'order.status.changed',
            aggregateType: 'ORDER',
            aggregateId: order.id,
            data: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              oldStatus: order.status,
              newStatus: updatedOrder.status,
              changedAt: new Date().toISOString(),
              reasonCode: 'OUTBOUND_COMPLETED',
            },
            socket: { room: SocketRooms.ORDERS, event: SocketEvents.ORDER_STATUS_CHANGED },
            createdById: actorId,
          });
        }

        return {
          payload: {
            ...serializeTransaction(transaction),
            inventoryStatus: nextInventoryStatus,
            outboundQuantity: nextOutboundQuantity,
            outboundStatus: nextOutboundStatus,
            orderStatus: updatedOrder.status.toLowerCase(),
            orderVersion: updatedOrder.version,
            reservedQuantity: nextReservedQuantity,
          },
          statusCode: 201,
          resourceType: 'INVENTORY_TRANSACTION',
          resourceId: transaction.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

export default router;
