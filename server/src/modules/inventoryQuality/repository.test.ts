import { describe, expect, it } from 'vitest';
import { inventoryRepository, inventoryTransactionRepository } from './index.js';

describe('inventoryQuality repository boundary', () => {
  it('exposes the InventoryDetail delegate through the public module entry', () => {
    expect(typeof inventoryRepository.findMany).toBe('function');
    expect(typeof inventoryRepository.findUnique).toBe('function');
    expect(typeof inventoryTransactionRepository.findMany).toBe('function');
  });
});
