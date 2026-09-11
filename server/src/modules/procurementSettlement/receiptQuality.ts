import crypto from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../middleware/errorHandler.js';

const MAX_DATABASE_INTEGER = 2_147_483_647;
const VALID_CERTIFICATE_STATUSES = new Set(['ISSUED']);

const text = z.string().trim().min(1).max(256);
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();
const dateValue = z.union([
  z.string().datetime({ offset: true }),
  z.date().refine((value) => !Number.isNaN(value.getTime()), '日期无效'),
]).transform((value) => new Date(value));
const quantity = z.number().int().positive().max(MAX_DATABASE_INTEGER);
const nonNegativeInteger = z.number().int().nonnegative().max(MAX_DATABASE_INTEGER);
const finiteNumber = z.number().finite();
const certificateReferenceSchema = z.object({
  id: text.max(200),
  fileHash: text.max(512),
}).strict();

/**
 * Physical facts supplied with an arrival.  This schema intentionally has no
 * commercial fields.  It is strict so a route cannot silently accept a cost,
 * quote, or arbitrary JSON field and later persist it in a quality snapshot.
 *
 * Date fields accept Date values for service/unit callers and ISO strings for
 * JSON routes; the parsed result always contains Date instances.
 */
export const receiptPhysicalSchema = z.object({
  partNumber: text.max(200),
  uom: text.max(64).transform((value) => value.toUpperCase()),
  trackingType: z.string().trim().transform((value) => value.toUpperCase())
    .pipe(z.enum(['SERIAL', 'BATCH'])),
  quantity,
  serialNumber: nullableText(200).default(null),
  batchNumber: nullableText(200).default(null),
  conditionCode: text.max(64).transform((value) => value.toUpperCase()),
  certificateReferences: z.array(certificateReferenceSchema).max(100).default([]),
  certificateType: nullableText(200).default(null),
  certificateNumber: nullableText(200).default(null),
  lifeLimited: z.boolean().default(false),
  // Arrival is allowed to record a bad life measurement so that QC can reject
  // the physical line.  ACCEPT validation applies the positive-life rules.
  remainingHours: finiteNumber.nullable().default(null),
  remainingCycles: finiteNumber.int().min(-MAX_DATABASE_INTEGER).max(MAX_DATABASE_INTEGER).nullable().default(null),
  shelfLifeDate: dateValue.nullable().default(null),
  shelfLifeDays: nonNegativeInteger.nullable().default(null),
  nextOverhaulDue: dateValue.nullable().default(null),
  storageCondition: nullableText(256).default(null),
}).strict().superRefine((value, context) => {
  if (value.trackingType === 'SERIAL' && value.quantity !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['quantity'],
      message: '序号跟踪件到货数量必须为 1',
    });
  }
  if (value.trackingType === 'SERIAL' && !value.serialNumber) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['serialNumber'],
      message: '序号跟踪件必须记录序号',
    });
  }
  if (value.trackingType === 'BATCH' && !value.batchNumber) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['batchNumber'],
      message: '批次跟踪件必须记录批次',
    });
  }
  const ids = value.certificateReferences.map((reference) => reference.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['certificateReferences'],
      message: '证书引用不能重复',
    });
  }
});

export type ReceiptPhysicalInput = z.input<typeof receiptPhysicalSchema>;
export type ReceiptPhysical = z.output<typeof receiptPhysicalSchema>;
export type ReceiptFulfillmentMode = 'STOCK_RECEIPT' | 'SUPPLIER_DIRECT';

export type ReceiptIdentitySnapshot = {
  schemaVersion: 1;
  orderLineId: string;
  quotationLineId: string;
  rfqLineId: string;
  partNumber: string;
  uom: string;
  conditionCode: string;
  serialNumber: string | null;
  batchNumber: string | null;
  certificateRequired: boolean;
  certificateType: string | null;
  trackingType?: 'SERIAL' | 'BATCH' | string | null;
};

