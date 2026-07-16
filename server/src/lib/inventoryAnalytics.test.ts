import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('canonical inventory analytics', () => {
  let prismaMock: {
    inventory: { findMany: ReturnType<typeof vi.fn> };
    inventoryItem: { findMany: ReturnType<typeof vi.fn> };
    inventoryDetail: { findMany: ReturnType<typeof vi.fn> };
    order: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      inventory: { findMany: vi.fn() },
      inventoryItem: { findMany: vi.fn() },
      inventoryDetail: { findMany: vi.fn() },
      order: { findMany: vi.fn() },
    };
    vi.doMock('./prisma.js', () => ({ default: prismaMock }));
  });

  it('aggregates only AVAILABLE canonical details per part number for safety stock', async () => {
    prismaMock.inventoryItem.findMany.mockResolvedValue([
      { partNumber: 'PN-AVAILABLE', details: [{ quantity: 2 }, { quantity: 3 }] },
      { partNumber: 'PN-RESERVED', details: [] },
    ]);
    prismaMock.order.findMany.mockResolvedValue([]);

    const { calculateSafetyStockRecommendations } = await import('./inventoryAnalytics.js');
    const recommendations = await calculateSafetyStockRecommendations();

    expect(recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ partNumber: 'PN-AVAILABLE', currentStock: 5 }),
      expect.objectContaining({ partNumber: 'PN-RESERVED', currentStock: 0 }),
    ]));
    expect(prismaMock.inventoryItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        details: expect.objectContaining({ where: { status: 'AVAILABLE' } }),
      }),
    }));
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
  });

  it('values non-scrapped canonical details without falling back to legacy Inventory', async () => {
    prismaMock.inventoryItem.findMany.mockResolvedValue([
      { partNumber: 'PN-HEALTH', details: [{ quantity: 2 }] },
    ]);
    prismaMock.order.findMany.mockResolvedValue([]);
    prismaMock.inventoryDetail.findMany.mockResolvedValue([
      { quantity: 2, unitCost: 1200 },
      { quantity: 1, unitCost: 800 },
    ]);

    const { getInventoryHealthSummary } = await import('./inventoryAnalytics.js');
    const summary = await getInventoryHealthSummary();

    expect(summary.totalItems).toBe(1);
    expect(summary.totalInventoryValue).toBe(3200);
    expect(prismaMock.inventoryDetail.findMany).toHaveBeenCalledWith({
      where: { status: { not: 'SCRAPPED' } },
      select: { quantity: true, unitCost: true },
    });
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
  });
});
