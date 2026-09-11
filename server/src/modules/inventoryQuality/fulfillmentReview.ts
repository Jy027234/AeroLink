import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { assertSupportedSaleType } from '../../lib/commercialScope.js';
import { hasCapability, type CapabilityActor } from '../../lib/capabilityPolicy.js';

function hash(value: unknown) {
  // PostgreSQL JSONB does not preserve object-key order.
  const canonical = (input: unknown): unknown => {
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    }
    return input;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function getFulfillmentReviewContext(tx: Prisma.TransactionClient, orderId: string, quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new AppError('出库数量必须为正整数', 400, 'VALIDATION_ERROR');
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { quotation: { include: { rfq: true, creator: { select: { department: true } } } } },
  });
  if (!order) throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
  if (order.lineItemsMode) throw new AppError('多行订单须使用行级实物分配与质量审核，整单审核入口尚不适用', 409, 'QUALITY_REVIEW_REQUIRED');
  if (!order.inventoryDetailId) throw new AppError('请先为订单预留库存', 409, 'QUALITY_REVIEW_REQUIRED');
  const detail = await tx.inventoryDetail.findUnique({
    where: { id: order.inventoryDetailId }, include: { inventoryItem: true },
  });
  if (!detail) throw new AppError('库存明细不存在', 404, 'RESOURCE_NOT_FOUND');
  const certificates = await tx.certificate.findMany({
    where: { OR: [{ inventoryDetailId: detail.id }, { orderId }] },
    orderBy: { id: 'asc' },
    select: {
      id: true, partNumber: true, serialNumber: true, batchNumber: true,
      certificateType: true, status: true, expiryDate: true,
      fileUrl: true, fileHash: true, updatedAt: true,
    },
  });
  const snapshot = {
    order: {
      id: order.id, version: order.version, partNumber: order.partNumber,
      customerId: order.customerId, quantity: order.quantity, outboundQuantity: order.outboundQuantity,
      status: order.status, serialNumber: order.serialNumber, batchNumber: order.batchNumber,
      certificateRequired: order.certificateRequired, certificateType: order.certificateType,
      inspectionRequired: order.inspectionRequired,
    },
    requirements: {
      rfqId: order.quotation.rfqId, rfqVersion: order.quotation.rfq.version,
      certificateRequired: order.quotation.rfq.certificateRequired,
      certificateType: order.quotation.rfq.certificateType,
      conditionCode: order.quotation.rfq.conditionCode,
      quotationId: order.quotationId, quotationVersion: order.quotation.version,
      certificateFiles: order.quotation.certificateFiles,
      inspectionStandard: order.quotation.inspectionStandard,
    },
    inventory: {
      id: detail.id, partNumber: detail.inventoryItem.partNumber,
      trackingType: detail.inventoryItem.trackingType, serialNumber: detail.serialNumber,
      batchNumber: detail.batchNumber, conditionCode: detail.conditionCode,
      quantity: detail.quantity, status: detail.status, updatedAt: detail.updatedAt,
      itemUpdatedAt: detail.inventoryItem.updatedAt,
      certificateType: detail.certificateType, certificateNumber: detail.certificateNumber,
      certificateFileUrl: detail.certificateFileUrl, traceabilityDocs: detail.traceabilityDocs,
      lifeLimited: detail.lifeLimited, remainingHours: detail.remainingHours,
      remainingCycles: detail.remainingCycles, shelfLifeDate: detail.shelfLifeDate,
      shelfLifeDays: detail.shelfLifeDays, nextOverhaulDue: detail.nextOverhaulDue,
      storageCondition: detail.storageCondition,
    },
    certificates,
    plannedQuantity: quantity,
  };
  return { snapshot, snapshotHash: hash(snapshot), order, detail };
}

export function assertFulfillmentFacts(context: Awaited<ReturnType<typeof getFulfillmentReviewContext>>, now = new Date()) {
  const { order, detail, snapshot } = context;
  assertSupportedSaleType(order.saleType);
  const fail = (message: string) => { throw new AppError(message, 409, 'QUALITY_REVIEW_BLOCKED'); };
  if (!['SO_CREATED', 'PO_CREATED'].includes(order.status)) fail('当前订单不可出库');
  if (order.quotation.inventoryDetailId !== detail.id || order.partNumber !== detail.inventoryItem.partNumber) fail('订单与实物绑定不一致');
  if (!['AVAILABLE', 'RESERVED'].includes(detail.status)) fail('库存处于不可交付状态');
  if (snapshot.plannedQuantity > detail.quantity || snapshot.plannedQuantity > order.quantity - order.outboundQuantity) fail('计划数量超过可交付数量');
  if (detail.conditionCode !== order.quotation.rfq.conditionCode) fail('实物状态与客户需求不一致，请先复核需求');
  if ((order.serialNumber || '') !== (detail.serialNumber || '') || (order.batchNumber || '') !== (detail.batchNumber || '')) fail('订单序号或批次与实物不一致');
  if (detail.inventoryItem.trackingType === 'SERIAL' || detail.serialNumber) {
    if (!detail.serialNumber || detail.quantity !== 1 || snapshot.plannedQuantity !== 1) fail('序号跟踪件必须有唯一序号且按一件出库');
  }
  if (detail.shelfLifeDays != null && !detail.shelfLifeDate) fail('受货架期控制的实物缺少到期日期');
  if (detail.shelfLifeDate && detail.shelfLifeDate.getTime() <= now.getTime()) fail('实物已超过货架期');
  if (detail.nextOverhaulDue && detail.nextOverhaulDue.getTime() <= now.getTime()) fail('实物已超过下次检修期限');
  if (detail.lifeLimited) {
    if (detail.remainingHours == null && detail.remainingCycles == null) fail('寿命限制件缺少剩余寿命记录');
    if ((detail.remainingHours != null && detail.remainingHours <= 0) || (detail.remainingCycles != null && detail.remainingCycles <= 0)) fail('实物剩余寿命不合格');
  }
}