/** Server-loaded modern order/RFQ relation. No prices or customer data belong here. */
export type ReceiptModernChain = {
  order: {
    id: string;
    quotationId: string;
    lineItemsMode: boolean;
    currency: string;
    saleType?: string | null;
    status?: string | null;
    certificateRequired: boolean;
    certificateType: string | null;
    inspectionRequired: boolean;
  };
  orderLine: {
    id: string;
    orderId: string;
    quotationLineId: string;
    partNumber: string;
    uom: string;
    quantity: number;
    serialNumber: string | null;
    batchNumber: string | null;
    currency: string;
  };
  quotation: {
    id: string;
    rfqId: string;
    currency: string;
  };
  quotationLine: {
    id: string;
    quotationId: string;
    rfqLineId: string;
    partNumber: string;
    uom: string;
    quantity: number;
    acceptedQuantity: number;
    serialNumber: string | null;
    batchNumber: string | null;
    currency: string;
  };
  rfqLine: {
    id: string;
    rfqId: string;
    partNumber: string;
    uom: string;
    quantity: number;
    conditionCode: string;
    serialNumber: string | null;
    batchNumber: string | null;
    certificateRequired: boolean;
    certificateType: string | null;
    alternatePartNumbers?: string | null;
  };
  rfq?: {
    id: string;
    lineItemsMode?: boolean;
  };
};

/** Purchase-line facts safe for QC; cost/source-commercial snapshots are excluded. */
export type ReceiptPurchaseSnapshot = {
  purchaseCommitmentId: string;
  purchaseCommitmentLineId: string;
  orderId: string;
  supplierId: string;
  orderLineId: string;
  partNumber: string;
  uom: string;
  quantity: number;
  cancelledQuantity: number;
  receivedQuantity: number;
  directShippedQuantity: number;
  fulfillmentMode: ReceiptFulfillmentMode;
  identitySnapshot: ReceiptIdentitySnapshot;
};

/** Current Certificate row selected by the server for the receipt line. */
export type ReceiptCertificateRow = {
  id: string;
  certificateNumber: string;
  partNumber: string;
  serialNumber: string | null;
  batchNumber: string | null;
  certificateType: string;
  status: string;
  expiryDate: Date | string | null;
  fileHash: string | null;
  supplierId: string | null;
  orderId: string | null;
  inventoryDetailId?: string | null;
  updatedAt: Date | string;
};

export type ReceiptQualityInput = {
  physical: unknown;
  chain: ReceiptModernChain;
  /** A Prisma Json/object value is accepted; only the allowlisted fields below are copied. */
  purchase: unknown;
  certificates: readonly ReceiptCertificateRow[];
  now?: Date | string;
};

export type ReceiptQualityPhase = 'ARRIVAL' | 'ACCEPT';

export type ReceiptQualityIssue = {
  code: string;
  path: string;
  message: string;
};

export type ReceiptQualitySnapshot = {
  schemaVersion: 1;
  chain: {
    order: ReceiptModernChain['order'];
    orderLine: ReceiptModernChain['orderLine'];
    quotation: ReceiptModernChain['quotation'];
    quotationLine: ReceiptModernChain['quotationLine'];
    rfqLine: ReceiptModernChain['rfqLine'];
    rfq?: ReceiptModernChain['rfq'];
  };
  purchase: ReceiptPurchaseSnapshot;
  physical: {
    partNumber: string;
    uom: string;
    trackingType: 'SERIAL' | 'BATCH';
    quantity: number;
    serialNumber: string | null;
    batchNumber: string | null;
    conditionCode: string;
    certificateReferences: Array<{ id: string; fileHash: string }>;
    certificateType: string | null;
    certificateNumber: string | null;
    lifeLimited: boolean;
    remainingHours: number | null;
    remainingCycles: number | null;
    shelfLifeDate: string | null;
    shelfLifeDays: number | null;
    nextOverhaulDue: string | null;
    storageCondition: string | null;
  };
  certificates: Array<{
    id: string;
    certificateNumber: string;
    partNumber: string;
    serialNumber: string | null;
    batchNumber: string | null;
    certificateType: string;
    status: string;
    expiryDate: string | null;
    fileHash: string | null;
    supplierId: string | null;
    orderId: string | null;
    inventoryDetailId: string | null;
    updatedAt: string;
  }>;
};

export type ReceiptQualityValidation = {
  normalizedPhysical: ReceiptPhysical;
  issues: ReceiptQualityIssue[];
  canAccept: boolean;
  snapshot: ReceiptQualitySnapshot;
  snapshotHash: string;
};

function sourceConflict(message: string): never {
  throw new AppError(message, 409, 'ALLOCATION_INCONSISTENT');
}

function qualityBlocked(message: string, evidence = false): never {
  throw new AppError(message, 409, evidence ? 'QUALITY_EVIDENCE_INVALID' : 'QUALITY_REVIEW_BLOCKED');
}

function identifier(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) sourceConflict(`${label}不能为空`);
  return value.trim();
}

function safeQuantity(value: number, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_DATABASE_INTEGER) {
    sourceConflict(`${label}必须是数据库可表示的${positive ? '正' : '非负'}整数`);
  }
  return value;
}

