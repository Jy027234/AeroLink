import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { reconcileMoneyShadows } from './moneyReconciliation.js';

describe('money shadow reconciliation', () => {
  it('passes when Decimal shadows match legacy compatibility values at four decimal places', () => {
    const result = reconcileMoneyShadows([
      {
        entity: 'quotation',
        id: 'quote-1',
        fields: [
          { name: 'unitPrice', legacyValue: 0.1 + 0.2, decimalValue: new Prisma.Decimal('0.3000') },
          { name: 'totalPrice', legacyValue: 12.3456, decimalValue: new Prisma.Decimal('12.3456') },
        ],
      },
    ]);

    expect(result).toEqual({
      status: 'PASS',
      checkedRecords: 1,
      checkedFields: 2,
      missingShadowFields: 0,
      mismatchedFields: 0,
      unexpectedShadowFields: 0,
      issues: [],
    });
  });

  it('reports missing, divergent, and unexpected shadow values separately', () => {
    const result = reconcileMoneyShadows([
      {
        entity: 'order',
        id: 'order-1',
        fields: [
          { name: 'totalAmount', legacyValue: 100, decimalValue: null },
          { name: 'importDuty', legacyValue: 10, decimalValue: new Prisma.Decimal('9.9999') },
          { name: 'vatAmount', legacyValue: null, decimalValue: new Prisma.Decimal('1.0000') },
          { name: 'totalLandCost', legacyValue: null, decimalValue: null },
        ],
      },
    ]);

    expect(result).toMatchObject({
      status: 'FAIL',
      checkedRecords: 1,
      checkedFields: 3,
      missingShadowFields: 1,
      mismatchedFields: 1,
      unexpectedShadowFields: 1,
      issues: [
        expect.objectContaining({ field: 'totalAmount', reason: 'MISSING_SHADOW' }),
        expect.objectContaining({ field: 'importDuty', reason: 'MISMATCH' }),
        expect.objectContaining({ field: 'vatAmount', reason: 'UNEXPECTED_SHADOW' }),
      ],
    });
  });
});
