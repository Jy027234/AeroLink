import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Inventory server-side pagination', () => {
  let reconciliationMock: ReturnType<typeof vi.fn>;
  let prismaMock: {
    inventory: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      groupBy: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    reconciliationMock = vi.fn();
    prismaMock = {
      inventory: {
        findMany: vi.fn(),
        count: vi.fn(),
        groupBy: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/socketEvents.js', () => ({
      SocketEvents: { INVENTORY_UPDATED: 'inventory.updated' },
      SocketRooms: { INVENTORY: 'inventory' },
      emitToRoom: vi.fn(),
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
    app.use('/api/inventory', inventoryRouter);
    app.use(errorHandler);
    return app;
  }

  it('pushes inventory filters and page boundaries into the database query', async () => {
    const inventory = {
      id: 'inventory-1',
      partNumber: 'PN-100',
      description: 'Fuel pump',
      quantity: 2,
      location: 'A1',
      warehouse: 'Main',
      shelf: 'S1',
      conditionCode: 'SV',
      certificateType: 'FAA-8130-3',
      certificateNumber: null,
      certificateFileUrl: null,
      serialNumber: 'SN-1',
      batchNumber: null,
      manufacturer: 'OEM',
      manufacturerCageCode: null,
      ataChapter: '29',
      alternatePartNumbers: null,
      partCategory: 'ROTABLE',
      trackingType: 'SERIAL',
      unitOfMeasure: 'EA',
      countryOfOrigin: 'US',
      hsCode: null,
      type: 'OWN',
      unitCost: 100,
      supplierId: null,
      supplier: null,
      eta: null,
      createdAt: new Date('2026-07-14T00:00:00.000Z'),
      lifeLimited: false,
      totalHours: null,
      totalCycles: null,
      remainingHours: null,
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
    };

    prismaMock.inventory.findMany.mockImplementation((args: { select?: unknown }) =>
      args.select ? [{ quantity: 2, unitCost: 100 }] : [inventory],
    );
    prismaMock.inventory.count.mockResolvedValue(12);
    prismaMock.inventory.groupBy.mockImplementation((args: { by: string[] }) =>
      args.by[0] === 'partCategory'
        ? [{ partCategory: 'ROTABLE', _count: { _all: 12 } }]
        : [{ location: 'A1', _count: { _all: 12 }}],
    );

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
      data: [{ id: 'inventory-1', partNumber: 'PN-100', partCategory: 'ROTABLE', trackingType: 'SERIAL' }],
      summary: {
        total: 12,
        rotable: 12,
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

    const findManyArgs = prismaMock.inventory.findMany.mock.calls.find((call) => !call[0]?.select)?.[0];
    expect(findManyArgs).toEqual(expect.objectContaining({ skip: 10, take: 10 }));
    expect(findManyArgs.where).toEqual(expect.objectContaining({
      conditionCode: 'SV',
      certificateType: 'FAA-8130-3',
      type: 'OWN',
      partCategory: 'ROTABLE',
      location: 'A1',
      OR: expect.arrayContaining([
        { partNumber: { contains: 'pn-100', mode: 'insensitive' } },
        { description: { contains: 'pn-100', mode: 'insensitive' } },
      ]),
    }));
    expect(prismaMock.inventory.count).toHaveBeenCalledWith({ where: findManyArgs.where });
  });

  it('exposes a read-only reconciliation result for authorized operators', async () => {
    reconciliationMock.mockResolvedValue({
      checkedPartNumbers: 2,
      legacyTotal: 8,
      detailTotal: 7,
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
        detailTotal: 7,
        mismatches: [{ partNumber: 'PN-200', delta: 1 }],
      },
    });
    expect(reconciliationMock).toHaveBeenCalledTimes(1);
  });
});
