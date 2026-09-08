import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import type { CapabilityAction } from '../lib/capabilityPolicy.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { assertPurchaseOrderScope, getOrderPurchaseCommitments, getPurchaseCommitment,
  createPurchaseCommitment, transitionPurchaseCommitment, type PurchaseCommand } from '../modules/procurementSettlement/index.js';

const router = Router();
const id = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(3).max(4000);
const evidenceIds = z.array(id).min(1).max(20).refine(ids => new Set(ids).size === ids.length, '附件不能重复');
const version = z.number().int().positive().max(2147483647);
const source = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SUPPLIER_QUOTE'), supplierQuoteId: id }).strict(),
  z.object({ type: z.literal('MANUAL'), unitCost: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
    currency: z.literal('USD'), reason, evidenceFileIds: evidenceIds }).strict(),
]);
const createSchema = z.object({ orderId: id, supplierId: id, paymentTerms: z.string().trim().min(1).max(2000).nullable().optional(),
  lines: z.array(z.object({ orderLineId: id, source, quantity: z.number().int().positive().max(2147483647),
    promisedDate: z.string().datetime({ offset: true }), fulfillmentMode: z.enum(['STOCK_RECEIPT', 'SUPPLIER_DIRECT']),
  }).strict()).min(1).max(100) }).strict();
const transitionSchema = z.object({ version, reason }).strict();
const confirmSchema = transitionSchema.extend({ supplierReferenceNo: id, evidenceIds }).strict();

async function access(req: AuthRequest, target: { id?: string; orderId?: string }, action: CapabilityAction) {
  const orderId = target.id
    ? (await prisma.purchaseCommitment.findUnique({ where: { id: target.id }, select: { orderId: true } }))?.orderId
    : target.orderId;
  if (!orderId) throw new AppError('采购承诺或销售来源不存在', 404, 'RESOURCE_NOT_FOUND');
  const result = await assertPurchaseOrderScope(prisma, req.user!, orderId, action);
  if (action !== 'read' && !result.canViewCost) throw new AppError('处理采购承诺需要成本权限', 403, 'AUTH_FORBIDDEN');
}
function command(req: AuthRequest, scope: string) {
  const context = buildIdempotencyContext(req, req.user!.id, scope);
  if (!context.key) throw new AppError('采购命令必须提供 Idempotency-Key', 400, 'BAD_REQUEST');
  return { context, commandId: createHash('sha256').update(JSON.stringify([context.actorId, scope, context.key])).digest('hex') };
}
router.get('/', requireCapability('purchase_commitment', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const query = z.object({ orderId: id }).strict().safeParse(req.query);
  if (!query.success) throw new AppError('采购列表需要明确的 orderId', 400, 'VALIDATION_ERROR');
  const data = await prisma.$transaction(tx => getOrderPurchaseCommitments({ tx, actor: req.user!, orderId: query.data.orderId }), { isolationLevel: 'RepeatableRead' });
  res.json({ success: true, data });
}));
router.get('/:id', requireCapability('purchase_commitment', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const data = await prisma.$transaction(tx => getPurchaseCommitment({ tx, actor: req.user!, purchaseCommitmentId: req.params.id }), { isolationLevel: 'RepeatableRead' });
  res.json({ success: true, data });
}));
router.post('/', requireCapability('purchase_commitment', 'create'), validateBody(createSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { orderId: req.body.orderId }, 'create');
  const { context, commandId } = command(req, 'POST:/purchase-commitments');
  // Persist only a non-sensitive resource reference in the replay cache. Read
  // and project the current entity after rechecking current write permission.
  const result = await runIdempotentOperation(context, async tx => ({ statusCode: 201,
    payload: await createPurchaseCommitment({ tx, actor: req.user!, ...req.body, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { id: result.payload.id }, 'create');
  const data = await prisma.$transaction(tx => getPurchaseCommitment({ tx, actor: req.user!, purchaseCommitmentId: result.payload.id }), { isolationLevel: 'RepeatableRead' });
  applyIdempotencyHeaders(res, result);
  res.status(result.statusCode).json({ success: true, data });
}));

function transition(action: PurchaseCommand) {
  return asyncHandler(async (req: AuthRequest, res) => {
    const capability = action === 'APPROVE' || action === 'REJECT' ? 'approve' : 'transition';
    await access(req, { id: req.params.id }, capability);
    const { context, commandId } = command(req, `POST:/purchase-commitments/${req.params.id}/${action.toLowerCase()}`);
    const result = await runIdempotentOperation(context, async tx => ({
      payload: await transitionPurchaseCommitment({ tx, actor: req.user!, ...req.body, purchaseCommitmentId: req.params.id, action, commandId }),
    }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
    await access(req, { id: req.params.id }, capability);
    const data = await prisma.$transaction(tx => getPurchaseCommitment({ tx, actor: req.user!, purchaseCommitmentId: req.params.id }), { isolationLevel: 'RepeatableRead' });
    applyIdempotencyHeaders(res, result);
    res.status(result.statusCode).json({ success: true, data });
  });
}
router.post('/:id/submit', requireCapability('purchase_commitment', 'transition'), validateBody(transitionSchema), transition('SUBMIT'));
router.post('/:id/approve', requireCapability('purchase_commitment', 'approve'), validateBody(transitionSchema), transition('APPROVE'));
router.post('/:id/reject', requireCapability('purchase_commitment', 'approve'), validateBody(transitionSchema), transition('REJECT'));
router.post('/:id/confirm', requireCapability('purchase_commitment', 'transition'), validateBody(confirmSchema), transition('CONFIRM'));
router.post('/:id/cancel', requireCapability('purchase_commitment', 'transition'), validateBody(transitionSchema), transition('CANCEL'));

export default router;
