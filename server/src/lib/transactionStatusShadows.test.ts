import { describe, expect, it } from 'vitest';
import {
  preferredOrderStatus,
  preferredQuotationStatus,
  reconcileTransactionStatusShadows,
  toOrderStatusEnum,
  toQuotationStatusEnum,
  toRfqStatusEnum,
  toSupplierQuoteStatusEnum,
} from './transactionStatusShadows.js';

describe('transaction status enum shadows', () => {
  it('normalizes legacy aliases into stable enum values', () => {
    expect(toRfqStatusEnum('approved')).toBe('APPROVING');
    expect(toQuotationStatusEnum('pending approval')).toBe('PENDING_APPROVAL');
    expect(toOrderStatusEnum('in-transit')).toBe('IN_TRANSIT');
    expect(toOrderStatusEnum('in transit')).toBe('IN_TRANSIT');
    expect(toSupplierQuoteStatusEnum('PENDING')).toBe('pending');
  });

  it('prefers enum shadows while retaining normalized legacy fallback', () => {
    expect(preferredQuotationStatus('APPROVED', 'DRAFT')).toBe('APPROVED');
    expect(preferredOrderStatus(null, 'in-transit')).toBe('IN_TRANSIT');
  });

  it('accepts matching canonical and legacy aliases during reconciliation', () => {
    const result = reconcileTransactionStatusShadows([
      { entity: 'rfq', id: 'rfq-1', legacyStatus: 'approved', enumStatus: 'APPROVING' },
      { entity: 'quotation', id: 'quote-1', legacyStatus: 'pending approval', enumStatus: 'PENDING_APPROVAL' },
      { entity: 'order', id: 'order-1', legacyStatus: 'in transit', enumStatus: 'IN_TRANSIT' },
      { entity: 'supplierQuote', id: 'supplier-quote-1', legacyStatus: 'PENDING', enumStatus: 'pending' },
    ]);

    expect(result).toMatchObject({
      status: 'PASS',
      checkedRecords: 4,
      missingShadowStatuses: 0,
      invalidLegacyStatuses: 0,
      mismatchedStatuses: 0,
      issues: [],
    });
  });

  it('reports missing, invalid, and divergent shadow values', () => {
    const result = reconcileTransactionStatusShadows([
      { entity: 'rfq', id: 'rfq-1', legacyStatus: 'PENDING', enumStatus: null },
      { entity: 'quotation', id: 'quote-1', legacyStatus: 'unknown', enumStatus: 'DRAFT' },
      { entity: 'order', id: 'order-1', legacyStatus: 'SHIPPED', enumStatus: 'DELIVERED' },
    ]);

    expect(result).toMatchObject({
      status: 'FAIL',
      missingShadowStatuses: 1,
      invalidLegacyStatuses: 1,
      mismatchedStatuses: 1,
    });
    expect(result.issues.map((issue) => issue.reason)).toEqual([
      'MISSING_SHADOW',
      'INVALID_LEGACY_STATUS',
      'MISMATCH',
    ]);
  });
});
