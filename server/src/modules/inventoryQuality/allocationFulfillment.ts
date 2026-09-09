import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { assertSupportedSaleType } from '../../lib/commercialScope.js';
import { hasCapability, normalizeRole, type CapabilityActor } from '../../lib/capabilityPolicy.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { StateTransitionConflictError, transitionOrderStatus } from '../../lib/transactionStateService.js';
import { allocationQuantities } from './allocationQuantities.js';
import { loadAcceptedReceiptCertificates } from '../procurementSettlement/receiptCertificateSources.js';

/**
 * D12's modern fulfillment path deliberately returns only operational facts.
 * In particular, quotation prices, cost prices, customer names and unit cost
 * never enter the review snapshot or the allocation event payload.
 */
const ALLOCATION_CONTEXT_INCLUDE = {
  allocation: {
    include: {
      quotationLine: {
        include: {
          quotation: {
            include: {
              rfq: true,
              creator: { select: { id: true, department: true } },
            },
          },
          rfqLine: true,
        },
      },
      inventoryDetail: { include: { inventoryItem: true, allocations: true } },
      assignments: true,
    },
  },
  orderLine: {
    include: {
      order: {
        include: {
          quotation: {
            include: {
              rfq: true,
              creator: { select: { id: true, department: true } },
            },
          },
        },
      },
      quotationLine: { include: { rfqLine: true } },
    },
  },
} as const satisfies Prisma.AllocationAssignmentInclude;

type AllocationContextRecord = Prisma.AllocationAssignmentGetPayload<{
  include: typeof ALLOCATION_CONTEXT_INCLUDE;
}>;

type AllocationCertificate = {
  id: string;
  certificateNumber: string;
  partNumber: string;
  serialNumber: string | null;
  batchNumber: string | null;
  certificateType: string;
  status: string;
  expiryDate: Date | null;
  fileUrl: string | null;
  fileHash: string | null;
  updatedAt: Date;
};

type AllocationContextWithCertificates = AllocationContextRecord & {
  certificates: AllocationCertificate[];
};

export type AllocationFulfillmentSnapshot = {
  schemaVersion: 1;
  assignment: {
    id: string;
    allocationId: string;
    orderLineId: string;
    version: number;
    assignedQuantity: number;
    releasedQuantity: number;
    consumedQuantity: number;
  };
  allocation: {
    id: string;
    quotationLineId: string;
    inventoryDetailId: string;
    version: number;
    allocatedQuantity: number;
    releasedQuantity: number;
    consumedQuantity: number;
  };
  order: {
    id: string;
    quotationId: string;
    version: number;
    status: string;
    lineItemsMode: boolean;
    customerId: string;
    quantity: number;
    outboundQuantity: number;
    certificateRequired: boolean;
    certificateType: string | null;
    inspectionRequired: boolean;
    saleType: string;
  };
  orderLine: {
    id: string;
    orderId: string;
    lineNo: number;
    quotationLineId: string;
    partNumber: string;
    uom: string;
    quantity: number;
    outboundQuantity: number;
    outboundStatus: string;
    inventoryDetailId: string | null;
    serialNumber: string | null;
    batchNumber: string | null;
    currency: string;
  };
  quotationLine: {
    id: string;
    quotationId: string;
    lineNo: number;
    rfqLineId: string;
    partNumber: string;
    uom: string;
    quantity: number;
    acceptedQuantity: number;
    reservedQuantity: number;
    status: string;
    currency: string;
  };
  rfqLine: {
    id: string;
    rfqId: string;
    lineNo: number;
    partNumber: string;
    quantity: number;
    uom: string;
    conditionCode: string;
    certificateRequired: boolean;
    certificateType: string | null;
    requiredDate: Date;
    status: string;
    updatedAt: Date;
  };
  rfq: {
    id: string;
    version: number;
    lineItemsMode: boolean;
    conditionCode: string;
    certificateRequired: boolean;
    certificateType: string | null;
  };
  inventory: {
    id: string;
    inventoryItemId: string;
    partNumber: string;
    trackingType: string;
    type: string;
    serialNumber: string | null;
    batchNumber: string | null;
    conditionCode: string;
    quantity: number;
    allocatedQuantity: number;
    status: string;
    certificateType: string;
    certificateNumber: string | null;
    certificateFileUrl: string | null;
    lifeLimited: boolean;
    remainingHours: number | null;
    remainingCycles: number | null;
    shelfLifeDate: Date | null;
    shelfLifeDays: number | null;
    nextOverhaulDue: Date | null;
    storageCondition: string | null;
    updatedAt: Date;
    itemUpdatedAt: Date;
  };
  certificates: Array<{
    id: string;
    certificateNumber: string;
    partNumber: string;
    serialNumber: string | null;
    batchNumber: string | null;
    certificateType: string;
    status: string;
    expiryDate: Date | null;
    fileUrl: string | null;
    fileHash: string | null;
    updatedAt: Date;
  }>;
  plannedQuantity: number;
};

export type AllocationFulfillmentContext = AllocationContextWithCertificates & {
  snapshot: AllocationFulfillmentSnapshot;
  snapshotHash: string;
};

export type AllocationEvidenceReference =
  | string
  | { id?: string; fileId?: string; storageKey?: string };

export type AllocationCertificateIdentity = {
  id?: string;
  certificateId?: string;
  certificateNumber?: string;
  certificateType?: string;
  partNumber?: string;
  serialNumber?: string | null;
  batchNumber?: string | null;
  fileHash?: string | null;
};

export type AllocationFulfillmentChecks = {
  identity: boolean;
  documents: boolean;
  conditionAndLife: boolean;
  customerRequirements: boolean;
};

export type AllocationFulfillmentReviewInput = {
  assignmentId: string;
  quantity: number;
  snapshotHash: string;
  approved?: boolean;
  evidenceIds?: string[];
  evidence?: AllocationEvidenceReference[];
  certificateIdentity?: AllocationCertificateIdentity | string;
  verifiedSerialNumber?: string;
  verifiedBatchNumber?: string;
  checks: AllocationFulfillmentChecks;
  reason: string;
};

