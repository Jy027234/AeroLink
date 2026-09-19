import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { AppError } from '../middleware/errorHandler.js';
import { isExplicitDemandPart } from './transactionLinePreflight.js';
import { quotationLineStatus, rfqLineStatus } from './transactionLineStateProjection.js';
import {
  calculateMarginPercent,
  calculateMoneyTotal,
  moneyValuesMatch,
  normalizeMoney,
  normalizeOptionalMoney,
  type MoneyInput,
} from './money.js';

/** The line service deliberately depends on only the transaction delegates it uses. */
export type TransactionLineClient = Pick<
  Prisma.TransactionClient,
  'rFQ' | 'rfqLine' | 'supplierQuote' | 'quotation' | 'quotationLine' | 'order' | 'orderLine'
>;

export type RfqLineSource = {
  id: string;
  rfqId: string;
  partNumber: string;
  quantity: number;
  uom: string;
  conditionCode: string;
  description: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
  alternatePartNumbers: string | null;
  certificateRequired: boolean;
  certificateType: string | null;
  requiredDate: Date;
  leadTimeDays: number | null;
  targetPriceDecimal: MoneyInput | null;
  targetPriceCurrency: string;
  status: string;
};

export type RfqLineAggregate = {
  id: string;
  partNumber: string;
  quantity: number;
  uom: string;
  conditionCode: string;
  description: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
  alternatePartNumbers: string | null;
  certificateRequired: boolean;
  certificateType: string | null;
  requiredDate: Date;
  leadTimeDays: number | null;
  targetPrice: number | null;
  targetPriceCurrency: string;
  lines?: RfqLineSource[];
};

export type QuotationLineAggregate = {
  id: string;
  rfqId: string;
  partNumber: string;
  quantity: number;
  unitPrice: number;
  unitPriceDecimal: MoneyInput | null;
  totalPrice: number;
  totalPriceDecimal: MoneyInput | null;
  costPrice: number;
  costPriceDecimal: MoneyInput | null;
  currency: string;
  costSourceType?: string | null;
  costSourceId?: string | null;
  status: string;
  reservedQuantity: number;
  inventoryDetailId: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
};

export type OrderLineAggregate = {
  id: string;
  orderNumber: string;
  quotationId: string;
  partNumber: string;
  quantity: number;
  totalAmount: number;
  totalAmountDecimal: MoneyInput | null;
  status: string;
  outboundQuantity: number;
  outboundStatus: string;
  inventoryDetailId: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
};

type ExistingQuotationLine = Prisma.QuotationLineGetPayload<{}>;
type ExistingOrderLine = Prisma.OrderLineGetPayload<{}>;

function conflict(message: string): never {
  throw new AppError(message, 409, 'RESOURCE_CONFLICT');
}

function lineRequired(message: string): never {
  throw new AppError(message, 409, 'LINE_ID_REQUIRED');
}

function assertUsd(currency: string, name: string) {
  if (currency !== 'USD') conflict(`${name}仅支持 USD 商业金额`);
}

function assertDecimal(value: MoneyInput | null, field: string): MoneyInput {
  if (value === null) conflict(`${field}缺少 Decimal 金额事实，不能建立交易行`);
  return value as MoneyInput;
}

function assertMoneyShadow(decimal: MoneyInput | null, legacy: number, field: string) {
  const required = assertDecimal(decimal, field);
  if (!moneyValuesMatch(required, legacy)) conflict(`${field} Decimal 与旧金额不一致，不能静默覆盖`);
  return normalizeMoney(required);
}

function assertDate(value: Date, field: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) conflict(`${field}不是有效日期`);
}

function assertPositiveQuantity(quantity: number, field: string) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) conflict(`${field}必须为正整数`);
}

function assertQuantityWithin(quantity: number, maximum: number, field: string) {
  assertPositiveQuantity(quantity, field);
  if (quantity > maximum) conflict(`${field}不能超过来源需求数量`);
}

function sameDate(left: Date, right: Date) {
  return left.getTime() === right.getTime();
}

