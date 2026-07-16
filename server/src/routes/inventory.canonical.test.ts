import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

function createCanonicalDetail(quantity: number) {
  return {
    id: 'detail-1',
    inventoryItemId: 'item-1',
    serialNumber: null,
    batchNumber: null,
    quantity,
    conditionCode: 'NE',
    status: 'AVAILABLE',
    warehouse: 'Main',
    shelf: null,
    location: 'A-01',
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
    unitCost: 1200,
    supplierId: null,
    eta: null,
    type: 'OWN',
    createdAt: new Date('2026-07-16T00:00:00.000Z'),
    updatedAt: new Date('2026-07-16T00:00:00.000Z'),
    supplier: null,
    inventoryItem: {
      id: 'item-1',
      partNumber: 'CANONICAL-100',
      description: 'Canonical stock test item',
      partCategory: 'ROTABLE',
      trackingType: 'BATCH',
      manufacturer: null,
      manufacturerCageCode: null,
      ataChapter: null,
      alternatePartNumbers: null,
      unitOfMeasure: 'EA',
      countryOfOrigin: null,
      hsCode: null,
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
      updatedAt: new Date('2026-07-16T00:00:00.000Z'),
    },
  };
}

describe('canonical inventory mutations', () => {
  let prismaMock: {
    inventory: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    inventoryItem: {
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    inventoryDetail: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    inventoryTransaction: { create: ReturnType<typeof vi.fn> };
  };
  let enqueueBusinessEventMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      // These spies make an accidental legacy write observable.
      inventory: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      inventoryItem: { upsert: vi.fn(), update: vi.fn() },
      inventoryDetail: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      inventoryTransaction: { create: vi.fn() },
    };
    enqueueBusinessEventMock = vi.fn();

    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../middleware/rbac.js', () => ({
      requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }));
    vi.doMock('../lib/idempotencyService.js', () => ({
      buildIdempotencyContext: vi.fn(() => ({})),
      runIdempotentOperation: vi.fn(async (
        _context: unknown,
        operation: (tx: typeof prismaMock) => Promise<{
          payload: unknown;
          statusCode?: number;
          resourceType?: string;
          resourceId?: string;
        }>,
      ) => {
        const result = await operation(prismaMock);
        return { ...result, statusCode: result.statusCode ?? 200, replayed: false };
      }),
      applyIdempotencyHeaders: vi.fn(),
    }));
    vi.doMock('../lib/outboxService.js', () => ({
      enqueueBusinessEvent: enqueueBusinessEventMock,
    }));
    vi.doMock('../lib/socketEvents.js', () => ({
      SocketEvents: { INVENTORY_UPDATED: 'inventory.updated' },
      SocketRooms: { INVENTORY: 'inventory' },
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

  it('creates a receipt, ledger row and outbox event without writing legacy Inventory', async () => {
    const detail = createCanonicalDetail(4);
    prismaMock.inventoryItem.upsert.mockResolvedValue(detail.inventoryItem);
    prismaMock.inventoryDetail.create.mockResolvedValue(detail);
    prismaMock.inventoryTransaction.create.mockResolvedValue({ id: 'txn-inbound-1' });

    const app = await buildApp();
    const response = await request(app)
      .post('/api/inventory')
      .send({
        partNumber: detail.inventoryItem.partNumber,
        description: detail.inventoryItem.description,
        partCategory: 'ROTABLE',
        trackingType: 'BATCH',
        quantity: 4,
        location: detail.location,
        unitCost: detail.unitCost,
        notes: 'Initial canonical receipt',
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        id: detail.id,
        inventoryItemId: detail.inventoryItemId,
        partNumber: detail.inventoryItem.partNumber,
        quantity: 4,
      },
    });
    expect(prismaMock.inventoryItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { partNumber: detail.inventoryItem.partNumber },
      create: expect.objectContaining({ description: detail.inventoryItem.description }),
    }));
    expect(prismaMock.inventoryDetail.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ inventoryItemId: detail.inventoryItemId, quantity: 4 }),
    }));
    expect(prismaMock.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inventoryDetailId: detail.id,
        type: 'INBOUND',
        beforeQuantity: 0,
        afterQuantity: 4,
      }),
    });
    expect(enqueueBusinessEventMock).toHaveBeenCalledWith(prismaMock, expect.objectContaining({
      eventType: 'inventory.created',
      aggregateId: detail.id,
    }));
    expect(prismaMock.inventory.create).not.toHaveBeenCalled();
    expect(prismaMock.inventory.update).not.toHaveBeenCalled();
    expect(prismaMock.inventory.delete).not.toHaveBeenCalled();
  });

  it('adjusts the canonical detail and writes an immutable adjustment ledger row only', async () => {
    const existing = createCanonicalDetail(2);
    const updated = createCanonicalDetail(5);
    prismaMock.inventoryDetail.findUnique.mockResolvedValue(existing);
    prismaMock.inventoryDetail.update.mockResolvedValue(updated);
    prismaMock.inventoryTransaction.create.mockResolvedValue({ id: 'txn-adjustment-1' });

    const app = await buildApp();
    const response = await request(app)
      .patch(`/api/inventory/${existing.id}`)
      .send({ quantity: 5, notes: 'Cycle-count adjustment' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: existing.id, quantity: 5 });
    expect(prismaMock.inventoryDetail.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: existing.id },
      data: expect.objectContaining({ quantity: 5 }),
    }));
    expect(prismaMock.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inventoryDetailId: existing.id,
        type: 'ADJUSTMENT',
        quantity: 3,
        beforeQuantity: 2,
        afterQuantity: 5,
      }),
    });
    expect(enqueueBusinessEventMock).toHaveBeenCalledWith(prismaMock, expect.objectContaining({
      eventType: 'inventory.adjusted',
      aggregateId: existing.id,
    }));
    expect(prismaMock.inventory.create).not.toHaveBeenCalled();
    expect(prismaMock.inventory.update).not.toHaveBeenCalled();
    expect(prismaMock.inventory.delete).not.toHaveBeenCalled();
  });
});
