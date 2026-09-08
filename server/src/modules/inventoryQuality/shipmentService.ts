import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AppError, type ErrorCode } from '../../middleware/errorHandler.js';
import { hasCapability, type CapabilityActor } from '../../lib/capabilityPolicy.js';
import { StateTransitionConflictError, transitionOrderStatus } from '../../lib/transactionStateService.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { calculateShippableQuantities, deriveOrderDeliveryProgress } from './shipmentQuantities.js';
import { bindShipmentEvidence } from './shipmentEvidence.js';

type Tx = Prisma.TransactionClient;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function fail(message: string, code: ErrorCode = 'SHIPMENT_BLOCKED'): never { throw new AppError(message, 409, code); }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const positive = (value: number) => {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) fail('数量必须为有效正整数', 'VALIDATION_ERROR');
};
function text(value: string, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) fail(`${label}不能为空或超过长度限制`, 'VALIDATION_ERROR');
  return value.trim();
}

export async function assertShipmentOrderAccess(tx: Tx, actor: CapabilityActor, orderId: string, manage = false) {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: {
    id: true, status: true, version: true, lineItemsMode: true, quantity: true, outboundQuantity: true,
    quotation: { select: { createdBy: true, creator: { select: { department: true } } } },
    lines: { select: { id: true, quantity: true, outboundQuantity: true }, orderBy: { lineNo: 'asc' } },
  } });
  if (!order) throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
  const scope = { ownerId: order.quotation.createdBy, department: order.quotation.creator.department };
  if (!hasCapability(actor, 'order', 'read', scope) || (manage && !hasCapability(actor, 'inventory', 'manage'))) {
    throw new AppError('无权处理此订单的发运', 403, 'AUTH_FORBIDDEN');
  }
  if (!order.lineItemsMode || !order.lines.length) fail('旧订单不能自动映射为现代发运事实');
  return order;
}

const detailSelect = {
  id: true, inventoryItemId: true, serialNumber: true, batchNumber: true, conditionCode: true,
  warehouse: true, location: true, certificateType: true, certificateNumber: true, certificateFileUrl: true,
  lifeLimited: true, remainingHours: true, remainingCycles: true, shelfLifeDate: true, shelfLifeDays: true,
  nextOverhaulDue: true, storageCondition: true, type: true,
  inventoryItem: { select: { partNumber: true, trackingType: true } },
} as const satisfies Prisma.InventoryDetailSelect;
const sourceInclude = {
  inventoryDetail: { select: detailSelect },
  assignment: { select: { id: true, orderLineId: true, allocationId: true, orderLine: { select: { orderId: true } } } },
  fulfillmentReview: true,
} as const satisfies Prisma.InventoryTransactionInclude;
type Source = Prisma.InventoryTransactionGetPayload<{ include: typeof sourceInclude }>;
function identity(detail: Source['inventoryDetail']) {
  return { inventoryDetailId: detail.id, inventoryItemId: detail.inventoryItemId,
    partNumber: detail.inventoryItem.partNumber, trackingType: detail.inventoryItem.trackingType,
    serialNumber: detail.serialNumber, batchNumber: detail.batchNumber, conditionCode: detail.conditionCode,
    warehouse: detail.warehouse, location: detail.location };
}