function sameNullable(left: string | null | undefined, right: string | null | undefined) {
  return (left ?? '') === (right ?? '');
}

function normalizeCertificateType(value: string | null | undefined) {
  return (value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseAlternatePartNumbers(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((part): part is string => typeof part === 'string')
        .map((part) => part.trim()).filter(Boolean);
    }
  } catch {
    // Historical RFQ rows also use comma/semicolon separated text.
  }
  return value.split(/[,;\s]+/).map((part) => part.trim()).filter(Boolean);
}

function isAllowedRfqPart(rfqPartNumber: string, alternatePartNumbers: string | null | undefined, partNumber: string) {
  return partNumber === rfqPartNumber || parseAlternatePartNumbers(alternatePartNumbers).includes(partNumber);
}

function dateOrNull(value: Date | string | null | undefined, label: string): Date | null {
  if (value == null) return null;
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(result.getTime())) sourceConflict(`${label}不是有效日期`);
  return result;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) sourceConflict(`${label}缺失`);
  return value as Record<string, unknown>;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return identifier(value as string, label);
}

function optionalTrackingType(value: unknown): ReceiptIdentitySnapshot['trackingType'] {
  if (value === null || value === undefined) return undefined;
  const normalized = identifier(value as string, '采购追踪方式').toUpperCase();
  if (normalized !== 'SERIAL' && normalized !== 'BATCH') sourceConflict('采购追踪方式无效');
  return normalized;
}

/**
 * Normalize a server-loaded purchase line with an explicit allowlist.  A
 * Prisma row may contain unitCost/sourceSnapshot; those fields are never
 * copied into the quality contract or its snapshot.
 */
export function normalizeReceiptPurchaseSnapshot(value: unknown): ReceiptPurchaseSnapshot {
  const row = objectValue(value, '采购承诺行');
  const identity = objectValue(row.identitySnapshot, '采购实物要求快照');
  if (identity.schemaVersion !== 1) sourceConflict('采购实物要求快照版本无效');
  const normalizedIdentity: ReceiptIdentitySnapshot = {
    schemaVersion: 1,
    orderLineId: identifier(identity.orderLineId as string, '采购实物快照订单行 id'),
    quotationLineId: identifier(identity.quotationLineId as string, '采购实物快照报价行 id'),
    rfqLineId: identifier(identity.rfqLineId as string, '采购实物快照 RFQ 行 id'),
    partNumber: identifier(identity.partNumber as string, '采购实物快照件号'),
    uom: identifier(identity.uom as string, '采购实物快照单位').toUpperCase(),
    conditionCode: identifier(identity.conditionCode as string, '采购实物快照条件状态').toUpperCase(),
    serialNumber: nullableString(identity.serialNumber, '采购实物快照序号'),
    batchNumber: nullableString(identity.batchNumber, '采购实物快照批次'),
    certificateRequired: identity.certificateRequired === true,
    certificateType: nullableString(identity.certificateType, '采购实物快照证书类型'),
    ...(optionalTrackingType(identity.trackingType) ? { trackingType: optionalTrackingType(identity.trackingType) } : {}),
  };
  if (typeof identity.certificateRequired !== 'boolean') sourceConflict('采购实物快照证书要求无效');
  const fulfillmentMode = row.fulfillmentMode;
  if (fulfillmentMode !== 'STOCK_RECEIPT' && fulfillmentMode !== 'SUPPLIER_DIRECT') sourceConflict('采购履约方式无效');
  const normalized: ReceiptPurchaseSnapshot = {
    purchaseCommitmentId: identifier(row.purchaseCommitmentId as string, '采购承诺 id'),
    purchaseCommitmentLineId: identifier(row.purchaseCommitmentLineId as string, '采购承诺行 id'),
    orderId: identifier(row.orderId as string, '采购订单 id'),
    supplierId: identifier(row.supplierId as string, '采购供应商 id'),
    orderLineId: identifier(row.orderLineId as string, '采购订单行 id'),
    partNumber: identifier(row.partNumber as string, '采购件号'),
    uom: identifier(row.uom as string, '采购单位').toUpperCase(),
    quantity: safeQuantity(row.quantity as number, '采购承诺数量', true),
    cancelledQuantity: safeQuantity(row.cancelledQuantity as number, '采购取消数量'),
    receivedQuantity: safeQuantity(row.receivedQuantity as number, '采购已收货数量'),
    directShippedQuantity: safeQuantity(row.directShippedQuantity as number, '采购直发数量'),
    fulfillmentMode,
    identitySnapshot: normalizedIdentity,
  };
  return normalized;
}