function expectedRfqLineData(rfq: RfqLineAggregate, id: string) {
  assertPositiveQuantity(rfq.quantity, 'RFQ数量');
  assertDate(rfq.requiredDate, 'RFQ交付日期');
  return {
    id,
    rfqId: rfq.id,
    lineNo: 1,
    partNumber: rfq.partNumber,
    quantity: rfq.quantity,
    uom: rfq.uom || 'EA',
    conditionCode: rfq.conditionCode || 'NE',
    description: rfq.description,
    serialNumber: rfq.serialNumber,
    batchNumber: rfq.batchNumber,
    alternatePartNumbers: rfq.alternatePartNumbers,
    certificateRequired: rfq.certificateRequired,
    certificateType: rfq.certificateType,
    requiredDate: rfq.requiredDate,
    leadTimeDays: rfq.leadTimeDays,
    targetPriceDecimal: normalizeOptionalMoney(rfq.targetPrice),
    targetPriceCurrency: rfq.targetPriceCurrency || 'USD',
    status: 'OPEN',
  };
}

function assertRfqLineProjection(rfq: RfqLineAggregate, line: RfqLineSource) {
  if (line.rfqId !== rfq.id) conflict('RFQ 行不属于当前 RFQ');
  if (line.partNumber !== rfq.partNumber || line.quantity !== rfq.quantity || line.uom !== (rfq.uom || 'EA') || line.conditionCode !== (rfq.conditionCode || 'NE')) {
    conflict('RFQ 行与头表兼容投影冲突，拒绝覆盖');
  }
  if (line.description !== rfq.description || line.serialNumber !== rfq.serialNumber || line.batchNumber !== rfq.batchNumber || line.alternatePartNumbers !== rfq.alternatePartNumbers || line.certificateRequired !== rfq.certificateRequired || line.certificateType !== rfq.certificateType || !sameDate(line.requiredDate, rfq.requiredDate) || line.leadTimeDays !== rfq.leadTimeDays || line.targetPriceCurrency !== (rfq.targetPriceCurrency || 'USD') || !moneyValuesMatch(line.targetPriceDecimal, rfq.targetPrice)) {
    conflict('RFQ 行与头表兼容投影冲突，拒绝覆盖');
  }
}

async function getSingleRfqLine(tx: TransactionLineClient, rfq: RfqLineAggregate, requestedRfqLineId?: string | null) {
  const lines = rfq.lines && rfq.lines.length > 0
    ? rfq.lines
    : await tx.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { lineNo: 'asc' } });
  if (lines.length > 1) lineRequired('当前 RFQ 已有多条需求行，请使用行级交易入口');
  let line = lines[0];
  if (requestedRfqLineId && line && requestedRfqLineId !== line.id) conflict('指定 RFQ 行不属于当前单行兼容入口');
  if (requestedRfqLineId && !line) conflict('指定 RFQ 行不存在，不能由兼容入口猜测创建');
  if (!line) {
    const created = await tx.rfqLine.create({ data: expectedRfqLineData(rfq, randomUUID()) });
    line = created as RfqLineSource;
  }
  assertRfqLineProjection(rfq, line);
  return line;
}

export function assertSingleTransactionLineRequest(lines: unknown, documentName: string) {
  if (lines === undefined) return undefined;
  if (!Array.isArray(lines) || lines.length !== 1) {
    lineRequired(`${documentName}当前仅支持单行兼容入口，多行请求必须提交行级交易`);
  }
  return lines[0] as Record<string, unknown>;
}

function assertQuotationFacts(quotation: QuotationLineAggregate, rfqLine: RfqLineSource) {
  assertUsd(quotation.currency, '报价');
  assertQuantityWithin(quotation.quantity, rfqLine.quantity, '报价数量');
  if (!isExplicitDemandPart({ partNumber: rfqLine.partNumber, alternatePartNumbers: rfqLine.alternatePartNumbers }, quotation.partNumber)) {
    conflict('报价件号不属于 RFQ 明确件号或 alternate，不能自动选择');
  }
  const unit = assertMoneyShadow(quotation.unitPriceDecimal, quotation.unitPrice, '报价单价');
  const total = assertMoneyShadow(quotation.totalPriceDecimal, quotation.totalPrice, '报价总价');
  const cost = assertMoneyShadow(quotation.costPriceDecimal, quotation.costPrice, '报价成本');
  if (!total.equals(calculateMoneyTotal(unit, quotation.quantity))) conflict('报价总价与单价数量不一致');
  return { unit, total, cost };
}

