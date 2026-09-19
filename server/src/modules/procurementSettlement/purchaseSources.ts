import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import type { CapabilityActor } from '../../lib/capabilityPolicy.js';
import { isQuotationPartAllowed } from '../../lib/commercialCostSource.js';
import { VERIFIED_CURRENCY_STATUS } from '../../lib/commercialCostSource.js';
import type { PurchasePolicyLine } from './purchasePolicy.js';

export type PurchaseFulfillmentMode = 'STOCK_RECEIPT' | 'SUPPLIER_DIRECT';

export type SupplierQuotePurchaseSource = Readonly<{
  type: 'SUPPLIER_QUOTE';
  supplierQuoteId: string;
}>;

export type ManualPurchaseSource = Readonly<{
  type: 'MANUAL';
  unitCost: Prisma.Decimal.Value;
  reason: string;
  evidenceFileIds: readonly string[];
  currency?: string;
}>;

export type PurchaseLineSource = SupplierQuotePurchaseSource | ManualPurchaseSource;

export type PurchaseLineInput = Readonly<{
  orderLineId: string;
  source: PurchaseLineSource;
  quantity: number;
  promisedDate: Date | string;
  fulfillmentMode: PurchaseFulfillmentMode;
}>;

export type PurchaseEvidenceFingerprint = Readonly<{
  id: string;
  version: number;
  sha256: string;
  status: string;
}>;

export type ResolvePurchaseLinesInput = Readonly<{
  tx: Prisma.TransactionClient;
  actor: CapabilityActor;
  orderId: string;
  supplierId: string;
  /** A command may generate this UUID before creating its commitment row. */
  purchaseCommitmentId?: string;
  lines: readonly PurchaseLineInput[];
  now?: Date;
}>;

export type ResolvedPurchaseLines = Readonly<{
  orderId: string;
  supplierId: string;
  currency: 'USD';
  totalCost: Prisma.Decimal.Value;
  lines: PurchasePolicyLine[];
}>;

export type BindPurchaseEvidenceInput = Readonly<{
  tx: Prisma.TransactionClient;
  actor: CapabilityActor;
  purchaseCommitmentId: string;
  evidenceFileIds: readonly string[];
}>;

export type AssertPurchaseSourcesCurrentInput = Readonly<{
  tx: Prisma.TransactionClient;
  orderId: string;
  supplierId: string;
  purchaseCommitmentId: string;
  lines: readonly PurchasePolicyLine[];
  now?: Date;
}>;

const PURCHASE_EVIDENCE_DOMAIN = 'purchase_commitment';
const PURCHASE_CURRENCY = 'USD' as const;
const MAX_MONEY = new Prisma.Decimal('99999999999999.9999');

const ORDER_LINE_SOURCE_SELECT = {
  id: true,
  orderId: true,
  lineNo: true,
  quotationLineId: true,
  partNumber: true,
  uom: true,
  quantity: true,
  currency: true,
  serialNumber: true,
  batchNumber: true,
  order: {
    select: {
      id: true,
      quotationId: true,
      quotation: { select: { id: true, rfqId: true } },
    },
  },
  quotationLine: {
    select: {
      id: true,
      quotationId: true,
      rfqLineId: true,
      partNumber: true,
      quantity: true,
      uom: true,
      currency: true,
      serialNumber: true,
      batchNumber: true,
      rfqLine: {
        select: {
          id: true,
          rfqId: true,
          partNumber: true,
          quantity: true,
          uom: true,
          conditionCode: true,
          description: true,
          serialNumber: true,
          batchNumber: true,
          alternatePartNumbers: true,
          certificateRequired: true,
          certificateType: true,
          requiredDate: true,
        },
      },
    },
  },
} satisfies Prisma.OrderLineSelect;

const SUPPLIER_QUOTE_SELECT = {
  id: true,
  rfqId: true,
  rfqLineId: true,
  supplierId: true,
  partNumber: true,
  quantity: true,
  unitPriceDecimal: true,
  currency: true,
  currencyReviewStatus: true,
  validUntil: true,
  status: true,
  statusEnum: true,
} satisfies Prisma.SupplierQuoteSelect;

const STORED_OBJECT_SELECT = {
  id: true,
  version: true,
  sha256: true,
  status: true,
  ownerId: true,
  domain: true,
  resourceId: true,
} satisfies Prisma.StoredObjectSelect;

