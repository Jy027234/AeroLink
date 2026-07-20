import { describe, expect, it } from 'vitest';
import { customerRepository, supplierRepository } from './index.js';

describe('customerSupplier repository boundary', () => {
  it('exposes only the aggregate delegates through the public module entry', () => {
    expect(typeof customerRepository.findMany).toBe('function');
    expect(typeof customerRepository.create).toBe('function');
    expect(typeof supplierRepository.findMany).toBe('function');
    expect(typeof supplierRepository.update).toBe('function');
  });
});
