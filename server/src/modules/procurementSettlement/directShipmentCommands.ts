import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { CapabilityActor } from '../../lib/capabilityPolicy.js';
import { AppError } from '../../middleware/errorHandler.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { transitionOrderStatus } from '../../lib/transactionStateService.js';
import { readDirectDeliveryProjection } from '../../lib/directDeliveryProjection.js';
import { assertDirectShipmentOrderScope } from './directShipmentAccess.js';
import { bindDirectShipmentEvidence, validateDirectShipmentEvidence } from './directShipmentEvidence.js';
import { loadDirectShipmentFacts } from './directShipmentQuality.js';
import { deriveDirectShipmentQuantities, deriveMixedOrderDelivery, DirectShipmentQuantityError } from './directShipmentQuantities.js';
import { lockPurchaseCoverageLines } from './purchaseCoverage.js';
import { createDirectShipmentSchema, reviewDirectShipmentSchema, directShipmentActionSchema,
  directShipmentReceiptSchema } from './directShipmentInputs.js';
import type { z } from 'zod';

type Tx = Prisma.TransactionClient;
type Command = { tx: Tx; actor: CapabilityActor; commandId: string };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function conflict(message: string): never { throw new AppError(message, 409, 'RESOURCE_CONFLICT'); }
function stale(): never { throw new AppError('直发质量事实已变化，请取消本计划并重新提交审核', 409, 'QUALITY_REVIEW_STALE'); }
function independent(actor: CapabilityActor, people: Array<string | null>) {
  if (people.includes(actor.id)) throw new AppError('直发经办人不能审核自己的交付，审核人也不能执行该批发运', 403, 'SELF_APPROVAL_FORBIDDEN');
}

async function replay(tx: Tx, actor: CapabilityActor, commandId: string, requestHash: string, kind: string, shipmentId?: string) {
  if (!commandId || commandId.length > 200) throw new AppError('命令标识无效', 400, 'VALIDATION_ERROR');
  const event = await tx.supplierDirectShipmentEvent.findUnique({ where: { commandId_eventNo: { commandId, eventNo: 1 } } });
  if (!event) return null;
  if (event.actorId !== actor.id || event.requestHash !== requestHash || event.kind !== kind
    || (shipmentId && event.shipmentId !== shipmentId)) {
    throw new AppError('同一命令不能更换直发参数', 409, 'IDEMPOTENCY_KEY_REUSED');
  }
  return { id: event.shipmentId };
}
async function record(tx: Tx, actor: CapabilityActor, head: { id: string; orderId: string },
  commandId: string, requestHash: string, kind: string, quantity: number, data: unknown, shipmentLineId?: string) {
  await tx.supplierDirectShipmentEvent.create({ data: { shipmentId: head.id, shipmentLineId,
    actorId: actor.id, commandId, eventNo: 1, requestHash, kind, quantity, data: json(data) } });
  await enqueueBusinessEvent(tx, { aggregateType: 'ORDER', aggregateId: head.orderId,
    eventType: `supplier_direct_shipment.${kind.toLowerCase()}`,
    data: { orderId: head.orderId, shipmentId: head.id, kind, refresh: true },
    socket: { room: SocketRooms.ORDERS, event: SocketEvents.ORDER_STATUS_CHANGED, scope: { capability: 'order.read' } },
    createdById: actor.id });
}
const headInclude = { purchaseCommitment: { include: { lines: true } }, lines: { orderBy: { lineNo: 'asc' as const } } } as const;
async function loadHead(tx: Tx, shipmentId: string) {
  const head = await tx.supplierDirectShipment.findUnique({ where: { id: shipmentId }, include: headInclude });
  if (!head) throw new AppError('供应商直发记录不存在', 404, 'RESOURCE_NOT_FOUND');
  return head;
}
async function loadLine(tx: Tx, lineId: string) {
  const line = await tx.supplierDirectShipmentLine.findUnique({ where: { id: lineId } });
  if (!line) throw new AppError('供应商直发行不存在', 404, 'RESOURCE_NOT_FOUND');
  return { line, head: await loadHead(tx, line.shipmentId) };
}
async function claim(tx: Tx, actor: CapabilityActor,
  purchase: { id: string; orderId: string; version: number; status: string; lines: Array<{ orderLineId: string }> },
  action: 'manage' | 'review', phase: 'plan' | 'receive' | 'cancel' = 'plan') {
  const { order } = await assertDirectShipmentOrderScope(tx, actor, purchase.orderId, action);
  if (purchase.status !== 'CONFIRMED') conflict('直发仅可基于已确认的采购承诺');
  const statuses = phase === 'receive' ? ['SO_CREATED', 'PO_CREATED', 'SHIPPED', 'IN_TRANSIT', 'CUSTOMS', 'INSPECTION'] : ['SO_CREATED', 'PO_CREATED'];
  // A rejected plan may be superseded and the order fulfilled before the old
  // PREPARED head is cancelled. Closing that unused plan must remain possible.
  if (phase !== 'cancel' && !statuses.includes(order.status)) conflict('当前订单状态不能执行此直发命令');
  const changedOrder = await tx.order.updateMany({ where: { id: order.id, version: order.version, status: order.status },
    data: { version: { increment: 1 } } });
  if (changedOrder.count !== 1) conflict('订单已变化，请刷新');
  const changedPurchase = await tx.purchaseCommitment.updateMany({ where: { id: purchase.id, version: purchase.version, status: purchase.status },
    data: { version: { increment: 1 } } });
  if (changedPurchase.count !== 1) conflict('采购承诺已变化，请刷新');
  await lockPurchaseCoverageLines(tx, purchase.lines.map(line => line.orderLineId));
}
async function quantities(tx: Tx, purchaseId: string) {
  const purchaseLines = await tx.purchaseCommitmentLine.findMany({ where: { purchaseCommitmentId: purchaseId } });
  const shipments = await tx.supplierDirectShipment.findMany({ where: { purchaseCommitmentId: purchaseId }, include: { lines: true } });
  try {
    return deriveDirectShipmentQuantities({ purchaseLines, shipments });
  } catch (error) {
    if (error instanceof DirectShipmentQuantityError) throw new AppError(error.message, 409, 'ALLOCATION_INCONSISTENT');
    throw error;
  }
}
async function updateHeadVersion(tx: Tx, head: { id: string; version: number }, data: Prisma.SupplierDirectShipmentUncheckedUpdateManyInput = {}) {
  const changed = await tx.supplierDirectShipment.updateMany({ where: { id: head.id, version: head.version }, data: { ...data, version: { increment: 1 } } });
  if (changed.count !== 1) conflict('直发计划已变化，请刷新');
}

