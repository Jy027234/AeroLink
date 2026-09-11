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
import { assertSettlementOrderScope, getSettlementAccount, getOrderSettlements,
  createSettlementAccount, appendSettlementRecord, createSettlementAccountSchema, settlementRecordSchema,
} from '../modules/procurementSettlement/index.js';

const router = Router();
async function access(req: AuthRequest, accountId: string, action: CapabilityAction) {
  const account = await prisma.settlementAccount.findUnique({ where: { id: accountId }, select: { orderId: true, side: true } });
  if (!account) throw new AppError('结算记录不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertSettlementOrderScope(prisma, req.user!, account.orderId, account.side, action);
}
function command(req: AuthRequest, scope: string) {
  const context = buildIdempotencyContext(req, req.user!.id, scope);
  if (!context.key) throw new AppError('结算登记必须提供 Idempotency-Key', 400, 'BAD_REQUEST');
  return { context, commandId: createHash('sha256').update(JSON.stringify([context.actorId, scope, context.key])).digest('hex') };
}
router.get('/', requireCapability('settlement', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const query = z.object({ orderId: z.string().trim().min(1).max(200) }).strict().safeParse(req.query);
  if (!query.success) throw new AppError('结算列表需要明确的 orderId', 400, 'VALIDATION_ERROR');
  const data = await prisma.$transaction(tx => getOrderSettlements(tx, req.user!, query.data.orderId), { isolationLevel: 'RepeatableRead' });
  res.json({ success: true, data });
}));
router.get('/:id', requireCapability('settlement', 'read'), asyncHandler(async (req: AuthRequest, res) => {
  const data = await prisma.$transaction(tx => getSettlementAccount(tx, req.user!, req.params.id), { isolationLevel: 'RepeatableRead' });
  res.json({ success: true, data });
}));
router.post('/', requireCapability('settlement', 'create'), validateBody(createSettlementAccountSchema), asyncHandler(async (req: AuthRequest, res) => {
  await assertSettlementOrderScope(prisma, req.user!, req.body.orderId, req.body.side, 'create');
  const { context, commandId } = command(req, 'POST:/settlements');
  const result = await runIdempotentOperation(context, async tx => ({ statusCode: 201,
    payload: await createSettlementAccount({ tx, actor: req.user!, input: req.body, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  // Cache only an ID. Re-check current write scope before projecting current financial data.
  await access(req, result.payload.id, 'create');
  const data = await prisma.$transaction(tx => getSettlementAccount(tx, req.user!, result.payload.id), { isolationLevel: 'RepeatableRead' });
  applyIdempotencyHeaders(res, result);
  res.status(result.statusCode).json({ success: true, data });
}));
router.post('/:id/records', validateBody(settlementRecordSchema), asyncHandler(async (req: AuthRequest, res) => {
  const action = req.body.kind === 'REVERSAL' ? 'reconcile' : req.body.kind === 'TERMS' ? 'update' : 'create';
  await access(req, req.params.id, action);
  const { context, commandId } = command(req, `POST:/settlements/${req.params.id}/records`);
  const result = await runIdempotentOperation(context, async tx => ({ statusCode: 201,
    payload: await appendSettlementRecord({ tx, actor: req.user!, accountId: req.params.id, input: req.body, commandId }),
  }), { isolationLevel: 'Serializable', validateDeferredConstraints: true });
  await access(req, result.payload.id, action);
  const data = await prisma.$transaction(tx => getSettlementAccount(tx, req.user!, result.payload.id), { isolationLevel: 'RepeatableRead' });
  applyIdempotencyHeaders(res, result);
  res.status(result.statusCode).json({ success: true, data });
}));
export default router;
