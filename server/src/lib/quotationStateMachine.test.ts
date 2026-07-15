import { describe, expect, it } from 'vitest';
import {
  isQuotationTransitionAllowed,
  normalizeQuotationStatus,
} from './quotationStateMachine.js';

describe('quotation state machine', () => {
  it('normalizes UI aliases and separator variants', () => {
    expect(normalizeQuotationStatus('pending approval')).toBe('PENDING_APPROVAL');
    expect(normalizeQuotationStatus('pending-approval')).toBe('PENDING_APPROVAL');
    expect(normalizeQuotationStatus('accepted')).toBe('ACCEPTED');
    expect(normalizeQuotationStatus('unknown')).toBeNull();
  });

  it('allows only business-valid transitions', () => {
    expect(isQuotationTransitionAllowed('draft', 'pending_approval')).toBe(true);
    expect(isQuotationTransitionAllowed('rejected', 'pending_approval')).toBe(true);
    expect(isQuotationTransitionAllowed('approved', 'sent')).toBe(true);
    expect(isQuotationTransitionAllowed('sent', 'withdrawn')).toBe(true);
    expect(isQuotationTransitionAllowed('sent', 'sent')).toBe(true);
    expect(isQuotationTransitionAllowed('draft', 'sent')).toBe(false);
    expect(isQuotationTransitionAllowed('withdrawn', 'accepted')).toBe(false);
  });
});
