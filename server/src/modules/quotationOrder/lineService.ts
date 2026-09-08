import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { calculateMoneyTotal, normalizeMoney } from '../../lib/money.js';
import { assertSupportedSaleType } from '../../lib/commercialScope.js';
import { assertQuotationApprovalActor, assertQuotationValidity, buildQuotationApprovalSnapshot, QUOTATION_APPROVAL_POLICY_VERSION } from '../../lib/quotationApprovalPolicy.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { captureQuotationLineCost, assertLineCostSnapshot, buildCommercialApprovalSnapshot, hashCommercialApprovalSnapshot } from '../../lib/lineQuotationPolicy.js';
import { createInitialStatusHistory, StateTransitionConflictError } from '../../lib/transactionStateService.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { assertActiveQuotationRevision } from '../../lib/quotationRevisionPolicy.js';
import { freezeQuotationDocument } from '../../lib/quotationDocumentService.js';

export type LineQuoteInput = {
  rfqLineId: string; partNumber: string; quantity: number; unitPrice: number; costPrice: number;
  costSourceType: string; costSourceId?: string; costSourceReason?: string;
};
export type LineQuoteCreateInput = {
  rfqId: string; customerId: string; currency: string; lines: LineQuoteInput[];
  saleType?: string; validityDays?: number; template?: string; incoterm?: string; incotermLocation?: string;
  shipToId?: string; shipForId?: string; leadTimeDays?: number; leadTimeBasis?: string;
  taxIncluded?: boolean; taxRate?: number; warrantyDays?: number; warrantyTerms?: string;
  packagingRequirement?: string; shippingMethod?: string; commonNote?: string;
  certificateFiles?: string[]; moq?: number; mpq?: number; priceBasis?: string;
  ccRecipients?: string[] | string; eSignature?: string; eSignatureStatus?: string;
  countryOfOrigin?: string; hsCode?: string; eccn?: string; dualUse?: boolean;
};

export const lineQuoteInclude = {
  lines: { orderBy: { lineNo: 'asc' as const } },
  rfq: { include: { creator: { select: { department: true } } } },
  customer: true, creator: { select: { department: true } },
  approvals: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.QuotationInclude;
export type LineQuotation = Prisma.QuotationGetPayload<{ include: typeof lineQuoteInclude }>;
type Tx = Prisma.TransactionClient;

function fail(message: string, code: 'BAD_REQUEST' | 'RESOURCE_CONFLICT' = 'BAD_REQUEST'): never {
  throw new AppError(message, 409, code);
}

function assertDistinct(ids: string[]) {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) fail('必须选择 1 至 100 条不同的来源行');
}

function assertQuantity(quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) fail('行数量必须为正整数');
}

export async function loadLineQuotation(tx: Tx, id: string) {
  const quotation = await tx.quotation.findUnique({ where: { id }, include: lineQuoteInclude });
  if (!quotation) throw new AppError('报价不存在', 404, 'RESOURCE_NOT_FOUND');
  if (!quotation.lineItemsMode) fail('该报价应通过单行兼容流程处理');
  return quotation;
}

type ApprovalQuotation = Parameters<typeof buildQuotationApprovalSnapshot>[0] & { lines: LineQuotation['lines']; approvals: Array<Pick<LineQuotation['approvals'][number], 'action' | 'policyVersion' | 'snapshotJson'>> };

export function lineQuotationSnapshot(quotation: ApprovalQuotation) {
  return buildCommercialApprovalSnapshot({ headerTerms: buildQuotationApprovalSnapshot(quotation), lines: quotation.lines });
}

export function hasCurrentLineQuotationApproval(quotation: ApprovalQuotation) {
  const decision = quotation.approvals[0];
  if (!decision || decision.action !== 'APPROVE' || decision.policyVersion !== `${QUOTATION_APPROVAL_POLICY_VERSION}-lines-v1` || !decision.snapshotJson) return false;
  try {
    return hashCommercialApprovalSnapshot(JSON.parse(decision.snapshotJson)) === hashCommercialApprovalSnapshot(lineQuotationSnapshot(quotation));
  } catch { return false; }
}

