import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { CapabilityActor } from '../../lib/capabilityPolicy.js';
import { AppError } from '../../middleware/errorHandler.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { assertSettlementOrderScope, settlementReadInclude, settlementBalance } from './settlementAccess.js';
import { bindSettlementEvidence } from './settlementEvidence.js';
import { SettlementAmountError } from './settlementAmounts.js';
import { createSettlementAccountSchema, settlementRecordSchema } from './settlementInputs.js';

type Tx = Prisma.TransactionClient;
type CreateInput = ReturnType<typeof createSettlementAccountSchema.parse>;
type RecordInput = ReturnType<typeof settlementRecordSchema.parse>;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function conflict(message: string): never { throw new AppError(message, 409, 'RESOURCE_CONFLICT'); }
function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('结算输入不完整或不符合当前记录类型', 400, 'VALIDATION_ERROR');
  return result.data;
}
async function replay(tx: Tx, actor: CapabilityActor, commandId: string, requestHash: string, accountId?: string) {
  if (typeof commandId !== 'string' || !commandId.trim() || commandId.length > 200) {
    throw new AppError('缺少有效命令标识', 400, 'VALIDATION_ERROR');
  }
  const previous = await tx.settlementRecord.findUnique({ where: { commandId } });
  if (!previous) return null;
  if (previous.actorId !== actor.id || previous.requestHash !== requestHash || (accountId && previous.accountId !== accountId)) {
    throw new AppError('同一结算命令不能更换内容', 409, 'IDEMPOTENCY_KEY_REUSED');
  }
  return { id: previous.accountId };
}
async function changed(tx: Tx, actor: CapabilityActor, orderId: string) {
  await enqueueBusinessEvent(tx, { eventType: 'settlement.changed', aggregateType: 'ORDER', aggregateId: orderId,
    data: { orderId, refresh: true }, createdById: actor.id,
    socket: { room: SocketRooms.ORDERS, event: SocketEvents.ORDER_STATUS_CHANGED, scope: { capability: 'order.read' } } });
}

/** Caller owns Serializable transaction and validates deferred constraints. */
export async function createSettlementAccount(args: { tx: Tx; actor: CapabilityActor; input: CreateInput; commandId: string }) {
  const { tx, actor } = args;
  const input = parse(createSettlementAccountSchema, args.input);
  const access = await assertSettlementOrderScope(tx, actor, input.orderId, input.side, 'create');
  const requestHash = hash({ kind: 'OPEN', ...input, evidenceIds: [...input.evidenceIds].sort() });
  const previous = await replay(tx, actor, args.commandId, requestHash);
  if (previous) return previous;
  const order = access.order;
  if (!['SO_CREATED', 'PO_CREATED', 'SHIPPED', 'DELIVERED'].includes(order.status) || order.quotation.currency !== 'USD') {
    conflict('当前订单状态或币种不能建立结算记录');
  }
  let sourceKey = `ORDER:${order.id}`;
  let initialAmount = order.totalAmountDecimal;
  let sourceSnapshot: Record<string, unknown> = { kind: 'ORDER', sourceId: order.id,
    sourceNumber: order.orderNumber, sourceVersion: order.version, counterpartyId: order.customerId, counterpartyName: order.customer.name };
  if (input.side === 'PAYABLE') {
    const purchase = await tx.purchaseCommitment.findUnique({ where: { id: input.purchaseCommitmentId! },
      include: { supplier: { select: { name: true } } } });
    if (!purchase || purchase.orderId !== order.id || !['CONFIRMED', 'CLOSED'].includes(purchase.status) || purchase.currency !== 'USD') {
      conflict('应付必须对应当前订单已确认的 USD 采购承诺');
    }
    sourceKey = `PURCHASE:${purchase.id}`;
    initialAmount = purchase.totalCost;
    sourceSnapshot = { kind: 'PURCHASE', sourceId: purchase.id, sourceNumber: purchase.commitmentNumber,
      sourceVersion: purchase.version, counterpartyId: purchase.supplierId, counterpartyName: purchase.supplier.name };
  }
  if (initialAmount === null || !initialAmount.isFinite() || initialAmount.isNegative()) conflict('交易缺少有效的结算金额事实');
  if (await tx.settlementAccount.findUnique({ where: { sourceKey } })) conflict('该交易来源已经建立结算记录');
  const claimed = await tx.order.updateMany({ where: { id: order.id, version: order.version }, data: { version: { increment: 1 } } });
  if (claimed.count !== 1) conflict('销售订单已变化，请刷新后重试');
  const id = randomUUID();
  await tx.settlementAccount.create({ data: { id, side: input.side, sourceKey, orderId: order.id,
    purchaseCommitmentId: input.purchaseCommitmentId ?? null, currency: 'USD', initialAmount,
    sourceSnapshot: json({ ...sourceSnapshot, initialAmount: initialAmount.toFixed(4), currency: 'USD' }),
    dueDate: new Date(input.dueDate), createdById: actor.id } });
  const evidence = await bindSettlementEvidence(tx, actor, id, input.evidenceIds);
  await tx.settlementRecord.create({ data: { accountId: id, accountVersion: 1, kind: 'OPEN', amount: null,
    dueDate: new Date(input.dueDate), occurredAt: new Date(input.occurredAt), externalSystem: input.externalSystem,
    voucherNumber: input.voucherNumber, voucherLine: input.voucherLine, reason: input.reason, evidence: json(evidence),
    actorId: actor.id, commandId: args.commandId, requestHash } });
  await changed(tx, actor, order.id);
  return { id };
}