type Evidence = { id: string; version: number; sha256: string; status: string };
async function storedEvidence(tx: Tx, ids: string[]): Promise<Evidence[]> {
  if (new Set(ids).size !== ids.length) fail('附件标识重复', 'QUALITY_EVIDENCE_INVALID');
  if (!ids.length) return [];
  const rows = await tx.storedObject.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' },
    select: { id: true, version: true, sha256: true, status: true } });
  if (rows.length !== ids.length || rows.some(row => row.status !== 'AVAILABLE' || row.version < 1 || !/^[a-f\d]{64}$/i.test(row.sha256))) {
    fail('交付证据缺失、失效或指纹无效', 'QUALITY_EVIDENCE_INVALID');
  }
  return rows;
}
function parseEvidence(value: unknown): Evidence[] {
  if (!Array.isArray(value)) fail('原出库质量证据无效', 'QUALITY_EVIDENCE_INVALID');
  return value.map(item => {
    const evidence = record(item);
    if (typeof evidence.id !== 'string' || typeof evidence.version !== 'number' || typeof evidence.sha256 !== 'string' || typeof evidence.status !== 'string') {
      fail('原出库质量证据无效', 'QUALITY_EVIDENCE_INVALID');
    }
    return evidence as unknown as Evidence;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Require the exact review consumed by this ledger row; never infer it by date or quantity. */
async function validateSource(tx: Tx, source: Source, orderId: string) {
  const { assignment, fulfillmentReview: review, inventoryDetail: detail } = source;
  if (source.type !== 'OUTBOUND' || source.quantity >= 0 || source.orderId !== orderId || !assignment
    || assignment.orderLine.orderId !== orderId || source.allocationId !== assignment.allocationId
    || !review || !review.approved || !review.consumedAt || review.assignmentId !== assignment.id
    || review.orderId !== orderId || review.inventoryDetailId !== detail.id || review.quantity !== -source.quantity) {
    fail('出库流水缺少可验证的订单分配或实际质量复核来源');
  }
  const snapshot = record(review.snapshot);
  const inventory = record(snapshot.inventory);
  if (inventory.id !== detail.id || inventory.partNumber !== detail.inventoryItem.partNumber
    || inventory.trackingType !== detail.inventoryItem.trackingType) fail('出库后实物身份已变化');
  for (const key of ['serialNumber', 'batchNumber', 'conditionCode', 'certificateType', 'certificateNumber',
    'certificateFileUrl', 'lifeLimited', 'remainingHours', 'remainingCycles', 'shelfLifeDays', 'storageCondition', 'type'] as const) {
    if ((inventory[key] ?? null) !== (detail[key] ?? null)) fail('出库后质量资料已变化，不能沿用原复核发运', 'QUALITY_REVIEW_STALE');
  }
  for (const key of ['shelfLifeDate', 'nextOverhaulDue'] as const) {
    if ((inventory[key] ?? null) !== (detail[key]?.toISOString() ?? null)
      || (detail[key] && detail[key].getTime() <= Date.now())) fail('实物有效期或质量资料已变化', 'QUALITY_REVIEW_STALE');
  }
  if (detail.lifeLimited && ((detail.remainingHours == null && detail.remainingCycles == null)
    || (detail.remainingHours != null && detail.remainingHours <= 0) || (detail.remainingCycles != null && detail.remainingCycles <= 0))) fail('寿命件剩余寿命不足');
  const evidence = parseEvidence(review.evidence);
  const current = await storedEvidence(tx, evidence.map(item => item.id));
  if (hash(current) !== hash(evidence)) fail('原质量附件已变化，不能用于发运', 'QUALITY_REVIEW_STALE');
  const certificates = Array.isArray(snapshot.certificates) ? snapshot.certificates.map(record) : [];
  const rows = certificates.length ? await tx.certificate.findMany({ where: { id: { in: certificates.map(item => String(item.id)) } }, select: {
      id: true, certificateNumber: true, partNumber: true, serialNumber: true, batchNumber: true,
      certificateType: true, status: true, expiryDate: true, fileUrl: true, fileHash: true, updatedAt: true,
    } }) : [];
  if (certificates.length) {
    for (const expected of certificates) {
      const actual = rows.find(row => row.id === expected.id);
      if (!actual || hash(json(actual)) !== hash(expected)) fail('原出库证书资料已变化', 'QUALITY_EVIDENCE_INVALID');
    }
  }
  const order = record(snapshot.order);
  const demand = record(snapshot.rfqLine);
  const normalize = (value: unknown) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const declaredType = detail.certificateType && normalize(detail.certificateType) !== 'NONE' ? detail.certificateType : null;
  if (order.certificateRequired || order.inspectionRequired || demand.certificateRequired || declaredType || detail.certificateNumber) {
    const required = [order.certificateRequired ? order.certificateType : null, demand.certificateRequired ? demand.certificateType : null, declaredType].filter(Boolean);
    const usable = rows.some(row => row.partNumber === detail.inventoryItem.partNumber
      && (row.serialNumber || null) === (detail.serialNumber || null) && (row.batchNumber || null) === (detail.batchNumber || null)
      && !['REVOKED', 'EXPIRED', 'VOID', 'REJECTED'].includes(row.status.toUpperCase())
      && (!row.expiryDate || row.expiryDate.getTime() > Date.now())
      && required.every(type => normalize(type) === normalize(row.certificateType)));
    if (!usable || !evidence.length) fail('交付缺少与实物匹配且有效的证书及附件', 'QUALITY_EVIDENCE_REQUIRED');
  }
  return { outboundTransactionId: source.id, reviewId: review.id, snapshotHash: review.snapshotHash, evidence, certificates };
}

const shipmentInclude = { lines: { orderBy: { lineNo: 'asc' as const }, include: { returnHolds: true } } } satisfies Prisma.ShipmentInclude;
function publicHold(hold: Prisma.ReturnHoldGetPayload<Record<string, never>>) {
  return { id: hold.id, shipmentLineId: hold.shipmentLineId, inventoryDetailId: hold.inventoryDetailId,
    quantity: hold.quantity, status: hold.status, version: hold.version, snapshotHash: hold.snapshotHash,
    receivedById: hold.receivedById, receivedAt: hold.receivedAt, releasedById: hold.releasedById,
    releasedAt: hold.releasedAt, identitySnapshot: hold.identitySnapshot, evidence: hold.evidence };
}
function publicShipment(shipment: Prisma.ShipmentGetPayload<{ include: typeof shipmentInclude }>) {
  return { id: shipment.id, shipmentNumber: shipment.shipmentNumber, carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber, origin: shipment.origin, destination: shipment.destination,
    status: shipment.status, version: shipment.version, shippedAt: shipment.shippedAt, evidence: shipment.evidence,
    lines: shipment.lines.map(line => ({ id: line.id, lineNo: line.lineNo, orderLineId: line.orderLineId,
      assignmentId: line.assignmentId, outboundTransactionId: line.outboundTransactionId, quantity: line.quantity,
      receivedQuantity: line.receivedQuantity, returnedQuantity: line.returnedQuantity, version: line.version,
      identitySnapshot: line.identitySnapshot, returns: line.returnHolds.map(publicHold) })) };
}

export async function getOrderShipments(args: { tx: Tx; actor: CapabilityActor; orderId: string }) {
  const order = await assertShipmentOrderAccess(args.tx, args.actor, args.orderId);
  const [sources, shipments] = await Promise.all([
    args.tx.inventoryTransaction.findMany({ where: { orderId: order.id, type: 'OUTBOUND' }, include: sourceInclude, orderBy: { id: 'asc' } }),
    args.tx.shipment.findMany({ where: { orderId: order.id }, include: shipmentInclude, orderBy: { shippedAt: 'asc' } }),
  ]);
  const boundLines = shipments.flatMap(shipment => shipment.lines);
  const balances = calculateShippableQuantities(sources.map(row => ({ id: row.id, quantity: -row.quantity })),
    boundLines.map(line => ({ id: line.id, outboundTransactionId: line.outboundTransactionId, quantity: line.quantity })));
  const delivery = deriveOrderDeliveryProgress(order.lines.map(line => ({ orderLineId: line.id, quantity: line.quantity,
    receivedQuantity: boundLines.filter(shipmentLine => shipmentLine.orderLineId === line.id).reduce((sum, row) => sum + row.receivedQuantity, 0) })));
  return { order: { id: order.id, status: order.status, version: order.version },
    outboundTransactions: sources.map(source => {
      const balance = balances.byOutboundTransaction.find(row => row.outboundTransactionId === source.id)!;
      return { id: source.id, orderLineId: source.assignment?.orderLineId ?? null, assignmentId: source.assignmentId,
        ...identity(source.inventoryDetail), quantity: -source.quantity,
        boundQuantity: balance.boundShipmentQuantity,
        availableQuantity: source.fulfillmentReviewId && source.assignmentId ? balance.shippableQuantity : 0,
        requiresHistoricalReview: !source.fulfillmentReviewId || !source.assignmentId };
    }), shipments: shipments.map(publicShipment), delivery };
}

async function refreshEvent(tx: Tx, actor: CapabilityActor, orderId: string, shipmentId: string, kind: string) {
  await enqueueBusinessEvent(tx, { eventType: `shipment.${kind.toLowerCase()}`, aggregateType: 'ORDER', aggregateId: orderId,
    data: { orderId, shipmentId, kind, refresh: true },
    socket: { room: SocketRooms.ORDERS, event: SocketEvents.ORDER_STATUS_CHANGED, scope: { capability: 'order.read' } }, createdById: actor.id });
}
async function claimOrder(tx: Tx, order: { id: string; version: number; status: string }) {
  const updated = await tx.order.updateMany({ where: { id: order.id, version: order.version, status: order.status }, data: { version: { increment: 1 } } });
  if (updated.count !== 1) throw new StateTransitionConflictError();
}

export async function createShipment(args: { tx: Tx; actor: CapabilityActor; orderId: string; carrier: string;
  trackingNumber: string; origin: string; destination: string; lines: Array<{ outboundTransactionId: string; quantity: number }>;
  evidenceIds: string[]; commandId: string }) {
  const { tx, actor } = args;
  const order = await assertShipmentOrderAccess(tx, actor, args.orderId, true);
  const input = { orderId: order.id, carrier: text(args.carrier, '承运人'), trackingNumber: text(args.trackingNumber, '运单号'),
    origin: text(args.origin, '始发地'), destination: text(args.destination, '目的地'),
    lines: [...args.lines].sort((a, b) => a.outboundTransactionId.localeCompare(b.outboundTransactionId)), evidenceIds: [...args.evidenceIds].sort() };
  if (!input.lines.length || input.lines.length > 100 || new Set(input.lines.map(line => line.outboundTransactionId)).size !== input.lines.length) fail('请选择不重复的实际出库来源', 'VALIDATION_ERROR');
  input.lines.forEach(line => positive(line.quantity));
  positive(input.lines.reduce((sum, line) => sum + line.quantity, 0));
  const requestHash = hash(input);
  const existing = await tx.shipment.findUnique({ where: { commandId: args.commandId }, include: shipmentInclude });
  if (existing) {
    if (existing.requestHash !== requestHash || existing.orderId !== order.id) fail('同一命令不能更换发运参数', 'IDEMPOTENCY_KEY_REUSED');
    return publicShipment(existing);
  }
  if (['CANCELLED', 'COMPLETED', 'DELIVERED'].includes(order.status.toUpperCase())) fail('当前订单状态不能创建发运');
  await claimOrder(tx, order);
  const sources = await tx.inventoryTransaction.findMany({ where: { id: { in: input.lines.map(line => line.outboundTransactionId) } }, include: sourceInclude });
  if (sources.length !== input.lines.length) fail('出库来源不存在');
  const qualityReviews = [];
  for (const source of sources) qualityReviews.push(await validateSource(tx, source, order.id));
  const bound = await tx.shipmentLine.findMany({ where: { outboundTransactionId: { in: sources.map(source => source.id) } }, select: { id: true, outboundTransactionId: true, quantity: true } });
  calculateShippableQuantities(sources.map(source => ({ id: source.id, quantity: -source.quantity })),
    [...bound, ...input.lines.map((line, index) => ({ ...line, id: `new:${index}` }))]);
  const attachments = await storedEvidence(tx, input.evidenceIds);
  if (attachments.length) {
    const linked = await tx.storedObject.findMany({ where: { id: { in: input.evidenceIds }, resourceId: order.id, domain: { in: ['order', 'orders'] } }, select: { id: true } });
    const allowed = new Set([...linked.map(row => row.id), ...qualityReviews.flatMap(review => review.evidence.map(row => row.id))]);
    if (attachments.some(row => !allowed.has(row.id))) fail('交付附件未关联本订单或所选出库复核', 'QUALITY_EVIDENCE_INVALID');
  }
  const shipment = await tx.shipment.create({ data: { orderId: order.id, shipmentNumber: `SHP-${randomUUID().toUpperCase()}`,
    carrier: input.carrier, trackingNumber: input.trackingNumber, origin: input.origin, destination: input.destination,
    evidence: json({ qualityReviews, attachments }), commandId: args.commandId, requestHash, createdById: actor.id,
    lines: { create: input.lines.map((line, index) => {
      const source = sources.find(row => row.id === line.outboundTransactionId)!;
      return { lineNo: index + 1, orderLineId: source.assignment!.orderLineId, assignmentId: source.assignmentId!,
        outboundTransactionId: source.id, quantity: line.quantity, identitySnapshot: json(identity(source.inventoryDetail)) };
    }) },
  }, include: shipmentInclude });
  await tx.shipmentEvent.create({ data: { shipmentId: shipment.id, kind: 'DISPATCH', quantity: input.lines.reduce((sum, line) => sum + line.quantity, 0),
    commandId: args.commandId, eventNo: 1, actorId: actor.id, evidence: json({ requestHash }), reason: '按实际出库流水创建发运' } });
  await refreshEvent(tx, actor, order.id, shipment.id, 'DISPATCH');
  return publicShipment(shipment);
}

export async function receiveShipment(args: { tx: Tx; actor: CapabilityActor; shipmentId: string;
  lines: Array<{ shipmentLineId: string; quantity: number }>; evidenceIds: string[]; reason: string; commandId: string }) {
  const { tx, actor } = args;
  const shipment = await tx.shipment.findUnique({ where: { id: args.shipmentId }, include: shipmentInclude });
  if (!shipment) throw new AppError('发运不存在', 404, 'RESOURCE_NOT_FOUND');
  const order = await assertShipmentOrderAccess(tx, actor, shipment.orderId, true);
  const input = { shipmentId: shipment.id, lines: [...args.lines].sort((a, b) => a.shipmentLineId.localeCompare(b.shipmentLineId)),
    evidenceIds: [...args.evidenceIds].sort(), reason: text(args.reason, '签收依据') };
  if (!input.lines.length || input.lines.length > 100 || new Set(input.lines.map(line => line.shipmentLineId)).size !== input.lines.length) fail('签收行不能为空或重复', 'VALIDATION_ERROR');
  input.lines.forEach(line => positive(line.quantity));
  const requestHash = hash(input);
  const replay = await tx.shipmentEvent.findMany({ where: { commandId: args.commandId } });
  if (replay.length) {
    if (replay.length !== input.lines.length || replay.some(event => event.kind !== 'RECEIPT' || event.shipmentId !== shipment.id || record(event.evidence).requestHash !== requestHash)) fail('同一命令不能更换签收参数', 'IDEMPOTENCY_KEY_REUSED');
    return publicShipment(shipment);
  }
  if (['CANCELLED', 'DELIVERED', 'COMPLETED'].includes(order.status.toUpperCase())) fail('已取消或已完成交付的订单不能追加签收');
  if (!input.evidenceIds.length) fail('请提供签收证据', 'QUALITY_EVIDENCE_REQUIRED');
  const evidence = await bindShipmentEvidence(tx, actor, input.evidenceIds, order.id);
  await claimOrder(tx, order);
  for (const [index, inputLine] of input.lines.entries()) {
    const line = shipment.lines.find(row => row.id === inputLine.shipmentLineId);
    if (!line || inputLine.quantity > line.quantity - line.receivedQuantity) fail('签收数量超出该发运行余量');
    const changed = await tx.shipmentLine.updateMany({ where: { id: line.id, version: line.version, receivedQuantity: line.receivedQuantity },
      data: { receivedQuantity: { increment: inputLine.quantity }, version: { increment: 1 } } });
    if (changed.count !== 1) throw new StateTransitionConflictError();
    await tx.shipmentEvent.create({ data: { shipmentId: shipment.id, shipmentLineId: line.id, kind: 'RECEIPT', quantity: inputLine.quantity,
      commandId: args.commandId, eventNo: index + 1, actorId: actor.id, evidence: json({ requestHash, attachments: evidence }), reason: input.reason } });
  }
  const current = await tx.shipment.findUniqueOrThrow({ where: { id: shipment.id }, include: shipmentInclude });
  const complete = current.lines.every(line => line.receivedQuantity === line.quantity);
  const changed = await tx.shipment.updateMany({ where: { id: shipment.id, version: shipment.version },
    data: { status: complete ? 'DELIVERED' : 'PARTIALLY_RECEIVED', version: { increment: 1 } } });
  if (changed.count !== 1) throw new StateTransitionConflictError();
  const view = await getOrderShipments({ tx, actor, orderId: order.id });
  if (view.delivery.complete && !['DELIVERED', 'COMPLETED'].includes(order.status.toUpperCase())) {
    if (order.outboundQuantity !== order.quantity || order.lines.some(line => line.outboundQuantity !== line.quantity)) fail('订单签收与实际出库数量不一致');
    await transitionOrderStatus(tx, { id: order.id, currentVersion: order.version + 1, currentStatus: order.status,
      nextStatus: 'DELIVERED', actorId: actor.id, reasonCode: 'SHIPMENT_RECEIPTS_COMPLETED', reason: input.reason });
  }
  await refreshEvent(tx, actor, order.id, shipment.id, 'RECEIPT');
  return publicShipment({ ...current, status: complete ? 'DELIVERED' : 'PARTIALLY_RECEIVED', version: shipment.version + 1 });
}
