import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import type { AuthRequest } from '../middleware/auth.js';
import { AppError, asyncHandler } from '../middleware/errorHandler.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { reserveLineInventory, assignLineInventory, releaseLineInventory, getLineInventoryAvailability,
  getAllocationFulfillmentContext, createAllocationFulfillmentReview, consumeAllocatedInventory } from '../modules/inventoryQuality/index.js';

const router = Router();
const id = z.string().min(1);
const quantity = z.number().int().positive().max(2147483647);
const reserveSchema = z.object({ quotationLineId: id, orderLineId: id.optional(),
  allocations: z.array(z.object({ inventoryDetailId: id, quantity,
    stockReceiptLineId: id.optional(), sourceReturnHoldId: id.optional() }).strict()
    .refine(row => !(row.stockReceiptLineId && row.sourceReturnHoldId), '只能指定一个实物来源')).min(1).max(100) }).strict();
const assignSchema = z.object({ orderLineId: id,
  allocations: z.array(z.object({ allocationId: id, quantity }).strict()).min(1).max(100) }).strict();
const releaseSchema = z.object({ allocationId: id, assignmentId: id.optional(), quantity,
  reason: z.string().trim().min(1).max(1000) }).strict();
const reviewSchema = z.object({ assignmentId: id, quantity, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/i),
  approved: z.boolean(), evidenceIds: z.array(id).max(20), verifiedSerialNumber: z.string(), verifiedBatchNumber: z.string(),
  certificateIdentity: z.object({ id: id.optional(), certificateId: id.optional(), certificateNumber: z.string().optional(),
    certificateType: z.string().optional(), partNumber: z.string().optional(), serialNumber: z.string().nullable().optional(),
    batchNumber: z.string().nullable().optional(), fileHash: z.string().nullable().optional() }).strict().optional(),
  checks: z.object({ identity: z.boolean(), documents: z.boolean(), conditionAndLife: z.boolean(), customerRequirements: z.boolean() }).strict(),
  reason: z.string().trim().min(3).max(4000),
}).strict();
const consumeSchema = z.object({ assignmentId: id, quantity, reviewId: id, notes: z.string().max(4000).optional() }).strict();

async function assertLineAccess(actor: NonNullable<AuthRequest['user']>, target: { quotationLineId?: string; orderLineId?: string; allocationId?: string; assignmentId?: string }, quotationRead = true) {
  const assignment = target.assignmentId ? await prisma.allocationAssignment.findUnique({ where: { id: target.assignmentId },
    select: { orderLineId: true, allocationId: true } }) : null;
  if (target.assignmentId && !assignment) throw new AppError('订单分配不存在', 404, 'RESOURCE_NOT_FOUND');
  if (assignment && target.allocationId && assignment.allocationId !== target.allocationId) throw new AppError('分配来源不匹配', 409, 'RESOURCE_CONFLICT');
  const orderLineId = target.orderLineId ?? assignment?.orderLineId;
  const orderLine = orderLineId ? await prisma.orderLine.findUnique({ where: { id: orderLineId }, select: {
    quotationLineId: true, order: { select: { quotation: { select: { createdBy: true, creator: { select: { department: true } } } } } },
  } }) : null;
  if (orderLineId && !orderLine) throw new AppError('订单行不存在', 404, 'RESOURCE_NOT_FOUND');
  const allocation = target.allocationId ? await prisma.inventoryAllocation.findUnique({ where: { id: target.allocationId }, select: { quotationLineId: true } }) : null;
  if (target.allocationId && !allocation) throw new AppError('库存分配不存在', 404, 'RESOURCE_NOT_FOUND');
  const quotationLineId = target.quotationLineId ?? orderLine?.quotationLineId ?? allocation?.quotationLineId;
  const line = quotationLineId ? await prisma.quotationLine.findUnique({ where: { id: quotationLineId }, select: {
    quotation: { select: { createdBy: true, creator: { select: { department: true } } } },
  } }) : null;
  if (!line) throw new AppError('报价行不存在', 404, 'RESOURCE_NOT_FOUND');
  if (orderLine && orderLine.quotationLineId !== quotationLineId) throw new AppError('订单行与报价行不匹配', 409, 'RESOURCE_CONFLICT');
  if (allocation && allocation.quotationLineId !== quotationLineId) throw new AppError('分配与报价行不匹配', 409, 'RESOURCE_CONFLICT');
  if (quotationRead) assertCapability(actor, 'quotation', 'read', { ownerId: line.quotation.createdBy, department: line.quotation.creator.department });
  if (orderLine) assertCapability(actor, 'order', 'read', { ownerId: orderLine.order.quotation.createdBy, department: orderLine.order.quotation.creator.department });
  return { ownerId: line.quotation.createdBy, department: line.quotation.creator.department };
}

function commandContext(req: AuthRequest, scope: string) {
  const context = buildIdempotencyContext(req, req.user!.id, scope);
  if (!context.key) throw new AppError('库存分配写入必须提供 Idempotency-Key', 400, 'BAD_REQUEST');
  // A persistent command identity also prevents duplicate side effects after
  // the general response cache's replay window has expired.
  const commandId = createHash('sha256').update(JSON.stringify([context.actorId, context.scope, context.key])).digest('hex');
  return { context, commandId };
}