export type FulfillmentReviewInput = {
  orderId: string;
  quantity: number;
  snapshotHash: string;
  approved: boolean;
  evidenceIds: string[];
  verifiedSerialNumber: string;
  verifiedBatchNumber: string;
  checks: { identity: boolean; documents: boolean; conditionAndLife: boolean; customerRequirements: boolean };
  reason: string;
};

async function getEvidence(tx: Prisma.TransactionClient, ids: string[]) {
  const records = await tx.storedObject.findMany({ where: { id: { in: [...new Set(ids)] } }, orderBy: { id: 'asc' } });
  if (records.length !== new Set(ids).size || records.some((record) => record.status !== 'AVAILABLE')) {
    throw new AppError('审核证据不存在或已不可用', 409, 'QUALITY_EVIDENCE_INVALID');
  }
  return records;
}

function evidenceSnapshot(records: Awaited<ReturnType<typeof getEvidence>>) {
  return records.map(({ id, version, sha256, status }) => ({ id, version, sha256, status }));
}

export async function createFulfillmentReview(tx: Prisma.TransactionClient, input: FulfillmentReviewInput, actor: CapabilityActor) {
  if (!hasCapability(actor, 'quality_review', 'approve')) throw new AppError('需要质量审核权限', 403, 'AUTH_FORBIDDEN');
  const context = await getFulfillmentReviewContext(tx, input.orderId, input.quantity);
  if (context.snapshotHash !== input.snapshotHash) throw new AppError('订单、实物或证据已变化，请重新核对', 409, 'QUALITY_REVIEW_STALE');
  if (actor.id === context.order.quotation.createdBy) throw new AppError('业务经办人不能审核自己的交付', 403, 'SELF_APPROVAL_FORBIDDEN');
  const records = await getEvidence(tx, input.evidenceIds);
  // Reviewers attach files they can actually read. Shared business-bound file
  // authorization can be added without treating arbitrary object ids as proof.
  if (records.some((record) => record.ownerId !== actor.id && actor.role.toLowerCase() !== 'admin')) {
    throw new AppError('只能使用本人可访问的审核附件', 403, 'AUTH_FORBIDDEN');
  }
  if (!input.reason.trim()) throw new AppError('请记录审核依据及不适用项理由', 400, 'VALIDATION_ERROR');
  if (input.approved) {
    assertFulfillmentFacts(context);
    if (Object.values(input.checks).some((checked) => checked !== true)) throw new AppError('请完成所有适用核对并说明不适用项', 409, 'QUALITY_REVIEW_BLOCKED');
    if (input.verifiedSerialNumber.trim() !== (context.detail.serialNumber || '') || input.verifiedBatchNumber.trim() !== (context.detail.batchNumber || '')) {
      throw new AppError('交付文件上的序号或批次与实物不一致', 409, 'QUALITY_REVIEW_BLOCKED');
    }
    if ((context.order.certificateRequired || context.order.quotation.rfq.certificateRequired || context.order.inspectionRequired) && records.length === 0) {
      throw new AppError('请上传本次交付所需的证书或检验依据', 409, 'QUALITY_EVIDENCE_REQUIRED');
    }
  }
  return tx.fulfillmentReview.create({ data: {
    orderId: input.orderId, inventoryDetailId: context.detail.id, quantity: input.quantity,
    approved: input.approved, snapshotHash: context.snapshotHash, snapshot: json(context.snapshot),
    evidence: json(evidenceSnapshot(records)), checks: json(input.checks), reason: input.reason.trim(),
    reviewedById: actor.id,
  } });
}

export async function consumeFulfillmentReview(tx: Prisma.TransactionClient, orderId: string, quantity: number) {
  const context = await getFulfillmentReviewContext(tx, orderId, quantity);
  assertFulfillmentFacts(context);
  const review = await tx.fulfillmentReview.findFirst({
    where: { orderId, inventoryDetailId: context.detail.id }, orderBy: [{ reviewedAt: 'desc' }, { id: 'desc' }],
  });
  if (!review || !review.approved || review.consumedAt || review.quantity !== quantity) {
    throw new AppError('本次出库尚无有效质量审核，请由质量人员核对计划数量及交付资料', 409, 'QUALITY_REVIEW_REQUIRED');
  }
  if (review.snapshotHash !== context.snapshotHash) throw new AppError('审核后业务或实物资料已变化，请重新审核', 409, 'QUALITY_REVIEW_STALE');
  const evidence = review.evidence as Array<{ id: string; version: number; sha256: string; status: string }>;
  if (hash(evidenceSnapshot(await getEvidence(tx, evidence.map((item) => item.id)))) !== hash(evidence)) {
    throw new AppError('审核附件版本已变化，请重新审核', 409, 'QUALITY_REVIEW_STALE');
  }
  const consumed = await tx.fulfillmentReview.updateMany({ where: { id: review.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) throw new AppError('本次审核已被使用，请刷新', 409, 'RESOURCE_CONFLICT');
  return review.id;
}
