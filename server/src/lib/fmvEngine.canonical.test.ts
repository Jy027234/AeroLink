import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('FMV canonical part master reads', () => {
  let prismaMock: {
    inventory: { findMany: ReturnType<typeof vi.fn> };
    inventoryItem: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    quotation: { findMany: ReturnType<typeof vi.fn> };
    order: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      inventory: { findMany: vi.fn() },
      inventoryItem: { findUnique: vi.fn(), findMany: vi.fn() },
      quotation: { findMany: vi.fn() },
      order: { findMany: vi.fn() },
    };
    vi.doMock('./prisma.js', () => ({ default: prismaMock }));
  });

  it('derives manufacturer and ATA comparables from InventoryItem when callers omit them', async () => {
    prismaMock.inventoryItem.findUnique.mockResolvedValue({ manufacturer: 'OEM Corp', ataChapter: '29' });
    prismaMock.inventoryItem.findMany.mockResolvedValue([{ partNumber: 'FMV-PN-1' }]);
    prismaMock.quotation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ unitPrice: 1000, totalPrice: 1000, quantity: 1 }]);
    prismaMock.order.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const { calculateFMV } = await import('./fmvEngine.js');
    const result = await calculateFMV('FMV-PN-1', 'SV');

    expect(result).toMatchObject({
      partNumber: 'FMV-PN-1',
      manufacturer: 'OEM Corp',
      selectedFMV: 1000,
      selectedStage: 3,
      selectedConfidence: 7,
    });
    expect(prismaMock.inventoryItem.findUnique).toHaveBeenCalledWith({
      where: { partNumber: 'FMV-PN-1' },
      select: { manufacturer: true, ataChapter: true },
    });
    expect(prismaMock.inventoryItem.findMany).toHaveBeenCalledWith({
      where: { ataChapter: '29' },
      select: { partNumber: true },
      take: 50,
    });
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
  });
});