function quotationLineCommercialFactsMatch(existing: ExistingQuotationLine, expected: {
  quotationId: string;
  rfqLineId: string;
  partNumber: string;
  description: string | null;
  uom: string;
  quantity: number;
  unitPrice: MoneyInput;
  costPrice: MoneyInput;
  lineTotal: MoneyInput;
  marginAmount: MoneyInput;
  marginPercent: MoneyInput;
  currency: string;
  sourceSupplierQuoteId?: string | null;
}) {
  return existing.quotationId === expected.quotationId
    && existing.lineNo === 1
    && existing.rfqLineId === expected.rfqLineId
    && existing.partNumber === expected.partNumber
    && existing.description === expected.description
    && existing.uom === expected.uom
    && existing.quantity === expected.quantity
    && normalizeMoney(existing.unitPrice).equals(normalizeMoney(expected.unitPrice))
    && normalizeMoney(existing.costPrice).equals(normalizeMoney(expected.costPrice))
    && normalizeMoney(existing.lineTotal).equals(normalizeMoney(expected.lineTotal))
    && normalizeMoney(existing.marginAmount).equals(normalizeMoney(expected.marginAmount))
    && normalizeMoney(existing.marginPercent).equals(normalizeMoney(expected.marginPercent))
    && existing.currency === expected.currency
    && (expected.sourceSupplierQuoteId === undefined || existing.sourceSupplierQuoteId === expected.sourceSupplierQuoteId);
}

function orderLineCommercialFactsMatch(existing: ExistingOrderLine, expected: {
  orderId: string;
  quotationLineId: string;
  partNumber: string;
  uom: string;
  quantity: number;
  unitPrice: MoneyInput;
  lineTotal: MoneyInput;
  currency: string;
}) {
  return existing.orderId === expected.orderId
    && existing.lineNo === 1
    && existing.quotationLineId === expected.quotationLineId
    && existing.partNumber === expected.partNumber
    && existing.uom === expected.uom
    && existing.quantity === expected.quantity
    && normalizeMoney(existing.unitPrice).equals(normalizeMoney(expected.unitPrice))
    && normalizeMoney(existing.lineTotal).equals(normalizeMoney(expected.lineTotal))
    && existing.currency === expected.currency;
}

/**
 * A lifecycle update is allowed to change only the line's projection state.
 * Re-read the immutable commercial facts first so a stale or hand-edited line
 * cannot be carried forward by a reservation/status transition.
 */
async function assertQuotationLineProjection(
  tx: TransactionLineClient,
  quotation: QuotationLineAggregate,
  line: ExistingQuotationLine,
  options: { checkSource?: boolean } = {},
) {
  if (line.quotationId !== quotation.id) conflict('报价行不属于当前报价');
  const rfqLine = await tx.rfqLine.findUnique({ where: { id: line.rfqLineId } });
  if (!rfqLine || rfqLine.rfqId !== quotation.rfqId) conflict('报价行缺少当前 RFQ 的可信来源行');
  if (line.partNumber !== quotation.partNumber || line.quantity !== quotation.quantity || line.currency !== quotation.currency) {
    conflict('现有报价行与报价头件号、数量或币种不一致，拒绝状态同步');
  }
  if (!isExplicitDemandPart({ partNumber: rfqLine.partNumber, alternatePartNumbers: rfqLine.alternatePartNumbers }, quotation.partNumber)) {
    conflict('报价行件号不属于 RFQ 明确件号或 alternate，拒绝状态同步');
  }
  if (line.uom !== rfqLine.uom || line.description !== rfqLine.description) {
    conflict('现有报价行与 RFQ 行描述或单位不一致，拒绝状态同步');
  }
  assertUsd(quotation.currency, '报价');
  const unitPrice = assertMoneyShadow(quotation.unitPriceDecimal, quotation.unitPrice, '报价单价');
  const totalPrice = assertMoneyShadow(quotation.totalPriceDecimal, quotation.totalPrice, '报价总价');
  const costPrice = assertMoneyShadow(quotation.costPriceDecimal, quotation.costPrice, '报价成本');
  const expectedMarginAmount = totalPrice.minus(calculateMoneyTotal(costPrice, quotation.quantity));
  const expectedMarginPercent = normalizeMoney(calculateMarginPercent(totalPrice, costPrice, quotation.quantity));
  if (!normalizeMoney(line.unitPrice).equals(unitPrice)
    || !normalizeMoney(line.lineTotal).equals(totalPrice)
    || !normalizeMoney(line.costPrice).equals(costPrice)
    || !normalizeMoney(line.marginAmount).equals(expectedMarginAmount)
    || !normalizeMoney(line.marginPercent).equals(expectedMarginPercent)) {
    conflict('现有报价行 Decimal 商业事实与报价头不一致，拒绝状态同步');
  }
  const expectedSourceSupplierQuoteId = String(quotation.costSourceType || '').toUpperCase() === 'SUPPLIER_QUOTE'
    ? quotation.costSourceId || null
    : null;
  if (options.checkSource !== false && line.sourceSupplierQuoteId !== expectedSourceSupplierQuoteId) {
    conflict('报价行来源与报价头成本来源不一致，拒绝状态同步');
  }
}