function assertCurrency(value: string, label: string) {
  if (value.trim().toUpperCase() !== 'USD') sourceConflict(`${label}必须是 USD`);
}

type NormalizedReceiptQualityInput = Omit<ReceiptQualityInput, 'physical' | 'purchase'> & {
  physical: ReceiptPhysical;
  purchase: ReceiptPurchaseSnapshot;
};

function assertSourceContext(input: NormalizedReceiptQualityInput, expectedFulfillmentMode: ReceiptFulfillmentMode = 'STOCK_RECEIPT') {
  const { chain, purchase } = input;
  const order = chain.order;
  const orderLine = chain.orderLine;
  const quotation = chain.quotation;
  const quotationLine = chain.quotationLine;
  const rfqLine = chain.rfqLine;
  const identity = purchase.identitySnapshot;

  identifier(order.id, '订单 id');
  identifier(order.quotationId, '订单报价 id');
  identifier(orderLine.id, '订单行 id');
  identifier(quotation.id, '报价 id');
  identifier(quotationLine.id, '报价行 id');
  identifier(rfqLine.id, 'RFQ 行 id');
  identifier(purchase.purchaseCommitmentId, '采购承诺 id');
  identifier(purchase.purchaseCommitmentLineId, '采购承诺行 id');
  identifier(purchase.supplierId, '供应商 id');

  if (!order.lineItemsMode || chain.rfq?.lineItemsMode === false) sourceConflict('收货质量只能绑定现代多行订单/RFQ');
  if (order.saleType && order.saleType !== 'Sale') sourceConflict('首期收货只支持 Sale 业务');
  assertCurrency(order.currency, '订单币种');
  assertCurrency(quotation.currency, '报价币种');
  assertCurrency(orderLine.currency, '订单行币种');
  assertCurrency(quotationLine.currency, '报价行币种');
  if (purchase.fulfillmentMode !== expectedFulfillmentMode) {
    sourceConflict(`当前质量链要求 ${expectedFulfillmentMode} 履约方式`);
  }

  if (purchase.orderId !== order.id || orderLine.orderId !== order.id || purchase.orderLineId !== orderLine.id) {
    sourceConflict('采购承诺、订单和订单行来源关系不一致');
  }
  if (orderLine.quotationLineId !== quotationLine.id || quotationLine.quotationId !== quotation.id
    || order.quotationId !== quotation.id) {
    sourceConflict('订单行、报价和报价行来源关系不一致');
  }
  if (quotation.rfqId !== rfqLine.rfqId || quotationLine.rfqLineId !== rfqLine.id
    || chain.rfq && chain.rfq.id !== rfqLine.rfqId) {
    sourceConflict('报价行与 RFQ 需求行来源关系不一致');
  }
  if (orderLine.partNumber !== quotationLine.partNumber || orderLine.uom !== quotationLine.uom
    || !isAllowedRfqPart(rfqLine.partNumber, rfqLine.alternatePartNumbers, quotationLine.partNumber)) {
    sourceConflict('订单行、报价行与 RFQ 件号或单位不一致');
  }

  if (identity.schemaVersion !== 1 || identity.orderLineId !== orderLine.id
    || identity.quotationLineId !== quotationLine.id || identity.rfqLineId !== rfqLine.id
    || identity.partNumber !== purchase.partNumber || identity.uom !== purchase.uom
    || identity.conditionCode !== rfqLine.conditionCode
    || !sameNullable(identity.serialNumber, orderLine.serialNumber)
    || !sameNullable(identity.serialNumber, quotationLine.serialNumber)
    || !sameNullable(identity.serialNumber, rfqLine.serialNumber)
    || !sameNullable(identity.batchNumber, orderLine.batchNumber)
    || !sameNullable(identity.batchNumber, quotationLine.batchNumber)
    || !sameNullable(identity.batchNumber, rfqLine.batchNumber)
    || identity.certificateRequired !== rfqLine.certificateRequired
    || normalizeCertificateType(identity.certificateType) !== normalizeCertificateType(rfqLine.certificateType)) {
    sourceConflict('采购实物要求快照与当前订单、报价或 RFQ 行事实不一致');
  }

  if (purchase.partNumber !== orderLine.partNumber || purchase.uom !== orderLine.uom) {
    sourceConflict('采购行件号或单位与销售订单行不一致');
  }
  safeQuantity(purchase.quantity, '采购承诺数量', true);
  safeQuantity(purchase.cancelledQuantity, '采购取消数量');
  safeQuantity(purchase.receivedQuantity, '采购已收货数量');
  safeQuantity(purchase.directShippedQuantity, '采购直发数量');
  if (purchase.cancelledQuantity + purchase.receivedQuantity + purchase.directShippedQuantity > purchase.quantity) {
    sourceConflict('采购承诺取消、收货及直发数量超过承诺数量');
  }
  if (expectedFulfillmentMode === 'STOCK_RECEIPT' && purchase.directShippedQuantity !== 0) {
    sourceConflict('当前收货链禁止非零直发数量');
  }
  if (expectedFulfillmentMode === 'SUPPLIER_DIRECT' && purchase.receivedQuantity !== 0) {
    sourceConflict('当前直发质量链禁止已有库存收货数量');
  }
  safeQuantity(orderLine.quantity, '订单行数量', true);
  safeQuantity(quotationLine.quantity, '报价行数量', true);
  safeQuantity(quotationLine.acceptedQuantity, '报价行成交数量', true);
  if (quotationLine.quantity < quotationLine.acceptedQuantity || quotationLine.acceptedQuantity < orderLine.quantity) {
    sourceConflict('订单行成交数量与报价行数量不一致');
  }
}

