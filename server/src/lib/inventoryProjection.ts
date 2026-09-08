import type { InventoryDetail, InventoryItem, Supplier } from '@prisma/client';

/**
 * The legacy Inventory API is intentionally preserved as a read-compatible
 * projection. InventoryItem and InventoryDetail are the only writable stock
 * source; consumers of /api/inventory receive one projected row per detail.
 */
export type InventoryDetailProjection = InventoryDetail & {
  inventoryItem: InventoryItem;
  supplier: Pick<Supplier, 'id' | 'name'> | null;
};

function toIso(value: Date | null) {
  return value?.toISOString();
}

export function serializeInventoryDetail(
  detail: InventoryDetailProjection,
  options: { includeCost?: boolean } | boolean = false,
) {
  const includeCost = typeof options === 'boolean'
    ? options
    : options.includeCost === true;
  const item = detail.inventoryItem;
  return {
    id: detail.id,
    inventoryItemId: detail.inventoryItemId,
    partNumber: item.partNumber,
    description: item.description,
    quantity: detail.quantity,
    serialNumber: detail.serialNumber,
    batchNumber: detail.batchNumber,
    partCategory: item.partCategory,
    trackingType: item.trackingType,
    manufacturer: item.manufacturer,
    manufacturerCageCode: item.manufacturerCageCode,
    ataChapter: item.ataChapter,
    alternatePartNumbers: item.alternatePartNumbers,
    conditionCode: detail.conditionCode,
    status: detail.status,
    certificateType: detail.certificateType,
    certificateNumber: detail.certificateNumber,
    certificateFileUrl: detail.certificateFileUrl,
    lifeLimited: detail.lifeLimited,
    totalHours: detail.totalHours,
    totalCycles: detail.totalCycles,
    remainingHours: detail.remainingHours,
    remainingCycles: detail.remainingCycles,
    manufactureDate: toIso(detail.manufactureDate),
    shelfLifeDate: toIso(detail.shelfLifeDate),
    overhaulDate: toIso(detail.overhaulDate),
    nextOverhaulDue: toIso(detail.nextOverhaulDue),
    adStatus: detail.adStatus,
    sbStatus: detail.sbStatus,
    repairScheme: detail.repairScheme,
    previousOperator: detail.previousOperator,
    removalAircraftReg: detail.removalAircraftReg,
    removalDate: toIso(detail.removalDate),
    removalReason: detail.removalReason,
    nonIncidentStatement: detail.nonIncidentStatement,
    militarySource: detail.militarySource,
    traceabilityDocs: detail.traceabilityDocs,
    location: detail.location,
    warehouse: detail.warehouse,
    shelf: detail.shelf,
    storageCondition: detail.storageCondition,
    ata300Packaging: detail.ata300Packaging,
    shelfLifeDays: detail.shelfLifeDays,
    storageTempMin: detail.storageTempMin,
    storageTempMax: detail.storageTempMax,
    hazardClass: detail.hazardClass,
    ...(includeCost ? { unitCost: detail.unitCost } : {}),
    unitOfMeasure: item.unitOfMeasure,
    countryOfOrigin: item.countryOfOrigin,
    hsCode: item.hsCode,
    type: detail.type.toLowerCase(),
    supplierId: detail.supplierId,
    supplierName: detail.supplier?.name,
    eta: toIso(detail.eta),
    createdAt: detail.createdAt.toISOString(),
    updatedAt: detail.updatedAt.toISOString(),
  };
}

/** Remove unit cost from item/detail responses while preserving all stock data. */
export function projectInventoryItem<T extends { details?: unknown }>(item: T, includeCost: boolean): T {
  const details = item.details;
  if (includeCost || !Array.isArray(details)) return item;

  return {
    ...item,
    details: details.map((detail) => {
      if (!detail || typeof detail !== 'object') return detail;
      const { unitCost: _unitCost, ...safeDetail } = detail as Record<string, unknown>;
      return safeDetail;
    }),
  } as T;
}
