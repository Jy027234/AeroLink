import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

function detail() {
  return {
    id: 'detail-1',
    inventoryItemId: 'item-1',
    serialNumber: null,
    batchNumber: null,
    quantity: 2,
    conditionCode: 'NE',
    status: 'AVAILABLE',
    warehouse: null,
    shelf: null,
    location: 'A1',
    certificateType: 'NONE',
    certificateNumber: null,
    certificateFileUrl: null,
    lifeLimited: false,
    totalHours: null,
    remainingHours: null,
    totalCycles: null,
    remainingCycles: null,
    manufactureDate: null,
    shelfLifeDate: null,
    overhaulDate: null,
    nextOverhaulDue: null,
    adStatus: null,
    sbStatus: null,
    repairScheme: null,
    previousOperator: null,
    removalAircraftReg: null,
    removalDate: null,
    removalReason: null,
    nonIncidentStatement: false,
    militarySource: false,
    traceabilityDocs: null,
    storageCondition: null,
    ata300Packaging: false,
    shelfLifeDays: null,
    storageTempMin: null,
    storageTempMax: null,
    hazardClass: null,
    unitCost: 900,
    supplierId: null,
    eta: null,
    type: 'OWN',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    supplier: null,
    inventoryItem: {
      id: 'item-1',
      partNumber: 'PN-1',
      description: 'test',
      partCategory: 'ROTABLE',
      trackingType: 'BATCH',
      manufacturer: null,
      manufacturerCageCode: null,
      ataChapter: null,
      alternatePartNumbers: null,
      unitOfMeasure: 'EA',
      countryOfOrigin: null,
      hsCode: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  };
}

describe('inventory cost visibility', () => {
  let prismaMock: {
    inventory: { findMany: ReturnType<typeof vi.fn> };
    inventoryDetail: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    const row = detail();
    prismaMock = {
      inventory: { findMany: vi.fn() },
      inventoryDetail: {
        findMany: vi.fn().mockImplementation((args: { select?: unknown }) => (
          args.select
            ? [{ quantity: row.quantity, unitCost: row.unitCost, location: row.location, inventoryItem: { partCategory: 'ROTABLE' } }]
            : [row]
        )),
        count: vi.fn().mockResolvedValue(1),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/socketEvents.js', () => ({
      SocketEvents: { INVENTORY_UPDATED: 'inventory.updated' },
      SocketRooms: { INVENTORY: 'inventory' },
    }));
    vi.doMock('../lib/inventoryReconciliation.js', () => ({ loadInventoryReconciliation: vi.fn() }));
  });

  it('returns source and quantity data while hiding unit cost and total value', async () => {
    const router = (await import('./inventory.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'sales-1', role: 'sales', department: 'Sales' } });
      next();
    });
    app.use('/api/inventory', router);
    app.use(errorHandler);

    const response = await request(app).get('/api/inventory');

    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({ partNumber: 'PN-1', quantity: 2 });
    expect(response.body.data[0]).not.toHaveProperty('unitCost');
    expect(response.body.summary.totalValue).toBeNull();
  });
});