type OrderLineSourceRow = Prisma.OrderLineGetPayload<{ select: typeof ORDER_LINE_SOURCE_SELECT }>;
type SupplierQuoteSourceRow = Prisma.SupplierQuoteGetPayload<{ select: typeof SUPPLIER_QUOTE_SELECT }>;
type StoredObjectSourceRow = Prisma.StoredObjectGetPayload<{ select: typeof STORED_OBJECT_SELECT }>;

function conflict(message: string): never {
  throw new AppError(message, 409, 'RESOURCE_CONFLICT');
}

function forbidden(message: string): never {
  throw new AppError(message, 403, 'AUTH_FORBIDDEN');
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) conflict(`${field}不能为空`);
  return value.trim();
}

function positiveQuantity(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) conflict(`${field}必须为正整数`);
  return value as number;
}

function money(value: unknown, field: string): Prisma.Decimal {
  let amount: Prisma.Decimal;
  try {
    amount = new Prisma.Decimal(value as Prisma.Decimal.Value);
  } catch {
    conflict(`${field}必须是有效 Decimal 金额`);
  }
  if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 4 || amount.gt(MAX_MONEY)) {
    conflict(`${field}必须是 Decimal(18,4) 范围内的非负金额`);
  }
  return amount.toDecimalPlaces(4);
}

function sumMoney(left: Prisma.Decimal, right: Prisma.Decimal): Prisma.Decimal {
  const result = left.plus(right);
  if (result.gt(MAX_MONEY)) conflict('采购总成本超过 Decimal(18,4) 范围');
  return result.toDecimalPlaces(4);
}

function dateValue(value: unknown, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(date.getTime())) conflict(`${field}必须是有效日期`);
  return date;
}

function usd(value: unknown, field: string) {
  if (value !== undefined && value !== PURCHASE_CURRENCY) {
    conflict(`${field}必须是已核实的 USD`);
  }
}

function statusOf(quote: SupplierQuoteSourceRow): string {
  return String(quote.statusEnum ?? quote.status ?? '').trim().toLowerCase();
}

function assertSupplierQuoteUsable(quote: SupplierQuoteSourceRow, supplierId: string, rfqId: string, rfqLineId: string, partNumber: string, quantity: number, now: Date) {
  if (quote.supplierId !== supplierId || quote.rfqId !== rfqId || quote.rfqLineId !== rfqLineId) {
    conflict('供应商报价必须属于当前供应商、RFQ 和 RFQ 行');
  }
  if (quote.partNumber !== partNumber) conflict('供应商报价件号必须与订单行精确一致');
  if (!quote.currency || quote.currency !== PURCHASE_CURRENCY || quote.currencyReviewStatus !== VERIFIED_CURRENCY_STATUS) {
    conflict('供应商报价币种未完成 USD 核实');
  }
  const status = statusOf(quote);
  if (!['pending', 'accepted'].includes(status)) conflict('供应商报价状态不允许作为采购来源');
  if (!(quote.validUntil instanceof Date) || Number.isNaN(quote.validUntil.getTime()) || quote.validUntil.getTime() <= now.getTime()) {
    conflict('供应商报价已过期或缺少有效期');
  }
  if (!Number.isSafeInteger(quote.quantity) || quote.quantity < quantity) conflict('供应商报价来源数量不足');
  if (quote.unitPriceDecimal === null || quote.unitPriceDecimal === undefined) {
    conflict('供应商报价缺少可信 Decimal 单价，不能降级使用 Float');
  }
  const unitCost = money(quote.unitPriceDecimal, '供应商报价 Decimal 单价');
  return { status, unitCost };
}