/** Adds external voucher facts; it never initiates a bank payment or edits history. */
export async function appendSettlementRecord(args: { tx: Tx; actor: CapabilityActor; accountId: string; input: RecordInput; commandId: string }) {
  const { tx, actor } = args;
  const input = parse(settlementRecordSchema, args.input);
  const account = await tx.settlementAccount.findUnique({ where: { id: args.accountId }, include: settlementReadInclude });
  if (!account) throw new AppError('结算记录不存在', 404, 'RESOURCE_NOT_FOUND');
  const action = input.kind === 'REVERSAL' ? 'reconcile' : input.kind === 'TERMS' ? 'update' : 'create';
  await assertSettlementOrderScope(tx, actor, account.orderId, account.side, action);
  const requestHash = hash({ accountId: account.id, ...input, evidenceIds: [...input.evidenceIds].sort() });
  const previous = await replay(tx, actor, args.commandId, requestHash, account.id);
  if (previous) return previous;
  if (input.version !== account.version) conflict('结算记录已变化，请刷新后重试');
  let amount = input.amount === undefined ? null : new Prisma.Decimal(input.amount);
  if (input.kind === 'REVERSAL') {
    const target = account.records.find(record => record.id === input.reversalOfId);
    if (!target || !['PAYMENT', 'CREDIT', 'REFUND'].includes(target.kind) || !target.amount) conflict('只能冲销本结算记录的收付款、信用冲减或退款');
    if (account.records.some(record => record.reversalOfId === target.id)) conflict('该凭证已经冲销');
    amount = target.amount;
  }
  const version = account.version + 1;
  const updated = await tx.settlementAccount.updateMany({ where: { id: account.id, version: account.version },
    data: { version: { increment: 1 }, ...(input.kind === 'TERMS' ? { dueDate: new Date(input.dueDate!) } : {}) } });
  if (updated.count !== 1) conflict('结算记录已变化，请刷新后重试');
  const evidence = await bindSettlementEvidence(tx, actor, account.id, input.evidenceIds);
  await tx.settlementRecord.create({ data: { accountId: account.id, accountVersion: version,
    kind: input.kind, amount, dueDate: input.kind === 'TERMS' ? new Date(input.dueDate!) : null,
    occurredAt: new Date(input.occurredAt), externalSystem: input.externalSystem, voucherNumber: input.voucherNumber,
    voucherLine: input.voucherLine, reason: input.reason, evidence: json(evidence), reversalOfId: input.reversalOfId ?? null,
    actorId: actor.id, commandId: args.commandId, requestHash } });
  const current = await tx.settlementAccount.findUniqueOrThrow({ where: { id: account.id }, include: settlementReadInclude });
  try { settlementBalance(current); }
  catch (error) {
    if (error instanceof SettlementAmountError) throw new AppError(error.message, 409, 'RESOURCE_CONFLICT');
    throw error;
  }
  await changed(tx, actor, account.orderId);
  return { id: account.id };
}
