import { describe, expect, it } from 'vitest';
import { canViewInventoryCost, canViewReportCost, visibleCost } from './costVisibility.js';

describe('cost visibility', () => {
  it('requires the narrow capability for inventory and report costs', () => {
    expect(canViewInventoryCost({ id: 'sales-1', role: 'sales' })).toBe(false);
    expect(canViewReportCost({ id: 'quality-1', role: 'quality_manager' })).toBe(false);
    expect(canViewInventoryCost({ id: 'finance-1', role: 'finance' })).toBe(true);
    expect(canViewReportCost({ id: 'manager-1', role: 'manager' })).toBe(true);
  });

  it('returns null for hidden aggregate values', () => {
    expect(visibleCost(100, false)).toBeNull();
    expect(visibleCost(100, true)).toBe(100);
    expect(visibleCost(null, true)).toBeNull();
  });
});