router.post('/reserve', requireCapability('inventory', 'manage'), validateBody(reserveSchema), asyncHandler(async (req: AuthRequest, res) => {
  await assertLineAccess(req.user!, req.body);
  const { context, commandId } = commandContext(req, 'POST:/inventory-allocations/reserve');
  const execution = await runIdempotentOperation(context, async tx => ({
    payload: await reserveLineInventory({ tx, actor: req.user!, ...req.body, commandId }), statusCode: 201,
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await assertLineAccess(req.user!, req.body);
  applyIdempotencyHeaders(res, execution);
  res.status(execution.statusCode).json({ success: true, data: execution.payload });
}));

router.post('/assign', requireCapability('inventory', 'manage'), validateBody(assignSchema), asyncHandler(async (req: AuthRequest, res) => {
  await assertLineAccess(req.user!, req.body);
  const { context, commandId } = commandContext(req, 'POST:/inventory-allocations/assign');
  const execution = await runIdempotentOperation(context, async tx => ({
    payload: await assignLineInventory({ tx, actor: req.user!, ...req.body, commandId }), statusCode: 201,
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await assertLineAccess(req.user!, req.body);
  applyIdempotencyHeaders(res, execution);
  res.status(execution.statusCode).json({ success: true, data: execution.payload });
}));

router.post('/release', requireCapability('inventory', 'manage'), validateBody(releaseSchema), asyncHandler(async (req: AuthRequest, res) => {
  await assertLineAccess(req.user!, req.body);
  const { context, commandId } = commandContext(req, 'POST:/inventory-allocations/release');
  const execution = await runIdempotentOperation(context, async tx => ({
    payload: await releaseLineInventory({ tx, actor: req.user!, ...req.body, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await assertLineAccess(req.user!, req.body);
  applyIdempotencyHeaders(res, execution);
  res.status(execution.statusCode).json({ success: true, data: execution.payload });
}));

router.get('/quotation-lines/:quotationLineId', requireCapability('quotation', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const data = await getLineInventoryAvailability({ tx: prisma, actor: req.user!, quotationLineId: req.params.quotationLineId });
  res.json({ success: true, data });
}));

router.get('/order-lines/:orderLineId', requireCapability('order', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  await assertLineAccess(req.user!, { orderLineId: req.params.orderLineId }, false);
  const line = await prisma.orderLine.findUniqueOrThrow({ where: { id: req.params.orderLineId },
    select: { id: true, quotationLineId: true, quantity: true, outboundQuantity: true, directShippedQuantity: true } });
  const rows = await prisma.allocationAssignment.findMany({ where: { orderLineId: line.id }, orderBy: { id: 'asc' }, select: {
    id: true, orderLineId: true, assignedQuantity: true, releasedQuantity: true, consumedQuantity: true, allocationId: true,
    allocation: { select: { inventoryDetailId: true } },
  } });
  const assignments = rows.map(({ allocation, ...assignment }) => ({ ...assignment, inventoryDetailId: allocation.inventoryDetailId,
    activeQuantity: assignment.assignedQuantity - assignment.releasedQuantity - assignment.consumedQuantity }));
  res.json({ success: true, data: { ...line, assignments } });
}));

router.get('/quality-review/:assignmentId', requireCapability('quality_review', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const scope = await assertLineAccess(req.user!, { assignmentId: req.params.assignmentId }, false);
  assertCapability(req.user!, 'quality_review', 'read', scope);
  const parsed = quantity.safeParse(Number(req.query.quantity));
  if (!parsed.success) throw new AppError('请输入正整数审核数量', 400, 'BAD_REQUEST');
  const context = await getAllocationFulfillmentContext(prisma, req.params.assignmentId, parsed.data);
  const review = await prisma.fulfillmentReview.findFirst({ where: { assignmentId: req.params.assignmentId },
    orderBy: [{ reviewedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, approved: true, snapshotHash: true, consumedAt: true, reviewedAt: true, quantity: true } });
  res.json({ success: true, data: { snapshot: context.snapshot, snapshotHash: context.snapshotHash, review } });
}));

router.post('/quality-reviews', requireCapability('quality_review', 'approve'), validateBody(reviewSchema), asyncHandler(async (req: AuthRequest, res) => {
  assertCapability(req.user!, 'quality_review', 'approve', await assertLineAccess(req.user!, req.body, false));
  const { context } = commandContext(req, 'POST:/inventory-allocations/quality-reviews');
  const execution = await runIdempotentOperation(context, async tx => {
    const review = await createAllocationFulfillmentReview(tx, req.body, req.user!);
    return { payload: { id: review.id, approved: review.approved, reviewedAt: review.reviewedAt, quantity: review.quantity }, statusCode: 201 };
  }, { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  assertCapability(req.user!, 'quality_review', 'approve', await assertLineAccess(req.user!, req.body, false));
  applyIdempotencyHeaders(res, execution);
  res.status(execution.statusCode).json({ success: true, data: execution.payload });
}));

router.post('/consume', requireCapability('inventory', 'manage'), validateBody(consumeSchema), asyncHandler(async (req: AuthRequest, res) => {
  await assertLineAccess(req.user!, req.body);
  const { context, commandId } = commandContext(req, 'POST:/inventory-allocations/consume');
  const execution = await runIdempotentOperation(context, async tx => {
    const result = await consumeAllocatedInventory({ tx, actor: req.user!, ...req.body, commandId });
    return { payload: { assignmentId: result.assignmentId, allocationId: result.allocationId,
      inventoryDetailId: result.inventoryDetailId, quantity: result.quantity, beforeQuantity: result.beforeQuantity,
      afterQuantity: result.afterQuantity, transactionId: result.transaction.id,
      orderId: result.order.id, orderStatus: result.order.status, allocationVersion: result.allocationVersion,
      assignmentVersion: result.assignmentVersion } };
  }, { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await assertLineAccess(req.user!, req.body);
  applyIdempotencyHeaders(res, execution);
  res.status(execution.statusCode).json({ success: true, data: execution.payload });
}));

export default router;
