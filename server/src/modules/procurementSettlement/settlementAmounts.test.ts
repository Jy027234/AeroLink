import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  deriveSettlementAmounts,
  type SettlementEvent,
  type SettlementSide,
} from './settlementAmounts.js';

function event(
  id: string,
  kind: SettlementEvent['kind'],
  amount: string | number,
  side: SettlementSide = 'RECEIVABLE',
  extra: Partial<SettlementEvent> = {},
): SettlementEvent {
  return { id, kind, amount, side, currency: 'USD', ...extra };
}

function codeOf(action: () => unknown) {
  try {
    action();
    throw new Error('expected settlement validation to fail');
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('deriveSettlementAmounts', () => {
  it('derives both receivable and payable summaries without inventing ledger or tax facts', () => {
    const result = deriveSettlementAmounts({
      initialReceivable: '100.0000',
      initialPayable: '80.0000',
      events: [
        event('customer-payment', 'PAYMENT', '100.0000'),
        event('customer-refund', 'REFUND', '5.0000'),
        event('customer-credit', 'CREDIT', '10.0000'),
        event('supplier-payment', 'PAYMENT', '50.0000', 'PAYABLE'),
        event('supplier-credit', 'CREDIT', '5.0000', 'PAYABLE'),
      ],
    });

    expect(result.currency).toBe('USD');
    expect(result.receivable.grossPaid.toFixed(4)).toBe('100.0000');
    expect(result.receivable.refunded.toFixed(4)).toBe('5.0000');
    expect(result.receivable.effectivePaid.toFixed(4)).toBe('95.0000');
    expect(result.receivable.creditReduction.toFixed(4)).toBe('10.0000');
    expect(result.receivable.adjustedDue.toFixed(4)).toBe('90.0000');
    expect(result.receivable.unpaid.toFixed(4)).toBe('0.0000');
    expect(result.receivable.overpaid.toFixed(4)).toBe('0.0000');
    expect(result.receivable.pendingRefund.toFixed(4)).toBe('5.0000');
    expect(result.payable.adjustedDue.toFixed(4)).toBe('75.0000');
    expect(result.payable.unpaid.toFixed(4)).toBe('25.0000');
  });

  it('allows a credit after full payment to create a pending refund', () => {
    const result = deriveSettlementAmounts({
      initialReceivable: '100',
      initialPayable: '0',
      events: [event('paid', 'PAYMENT', '100'), event('credit', 'CREDIT', '25')],
    });
    expect(result.receivable.effectivePaid.toFixed(4)).toBe('100.0000');
    expect(result.receivable.adjustedDue.toFixed(4)).toBe('75.0000');
    expect(result.receivable.unpaid.toFixed(4)).toBe('0.0000');
    expect(result.receivable.overpaid.toFixed(4)).toBe('0.0000');
    expect(result.receivable.pendingRefund.toFixed(4)).toBe('25.0000');
  });

  it('applies an out-of-order reversal exactly once and leaves a round trip at zero', () => {
    const result = deriveSettlementAmounts({
      initialReceivable: '100.0000',
      initialPayable: '0.0000',
      events: [
        event('payment-reversal', 'REVERSAL', '40.0000', 'RECEIVABLE', { reversalOfId: 'payment' }),
        event('payment', 'PAYMENT', '40.0000'),
      ],
    });
    expect(result.receivable.grossPaid.toFixed(4)).toBe('0.0000');
    expect(result.receivable.effectivePaid.toFixed(4)).toBe('0.0000');
    expect(result.receivable.unpaid.toFixed(4)).toBe('100.0000');
  });

  it('is independent of event order when active events are the same', () => {
    const input = {
      initialReceivable: new Prisma.Decimal('90.0000'),
      initialPayable: new Prisma.Decimal('45.0000'),
      events: [
        event('p2', 'PAYMENT', '20.1250'),
        event('c1', 'CREDIT', '5.1250'),
        event('p1', 'PAYMENT', '10.2500'),
      ],
    } as const;
    const shuffled = deriveSettlementAmounts({ ...input, events: [...input.events].reverse() });
    const ordered = deriveSettlementAmounts(input);
    expect(shuffled.receivable.effectivePaid.equals(ordered.receivable.effectivePaid)).toBe(true);
    expect(shuffled.receivable.adjustedDue.equals(ordered.receivable.adjustedDue)).toBe(true);
    expect(shuffled.receivable.unpaid.equals(ordered.receivable.unpaid)).toBe(true);
  });

  it('rejects duplicate ids, unknown or duplicate reversal targets, and reversal of a reversal', () => {
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 1, initialPayable: 0, events: [
      event('same', 'PAYMENT', 1), event('same', 'CREDIT', 1),
    ] }))).toBe('DUPLICATE_EVENT_ID');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 1, initialPayable: 0, events: [
      event('r', 'REVERSAL', 1, 'RECEIVABLE', { reversalOfId: 'missing' }),
    ] }))).toBe('UNKNOWN_REVERSAL_TARGET');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 2, initialPayable: 0, events: [
      event('p', 'PAYMENT', 1),
      event('r1', 'REVERSAL', 1, 'RECEIVABLE', { reversalOfId: 'p' }),
      event('r2', 'REVERSAL', 1, 'RECEIVABLE', { reversalOfId: 'p' }),
    ] }))).toBe('DUPLICATE_REVERSAL');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 2, initialPayable: 0, events: [
      event('r1', 'REVERSAL', 1, 'RECEIVABLE', { reversalOfId: 'r2' }),
      event('r2', 'REVERSAL', 1, 'RECEIVABLE', { reversalOfId: 'p' }),
      event('p', 'PAYMENT', 1),
    ] }))).toBe('REVERSAL_TARGET_INVALID');
  });

  it('rejects a reversal with a different amount, side, or currency', () => {
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 2, initialPayable: 0, events: [
      event('p', 'PAYMENT', 1), event('r', 'REVERSAL', 0.5, 'RECEIVABLE', { reversalOfId: 'p' }),
    ] }))).toBe('REVERSAL_AMOUNT_MISMATCH');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 2, initialPayable: 2, events: [
      event('p', 'PAYMENT', 1, 'RECEIVABLE'), event('r', 'REVERSAL', 1, 'PAYABLE', { reversalOfId: 'p' }),
    ] }))).toBe('REVERSAL_TARGET_INVALID');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 2, initialPayable: 0, events: [
      event('p', 'PAYMENT', 1), event('r', 'REVERSAL', 1, 'RECEIVABLE', { reversalOfId: 'p', currency: 'EUR' }),
    ] }))).toBe('UNSUPPORTED_CURRENCY');
  });

  it('rejects negative, zero event, invalid-scale, and non-finite amounts', () => {
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: -1, initialPayable: 0, events: [] }))).toBe('NEGATIVE_AMOUNT');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 1, initialPayable: 0, events: [event('zero', 'PAYMENT', 0)] }))).toBe('ZERO_EVENT_AMOUNT');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: '1.00001', initialPayable: 0, events: [] }))).toBe('DECIMAL_SCALE_EXCEEDED');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: Number.NaN, initialPayable: 0, events: [] }))).toBe('INVALID_AMOUNT');
  });

  it('rejects Decimal(18,4) overflow on inputs and accumulated payments', () => {
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: '100000000000000.0000', initialPayable: 0, events: [] }))).toBe('DECIMAL_OVERFLOW');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 0, initialPayable: 0, events: [
      event('p1', 'PAYMENT', '99999999999999.9999'), event('p2', 'PAYMENT', '0.0001'),
    ] }))).toBe('DECIMAL_OVERFLOW');
  });

  it('rejects cross-currency facts and unknown event shape', () => {
    expect(codeOf(() => deriveSettlementAmounts({ currency: null as never, initialReceivable: 1, initialPayable: 0, events: [] }))).toBe('UNSUPPORTED_CURRENCY');
    expect(codeOf(() => deriveSettlementAmounts({ currency: '', initialReceivable: 1, initialPayable: 0, events: [] }))).toBe('UNSUPPORTED_CURRENCY');
    expect(codeOf(() => deriveSettlementAmounts({ currency: 'EUR', initialReceivable: 1, initialPayable: 0, events: [] }))).toBe('UNSUPPORTED_CURRENCY');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 1, initialPayable: 0, events: [event('eur', 'PAYMENT', 1, 'RECEIVABLE', { currency: 'EUR' })] }))).toBe('UNSUPPORTED_CURRENCY');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 1, initialPayable: 0, events: [
      { id: 'bad', kind: 'PAYMENT', amount: 1, side: 'OTHER' } as unknown as SettlementEvent,
    ] }))).toBe('INVALID_EVENT');
  });

  it('rejects cumulative credit above the initial amount and refunds above effective payments', () => {
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 10, initialPayable: 0, events: [
      event('c1', 'CREDIT', 6), event('c2', 'CREDIT', 5),
    ] }))).toBe('CREDIT_EXCEEDS_INITIAL');
    expect(codeOf(() => deriveSettlementAmounts({ initialReceivable: 10, initialPayable: 0, events: [
      event('p', 'PAYMENT', 2), event('refund', 'REFUND', 3),
    ] }))).toBe('REFUND_EXCEEDS_PAYMENT');
    const reversedRefund = deriveSettlementAmounts({ initialReceivable: 10, initialPayable: 0, events: [
      event('p', 'PAYMENT', 2), event('refund', 'REFUND', 3),
      event('refund-reversal', 'REVERSAL', 3, 'RECEIVABLE', { reversalOfId: 'refund' }),
    ] });
    expect(reversedRefund.receivable.effectivePaid.toFixed(4)).toBe('2.0000');
  });
});
