import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../middleware/errorHandler.js';
import type { CapabilityActor } from '../../lib/capabilityPolicy.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { createInventoryAggregate } from '../inventoryQuality/service.js';
import { assertStockReceiptOrderScope } from './stockReceiptAccess.js';
import { loadStockReceiptFacts } from './stockReceiptFacts.js';
import { bindReceiptEvidence, readReceiptEvidence } from './receiptEvidenceAccess.js';
import { deriveReceiptQuantities } from './receiptQuantities.js';
import { lockPurchaseCoverageLines } from './purchaseCoverage.js';

type Tx = Prisma.TransactionClient;
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
const text = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new AppError(`${label}无效`, 400, 'VALIDATION_ERROR');
  return value.trim();
};
export const receiptStorageSchema = z.object({ location: z.string().trim().min(1).max(200),
  warehouse: z.string().trim().min(1).max(200), shelf: z.string().trim().min(1).max(200).nullable().default(null) }).strict();
export type StockReceiptArrivalInput = { purchaseCommitmentId: string; purchaseVersion: number;
  supplierDeliveryReference: string; reason: string; evidenceIds: string[];
  lines: Array<{ purchaseCommitmentLineId: string; physical: unknown; storage: z.input<typeof receiptStorageSchema> }> };

async function record(tx: Tx, actor: CapabilityActor, receipt: { id: string; orderId: string },
  commandId: string, requestHash: string, kind: string, quantity: number, data: unknown) {
  await tx.stockReceiptEvent.create({ data: { stockReceiptId: receipt.id, kind, quantity, commandId,
    requestHash, eventNo: 1, actorId: actor.id, data: json(data) } });
  await enqueueBusinessEvent(tx, { aggregateType: 'ORDER', aggregateId: receipt.orderId,
    eventType: `stock_receipt.${kind.toLowerCase()}`, data: { orderId: receipt.orderId, receiptId: receipt.id, kind, refresh: true },
    socket: { room: SocketRooms.ORDERS, event: SocketEvents.ORDER_STATUS_CHANGED, scope: { capability: 'order.read' } }, createdById: actor.id });
}
async function replay(tx: Tx, actor: CapabilityActor, commandId: string, requestHash: string, kind: string, receiptId?: string) {
  text(commandId, '命令标识');
  const event = await tx.stockReceiptEvent.findUnique({ where: { commandId_eventNo: { commandId, eventNo: 1 } } });
  if (!event) return null;
  if (event.actorId !== actor.id || event.requestHash !== requestHash || event.kind !== kind
    || (receiptId && event.stockReceiptId !== receiptId)) throw new AppError('相同命令不能更换收货参数', 409, 'IDEMPOTENCY_KEY_REUSED');
  return { id: event.stockReceiptId };
}
async function claimPurchase(tx: Tx, purchase: { id: string; version: number; status: string; orderId: string }, actor: CapabilityActor,
  action: 'receive' | 'review') {
  const access = await assertStockReceiptOrderScope(tx, actor, purchase.orderId, action);
  if (purchase.status !== 'CONFIRMED') conflict('只有已确认采购承诺可以登记或验收到货');
  if (!['SO_CREATED', 'PO_CREATED'].includes(access.order.status)) conflict('当前销售订单状态不能推进采购收货');
  const order = await tx.order.updateMany({ where: { id: access.order.id, version: access.order.version, status: access.order.status },
    data: { version: { increment: 1 } } });
  if (order.count !== 1) conflict('订单已变化，请刷新后重试');
  const updated = await tx.purchaseCommitment.updateMany({ where: { id: purchase.id, version: purchase.version, status: 'CONFIRMED' },
    data: { version: { increment: 1 } } });
  if (updated.count !== 1) conflict('采购承诺已变化，请刷新后重试');
}
async function assertReceiptProjection(tx: Tx, purchaseId: string) {
  const purchaseLines = await tx.purchaseCommitmentLine.findMany({ where: { purchaseCommitmentId: purchaseId } });
  const receipts = await tx.stockReceiptLine.findMany({ where: { purchaseCommitmentLineId: { in: purchaseLines.map(row => row.id) } } });
  return deriveReceiptQuantities({ purchaseLines, receiptLines: receipts.map(row => ({ id: row.id,
    purchaseLineId: row.purchaseCommitmentLineId, quantity: row.quantity, status: row.status })) });
}

