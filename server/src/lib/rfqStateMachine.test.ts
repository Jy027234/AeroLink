import { describe, expect, it } from 'vitest';
import {
  isRfqStatusTransitionAllowed,
  normalizeRfqStatus,
  toUiRfqStatus,
} from './rfqStateMachine.js';

describe('RFQ state machine', () => {
  it('normalizes legacy UI aliases to canonical persisted statuses', () => {
    expect(normalizeRfqStatus('approved')).toBe('APPROVING');
    expect(normalizeRfqStatus('sent')).toBe('ORDERED');
    expect(normalizeRfqStatus('won')).toBe('COMPLETED');
    expect(normalizeRfqStatus('unknown')).toBeNull();
    expect(toUiRfqStatus('ORDERED')).toBe('sent');
  });

  it('allows only defined forward transitions and idempotent retries', () => {
    expect(isRfqStatusTransitionAllowed('PENDING', 'SOURCING')).toBe(true);
    expect(isRfqStatusTransitionAllowed('QUOTING', 'ORDERED')).toBe(true);
    expect(isRfqStatusTransitionAllowed('ORDERED', 'COMPLETED')).toBe(true);
    expect(isRfqStatusTransitionAllowed('SOURCING', 'COMPLETED')).toBe(false);
    expect(isRfqStatusTransitionAllowed('COMPLETED', 'PENDING')).toBe(false);
    expect(isRfqStatusTransitionAllowed('QUOTING', 'QUOTING')).toBe(true);
  });
});
