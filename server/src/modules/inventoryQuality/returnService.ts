import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { hasCapability, type CapabilityActor } from '../../lib/capabilityPolicy.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { assertShipmentOutboundUnreturned } from './returnGuards.js';
import { bindShipmentEvidence } from './shipmentEvidence.js';

type Tx = Prisma.TransactionClient;
type JsonObject = Record<string, unknown>;

export type ReturnChecks = {
  identity: boolean;
  documents: boolean;
  conditionAndLife: boolean;
  customerRequirements: boolean;
};

export type ReceiveShipmentReturnInput = {
  tx: Tx;
  actor: CapabilityActor;
  shipmentLineId: string;
  quantity: number;
  evidenceIds: string[];
  verifiedSerialNumber?: string;
  verifiedBatchNumber?: string;
  reason: string;
  commandId: string;
};

export type ReturnReleaseContextInput = {
  tx: Tx;
  actor: CapabilityActor;
  returnHoldId: string;
};

export type ReleaseShipmentReturnInput = {
  tx: Tx;
  actor: CapabilityActor;
  returnHoldId: string;
  snapshotHash: string;
  evidenceIds: string[];
  verifiedSerialNumber?: string;
  verifiedBatchNumber?: string;
  checks: ReturnChecks;
  reason: string;
  commandId: string;
};

type EvidenceSnapshot = { id: string; version: number; sha256: string; status: string };
type IdentitySnapshot = {
  inventoryDetailId: string;
  inventoryItemId: string;
  partNumber: string;
  trackingType: string;
  serialNumber: string | null;
  batchNumber: string | null;
  conditionCode: string;
  warehouse: string | null;
  location: string;
};

type InventoryDetailWithRelations = Prisma.InventoryDetailGetPayload<{
  include: { inventoryItem: true; certificates: true };
}>;

const SHIPMENT_LINE_INCLUDE = {
  shipment: {
    include: {
      order: {
        include: {
          quotation: { include: { creator: { select: { id: true, department: true } }, rfq: true } },
        },
      },
    },
  },
  orderLine: {
    include: {
      order: {
        include: {
          quotation: { include: { creator: { select: { id: true, department: true } }, rfq: true } },
        },
      },
      quotationLine: { include: { rfqLine: true } },
    },
  },
  assignment: { include: { allocation: { select: { createdById: true } } } },
  outboundTransaction: {
    include: {
      inventoryDetail: { include: { inventoryItem: true, certificates: true } },
    },
  },
} satisfies Prisma.ShipmentLineInclude;

const RETURN_HOLD_INCLUDE = {
  shipmentLine: { include: SHIPMENT_LINE_INCLUDE },
  inventoryDetail: { include: { inventoryItem: true, certificates: true } },
  events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ReturnHoldInclude;

function db(tx: Tx) {
  return tx;
}

function validation(message: string): never {
  throw new AppError(message, 400, 'VALIDATION_ERROR');
}

function conflict(message: string, code: 'RESOURCE_CONFLICT' | 'QUALITY_REVIEW_BLOCKED' | 'QUALITY_REVIEW_STALE' | 'QUALITY_EVIDENCE_INVALID' | 'QUALITY_EVIDENCE_REQUIRED' | 'SELF_APPROVAL_FORBIDDEN' | 'STATE_CONFLICT' | 'INVALID_STATE_TRANSITION' = 'RESOURCE_CONFLICT'): never {
  throw new AppError(message, code === 'SELF_APPROVAL_FORBIDDEN' ? 403 : 409, code);
}

function forbidden(message: string): never {
  throw new AppError(message, 403, 'AUTH_FORBIDDEN');
}

function id(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) validation(`${label}不能为空`);
  return value.trim();
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) validation(`${label}必须是正整数`);
}

function nonEmptyReason(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) validation('请记录退货处理依据');
  return value.trim();
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function hash(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value : String(value);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) conflict(`${label}缺失，不能建立退货事实`, 'QUALITY_REVIEW_STALE');
  return value.trim();
}

