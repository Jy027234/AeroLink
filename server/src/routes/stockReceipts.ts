import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { assertStockReceiptOrderScope, getStockReceipt, getOrderStockReceipts, receiptPhysicalSchema,
  receiptStorageSchema, receivePurchaseStock, getStockReceiptReviewContext, reviewPurchaseStock } from '../modules/procurementSettlement/index.js';

const router = Router();
const id = z.string().trim().min(1).max(200);
const version = z.number().int().positive().max(2147483647);
const reason = z.string().trim().min(3).max(4000);
const arrivalSchema = z.object({ purchaseCommitmentId: id, purchaseVersion: version,
  supplierDeliveryReference: id, reason, evidenceIds: z.array(id).min(1).max(20).refine(ids => new Set(ids).size === ids.length, '附件不能重复'),
  lines: z.array(z.object({ purchaseCommitmentLineId: id, physical: receiptPhysicalSchema, storage: receiptStorageSchema }).strict()).min(1).max(100),
}).strict();
const reviewSchema = z.object({ version, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['ACCEPTED', 'REJECTED']), reason,
  checks: z.object({ identity: z.boolean(), documents: z.boolean(), conditionAndLife: z.boolean(), customerRequirements: z.boolean() }).strict(),
}).strict();
async function access(req: AuthRequest, target: { purchaseId?: string; receiptLineId?: string; receiptId?: string }, action: 'receive' | 'review') {
  const receiptId = target.receiptId ?? (target.receiptLineId ? (await prisma.stockReceiptLine.findUnique({
    where: { id: target.receiptLineId }, select: { receiptId: true } }))?.receiptId : undefined);
  const purchaseId = target.purchaseId ?? (receiptId ? (await prisma.stockReceipt.findUnique({
    where: { id: receiptId }, select: { purchaseCommitmentId: true } }))?.purchaseCommitmentId : undefined);
  const purchase = purchaseId ? await prisma.purchaseCommitment.findUnique({ where: { id: purchaseId }, select: { orderId: true } }) : null;
  if (!purchase) throw new AppError('收货或采购来源不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertStockReceiptOrderScope(prisma, req.user!, purchase.orderId, action);
}
function command(req: AuthRequest, scope: string) {
  const context = buildIdempotencyContext(req, req.user!.id, scope);
  if (!context.key) throw new AppError('收货命令必须提供 Idempotency-Key', 400, 'BAD_REQUEST');
  return { context, commandId: createHash('sha256').update(JSON.stringify([context.actorId, scope, context.key])).digest('hex') };
}
router.get('/', requireCapability('inventory', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const query = z.object({ orderId: id }).strict().safeParse(req.query);
  if (!query.success) throw new AppError('收货列表需要明确的 orderId', 400, 'VALIDATION_ERROR');
  const data = await prisma.$transaction(tx => getOrderStockReceipts({ tx, actor: req.user!, orderId: query.data.orderId }), { isolationLevel: 'RepeatableRead' });
  res.json({ success: true, data });
}));
router.get('/lines/:id/review-context', requireCapability('quality_review', 'approve'), asyncHandler(async (req: AuthRequest, res) => {
  const data = await prisma.$transaction(tx => getStockReceiptReviewContext({ tx, actor: req.user!, receiptLineId: req.params.id }), { isolationLevel: 'RepeatableRead' });
  res.json({ success: true, data });
}));
router.get('/:id', requireCapability('inventory', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const data = await prisma.$transaction(tx => getStockReceipt({ tx, actor: req.user!, receiptId: req.params.id }), { isolationLevel: 'RepeatableRead' });
  res.json({ success: true, data });
}));
router.post('/', requireCapability('inventory', 'manage'), validateBody(arrivalSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { purchaseId: req.body.purchaseCommitmentId }, 'receive');
  const { context, commandId } = command(req, 'POST:/stock-receipts');
  const result = await runIdempotentOperation(context, async tx => ({ statusCode: 201,
    payload: await receivePurchaseStock({ tx, actor: req.user!, ...req.body, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { receiptId: result.payload.id }, 'receive');
  const data = await prisma.$transaction(tx => getStockReceipt({ tx, actor: req.user!, receiptId: result.payload.id }), { isolationLevel: 'RepeatableRead' });
  applyIdempotencyHeaders(res, result); res.status(result.statusCode).json({ success: true, data });
}));
router.post('/lines/:id/review', requireCapability('quality_review', 'approve'), validateBody(reviewSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { receiptLineId: req.params.id }, 'review');
  const { context, commandId } = command(req, `POST:/stock-receipts/lines/${req.params.id}/review`);
  const result = await runIdempotentOperation(context, async tx => ({
    payload: await reviewPurchaseStock({ tx, actor: req.user!, ...req.body, receiptLineId: req.params.id, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { receiptId: result.payload.id }, 'review');
  const data = await prisma.$transaction(tx => getStockReceipt({ tx, actor: req.user!, receiptId: result.payload.id }), { isolationLevel: 'RepeatableRead' });
  applyIdempotencyHeaders(res, result); res.status(result.statusCode).json({ success: true, data });
}));
export default router;