/** Commands must run inside an owned Serializable transaction and force
 * deferred constraints before returning an idempotent result. */
export async function createDirectShipment(args: Command & z.input<typeof createDirectShipmentSchema>) {
  const { tx, actor, commandId, ...body } = args;
  const input = createDirectShipmentSchema.parse(body);
  const purchase = await tx.purchaseCommitment.findUnique({ where: { id: input.purchaseCommitmentId }, include: { lines: true } });
  if (!purchase) throw new AppError('采购承诺不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertDirectShipmentOrderScope(tx, actor, purchase.orderId, 'manage');
  const requestHash = hash(input);
  const previous = await replay(tx, actor, commandId, requestHash, 'CREATE');
  if (previous) return previous;
  if (purchase.version !== input.purchaseVersion) conflict('采购承诺版本已变化');
  await claim(tx, actor, purchase, 'manage');
  const id = randomUUID();
  const lines: Prisma.SupplierDirectShipmentLineUncheckedCreateWithoutShipmentInput[] = [];
  for (const [index, row] of input.lines.entries()) {
    const facts = await loadDirectShipmentFacts(tx, row.purchaseCommitmentLineId, row.physical);
    if (facts.line.purchaseCommitmentId !== purchase.id || facts.line.fulfillmentMode !== 'SUPPLIER_DIRECT') conflict('直发行必须属于当前采购承诺的供应商直发来源');
    const physical = facts.physical;
    lines.push({ id: randomUUID(), lineNo: index + 1, purchaseCommitmentLineId: facts.line.id,
      quantity: physical.quantity, physicalSnapshot: json(physical),
      serialClaimKey: physical.trackingType === 'SERIAL' ? `${[...physical.partNumber].length}:${physical.partNumber}${physical.serialNumber}` : null });
  }
  const total = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (total > 2147483647) conflict('本次直发总量超过可记录范围');
  const files = await tx.storedObject.findMany({ where: { id: { in: input.evidenceIds } }, orderBy: { id: 'asc' },
    select: { id: true, version: true, status: true, sha256: true } });
  const expected = files.map(file => ({ ...file, version: file.version + 1 }));
  await tx.supplierDirectShipment.create({ data: { id, shipmentNumber: `DS-${randomUUID().toUpperCase()}`,
    purchaseCommitmentId: purchase.id, orderId: purchase.orderId, carrier: input.carrier, trackingNumber: input.trackingNumber,
    origin: input.origin, destination: input.destination, reason: input.reason, evidence: json(expected),
    commandId, requestHash, createdById: actor.id, lines: { create: lines } } });
  const evidence = await bindDirectShipmentEvidence(tx, actor, id, input.evidenceIds, 'manage');
  if (hash(expected) !== hash(evidence)) conflict('直发附件绑定版本已变化');
  await quantities(tx, purchase.id);
  await record(tx, actor, { id, orderId: purchase.orderId }, commandId, requestHash, 'CREATE', 0, { plannedQuantity: total, evidence, reason: input.reason });
  return { id };
}

async function reviewContext(tx: Tx, actor: CapabilityActor, lineId: string) {
  const { line, head } = await loadLine(tx, lineId);
  await assertDirectShipmentOrderScope(tx, actor, head.orderId, 'review');
  const facts = await loadDirectShipmentFacts(tx, line.purchaseCommitmentLineId, line.physicalSnapshot);
  const evidence = await validateDirectShipmentEvidence(tx, actor, head.id, head.evidence);
  if (!evidence.length) conflict('直发缺少有效的供应商交付证据');
  const snapshot = { quality: facts.review.approvalSnapshot, evidence };
  return { line, head, facts, snapshot, snapshotHash: hash(snapshot) };
}
export async function getDirectShipmentReviewContext(args: { tx: Tx; actor: CapabilityActor; shipmentLineId: string }) {
  const c = await reviewContext(args.tx, args.actor, args.shipmentLineId);
  const purchase = c.head.purchaseCommitment;
  return { shipmentLineId: c.line.id, shipmentId: c.head.id, version: c.line.version, reviewStatus: c.line.reviewStatus,
    snapshot: c.snapshot, snapshotHash: c.snapshotHash, issues: c.facts.review.issues,
    canApprove: c.head.status === 'PREPARED' && c.line.reviewStatus === 'PENDING_REVIEW' && c.facts.review.canAccept
      && ![c.head.createdById, purchase.createdById, purchase.submittedById, purchase.confirmedById].includes(args.actor.id) };
}
export async function reviewDirectShipment(args: Command & z.input<typeof reviewDirectShipmentSchema> & { shipmentLineId: string }) {
  const { tx, actor, commandId, shipmentLineId, ...body } = args;
  const input = reviewDirectShipmentSchema.parse(body);
  const { line, head } = await loadLine(tx, shipmentLineId);
  await assertDirectShipmentOrderScope(tx, actor, head.orderId, 'review');
  const kind = input.decision === 'APPROVED' ? 'APPROVE' : 'REJECT';
  const requestHash = hash({ shipmentLineId, ...input });
  const previous = await replay(tx, actor, commandId, requestHash, kind, head.id);
  if (previous) return previous;
  if (head.status !== 'PREPARED' || line.reviewStatus !== 'PENDING_REVIEW' || line.version !== input.version) conflict('直发行已处理或版本已变化');
  const purchase = head.purchaseCommitment;
  independent(actor, [head.createdById, purchase.createdById, purchase.submittedById, purchase.confirmedById]);
  await claim(tx, actor, purchase, 'review');
  const c = await reviewContext(tx, actor, line.id);
  if (c.snapshotHash !== input.snapshotHash) stale();
  if (input.decision === 'APPROVED') {
    if (!Object.values(input.checks).every(value => value === true)) conflict('批准直发必须完成全部质量检查');
    await loadDirectShipmentFacts(tx, line.purchaseCommitmentLineId, line.physicalSnapshot, 'APPROVE');
  }
  const evidence = await bindDirectShipmentEvidence(tx, actor, head.id, input.evidenceIds, 'review');
  const changed = await tx.supplierDirectShipmentLine.updateMany({ where: { id: line.id, version: input.version, reviewStatus: 'PENDING_REVIEW' },
    data: { reviewStatus: input.decision, reviewedById: actor.id, reviewedAt: new Date(), reviewReason: input.reason,
      checks: json(input.checks), reviewSnapshot: json(c.snapshot), reviewSnapshotHash: c.snapshotHash, reviewEvidence: json(evidence),
      ...(input.decision === 'REJECTED' ? { serialClaimKey: null } : {}), version: { increment: 1 } } });
  if (changed.count !== 1) conflict('直发行已由其他操作处理');
  await updateHeadVersion(tx, head);
  await quantities(tx, purchase.id);
  await record(tx, actor, head, commandId, requestHash, kind, 0, { reviewedQuantity: line.quantity, reason: input.reason, evidence }, line.id);
  return { id: head.id };
}

async function syncOrder(tx: Tx, actor: CapabilityActor, orderId: string, reason: string) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
  const direct = await readDirectDeliveryProjection(tx, order.lines.map(line => line.id));
  const local = await tx.shipmentLine.findMany({ where: { orderLineId: { in: order.lines.map(line => line.id) } },
    select: { orderLineId: true, receivedQuantity: true } });
  const progress = deriveMixedOrderDelivery(order.lines.map(line => ({ id: line.id, quantity: line.quantity,
    localOutbound: line.outboundQuantity, directShipped: direct.get(line.id)?.dispatched ?? 0,
    localReceived: local.filter(row => row.orderLineId === line.id).reduce((sum, row) => sum + row.receivedQuantity, 0),
    directReceived: direct.get(line.id)?.received ?? 0 })));
  for (const row of progress.lines) {
    const old = order.lines.find(line => line.id === row.orderLineId)!;
    if (old.directShippedQuantity === row.directShipped) continue;
    const changed = await tx.orderLine.updateMany({ where: { id: old.id, directShippedQuantity: old.directShippedQuantity, outboundQuantity: old.outboundQuantity },
      data: { directShippedQuantity: row.directShipped } });
    if (changed.count !== 1) conflict('订单行交付事实已变化');
  }
  const changed = await tx.order.updateMany({ where: { id: order.id, version: order.version },
    data: { directShippedQuantity: progress.totals.directShipped, version: { increment: 1 } } });
  if (changed.count !== 1) conflict('订单交付事实已变化');
  if (progress.totals.fullyReceived && ['SHIPPED', 'IN_TRANSIT', 'CUSTOMS', 'INSPECTION'].includes(order.status)) {
    await transitionOrderStatus(tx, { id: order.id, currentVersion: order.version + 1, currentStatus: order.status,
      nextStatus: 'DELIVERED', actorId: actor.id, reasonCode: 'ALL_DELIVERY_RECEIPTS_COMPLETED', reason });
  } else if (progress.totals.fullyDispatched && ['SO_CREATED', 'PO_CREATED'].includes(order.status)) {
    await transitionOrderStatus(tx, { id: order.id, currentVersion: order.version + 1, currentStatus: order.status,
      nextStatus: 'SHIPPED', actorId: actor.id, reasonCode: 'ALL_DELIVERY_SOURCES_DISPATCHED', reason });
  }
}