function identityFromLine(value: unknown): IdentitySnapshot {
  const record = asRecord(value);
  if (!record) conflict('发运行缺少可信实物身份快照', 'QUALITY_REVIEW_STALE');
  return {
    inventoryDetailId: requiredString(record.inventoryDetailId, '库存明细身份'),
    inventoryItemId: requiredString(record.inventoryItemId, '库存主件身份'),
    partNumber: requiredString(record.partNumber, '库存件号'),
    trackingType: requiredString(record.trackingType, '库存追踪类型').toUpperCase(),
    serialNumber: nullableString(record.serialNumber),
    batchNumber: nullableString(record.batchNumber),
    conditionCode: requiredString(record.conditionCode, '库存状态'),
    warehouse: nullableString(record.warehouse),
    location: requiredString(record.location, '库存位置'),
  };
}

function sameNullable(left: unknown, right: unknown) {
  return nullableString(left) === nullableString(right);
}

function evidenceIds(value: unknown, label = 'evidenceIds') {
  if (!Array.isArray(value) || value.length === 0) validation(`${label}至少需要一个附件`);
  const normalized = value.map((item, index) => id(item, `${label}[${index}]`));
  const unique = [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
  if (unique.length !== normalized.length) validation(`${label}不能重复引用附件`);
  return unique;
}

function evidenceSnapshot(records: Array<{ id: string; version: number; sha256: string; status: string }>): EvidenceSnapshot[] {
  return records
    .map(({ id, version, sha256, status }) => ({ id, version, sha256, status }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parseEvidence(value: unknown): EvidenceSnapshot[] {
  if (!Array.isArray(value) || value.length === 0) conflict('退货证据记录为空或格式无效', 'QUALITY_EVIDENCE_INVALID');
  return value.map((item) => {
    const row = asRecord(item);
    if (!row || typeof row.id !== 'string' || !Number.isSafeInteger(row.version)
      || typeof row.sha256 !== 'string' || typeof row.status !== 'string') {
      conflict('退货证据记录格式无效', 'QUALITY_EVIDENCE_INVALID');
    }
    return { id: row.id, version: row.version as number, sha256: row.sha256, status: row.status };
  });
}

async function readEvidence(
  tx: Tx,
  ids: string[],
  orderId: string,
): Promise<EvidenceSnapshot[]> {
  const records = await db(tx).storedObject.findMany({
    where: { id: { in: ids } },
    orderBy: { id: 'asc' },
  });
  if (records.length !== ids.length || records.some((record: any) =>
    record.status !== 'AVAILABLE'
    || !['order', 'orders'].includes(record.domain)
    || record.resourceId !== orderId
    || !Number.isSafeInteger(record.version)
    || record.version <= 0
    || typeof record.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/i.test(record.sha256),
  )) {
    conflict('退货证据不存在、已撤销或校验信息无效', 'QUALITY_EVIDENCE_INVALID');
  }
  return evidenceSnapshot(records);
}

async function assertEvidenceStillAvailable(tx: Tx, snapshots: EvidenceSnapshot[], orderId: string) {
  // The receiver's evidence is bound to the hold. A quality reviewer may
  // inspect it by order scope; only new release evidence needs ownership.
  const current = await readEvidence(tx, snapshots.map((item) => item.id), orderId);
  if (hash(current) !== hash(snapshots)) conflict('退货证据版本已变化，请重新核对', 'QUALITY_REVIEW_STALE');
  return current;
}

function orderForLine(line: any) {
  return line.shipment?.order ?? line.orderLine?.order ?? null;
}

function ownerContext(order: any) {
  return {
    ownerId: order?.quotation?.createdBy ?? null,
    department: order?.quotation?.creator?.department ?? null,
  };
}

function assertOrderScope(actor: CapabilityActor, order: any) {
  const context = ownerContext(order);
  if (!hasCapability(actor, 'order', 'read', context)) forbidden('当前用户无权读取该订单归属范围');
}

function assertReceiveCapability(actor: CapabilityActor, order: any) {
  if (!hasCapability(actor, 'inventory', 'manage')) forbidden('需要库存退货接收权限');
  assertOrderScope(actor, order);
}

function assertReleaseCapability(actor: CapabilityActor, order: any) {
  if (!hasCapability(actor, 'quality_review', 'approve')) forbidden('需要退货质量放行权限');
  assertOrderScope(actor, order);
}

function assertNotSelfApproval(actor: CapabilityActor, hold: any, line: any, order: any) {
  const forbiddenIds = new Set([
    hold.receivedById,
    line.assignment?.createdById,
    line.assignment?.allocation?.createdById,
    line.shipment?.createdById,
    order?.quotation?.createdBy,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0));
  if (forbiddenIds.has(actor.id)) conflict('退货接收人、订单经办人或分配创建者不能审批自己的退货', 'SELF_APPROVAL_FORBIDDEN');
}

function currentIdentity(detail: any): IdentitySnapshot {
  return {
    inventoryDetailId: detail.id,
    inventoryItemId: detail.inventoryItemId,
    partNumber: detail.inventoryItem?.partNumber ?? '',
    trackingType: String(detail.inventoryItem?.trackingType ?? '').toUpperCase(),
    serialNumber: nullableString(detail.serialNumber),
    batchNumber: nullableString(detail.batchNumber),
    conditionCode: String(detail.conditionCode ?? ''),
    warehouse: nullableString(detail.warehouse),
    location: String(detail.location ?? ''),
  };
}

function assertIdentitySnapshot(identity: IdentitySnapshot, detail: any) {
  const current = currentIdentity(detail);
  const fields: Array<keyof IdentitySnapshot> = [
    'inventoryDetailId', 'inventoryItemId', 'partNumber', 'trackingType',
    'serialNumber', 'batchNumber', 'conditionCode', 'warehouse', 'location',
  ];
  if (fields.some((field) => current[field] !== identity[field])) {
    conflict('退货实物身份已变化，请重新核对原始发运快照', 'QUALITY_REVIEW_STALE');
  }
}

function assertVerifiedIdentity(identity: IdentitySnapshot, serial: unknown, batch: unknown) {
  const verifiedSerial = typeof serial === 'string' ? serial.trim() : '';
  const verifiedBatch = typeof batch === 'string' ? batch.trim() : '';
  if ((identity.serialNumber ?? '') !== verifiedSerial) conflict('退货核验序号与原始发运身份不一致', 'QUALITY_REVIEW_BLOCKED');
  if ((identity.batchNumber ?? '') !== verifiedBatch) conflict('退货核验批次与原始发运身份不一致', 'QUALITY_REVIEW_BLOCKED');
}

function assertShipmentLineChain(line: any, detail: any): IdentitySnapshot {
  const outbound = line.outboundTransaction;
  const order = orderForLine(line);
  if (!outbound || outbound.type !== 'OUTBOUND' || !Number.isSafeInteger(outbound.quantity) || outbound.quantity >= 0) {
    conflict('发运行没有可信的 OUTBOUND 出库事实', 'QUALITY_REVIEW_BLOCKED');
  }
  positiveInteger(line.quantity, '发运行数量');
  if (line.quantity > Math.abs(outbound.quantity)) conflict('发运行数量超过原始出库流水', 'QUALITY_REVIEW_BLOCKED');
  if (!order || !line.shipment || line.shipment.orderId !== order.id || line.orderLine?.orderId !== order.id) {
    conflict('发运行订单关系不一致', 'QUALITY_REVIEW_BLOCKED');
  }
  if (outbound.inventoryDetailId !== detail.id) conflict('出库流水与退货实物不一致', 'QUALITY_REVIEW_BLOCKED');
  if (outbound.assignmentId && outbound.assignmentId !== line.assignmentId) conflict('出库流水与分配任务不一致', 'QUALITY_REVIEW_BLOCKED');
  if (line.assignment?.orderLineId && line.assignment.orderLineId !== line.orderLineId) conflict('发运行与分配订单行不一致', 'QUALITY_REVIEW_BLOCKED');
  if (line.receivedQuantity < 0 || line.returnedQuantity < 0 || line.returnedQuantity > line.quantity) {
    conflict('发运行签收或退货投影无效', 'QUALITY_REVIEW_BLOCKED');
  }
  const identity = identityFromLine(line.identitySnapshot);
  if (identity.inventoryDetailId !== detail.id || identity.inventoryItemId !== detail.inventoryItemId) {
    conflict('发运身份快照与当前库存明细不一致', 'QUALITY_REVIEW_STALE');
  }
  assertIdentitySnapshot(identity, detail);
  return identity;
}

function serialTracked(identity: IdentitySnapshot) {
  return identity.trackingType === 'SERIAL' || Boolean(identity.serialNumber);
}

async function assertLatestSerialOutbound(tx: Tx, line: any, identity: IdentitySnapshot) {
  await assertShipmentOutboundUnreturned(tx, {
    inventoryDetailId: identity.inventoryDetailId,
    outboundTransactionId: line.outboundTransaction.id,
    requireUniqueUncovered: serialTracked(identity),
  });
}

function qualitySnapshot(detail: any, certificates: any[]) {
  return {
    status: detail.status,
    quantity: detail.quantity,
    allocatedQuantity: detail.allocatedQuantity,
    conditionCode: detail.conditionCode,
    certificateType: detail.certificateType,
    certificateNumber: detail.certificateNumber,
    certificateFileUrl: detail.certificateFileUrl,
    lifeLimited: detail.lifeLimited,
    remainingHours: detail.remainingHours,
    remainingCycles: detail.remainingCycles,
    shelfLifeDate: detail.shelfLifeDate,
    shelfLifeDays: detail.shelfLifeDays,
    nextOverhaulDue: detail.nextOverhaulDue,
    storageCondition: detail.storageCondition,
    updatedAt: detail.updatedAt,
    itemUpdatedAt: detail.inventoryItem?.updatedAt,
    certificates: certificates.map((certificate) => ({
      id: certificate.id,
      certificateNumber: certificate.certificateNumber,
      partNumber: certificate.partNumber,
      serialNumber: certificate.serialNumber,
      batchNumber: certificate.batchNumber,
      certificateType: certificate.certificateType,
      status: certificate.status,
      expiryDate: certificate.expiryDate,
      fileHash: certificate.fileHash,
      updatedAt: certificate.updatedAt,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function buildSnapshot(
  line: any,
  detail: any,
  certificates: any[],
  evidence: EvidenceSnapshot[],
  identity: IdentitySnapshot,
  hold?: any,
) {
  return {
    schemaVersion: 1,
    shipmentLineId: line.id,
    inventoryDetailId: detail.id,
    assignmentId: line.assignmentId,
    outboundTransactionId: line.outboundTransactionId,
    quantity: line.quantity,
    identitySnapshot: identity,
    quality: qualitySnapshot(detail, certificates),
    evidence,
    ...(hold ? {
      hold: {
        id: hold.id,
        quantity: hold.quantity,
        version: hold.version,
        status: hold.status,
        receivedById: hold.receivedById,
        receivedAt: hold.receivedAt,
      },
    } : {}),
  };
}

async function certificatesForDetail(tx: Tx, detail: any, orderId?: string) {
  return db(tx).certificate.findMany({
    where: orderId
      ? { OR: [{ inventoryDetailId: detail.id }, { orderId }] }
      : { inventoryDetailId: detail.id },
    orderBy: { id: 'asc' },
  });
}

function validCertificate(certificate: any, detail: any, requiredTypes: string[]) {
  const status = String(certificate.status ?? '').trim().toUpperCase();
  const normalizeType = (value: unknown) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return !['REVOKED', 'EXPIRED', 'VOID', 'REJECTED'].includes(status)
    && (!certificate.expiryDate || new Date(certificate.expiryDate).getTime() > Date.now())
    && certificate.partNumber === detail.inventoryItem?.partNumber
    && sameNullable(certificate.serialNumber, detail.serialNumber)
    && sameNullable(certificate.batchNumber, detail.batchNumber)
    && requiredTypes.every((type) => normalizeType(type) === normalizeType(certificate.certificateType));
}

function assertLife(detail: any) {
  const now = Date.now();
  if (detail.shelfLifeDays != null && !detail.shelfLifeDate) conflict('退货实物缺少可核验的货架期日期', 'QUALITY_EVIDENCE_REQUIRED');
  if (detail.shelfLifeDate && new Date(detail.shelfLifeDate).getTime() <= now) conflict('退货实物已超过货架期', 'QUALITY_REVIEW_BLOCKED');
  if (detail.nextOverhaulDue && new Date(detail.nextOverhaulDue).getTime() <= now) conflict('退货实物已超过检修期限', 'QUALITY_REVIEW_BLOCKED');
  if (detail.lifeLimited && detail.remainingHours == null && detail.remainingCycles == null) conflict('退货时寿实物缺少剩余寿命事实', 'QUALITY_EVIDENCE_REQUIRED');
  if (detail.lifeLimited && ((detail.remainingHours != null && detail.remainingHours <= 0)
    || (detail.remainingCycles != null && detail.remainingCycles <= 0))) conflict('退货时寿实物剩余寿命不足', 'QUALITY_REVIEW_BLOCKED');
}

async function assertQualityEvidence(tx: Tx, line: any, detail: any, certificates: any[]) {
  assertLife(detail);
  const order = orderForLine(line);
  const rfqLine = line.orderLine?.quotationLine?.rfqLine;
  const requiredTypes = [
    typeof detail.certificateType === 'string' ? detail.certificateType : null,
    order?.certificateRequired === true ? order.certificateType : null,
    rfqLine?.certificateRequired === true ? rfqLine.certificateType : null,
  ]
    .filter((value): value is string => typeof value === 'string'
      && Boolean(value.trim())
      && value.toUpperCase() !== 'NONE');
  const required = Boolean(
    order?.certificateRequired === true
    || order?.inspectionRequired === true
    || rfqLine?.certificateRequired === true
    || Boolean(detail.certificateNumber)
    || requiredTypes.length > 0,
  );
  if (required && !certificates.some((certificate) => validCertificate(certificate, detail, requiredTypes))) {
    conflict('退货缺少匹配件号、序号/批次、类型及有效期的证书', 'QUALITY_EVIDENCE_REQUIRED');
  }
  void tx;
}

async function loadShipmentLine(tx: Tx, shipmentLineId: string) {
  const line = await db(tx).shipmentLine.findUnique({ where: { id: shipmentLineId }, include: SHIPMENT_LINE_INCLUDE });
  if (!line) throw new AppError('发运行不存在', 404, 'RESOURCE_NOT_FOUND');
  const outbound = line.outboundTransaction;
  let detail: InventoryDetailWithRelations | null = outbound?.inventoryDetail ?? null;
  if (!detail) {
    detail = await db(tx).inventoryDetail.findUnique({
      where: { id: outbound?.inventoryDetailId },
      include: { inventoryItem: true, certificates: true },
    });
  }
  if (!detail) throw new AppError('退货对应库存明细不存在', 404, 'RESOURCE_NOT_FOUND');
  return { line, detail };
}

async function loadHold(tx: Tx, returnHoldId: string) {
  const hold = await db(tx).returnHold.findUnique({ where: { id: returnHoldId }, include: RETURN_HOLD_INCLUDE });
  if (!hold) throw new AppError('退货隔离记录不存在', 404, 'RESOURCE_NOT_FOUND');
  const line = hold.shipmentLine;
  let detail: InventoryDetailWithRelations | null = hold.inventoryDetail
    ?? line?.outboundTransaction?.inventoryDetail
    ?? null;
  if (!detail) {
    detail = await db(tx).inventoryDetail.findUnique({
      where: { id: hold.inventoryDetailId },
      include: { inventoryItem: true, certificates: true },
    });
  }
  if (!line || !detail) conflict('退货隔离来源关系不完整', 'QUALITY_REVIEW_STALE');
  return { hold, line, detail };
}

async function checkReceiveIdempotency(tx: Tx, actor: CapabilityActor, commandId: string, requestHash: string) {
  const existing = await db(tx).returnHold.findUnique({ where: { commandId } });
  if (!existing) return null;
  if (existing.receivedById !== actor.id || existing.requestHash !== requestHash) {
    throw new AppError('退货接收幂等命令已用于其他请求', 409, 'IDEMPOTENCY_KEY_REUSED');
  }
  return { ...safeHold(existing), replayed: true };
}

async function checkReleaseIdempotency(tx: Tx, actor: CapabilityActor, commandId: string, requestHash: string) {
  const existing = await db(tx).returnHold.findFirst({ where: { releaseCommandId: commandId } });
  if (!existing) return null;
  if (existing.releasedById !== actor.id || existing.releaseRequestHash !== requestHash) {
    throw new AppError('退货放行幂等命令已用于其他请求', 409, 'IDEMPOTENCY_KEY_REUSED');
  }
  return { ...safeHold(existing), replayed: true };
}

function safeHold(hold: any) {
  return {
    id: hold.id,
    shipmentLineId: hold.shipmentLineId,
    inventoryDetailId: hold.inventoryDetailId,
    quantity: hold.quantity,
    status: hold.status,
    version: hold.version,
    identitySnapshot: hold.identitySnapshot,
    evidence: hold.evidence,
    snapshotHash: hold.snapshotHash,
    receivedById: hold.receivedById,
    receivedAt: hold.receivedAt,
    releasedById: hold.releasedById,
    releasedAt: hold.releasedAt,
    releaseReason: hold.releaseReason,
    returnTransactionId: hold.returnTransactionId,
  };
}

function safeDetail(detail: any) {
  return {
    id: detail.id,
    inventoryItemId: detail.inventoryItemId,
    partNumber: detail.inventoryItem?.partNumber,
    trackingType: detail.inventoryItem?.trackingType,
    serialNumber: detail.serialNumber,
    batchNumber: detail.batchNumber,
    conditionCode: detail.conditionCode,
    warehouse: detail.warehouse,
    location: detail.location,
    status: detail.status,
    quantity: detail.quantity,
    allocatedQuantity: detail.allocatedQuantity,
    certificateType: detail.certificateType,
    certificateNumber: detail.certificateNumber,
    lifeLimited: detail.lifeLimited,
    remainingHours: detail.remainingHours,
    remainingCycles: detail.remainingCycles,
    shelfLifeDate: detail.shelfLifeDate,
    nextOverhaulDue: detail.nextOverhaulDue,
  };
}

function publicContext(hold: any, line: any, detail: any, certificates: any[], currentHash: string, snapshot: JsonObject) {
  return {
    ...safeHold(hold),
    returnHoldId: hold.id,
    // The hold keeps the immutable receive hash for audit.  Release reviews
    // use the freshly computed current snapshot hash so a quality reviewer
    // can explicitly re-review a changed, still-authorized context.
    receivedSnapshotHash: hold.snapshotHash,
    snapshotHash: currentHash,
    snapshot,
    shipmentLine: {
      id: line.id,
      shipmentId: line.shipmentId,
      orderLineId: line.orderLineId,
      assignmentId: line.assignmentId,
      outboundTransactionId: line.outboundTransactionId,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
      returnedQuantity: line.returnedQuantity,
      version: line.version,
      identitySnapshot: line.identitySnapshot,
    },
    inventoryDetail: safeDetail(detail),
    certificates: certificates.map((certificate) => ({
      id: certificate.id,
      certificateNumber: certificate.certificateNumber,
      partNumber: certificate.partNumber,
      serialNumber: certificate.serialNumber,
      batchNumber: certificate.batchNumber,
      certificateType: certificate.certificateType,
      status: certificate.status,
      expiryDate: certificate.expiryDate,
      fileHash: certificate.fileHash,
      updatedAt: certificate.updatedAt,
    })),
    currentSnapshotHash: currentHash,
  };
}

export async function receiveShipmentReturn(input: ReceiveShipmentReturnInput) {
  const shipmentLineId = id(input.shipmentLineId, 'shipmentLineId');
  const commandId = id(input.commandId, 'commandId');
  const reason = nonEmptyReason(input.reason);
  positiveInteger(input.quantity, '退货数量');
  const attachments = evidenceIds(input.evidenceIds);
  const requestHash = hash({
    operation: 'receive-shipment-return', shipmentLineId, quantity: input.quantity,
    evidenceIds: attachments, verifiedSerialNumber: input.verifiedSerialNumber ?? '',
    verifiedBatchNumber: input.verifiedBatchNumber ?? '', reason,
  });
  const replay = await checkReceiveIdempotency(input.tx, input.actor, commandId, requestHash);
  if (replay) return replay;

  const { line, detail } = await loadShipmentLine(input.tx, shipmentLineId);
  const order = orderForLine(line);
  assertReceiveCapability(input.actor, order);
  const identity = assertShipmentLineChain(line, detail);
  await assertLatestSerialOutbound(input.tx, line, identity);
  assertVerifiedIdentity(identity, input.verifiedSerialNumber, input.verifiedBatchNumber);
  if (line.quantity - line.returnedQuantity < input.quantity) conflict('累计退货数量不能超过发运行数量', 'QUALITY_REVIEW_BLOCKED');
  const evidence = await bindShipmentEvidence(input.tx, input.actor, attachments, order.id);
  const certificates = await certificatesForDetail(input.tx, detail, order?.id);
  const snapshot = buildSnapshot(line, detail, certificates, evidence, identity);
  const snapshotHash = hash(snapshot);

  const hold = await db(input.tx).returnHold.create({
    data: {
      shipmentLineId: line.id,
      inventoryDetailId: detail.id,
      quantity: input.quantity,
      status: 'QUARANTINED',
      version: 1,
      identitySnapshot: json(identity),
      evidence: json(evidence),
      snapshotHash,
      receivedById: input.actor.id,
      commandId,
      requestHash,
    },
  });
  const updatedLine = await db(input.tx).shipmentLine.updateMany({
    where: { id: line.id, version: line.version, returnedQuantity: line.returnedQuantity },
    data: { returnedQuantity: { increment: input.quantity }, version: { increment: 1 } },
  });
  if (updatedLine.count !== 1) conflict('发运行已被并发修改，请刷新后重试', 'STATE_CONFLICT');
  const event = await db(input.tx).returnEvent.create({
    data: {
      returnHoldId: hold.id,
      kind: 'RECEIVED',
      quantity: input.quantity,
      commandId,
      eventNo: 1,
      actorId: input.actor.id,
      evidence: json(evidence),
      reason,
    },
  });
  await enqueueBusinessEvent(input.tx, {
    eventType: 'inventory.return.received',
    aggregateType: 'RETURN_HOLD',
    aggregateId: hold.id,
    data: {
      returnHoldId: hold.id,
      shipmentLineId: line.id,
      inventoryDetailId: detail.id,
      status: 'QUARANTINED',
      version: hold.version,
      eventId: event.id,
      commandId,
    },
    createdById: input.actor.id,
  });
  void event;
  return { ...safeHold(hold), replayed: false };
}

async function loadReleaseState(tx: Tx, actor: CapabilityActor, returnHoldId: string) {
  const { hold, line, detail } = await loadHold(tx, returnHoldId);
  const order = orderForLine(line);
  assertReleaseCapability(actor, order);
  const identity = assertShipmentLineChain(line, detail);
  await assertLatestSerialOutbound(tx, line, identity);
  assertIdentitySnapshot(identityFromLine(hold.identitySnapshot), detail);
  const sourceEvidence = parseEvidence(hold.evidence);
  await assertEvidenceStillAvailable(tx, sourceEvidence, order.id);
  const certificates = await certificatesForDetail(tx, detail, order?.id);
  const snapshot = buildSnapshot(line, detail, certificates, sourceEvidence, identity, hold);
  return { hold, line, detail, order, identity, sourceEvidence, certificates, snapshot, snapshotHash: hash(snapshot) };
}

export async function getReturnReleaseContext(input: ReturnReleaseContextInput) {
  const returnHoldId = id(input.returnHoldId, 'returnHoldId');
  const state = await loadReleaseState(input.tx, input.actor, returnHoldId);
  return publicContext(state.hold, state.line, state.detail, state.certificates, state.snapshotHash, state.snapshot);
}

export async function releaseShipmentReturn(input: ReleaseShipmentReturnInput) {
  const returnHoldId = id(input.returnHoldId, 'returnHoldId');
  const commandId = id(input.commandId, 'commandId');
  const reason = nonEmptyReason(input.reason);
  if (!/^[a-f0-9]{64}$/i.test(input.snapshotHash)) validation('退货快照指纹无效');
  const attachments = evidenceIds(input.evidenceIds, 'releaseEvidenceIds');
  const requiredCheckKeys: Array<keyof ReturnChecks> = [
    'identity', 'documents', 'conditionAndLife', 'customerRequirements',
  ];
  if (!input.checks || requiredCheckKeys.some((key) => input.checks[key] !== true)) {
    conflict('退货质量放行必须完成全部核对项', 'QUALITY_REVIEW_BLOCKED');
  }
  const requestHash = hash({
    operation: 'release-shipment-return', returnHoldId, snapshotHash: input.snapshotHash,
    evidenceIds: attachments, verifiedSerialNumber: input.verifiedSerialNumber ?? '',
    verifiedBatchNumber: input.verifiedBatchNumber ?? '', checks: input.checks, reason,
  });
  const replay = await checkReleaseIdempotency(input.tx, input.actor, commandId, requestHash);
  if (replay) return replay;

  const state = await loadReleaseState(input.tx, input.actor, returnHoldId);
  if (state.hold.status !== 'QUARANTINED') conflict('退货隔离记录当前不能放行', 'INVALID_STATE_TRANSITION');
  if (state.snapshotHash !== input.snapshotHash) {
    conflict('退货实物、证据或证书已变化，请重新核对', 'QUALITY_REVIEW_STALE');
  }
  assertNotSelfApproval(input.actor, state.hold, state.line, state.order);
  assertVerifiedIdentity(state.identity, input.verifiedSerialNumber, input.verifiedBatchNumber);
  await assertQualityEvidence(input.tx, state.line, state.detail, state.certificates);
  const releaseEvidence = await bindShipmentEvidence(input.tx, input.actor, attachments, state.order.id);
  const detailStatus = String(state.detail.status).toUpperCase();
  const beforeQuantity = state.detail.quantity;
  const expectedAllocatedQuantity = state.detail.allocatedQuantity;
  const serial = serialTracked(state.identity);
  if (detailStatus === 'QUARANTINED' && (beforeQuantity > 0 || expectedAllocatedQuantity > 0)) {
    conflict('已有隔离库存或活动分配，不能与退货放行合并；请建立独立库存明细', 'QUALITY_REVIEW_BLOCKED');
  }
  if (!['AVAILABLE', 'QUARANTINED'].includes(detailStatus)) {
    conflict('当前库存明细状态不能执行退货放行', 'QUALITY_REVIEW_BLOCKED');
  }
  if (serial && (beforeQuantity !== 0 || expectedAllocatedQuantity !== 0)) {
    conflict('序号件退货放行要求当前库存数量和活动分配均为零', 'QUALITY_REVIEW_BLOCKED');
  }
  const afterQuantity = beforeQuantity + state.hold.quantity;
  const releasedAt = new Date();
  const transaction = await db(input.tx).inventoryTransaction.create({
    data: {
      inventoryDetailId: state.detail.id,
      type: 'RETURN',
      quantity: state.hold.quantity,
      beforeQuantity,
      afterQuantity,
      orderId: state.order.id,
      assignmentId: state.line.assignmentId,
      referenceNo: state.hold.id,
      referenceType: 'RETURN',
      notes: reason,
      createdBy: input.actor.id,
    },
  });
  const updatedDetail = await db(input.tx).inventoryDetail.updateMany({
    where: {
      id: state.detail.id,
      quantity: beforeQuantity,
      allocatedQuantity: expectedAllocatedQuantity,
      updatedAt: state.detail.updatedAt,
    },
    data: { quantity: { increment: state.hold.quantity }, status: 'AVAILABLE' },
  });
  if (updatedDetail.count !== 1) conflict('库存明细已被并发修改，请重新核对退货', 'STATE_CONFLICT');
  const updatedHold = await db(input.tx).returnHold.updateMany({
    where: { id: state.hold.id, status: 'QUARANTINED', version: state.hold.version, releaseCommandId: null },
    data: {
      status: 'RELEASED',
      version: { increment: 1 },
      releasedById: input.actor.id,
      releasedAt,
      releaseCommandId: commandId,
      releaseRequestHash: requestHash,
      releaseEvidence: json(releaseEvidence),
      releaseReason: reason,
      returnTransactionId: transaction.id,
    },
  });
  if (updatedHold.count !== 1) conflict('退货隔离记录已被并发处理，请刷新', 'STATE_CONFLICT');
  const event = await db(input.tx).returnEvent.create({
    data: {
      returnHoldId: state.hold.id,
      kind: 'RELEASED',
      quantity: state.hold.quantity,
      commandId,
      eventNo: 1,
      actorId: input.actor.id,
      evidence: json(releaseEvidence),
      reason,
    },
  });
  await enqueueBusinessEvent(input.tx, {
    eventType: 'inventory.return.released',
    aggregateType: 'RETURN_HOLD',
    aggregateId: state.hold.id,
    data: {
      returnHoldId: state.hold.id,
      inventoryDetailId: state.detail.id,
      returnTransactionId: transaction.id,
      status: 'RELEASED',
      version: state.hold.version + 1,
      eventId: event.id,
      commandId,
    },
    createdById: input.actor.id,
  });
  void transaction;
  void event;
  return {
    ...safeHold({
      ...state.hold,
      status: 'RELEASED',
      version: state.hold.version + 1,
      releasedById: input.actor.id,
      releasedAt,
      releaseReason: reason,
      returnTransactionId: transaction.id,
    }),
    replayed: false,
  };
}
