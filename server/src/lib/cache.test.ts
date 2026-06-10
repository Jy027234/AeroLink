import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cache, CACHE_TTL, CACHE_KEY } from './cache';

describe('Cache Layer', () => {
  beforeEach(() => {
    cache.flush();
  });

  it('should set and get a value', () => {
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('should return undefined for missing key', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('should expire after TTL', async () => {
    cache.set('key2', 'value2', 0.05); // 50ms
    expect(cache.get('key2')).toBe('value2');
    await new Promise((r) => setTimeout(r, 100));
    expect(cache.get('key2')).toBeUndefined();
  });

  it('should delete a key', () => {
    cache.set('key3', 'value3');
    cache.del('key3');
    expect(cache.get('key3')).toBeUndefined();
  });

  it('should delete by prefix', () => {
    cache.set('users:1', { name: 'A' });
    cache.set('users:2', { name: 'B' });
    cache.set('orders:1', { total: 100 });

    const deleted = cache.delByPrefix('users:');
    expect(deleted).toBe(2);
    expect(cache.get('users:1')).toBeUndefined();
    expect(cache.get('users:2')).toBeUndefined();
    expect(cache.get('orders:1')).toEqual({ total: 100 });
  });

  it('should use getOrSet with factory', async () => {
    const factory = vi.fn().mockResolvedValue('computed');
    const result = await cache.getOrSet('computed-key', factory, 60);
    expect(result).toBe('computed');
    expect(factory).toHaveBeenCalledOnce();

    // Second call should use cache
    const result2 = await cache.getOrSet('computed-key', factory, 60);
    expect(result2).toBe('computed');
    expect(factory).toHaveBeenCalledOnce(); // still once
  });

  it('should return stats', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    const stats = cache.stats();
    expect(stats.size).toBe(2);
    expect(stats.keys).toContain('a');
    expect(stats.keys).toContain('b');
  });

  it('should flush all entries', () => {
    cache.set('x', 1);
    cache.set('y', 2);
    cache.flush();
    expect(cache.stats().size).toBe(0);
  });

  describe('CACHE_KEY helpers', () => {
    it('should generate detail keys', () => {
      expect(CACHE_KEY.SUPPLIER_DETAIL('abc-123')).toBe('suppliers:abc-123');
      expect(CACHE_KEY.INVENTORY_DETAIL('inv-1')).toBe('inventory:inv-1');
    });
  });

  describe('CACHE_TTL constants', () => {
    it('should have reasonable TTL values', () => {
      expect(CACHE_TTL.DASHBOARD_STATS).toBe(30);
      expect(CACHE_TTL.DASHBOARD_FUNNEL).toBe(60);
      expect(CACHE_TTL.SUPPLIER_LIST).toBe(300);
      expect(CACHE_TTL.SUPPLIER_LIST).toBeGreaterThan(CACHE_TTL.DASHBOARD_STATS);
    });
  });
});
