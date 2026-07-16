import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

function createCanonicalDetail() {
  return {
    id: 'detail-public-1',
    inventoryItemId: 'item-public-1',
    quantity: 3,
    conditionCode: 'OH',
    status: 'AVAILABLE',
    location: 'PUBLIC-A1',
    unitCost: 900,
    type: 'OWN',
    createdAt: new Date('2026-07-16T00:00:00.000Z'),
    updatedAt: new Date('2026-07-16T00:00:00.000Z'),
    inventoryItem: {
      id: 'item-public-1',
      partNumber: 'PUBLIC-100',
      description: 'Public inventory projection',
      partCategory: 'ROTABLE',
      trackingType: 'BATCH',
      unitOfMeasure: 'EA',
    },
    supplier: null,
  };
}

describe('v1 inventory compatibility API', () => {
  let prismaMock: {
    inventory: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    inventoryDetail: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      inventory: { findMany: vi.fn(), findUnique: vi.fn() },
      inventoryDetail: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../middleware/apiKeyAuth.js', () => ({
      apiKeyAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
  });

  async function buildApp() {
    const router = (await import('./apiV1.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use('/api/v1', router);
    app.use(errorHandler);
    return app;
  }

  it('projects canonical details for list and detail reads without querying legacy Inventory', async () => {
    const detail = createCanonicalDetail();
    prismaMock.inventoryDetail.findMany.mockResolvedValue([detail]);
    prismaMock.inventoryDetail.findUnique.mockResolvedValue(detail);
    prismaMock.inventoryDetail.count.mockResolvedValue(1);

    const app = await buildApp();
    const listResponse = await request(app)
      .get('/api/v1/inventory')
      .query({ partNumber: 'public', conditionCode: 'oh', page: '2', limit: '5' });

    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toMatchObject({
      success: true,
      data: [{
        id: detail.id,
        inventoryItemId: detail.inventoryItemId,
        partNumber: detail.inventoryItem.partNumber,
        conditionCode: 'OH',
      }],
      pagination: { page: 2, pageSize: 5, total: 1, totalPages: 1 },
    });
    expect(prismaMock.inventoryDetail.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        inventoryItem: { partNumber: { contains: 'public', mode: 'insensitive' } },
        conditionCode: 'OH',
      },
      skip: 5,
      take: 5,
    }));

    const detailResponse = await request(app).get(`/api/v1/inventory/${detail.id}`);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.data).toMatchObject({
      id: detail.id,
      inventoryItemId: detail.inventoryItemId,
      partNumber: detail.inventoryItem.partNumber,
    });
    expect(prismaMock.inventoryDetail.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: detail.id },
    }));
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
    expect(prismaMock.inventory.findUnique).not.toHaveBeenCalled();
  });
});
