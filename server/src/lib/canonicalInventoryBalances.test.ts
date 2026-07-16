import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('canonical inventory balance aggregation', () => {
  let prismaMock: {
    inventory: { findMany: ReturnType<typeof vi.fn> };
    inventoryDetail: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      inventory: { findMany: vi.fn() },
      inventoryDetail: { findMany: vi.fn() },
    };
    vi.doMock('./prisma.js', () => ({ default: prismaMock }));
  });

  it('sums only AVAILABLE canonical details and preserves zero balances for requested parts', async () => {
    prismaMock.inventoryDetail.findMany.mockResolvedValue([
      { quantity: 2, unitCost: 100, inventoryItem: { partNumber: 'PN-AVAILABLE' } },
      { quantity: 3, unitCost: 50, inventoryItem: { partNumber: 'PN-AVAILABLE' } },
    ]);

    const { loadAvailableInventoryBalances } = await import('./canonicalInventoryBalances.js');
    const balances = await loadAvailableInventoryBalances([
      ' PN-AVAILABLE ',
      'PN-ZERO',
      'PN-AVAILABLE',
      ' ',
    ]);

    expect(Object.fromEntries(balances)).toEqual({
      'PN-AVAILABLE': { quantity: 5, value: 350, detailCount: 2 },
      'PN-ZERO': { quantity: 0, value: 0, detailCount: 0 },
    });
    expect(prismaMock.inventoryDetail.findMany).toHaveBeenCalledWith({
      where: {
        status: 'AVAILABLE',
        inventoryItem: { partNumber: { in: ['PN-AVAILABLE', 'PN-ZERO'] } },
      },
      select: {
        quantity: true,
        unitCost: true,
        inventoryItem: { select: { partNumber: true } },
      },
    });
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
  });
});
