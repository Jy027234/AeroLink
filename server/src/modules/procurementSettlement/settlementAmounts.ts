import { Prisma } from '@prisma/client';

export const SETTLEMENT_CURRENCY = 'USD' as const;
export const SETTLEMENT_DECIMAL_PLACES = 4 as const;

/** Inputs are intentionally limited to values Prisma.Decimal can represent. */
export type SettlementDecimalInput = Prisma.Decimal | number | string;
export type SettlementSide = 'RECEIVABLE' | 'PAYABLE';
export type SettlementEventKind = 'PAYMENT' | 'CREDIT' | 'REFUND' | 'REVERSAL';

export type SettlementEvent = Readonly<{
  id: string;
  kind: SettlementEventKind;
  side: SettlementSide;
  amount: SettlementDecimalInput;
  /** Omitted means USD; a supplied currency must still be USD. */
  currency?: string;
  /** Required only for REVERSAL and must point to a non-REVERSAL event. */
  reversalOfId?: string | null;
}>;

export type DeriveSettlementAmountsInput = Readonly<{
  initialReceivable: SettlementDecimalInput;
  initialPayable: SettlementDecimalInput;
  events: readonly SettlementEvent[];
  /** Omitted means USD; this function never derives an exchange rate. */
  currency?: string;
}>;

export type SettlementSideAmounts = Readonly<{
  initialAmount: Prisma.Decimal;
  grossPaid: Prisma.Decimal;
  refunded: Prisma.Decimal;
  effectivePaid: Prisma.Decimal;
  creditReduction: Prisma.Decimal;
  adjustedDue: Prisma.Decimal;
  unpaid: Prisma.Decimal;
  /** Cash remaining above the original amount before credit adjustments. */
  overpaid: Prisma.Decimal;
  /** Cash remaining above adjustedDue, including credit-created refunds. */
  pendingRefund: Prisma.Decimal;
}>;

export type SettlementAmounts = Readonly<{
  currency: typeof SETTLEMENT_CURRENCY;
  receivable: SettlementSideAmounts;
  payable: SettlementSideAmounts;
}>;

export type SettlementAmountErrorCode =
  | 'INVALID_AMOUNT'
  | 'NEGATIVE_AMOUNT'
  | 'ZERO_EVENT_AMOUNT'
  | 'DECIMAL_SCALE_EXCEEDED'
  | 'DECIMAL_OVERFLOW'
  | 'UNSUPPORTED_CURRENCY'
  | 'INVALID_EVENT'
  | 'DUPLICATE_EVENT_ID'
  | 'UNKNOWN_REVERSAL_TARGET'
  | 'REVERSAL_TARGET_INVALID'
  | 'DUPLICATE_REVERSAL'
  | 'REVERSAL_AMOUNT_MISMATCH'
  | 'CREDIT_EXCEEDS_INITIAL'
  | 'REFUND_EXCEEDS_PAYMENT';

export class SettlementAmountError extends Error {
  readonly code: SettlementAmountErrorCode;

  constructor(message: string, code: SettlementAmountErrorCode) {
    super(message);
    this.name = 'SettlementAmountError';
    this.code = code;
  }
}

// Prisma Decimal(18,4) allows at most 14 integer digits for these USD facts.
const MAX_DECIMAL_18_4 = new Prisma.Decimal('99999999999999.9999');
const ZERO = new Prisma.Decimal(0);

function reject(message: string, code: SettlementAmountErrorCode): never {
  throw new SettlementAmountError(message, code);
}

function normalizeCurrency(value: unknown, field: string): typeof SETTLEMENT_CURRENCY {
  if (value === undefined) return SETTLEMENT_CURRENCY;
  if (typeof value !== 'string' || value.trim().toUpperCase() !== SETTLEMENT_CURRENCY) {
    reject(`${field}只支持 USD，不能隐式换汇`, 'UNSUPPORTED_CURRENCY');
  }
  return SETTLEMENT_CURRENCY;
}

function normalizeSide(value: unknown, field: string): SettlementSide {
  if (value === 'RECEIVABLE' || value === 'PAYABLE') return value;
  reject(`${field}必须是 RECEIVABLE 或 PAYABLE`, 'INVALID_EVENT');
}

