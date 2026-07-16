import { moneyValuesMatch, type MoneyInput } from './money.js';
import prisma from './prisma.js';

type ShadowValue = MoneyInput | null | undefined;

export interface MoneyShadowIssue {
  entity: 'quotation' | 'order' | 'supplierQuote';
  id: string;
  field: string;
  legacyValue: number | null;
  decimalValue: string | null;
  reason: 'MISSING_SHADOW' | 'MISMATCH' | 'UNEXPECTED_SHADOW';
}

export interface MoneyShadowReconciliationResult {
  status: 'PASS' | 'FAIL';
  checkedRecords: number;
  checkedFields: number;
  missingShadowFields: number;
  mismatchedFields: number;
  unexpectedShadowFields: number;
  issues: MoneyShadowIssue[];
}

interface ShadowField {
  name: string;
  legacyValue: number | null | undefined;
  decimalValue: ShadowValue;
}

interface ShadowRecord {
  entity: MoneyShadowIssue['entity'];
  id: string;
  fields: ShadowField[];
}

function decimalToString(value: ShadowValue) {
  return value === null || value === undefined ? null : String(value);
}

export function reconcileMoneyShadows(records: ShadowRecord[]): MoneyShadowReconciliationResult {
  const issues: MoneyShadowIssue[] = [];
  let checkedFields = 0;
  let missingShadowFields = 0;
  let mismatchedFields = 0;
  let unexpectedShadowFields = 0;

  for (const record of records) {
    for (const field of record.fields) {
      const hasLegacy = field.legacyValue !== null && field.legacyValue !== undefined;
      const hasDecimal = field.decimalValue !== null && field.decimalValue !== undefined;
      if (!hasLegacy && !hasDecimal) {
        continue;
      }
      checkedFields += 1;

      if (hasLegacy && !hasDecimal) {
        missingShadowFields += 1;
        issues.push({
          entity: record.entity,
          id: record.id,
          field: field.name,
          legacyValue: field.legacyValue ?? null,
          decimalValue: null,
          reason: 'MISSING_SHADOW',
        });
        continue;
      }
      if (!hasLegacy && hasDecimal) {
        unexpectedShadowFields += 1;
        issues.push({
          entity: record.entity,
          id: record.id,
          field: field.name,
          legacyValue: null,
          decimalValue: decimalToString(field.decimalValue),
          reason: 'UNEXPECTED_SHADOW',
        });
        continue;
      }
      if (!moneyValuesMatch(field.decimalValue, field.legacyValue)) {
        mismatchedFields += 1;
        issues.push({
          entity: record.entity,
          id: record.id,
          field: field.name,
          legacyValue: field.legacyValue ?? null,
          decimalValue: decimalToString(field.decimalValue),
          reason: 'MISMATCH',
        });
      }
    }
  }

  return {
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    checkedRecords: records.length,
    checkedFields,
    missingShadowFields,
    mismatchedFields,
    unexpectedShadowFields,
    issues,
  };
}

export async function loadMoneyShadowReconciliation() {
  const [quotations, orders, supplierQuotes] = await Promise.all([
    prisma.quotation.findMany({
      select: {
        id: true,
        unitPrice: true,
        unitPriceDecimal: true,
        totalPrice: true,
        totalPriceDecimal: true,
        costPrice: true,
        costPriceDecimal: true,
      },
    }),
    prisma.order.findMany({
      select: {
        id: true,
        totalAmount: true,
        totalAmountDecimal: true,
        importDuty: true,
        importDutyDecimal: true,
        vatAmount: true,
        vatAmountDecimal: true,
        totalLandCost: true,
        totalLandCostDecimal: true,
        exchangeCoreCharge: true,
        exchangeCoreChargeDecimal: true,
      },
    }),
    prisma.supplierQuote.findMany({
      select: {
        id: true,
        unitPrice: true,
        unitPriceDecimal: true,
        totalPrice: true,
        totalPriceDecimal: true,
      },
    }),
  ]);

  return reconcileMoneyShadows([
    ...quotations.map((quotation) => ({
      entity: 'quotation' as const,
      id: quotation.id,
      fields: [
        { name: 'unitPrice', legacyValue: quotation.unitPrice, decimalValue: quotation.unitPriceDecimal },
        { name: 'totalPrice', legacyValue: quotation.totalPrice, decimalValue: quotation.totalPriceDecimal },
        { name: 'costPrice', legacyValue: quotation.costPrice, decimalValue: quotation.costPriceDecimal },
      ],
    })),
    ...orders.map((order) => ({
      entity: 'order' as const,
      id: order.id,
      fields: [
        { name: 'totalAmount', legacyValue: order.totalAmount, decimalValue: order.totalAmountDecimal },
        { name: 'importDuty', legacyValue: order.importDuty, decimalValue: order.importDutyDecimal },
        { name: 'vatAmount', legacyValue: order.vatAmount, decimalValue: order.vatAmountDecimal },
        { name: 'totalLandCost', legacyValue: order.totalLandCost, decimalValue: order.totalLandCostDecimal },
        { name: 'exchangeCoreCharge', legacyValue: order.exchangeCoreCharge, decimalValue: order.exchangeCoreChargeDecimal },
      ],
    })),
    ...supplierQuotes.map((supplierQuote) => ({
      entity: 'supplierQuote' as const,
      id: supplierQuote.id,
      fields: [
        { name: 'unitPrice', legacyValue: supplierQuote.unitPrice, decimalValue: supplierQuote.unitPriceDecimal },
        { name: 'totalPrice', legacyValue: supplierQuote.totalPrice, decimalValue: supplierQuote.totalPriceDecimal },
      ],
    })),
  ]);
}
