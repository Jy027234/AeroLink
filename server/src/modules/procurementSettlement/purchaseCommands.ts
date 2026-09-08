import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { type CapabilityActor, type CapabilityAction } from '../../lib/capabilityPolicy.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { requiredQuotationApprovalLevel } from '../../lib/quotationApprovalPolicy.js';
import { assertPurchaseOrderScope, purchaseReadInclude } from './purchaseAccess.js';
import { buildPurchaseApprovalSnapshot, assertPurchaseApprovalActor, PURCHASE_APPROVAL_POLICY_VERSION } from './purchasePolicy.js';
import { deriveProcurementCoverage } from './procurementQuantities.js';
import { lockPurchaseCoverageLines } from './purchaseCoverage.js';
import { resolvePurchaseLines, assertPurchaseSourcesCurrent, bindPurchaseEvidence, type PurchaseLineInput } from './purchaseSources.js';

type Tx = Prisma.TransactionClient;
type Purchase = Prisma.PurchaseCommitmentGetPayload<{ include: typeof purchaseReadInclude }>;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function conflict(message: string): never { throw new AppError(message, 409, 'RESOURCE_CONFLICT'); }
function text(value: string, label: string, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${label}为空或过长`, 400, 'VALIDATION_ERROR');
  return value.trim();
}
function openOrder(status: string) {
  if (!['SO_CREATED', 'PO_CREATED'].includes(status)) conflict('当前订单状态不能新增或推进采购承诺');
}
async function assertSupplierActive(tx: Tx, supplierId: string) {
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { id: true, status: true } });
  if (!supplier) throw new AppError('采购供应商不存在', 404, 'RESOURCE_NOT_FOUND');
  if (supplier.status.toLowerCase() !== 'active') conflict('采购供应商已停用或尚未启用');
}
async function claimOrder(tx: Tx, order: { id: string; version: number; status: string }) {
  const updated = await tx.order.updateMany({ where: { id: order.id, version: order.version, status: order.status },
    data: { version: { increment: 1 } } });
  if (updated.count !== 1) conflict('订单已变化，请刷新后重试');
}
async function recordEvent(tx: Tx, actor: CapabilityActor, purchase: { id: string; orderId: string },
  kind: string, commandId: string, requestHash: string, data: unknown) {
  await tx.purchaseCommitmentEvent.create({ data: { purchaseCommitmentId: purchase.id, kind,
    actorId: actor.id, commandId, eventNo: 1, requestHash, data: json(data) } });
  await enqueueBusinessEvent(tx, { eventType: `purchase_commitment.${kind.toLowerCase()}`,
    aggregateType: 'ORDER', aggregateId: purchase.orderId,
    data: { orderId: purchase.orderId, purchaseCommitmentId: purchase.id, kind, refresh: true },
    socket: { room: SocketRooms.ORDERS, event: SocketEvents.ORDER_STATUS_CHANGED, scope: { capability: 'order.read' } },
    createdById: actor.id });
}
async function replay(tx: Tx, actor: CapabilityActor, commandId: string, requestHash: string, kind: string, purchaseId?: string) {
  text(commandId, '命令标识', 200);
  const event = await tx.purchaseCommitmentEvent.findUnique({ where: { commandId_eventNo: { commandId, eventNo: 1 } } });
  if (!event) return null;
  if (event.requestHash !== requestHash || event.kind !== kind || event.actorId !== actor.id
    || (purchaseId && event.purchaseCommitmentId !== purchaseId)) throw new AppError('同一命令不能更换采购参数', 409, 'IDEMPOTENCY_KEY_REUSED');
  return { id: event.purchaseCommitmentId };
}

/** Caller owns a Serializable transaction. The shared SQL coverage guard also
 * validates inventory assignments, so neither side can over-cover the order. */
async function assertCoverage(tx: Tx, purchase: Purchase) {
  for (const line of purchase.lines) {
    const orderLine = await tx.orderLine.findUnique({ where: { id: line.orderLineId }, select: {
      quantity: true, allocationAssignments: { select: { id: true, assignedQuantity: true, releasedQuantity: true, consumedQuantity: true } },
      purchaseCommitmentLines: { where: { purchaseCommitment: { status: { in: ['PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED'] } } },
        select: { id: true, quantity: true, cancelledQuantity: true, receivedQuantity: true, directShippedQuantity: true } },
    } });
    if (!orderLine) conflict('销售来源行不存在');
    // Receipt provenance will replace this explicit non-purchase mapping when
    // the receipt adapter is introduced; no receipt command is exposed yet.
    deriveProcurementCoverage({ orderQuantity: orderLine.quantity,
      purchases: orderLine.purchaseCommitmentLines.some(row => row.id === line.id)
        ? orderLine.purchaseCommitmentLines : [...orderLine.purchaseCommitmentLines, line],
      assignments: orderLine.allocationAssignments.map(row => ({ ...row, purchaseLineId: null })) });
  }
}

export async function createPurchaseCommitment(args: { tx: Tx; actor: CapabilityActor; orderId: string;
  supplierId: string; lines: PurchaseLineInput[]; paymentTerms?: string | null; commandId: string }) {
  const { tx, actor } = args;
  const access = await assertPurchaseOrderScope(tx, actor, args.orderId, 'create');
  if (!access.canViewCost) throw new AppError('创建采购承诺需要成本权限', 403, 'AUTH_FORBIDDEN');
  const input = { orderId: args.orderId, supplierId: text(args.supplierId, '供应商', 200), lines: args.lines,
    paymentTerms: args.paymentTerms == null ? null : text(args.paymentTerms, '付款条款', 2000) };
  const requestHash = hash(input);
  const previous = await replay(tx, actor, args.commandId, requestHash, 'CREATE');
  if (previous) {
    const existing = await tx.purchaseCommitment.findUnique({ where: { id: previous.id }, select: { orderId: true } });
    if (!existing || existing.orderId !== access.order.id) conflict('原采购命令的销售来源不符');
    return previous;
  }
  openOrder(access.order.status);
  await assertSupplierActive(tx, input.supplierId);
  await claimOrder(tx, access.order);
  const id = randomUUID();
  const resolved = await resolvePurchaseLines({ tx, actor, orderId: access.order.id, supplierId: input.supplierId,
    purchaseCommitmentId: id, lines: input.lines });
  const totalCost = resolved.lines.reduce((total, line) => total.plus(line.lineTotal), new Prisma.Decimal(0));
  const snapshot = buildPurchaseApprovalSnapshot({ ...input, lines: resolved.lines, currency: 'USD', totalCost });
  const purchase = await tx.purchaseCommitment.create({ data: { id, commitmentNumber: `PC-${randomUUID().toUpperCase()}`,
    orderId: access.order.id, supplierId: input.supplierId, createdById: actor.id,
    currency: 'USD', totalCost, paymentTerms: input.paymentTerms,
    lines: { create: snapshot.lines.map(line => ({ ...line, promisedDate: new Date(line.promisedDate),
      fulfillmentMode: line.fulfillmentMode as 'STOCK_RECEIPT' | 'SUPPLIER_DIRECT',
      sourceSnapshot: json(line.sourceSnapshot), identitySnapshot: json(line.identitySnapshot) })) } }, include: purchaseReadInclude });
  await recordEvent(tx, actor, purchase, 'CREATE', args.commandId, requestHash, { version: purchase.version });
  return { id: purchase.id };
}

export type PurchaseCommand = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'CONFIRM' | 'CANCEL';
export async function transitionPurchaseCommitment(args: { tx: Tx; actor: CapabilityActor; purchaseCommitmentId: string;
  version: number; action: PurchaseCommand; reason: string; supplierReferenceNo?: string; evidenceIds?: string[]; commandId: string }) {
  const { tx, actor } = args;
  const purchase = await tx.purchaseCommitment.findUnique({ where: { id: args.purchaseCommitmentId }, include: purchaseReadInclude });
  if (!purchase) throw new AppError('采购承诺不存在', 404, 'RESOURCE_NOT_FOUND');
  if (!['SUBMIT', 'APPROVE', 'REJECT', 'CONFIRM', 'CANCEL'].includes(args.action)
    || !Number.isInteger(args.version) || args.version < 1) throw new AppError('采购命令或版本无效', 400, 'VALIDATION_ERROR');
  const capability: CapabilityAction = ['APPROVE', 'REJECT'].includes(args.action) ? 'approve' : 'transition';
  const access = await assertPurchaseOrderScope(tx, actor, purchase.orderId, capability);
  if (!access.canViewCost) throw new AppError('处理采购承诺需要成本权限', 403, 'AUTH_FORBIDDEN');
  const input = { purchaseCommitmentId: purchase.id, version: args.version, action: args.action,
    reason: text(args.reason, '操作依据'), supplierReferenceNo: args.supplierReferenceNo ?? null, evidenceIds: [...(args.evidenceIds ?? [])].sort() };
  const requestHash = hash(input);
  const previous = await replay(tx, actor, args.commandId, requestHash, args.action, purchase.id);
  if (previous) return previous;
  if (purchase.version !== args.version) conflict('采购承诺版本已变化，请刷新后重试');
  if (args.action !== 'CANCEL') openOrder(access.order.status);
  const allowed: Record<PurchaseCommand, string[]> = {
    SUBMIT: ['DRAFT'], APPROVE: ['PENDING_APPROVAL'], REJECT: ['PENDING_APPROVAL'],
    CONFIRM: ['APPROVED'], CANCEL: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'REJECTED'],
  };
  if (!allowed[args.action].includes(purchase.status)) conflict('当前采购承诺状态不允许此操作');
  if (args.action !== 'CONFIRM' && (args.supplierReferenceNo !== undefined || input.evidenceIds.length)) conflict('仅供应商确认操作可提交确认编号或附件');
  await claimOrder(tx, access.order);
  await lockPurchaseCoverageLines(tx, purchase.lines.map(line => line.orderLineId));
  const now = new Date();
  let data: Prisma.PurchaseCommitmentUncheckedUpdateManyInput = { version: { increment: 1 } };
  if (['SUBMIT', 'APPROVE', 'CONFIRM'].includes(args.action)) {
    await assertSupplierActive(tx, purchase.supplierId);
    await assertPurchaseSourcesCurrent({ tx, orderId: purchase.orderId, supplierId: purchase.supplierId,
      purchaseCommitmentId: purchase.id, lines: purchase.lines });
    await assertCoverage(tx, purchase);
  }
  if (args.action === 'SUBMIT') {
    const snapshot = buildPurchaseApprovalSnapshot(purchase);
    data = { ...data, status: 'PENDING_APPROVAL', submittedById: actor.id, submittedAt: now,
      approvalSnapshot: json(snapshot), approvalPolicyVersion: PURCHASE_APPROVAL_POLICY_VERSION,
      approvalLevel: requiredQuotationApprovalLevel(Number(snapshot.totalCost)) };
  } else if (args.action === 'APPROVE' || args.action === 'REJECT') {
    const decision = assertPurchaseApprovalActor({ actor, createdById: purchase.createdById, submittedById: purchase.submittedById, source: purchase });
    if (hash(purchase.approvalSnapshot) !== hash(decision.snapshot) || purchase.approvalLevel !== decision.level
      || purchase.approvalPolicyVersion !== decision.policyVersion) conflict('采购审批快照与当前承诺不符');
    data = { ...data, status: args.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      ...(args.action === 'APPROVE' ? { approvedById: actor.id, approvedAt: now } : {}) };
  } else if (args.action === 'CONFIRM') {
    if (!purchase.approvedById || !purchase.approvedAt || !purchase.submittedById
      || hash(purchase.approvalSnapshot) !== hash(buildPurchaseApprovalSnapshot(purchase))) conflict('采购承诺缺少有效审批事实');
    const evidence = await bindPurchaseEvidence(tx, actor, input.evidenceIds, purchase.id);
    data = { ...data, status: 'CONFIRMED', confirmedById: actor.id, confirmedAt: now,
      supplierReferenceNo: text(args.supplierReferenceNo!, '供应商确认编号', 200), confirmationEvidence: json(evidence) };
  } else {
    if (purchase.lines.some(line => line.receivedQuantity || line.directShippedQuantity)) conflict('已有收货或直发事实，需要取消剩余量流程，不能整单取消');
    data = { ...data, status: 'CANCELLED' };
  }
  const updated = await tx.purchaseCommitment.updateMany({ where: { id: purchase.id, version: args.version, status: purchase.status }, data });
  if (updated.count !== 1) conflict('采购承诺已被其他操作修改');
  if (args.action === 'CANCEL') {
    for (const line of purchase.lines) await tx.purchaseCommitmentLine.update({ where: { id: line.id },
      data: { cancelledQuantity: line.quantity, version: { increment: 1 } } });
  }
  await recordEvent(tx, actor, purchase, args.action, args.commandId, requestHash,
    { fromStatus: purchase.status, toStatus: data.status, version: args.version + 1, reason: input.reason });
  return { id: purchase.id };
}
