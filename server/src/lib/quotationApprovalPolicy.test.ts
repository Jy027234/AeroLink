import { describe, expect, it } from 'vitest';
import {
  assertQuotationApprovalActor,
  buildQuotationApprovalSnapshot,
  hashQuotationApprovalSnapshot,
  hasCurrentQuotationApproval,
  requiredQuotationApprovalLevel,
} from './quotationApprovalPolicy.js';

const baseQuotation = {
  id: 'q-1',
  quoteNumber: 'QT-1',
  rfqId: 'rfq-1',
  customerId: 'customer-1',
  partNumber: 'PN-1',
  quantity: 2,
  unitPrice: 2_100,
  totalPrice: 4_200,
  costPrice: 1_800,
  margin: 14.2857,
  currency: 'USD',
  template: 'STANDARD',
  saleType: 'Sale',
  taxIncluded: true,
  warrantyDays: 90,
  expiryDate: new Date('2027-05-26T00:00:00.000Z'),
  validityDeadline: new Date('2027-05-26T00:00:00.000Z'),
  rfq: { urgency: 'AOG' },
};

function approvedQuotation() {
  const snapshot = buildQuotationApprovalSnapshot(baseQuotation);
  return {
    ...baseQuotation,
    version: 99,
    approvals: [{
      action: 'APPROVE',
      level: 'MANAGER',
      requiredLevel: 'MANAGER',
      policyVersion: '2026-09-08-usd-tier-v1',
      reviewedVersion: 1,
      snapshotJson: JSON.stringify(snapshot),
      createdAt: new Date('2027-05-12T09:00:00.000Z'),
    }],
  };
}

describe('quotation approval policy', () => {
  it('uses the agreed USD amount boundaries and never grants AOG an amount bypass', () => {
    expect(requiredQuotationApprovalLevel(5_000)).toBe('MANAGER');
    expect(requiredQuotationApprovalLevel(5_000.01)).toBe('FINANCE');
    expect(requiredQuotationApprovalLevel(50_000)).toBe('FINANCE');
    expect(requiredQuotationApprovalLevel(50_000.01)).toBe('GM');

    expect(() => assertQuotationApprovalActor({
      actorId: 'manager-1',
      actorRole: 'manager',
      creatorId: 'seller-1',
      totalPrice: 5_000.01,
      currency: 'USD',
    })).toThrow(/无权审批/);
  });

  it('allows higher authorized roles to approve lower tiers while finance stays narrow', () => {
    expect(() => assertQuotationApprovalActor({
      actorId: 'finance-1', actorRole: 'finance', creatorId: 'seller-1', totalPrice: 5_000, currency: 'USD',
    })).not.toThrow();
    expect(() => assertQuotationApprovalActor({
      actorId: 'finance-1', actorRole: 'finance', creatorId: 'seller-1', totalPrice: 50_000, currency: 'USD',
    })).not.toThrow();
    expect(() => assertQuotationApprovalActor({
      actorId: 'finance-1', actorRole: 'finance', creatorId: 'seller-1', totalPrice: 50_000.01, currency: 'USD',
    })).toThrow(/无权审批/);
    expect(() => assertQuotationApprovalActor({
      actorId: 'gm-1', actorRole: 'gm', creatorId: 'seller-1', totalPrice: 50_000.01, currency: 'USD',
    })).not.toThrow();
    expect(() => assertQuotationApprovalActor({
      actorId: 'admin-1', actorRole: 'admin', creatorId: 'seller-1', totalPrice: 100, currency: 'USD',
    })).toThrow(/无权审批/);
    expect(() => assertQuotationApprovalActor({
      actorId: 'seller-1', actorRole: 'gm', creatorId: 'seller-1', totalPrice: 100, currency: 'USD',
    })).toThrow(/不能审批自己的报价/);
  });

  it('rejects non-USD input and keeps a mutable concurrency version out of snapshot validity', () => {
    expect(() => assertQuotationApprovalActor({
      actorId: 'manager-1', actorRole: 'manager', creatorId: 'seller-1', totalPrice: 100, currency: 'EUR',
    })).toThrow(/USD/);

    const quotation = approvedQuotation();
    expect(hasCurrentQuotationApproval(quotation)).toBe(true);
    const changedVersion = { ...quotation, version: quotation.version + 1 };
    expect(hasCurrentQuotationApproval(changedVersion)).toBe(true);
    expect(hashQuotationApprovalSnapshot(buildQuotationApprovalSnapshot(quotation)))
      .toBe(hashQuotationApprovalSnapshot(buildQuotationApprovalSnapshot(changedVersion)));

    const changedAmount = { ...quotation, totalPrice: 4_300 };
    expect(hasCurrentQuotationApproval(changedAmount)).toBe(false);
  });
});
