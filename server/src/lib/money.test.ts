import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  calculateMarginPercent,
  calculateMoneyTotal,
  moneyValuesMatch,
  normalizeMoney,
  preferredMoneyValue,
} from './money.js';

describe('money precision helpers', () => {
  it('rounds persisted amounts half-up to four decimal places', () => {
    expect(normalizeMoney('10.12345').toString()).toBe('10.1235');
    expect(normalizeMoney('10.12344').toString()).toBe('10.1234');
  });

  it('calculates totals without binary floating point drift', () => {
    expect(calculateMoneyTotal('0.1', 3).toString()).toBe('0.3');
    expect(calculateMoneyTotal('12.3456', 7).toString()).toBe('86.4192');
  });

  it('uses the Decimal shadow before the legacy Float compatibility value', () => {
    expect(preferredMoneyValue(new Prisma.Decimal('99.1000'), 99.09)).toBe(99.1);
    expect(preferredMoneyValue(null, 99.09)).toBe(99.09);
  });

  it('compares a Float and Decimal after applying the persisted scale', () => {
    expect(moneyValuesMatch('0.3000', 0.1 + 0.2)).toBe(true);
    expect(moneyValuesMatch('0.3001', 0.3)).toBe(false);
  });

  it('calculates margin from precise amount values', () => {
    expect(calculateMarginPercent('10.0000', '6.6667', 1)).toBe(33.333);
  });
});