export async function dispatchDirectShipment(args: Command & z.input<typeof directShipmentActionSchema> & { shipmentId: string }) {
  const { tx, actor, commandId, shipmentId, ...body } = args;
  const input = directShipmentActionSchema.parse(body);
  const head = await loadHead(tx, shipmentId);
  await assertDirectShipmentOrderScope(tx, actor, head.orderId, 'manage');
  const requestHash = hash({ shipmentId, ...input });
  const previous = await replay(tx, actor, commandId, requestHash, 'DISPATCH', head.id);
  if (previous) return previous;
  if (head.status !== 'PREPARED' || head.version !== input.version || !head.lines.length) conflict('直发计划已变化或不能发运');
  if (head.lines.some(line => line.reviewStatus !== 'APPROVED')) conflict('全部直发行须先通过独立质量审核');
  independent(actor, head.lines.map(line => line.reviewedById));
  await claim(tx, actor, head.purchaseCommitment, 'manage');
  const evidence = await validateDirectShipmentEvidence(tx, actor, head.id, head.evidence);
  if (!evidence.length) conflict('直发缺少有效交付证据');
  for (const line of head.lines) {
    const facts = await loadDirectShipmentFacts(tx, line.purchaseCommitmentLineId, line.physicalSnapshot, 'DISPATCH');
    if (!line.reviewSnapshotHash || hash(line.reviewSnapshot) !== line.reviewSnapshotHash
      || hash({ quality: facts.review.approvalSnapshot, evidence }) !== line.reviewSnapshotHash) stale();
    await validateDirectShipmentEvidence(tx, actor, head.id, line.reviewEvidence);
  }
  await quantities(tx, head.purchaseCommitmentId);
  await updateHeadVersion(tx, head, { status: 'DISPATCHED', dispatchedById: actor.id, dispatchedAt: new Date() });
  for (const line of head.lines) await tx.purchaseCommitmentLine.update({ where: { id: line.purchaseCommitmentLineId },
    data: { directShippedQuantity: { increment: line.quantity }, version: { increment: 1 } } });
  await quantities(tx, head.purchaseCommitmentId);
  await syncOrder(tx, actor, head.orderId, input.reason);
  await record(tx, actor, head, commandId, requestHash, 'DISPATCH', 0, {
    dispatchedQuantity: head.lines.reduce((sum, line) => sum + line.quantity, 0), reason: input.reason, evidence });
  return { id: head.id };
}