function identitySnapshot(row: OrderLineSourceRow) {
  const rfqLine = row.quotationLine.rfqLine;
  if (!rfqLine) conflict('订单行缺少可信 RFQ 行关系');
  if (row.partNumber !== row.quotationLine.partNumber || row.uom !== row.quotationLine.uom
    || row.quotationLine.rfqLineId !== rfqLine.id || row.quotationLine.quotationId !== row.order.quotationId
    || row.order.quotation.id !== row.order.quotationId || rfqLine.rfqId !== row.order.quotation.rfqId) {
    conflict('订单行、报价行、RFQ 行关系或实物事实不一致');
  }
  if (row.currency !== PURCHASE_CURRENCY || row.quotationLine.currency !== PURCHASE_CURRENCY) {
    conflict('订单行商业币种必须是 USD');
  }
  if (!isQuotationPartAllowed(row.quotationLine.partNumber, rfqLine)) {
    conflict('报价行件号不属于 RFQ 明确件号或替代件号');
  }
  if (row.serialNumber !== row.quotationLine.serialNumber || row.batchNumber !== row.quotationLine.batchNumber) {
    conflict('订单行与报价行实物身份不一致');
  }
  if ((rfqLine.serialNumber !== null && rfqLine.serialNumber !== row.serialNumber)
    || (rfqLine.batchNumber !== null && rfqLine.batchNumber !== row.batchNumber)) {
    conflict('订单行实物身份不符合 RFQ 行的明确序号或批次要求');
  }
  return {
    schemaVersion: 1,
    orderLineId: row.id,
    quotationLineId: row.quotationLine.id,
    rfqLineId: rfqLine.id,
    partNumber: row.partNumber,
    uom: row.uom,
    conditionCode: rfqLine.conditionCode,
    serialNumber: row.serialNumber,
    batchNumber: row.batchNumber,
    certificateRequired: rfqLine.certificateRequired,
    certificateType: rfqLine.certificateType,
  };
}

async function loadOrderLine(tx: Prisma.TransactionClient, orderId: string, orderLineId: string) {
  const row = await tx.orderLine.findUnique({ where: { id: orderLineId }, select: ORDER_LINE_SOURCE_SELECT });
  if (!row) conflict('订单行不存在');
  if (row.orderId !== orderId || row.order.id !== orderId) conflict('订单行不属于当前订单');
  const identity = identitySnapshot(row);
  return { row, identity, rfqLine: row.quotationLine.rfqLine };
}

function assertInputLine(input: PurchaseLineInput, row: OrderLineSourceRow) {
  const quantity = positiveQuantity(input.quantity, '采购数量');
  if (quantity > row.quantity || quantity > row.quotationLine.quantity) conflict('采购数量超过当前订单行数量');
  const promisedDate = dateValue(input.promisedDate, '承诺交期');
  if (!['STOCK_RECEIPT', 'SUPPLIER_DIRECT'].includes(input.fulfillmentMode)) conflict('采购履约方式无效');
  return { quantity, promisedDate };
}

function supplierSnapshot(args: {
  quote: SupplierQuoteSourceRow;
  status: string;
  unitCost: Prisma.Decimal;
  identity: Record<string, unknown>;
  capturedAt: Date;
}) {
  return {
    schemaVersion: 1,
    type: 'SUPPLIER_QUOTE' as const,
    id: args.quote.id,
    supplierId: args.quote.supplierId,
    rfqLineId: args.identity.rfqLineId,
    partNumber: args.quote.partNumber,
    quantity: args.quote.quantity,
    unitCost: args.unitCost.toFixed(4),
    currency: PURCHASE_CURRENCY,
    validUntil: args.quote.validUntil!.toISOString(),
    status: args.status,
    capturedAt: args.capturedAt.toISOString(),
  };
}

function manualSnapshot(args: {
  supplierId: string;
  identity: Record<string, unknown>;
  unitCost: Prisma.Decimal;
  reason: string;
  evidence: readonly PurchaseEvidenceFingerprint[];
  capturedAt: Date;
}) {
  return {
    schemaVersion: 1,
    type: 'MANUAL' as const,
    id: null,
    supplierId: args.supplierId,
    rfqLineId: args.identity.rfqLineId,
    partNumber: args.identity.partNumber,
    quantity: null,
    unitCost: args.unitCost.toFixed(4),
    currency: PURCHASE_CURRENCY,
    reason: args.reason,
    evidence: args.evidence,
    capturedAt: args.capturedAt.toISOString(),
  };
}

function safeEvidence(row: StoredObjectSourceRow): PurchaseEvidenceFingerprint {
  return { id: row.id, version: row.version, sha256: row.sha256, status: row.status };
}

function assertEvidenceRow(row: StoredObjectSourceRow, actorId?: string) {
  if (row.status !== 'AVAILABLE' || !Number.isSafeInteger(row.version) || row.version < 1
    || !/^[a-f\d]{64}$/i.test(row.sha256)) conflict('采购成本证据不存在、已撤销或校验信息无效');
  if (actorId !== undefined && row.ownerId !== actorId) forbidden('人工采购成本证据必须由当前操作者本人提交');
}