export function assertLineQuotationCommercialTerms(quotation: LineQuotation) {
  assertActiveQuotationRevision(quotation);
  assertSupportedSaleType(quotation.saleType);
  assertLineCommercialAmounts(quotation);
  for (const line of quotation.lines) assertLineCostSnapshot(line);
  if (quotation.currency !== 'USD') fail('报价币种无效或已过期');
  assertQuotationValidity(quotation);
  if (!hasCurrentLineQuotationApproval(quotation)) fail('报价行或条款已变化，需要重新审批');
}

async function assertSharedInventoryCapacity(tx: Tx, lines: Array<{ costSourceType?: string | null; costSourceId?: string | null; quantity: number }>, quotationId?: string) {
  const grouped = new Map<string, { quantity: number; count: number }>();
  for (const line of lines) {
    if (line.costSourceType !== 'INVENTORY_DETAIL' || !line.costSourceId) continue;
    const previous = grouped.get(line.costSourceId) ?? { quantity: 0, count: 0 };
    grouped.set(line.costSourceId, { quantity: previous.quantity + line.quantity, count: previous.count + 1 });
  }
  for (const [id, requested] of grouped) {
    if (requested.count < 2) continue;
    const [detail, reservations] = await Promise.all([
      tx.inventoryDetail.findUnique({ where: { id }, select: { quantity: true } }),
      tx.quotation.aggregate({ where: { inventoryDetailId: id, reservedQuantity: { gt: 0 },
        ...(quotationId ? { id: { not: quotationId } } : {}), status: { notIn: ['WITHDRAWN', 'REJECTED', 'CANCELLED'] } }, _sum: { reservedQuantity: true } }),
    ]);
    if (!detail || requested.quantity > detail.quantity - (reservations._sum.reservedQuantity ?? 0)) fail('多条报价行共同引用的库存可用数量不足');
  }
}

export function assertLineCommercialAmounts(quotation: LineQuotation) {
  assertDistinct(quotation.lines.map(line => line.rfqLineId));
  let total = normalizeMoney(0);
  for (const line of quotation.lines) {
    assertQuantity(line.quantity);
    const expectedTotal = calculateMoneyTotal(line.unitPrice, line.quantity);
    const expectedMargin = expectedTotal.minus(calculateMoneyTotal(line.costPrice, line.quantity));
    const expectedMarginPercent = expectedTotal.isZero()
      ? normalizeMoney(0)
      : expectedMargin.div(expectedTotal).mul(100).toDecimalPlaces(4);
    if (line.unitPrice.isNegative() || line.costPrice.isNegative() || !line.lineTotal.equals(expectedTotal)
      || !line.marginAmount.equals(expectedMargin) || line.currency !== 'USD'
      || !line.marginPercent.equals(expectedMarginPercent)
      || line.acceptedQuantity < 0 || line.acceptedQuantity > line.quantity) fail('报价行金额、币种或成交数量不一致');
    total = total.plus(expectedTotal);
  }
  if (!total.equals(quotation.totalPriceDecimal ?? quotation.totalPrice)) fail('报价行合计与总额不一致');
}

async function recordLineEvent(tx: Tx, quotation: LineQuotation, actorId: string, eventType: string) {
  await enqueueBusinessEvent(tx, {
    eventType, aggregateType: 'QUOTATION', aggregateId: quotation.id,
    data: { quotationId: quotation.id, version: quotation.version, status: quotation.status },
    socket: { event: SocketEvents.QUOTATION_UPDATED, room: SocketRooms.QUOTATIONS }, createdById: actorId,
  });
}