/** All calls require an owned Serializable transaction. Arrival records custody
 * only; the independently reviewed ACCEPT command is the sole inventory writer. */
export async function receivePurchaseStock(args: { tx: Tx; actor: CapabilityActor; commandId: string } & StockReceiptArrivalInput) {
  const { tx, actor } = args;
  const purchase = await tx.purchaseCommitment.findUnique({ where: { id: args.purchaseCommitmentId }, include: { lines: true } });
  if (!purchase) throw new AppError('采购承诺不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertStockReceiptOrderScope(tx, actor, purchase.orderId, 'receive');
  const input = { purchaseCommitmentId: purchase.id, purchaseVersion: args.purchaseVersion,
    supplierDeliveryReference: text(args.supplierDeliveryReference, '供应商送货单号'), reason: text(args.reason, '到货依据'),
    evidenceIds: [...args.evidenceIds].sort(), lines: args.lines };
  const requestHash = hash(input);
  const previous = await replay(tx, actor, args.commandId, requestHash, 'RECEIVE');
  if (previous) return previous;
  if (!Number.isInteger(args.purchaseVersion) || args.purchaseVersion < 1 || purchase.version !== args.purchaseVersion) conflict('采购版本已变化');
  if (!Array.isArray(args.lines) || !args.lines.length || args.lines.length > 100) conflict('到货行数量无效');
  if (!input.evidenceIds.length || input.evidenceIds.length > 20 || new Set(input.evidenceIds).size !== input.evidenceIds.length) conflict('到货需要不重复的证据附件');
  await claimPurchase(tx, purchase, actor, 'receive');
  await lockPurchaseCoverageLines(tx, purchase.lines.map(line => line.orderLineId));
  const id = randomUUID(); const now = new Date();
  const lines: Prisma.StockReceiptLineUncheckedCreateWithoutReceiptInput[] = [];
  for (const [index, inputLine] of args.lines.entries()) {
    const facts = await loadStockReceiptFacts(tx, inputLine.purchaseCommitmentLineId, inputLine.physical, 'ARRIVAL', now);
    if (facts.line.purchaseCommitmentId !== purchase.id) conflict('到货行不属于当前采购承诺');
    const p = facts.physical; const ql = facts.line.orderLine.quotationLine;
    lines.push({ id: randomUUID(), lineNo: index + 1, purchaseCommitmentLineId: facts.line.id, quantity: p.quantity,
      identitySnapshot: json({ schemaVersion: 1, purchaseCommitmentLineId: facts.line.id, orderLineId: facts.line.orderLineId,
        quotationLineId: ql.id, rfqLineId: ql.rfqLineId, partNumber: p.partNumber, uom: p.uom,
        serialNumber: p.serialNumber, batchNumber: p.batchNumber, conditionCode: p.conditionCode, trackingType: p.trackingType }),
      qualitySnapshot: json({ physical: p, storage: receiptStorageSchema.parse(inputLine.storage) }), evidence: [],
    });
  }
  const arrivalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (!Number.isSafeInteger(arrivalQuantity) || arrivalQuantity > 2147483647) conflict('单次收货总量超过可记录范围，请拆分送货记录');
  // The header is immutable. Store the expected post-binding fingerprints up
  // front, then let the binding helper verify owner/scope/domain and CAS them.
  const files = await tx.storedObject.findMany({ where: { id: { in: input.evidenceIds } },
    select: { id: true, version: true, sha256: true, status: true }, orderBy: { id: 'asc' } });
  const expectedEvidence = files.map(file => ({ id: file.id, version: file.version + 1, sha256: file.sha256, status: file.status }));
  const receipt = await tx.stockReceipt.create({ data: { id, purchaseCommitmentId: purchase.id,
    receiptNumber: `SR-${randomUUID().toUpperCase()}`, commandId: args.commandId, requestHash,
    receivedById: actor.id, receivedAt: now, supplierDeliveryReference: input.supplierDeliveryReference,
    reason: input.reason, evidence: json(expectedEvidence), lines: { create: lines.map(line => ({ ...line, evidence: json(expectedEvidence) })) } } });
  const evidence = await bindReceiptEvidence(tx, actor, input.evidenceIds, id);
  if (hash(evidence) !== hash(expectedEvidence)) conflict('附件绑定版本已变化');
  await assertReceiptProjection(tx, purchase.id);
  await record(tx, actor, { id, orderId: purchase.orderId }, args.commandId, requestHash, 'RECEIVE',
    arrivalQuantity, { version: receipt.version, purchaseCommitmentId: purchase.id });
  return { id };
}

async function reviewContext(tx: Tx, actor: CapabilityActor, receiptLineId: string) {
  const line = await tx.stockReceiptLine.findUnique({ where: { id: receiptLineId }, include: {
    receipt: { include: { purchaseCommitment: true } },
  } });
  if (!line) throw new AppError('收货行不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertStockReceiptOrderScope(tx, actor, line.receipt.purchaseCommitment.orderId, 'review');
  const stored = z.object({ physical: z.unknown(), storage: receiptStorageSchema }).strict().parse(line.qualitySnapshot);
  const facts = await loadStockReceiptFacts(tx, line.purchaseCommitmentLineId, stored.physical, 'ARRIVAL');
  const evidence = await readReceiptEvidence(tx, actor, line.receiptId);
  if (!evidence.length || hash(evidence) !== hash(line.evidence)) conflict('收货行缺少当前有效的到货证据');
  const snapshot = { receiptId: line.receiptId, receiptLineId: line.id, version: line.version,
    receiptVersion: line.receipt.version, identity: line.identitySnapshot, physical: stored,
    requirements: facts.review.snapshot, evidence };
  return { line, facts, storage: stored.storage, snapshot, snapshotHash: hash(snapshot) };
}
export async function getStockReceiptReviewContext(args: { tx: Tx; actor: CapabilityActor; receiptLineId: string }) {
  const context = await reviewContext(args.tx, args.actor, args.receiptLineId);
  return { receiptLineId: context.line.id, version: context.line.version, status: context.line.status,
    snapshot: context.snapshot, snapshotHash: context.snapshotHash,
    issues: context.facts.review.issues, canAccept: context.line.status === 'PENDING_REVIEW' && context.facts.review.canAccept
      && ![context.line.receipt.receivedById, context.line.receipt.purchaseCommitment.createdById,
        context.line.receipt.purchaseCommitment.submittedById, context.line.receipt.purchaseCommitment.confirmedById].includes(args.actor.id) };
}
export type StockReceiptReviewInput = { receiptLineId: string; version: number; snapshotHash: string;
  decision: 'ACCEPTED' | 'REJECTED'; reason: string;
  checks: { identity: boolean; documents: boolean; conditionAndLife: boolean; customerRequirements: boolean } };
export async function reviewPurchaseStock(args: { tx: Tx; actor: CapabilityActor; commandId: string } & StockReceiptReviewInput) {
  const { tx, actor } = args;
  const existing = await tx.stockReceiptLine.findUnique({ where: { id: args.receiptLineId },
    include: { receipt: { include: { purchaseCommitment: true } } } });
  if (!existing) throw new AppError('收货行不存在', 404, 'RESOURCE_NOT_FOUND');
  const purchase = existing.receipt.purchaseCommitment;
  await assertStockReceiptOrderScope(tx, actor, purchase.orderId, 'review');
  const input = { receiptLineId: args.receiptLineId, version: args.version, snapshotHash: args.snapshotHash,
    decision: args.decision, reason: text(args.reason, '质检依据'), checks: args.checks };
  const requestHash = hash(input);
  const previous = await replay(tx, actor, args.commandId, requestHash, args.decision, existing.receiptId);
  if (previous) return previous;
  if (![ 'ACCEPTED', 'REJECTED' ].includes(args.decision) || existing.status !== 'PENDING_REVIEW'
    || args.version !== existing.version) conflict('收货行已经复核或版本已变化');
  if ([existing.receipt.receivedById, purchase.createdById, purchase.confirmedById, purchase.submittedById].includes(actor.id)) {
    throw new AppError('到货人或采购经办人不能质检自己的收货', 403, 'SELF_APPROVAL_FORBIDDEN');
  }
  await claimPurchase(tx, purchase, actor, 'review');
  await lockPurchaseCoverageLines(tx, [ (await tx.purchaseCommitmentLine.findUniqueOrThrow({ where: { id: existing.purchaseCommitmentLineId } })).orderLineId ]);
  const context = await reviewContext(tx, actor, existing.id);
  // claimPurchase changes only the purchase version, which is not part of the
  // quality snapshot; all physical, requirement and evidence facts are current.
  if (args.snapshotHash !== context.snapshotHash) throw new AppError('质检事实已变化，请刷新后重新复核', 409, 'QUALITY_REVIEW_STALE');
  let inventoryDetailId: string | null = null;
  if (args.decision === 'ACCEPTED') {
    if (!args.checks || !['identity', 'documents', 'conditionAndLife', 'customerRequirements']
      .every(key => args.checks[key as keyof typeof args.checks] === true)) conflict('验收需要完成全部质量检查');
    const facts = await loadStockReceiptFacts(tx, existing.purchaseCommitmentLineId, context.facts.physical, 'ACCEPT');
    const p = facts.physical;
    const master = await tx.inventoryItem.findUnique({ where: { partNumber: p.partNumber } });
    if (master && (master.trackingType !== p.trackingType || master.unitOfMeasure !== p.uom)) conflict('收货追踪方式或单位与主件记录不符');
    const unitCost = facts.line.unitCost.toNumber();
    if (!Number.isFinite(unitCost) || !new Prisma.Decimal(unitCost).equals(facts.line.unitCost)) conflict('采购成本无法无损映射现有库存成本字段');
    const detail = await createInventoryAggregate(tx, {
      item: { partNumber: p.partNumber, description: facts.line.orderLine.quotationLine.rfqLine!.description ?? p.partNumber,
        trackingType: p.trackingType, unitOfMeasure: p.uom },
      detail: { quantity: existing.quantity, type: 'OWN', status: 'AVAILABLE', conditionCode: p.conditionCode,
        serialNumber: p.serialNumber, batchNumber: p.batchNumber, ...context.storage, unitCost, supplierId: purchase.supplierId,
        certificateType: p.certificateType ?? 'NONE', certificateNumber: p.certificateNumber,
        lifeLimited: p.lifeLimited, remainingHours: p.remainingHours, remainingCycles: p.remainingCycles,
        shelfLifeDate: p.shelfLifeDate ? new Date(p.shelfLifeDate) : null, shelfLifeDays: p.shelfLifeDays,
        nextOverhaulDue: p.nextOverhaulDue ? new Date(p.nextOverhaulDue) : null, storageCondition: p.storageCondition },
      include: {}, actorId: actor.id, notes: input.reason,
      receipt: { stockReceiptLineId: existing.id, receiptNumber: existing.receipt.receiptNumber },
    });
    inventoryDetailId = detail.id;
    await tx.purchaseCommitmentLine.update({ where: { id: facts.line.id }, data: { receivedQuantity: { increment: existing.quantity }, version: { increment: 1 } } });
  }
  const updated = await tx.stockReceiptLine.updateMany({ where: { id: existing.id, status: 'PENDING_REVIEW', version: existing.version },
    data: { status: args.decision, inventoryDetailId, reviewedById: actor.id, reviewedAt: new Date(), reviewReason: input.reason, version: { increment: 1 } } });
  if (updated.count !== 1) conflict('收货行已被其他质检操作处理');
  const header = await tx.stockReceipt.updateMany({ where: { id: existing.receiptId, version: existing.receipt.version }, data: { version: { increment: 1 } } });
  if (header.count !== 1) conflict('收货单已变化，请刷新后复核');
  await assertReceiptProjection(tx, purchase.id);
  await record(tx, actor, { id: existing.receiptId, orderId: purchase.orderId }, args.commandId, requestHash, args.decision,
    existing.quantity, { receiptLineId: existing.id, inventoryDetailId, reason: input.reason,
      checks: args.checks, snapshot: context.snapshot, snapshotHash: context.snapshotHash });
  return { id: existing.receiptId };
}