export async function cancelDirectShipment(args: Command & z.input<typeof directShipmentActionSchema> & { shipmentId: string }) {
  const { tx, actor, commandId, shipmentId, ...body } = args;
  const input = directShipmentActionSchema.parse(body);
  const head = await loadHead(tx, shipmentId);
  await assertDirectShipmentOrderScope(tx, actor, head.orderId, 'manage');
  const requestHash = hash({ shipmentId, ...input });
  const previous = await replay(tx, actor, commandId, requestHash, 'CANCEL', head.id);
  if (previous) return previous;
  if (head.status !== 'PREPARED' || head.version !== input.version) conflict('仅可取消尚未发运且版本未变化的直发计划');
  await claim(tx, actor, head.purchaseCommitment, 'manage', 'cancel');
  // The immediate line guard only permits claim release after the head is cancelled.
  // Deferred integrity checks still require both changes and the event in this transaction.
  await updateHeadVersion(tx, head, { status: 'CANCELLED', cancelledById: actor.id, cancelledAt: new Date(), cancellationReason: input.reason });
  await tx.supplierDirectShipmentLine.updateMany({ where: { shipmentId: head.id, serialClaimKey: { not: null } },
    data: { serialClaimKey: null, version: { increment: 1 } } });
  await quantities(tx, head.purchaseCommitmentId);
  await record(tx, actor, head, commandId, requestHash, 'CANCEL', 0, { reason: input.reason });
  return { id: head.id };
}