/** Bind new manual-cost evidence to a private purchase commitment resource. */
export function bindPurchaseEvidence(input: BindPurchaseEvidenceInput): Promise<PurchaseEvidenceFingerprint[]>;
export function bindPurchaseEvidence(
  tx: Prisma.TransactionClient,
  actor: CapabilityActor,
  evidenceFileIds: readonly string[],
  purchaseCommitmentId: string,
): Promise<PurchaseEvidenceFingerprint[]>;
export async function bindPurchaseEvidence(
  inputOrTx: BindPurchaseEvidenceInput | Prisma.TransactionClient,
  actorArg?: CapabilityActor,
  evidenceFileIdsArg?: readonly string[],
  purchaseCommitmentIdArg?: string,
): Promise<PurchaseEvidenceFingerprint[]> {
  const input: BindPurchaseEvidenceInput = 'tx' in inputOrTx
    ? inputOrTx
    : {
      tx: inputOrTx,
      actor: actorArg!,
      evidenceFileIds: evidenceFileIdsArg!,
      purchaseCommitmentId: purchaseCommitmentIdArg!,
    };
  const purchaseCommitmentId = text(input.purchaseCommitmentId, 'purchaseCommitmentId');
  if (!input.actor || typeof input.actor.id !== 'string' || !input.actor.id.trim()) forbidden('缺少有效的当前用户');
  if (!Array.isArray(input.evidenceFileIds) || input.evidenceFileIds.length === 0) conflict('人工采购成本必须提供证据附件');
  const ids = input.evidenceFileIds.map((value) => text(value, 'evidenceFileId'));
  if (new Set(ids).size !== ids.length) conflict('采购成本证据附件不能重复');
  const rows = await input.tx.storedObject.findMany({
    where: { id: { in: ids } },
    orderBy: { id: 'asc' },
    select: STORED_OBJECT_SELECT,
  });
  if (rows.length !== ids.length) conflict('采购成本证据不存在或不完整');
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: PurchaseEvidenceFingerprint[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) conflict('采购成本证据不存在或不完整');
    assertEvidenceRow(row, input.actor.id);
    if (row.resourceId !== null
      && (row.domain !== PURCHASE_EVIDENCE_DOMAIN || row.resourceId !== purchaseCommitmentId)) {
      conflict('采购成本证据已绑定其他业务对象，不能复用');
    }
    if (row.domain === PURCHASE_EVIDENCE_DOMAIN && row.resourceId === purchaseCommitmentId) {
      result.push(safeEvidence(row));
      continue;
    }
    const claimed = await input.tx.storedObject.updateMany({
      where: {
        id: row.id,
        status: 'AVAILABLE',
        ownerId: input.actor.id,
        version: row.version,
        resourceId: null,
      },
      data: { domain: PURCHASE_EVIDENCE_DOMAIN, resourceId: purchaseCommitmentId, version: { increment: 1 } },
    });
    if (claimed.count !== 1) conflict('采购成本证据已被其他业务对象或用户占用，请刷新后重试');
    result.push({ ...safeEvidence(row), version: row.version + 1 });
  }
  return result;
}

async function resolveOneLine(args: {
  tx: Prisma.TransactionClient;
  actor: CapabilityActor;
  orderId: string;
  supplierId: string;
  purchaseCommitmentId?: string;
  input: PurchaseLineInput;
  now: Date;
}) {
  const order = await loadOrderLine(args.tx, args.orderId, text(args.input.orderLineId, 'orderLineId'));
  const { quantity, promisedDate } = assertInputLine(args.input, order.row);
  const rfqLine = order.rfqLine!;
  const capturedAt = new Date(args.now.getTime());
  let sourceSupplierQuoteId: string | null = null;
  let unitCost: Prisma.Decimal;
  let sourceSnapshot: Record<string, unknown>;
  if (args.input.source.type === 'SUPPLIER_QUOTE') {
    const sourceId = text(args.input.source.supplierQuoteId, 'supplierQuoteId');
    const quote = await args.tx.supplierQuote.findUnique({ where: { id: sourceId }, select: SUPPLIER_QUOTE_SELECT });
    if (!quote) conflict('供应商报价来源不存在');
    const checked = assertSupplierQuoteUsable(quote, args.supplierId, rfqLine.rfqId, rfqLine.id, order.row.partNumber, quantity, args.now);
    sourceSupplierQuoteId = quote.id;
    unitCost = checked.unitCost;
    sourceSnapshot = supplierSnapshot({ quote, status: checked.status, unitCost, identity: order.identity, capturedAt });
  } else if (args.input.source.type === 'MANUAL') {
    const commitmentId = text(args.purchaseCommitmentId, 'purchaseCommitmentId');
    const reason = text(args.input.source.reason, '人工采购成本原因');
    usd(args.input.source.currency, '人工采购成本币种');
    unitCost = money(args.input.source.unitCost, '人工采购成本');
    const evidence = await bindPurchaseEvidence(
      args.tx,
      args.actor,
      args.input.source.evidenceFileIds,
      commitmentId,
    );
    sourceSnapshot = manualSnapshot({ supplierId: args.supplierId, identity: order.identity, unitCost, reason, evidence, capturedAt });
  } else {
    conflict('采购成本来源类型无效');
  }

  const lineTotal = unitCost.mul(quantity).toDecimalPlaces(4);
  if (lineTotal.gt(MAX_MONEY)) conflict('采购行金额超过 Decimal(18,4) 范围');
  const line: PurchasePolicyLine = {
    id: randomUUID(),
    lineNo: order.row.lineNo,
    orderLineId: order.row.id,
    sourceSupplierQuoteId,
    quantity,
    unitCost: unitCost.toFixed(4),
    lineTotal: lineTotal.toFixed(4),
    currency: PURCHASE_CURRENCY,
    promisedDate: promisedDate.toISOString(),
    fulfillmentMode: args.input.fulfillmentMode,
    partNumber: order.row.partNumber,
    uom: order.row.uom,
    identitySnapshot: order.identity,
    sourceSnapshot,
  };
  return line;
}