export async function createLineQuotation(args: {
  tx: Tx; actorId: string; input: LineQuoteCreateInput;
  authorizeRfq: (rfq: { createdBy: string; creator?: { department: string | null } | null }) => void;
}) {
  const { tx, actorId, input } = args;
  assertDistinct(input.lines.map(line => line.rfqLineId));
  assertSupportedSaleType(input.saleType);
  if (input.currency !== 'USD') fail('首期交易仅支持 USD');
  const rfq = await tx.rFQ.findUnique({
    where: { id: input.rfqId }, include: { lines: true, creator: { select: { department: true } } },
  });
  if (!rfq) throw new AppError('需求不存在', 404, 'RESOURCE_NOT_FOUND');
  args.authorizeRfq(rfq);
  if (!rfq.lineItemsMode) fail('请先将尚未报价的需求保存为逐行需求，再创建逐行报价');
  if (rfq.customerId !== input.customerId || ['COMPLETED', 'CANCELLED'].includes(rfq.status)) fail('需求客户不匹配或需求已关闭');
  const byId = new Map(rfq.lines.map(line => [line.id, line]));
  await assertSharedInventoryCapacity(tx, input.lines);
  const lines: Prisma.QuotationLineCreateWithoutQuotationInput[] = [];
  let total = normalizeMoney(0);
  let cost = normalizeMoney(0);
  for (const [index, inputLine] of input.lines.entries()) {
    assertQuantity(inputLine.quantity);
    const rfqLine = byId.get(inputLine.rfqLineId);
    if (!rfqLine || rfqLine.status !== 'OPEN' || inputLine.quantity > rfqLine.quantity) fail('需求行不存在、已关闭或报价数量超出需求');
    const unitPrice = normalizeMoney(inputLine.unitPrice);
    const costPrice = normalizeMoney(inputLine.costPrice);
    if (unitPrice.isNegative() || costPrice.isNegative()) fail('价格不能为负数');
    const source = await captureQuotationLineCost({ tx, rfqId: rfq.id, rfqLine, input: { ...inputLine, currency: 'USD' } });
    const lineTotal = calculateMoneyTotal(unitPrice, inputLine.quantity);
    const lineCost = calculateMoneyTotal(costPrice, inputLine.quantity);
    total = total.plus(lineTotal); cost = cost.plus(lineCost);
    const { sourceSupplierQuoteId, ...costEvidence } = source;
    lines.push({
      id: randomUUID(), lineNo: index + 1, rfqLine: { connect: { id: rfqLine.id } },
      partNumber: inputLine.partNumber, description: rfqLine.description, uom: rfqLine.uom,
      quantity: inputLine.quantity, unitPrice, costPrice, lineTotal, marginAmount: lineTotal.minus(lineCost),
      marginPercent: lineTotal.isZero() ? normalizeMoney(0) : lineTotal.minus(lineCost).div(lineTotal).mul(100).toDecimalPlaces(4),
      currency: 'USD', status: 'DRAFT', ...costEvidence,
      ...(sourceSupplierQuoteId ? { sourceSupplierQuote: { connect: { id: sourceSupplierQuoteId } } } : {}),
    });
  }
  const validityDays = rfq.urgency === 'AOG' ? 1 : input.validityDays ?? 7;
  const expiryDate = new Date(Date.now() + validityDays * 86_400_000);
  const quotation = await tx.quotation.create({
    data: {
      quoteNumber: `QT-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`,
      lineItemsMode: true, rfqId: rfq.id, customerId: rfq.customerId, createdBy: actorId,
      // Legacy scalar columns remain compatibility projections; line facts
      // and the aggregate total are authoritative for this mode.
      partNumber: input.lines[0].partNumber, quantity: input.lines.reduce((sum, line) => sum + line.quantity, 0),
      unitPrice: 0, unitPriceDecimal: normalizeMoney(0), costPrice: 0, costPriceDecimal: normalizeMoney(0),
      totalPrice: total.toNumber(), totalPriceDecimal: total,
      margin: total.isZero() ? 0 : total.minus(cost).div(total).mul(100).toDecimalPlaces(4).toNumber(),
      currency: 'USD', saleType: 'Sale', status: 'DRAFT', statusEnum: 'DRAFT', validityDays, expiryDate, validityDeadline: expiryDate,
      template: input.template ?? 'STANDARD', incoterm: input.incoterm, incotermLocation: input.incotermLocation,
      shipToId: input.shipToId, shipForId: input.shipForId, leadTimeDays: input.leadTimeDays, leadTimeBasis: input.leadTimeBasis,
      taxIncluded: input.taxIncluded ?? true, taxRate: input.taxRate, warrantyDays: input.warrantyDays ?? 90,
      warrantyTerms: input.warrantyTerms, packagingRequirement: input.packagingRequirement,
      shippingMethod: input.shippingMethod, commonNote: input.commonNote, lines: { create: lines },
      certificateFiles: input.certificateFiles?.join(','), moq: input.moq, mpq: input.mpq, priceBasis: input.priceBasis,
      ccRecipients: Array.isArray(input.ccRecipients) ? JSON.stringify(input.ccRecipients) : input.ccRecipients,
      eSignature: input.eSignature, eSignatureStatus: input.eSignatureStatus ?? 'Unsigned',
      countryOfOrigin: input.countryOfOrigin, hsCode: input.hsCode, eccn: input.eccn, dualUse: input.dualUse ?? false,
    }, include: lineQuoteInclude,
  });
  await createInitialStatusHistory(tx, { entityType: 'QUOTATION', entityId: quotation.id, toStatus: 'DRAFT', actorId, reasonCode: 'LINE_QUOTATION_CREATED', version: quotation.version });
  await recordLineEvent(tx, quotation, actorId, 'quotation.created');
  return { quotation };
}