async function assertLiveSupplierQuoteForLine(
  tx: TransactionLineClient,
  quotation: QuotationLineAggregate,
  line: RfqLineSource,
  sourceSupplierQuoteId: string,
  partNumber: string,
  quantity: number,
) {
  const source = await tx.supplierQuote.findUnique({ where: { id: sourceSupplierQuoteId } });
  if (!source || source.rfqId !== quotation.rfqId || (source.rfqLineId && source.rfqLineId !== line.id) || source.partNumber !== partNumber || source.quantity < quantity) {
    conflict('报价成本来源供应商报价与 RFQ 行或报价事实不一致');
  }
}

async function syncQuotationLineStateInternal(tx: TransactionLineClient, quotation: QuotationLineAggregate, lines: ExistingQuotationLine[]) {
  if (lines.length === 0) return null;
  if (lines.length > 1) lineRequired('当前报价已有多条报价行，暂不支持旧单行生命周期操作');
  const line = lines[0];
  await assertQuotationLineProjection(tx, quotation, line);
  const order = await tx.order.findFirst({ where: { quotationId: quotation.id }, select: { quantity: true, status: true } });
  if (order && ['CANCELLED', 'CANCELED'].includes(String(order.status).toUpperCase())) {
    conflict('订单取消后的成交量释放语义尚未定义，拒绝将成交量伪装为零');
  }
  const acceptedQuantity = order?.quantity ?? 0;
  if (acceptedQuantity < 0 || acceptedQuantity > quotation.quantity) conflict('订单成交数量超过报价数量');
  const reservedQuantity = quotation.reservedQuantity;
  if (reservedQuantity < 0 || reservedQuantity > quotation.quantity) conflict('报价预留数量无效');
  const data: Prisma.QuotationLineUncheckedUpdateInput = {
    status: quotationLineStatus(quotation.status, acceptedQuantity, quotation.quantity),
    acceptedQuantity,
    reservedQuantity,
    inventoryDetailId: quotation.inventoryDetailId,
    serialNumber: quotation.serialNumber,
    batchNumber: quotation.batchNumber,
  };
  if (line.status === data.status && line.acceptedQuantity === data.acceptedQuantity && line.reservedQuantity === data.reservedQuantity && line.inventoryDetailId === data.inventoryDetailId && line.serialNumber === data.serialNumber && line.batchNumber === data.batchNumber) return line;
  return tx.quotationLine.update({ where: { id: line.id }, data });
}

