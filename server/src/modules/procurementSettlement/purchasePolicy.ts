import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { isQuotationApprovalLevelSufficient, requiredQuotationApprovalLevel,
  QUOTATION_APPROVAL_POLICY_VERSION } from '../../lib/quotationApprovalPolicy.js';
import type { CapabilityActor } from '../../lib/capabilityPolicy.js';

// Purchase and sales approvals use the same user-confirmed USD authority tiers.
export const PURCHASE_APPROVAL_POLICY_VERSION = QUOTATION_APPROVAL_POLICY_VERSION;
export type PurchasePolicyLine = {
  id: string; lineNo: number; orderLineId: string; sourceSupplierQuoteId: string | null;
  quantity: number; unitCost: Prisma.Decimal.Value; lineTotal: Prisma.Decimal.Value;
  currency: string; promisedDate: Date | string; fulfillmentMode: 'STOCK_RECEIPT' | 'SUPPLIER_DIRECT';
  partNumber: string; uom: string; identitySnapshot: unknown;
  sourceSnapshot: unknown;
};
export type PurchasePolicySource = {
  orderId: string; supplierId: string; currency: string; totalCost: Prisma.Decimal.Value;
  paymentTerms: string | null; lines: PurchasePolicyLine[];
};

function invalid(message: string): never { throw new AppError(message, 409, 'RESOURCE_CONFLICT'); }
function usd(currency: string) {
  if (currency !== 'USD') invalid('采购承诺必须使用已核实的 USD 币种');
}
function money(value: Prisma.Decimal.Value) {
  let amount: Prisma.Decimal;
  try { amount = new Prisma.Decimal(value); } catch { invalid('采购金额无效'); }
  if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 4
    || amount.gt('99999999999999.9999')) invalid('采购金额必须是 Decimal(18,4) 范围内的非负金额');
  return amount;
}
function identifier(value: string) {
  if (typeof value !== 'string' || !value.trim()) invalid('采购来源标识不能为空');
  return value;
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function buildPurchaseApprovalSnapshot(source: PurchasePolicySource) {
  usd(source.currency);
  identifier(source.orderId); identifier(source.supplierId);
  if (!Array.isArray(source.lines) || !source.lines.length || source.lines.length > 100) invalid('采购承诺必须有 1 至 100 条明确来源行');
  if (new Set(source.lines.map(line => line.id)).size !== source.lines.length
    || new Set(source.lines.map(line => line.lineNo)).size !== source.lines.length
    || new Set(source.lines.map(line => line.orderLineId)).size !== source.lines.length) invalid('采购行标识、行号或销售来源行不能重复');
  let total = new Prisma.Decimal(0);
  const lines = [...source.lines].sort((a, b) => a.lineNo - b.lineNo).map(line => {
    identifier(line.id); identifier(line.orderLineId); identifier(line.partNumber); identifier(line.uom);
    if (!Number.isInteger(line.lineNo) || line.lineNo < 1 || line.lineNo > 100
      || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 2147483647) invalid('采购行号或数量无效');
    usd(line.currency);
    const unitCost = money(line.unitCost);
    const lineTotal = money(line.lineTotal);
    if (!unitCost.mul(line.quantity).equals(lineTotal)) invalid('采购行金额与数量、单位成本不符');
    total = money(total.plus(lineTotal));
    const promisedDate = new Date(line.promisedDate);
    if (Number.isNaN(promisedDate.getTime())) invalid('采购交期必须是有效日期');
    if (!['STOCK_RECEIPT', 'SUPPLIER_DIRECT'].includes(line.fulfillmentMode)) invalid('采购履约方式无效');
    if (!line.sourceSnapshot || typeof line.sourceSnapshot !== 'object' || Array.isArray(line.sourceSnapshot)) invalid('采购成本来源快照缺失');
    if (!line.identitySnapshot || typeof line.identitySnapshot !== 'object' || Array.isArray(line.identitySnapshot)) invalid('采购实物要求快照缺失');
    return { id: line.id, lineNo: line.lineNo, orderLineId: line.orderLineId,
      sourceSupplierQuoteId: line.sourceSupplierQuoteId, quantity: line.quantity,
      unitCost: unitCost.toFixed(4), lineTotal: lineTotal.toFixed(4), currency: 'USD',
      promisedDate: promisedDate.toISOString(), fulfillmentMode: line.fulfillmentMode,
      partNumber: line.partNumber, uom: line.uom, identitySnapshot: canonical(line.identitySnapshot),
      sourceSnapshot: canonical(line.sourceSnapshot) };
  });
  if (!total.equals(money(source.totalCost))) invalid('采购头金额与全部行合计不符');
  return { schemaVersion: 1, policyVersion: PURCHASE_APPROVAL_POLICY_VERSION,
    orderId: source.orderId, supplierId: source.supplierId, currency: 'USD', totalCost: total.toFixed(4),
    paymentTerms: source.paymentTerms, lines };
}

export function purchaseApprovalFingerprint(source: PurchasePolicySource) {
  return createHash('sha256').update(JSON.stringify(canonical(buildPurchaseApprovalSnapshot(source)))).digest('hex');
}

export function assertPurchaseApprovalActor(args: {
  actor: CapabilityActor; createdById: string; submittedById?: string | null;
  source: PurchasePolicySource;
}) {
  identifier(args.actor.id); identifier(args.createdById);
  if (args.actor.id === args.createdById || args.actor.id === args.submittedById) {
    throw new AppError('采购创建人或提交人不能审批自己的采购承诺', 403, 'SELF_APPROVAL_FORBIDDEN');
  }
  const snapshot = buildPurchaseApprovalSnapshot(args.source);
  // Four-decimal values near the fixed 5,000 / 50,000 boundaries retain the
  // comparison in IEEE-754; larger allowed amounts unambiguously need GM.
  const level = requiredQuotationApprovalLevel(Number(snapshot.totalCost));
  if (!isQuotationApprovalLevelSufficient(args.actor.role, level)) {
    throw new AppError(`当前角色无权审批 ${level} 级别采购承诺`, 403, 'AUTH_FORBIDDEN');
  }
  return { level, policyVersion: PURCHASE_APPROVAL_POLICY_VERSION, snapshot };
}