export async function resolvePurchaseLines(input: ResolvePurchaseLinesInput): Promise<ResolvedPurchaseLines> {
  const orderId = text(input.orderId, 'orderId');
  const supplierId = text(input.supplierId, 'supplierId');
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) conflict('采购承诺必须有 1 至 100 条来源行');
  if (new Set(input.lines.map((line) => line.orderLineId)).size !== input.lines.length) conflict('采购来源订单行不能重复');
  const now = input.now ? dateValue(input.now, '当前时间') : new Date();
  let totalCost = new Prisma.Decimal(0);
  const lines: PurchasePolicyLine[] = [];
  for (const lineInput of input.lines) {
    const line = await resolveOneLine({ ...input, orderId, supplierId, input: lineInput, now });
    totalCost = sumMoney(totalCost, money(line.lineTotal, '采购行总额'));
    lines.push(line);
  }
  lines.sort((left, right) => left.lineNo - right.lineNo);
  return { orderId, supplierId, currency: PURCHASE_CURRENCY, totalCost: totalCost.toFixed(4), lines };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) conflict(`${field}缺失`);
  return value as Record<string, unknown>;
}

function sourceEvidenceSnapshot(line: PurchasePolicyLine) {
  return object(line.sourceSnapshot, '采购成本来源快照');
}

const IDENTITY_SNAPSHOT_KEYS = [
  'schemaVersion', 'orderLineId', 'quotationLineId', 'rfqLineId', 'partNumber', 'uom',
  'conditionCode', 'serialNumber', 'batchNumber', 'certificateRequired', 'certificateType',
] as const;

function assertIdentitySnapshotCurrent(snapshot: unknown, expected: Record<string, unknown>) {
  const actual = object(snapshot, '采购实物要求快照');
  for (const key of IDENTITY_SNAPSHOT_KEYS) {
    if (!(key in actual) || actual[key] !== expected[key]) {
      conflict('采购实物要求快照与当前订单、报价或 RFQ 行事实不一致');
    }
  }
}

async function assertManualEvidenceCurrent(
  tx: Prisma.TransactionClient,
  snapshot: Record<string, unknown>,
  purchaseCommitmentId: string,
) {
  if (snapshot.type !== 'MANUAL' || snapshot.id !== null || snapshot.currency !== PURCHASE_CURRENCY) conflict('人工采购成本来源快照类型或币种无效');
  const evidence = snapshot.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) conflict('人工采购成本来源缺少证据快照');
  const ids = evidence.map((item) => object(item, '采购成本证据').id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids as string[]).size !== ids.length) conflict('采购成本证据快照 ID 无效');
  const rows = await tx.storedObject.findMany({
    where: { id: { in: ids as string[] } },
    select: STORED_OBJECT_SELECT,
  });
  if (rows.length !== ids.length) conflict('采购成本证据已删除或不可读');
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const item of evidence) {
    const expected = object(item, '采购成本证据');
    const row = byId.get(String(expected.id));
    if (!row || row.domain !== PURCHASE_EVIDENCE_DOMAIN || row.resourceId !== purchaseCommitmentId
      || row.version !== expected.version || row.sha256 !== expected.sha256 || row.status !== expected.status) {
      conflict('人工采购成本证据绑定、版本或哈希已变化');
    }
    assertEvidenceRow(row);
  }
}