export type ConsumeAllocatedInventoryInput = {
  tx: Prisma.TransactionClient;
  actor: CapabilityActor;
  assignmentId: string;
  quantity: number;
  reviewId: string;
  commandId: string;
  notes?: string;
};

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

function validation(message: string): never {
  throw new AppError(message, 400, 'VALIDATION_ERROR');
}

function blocked(message: string, code: 'QUALITY_REVIEW_BLOCKED' | 'QUALITY_REVIEW_STALE' | 'QUALITY_REVIEW_REQUIRED' | 'QUALITY_EVIDENCE_INVALID' | 'QUALITY_EVIDENCE_REQUIRED' | 'ALLOCATION_INCONSISTENT' = 'QUALITY_REVIEW_BLOCKED'): never {
  throw new AppError(message, 409, code);
}

function positiveInteger(value: unknown, message: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) validation(message);
}

function sameNullable(left: string | null | undefined, right: string | null | undefined) {
  return (left || '') === (right || '');
}

function parseAlternatePartNumbers(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  } catch {
    // Historical rows use comma/semicolon separated text.
  }
  return value.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean);
}

function isAllowedRfqPart(rfqLine: AllocationContextRecord['allocation']['quotationLine']['rfqLine'], partNumber: string) {
  return partNumber === rfqLine.partNumber || parseAlternatePartNumbers(rfqLine.alternatePartNumbers).includes(partNumber);
}