export function normalizeReceiptPhysical(value: unknown): ReceiptPhysical {
  return receiptPhysicalSchema.parse(value);
}

function addIssue(issues: ReceiptQualityIssue[], code: string, path: string, message: string) {
  issues.push({ code, path, message });
}

function certificateRequired(input: NormalizedReceiptQualityInput, physical: ReceiptPhysical) {
  return input.chain.order.certificateRequired
    || input.chain.order.inspectionRequired
    || input.chain.rfqLine.certificateRequired
    || input.purchase.identitySnapshot.certificateRequired
    || Boolean(input.chain.order.certificateType)
    || Boolean(input.chain.rfqLine.certificateType)
    || physical.certificateReferences.length > 0;
}

function collectCertificateIssues(
  input: NormalizedReceiptQualityInput,
  physical: ReceiptPhysical,
  now: Date,
  issues: ReceiptQualityIssue[],
) {
  const requiredTypes = [
    input.chain.order.certificateRequired ? input.chain.order.certificateType : null,
    input.chain.rfqLine.certificateRequired ? input.chain.rfqLine.certificateType : null,
    input.purchase.identitySnapshot.certificateRequired ? input.purchase.identitySnapshot.certificateType : null,
    physical.certificateType,
  ].filter((value): value is string => Boolean(value?.trim()));
  const required = certificateRequired(input, physical);
  const references = physical.certificateReferences;
  if (required && references.length === 0) {
    addIssue(issues, 'CERTIFICATE_REQUIRED', 'certificateReferences', '当前收货要求至少绑定一份证书记录');
  }

  const rows = new Map<string, ReceiptCertificateRow>();
  for (const row of input.certificates) {
    if (rows.has(row.id)) sourceConflict('当前 Certificate 结果包含重复 id');
    rows.set(row.id, row);
  }

  for (const reference of references) {
    const row = rows.get(reference.id);
    if (!row) {
      addIssue(issues, 'CERTIFICATE_NOT_FOUND', `certificateReferences.${reference.id}`, '证书当前记录不存在');
      continue;
    }
    const expiryDate = dateOrNull(row.expiryDate, `证书 ${row.id} expiryDate`);
    const status = row.status.trim().toUpperCase();
    if (!row.fileHash || row.fileHash !== reference.fileHash) {
      addIssue(issues, 'CERTIFICATE_FILE_HASH_MISMATCH', `certificateReferences.${reference.id}.fileHash`, '证书文件指纹与当前 Certificate 记录不一致');
    }
    if (row.partNumber !== physical.partNumber) {
      addIssue(issues, 'CERTIFICATE_PART_MISMATCH', `certificateReferences.${reference.id}`, '证书件号与到货实物不一致');
    }
    if (!sameNullable(row.serialNumber, physical.serialNumber)) {
      addIssue(issues, 'CERTIFICATE_SERIAL_MISMATCH', `certificateReferences.${reference.id}`, '证书序号与到货实物不一致');
    }
    if (!sameNullable(row.batchNumber, physical.batchNumber)) {
      addIssue(issues, 'CERTIFICATE_BATCH_MISMATCH', `certificateReferences.${reference.id}`, '证书批次与到货实物不一致');
    }
    const scopeMismatch = input.purchase.fulfillmentMode === 'SUPPLIER_DIRECT'
      ? row.supplierId !== input.purchase.supplierId || row.orderId !== input.purchase.orderId
      : row.supplierId !== input.purchase.supplierId || (row.orderId !== null && row.orderId !== input.purchase.orderId);
    if (scopeMismatch) {
      addIssue(issues, 'CERTIFICATE_SCOPE_MISMATCH', `certificateReferences.${reference.id}`, '证书 supplier/order 归属与采购销售来源不一致');
    }
    if (row.inventoryDetailId) {
      addIssue(issues, 'CERTIFICATE_ALREADY_BOUND', `certificateReferences.${reference.id}`, '证书已经绑定库存明细，不能复用于本次新收货');
    }
    if (!VALID_CERTIFICATE_STATUSES.has(status)) {
      addIssue(issues, 'CERTIFICATE_STATUS_INVALID', `certificateReferences.${reference.id}`, '证书当前状态不可用于收货验收');
    }
    if (expiryDate && expiryDate.getTime() <= now.getTime()) {
      addIssue(issues, 'CERTIFICATE_EXPIRED', `certificateReferences.${reference.id}`, '证书已超过有效期');
    }
    if (requiredTypes.length > 0
      && !requiredTypes.every((type) => normalizeCertificateType(type) === normalizeCertificateType(row.certificateType))) {
      addIssue(issues, 'CERTIFICATE_TYPE_MISMATCH', `certificateReferences.${reference.id}`, '证书类型与订单/RFQ要求不一致');
    }
    if (physical.certificateNumber && physical.certificateNumber !== row.certificateNumber) {
      addIssue(issues, 'CERTIFICATE_NUMBER_MISMATCH', `certificateReferences.${reference.id}`, '证书编号与到货记录不一致');
    }
  }
}

