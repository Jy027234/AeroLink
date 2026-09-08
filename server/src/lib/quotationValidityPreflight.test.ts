import { describe, expect, it } from 'vitest';
import { checkQuotationValidity, type QuotationValidityRecord } from './quotationValidityPreflight.js';

const record: QuotationValidityRecord = {
  id: 'q1', quoteNumber: 'Q1', version: 2, status: 'APPROVED',
  expiryDate: '2026-09-10T00:00:00Z', validityDeadline: '2026-09-10T00:00:00Z',
  createdAt: '2026-09-01T00:00:00Z',
};
const now = new Date('2026-09-08T00:00:00Z');

describe('quotation validity preflight', () => {
  it('compares instants across timezone representations and treats equality as expired', () => {
    expect(checkQuotationValidity([{ ...record, validityDeadline: '2026-09-10T08:00:00+08:00' }], now)).toMatchObject({ status: 'READY', expired: 0 });
    expect(checkQuotationValidity([record], new Date(record.expiryDate!))).toMatchObject({ status: 'READY', expired: 1 });
  });

  it('reports a possible old creation-time default without treating it as proof or changing dates', () => {
    const input = { ...record, validityDeadline: record.createdAt };
    const before = JSON.stringify(input);
    expect(checkQuotationValidity([input], now)).toMatchObject({
      status: 'REVIEW', expired: 0,
      issues: [{ id: 'q1', version: 2, code: 'DEADLINE_CONFLICT', possibleCreationDefault: true }],
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('blocks missing or invalid canonical dates instead of borrowing a future legacy date', () => {
    expect(checkQuotationValidity([{ ...record, expiryDate: null }], now)).toMatchObject({ status: 'BLOCKED', issues: [{ code: 'INVALID_EXPIRY' }] });
    expect(checkQuotationValidity([{ ...record, validityDeadline: 'invalid' }], now)).toMatchObject({ status: 'BLOCKED', issues: [{ code: 'INVALID_DEADLINE' }] });
  });
});
