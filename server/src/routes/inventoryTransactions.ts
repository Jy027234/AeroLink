import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import {
  inventoryTransactionRepository,
  outboundInventoryForOrder,
  releaseInventoryReservation,
  reserveInventoryForQuotation,
} from '../modules/inventoryQuality/index.js';

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

function assertPositiveInteger(value: unknown, message: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AppError(message, 400, 'VALIDATION_ERROR');
  }
}

router.get(
  '/detail/:detailId',
  requireCapability('inventory', 'read'),
  asyncHandler(async (req, res) => {
    const transactions = await inventoryTransactionRepository.findMany({
      where: { inventoryDetailId: req.params.detailId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: transactions.map(serializeTransaction) });
  }),
);

router.get(
  '/order/:orderId',
  requireCapability('inventory', 'read'),
  asyncHandler(async (req, res) => {
    const transactions = await inventoryTransactionRepository.findMany({
      where: { orderId: req.params.orderId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: transactions.map(serializeTransaction) });
  }),
);

/**
 * The HTTP layer only validates the request envelope and applies idempotency.
 * Cross-aggregate policy, optimistic writes, ledger rows and outbox events
 * live in the Inventory & Quality module service.
 */
router.post(
  '/reserve',
  requireCapability('inventory', 'manage'),
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
        const result = await reserveInventoryForQuotation(tx, {
          inventoryDetailId,
          quotationId,
          quantity,
          notes,
          actorId,
        });
        return {
          payload: { ...serializeTransaction(result.transaction), ...result, transaction: undefined },
          statusCode: 201,
          resourceType: 'INVENTORY_TRANSACTION',
          resourceId: result.transaction.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({ success: true, data: execution.payload });
  }),
);

router.post(
  '/release',
  requireCapability('inventory', 'manage'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { quotationId, notes } = req.body as { quotationId?: string; notes?: string };
    const actorId = req.user!.id;

    if (!quotationId) {
      throw new AppError('库存预留释放参数不完整', 400, 'VALIDATION_ERROR');
    }

    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/inventory-transactions/release'),
      async (tx) => {
        const result = await releaseInventoryReservation(tx, { quotationId, notes, actorId });
        return {
          payload: { ...serializeTransaction(result.transaction), ...result, transaction: undefined },
          statusCode: 201,
          resourceType: 'INVENTORY_TRANSACTION',
          resourceId: result.transaction.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({ success: true, data: execution.payload });
  }),
);

router.post(
  '/outbound',
  requireCapability('inventory', 'manage'),
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
        const result = await outboundInventoryForOrder(tx, {
          inventoryDetailId,
          orderId,
          quantity,
          notes,
          actorId,
        });
        return {
          payload: { ...serializeTransaction(result.transaction), ...result, transaction: undefined },
          statusCode: 201,
          resourceType: 'INVENTORY_TRANSACTION',
          resourceId: result.transaction.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({ success: true, data: execution.payload });
  }),
);

export default router;
