import { describe, expect, it } from 'vitest';
import type { Quotation } from '@/types';
import { buildQuotationRevisionInput, remainingRevisionQuantity, validateRevisionIdentity } from './revisionModel';

const source = { id: 'q-1', rfqId: 'rfq-1', customerId: 'customer-1', lineItemsMode: true, version: 7 } as Quotation;

describe('quotation revision model', () => {
  it('keeps the source RFQ, customer, and explicit line mode as immutable identity', () => {
    expect(validateRevisionIdentity(source, { rfqId: 'rfq-1', customerId: 'customer-1', lineItemsMode: true })).toBeNull();
    expect(validateRevisionIdentity(source, { rfqId: 'rfq-2', customerId: 'customer-1', lineItemsMode: true })).toBe('rfq');
    expect(validateRevisionIdentity(source, { rfqId: 'rfq-1', customerId: 'customer-2', lineItemsMode: true })).toBe('customer');
    expect(validateRevisionIdentity(source, { rfqId: 'rfq-1', customerId: 'customer-1', lineItemsMode: false })).toBe('mode');
  });

  it('trims and requires the revision reason while preserving the CAS version', () => {
    const payload = buildQuotationRevisionInput(source, '  customer changed delivery date  ', {
      rfqId: 'rfq-1',
      customerId: 'customer-1',
      lines: [],
      currency: 'USD',
      validityDays: 30,
    });
    expect(payload).toMatchObject({ version: 7, reason: 'customer changed delivery date' });
    expect(() => buildQuotationRevisionInput(source, '  ', payload.quotation)).toThrow('Revision reason is required');
  });

  it('only carries the unaccepted quantity into a new multi-line revision', () => {
    expect(remainingRevisionQuantity({ quantity: 10, acceptedQuantity: 3 })).toBe(7);
    expect(remainingRevisionQuantity({ quantity: 10, acceptedQuantity: 12 })).toBe(0);
  });
});