function normalizeKind(value: unknown): SettlementEventKind {
  if (value === 'PAYMENT' || value === 'CREDIT' || value === 'REFUND' || value === 'REVERSAL') return value;
  reject('结算凭证类型无效', 'INVALID_EVENT');
}

function decimal(value: unknown, field: string, requirePositive: boolean): Prisma.Decimal {
  let parsed: Prisma.Decimal;
  try {
    parsed = new Prisma.Decimal(value as Prisma.Decimal.Value);
  } catch {
    reject(`${field}不是有效 Decimal 金额`, 'INVALID_AMOUNT');
  }
  if (!parsed.isFinite()) reject(`${field}必须是有限 Decimal 金额`, 'INVALID_AMOUNT');
  if (parsed.isNegative()) reject(`${field}不能为负数`, 'NEGATIVE_AMOUNT');
  if (requirePositive && parsed.isZero()) reject(`${field}必须大于零`, 'ZERO_EVENT_AMOUNT');
  if (parsed.decimalPlaces() > SETTLEMENT_DECIMAL_PLACES) {
    reject(`${field}超过四位有效小数`, 'DECIMAL_SCALE_EXCEEDED');
  }
  if (parsed.gt(MAX_DECIMAL_18_4)) reject(`${field}超过 Decimal(18,4) 范围`, 'DECIMAL_OVERFLOW');
  return parsed.toDecimalPlaces(SETTLEMENT_DECIMAL_PLACES);
}

function checkedAdd(left: Prisma.Decimal, right: Prisma.Decimal, field: string) {
  const result = left.plus(right);
  if (result.gt(MAX_DECIMAL_18_4)) reject(`${field}超过 Decimal(18,4) 范围`, 'DECIMAL_OVERFLOW');
  return result.toDecimalPlaces(SETTLEMENT_DECIMAL_PLACES);
}

function subtractNonNegative(left: Prisma.Decimal, right: Prisma.Decimal, field: string) {
  const result = left.minus(right);
  if (result.isNegative()) reject(`${field}计算结果不能为负数`, 'INVALID_AMOUNT');
  return result.toDecimalPlaces(SETTLEMENT_DECIMAL_PLACES);
}

function maxZero(value: Prisma.Decimal) {
  return value.isNegative() ? ZERO : value.toDecimalPlaces(SETTLEMENT_DECIMAL_PLACES);
}

function summarize(initialAmount: Prisma.Decimal, payment: Prisma.Decimal, credit: Prisma.Decimal, refund: Prisma.Decimal): SettlementSideAmounts {
  if (credit.gt(initialAmount)) {
    reject('累计信用冲减不能超过该方向的初始金额', 'CREDIT_EXCEEDS_INITIAL');
  }
  if (refund.gt(payment)) {
    reject('有效退款不能超过有效付款', 'REFUND_EXCEEDS_PAYMENT');
  }
  const effectivePaid = subtractNonNegative(payment, refund, '有效已付');
  const adjustedDue = subtractNonNegative(initialAmount, credit, '调整后应付');
  return {
    initialAmount,
    grossPaid: payment,
    refunded: refund,
    effectivePaid,
    creditReduction: credit,
    adjustedDue,
    unpaid: maxZero(adjustedDue.minus(effectivePaid)),
    overpaid: maxZero(effectivePaid.minus(initialAmount)),
    pendingRefund: maxZero(effectivePaid.minus(adjustedDue)),
  };
}

/**
 * Derive settlement balances from immutable external voucher facts.
 *
 * A PAYMENT increases cash paid on its side, a REFUND reduces that cash, and
 * a CREDIT reduces the amount due. A REVERSAL cancels exactly one original
 * non-REVERSAL event and never creates a new financial amount. This is only a
 * settlement summary; it does not invent ledger, tax, FX, or accounting rows.
 */
