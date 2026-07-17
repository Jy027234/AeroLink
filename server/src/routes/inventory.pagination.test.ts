import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

function createCanonicalDetail() {
  return {
    id: 'inventory-1',
    inventoryItemId: 'item-1',
    serialNumber: 'SN-1',
    batchNumber: null,
    quantity: 2,
    conditionCode: 'SV',
    status: 'AVAILABLE',
    warehouse: 'Main',
    shelf: 'S1',
    location: 'A1',
    certificateType: 'FAA-8130-3',
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
    unitCost: 100,
    supplierId: null,
    eta: null,
    type: 'OWN',
    createdAt: new Date('2026-07-14T00:00:00.000Z'),
    updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    supplier: null,
    inventoryItem: {
      id: 'item-1',
      partNumber: 'PN-100',
      description: 'Fuel pump',
      partCategory: 'ROTABLE',
      trackingType: 'SERIAL',
      manufacturer: 'OEM',
      manufacturerCageCode: null,
      ataChapter: '29',
      alternatePartNumbers: null,
      unitOfMeasure: 'EA',
      countryOfOrigin: 'US',
      hsCode: null,
      createdAt: new Date('2026-07-14T00:00:00.000Z'),
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    },
  };
}

describe('Inventory server-side pagination', () => {
  let reconciliationMock: ReturnType<typeof vi.fn>;
  let prismaMock: {
    inventory: { findMany: ReturnType<typeof vi.fn> };
    inventoryDetail: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    reconciliationMock = vi.fn();
    prismaMock = {
      inventory: { findMany: vi.fn() },
      inventoryDetail: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/socketEvents.js', () => ({
      SocketEvents: { INVENTORY_UPDATED: 'inventory.updated' },
      SocketRooms: { INVENTORY: 'inventory' },
    }));
    vi.doMock('../lib/inventoryReconciliation.js', () => ({
      loadInventoryReconciliation: reconciliationMock,
    }));
    vi.doMock('../middleware/rbac.js', () => ({
      requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
  });

  async function buildApp() {
    const inventoryRouter = (await import('./inventory.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'manager-1', role: 'manager' } });
      next();
    });
    app.use('/api/inventory', inventoryRouter);
    app.use(errorHandler);
    return app;
  }

  it('pushes canonical-detail filters and page boundaries into the database query', async () => {
    const detail = createCanonicalDetail();
    prismaMock.inventoryDetail.findMany.mockImplementation((args: { select?: unknown }) =>
      args.select
        ? [{ quantity: 2, unitCost: 100, location: 'A1', inventoryItem: { partCategory: 'ROTABLE' } }]
        : [detail],
    );
    prismaMock.inventoryDetail.count.mockResolvedValue(12);

    const app = await buildApp();
    const response = await request(app)
      .get('/api/inventory')
      .query({
        search: 'pn-100',
        conditionCode: 'sv',
        certificateType: 'faa-8130-3',
        type: 'own',
        partCategory: 'rotable',
        location: 'A1',
        page: '2',
        limit: '10',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: [{
        id: 'inventory-1',
        inventoryItemId: 'item-1',
        partNumber: 'PN-100',
        partCategory: 'ROTABLE',
        trackingType: 'SERIAL',
        status: 'AVAILABLE',
      }],
      summary: {
        total: 1,
        rotable: 1,
        repairable: 0,
        chemical: 0,
        standardPart: 0,
        rawMaterial: 0,
        consumable: 0,
        totalValue: 200,
        locations: ['A1'],
      },
      pagination: { page: 2, limit: 10, total: 12, totalPages: 2 },
    });

    const findManyArgs = prismaMock.inventoryDetail.findMany.mock.calls.find((call) => !call[0]?.select)?.[0];
    expect(findManyArgs).toEqual(expect.objectContaining({ skip: 10, take: 10 }));
    expect(findManyArgs.where).toEqual(expect.objectContaining({
      conditionCode: 'SV',
      certificateType: 'FAA-8130-3',
      type: 'OWN',
      location: 'A1',
      inventoryItem: expect.objectContaining({
        partCategory: 'ROTABLE',
      }),
      OR: expect.arrayContaining([
        { inventoryItem: { partNumber: { contains: 'pn-100', mode: 'insensitive' } } },
        { inventoryItem: { description: { contains: 'pn-100', mode: 'insensitive' } } },
      ]),
    }));
    expect(prismaMock.inventoryDetail.count).toHaveBeenCalledWith({ where: findManyArgs.where });
    expect(prismaMock.inventory.findMany).not.toHaveBeenCalled();
  });

  it('exposes a read-only reconciliation result for authorized managers', async () => {
    reconciliationMock.mockResolvedValue({
      checkedPartNumbers: 2,
      legacyTotal: 8,
      comparedLegacyTotal: 6,
      detailTotal: 10,
      comparedDetailTotal: 7,
      transactionalLegacyDetails: 1,
      transactionalLegacyQuantity: 1,
      canonicalOnlyDetails: 1,
      canonicalOnlyQuantity: 3,
      mismatches: [
        { partNumber: 'PN-200', legacyQuantity: 5, detailQuantity: 4, delta: 1 },
      ],
    });

    const app = await buildApp();
    const response = await request(app).get('/api/inventory/reconciliation');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        status: 'MISMATCH',
        checkedPartNumbers: 2,
        legacyTotal: 8,
        comparedLegacyTotal: 6,
        detailTotal: 10,
        comparedDetailTotal: 7,
        transactionalLegacyDetails: 1,
        transactionalLegacyQuantity: 1,
        canonicalOnlyDetails: 1,
        canonicalOnlyQuantity: 3,
        mismatches: [{ partNumber: 'PN-200', delta: 1 }],
      },
    });
    expect(reconciliationMock).toHaveBeenCalledTimes(1);
  });
});
