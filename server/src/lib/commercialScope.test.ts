import { describe, expect, it } from 'vitest';
import { assertSupportedSaleType } from './commercialScope.js';

describe('confirmed first-release commercial scope', () => {
  it('accepts normal sales and the legacy default', () => {
    expect(assertSupportedSaleType('Sale')).toBe('Sale');
    expect(assertSupportedSaleType(undefined)).toBe('Sale');
  });
  it.each(['Exchange', 'Loan', 'Consign', 'Repair', 'USD', 'exchange'])('rejects unsupported sale type %s', (saleType) => {
    expect(() => assertSupportedSaleType(saleType)).toThrow('首期仅支持');
  });
});