export async function ensureSingleQuotationLine(args: {
  tx: TransactionLineClient;
  quotation: QuotationLineAggregate;
  rfq?: RfqLineAggregate | null;
  rfqLineId?: string | null;
  sourceSupplierQuoteId?: string | null;
}) {
  const rfq = args.rfq ?? await args.tx.rFQ.findUnique({ where: { id: args.quotation.rfqId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
  if (!rfq) throw new AppError('关联 RFQ 不存在，不能建立报价行', 404, 'RESOURCE_NOT_FOUND');
  const rfqLine = await getSingleRfqLine(args.tx, rfq as RfqLineAggregate, args.rfqLineId);
  const amounts = assertQuotationFacts(args.quotation, rfqLine);
  const acceptedOrder = await args.tx.order.findFirst({ where: { quotationId: args.quotation.id }, select: { quantity: true } });
  const acceptedQuantity = acceptedOrder?.quantity ?? 0;
  if (acceptedQuantity > args.quotation.quantity) conflict('订单成交数量超过报价数量');
  const expected = {
    quotationId: args.quotation.id,
    rfqLineId: rfqLine.id,
    lineNo: 1,
    partNumber: args.quotation.partNumber,
    description: rfqLine.description,
    uom: rfqLine.uom,
    quantity: args.quotation.quantity,
    unitPrice: amounts.unit,
    costPrice: amounts.cost,
    lineTotal: amounts.total,
    marginAmount: amounts.total.minus(calculateMoneyTotal(amounts.cost, args.quotation.quantity)),
    marginPercent: calculateMarginPercent(amounts.total, amounts.cost, args.quotation.quantity),
    currency: 'USD',
    status: quotationLineStatus(args.quotation.status, acceptedQuantity, args.quotation.quantity),
    acceptedQuantity,
    reservedQuantity: args.quotation.reservedQuantity,
    inventoryDetailId: args.quotation.inventoryDetailId,
    serialNumber: args.quotation.serialNumber,
    batchNumber: args.quotation.batchNumber,
    sourceSupplierQuoteId: args.sourceSupplierQuoteId,
  };
  if (args.sourceSupplierQuoteId) {
    await assertLiveSupplierQuoteForLine(args.tx, args.quotation, rfqLine, args.sourceSupplierQuoteId, args.quotation.partNumber, args.quotation.quantity);
  }
  if (expected.reservedQuantity < 0 || expected.reservedQuantity > expected.quantity) conflict('报价预留数量无效');
  const lines = await args.tx.quotationLine.findMany({ where: { quotationId: args.quotation.id }, orderBy: { lineNo: 'asc' } });
  if (lines.length > 1) lineRequired('当前报价已有多条报价行，暂不支持旧单行入口');
  const existing = lines[0];
  if (!existing) {
    const created = await args.tx.quotationLine.create({ data: { id: randomUUID(), ...expected } });
    return { line: created, rfqLine, created: true };
  }
  if (!quotationLineCommercialFactsMatch(existing, expected)) conflict('现有报价行商业事实与报价头不一致，拒绝静默覆盖');
  const state = await syncQuotationLineStateInternal(args.tx, args.quotation, [existing]);
  return { line: state ?? existing, rfqLine, created: false };
}

export async function syncQuotationLineState(tx: TransactionLineClient, quotation: QuotationLineAggregate) {
  const lines = await tx.quotationLine.findMany({ where: { quotationId: quotation.id }, orderBy: { lineNo: 'asc' } });
  return syncQuotationLineStateInternal(tx, quotation, lines);
}

/**
 * Approval is the only controlled path that may change a line's supplier
 * source after creation. The caller must have captured and validated the new
 * cost source in the same transaction before invoking this projection update.
 */
export async function syncQuotationLineSource(
  tx: TransactionLineClient,
  quotation: QuotationLineAggregate,
  sourceSupplierQuoteId: string | null,
) {
  const lines = await tx.quotationLine.findMany({ where: { quotationId: quotation.id }, orderBy: { lineNo: 'asc' } });
  if (lines.length === 0) return null;
  if (lines.length > 1) lineRequired('当前报价已有多条报价行，暂不支持来源投影同步');
  const line = lines[0];
  await assertQuotationLineProjection(tx, quotation, line, { checkSource: false });
  if (sourceSupplierQuoteId) {
    const source = await tx.supplierQuote.findUnique({ where: { id: sourceSupplierQuoteId } });
    if (!source || source.rfqId !== quotation.rfqId || (source.rfqLineId && source.rfqLineId !== line.rfqLineId) || source.partNumber !== line.partNumber || source.quantity < line.quantity) {
      conflict('审批成本来源供应商报价与报价行来源不一致，拒绝更新行来源');
    }
  }
  if (line.sourceSupplierQuoteId === sourceSupplierQuoteId) return line;
  return tx.quotationLine.update({ where: { id: line.id }, data: { sourceSupplierQuoteId } });
}

/** Keep a legacy-compatible RFQ header status projected onto its single line. */
export async function syncRfqLineState(
  tx: TransactionLineClient,
  rfq: Pick<RfqLineAggregate, 'id'> & { status: string },
) {
  const lines = await tx.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { lineNo: 'asc' } });
  if (lines.length === 0) return null;
  if (lines.length > 1) lineRequired('当前 RFQ 已有多条需求行，暂不支持旧单行状态同步');
  const nextStatus = rfqLineStatus(rfq.status);
  const line = lines[0];
  return line.status === nextStatus
    ? line
    : tx.rfqLine.update({ where: { id: line.id }, data: { status: nextStatus } });
}

export async function ensureSingleOrderLine(args: {
  tx: TransactionLineClient;
  order: OrderLineAggregate;
  quotation: QuotationLineAggregate;
  quotationLine?: ExistingQuotationLine | null;
}) {
  const quotationLines = args.quotationLine
    ? [args.quotationLine]
    : await args.tx.quotationLine.findMany({ where: { quotationId: args.quotation.id }, orderBy: { lineNo: 'asc' } });
  if (quotationLines.length !== 1) lineRequired('当前订单只支持唯一报价行，多行订单必须提交行级交易');
  const quotationLine = quotationLines[0];
  assertUsd(quotationLine.currency, '报价行');
  if (quotationLine.quotationId !== args.quotation.id) conflict('报价行不属于当前报价');
  if (args.order.partNumber !== quotationLine.partNumber) conflict('订单件号与报价行商业事实不一致');
  assertQuantityWithin(args.order.quantity, quotationLine.quantity, '订单数量');
  const lineTotal = assertMoneyShadow(args.order.totalAmountDecimal, args.order.totalAmount, '订单总额');
  const unitPrice = normalizeMoney(quotationLine.unitPrice);
  if (!lineTotal.equals(calculateMoneyTotal(unitPrice, args.order.quantity))) conflict('订单总额与报价行单价数量不一致');
  const expected = {
    orderId: args.order.id,
    quotationLineId: quotationLine.id,
    lineNo: 1,
    partNumber: args.order.partNumber,
    uom: quotationLine.uom,
    quantity: args.order.quantity,
    unitPrice,
    lineTotal,
    currency: 'USD',
    outboundQuantity: args.order.outboundQuantity,
    outboundStatus: args.order.outboundStatus,
    inventoryDetailId: args.order.inventoryDetailId,
    serialNumber: args.order.serialNumber,
    batchNumber: args.order.batchNumber,
  };
  if (expected.outboundQuantity < 0 || expected.outboundQuantity > expected.quantity) conflict('订单出库数量无效');
  if (!['PENDING', 'PARTIAL', 'COMPLETED'].includes(expected.outboundStatus)) conflict('订单出库状态无效');
  const lines = await args.tx.orderLine.findMany({ where: { orderId: args.order.id }, orderBy: { lineNo: 'asc' } });
  if (lines.length > 1) lineRequired('当前订单已有多条订单行，暂不支持旧单行入口');
  const existing = lines[0];
  let line: ExistingOrderLine;
  let created = false;
  if (!existing) {
    line = await args.tx.orderLine.create({ data: { id: randomUUID(), ...expected } });
    created = true;
  } else {
    if (!orderLineCommercialFactsMatch(existing, expected)) conflict('现有订单行商业事实与订单头不一致，拒绝静默覆盖');
    const stateChanged = existing.outboundQuantity !== expected.outboundQuantity || existing.outboundStatus !== expected.outboundStatus || existing.inventoryDetailId !== expected.inventoryDetailId || existing.serialNumber !== expected.serialNumber || existing.batchNumber !== expected.batchNumber;
    line = stateChanged ? await args.tx.orderLine.update({ where: { id: existing.id }, data: { outboundQuantity: expected.outboundQuantity, outboundStatus: expected.outboundStatus, inventoryDetailId: expected.inventoryDetailId, serialNumber: expected.serialNumber, batchNumber: expected.batchNumber } }) : existing;
  }
  await syncQuotationLineState(args.tx, args.quotation);
  return { line, quotationLine, created };
}

export async function syncOrderLineState(tx: TransactionLineClient, order: OrderLineAggregate) {
  const lines = await tx.orderLine.findMany({ where: { orderId: order.id }, orderBy: { lineNo: 'asc' } });
  if (lines.length === 0) return null;
  if (lines.length > 1) lineRequired('当前订单已有多条订单行，暂不支持旧单行生命周期操作');
  const line = lines[0];
  const quotationLine = await tx.quotationLine.findUnique({ where: { id: line.quotationLineId } });
  if (!quotationLine) conflict('订单行缺少报价行来源');
  if (!orderLineCommercialFactsMatch(line, {
    orderId: order.id,
    quotationLineId: quotationLine.id,
    partNumber: order.partNumber,
    uom: quotationLine.uom,
    quantity: order.quantity,
    unitPrice: quotationLine.unitPrice,
    lineTotal: normalizeMoney(order.totalAmountDecimal ?? order.totalAmount),
    currency: 'USD',
  })) conflict('现有订单行商业事实与订单头不一致，拒绝状态同步');
  const stateChanged = line.outboundQuantity !== order.outboundQuantity || line.outboundStatus !== order.outboundStatus || line.inventoryDetailId !== order.inventoryDetailId || line.serialNumber !== order.serialNumber || line.batchNumber !== order.batchNumber;
  const updated = stateChanged ? await tx.orderLine.update({ where: { id: line.id }, data: { outboundQuantity: order.outboundQuantity, outboundStatus: order.outboundStatus, inventoryDetailId: order.inventoryDetailId, serialNumber: order.serialNumber, batchNumber: order.batchNumber } }) : line;
  return updated;
}
