import { describe, expect, it } from 'vitest';
import { projectInventoryItem, serializeInventoryDetail } from './inventoryProjection.js';

const detail = {
  id: 'detail-1',
  inventoryItemId: 'item-1',
  quantity: 4,
  conditionCode: 'NE',
  status: 'AVAILABLE',
  serialNumber: null,
  batchNumber: 'B-1',
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
  unitCost: 123.45,
  supplierId: null,
  eta: null,
  type: 'OWN',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
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
  supplier: null,
};

describe('inventory cost projection', () => {
  it('keeps quantity/source fields but omits unit cost by default', () => {
    const safe = serializeInventoryDetail(detail as never);
    const privileged = serializeInventoryDetail(detail as never, { includeCost: true });

    expect(safe).toMatchObject({ id: 'detail-1', partNumber: 'PN-1', quantity: 4 });
    expect(safe).not.toHaveProperty('unitCost');
    expect(privileged).toHaveProperty('unitCost', 123.45);
  });

  it('removes nested detail costs without changing item identity or quantity', () => {
    const safe = projectInventoryItem({
      id: 'item-1',
      partNumber: 'PN-1',
      details: [{ id: 'detail-1', quantity: 4, unitCost: 123.45 }],
    }, false);
    const privileged = projectInventoryItem({
      id: 'item-1',
      partNumber: 'PN-1',
      details: [{ id: 'detail-1', quantity: 4, unitCost: 123.45 }],
    }, true);

    expect(safe).toEqual({ id: 'item-1', partNumber: 'PN-1', details: [{ id: 'detail-1', quantity: 4 }] });
    expect(privileged.details?.[0]).toHaveProperty('unitCost', 123.45);
  });
});
