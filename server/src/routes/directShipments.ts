import { createHash } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import {
  assertDirectShipmentOrderScope,
  getDirectShipment,
  getOrderDirectShipments,
} from '../modules/procurementSettlement/index.js';
import {
  createDirectShipment,
  getDirectShipmentReviewContext,
  reviewDirectShipment,
  dispatchDirectShipment,
  cancelDirectShipment,
  receiveDirectShipment,
} from '../modules/procurementSettlement/index.js';
import {
  createDirectShipmentSchema,
  reviewDirectShipmentSchema,
  directShipmentActionSchema,
  directShipmentReceiptSchema,
} from '../modules/procurementSettlement/index.js';

const router = Router();
const id = z.string().trim().min(1).max(200);
const querySchema = z.object({ orderId: id }).strict();
const paramsSchema = z.object({ id }).strict();

type AccessAction = 'read' | 'manage' | 'review';
type AccessTarget = {
  orderId?: string;
  purchaseCommitmentId?: string;
  shipmentId?: string;
  shipmentLineId?: string;
};

async function access(req: AuthRequest, target: AccessTarget, action: AccessAction) {
  let orderId = target.orderId;
  if (target.purchaseCommitmentId) {
    orderId = (await prisma.purchaseCommitment.findUnique({
      where: { id: target.purchaseCommitmentId },
      select: { orderId: true },
    }))?.orderId;
  }
  if (target.shipmentId) {
    orderId = (await prisma.supplierDirectShipment.findUnique({
      where: { id: target.shipmentId },
      select: { orderId: true },
    }))?.orderId;
  }
  if (target.shipmentLineId) {
    orderId = (await prisma.supplierDirectShipmentLine.findUnique({
      where: { id: target.shipmentLineId },
      select: { shipment: { select: { orderId: true } } },
    }))?.shipment.orderId;
  }
  if (!orderId) throw new AppError('供应商直发或订单来源不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertDirectShipmentOrderScope(prisma, req.user!, orderId, action);
}

function command(req: AuthRequest, scope: string) {
  const context = buildIdempotencyContext(req, req.user!.id, scope);
  if (!context.key) throw new AppError('供应商直发命令必须提供 Idempotency-Key', 400, 'BAD_REQUEST');
  return {
    context,
    commandId: createHash('sha256').update(JSON.stringify([context.actorId, scope, context.key])).digest('hex'),
  };
}

async function projectShipment(actor: NonNullable<AuthRequest['user']>, shipmentId: string) {
  return prisma.$transaction(
    tx => getDirectShipment({ tx, actor, shipmentId }),
    { isolationLevel: 'RepeatableRead' },
  );
}

router.get('/', requireCapability('inventory', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const query = querySchema.safeParse(req.query);
  if (!query.success) throw new AppError('直发列表需要明确的 orderId', 400, 'VALIDATION_ERROR');
  const data = await prisma.$transaction(
    tx => getOrderDirectShipments({ tx, actor: req.user!, orderId: query.data.orderId }),
    { isolationLevel: 'RepeatableRead' },
  );
  res.json({ success: true, data });
}));

router.get('/lines/:id/review-context', requireCapability('quality_review', 'approve'), validateParams(paramsSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { shipmentLineId: req.params.id }, 'review');
  const data = await prisma.$transaction(
    tx => getDirectShipmentReviewContext({ tx, actor: req.user!, shipmentLineId: req.params.id }),
    { isolationLevel: 'RepeatableRead' },
  );
  res.json({ success: true, data });
}));

router.get('/:id', requireCapability('inventory', 'read'), validateParams(paramsSchema), asyncHandler(async (req: AuthRequest, res) => {
  const data = await projectShipment(req.user!, req.params.id);
  res.json({ success: true, data });
}));

router.post('/', requireCapability('inventory', 'manage'), validateBody(createDirectShipmentSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { purchaseCommitmentId: req.body.purchaseCommitmentId }, 'manage');
  const { context, commandId } = command(req, 'POST:/direct-shipments');
  const execution = await runIdempotentOperation(context, async tx => ({
    statusCode: 201,
    payload: await createDirectShipment({ tx, actor: req.user!, ...req.body, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { shipmentId: execution.payload.id }, 'manage');
  const data = await projectShipment(req.user!, execution.payload.id);
  applyIdempotencyHeaders(res, execution);
  res.status(execution.statusCode).json({ success: true, data });
}));

router.post('/lines/:id/review', requireCapability('quality_review', 'approve'), validateParams(paramsSchema), validateBody(reviewDirectShipmentSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { shipmentLineId: req.params.id }, 'review');
  const { context, commandId } = command(req, `POST:/direct-shipments/lines/${req.params.id}/review`);
  const execution = await runIdempotentOperation(context, async tx => ({
    payload: await reviewDirectShipment({ tx, actor: req.user!, ...req.body, shipmentLineId: req.params.id, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { shipmentLineId: req.params.id }, 'review');
  const data = await projectShipment(req.user!, execution.payload.id);
  applyIdempotencyHeaders(res, execution);
  res.status(execution.statusCode).json({ success: true, data });
}));

async function actionRoute(
  req: AuthRequest,
  res: Response,
  action: 'DISPATCH' | 'CANCEL',
) {
  await access(req, { shipmentId: req.params.id }, 'manage');
  const actionName = action === 'DISPATCH' ? 'dispatch' : 'cancel';
  const { context, commandId } = command(req, `POST:/direct-shipments/${req.params.id}/${actionName}`);
  const execution = await runIdempotentOperation(context, async tx => ({
    payload: action === 'DISPATCH'
      ? await dispatchDirectShipment({ tx, actor: req.user!, ...req.body, shipmentId: req.params.id, commandId })
      : await cancelDirectShipment({ tx, actor: req.user!, ...req.body, shipmentId: req.params.id, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { shipmentId: req.params.id }, 'manage');
  const data = await projectShipment(req.user!, execution.payload.id);
  applyIdempotencyHeaders(res, execution);
  res.status(execution.statusCode).json({ success: true, data });
}

router.post('/:id/dispatch', requireCapability('inventory', 'manage'), validateParams(paramsSchema), validateBody(directShipmentActionSchema), asyncHandler(async (req: AuthRequest, res) => {
  await actionRoute(req, res, 'DISPATCH');
}));

router.post('/:id/cancel', requireCapability('inventory', 'manage'), validateParams(paramsSchema), validateBody(directShipmentActionSchema), asyncHandler(async (req: AuthRequest, res) => {
  await actionRoute(req, res, 'CANCEL');
}));

router.post('/lines/:id/receipt', requireCapability('inventory', 'manage'), validateParams(paramsSchema), validateBody(directShipmentReceiptSchema), asyncHandler(async (req: AuthRequest, res) => {
  await access(req, { shipmentLineId: req.params.id }, 'manage');
  const { context, commandId } = command(req, `POST:/direct-shipments/lines/${req.params.id}/receipt`);
  const execution = await runIdempotentOperation(context, async tx => ({
    payload: await receiveDirectShipment({ tx, actor: req.user!, ...req.body, shipmentLineId: req.params.id, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, { shipmentLineId: req.params.id }, 'manage');
  const data = await projectShipment(req.user!, execution.payload.id);
  applyIdempotencyHeaders(res, execution);
  res.status(execution.statusCode).json({ success: true, data });
}));

export default router;
