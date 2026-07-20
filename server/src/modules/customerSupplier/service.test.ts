import { describe, expect, it } from 'vitest';
import { assertSupplierEmailAvailable, normalizeCustomerStatus, normalizeSupplierEmail, normalizeSupplierLevel } from './index.js';

describe('customerSupplier service policy', () => {
  it('normalizes supplier and customer status inputs', () => {
    expect(normalizeSupplierEmail('  buyer@example.test ')).toBe('buyer@example.test');
    expect(normalizeSupplierLevel('a')).toBe('A');
    expect(normalizeCustomerStatus('at-risk')).toBe('AT_RISK');
  });

  it('rejects duplicate supplier email while allowing the current record', () => {
    expect(() => assertSupplierEmailAvailable({ id: 'supplier-2' }, 'supplier-1')).toThrowError(/其他供应商/);
    expect(() => assertSupplierEmailAvailable({ id: 'supplier-1' }, 'supplier-1')).not.toThrow();
  });
});