export async function receiveDirectShipment(args: Command & z.input<typeof directShipmentReceiptSchema> & { shipmentLineId: string }) {
  const { tx, actor, commandId, shipmentLineId, ...body } = args;
  const input = directShipmentReceiptSchema.parse(body);
  const { line, head } = await loadLine(tx, shipmentLineId);
  await assertDirectShipmentOrderScope(tx, actor, head.orderId, 'manage');
  const requestHash = hash({ shipmentLineId, ...input });
  const previous = await replay(tx, actor, commandId, requestHash, 'RECEIPT', head.id);
  if (previous) return previous;
  if (!['DISPATCHED', 'PARTIALLY_RECEIVED'].includes(head.status) || line.version !== input.version
    || input.quantity > line.quantity - line.receivedQuantity) conflict('直发签收量超出余量或版本已变化');
  if (new Date(input.signedAt).getTime() > Date.now()) conflict('签收时间不能在未来');
  await claim(tx, actor, head.purchaseCommitment, 'manage', 'receive');
  const evidence = await bindDirectShipmentEvidence(tx, actor, head.id, input.evidenceIds, 'manage');
  const changed = await tx.supplierDirectShipmentLine.updateMany({ where: { id: line.id, version: input.version, receivedQuantity: line.receivedQuantity },
    data: { receivedQuantity: { increment: input.quantity }, version: { increment: 1 } } });
  if (changed.count !== 1) conflict('直发签收记录已变化');
  const complete = head.lines.every(row => row.receivedQuantity + (row.id === line.id ? input.quantity : 0) === row.quantity);
  await updateHeadVersion(tx, head, { status: complete ? 'DELIVERED' : 'PARTIALLY_RECEIVED' });
  await quantities(tx, head.purchaseCommitmentId);
  await syncOrder(tx, actor, head.orderId, input.reason);
  await record(tx, actor, head, commandId, requestHash, 'RECEIPT', input.quantity,
    { reason: input.reason, evidence, signedBy: input.signedBy, signedAt: input.signedAt }, line.id);
  return { id: head.id };
}