async function assertCurrentSupplierQuote(
  tx: Prisma.TransactionClient,
  row: OrderLineSourceRow,
  line: PurchasePolicyLine,
  supplierId: string,
  now: Date,
) {
  const sourceId = text(line.sourceSupplierQuoteId, 'sourceSupplierQuoteId');
  const quote = await tx.supplierQuote.findUnique({ where: { id: sourceId }, select: SUPPLIER_QUOTE_SELECT });
  if (!quote) conflict('采购供应商报价来源已不存在');
  const rfqLine = row.quotationLine.rfqLine;
  if (!rfqLine) conflict('采购订单行 RFQ 关系已失效');
  const checked = assertSupplierQuoteUsable(quote, supplierId, rfqLine.rfqId, rfqLine.id, row.partNumber, line.quantity, now);
  const unitCost = money(line.unitCost, '采购行 Decimal 单价');
  if (!checked.unitCost.equals(unitCost)) conflict('供应商报价来源单价已变化，需重新建立采购承诺');
  const snapshot = sourceEvidenceSnapshot(line);
  if (snapshot.type !== 'SUPPLIER_QUOTE' || snapshot.id !== quote.id || snapshot.supplierId !== supplierId
    || snapshot.rfqLineId !== rfqLine.id || snapshot.partNumber !== quote.partNumber
    || snapshot.currency !== PURCHASE_CURRENCY || !money(snapshot.unitCost, '采购来源快照单价').equals(unitCost)) {
    conflict('采购供应商报价来源快照与当前事实不一致');
  }
}

/** Re-check persisted purchase lines immediately before submit/approve. */
export async function assertPurchaseSourcesCurrent(input: AssertPurchaseSourcesCurrentInput): Promise<void> {
  const orderId = text(input.orderId, 'orderId');
  const supplierId = text(input.supplierId, 'supplierId');
  const purchaseCommitmentId = text(input.purchaseCommitmentId, 'purchaseCommitmentId');
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) conflict('采购承诺来源行数量无效');
  const now = input.now ? dateValue(input.now, '当前时间') : new Date();
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.orderLineId)) conflict('采购来源订单行不能重复');
    seen.add(line.orderLineId);
    const order = await loadOrderLine(input.tx, orderId, text(line.orderLineId, 'orderLineId'));
    if (typeof line.id !== 'string' || !line.id.trim() || line.orderLineId !== order.row.id || line.partNumber !== order.row.partNumber
      || line.uom !== order.row.uom || line.currency !== PURCHASE_CURRENCY) conflict('已保存采购行与当前订单行身份不一致');
    positiveQuantity(line.quantity, '采购行数量');
    if (line.quantity > order.row.quantity || line.quantity > order.row.quotationLine.quantity) conflict('已保存采购数量超过当前订单行');
    const unitCost = money(line.unitCost, '采购行 Decimal 单价');
    const total = money(line.lineTotal, '采购行总额');
    if (!unitCost.mul(line.quantity).toDecimalPlaces(4).equals(total)) conflict('采购行金额与数量、单位成本不一致');
    if (line.fulfillmentMode !== 'STOCK_RECEIPT' && line.fulfillmentMode !== 'SUPPLIER_DIRECT') conflict('采购履约方式无效');
    assertIdentitySnapshotCurrent(line.identitySnapshot, order.identity);
    const snapshot = sourceEvidenceSnapshot(line);
    if (snapshot.supplierId !== supplierId || snapshot.rfqLineId !== order.rfqLine!.id
      || snapshot.partNumber !== order.row.partNumber || snapshot.currency !== PURCHASE_CURRENCY) {
      conflict('采购来源快照与当前订单供应商或 RFQ 行不一致');
    }
    if (line.sourceSupplierQuoteId) {
      await assertCurrentSupplierQuote(input.tx, order.row, line, supplierId, now);
    } else {
      if (snapshot.type !== 'MANUAL' || typeof snapshot.reason !== 'string' || !snapshot.reason.trim()) conflict('人工采购成本来源原因无效');
      if (!money(snapshot.unitCost, '人工采购来源单价').equals(unitCost)) conflict('人工采购来源单价快照不一致');
      await assertManualEvidenceCurrent(input.tx, snapshot, purchaseCommitmentId);
    }
  }
}
