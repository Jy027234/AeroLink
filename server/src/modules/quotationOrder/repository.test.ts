import { describe, expect, it } from 'vitest';
import { orderRepository, quotationRepository } from './index.js';

describe('quotationOrder repository boundary', () => {
  it('exposes quotation and order delegates through the public module entry', () => {
    expect(typeof quotationRepository.findMany).toBe('function');
    expect(typeof quotationRepository.findUnique).toBe('function');
    expect(typeof orderRepository.findMany).toBe('function');
    expect(typeof orderRepository.findUnique).toBe('function');
  });
});
