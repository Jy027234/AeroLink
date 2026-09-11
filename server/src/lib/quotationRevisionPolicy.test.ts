import { describe, it, expect } from 'vitest';
import { assertActiveQuotationRevision } from './quotationRevisionPolicy.js';
import { quotationReviseSchema } from './validation.js';

const offer = { rfqId: 'rfq', customerId: 'customer', partNumber: 'PN', quantity: 1,
  unitPrice: 100, costPrice: 50, currency: 'USD', costSourceType: 'MANUAL', costSourceReason: 'Reviewed estimate' };

describe('commercial revision boundaries', () => {
  it('requires an explicit new validity period, reason and optimistic-lock version', () => {
    expect(quotationReviseSchema.safeParse({ version: 2, reason: 'Changed delivery terms', quotation: offer }).success).toBe(false);
    const revision = { version: 2, reason: 'Changed delivery terms', quotation: { ...offer, validityDays: 7 } };
    expect(quotationReviseSchema.safeParse(revision).success).toBe(true);
    expect(quotationReviseSchema.safeParse({ ...revision, reason: '   ' }).success).toBe(false);
    expect(quotationReviseSchema.safeParse({ ...revision, version: undefined }).success).toBe(false);
    expect(quotationReviseSchema.safeParse({ ...revision, supersededAt: null }).success).toBe(false);
  });

  it('keeps historical records readable while rejecting new obligations from superseded offers', () => {
    expect(() => assertActiveQuotationRevision({ supersededAt: null })).not.toThrow();
    expect(() => assertActiveQuotationRevision({})).not.toThrow();
    expect(() => assertActiveQuotationRevision({ supersededAt: new Date() })).toThrowError(/新的商业版次/);
  });
});
