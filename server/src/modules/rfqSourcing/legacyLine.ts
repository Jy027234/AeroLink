import { normalizeOptionalMoney } from '../../lib/money.js';

export type RfqLineInput = {
  id?: string;
  partNumber: string;
  quantity: number;
  uom?: string | null;
  conditionCode?: string | null;
  description?: string | null;
  serialNumber?: string | null;
  batchNumber?: string | null;
  alternatePartNumbers?: string | null;
  certificateRequired?: boolean;
  certificateType?: string | null;
  requiredDate: Date | string;
  leadTimeDays?: number | null;
  targetPrice?: number | null;
  targetPriceCurrency?: string;
  ataChapter?: string | null;
  aircraftType?: string | null;
  aircraftModel?: string | null;
};

/** Exact compatibility projection. Never infer a source relationship from part number. */
export function rfqLineData(data: RfqLineInput, lineNo = 1) {
  return {
    lineNo,
    partNumber: data.partNumber,
    quantity: data.quantity,
    uom: data.uom ?? 'EA',
    conditionCode: data.conditionCode ?? 'NE',
    description: data.description ?? null,
    serialNumber: data.serialNumber ?? null,
    batchNumber: data.batchNumber ?? null,
    alternatePartNumbers: data.alternatePartNumbers ?? null,
    certificateRequired: data.certificateRequired ?? true,
    certificateType: data.certificateType ?? null,
    requiredDate: new Date(data.requiredDate),
    leadTimeDays: data.leadTimeDays ?? null,
    targetPriceDecimal: normalizeOptionalMoney(data.targetPrice),
    targetPriceCurrency: data.targetPriceCurrency ?? 'USD',
    ataChapter: data.ataChapter ?? null,
    aircraftType: data.aircraftType ?? null,
    aircraftModel: data.aircraftModel ?? null,
  };
}

export function legacyRfqLineData(data: RfqLineInput) {
  return rfqLineData(data, 1);
}

export const legacyRfqLineFields = [
  'partNumber', 'quantity', 'uom', 'conditionCode', 'description', 'serialNumber', 'batchNumber',
  'ataChapter', 'aircraftType', 'aircraftModel', 'alternatePartNumbers', 'certificateRequired', 'certificateType', 'requiredDate', 'leadTimeDays',
  'targetPrice', 'targetPriceCurrency',
] as const;

export function changesLegacyRfqLine(current: Record<string, unknown>, update: Record<string, unknown>) {
  return legacyRfqLineFields.some(field => {
    if (!(field in update)) return false;
    let value = update[field];
    if (value && typeof value === 'object' && 'set' in value) value = value.set;
    const previous = current[field];
    if (field === 'requiredDate') return new Date(previous as string | Date).getTime() !== new Date(value as string | Date).getTime();
    return previous !== value;
  });
}
