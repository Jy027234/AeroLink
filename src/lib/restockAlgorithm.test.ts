import { calculateRestock, calculateRestockBatch } from './restockAlgorithm';

describe('VMI Restock Algorithm', () => {
  const baseParams = {
    currentStock: 10,
    leadTimeDays: 7,
    minStock: 5,
    maxStock: 50,
    minOrderQty: 5,
    serviceLevel: 0.95,
  };

  it('should suggest restock when stock below reorder point', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      quantity: 2,
    }));

    const result = calculateRestock(history, baseParams);
    expect(result.shouldRestock).toBe(true);
    expect(result.suggestedQty).toBeGreaterThan(0);
    expect(result.confidence).toBe('high');
  });

  it('should not suggest restock when stock is sufficient', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      quantity: 0.1,
    }));

    const result = calculateRestock(history, { ...baseParams, currentStock: 100 });
    expect(result.shouldRestock).toBe(false);
    expect(result.suggestedQty).toBe(0);
  });

  it('should return low confidence with insufficient data', () => {
    const history = [
      { date: '2026-04-01', quantity: 5 },
      { date: '2026-04-02', quantity: 3 },
    ];

    const result = calculateRestock(history, baseParams);
    expect(result.confidence).toBe('low');
    expect(result.reason).toContain('数据不足');
  });

  it('should respect min order quantity', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      quantity: 3,
    }));

    const result = calculateRestock(history, { ...baseParams, currentStock: 3 });
    expect(result.suggestedQty % 5).toBe(0); // should be multiple of 5
  });

  it('should calculate days until stockout', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      quantity: 2,
    }));

    const result = calculateRestock(history, baseParams);
    expect(result.daysUntilStockout).not.toBeNull();
    expect(result.daysUntilStockout!).toBeGreaterThan(0);
  });

  it('should handle batch calculation', () => {
    const items = [
      {
        id: '1',
        customerName: 'Airline A',
        partNumber: 'PN-001',
        currentStock: 5,
        consumptionHistory: Array.from({ length: 30 }, (_, i) => ({
          date: `2026-04-${String(i + 1).padStart(2, '0')}`,
          quantity: 2,
        })),
        params: baseParams,
      },
      {
        id: '2',
        customerName: 'Airline B',
        partNumber: 'PN-002',
        currentStock: 100,
        consumptionHistory: Array.from({ length: 30 }, (_, i) => ({
          date: `2026-04-${String(i + 1).padStart(2, '0')}`,
          quantity: 0.5,
        })),
        params: baseParams,
      },
    ];

    const results = calculateRestockBatch(items);
    expect(results).toHaveLength(2);
    expect(results[0].shouldRestock).toBe(true);
    expect(results[1].shouldRestock).toBe(false);
  });

  it('should trigger restock when below min stock', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      quantity: 0.1,
    }));

    const result = calculateRestock(history, { ...baseParams, currentStock: 3 });
    expect(result.shouldRestock).toBe(true);
    expect(result.reason).toContain('最小库存');
  });
});