async function changeState(tx: Tx, quotation: LineQuotation, actorId: string, next: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'SENT' | 'ACCEPTED', expectedVersion?: number) {
  if (expectedVersion !== undefined && quotation.version !== expectedVersion) throw new StateTransitionConflictError();
  const result = await tx.quotation.updateMany({ where: { id: quotation.id, version: quotation.version }, data: {
    status: next, statusEnum: next, version: { increment: 1 },
    ...(next === 'APPROVED' ? { approvedBy: actorId, approvedAt: new Date() } : {}),
  } });
  if (result.count !== 1) throw new StateTransitionConflictError();
  if (['PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(next)) {
    await tx.quotationLine.updateMany({ where: { quotationId: quotation.id }, data: { status: next } });
  }
  await tx.transactionStatusHistory.create({ data: {
    entityType: 'QUOTATION', entityId: quotation.id, fromStatus: quotation.status, toStatus: next,
    actorId, reasonCode: `LINE_QUOTATION_${next}`, version: quotation.version + 1,
  } });
  const updated = await loadLineQuotation(tx, quotation.id);
  await recordLineEvent(tx, updated, actorId, 'quotation.updated');
  return updated;
}

export async function submitLineQuotation(tx: Tx, quotation: LineQuotation, actorId: string, version?: number) {
  assertActiveQuotationRevision(quotation);
  if (!['DRAFT', 'REJECTED'].includes(quotation.status)) fail('只有草稿或已驳回报价可提交审批');
  return { quotation: await changeState(tx, quotation, actorId, 'PENDING_APPROVAL', version) };
}

export async function approveLineQuotation(args: {
  tx: Tx; quotation: LineQuotation; actorId: string; actorRole: string; action: 'approve' | 'reject'; version?: number; comment?: string;
}) {
  const { tx, quotation, actorId } = args;
  assertActiveQuotationRevision(quotation);
  if (!['PENDING_APPROVAL', 'APPROVED'].includes(quotation.status)) fail('报价当前不可审批');
  if (quotation.lines.some(line => line.acceptedQuantity > 0)) fail('已分批成交的报价不能重置审批，请撤回剩余报价后另建报价');
  assertLineCommercialAmounts(quotation);
  const total = quotation.lines.reduce((sum, line) => sum.plus(line.lineTotal), normalizeMoney(0));
  if (!total.equals(quotation.totalPriceDecimal ?? quotation.totalPrice)) fail('报价行合计与总额不一致');
  const level = assertQuotationApprovalActor({ actorId, actorRole: args.actorRole, creatorId: quotation.createdBy, totalPrice: total.toNumber(), currency: quotation.currency });
  if (args.action === 'approve') {
    assertQuotationValidity(quotation);
    await assertSharedInventoryCapacity(tx, quotation.lines, quotation.id);
    for (const line of quotation.lines) {
      assertLineCostSnapshot(line);
      const rfqLine = await tx.rfqLine.findUnique({ where: { id: line.rfqLineId } });
      if (!rfqLine) fail('需求行不存在');
      // Revalidate current supply at approval without replacing the evidence
      // captured at creation. Later acceptance uses only that evidence.
      await captureQuotationLineCost({ tx, rfqId: quotation.rfqId, rfqLine, quotationId: quotation.id, input: {
        ...line, unitPrice: line.unitPrice.toNumber(), costPrice: line.costPrice.toNumber(), currency: 'USD',
        costSourceType: line.costSourceType ?? '', costSourceId: line.costSourceId ?? undefined, costSourceReason: line.costSourceReason ?? undefined,
      } });
    }
  }
  const snapshot = lineQuotationSnapshot(quotation);
  const updated = await changeState(tx, quotation, actorId, args.action === 'approve' ? 'APPROVED' : 'REJECTED', args.version);
  await tx.approval.create({ data: {
    quotationId: quotation.id, level, requiredLevel: level, policyVersion: `${QUOTATION_APPROVAL_POLICY_VERSION}-lines-v1`,
    reviewedVersion: quotation.version, snapshotJson: JSON.stringify(snapshot), approverId: actorId,
    action: args.action.toUpperCase(), comment: args.comment,
  } });
  if (args.action === 'approve') await freezeQuotationDocument(tx, quotation.id, actorId);
  return { quotation: await loadLineQuotation(tx, updated.id), approvalLevel: level, requiredLevel: level, isNoop: false };
}

export async function acceptLineQuotation(args: {
  tx: Tx; quotation: LineQuotation; actorId: string; version: number;
  lines: Array<{ quotationLineId: string; quantity: number }>;
  poNumber?: string; deliveryDate?: string; confirmationNote?: string;
}) {
  const { tx, quotation, actorId } = args;
  assertLineQuotationCommercialTerms(quotation);
  if (!['APPROVED', 'SENT', 'ACCEPTED'].includes(quotation.status)) fail('报价当前不能登记客户接受');
  if (args.version !== quotation.version) throw new StateTransitionConflictError();
  assertDistinct(args.lines.map(line => line.quotationLineId));
  // Serialize alternative quotations against the same demand as well as the
  // current quotation. An RFQ cannot be sold twice through different offers.
  const rfq = await tx.rFQ.findUnique({ where: { id: quotation.rfqId }, include: { lines: true } });
  if (!rfq || ['COMPLETED', 'CANCELLED'].includes(rfq.status)) fail('需求已关闭或不存在');
  const demandClaim = await tx.rFQ.updateMany({ where: { id: rfq.id, version: rfq.version }, data: { version: { increment: 1 } } });
  if (demandClaim.count !== 1) throw new StateTransitionConflictError();
  const byId = new Map(quotation.lines.map(line => [line.id, line]));
  let total = normalizeMoney(0);
  const orderLines: Prisma.OrderLineCreateWithoutOrderInput[] = [];
  for (const [index, acceptance] of args.lines.entries()) {
    assertQuantity(acceptance.quantity);
    const line = byId.get(acceptance.quotationLineId);
    if (!line || acceptance.quantity > line.quantity - line.acceptedQuantity) fail('所选报价行不存在或成交数量超过剩余报价数量');
    const demand = rfq.lines.find(item => item.id === line.rfqLineId);
    const sold = await tx.orderLine.aggregate({ where: { quotationLine: { rfqLineId: line.rfqLineId }, order: { status: { not: 'CANCELLED' } } }, _sum: { quantity: true } });
    if (!demand || demand.status !== 'OPEN' || (sold._sum.quantity ?? 0) + acceptance.quantity > demand.quantity) fail('成交数量超过需求行剩余数量');
    const lineTotal = calculateMoneyTotal(line.unitPrice, acceptance.quantity);
    total = total.plus(lineTotal);
    orderLines.push({ lineNo: index + 1, quotationLine: { connect: { id: line.id } }, partNumber: line.partNumber,
      uom: line.uom, quantity: acceptance.quantity, unitPrice: line.unitPrice, lineTotal, currency: 'USD',
      serialNumber: line.serialNumber, batchNumber: line.batchNumber,
    });
  }
  // Claim the current quote before writing any accepted counters or order.
  // Concurrent requests can never both claim the same commercial remainder.
  const claim = await tx.quotation.updateMany({ where: { id: quotation.id, version: args.version }, data: {
    version: { increment: 1 }, acceptedAt: quotation.acceptedAt ?? new Date(), customerConfirmationNote: args.confirmationNote,
  } });
  if (claim.count !== 1) throw new StateTransitionConflictError();
  for (const acceptance of args.lines) {
    const previous = byId.get(acceptance.quotationLineId)!;
    const acceptedQuantity = previous.acceptedQuantity + acceptance.quantity;
    const updated = await tx.quotationLine.updateMany({ where: { id: previous.id, acceptedQuantity: previous.acceptedQuantity }, data: {
      acceptedQuantity, status: acceptedQuantity === previous.quantity ? 'ACCEPTED' : 'PARTIALLY_ACCEPTED',
    } });
    if (updated.count !== 1) throw new StateTransitionConflictError();
  }
  const orderNumber = `SO-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const order = await tx.order.create({ data: {
    lineItemsMode: true, orderNumber, soNumber: orderNumber, quotationId: quotation.id, customerId: quotation.customerId,
    partNumber: orderLines[0].partNumber, quantity: args.lines.reduce((sum, line) => sum + line.quantity, 0),
    totalAmount: total.toNumber(), totalAmountDecimal: total, status: 'SO_CREATED', statusEnum: 'SO_CREATED',
    poNumber: args.poNumber, deliveryDate: args.deliveryDate ? new Date(args.deliveryDate) : null,
    saleType: 'Sale', incoterm: quotation.incoterm, incotermLocation: quotation.incotermLocation,
    shipToId: quotation.shipToId, shipForId: quotation.shipForId,
    warrantyDays: quotation.warrantyDays,
    lines: { create: orderLines },
  }, include: { customer: true, lines: { orderBy: { lineNo: 'asc' } } } });
  const allAccepted = quotation.lines.every(line => line.acceptedQuantity + (args.lines.find(accepted => accepted.quotationLineId === line.id)?.quantity ?? 0) === line.quantity);
  const nextStatus = allAccepted ? 'ACCEPTED' : quotation.status === 'SENT' ? 'SENT' : 'APPROVED';
  await tx.quotation.update({ where: { id: quotation.id }, data: { status: nextStatus, statusEnum: nextStatus, orderId: order.id, orderNumber } });
  await createInitialStatusHistory(tx, { entityType: 'ORDER', entityId: order.id, toStatus: 'SO_CREATED', actorId, reasonCode: 'PARTIAL_QUOTATION_ACCEPTED', version: order.version });
  await tx.transactionStatusHistory.create({ data: { entityType: 'QUOTATION', entityId: quotation.id, fromStatus: quotation.status, toStatus: nextStatus, actorId, reasonCode: 'QUOTATION_LINES_ACCEPTED', version: quotation.version + 1 } });
  const updatedQuotation = await loadLineQuotation(tx, quotation.id);
  await recordLineEvent(tx, updatedQuotation, actorId, 'quotation.accepted');
  return { quotation: updatedQuotation, order };
}
