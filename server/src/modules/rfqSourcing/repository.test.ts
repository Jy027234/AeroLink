import { describe, expect, it } from 'vitest';
import { rfqRepository } from './index.js';

describe('rfqSourcing repository boundary', () => {
  it('exposes the RFQ delegate through the public module entry', () => {
    expect(typeof rfqRepository.findMany).toBe('function');
    expect(typeof rfqRepository.findUnique).toBe('function');
  });
});