export function deriveSettlementAmounts(input: DeriveSettlementAmountsInput): SettlementAmounts {
  if (!input || !Array.isArray(input.events)) reject('结算凭证列表无效', 'INVALID_EVENT');
  normalizeCurrency(input.currency, '结算币种');
  const initialReceivable = decimal(input.initialReceivable, '初始应收', false);
  const initialPayable = decimal(input.initialPayable, '初始应付', false);

  const events: Array<SettlementEvent & {
    id: string;
    kind: SettlementEventKind;
    side: SettlementSide;
    amount: Prisma.Decimal;
    currency: typeof SETTLEMENT_CURRENCY;
    reversalOfId?: string | null;
  }> = [];
  const byId = new Map<string, (typeof events)[number]>();

  for (const raw of input.events) {
    if (!raw || typeof raw !== 'object') reject('结算凭证事件无效', 'INVALID_EVENT');
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) reject('结算凭证事件缺少 id', 'INVALID_EVENT');
    if (byId.has(id)) reject(`结算凭证 id 重复：${id}`, 'DUPLICATE_EVENT_ID');
    const kind = normalizeKind(raw.kind);
    const side = normalizeSide(raw.side, `凭证 ${id} 方向`);
    const currency = normalizeCurrency(raw.currency, `凭证 ${id} 币种`);
    const amount = decimal(raw.amount, `凭证 ${id} 金额`, true);
    const reversalOfId = raw.reversalOfId == null ? undefined : String(raw.reversalOfId).trim();
    if (kind === 'REVERSAL' && !reversalOfId) reject(`冲销凭证 ${id} 缺少原事件 id`, 'INVALID_EVENT');
    if (kind !== 'REVERSAL' && reversalOfId) reject(`非冲销凭证 ${id} 不能引用原事件`, 'INVALID_EVENT');
    const event = { id, kind, side, amount, currency, reversalOfId } as (typeof events)[number];
    events.push(event);
    byId.set(id, event);
  }

  const reversedIds = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'REVERSAL') continue;
    const targetId = event.reversalOfId!;
    const target = byId.get(targetId);
    if (!target) reject(`冲销凭证 ${event.id} 引用未知事件 ${targetId}`, 'UNKNOWN_REVERSAL_TARGET');
    if (target.kind === 'REVERSAL') reject('不能再次冲销 REVERSAL 事件', 'REVERSAL_TARGET_INVALID');
    if (target.side !== event.side || target.currency !== event.currency) {
      reject(`冲销凭证 ${event.id} 与原事件方向或币种不一致`, 'REVERSAL_TARGET_INVALID');
    }
    if (!event.amount.eq(target.amount)) reject(`冲销凭证 ${event.id} 金额必须等于原事件金额`, 'REVERSAL_AMOUNT_MISMATCH');
    if (reversedIds.has(target.id)) reject(`原事件 ${target.id} 不能重复冲销`, 'DUPLICATE_REVERSAL');
    reversedIds.add(target.id);
  }

  const accumulators: Record<SettlementSide, { payment: Prisma.Decimal; credit: Prisma.Decimal; refund: Prisma.Decimal }> = {
    RECEIVABLE: { payment: ZERO, credit: ZERO, refund: ZERO },
    PAYABLE: { payment: ZERO, credit: ZERO, refund: ZERO },
  };
  for (const event of events) {
    if (event.kind === 'REVERSAL' || reversedIds.has(event.id)) continue;
    const accumulator = accumulators[event.side];
    if (event.kind === 'PAYMENT') accumulator.payment = checkedAdd(accumulator.payment, event.amount, `${event.side}有效付款`);
    if (event.kind === 'CREDIT') accumulator.credit = checkedAdd(accumulator.credit, event.amount, `${event.side}信用冲减`);
    if (event.kind === 'REFUND') accumulator.refund = checkedAdd(accumulator.refund, event.amount, `${event.side}有效退款`);
  }

  return {
    currency: SETTLEMENT_CURRENCY,
    receivable: summarize(initialReceivable, accumulators.RECEIVABLE.payment, accumulators.RECEIVABLE.credit, accumulators.RECEIVABLE.refund),
    payable: summarize(initialPayable, accumulators.PAYABLE.payment, accumulators.PAYABLE.credit, accumulators.PAYABLE.refund),
  };
}
