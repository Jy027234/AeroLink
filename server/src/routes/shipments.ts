import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { assertShipmentOrderAccess, getOrderShipments, createShipment, receiveShipment,
  receiveShipmentReturn, getReturnReleaseContext, releaseShipmentReturn } from '../modules/inventoryQuality/index.js';

const router = Router();
const id = z.string().trim().min(1).max(200);
const quantity = z.number().int().positive().max(2147483647);
const evidenceIds = z.array(id).max(20);
const reason = z.string().trim().min(3).max(4000);
const place = z.string().trim().min(1).max(300);
const createSchema = z.object({ orderId: id, carrier: place, trackingNumber: place, origin: place, destination: place,
  lines: z.array(z.object({ outboundTransactionId: id, quantity }).strict()).min(1).max(100), evidenceIds: evidenceIds.default([]) }).strict();
const receiptSchema = z.object({ lines: z.array(z.object({ shipmentLineId: id, quantity }).strict()).min(1).max(100),
  evidenceIds: evidenceIds.min(1), reason }).strict();
const returnSchema = z.object({ shipmentLineId: id, quantity, evidenceIds: evidenceIds.min(1),
  verifiedSerialNumber: z.string().max(200), verifiedBatchNumber: z.string().max(200), reason }).strict();
const releaseSchema = z.object({ snapshotHash: z.string().regex(/^[a-f\d]{64}$/i), evidenceIds: evidenceIds.min(1),
  verifiedSerialNumber: z.string().max(200), verifiedBatchNumber: z.string().max(200),
  checks: z.object({ identity: z.boolean(), documents: z.boolean(), conditionAndLife: z.boolean(), customerRequirements: z.boolean() }).strict(), reason }).strict();

type Target = { orderId?: string; shipmentId?: string; shipmentLineId?: string; returnHoldId?: string };
async function access(req: AuthRequest, target: Target) {
  let orderId = target.orderId;
  if (target.shipmentId) orderId = (await prisma.shipment.findUnique({ where: { id: target.shipmentId }, select: { orderId: true } }))?.orderId;
  if (target.shipmentLineId) orderId = (await prisma.shipmentLine.findUnique({ where: { id: target.shipmentLineId },
    select: { shipment: { select: { orderId: true } } } }))?.shipment.orderId;
  if (target.returnHoldId) orderId = (await prisma.returnHold.findUnique({ where: { id: target.returnHoldId },
    select: { shipmentLine: { select: { shipment: { select: { orderId: true } } } } } }))?.shipmentLine.shipment.orderId;
  if (!orderId) throw new AppError('发运或退货来源不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertShipmentOrderAccess(prisma, req.user!, orderId);
}
function command(req: AuthRequest, scope: string) {
  const context = buildIdempotencyContext(req, req.user!.id, scope);
  if (!context.key) throw new AppError('发运与退货命令必须提供 Idempotency-Key', 400, 'BAD_REQUEST');
  return { context, commandId: createHash('sha256').update(JSON.stringify([context.actorId, scope, context.key])).digest('hex') };
}

router.get('/orders/:orderId', requireCapability('order', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const data = await prisma.$transaction(tx => getOrderShipments({ tx, actor: req.user!, orderId: req.params.orderId }),
    { isolationLevel: 'RepeatableRead' });
  res.json({ success: true, data });
}));

router.get('/returns/:id/release-context', requireCapability('quality_review', 'approve'), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { returnHoldId: req.params.id });
  const data = await prisma.$transaction(tx => getReturnReleaseContext({ tx, actor: req.user!, returnHoldId: req.params.id }),
    { isolationLevel: 'RepeatableRead' });
  res.json({ success: true, data });
}));

router.post('/', requireCapability('inventory', 'manage'), validateBody(createSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { orderId: req.body.orderId });
  const { context, commandId } = command(req, 'POST:/shipments');
  const result = await runIdempotentOperation(context, async tx => ({
    statusCode: 201, payload: await createShipment({ tx, actor: req.user!, ...req.body, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { orderId: req.body.orderId });
  applyIdempotencyHeaders(res, result);
  res.status(result.statusCode).json({ success: true, data: result.payload });
}));

router.post('/dispatches/:id/receipts', requireCapability('inventory', 'manage'), validateBody(receiptSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { shipmentId: req.params.id });
  const { context, commandId } = command(req, `POST:/shipments/dispatches/${req.params.id}/receipts`);
  const result = await runIdempotentOperation(context, async tx => ({
    payload: await receiveShipment({ tx, actor: req.user!, shipmentId: req.params.id, ...req.body, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { shipmentId: req.params.id });
  applyIdempotencyHeaders(res, result);
  res.status(result.statusCode).json({ success: true, data: result.payload });
}));

router.post('/returns', requireCapability('inventory', 'manage'), validateBody(returnSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { shipmentLineId: req.body.shipmentLineId });
  const { context, commandId } = command(req, 'POST:/shipments/returns');
  const result = await runIdempotentOperation(context, async tx => ({
    statusCode: 201, payload: await receiveShipmentReturn({ tx, actor: req.user!, ...req.body, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { shipmentLineId: req.body.shipmentLineId });
  applyIdempotencyHeaders(res, result);
  res.status(result.statusCode).json({ success: true, data: result.payload });
}));

router.post('/returns/:id/release', requireCapability('quality_review', 'approve'), validateBody(releaseSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { returnHoldId: req.params.id });
  const { context, commandId } = command(req, `POST:/shipments/returns/${req.params.id}/release`);
  const result = await runIdempotentOperation(context, async tx => ({
    payload: await releaseShipmentReturn({ tx, actor: req.user!, returnHoldId: req.params.id, ...req.body, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { returnHoldId: req.params.id });
  applyIdempotencyHeaders(res, result);
  res.status(result.statusCode).json({ success: true, data: result.payload });
}));

export default router;
