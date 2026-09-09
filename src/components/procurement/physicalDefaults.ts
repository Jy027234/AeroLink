import type { ReceiptPhysical } from '@/features/orders';

export function emptyPhysical(partNumber: string, uom = 'EA'): ReceiptPhysical {
  return { partNumber, uom, trackingType: 'BATCH', quantity: 1, conditionCode: 'NE', serialNumber: null,
    batchNumber: null, certificateReferences: [], certificateType: null, certificateNumber: null,
    lifeLimited: false, remainingHours: null, remainingCycles: null, shelfLifeDate: null, shelfLifeDays: null,
    nextOverhaulDue: null, storageCondition: null };
}

export function localDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
