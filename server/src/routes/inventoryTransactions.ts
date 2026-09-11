import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import {
  inventoryTransactionRepository,
  outboundInventoryForOrder,
  releaseInventoryReservation,
  reserveInventoryForQuotation,
  getFulfillmentReviewContext,
  createFulfillmentReview,
} from '../modules/inventoryQuality/index.js';

const router = Router();

const qualityReviewSchema = z.object({
  orderId: z.string().min(1), quantity: z.number().int().positive(), snapshotHash: z.string().length(64),
  approved: z.boolean(), evidenceIds: z.array(z.string().min(1)).max(20),
  verifiedSerialNumber: z.string(), verifiedBatchNumber: z.string(),
  checks: z.object({ identity: z.boolean(), documents: z.boolean(), conditionAndLife: z.boolean(), customerRequirements: z.boolean() }).strict(),
  reason: z.string().trim().min(3).max(4000),
}).strict();

router.get('/quality-review/:orderId', requireCapability('quality_review', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const context = await getFulfillmentReviewContext(prisma, req.params.orderId, Number(req.query.quantity));
  assertCapability(req.user!, 'quality_review', 'read', { ownerId: context.order.quotation.createdBy, department: context.order.quotation.creator.department });
  const review = await prisma.fulfillmentReview.findFirst({
    where: { orderId: req.params.orderId, inventoryDetailId: context.detail.id },
    orderBy: [{ reviewedAt: 'desc' }, { id: 'desc' }],
    select: { approved: true, snapshotHash: true, consumedAt: true, reviewedAt: true, quantity: true },
  });
  res.json({ success: true, data: { snapshot: context.snapshot, snapshotHash: context.snapshotHash, review } });
}));

router.post('/quality-reviews', requireCapability('quality_review', 'approve'), validateBody(qualityReviewSchema), asyncHandler(async (req: AuthRequest, res) => {
  const execution = await runIdempotentOperation(
    buildIdempotencyContext(req, req.user!.id, 'POST:/inventory-transactions/quality-reviews'),
    async (tx) => {
      const review = await createFulfillmentReview(tx, req.body, req.user!);
      return { payload: { id: review.id, approved: review.approved, reviewedAt: review.reviewedAt, quantity: review.quantity }, statusCode: 201, resourceType: 'FULFILLMENT_REVIEW', resourceId: review.id };
    },
    { isolationLevel: 'Serializable' },
  );
  applyIdempotencyHeaders(res, execution);
  res.status(execution.statusCode).json({ success: true, data: execution.payload });
}));

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
      { isolationLevel: 'Serializable' },
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
      { isolationLevel: 'Serializable' },
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
      { isolationLevel: 'Serializable' },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({ success: true, data: execution.payload });
  }),
);

export default router;
