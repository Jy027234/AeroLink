import { describe, expect, it } from 'vitest';
import {
  createSettlementAccountSchema,
  settlementRecordSchema,
} from './settlementInputs.js';

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 60_000).toISOString();
const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const accountBase = {
  side: 'RECEIVABLE' as const,
  orderId: 'order-1',
  dueDate,
  occurredAt: past,
  externalSystem: 'ERP',
  voucherNumber: 'AR-001',
  voucherLine: '1',
  reason: 'Customer account opened from approved order',
  evidenceIds: ['evidence-1'],
};

const recordBase = {
  version: 1,
  kind: 'PAYMENT' as const,
  amount: '100.0000',
  occurredAt: past,
  externalSystem: 'ERP',
  voucherNumber: 'PAY-001',
  voucherLine: '1',
  reason: 'Payment received against the approved order',
  evidenceIds: ['evidence-1'],
};

function expectInvalid(result: { success: boolean }) {
  expect(result.success).toBe(false);
}

describe('settlement input schemas', () => {
  it('accepts USD account metadata while deriving base amount outside the request', () => {
    expect(createSettlementAccountSchema.safeParse(accountBase).success).toBe(true);
    expect(createSettlementAccountSchema.safeParse({
      ...accountBase,
      side: 'PAYABLE',
      purchaseCommitmentId: 'purchase-1',
    }).success).toBe(true);
    expect(createSettlementAccountSchema.safeParse({
      ...accountBase,
      baseAmount: '100.0000',
    })).toMatchObject({ success: false });
  });

  it('requires the purchase commitment only for payable accounts', () => {
    expectInvalid(createSettlementAccountSchema.safeParse({ ...accountBase, side: 'PAYABLE' }));
    expectInvalid(createSettlementAccountSchema.safeParse({ ...accountBase, purchaseCommitmentId: 'purchase-1' }));
  });

  it('allows due dates in either direction but rejects a future occurredAt', () => {
    expect(createSettlementAccountSchema.safeParse({ ...accountBase, dueDate: past }).success).toBe(true);
    expectInvalid(createSettlementAccountSchema.safeParse({ ...accountBase, occurredAt: future }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, occurredAt: future }));
  });

  it('accepts only positive plain decimal strings within Decimal(18,4)', () => {
    for (const amount of ['0.0001', '1', '1.2', '99999999999999.9999']) {
      expect(settlementRecordSchema.safeParse({ ...recordBase, amount }).success).toBe(true);
    }
    for (const amount of [0, 1, '0', '0.0000', '-1.0000', '1.00001', '1e3', '1E+3', '100000000000000.0000', '1.']) {
      expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, amount }));
    }
  });

  it('rejects unknown currency, amount, and technical fields at the strict boundary', () => {
    expectInvalid(createSettlementAccountSchema.safeParse({ ...accountBase, currency: 'USD' }));
    expectInvalid(createSettlementAccountSchema.safeParse({ ...accountBase, amount: '100.0000' }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, currency: 'USD' }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, sourceSnapshot: '{}' }));
  });

  it('enforces the record kind matrix', () => {
    expect(settlementRecordSchema.safeParse({ ...recordBase, kind: 'PAYMENT' }).success).toBe(true);
    expect(settlementRecordSchema.safeParse({ ...recordBase, kind: 'CREDIT' }).success).toBe(true);
    expect(settlementRecordSchema.safeParse({ ...recordBase, kind: 'REFUND' }).success).toBe(true);
    expect(settlementRecordSchema.safeParse({ ...recordBase, kind: 'REVERSAL', amount: undefined, reversalOfId: 'payment-1' }).success).toBe(true);
    expect(settlementRecordSchema.safeParse({ ...recordBase, kind: 'TERMS', amount: undefined, dueDate }).success).toBe(true);

    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, kind: 'REVERSAL' }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, kind: 'REVERSAL', reversalOfId: 'payment-1', amount: '1.0000' }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, kind: 'TERMS', amount: undefined }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, kind: 'TERMS', amount: '1.0000', dueDate }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, kind: 'PAYMENT', dueDate }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, kind: 'PAYMENT', reversalOfId: 'other' }));
  });

  it('requires strict evidence and bounded audit metadata', () => {
    expectInvalid(createSettlementAccountSchema.safeParse({ ...accountBase, evidenceIds: [] }));
    expectInvalid(createSettlementAccountSchema.safeParse({ ...accountBase, evidenceIds: ['same', 'same'] }));
    expectInvalid(createSettlementAccountSchema.safeParse({ ...accountBase, evidenceIds: [''] }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, reason: 'no' }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, externalSystem: '' }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, voucherNumber: 'x'.repeat(201) }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, version: 0 }));
    expectInvalid(settlementRecordSchema.safeParse({ ...recordBase, occurredAt: '2026-01-01T00:00:00' }));
  });
});