async function lockRows(tx: Prisma.TransactionClient, ids: {
  orderId: string;
  orderLineId: string;
  allocationId: string;
  assignmentId: string;
  inventoryDetailId: string;
}) {
  // Unit tests use structural transaction doubles. Real PostgreSQL callers
  // receive row locks before the second read and all writes below.
  if (typeof tx.$queryRaw !== 'function') return;
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "orders" WHERE "id" = ${ids.orderId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "order_lines" WHERE "id" = ${ids.orderLineId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "inventory_allocations" WHERE "id" = ${ids.allocationId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "allocation_assignments" WHERE "id" = ${ids.assignmentId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "inventory_details" WHERE "id" = ${ids.inventoryDetailId} FOR UPDATE`);
}

async function findAssignment(tx: Prisma.TransactionClient, assignmentId: string) {
  return tx.allocationAssignment.findUnique({ where: { id: assignmentId }, include: ALLOCATION_CONTEXT_INCLUDE });
}

async function loadCertificates(tx: Prisma.TransactionClient, detailId: string, orderId: string) {
  const directlyLinked = await tx.certificate.findMany({
    where: { OR: [{ inventoryDetailId: detailId }, { orderId }] },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      certificateNumber: true,
      partNumber: true,
      serialNumber: true,
      batchNumber: true,
      certificateType: true,
      status: true,
      expiryDate: true,
      fileUrl: true,
      fileHash: true,
      updatedAt: true,
    },
  });
  const receiptLinked = await loadAcceptedReceiptCertificates(tx, detailId);
  const byId = new Map<string, AllocationCertificate>();
  for (const certificate of directlyLinked) byId.set(certificate.id, certificate);
  for (const certificate of receiptLinked) {
    const previous = byId.get(certificate.id);
    if (previous && previous.fileHash !== certificate.fileHash) {
      throw new AppError('同一证书的当前文件指纹来源不一致', 409, 'ALLOCATION_INCONSISTENT');
    }
    byId.set(certificate.id, certificate);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function buildContext(record: AllocationContextRecord, certificates: AllocationCertificate[], quantity: number): AllocationFulfillmentContext {
  const snapshot = makeSnapshot(record, certificates, quantity);
  const context = Object.assign(record, { certificates, snapshot, snapshotHash: hash(snapshot) }) as AllocationFulfillmentContext;
  // Keep the internal Prisma graph available to the service while preventing
  // accidental JSON serialization of quotation prices/costs by a route.
  Object.defineProperty(context, 'allocation', { value: record.allocation, enumerable: false, writable: false, configurable: true });
  Object.defineProperty(context, 'orderLine', { value: record.orderLine, enumerable: false, writable: false, configurable: true });
  return context;
}

function makeSnapshot(record: AllocationContextRecord, certificates: AllocationCertificate[], quantity: number): AllocationFulfillmentSnapshot {
  const { allocation, orderLine } = record;
  const qLine = allocation.quotationLine;
  const rfqLine = qLine.rfqLine;
  const quotation = qLine.quotation;
  const order = orderLine.order;
  const detail = allocation.inventoryDetail;
  return {
    schemaVersion: 1,
    assignment: {
      id: record.id,
      allocationId: record.allocationId,
      orderLineId: record.orderLineId,
      version: record.version,
      assignedQuantity: record.assignedQuantity,
      releasedQuantity: record.releasedQuantity,
      consumedQuantity: record.consumedQuantity,
    },
    allocation: {
      id: allocation.id,
      quotationLineId: allocation.quotationLineId,
      inventoryDetailId: allocation.inventoryDetailId,
      version: allocation.version,
      allocatedQuantity: allocation.allocatedQuantity,
      releasedQuantity: allocation.releasedQuantity,
      consumedQuantity: allocation.consumedQuantity,
    },
    order: {
      id: order.id,
      quotationId: order.quotationId,
      version: order.version,
      status: order.status,
      lineItemsMode: order.lineItemsMode,
      customerId: order.customerId,
      quantity: order.quantity,
      outboundQuantity: order.outboundQuantity,
      certificateRequired: order.certificateRequired,
      certificateType: order.certificateType,
      inspectionRequired: order.inspectionRequired,
      saleType: order.saleType,
    },
    orderLine: {
      id: orderLine.id,
      orderId: orderLine.orderId,
      lineNo: orderLine.lineNo,
      quotationLineId: orderLine.quotationLineId,
      partNumber: orderLine.partNumber,
      uom: orderLine.uom,
      quantity: orderLine.quantity,
      outboundQuantity: orderLine.outboundQuantity,
      outboundStatus: orderLine.outboundStatus,
      inventoryDetailId: orderLine.inventoryDetailId,
      serialNumber: orderLine.serialNumber,
      batchNumber: orderLine.batchNumber,
      currency: orderLine.currency,
    },
    quotationLine: {
      id: qLine.id,
      quotationId: qLine.quotationId,
      lineNo: qLine.lineNo,
      rfqLineId: qLine.rfqLineId,
      partNumber: qLine.partNumber,
      uom: qLine.uom,
      quantity: qLine.quantity,
      acceptedQuantity: qLine.acceptedQuantity,
      reservedQuantity: qLine.reservedQuantity,
      status: qLine.status,
      currency: qLine.currency,
    },
    rfqLine: {
      id: rfqLine.id,
      rfqId: rfqLine.rfqId,
      lineNo: rfqLine.lineNo,
      partNumber: rfqLine.partNumber,
      quantity: rfqLine.quantity,
      uom: rfqLine.uom,
      conditionCode: rfqLine.conditionCode,
      certificateRequired: rfqLine.certificateRequired,
      certificateType: rfqLine.certificateType,
      requiredDate: rfqLine.requiredDate,
      status: rfqLine.status,
      updatedAt: rfqLine.updatedAt,
    },
    rfq: {
      id: quotation.rfq.id,
      version: quotation.rfq.version,
      lineItemsMode: quotation.rfq.lineItemsMode,
      conditionCode: quotation.rfq.conditionCode,
      certificateRequired: quotation.rfq.certificateRequired,
      certificateType: quotation.rfq.certificateType,
    },
    inventory: {
      id: detail.id,
      inventoryItemId: detail.inventoryItemId,
      partNumber: detail.inventoryItem.partNumber,
      trackingType: detail.inventoryItem.trackingType,
      type: detail.type,
      serialNumber: detail.serialNumber,
      batchNumber: detail.batchNumber,
      conditionCode: detail.conditionCode,
      quantity: detail.quantity,
      allocatedQuantity: detail.allocatedQuantity,
      status: detail.status,
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
      itemUpdatedAt: detail.inventoryItem.updatedAt,
    },
    certificates: certificates.map((certificate) => ({
      id: certificate.id,
      certificateNumber: certificate.certificateNumber,
      partNumber: certificate.partNumber,
      serialNumber: certificate.serialNumber,
      batchNumber: certificate.batchNumber,
      certificateType: certificate.certificateType,
      status: certificate.status,
      expiryDate: certificate.expiryDate,
      fileUrl: certificate.fileUrl,
      fileHash: certificate.fileHash,
      updatedAt: certificate.updatedAt,
    })),
    plannedQuantity: quantity,
  };
}

function assertQuantityFacts(record: AllocationContextRecord, quantity: number, detailAllocations: Array<{ allocatedQuantity: number; releasedQuantity: number; consumedQuantity: number; id?: string }>) {
  const { allocation, orderLine } = record;
  const assignmentSummary = allocationQuantities({
    allocatedQuantity: allocation.allocatedQuantity,
    releasedQuantity: allocation.releasedQuantity,
    consumedQuantity: allocation.consumedQuantity,
    assignments: allocation.assignments ?? [record],
  });
  const detailActive = detailAllocations.reduce((sum, row) => sum + row.allocatedQuantity - row.releasedQuantity - row.consumedQuantity, 0);
  if (detailActive < 0 || record.allocation.inventoryDetail.allocatedQuantity !== detailActive) {
    blocked('库存明细的活动分配投影与 Allocation 事实不一致', 'ALLOCATION_INCONSISTENT');
  }
  const assignmentActive = record.assignedQuantity - record.releasedQuantity - record.consumedQuantity;
  const allocationActive = allocation.allocatedQuantity - allocation.releasedQuantity - allocation.consumedQuantity;
  if (assignmentActive < quantity || allocationActive < quantity || assignmentSummary.assignedActiveQuantity < quantity) {
    blocked('本次计划数量超过该分配的活动数量', 'QUALITY_REVIEW_BLOCKED');
  }
  if (orderLine.quantity - orderLine.outboundQuantity < quantity) {
    blocked('计划数量超过订单行待出库数量', 'QUALITY_REVIEW_BLOCKED');
  }
  if (record.allocation.inventoryDetail.quantity < quantity) {
    blocked('实物当前数量不足', 'QUALITY_REVIEW_BLOCKED');
  }
}

function assertChain(record: AllocationContextRecord) {
  const { allocation, orderLine } = record;
  const qLine = allocation.quotationLine;
  const rfqLine = qLine.rfqLine;
  const order = orderLine.order;
  const detail = allocation.inventoryDetail;
  if (allocation.inventoryDetailId !== detail.id || allocation.quotationLineId !== qLine.id) blocked('Allocation来源关系不一致', 'ALLOCATION_INCONSISTENT');
  if (record.orderLineId !== orderLine.id || orderLine.orderId !== order.id) blocked('Allocation订单行关系不一致', 'ALLOCATION_INCONSISTENT');
  if (orderLine.quotationLineId !== qLine.id || qLine.quotationId !== order.quotationId) blocked('订单行与报价行不一致', 'ALLOCATION_INCONSISTENT');
  if (qLine.rfqLineId !== rfqLine.id || rfqLine.rfqId !== qLine.quotation.rfqId) blocked('报价行与 RFQ 需求行不一致', 'ALLOCATION_INCONSISTENT');
  if (qLine.partNumber !== orderLine.partNumber || detail.inventoryItem.partNumber !== orderLine.partNumber) blocked('订单行、报价行与实物件号不一致', 'QUALITY_REVIEW_BLOCKED');
  if (!isAllowedRfqPart(rfqLine, qLine.partNumber)) blocked('报价行件号不属于当前 RFQ 需求行', 'QUALITY_REVIEW_BLOCKED');
  if (orderLine.quantity <= 0 || qLine.acceptedQuantity < orderLine.quantity || qLine.quantity < qLine.acceptedQuantity) blocked('订单行成交数量与报价行不一致', 'QUALITY_REVIEW_BLOCKED');
  if (order.quotation.id !== qLine.quotationId) blocked('订单与报价来源不一致', 'ALLOCATION_INCONSISTENT');
  if (order.quotation.rfqId !== rfqLine.rfqId) blocked('订单报价与 RFQ 需求来源不一致', 'ALLOCATION_INCONSISTENT');
  if (qLine.currency !== 'USD' || orderLine.currency !== 'USD' || order.quotation.currency !== 'USD') blocked('履约交易仅支持 USD', 'QUALITY_REVIEW_BLOCKED');
  assertSupportedSaleType(order.saleType);
  if (String(detail.type).toUpperCase() !== 'OWN') blocked('首期履约仅支持自有库存', 'QUALITY_REVIEW_BLOCKED');
}

function assertQualityFacts(record: AllocationContextRecord, quantity: number, certificates: AllocationCertificate[], now = new Date()) {
  const { allocation, orderLine } = record;
  const order = orderLine.order;
  const qLine = allocation.quotationLine;
  const rfqLine = qLine.rfqLine;
  const detail = allocation.inventoryDetail;
  assertChain(record);
  if (!['SO_CREATED', 'PO_CREATED'].includes(order.status)) blocked('当前订单不可出库');
  if (!['AVAILABLE', 'RESERVED'].includes(detail.status)) blocked('库存处于不可交付状态');
  if (detail.conditionCode !== rfqLine.conditionCode) blocked('实物状态与客户需求不一致，请先复核需求');
  // A modern order line may intentionally leave serial/batch open while the
  // concrete assignment selects one. Only an explicit requirement is a
  // mismatch; the assignment snapshot and quality evidence bind the chosen
  // detail when the line itself is open.
  const requiredSerialNumber = orderLine.serialNumber || qLine.serialNumber || rfqLine.serialNumber;
  const requiredBatchNumber = orderLine.batchNumber || qLine.batchNumber || rfqLine.batchNumber;
  if (requiredSerialNumber && !sameNullable(requiredSerialNumber, detail.serialNumber)) blocked('订单行序号与实物不一致');
  if (requiredBatchNumber && !sameNullable(requiredBatchNumber, detail.batchNumber)) blocked('订单行批次与实物不一致');
  if (detail.inventoryItem.trackingType === 'SERIAL' || detail.serialNumber) {
    if (!detail.serialNumber || detail.quantity !== 1 || quantity !== 1) blocked('序号跟踪件必须有唯一序号且按一件出库');
  }
  if (detail.shelfLifeDays != null && !detail.shelfLifeDate) blocked('受货架期控制的实物缺少到期日期');
  if (detail.shelfLifeDate && detail.shelfLifeDate.getTime() <= now.getTime()) blocked('实物已超过货架期');
  if (detail.nextOverhaulDue && detail.nextOverhaulDue.getTime() <= now.getTime()) blocked('实物已超过下次检修期限');
  if (detail.lifeLimited) {
    if (detail.remainingHours == null && detail.remainingCycles == null) blocked('寿命限制件缺少剩余寿命记录');
    if ((detail.remainingHours != null && detail.remainingHours <= 0) || (detail.remainingCycles != null && detail.remainingCycles <= 0)) blocked('实物剩余寿命不合格');
  }
  if (order.certificateRequired || qLine.rfqLine.certificateRequired || order.inspectionRequired) {
    const usableCertificate = certificates.some((certificate) => {
      const status = certificate.status.trim().toUpperCase();
      const normalizeType = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const requiredTypes = [order.certificateRequired ? order.certificateType : null,
        rfqLine.certificateRequired ? rfqLine.certificateType : null].filter((value): value is string => Boolean(value));
      return !['REVOKED', 'EXPIRED', 'VOID', 'REJECTED'].includes(status)
        && (!certificate.expiryDate || certificate.expiryDate.getTime() > now.getTime())
        && certificate.partNumber === detail.inventoryItem.partNumber
        && sameNullable(certificate.serialNumber, detail.serialNumber)
        && sameNullable(certificate.batchNumber, detail.batchNumber)
        && requiredTypes.every(type => normalizeType(type) === normalizeType(certificate.certificateType));
    });
    if (!usableCertificate) blocked('本次交付缺少有效证书或检验依据', 'QUALITY_EVIDENCE_REQUIRED');
  }
}

async function readContext(tx: Prisma.TransactionClient, assignmentId: string): Promise<AllocationFulfillmentContext> {
  const assignment = await findAssignment(tx, assignmentId);
  if (!assignment) throw new AppError('库存分配任务不存在', 404, 'RESOURCE_NOT_FOUND');
  const certificates = await loadCertificates(tx, assignment.allocation.inventoryDetailId, assignment.orderLine.orderId);
  return buildContext(assignment, certificates, 1);
}

/**
 * Read the current public facts for one assignment and planned quantity.
 * Callers that will mutate the assignment must lock/re-read first using the
 * transaction helpers below; this function itself is a read contract.
 */
export async function getAllocationFulfillmentContext(
  tx: Prisma.TransactionClient,
  assignmentId: string,
  quantity: number,
) {
  positiveInteger(quantity, '出库数量必须为正整数');
  const assignment = await findAssignment(tx, assignmentId);
  if (!assignment) throw new AppError('库存分配任务不存在', 404, 'RESOURCE_NOT_FOUND');
  const certificates = await loadCertificates(tx, assignment.allocation.inventoryDetailId, assignment.orderLine.orderId);
  return buildContext(assignment, certificates, quantity);
}

async function lockAndReadContext(tx: Prisma.TransactionClient, assignmentId: string, quantity: number) {
  const first = await findAssignment(tx, assignmentId);
  if (!first) throw new AppError('库存分配任务不存在', 404, 'RESOURCE_NOT_FOUND');
  await lockRows(tx, {
    orderId: first.orderLine.orderId,
    orderLineId: first.orderLineId,
    allocationId: first.allocationId,
    assignmentId: first.id,
    inventoryDetailId: first.allocation.inventoryDetailId,
  });
  return getAllocationFulfillmentContext(tx, assignmentId, quantity);
}

async function getEvidence(tx: Prisma.TransactionClient, references: AllocationEvidenceReference[]) {
  const ids = new Set<string>();
  const objectKeys = new Set<string>();
  for (const reference of references) {
    if (typeof reference === 'string' && reference.trim()) ids.add(reference.trim());
    else if (reference && typeof reference === 'object') {
      if (reference.id?.trim()) ids.add(reference.id.trim());
      if (reference.fileId?.trim()) ids.add(reference.fileId.trim());
      if (reference.storageKey?.trim()) objectKeys.add(reference.storageKey.trim());
    }
  }
  if (ids.size === 0 && objectKeys.size === 0) return [];
  const records = await tx.storedObject.findMany({
    where: {
      OR: [
        ...(ids.size ? [{ id: { in: [...ids] } }] : []),
        ...(objectKeys.size ? [{ objectKey: { in: [...objectKeys] } }] : []),
      ],
    },
    orderBy: { id: 'asc' },
  });
  const requestedCount = ids.size + objectKeys.size;
  if (records.length !== requestedCount || records.some((record) => record.status !== 'AVAILABLE' || !record.sha256 || record.version <= 0)) {
    throw new AppError('审核证据不存在、已撤销或校验信息无效', 409, 'QUALITY_EVIDENCE_INVALID');
  }
  return records;
}

function evidenceSnapshot(records: Array<{ id: string; version: number; sha256: string; status: string }>) {
  return records.map(({ id, version, sha256, status }) => ({ id, version, sha256, status }));
}

function assertCertificateIdentity(
  identity: AllocationCertificateIdentity | string | undefined,
  certificates: AllocationCertificate[],
  detail: AllocationContextRecord['allocation']['inventoryDetail'],
  now = new Date(),
) {
  if (!identity) return;
  const expected = typeof identity === 'string' ? { id: identity } : identity;
  const found = certificates.find((certificate) =>
    (expected.id && certificate.id === expected.id)
    || (expected.certificateId && certificate.id === expected.certificateId)
    || (expected.certificateNumber && certificate.certificateNumber === expected.certificateNumber),
  );
  if (!found) blocked('证书身份与当前订单实物不一致', 'QUALITY_EVIDENCE_INVALID');
  const status = found.status.trim().toUpperCase();
  if (['REVOKED', 'EXPIRED', 'VOID', 'REJECTED'].includes(status) || (found.expiryDate && found.expiryDate.getTime() <= now.getTime())) {
    blocked('当前证书已失效，不能用于出库审核', 'QUALITY_EVIDENCE_INVALID');
  }
  if (expected.certificateType && expected.certificateType !== found.certificateType) blocked('证书类型与当前实物不一致', 'QUALITY_EVIDENCE_INVALID');
  if (expected.partNumber && expected.partNumber !== found.partNumber) blocked('证书件号与当前实物不一致', 'QUALITY_EVIDENCE_INVALID');
  if (expected.serialNumber !== undefined && !sameNullable(expected.serialNumber, found.serialNumber)) blocked('证书序号与当前实物不一致', 'QUALITY_EVIDENCE_INVALID');
  if (expected.batchNumber !== undefined && !sameNullable(expected.batchNumber, found.batchNumber)) blocked('证书批次与当前实物不一致', 'QUALITY_EVIDENCE_INVALID');
  if (expected.fileHash !== undefined && (expected.fileHash || null) !== (found.fileHash || null)) blocked('证书文件指纹已变化', 'QUALITY_REVIEW_STALE');
  if (!sameNullable(found.serialNumber, detail.serialNumber) || !sameNullable(found.batchNumber, detail.batchNumber)) blocked('证书身份与实物序号或批次不一致', 'QUALITY_EVIDENCE_INVALID');
}

function evidenceReferencesFromInput(input: AllocationFulfillmentReviewInput): AllocationEvidenceReference[] {
  return [
    ...(input.evidenceIds ?? []),
    ...(input.evidence ?? []),
  ];
}

export async function createAllocationFulfillmentReview(
  tx: Prisma.TransactionClient,
  input: AllocationFulfillmentReviewInput,
  actor: CapabilityActor,
) {
  if (!hasCapability(actor, 'quality_review', 'approve')) throw new AppError('需要质量审核权限', 403, 'AUTH_FORBIDDEN');
  if (!input || typeof input.assignmentId !== 'string' || !input.assignmentId.trim()) validation('缺少库存分配任务');
  positiveInteger(input.quantity, '审核数量必须为正整数');
  if (!/^[a-f0-9]{64}$/i.test(input.snapshotHash)) validation('审核快照指纹无效');
  if (!input.reason?.trim()) validation('请记录审核依据及不适用项理由');
  const context = await lockAndReadContext(tx, input.assignmentId, input.quantity);
  const ownerContext = {
    ownerId: context.orderLine.order.quotation.createdBy,
    department: context.orderLine.order.quotation.creator.department,
  };
  if (!hasCapability(actor, 'quality_review', 'approve', ownerContext) || !hasCapability(actor, 'order', 'read', ownerContext)) {
    throw new AppError('当前用户无权审核该订单归属范围', 403, 'AUTH_FORBIDDEN');
  }
  assertChain(context);
  assertQuantityFacts(context, input.quantity, context.allocation.inventoryDetail.allocations ?? [context.allocation]);
  const approved = input.approved !== false;
  if (approved) assertQualityFacts(context, input.quantity, context.certificates);
  if (context.snapshotHash !== input.snapshotHash) blocked('订单、行、实物或证书已变化，请重新核对', 'QUALITY_REVIEW_STALE');
  if (actor.id === context.orderLine.order.quotation.createdBy || actor.id === context.allocation.createdById || actor.id === context.createdById) {
    throw new AppError('业务经办人或分配创建者不能审核自己的交付', 403, 'SELF_APPROVAL_FORBIDDEN');
  }
  const checks = input.checks;
  if (!checks || Object.values(checks).some((checked) => typeof checked !== 'boolean')) validation('质量核对项不完整');
  if (approved) {
    if (Object.values(checks).some((checked) => checked !== true)) blocked('请完成所有适用核对并说明不适用项');
    if ((input.verifiedSerialNumber ?? '').trim() !== (context.allocation.inventoryDetail.serialNumber || '') || (input.verifiedBatchNumber ?? '').trim() !== (context.allocation.inventoryDetail.batchNumber || '')) {
      blocked('交付文件上的序号或批次与实物不一致');
    }
    assertCertificateIdentity(input.certificateIdentity, context.certificates, context.allocation.inventoryDetail);
  }
  const evidence = await getEvidence(tx, evidenceReferencesFromInput(input));
  if (evidence.some((record) => record.ownerId !== actor.id && normalizeRole(actor.role) !== 'admin')) {
    throw new AppError('只能使用本人可访问的审核附件', 403, 'AUTH_FORBIDDEN');
  }
  if (approved && (context.orderLine.order.certificateRequired || context.allocation.quotationLine.rfqLine.certificateRequired || context.orderLine.order.inspectionRequired) && evidence.length === 0) {
    blocked('请上传本次交付所需的证书或检验依据', 'QUALITY_EVIDENCE_REQUIRED');
  }
  return tx.fulfillmentReview.create({
    data: {
      orderId: context.orderLine.order.id,
      inventoryDetailId: context.allocation.inventoryDetail.id,
      assignmentId: context.id,
      quantity: input.quantity,
      approved,
      snapshotHash: context.snapshotHash,
      snapshot: json(context.snapshot),
      evidence: json(evidenceSnapshot(evidence)),
      checks: json(checks),
      reason: input.reason.trim(),
      reviewedById: actor.id,
    },
  });
}

function parseStoredEvidence(value: unknown): Array<{ id: string; version: number; sha256: string; status: string }> {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object')) {
    blocked('质量审核证据记录无效', 'QUALITY_REVIEW_STALE');
  }
  return value.map((item) => {
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.version !== 'number' || typeof row.sha256 !== 'string' || typeof row.status !== 'string') {
      blocked('质量审核证据记录无效', 'QUALITY_REVIEW_STALE');
    }
    return { id: row.id, version: row.version, sha256: row.sha256, status: row.status };
  });
}

async function assertReviewStillValid(tx: Prisma.TransactionClient, context: AllocationFulfillmentContext, reviewId: string, quantity: number) {
  const review = await tx.fulfillmentReview.findUnique({ where: { id: reviewId } });
  if (!review || review.assignmentId !== context.id || review.orderId !== context.orderLine.order.id || review.inventoryDetailId !== context.allocation.inventoryDetail.id || !review.approved || review.consumedAt || review.quantity !== quantity) {
    blocked('本次出库尚无该分配数量对应的有效质量审核', 'QUALITY_REVIEW_REQUIRED');
  }
  if (review.snapshotHash !== context.snapshotHash) blocked('审核后订单行、分配、实物或证书资料已变化，请重新审核', 'QUALITY_REVIEW_STALE');
  const evidence = parseStoredEvidence(review.evidence);
  let currentEvidence;
  try {
    currentEvidence = await getEvidence(tx, evidence.map((item) => item.id));
  } catch (error) {
    if (error instanceof AppError && error.code === 'QUALITY_EVIDENCE_INVALID') blocked('审核附件已撤销或校验信息已变化，请重新审核', 'QUALITY_REVIEW_STALE');
    throw error;
  }
  if (hash(evidenceSnapshot(currentEvidence)) !== hash(evidence)) blocked('审核附件版本已变化，请重新审核', 'QUALITY_REVIEW_STALE');
  return review;
}

type OrderLineProjection = { id: string; quantity: number; outboundQuantity: number; outboundStatus: string };

async function getOrderLineProjectionRows(tx: Prisma.TransactionClient, orderId: string, pending?: { orderLineId: string; quantity: number }) {
  const lines = await tx.orderLine.findMany({
    where: { orderId },
    select: { id: true, quantity: true, outboundQuantity: true, outboundStatus: true },
    orderBy: { lineNo: 'asc' },
  });
  if (lines.length === 0) blocked('订单缺少订单行，不能执行分配出库', 'ALLOCATION_INCONSISTENT');
  const assignments = await tx.allocationAssignment.findMany({
    where: { orderLineId: { in: lines.map((line) => line.id) } },
    select: { orderLineId: true, assignedQuantity: true, releasedQuantity: true, consumedQuantity: true },
  });
  const consumedByLine = new Map<string, number>();
  for (const assignment of assignments) {
    consumedByLine.set(assignment.orderLineId, (consumedByLine.get(assignment.orderLineId) ?? 0) + assignment.consumedQuantity);
  }
  for (const line of lines) {
    const consumed = consumedByLine.get(line.id) ?? 0;
    const expectedOutbound = line.id === pending?.orderLineId ? line.outboundQuantity + pending.quantity : line.outboundQuantity;
    if (consumed !== expectedOutbound || consumed > line.quantity) blocked('订单行出库投影与 Allocation 消费事实不一致', 'ALLOCATION_INCONSISTENT');
  }
  return { lines, consumedByLine };
}

async function updateOrderProjections(
  tx: Prisma.TransactionClient,
  context: AllocationFulfillmentContext,
  actor: CapabilityActor,
  quantity: number,
  notes: string | undefined,
) {
  const projection = await getOrderLineProjectionRows(tx, context.orderLine.orderId, { orderLineId: context.orderLine.id, quantity });
  const currentTotalOutbound = projection.lines.reduce((sum, line) => sum + line.outboundQuantity, 0);
  const currentTotalQuantity = projection.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (currentTotalOutbound !== context.orderLine.order.outboundQuantity || currentTotalQuantity !== context.orderLine.order.quantity) {
    blocked('订单头与订单行出库投影不一致', 'ALLOCATION_INCONSISTENT');
  }
  // The child assignment has already been incremented in this transaction;
  // the current assignment sum is therefore the next line projection.
  const targetConsumed = projection.consumedByLine.get(context.orderLine.id) ?? 0;
  if (targetConsumed > context.orderLine.quantity) blocked('订单行出库数量超过成交数量', 'QUALITY_REVIEW_BLOCKED');
  const targetStatus = targetConsumed === context.orderLine.quantity ? 'COMPLETED' : 'PARTIAL';
  const updatedLine = await tx.orderLine.updateMany({
    where: { id: context.orderLine.id, orderId: context.orderLine.orderId, outboundQuantity: context.orderLine.outboundQuantity },
    data: { outboundQuantity: targetConsumed, outboundStatus: targetStatus },
  });
  if (updatedLine.count !== 1) throw new StateTransitionConflictError();

  const nextLines = projection.lines.map((line) => line.id === context.orderLine.id
    ? { ...line, outboundQuantity: targetConsumed, outboundStatus: targetStatus }
    : line);
  const totalOutbound = nextLines.reduce((sum, line) => sum + line.outboundQuantity, 0);
  const totalQuantity = nextLines.reduce((sum, line) => sum + line.quantity, 0);
  if (totalOutbound > totalQuantity || totalOutbound > context.orderLine.order.quantity) blocked('订单累计出库数量无效', 'ALLOCATION_INCONSISTENT');
  const allLinesComplete = nextLines.every((line) => line.outboundQuantity === line.quantity);
  const nextOutboundStatus = totalOutbound === 0 ? 'PENDING' : allLinesComplete ? 'COMPLETED' : 'PARTIAL';
  const order = context.orderLine.order;
  if (allLinesComplete) {
    return transitionOrderStatus(tx, {
      id: order.id,
      currentStatus: order.status,
      currentVersion: order.version,
      nextStatus: 'SHIPPED',
      actorId: actor.id,
      reasonCode: 'ALLOCATION_OUTBOUND_COMPLETED',
      reason: notes?.trim() || 'All allocated order lines were fulfilled.',
      data: { outboundQuantity: totalOutbound, outboundStatus: nextOutboundStatus },
    });
  }
  const result = await tx.order.updateMany({
    where: { id: order.id, status: order.status, version: order.version },
    data: { outboundQuantity: totalOutbound, outboundStatus: nextOutboundStatus, version: { increment: 1 } },
  });
  if (result.count !== 1) throw new StateTransitionConflictError();
  return {
    ...order,
    outboundQuantity: totalOutbound,
    outboundStatus: nextOutboundStatus,
    version: order.version + 1,
  };
}

/**
 * Consume one assignment quantity after a quality review. The caller must run
 * this in a Serializable transaction; row locks and optimistic versions make
 * a direct retry safe only when the caller's idempotency layer replays it.
 */
export async function consumeAllocatedInventory(input: ConsumeAllocatedInventoryInput) {
  const { tx, actor, assignmentId, quantity, reviewId, commandId, notes } = input;
  if (!commandId?.trim()) validation('缺少出库幂等命令号');
  positiveInteger(quantity, '出库数量必须为正整数');
  if (!hasCapability(actor, 'inventory', 'manage')) throw new AppError('需要库存出库权限', 403, 'AUTH_FORBIDDEN');
  const context = await lockAndReadContext(tx, assignmentId, quantity);
  const ownerContext = { ownerId: context.orderLine.order.quotation.createdBy, department: context.orderLine.order.quotation.creator.department };
  if (!hasCapability(actor, 'inventory', 'manage', ownerContext) || !hasCapability(actor, 'order', 'read', ownerContext)) {
    throw new AppError('当前用户无权处理该订单归属范围', 403, 'AUTH_FORBIDDEN');
  }
  const detailAllocations = context.allocation.inventoryDetail.allocations ?? [context.allocation];
  assertQuantityFacts(context, quantity, detailAllocations);
  assertQualityFacts(context, quantity, context.certificates);
  await assertReviewStillValid(tx, context, reviewId, quantity);

  const assignmentBefore = context;
  const allocationBefore = context.allocation;
  const assignmentVersionBefore = assignmentBefore.version;
  const assignmentConsumedBefore = assignmentBefore.consumedQuantity;
  const allocationVersionBefore = allocationBefore.version;
  const allocationConsumedBefore = allocationBefore.consumedQuantity;
  const assignmentAfterConsumed = assignmentConsumedBefore + quantity;
  const allocationAfterConsumed = allocationConsumedBefore + quantity;
  if (assignmentBefore.releasedQuantity + assignmentAfterConsumed > assignmentBefore.assignedQuantity) blocked('订单分配消费数量超过计划数量', 'QUALITY_REVIEW_BLOCKED');
  if (allocationBefore.releasedQuantity + allocationAfterConsumed > allocationBefore.allocatedQuantity) blocked('库存来源消费数量超过分配数量', 'QUALITY_REVIEW_BLOCKED');

  const currentAssignments = allocationBefore.assignments ?? [assignmentBefore];
  const nextAssignments = currentAssignments.map((assignment) => assignment.id === assignmentBefore.id
    ? { ...assignment, consumedQuantity: assignmentAfterConsumed }
    : assignment);
  allocationQuantities({
    allocatedQuantity: allocationBefore.allocatedQuantity,
    releasedQuantity: allocationBefore.releasedQuantity,
    consumedQuantity: allocationAfterConsumed,
    assignments: nextAssignments,
  });
  const nextDetailAllocatedQuantity = allocationBefore.inventoryDetail.allocatedQuantity - quantity;
  const detailActiveAfter = detailAllocations.reduce((sum, row) => {
    const consumed = row.id === allocationBefore.id ? row.consumedQuantity + quantity : row.consumedQuantity;
    return sum + row.allocatedQuantity - row.releasedQuantity - consumed;
  }, 0);
  if (nextDetailAllocatedQuantity !== detailActiveAfter || nextDetailAllocatedQuantity < 0) blocked('库存明细活动分配投影更新不一致', 'ALLOCATION_INCONSISTENT');

  const parentUpdate = await tx.inventoryAllocation.updateMany({
    where: {
      id: allocationBefore.id,
      version: allocationBefore.version,
      consumedQuantity: allocationBefore.consumedQuantity,
      releasedQuantity: allocationBefore.releasedQuantity,
    },
    data: { consumedQuantity: allocationAfterConsumed, version: { increment: 1 } },
  });
  if (parentUpdate.count !== 1) throw new StateTransitionConflictError();
  const assignmentUpdate = await tx.allocationAssignment.updateMany({
    where: {
      id: assignmentBefore.id,
      allocationId: allocationBefore.id,
      version: assignmentBefore.version,
      consumedQuantity: assignmentBefore.consumedQuantity,
      releasedQuantity: assignmentBefore.releasedQuantity,
    },
    data: { consumedQuantity: assignmentAfterConsumed, version: { increment: 1 } },
  });
  if (assignmentUpdate.count !== 1) throw new StateTransitionConflictError();

  const detailBeforeQuantity = allocationBefore.inventoryDetail.quantity;
  const detailUpdate = await tx.inventoryDetail.updateMany({
    where: {
      id: allocationBefore.inventoryDetail.id,
      quantity: detailBeforeQuantity,
      allocatedQuantity: allocationBefore.inventoryDetail.allocatedQuantity,
      updatedAt: allocationBefore.inventoryDetail.updatedAt,
    },
    data: { quantity: { decrement: quantity }, allocatedQuantity: { decrement: quantity } },
  });
  if (detailUpdate.count !== 1) throw new StateTransitionConflictError();

  const transaction = await tx.inventoryTransaction.create({
    data: {
      inventoryDetailId: allocationBefore.inventoryDetail.id,
      type: 'OUTBOUND',
      quantity: -quantity,
      beforeQuantity: detailBeforeQuantity,
      afterQuantity: detailBeforeQuantity - quantity,
      orderId: assignmentBefore.orderLine.orderId,
      quotationId: assignmentBefore.orderLine.order.quotationId,
      allocationId: allocationBefore.id,
      assignmentId: assignmentBefore.id,
      fulfillmentReviewId: reviewId,
      referenceNo: assignmentBefore.orderLine.order.orderNumber,
      referenceType: 'ORDER',
      notes: notes?.trim() || null,
      createdBy: actor.id,
    },
  });

  const eventBefore = {
    allocationId: allocationBefore.id,
    assignmentId: assignmentBefore.id,
    quantity: { allocated: allocationBefore.allocatedQuantity, released: allocationBefore.releasedQuantity, consumed: allocationConsumedBefore },
    version: allocationVersionBefore,
  };
  const eventAfter = {
    allocationId: allocationBefore.id,
    assignmentId: assignmentBefore.id,
    quantity: { allocated: allocationBefore.allocatedQuantity, released: allocationBefore.releasedQuantity, consumed: allocationConsumedBefore + quantity },
    version: allocationVersionBefore + 1,
  };
  const event = await tx.inventoryAllocationEvent.create({
    data: {
      allocationId: allocationBefore.id,
      assignmentId: assignmentBefore.id,
      kind: 'CONSUME',
      quantity,
      before: json(eventBefore),
      after: json(eventAfter),
      commandId,
      eventNo: 1,
      actorId: actor.id,
    },
  });

  const updatedOrder = await updateOrderProjections(tx, context, actor, quantity, notes);
  await tx.fulfillmentReview.updateMany({
    where: { id: reviewId, assignmentId: assignmentBefore.id, consumedAt: null, quantity, snapshotHash: context.snapshotHash },
    data: { consumedAt: new Date() },
  }).then((result) => {
    if (result.count !== 1) throw new AppError('本次质量审核已被其他出库操作使用，请刷新', 409, 'RESOURCE_CONFLICT');
  });

  await enqueueBusinessEvent(tx, {
    eventType: 'inventory.allocation.consumed',
    aggregateType: 'INVENTORY_ALLOCATION',
    aggregateId: allocationBefore.id,
    data: {
      allocationId: allocationBefore.id,
      assignmentId: assignmentBefore.id,
      quotationLineId: allocationBefore.quotationLineId,
      orderLineId: assignmentBefore.orderLineId,
      inventoryDetailId: allocationBefore.inventoryDetailId,
      kind: 'CONSUME',
      quantity,
      before: eventBefore,
      after: eventAfter,
      allocationVersion: allocationVersionBefore + 1,
      assignmentVersion: assignmentVersionBefore + 1,
      transactionId: transaction.id,
      eventId: event.id,
      refresh: true,
    },
    socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED, scope: { capability: 'inventory.read' } },
    createdById: actor.id,
  });

  const publicOrder = {
    id: updatedOrder.id,
    status: updatedOrder.status,
    version: updatedOrder.version,
    outboundQuantity: updatedOrder.outboundQuantity,
    outboundStatus: updatedOrder.outboundStatus,
  };
  return {
    transaction,
    event,
    order: publicOrder,
    assignmentId: assignmentBefore.id,
    allocationId: allocationBefore.id,
    inventoryDetailId: allocationBefore.inventoryDetail.id,
    quantity,
    beforeQuantity: detailBeforeQuantity,
    afterQuantity: detailBeforeQuantity - quantity,
    allocationVersion: allocationVersionBefore + 1,
    assignmentVersion: assignmentVersionBefore + 1,
  };
}