function collectQualityIssues(input: NormalizedReceiptQualityInput, physical: ReceiptPhysical, now: Date) {
  const issues: ReceiptQualityIssue[] = [];
  const { chain, purchase } = input;
  const expectedSerial = chain.orderLine.serialNumber || chain.quotationLine.serialNumber || chain.rfqLine.serialNumber || purchase.identitySnapshot.serialNumber;
  const expectedBatch = chain.orderLine.batchNumber || chain.quotationLine.batchNumber || chain.rfqLine.batchNumber || purchase.identitySnapshot.batchNumber;
  const openQuantity = purchase.quantity - purchase.cancelledQuantity - purchase.receivedQuantity - purchase.directShippedQuantity;

  if (physical.partNumber !== purchase.partNumber) addIssue(issues, 'PART_NUMBER_MISMATCH', 'partNumber', '到货件号与采购承诺行不一致');
  if (physical.uom !== purchase.uom) addIssue(issues, 'UOM_MISMATCH', 'uom', '到货单位与采购承诺行不一致');
  if (purchase.identitySnapshot.trackingType && physical.trackingType !== purchase.identitySnapshot.trackingType) {
    addIssue(issues, 'TRACKING_TYPE_MISMATCH', 'trackingType', '到货追踪方式与服务器来源要求不一致');
  }
  if (physical.quantity > openQuantity) addIssue(issues, 'QUANTITY_EXCEEDS_OPEN', 'quantity', '到货数量超过采购承诺可收货余量');
  if (physical.conditionCode !== chain.rfqLine.conditionCode) addIssue(issues, 'CONDITION_MISMATCH', 'conditionCode', '到货条件状态不符合 RFQ 行要求');
  if (expectedSerial && physical.serialNumber !== expectedSerial) addIssue(issues, 'SERIAL_MISMATCH', 'serialNumber', '到货序号不符合订单/RFQ 已明确要求');
  if (expectedBatch && physical.batchNumber !== expectedBatch) addIssue(issues, 'BATCH_MISMATCH', 'batchNumber', '到货批次不符合订单/RFQ 已明确要求');

  if (physical.shelfLifeDays !== null && physical.shelfLifeDate === null) {
    addIssue(issues, 'SHELF_LIFE_DATE_MISSING', 'shelfLifeDate', '受货架期控制的实物缺少到期日期');
  }
  if (physical.shelfLifeDate && physical.shelfLifeDate.getTime() <= now.getTime()) {
    addIssue(issues, 'SHELF_LIFE_EXPIRED', 'shelfLifeDate', '实物已超过货架期');
  }
  if (physical.nextOverhaulDue && physical.nextOverhaulDue.getTime() <= now.getTime()) {
    addIssue(issues, 'OVERHAUL_DUE', 'nextOverhaulDue', '实物已超过下次检修期限');
  }
  if (physical.lifeLimited) {
    if (physical.remainingHours === null && physical.remainingCycles === null) {
      addIssue(issues, 'LIFE_REMAINING_MISSING', 'remainingHours', '寿命限制件缺少剩余寿命记录');
    }
    if ((physical.remainingHours !== null && physical.remainingHours <= 0)
      || (physical.remainingCycles !== null && physical.remainingCycles <= 0)) {
      addIssue(issues, 'LIFE_REMAINING_INVALID', 'remainingHours', '实物剩余寿命不合格');
    }
  }
  collectCertificateIssues(input, physical, now, issues);
  return issues;
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

function certificateSnapshot(row: ReceiptCertificateRow) {
  const updatedAt = dateOrNull(row.updatedAt, `证书 ${row.id} updatedAt`);
  if (!updatedAt) sourceConflict(`证书 ${row.id} 缺少 updatedAt`);
  const expiryDate = dateOrNull(row.expiryDate, `证书 ${row.id} expiryDate`);
  return {
    id: row.id,
    certificateNumber: row.certificateNumber,
    partNumber: row.partNumber,
    serialNumber: row.serialNumber,
    batchNumber: row.batchNumber,
    certificateType: row.certificateType,
    status: row.status,
    expiryDate: expiryDate?.toISOString() ?? null,
    fileHash: row.fileHash,
    supplierId: row.supplierId,
    orderId: row.orderId,
    inventoryDetailId: row.inventoryDetailId ?? null,
    updatedAt: updatedAt.toISOString(),
  };
}

function buildNormalizedReceiptQualitySnapshot(
  input: NormalizedReceiptQualityInput,
  expectedFulfillmentMode: ReceiptFulfillmentMode = 'STOCK_RECEIPT',
): ReceiptQualitySnapshot {
  assertSourceContext(input, expectedFulfillmentMode);
  const physical = input.physical;
  const references = [...physical.certificateReferences].sort((left, right) => left.id.localeCompare(right.id));
  const referencedIds = new Set(references.map((reference) => reference.id));
  const certificates = input.certificates
    .filter((certificate) => referencedIds.has(certificate.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(certificateSnapshot);
  const chainSnapshot = {
    order: {
      id: input.chain.order.id,
      quotationId: input.chain.order.quotationId,
      lineItemsMode: input.chain.order.lineItemsMode,
      currency: input.chain.order.currency,
      ...(input.chain.order.saleType !== undefined ? { saleType: input.chain.order.saleType } : {}),
      ...(input.chain.order.status !== undefined ? { status: input.chain.order.status } : {}),
      certificateRequired: input.chain.order.certificateRequired,
      certificateType: input.chain.order.certificateType,
      inspectionRequired: input.chain.order.inspectionRequired,
    },
    orderLine: {
      id: input.chain.orderLine.id,
      orderId: input.chain.orderLine.orderId,
      quotationLineId: input.chain.orderLine.quotationLineId,
      partNumber: input.chain.orderLine.partNumber,
      uom: input.chain.orderLine.uom,
      quantity: input.chain.orderLine.quantity,
      serialNumber: input.chain.orderLine.serialNumber,
      batchNumber: input.chain.orderLine.batchNumber,
      currency: input.chain.orderLine.currency,
    },
    quotation: {
      id: input.chain.quotation.id,
      rfqId: input.chain.quotation.rfqId,
      currency: input.chain.quotation.currency,
    },
    quotationLine: {
      id: input.chain.quotationLine.id,
      quotationId: input.chain.quotationLine.quotationId,
      rfqLineId: input.chain.quotationLine.rfqLineId,
      partNumber: input.chain.quotationLine.partNumber,
      uom: input.chain.quotationLine.uom,
      quantity: input.chain.quotationLine.quantity,
      acceptedQuantity: input.chain.quotationLine.acceptedQuantity,
      serialNumber: input.chain.quotationLine.serialNumber,
      batchNumber: input.chain.quotationLine.batchNumber,
      currency: input.chain.quotationLine.currency,
    },
    rfqLine: {
      id: input.chain.rfqLine.id,
      rfqId: input.chain.rfqLine.rfqId,
      partNumber: input.chain.rfqLine.partNumber,
      uom: input.chain.rfqLine.uom,
      quantity: input.chain.rfqLine.quantity,
      conditionCode: input.chain.rfqLine.conditionCode,
      serialNumber: input.chain.rfqLine.serialNumber,
      batchNumber: input.chain.rfqLine.batchNumber,
      certificateRequired: input.chain.rfqLine.certificateRequired,
      certificateType: input.chain.rfqLine.certificateType,
      ...(input.chain.rfqLine.alternatePartNumbers !== undefined
        ? { alternatePartNumbers: input.chain.rfqLine.alternatePartNumbers }
        : {}),
    },
    ...(input.chain.rfq
      ? { rfq: { id: input.chain.rfq.id, ...(input.chain.rfq.lineItemsMode !== undefined ? { lineItemsMode: input.chain.rfq.lineItemsMode } : {}) } }
      : {}),
  };
  return {
    schemaVersion: 1,
    chain: chainSnapshot,
    purchase: {
      ...input.purchase,
      identitySnapshot: { ...input.purchase.identitySnapshot },
    },
    physical: {
      partNumber: physical.partNumber,
      uom: physical.uom,
      trackingType: physical.trackingType,
      quantity: physical.quantity,
      serialNumber: physical.serialNumber,
      batchNumber: physical.batchNumber,
      conditionCode: physical.conditionCode,
      certificateReferences: references,
      certificateType: physical.certificateType,
      certificateNumber: physical.certificateNumber,
      lifeLimited: physical.lifeLimited,
      remainingHours: physical.remainingHours,
      remainingCycles: physical.remainingCycles,
      shelfLifeDate: physical.shelfLifeDate?.toISOString() ?? null,
      shelfLifeDays: physical.shelfLifeDays,
      nextOverhaulDue: physical.nextOverhaulDue?.toISOString() ?? null,
      storageCondition: physical.storageCondition,
    },
    certificates,
  };
}

export function buildReceiptQualitySnapshot(input: ReceiptQualityInput): ReceiptQualitySnapshot {
  const normalizedInput: NormalizedReceiptQualityInput = {
    ...input,
    physical: normalizeReceiptPhysical(input.physical),
    purchase: normalizeReceiptPurchaseSnapshot(input.purchase),
  };
  return buildNormalizedReceiptQualitySnapshot(normalizedInput);
}

export function hashReceiptQualitySnapshot(snapshot: ReceiptQualitySnapshot): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex');
}

export function buildReceiptQualitySnapshotHash(input: ReceiptQualityInput): string {
  return hashReceiptQualitySnapshot(buildReceiptQualitySnapshot(input));
}

// Short alias for callers that use the same naming as other quality modules.
export const buildReceiptQualityHash = buildReceiptQualitySnapshotHash;

export function validateReceiptQuality(
  input: ReceiptQualityInput,
  options: { phase?: ReceiptQualityPhase; now?: Date | string; expectedFulfillmentMode?: ReceiptFulfillmentMode } = {},
): ReceiptQualityValidation {
  const phase = options.phase ?? 'ACCEPT';
  if (phase !== 'ARRIVAL' && phase !== 'ACCEPT') {
    throw new AppError('收货质量校验阶段无效', 400, 'VALIDATION_ERROR');
  }
  const normalizedPhysical = normalizeReceiptPhysical(input.physical);
  const normalizedPurchase = normalizeReceiptPurchaseSnapshot(input.purchase);
  const normalizedInput: NormalizedReceiptQualityInput = {
    ...input,
    physical: normalizedPhysical,
    purchase: normalizedPurchase,
  };
  const expectedFulfillmentMode = options.expectedFulfillmentMode ?? 'STOCK_RECEIPT';
  if (expectedFulfillmentMode !== 'STOCK_RECEIPT' && expectedFulfillmentMode !== 'SUPPLIER_DIRECT') {
    throw new AppError('质量校验履约方式无效', 400, 'VALIDATION_ERROR');
  }
  assertSourceContext(normalizedInput, expectedFulfillmentMode);
  const now = dateOrNull(options.now ?? input.now ?? new Date(), '质量校验当前时间');
  if (!now) throw new AppError('质量校验当前时间不能为空', 400, 'VALIDATION_ERROR');
  const issues = collectQualityIssues(normalizedInput, normalizedPhysical, now);
  const snapshot = buildNormalizedReceiptQualitySnapshot(normalizedInput, expectedFulfillmentMode);
  const snapshotHash = hashReceiptQualitySnapshot(snapshot);
  if (phase === 'ACCEPT' && issues.length > 0) {
    const evidence = issues.some((issue) => issue.code.startsWith('CERTIFICATE_'));
    qualityBlocked(`收货质量校验失败：${issues.map((issue) => issue.message).join('；')}`, evidence);
  }
  return { normalizedPhysical, issues, canAccept: issues.length === 0, snapshot, snapshotHash };
}
