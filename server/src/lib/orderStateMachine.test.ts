import { describe, expect, it } from 'vitest';
import {
  isOrderStatusTransitionAllowed,
  normalizeOrderStatus,
  toUiOrderStatus,
} from './orderStateMachine.js';

describe('order state machine', () => {
  it('normalizes UI aliases to persisted statuses', () => {
    expect(normalizeOrderStatus('in-transit')).toBe('IN_TRANSIT');
    expect(toUiOrderStatus('PO_CREATED')).toBe('po_created');
  });

  it('allows only the defined forward transitions', () => {
    expect(isOrderStatusTransitionAllowed('SO_CREATED', 'po_created')).toBe(true);
    expect(isOrderStatusTransitionAllowed('DELIVERED', 'COMPLETED')).toBe(true);
    expect(isOrderStatusTransitionAllowed('SO_CREATED', 'COMPLETED')).toBe(false);
    expect(isOrderStatusTransitionAllowed('COMPLETED', 'DELIVERED')).toBe(false);
    expect(isOrderStatusTransitionAllowed('SHIPPED', 'SHIPPED')).toBe(true);
  });
});
