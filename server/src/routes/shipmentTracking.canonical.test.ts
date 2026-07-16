import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('shipment tracking canonical inventory reads', () => {
  let prismaMock: {
    inventory: { findFirst: ReturnType<typeof vi.fn> };
    inventoryItem: { findMany: ReturnType<typeof vi.fn> };
    shipmentTracking: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      inventory: { findFirst: vi.fn() },
      inventoryItem: { findMany: vi.fn() },
      shipmentTracking: { findMany: vi.fn() },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp() {
    const router = (await import('./shipmentTracking.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use('/api/shipment-tracking', router);
    app.use(errorHandler);
    return app;
  }

  it('loads customs HS codes in one canonical part-master query', async () => {
    prismaMock.shipmentTracking.findMany.mockResolvedValue([
      {
        status: 'CUSTOMS_HOLD',
        order: { partNumber: 'SHIP-PN-1', certificateType: '8130-3' },
      },
      {
        status: 'IN_TRANSIT',
        order: { partNumber: 'SHIP-PN-1', certificateType: 'NONE' },
      },
    ]);
    prismaMock.inventoryItem.findMany.mockResolvedValue([
      { partNumber: 'SHIP-PN-1', hsCode: '8803.30.0010' },
    ]);

    const app = await buildApp();
    const response = await request(app).get('/api/shipment-tracking/customs-risks');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({ partNumber: 'SHIP-PN-1', hsCode: '8803.30.0010', riskLevel: 'high', inspectionRate: 28 }),
        expect.objectContaining({ partNumber: 'SHIP-PN-1', hsCode: '8803.30.0010', riskLevel: 'medium', inspectionRate: 14 }),
      ],
    });
    expect(prismaMock.inventoryItem.findMany).toHaveBeenCalledWith({
      where: { partNumber: { in: ['SHIP-PN-1'] } },
      select: { partNumber: true, hsCode: true },
    });
    expect(prismaMock.inventory.findFirst).not.toHaveBeenCalled();
  });
});
