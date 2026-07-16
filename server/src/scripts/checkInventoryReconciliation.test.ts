import { describe, expect, it } from 'vitest';
import { reconcileInventoryQuantities, reconcileLegacyInventorySnapshot } from '../lib/inventoryReconciliation.js';

describe('inventory reconciliation', () => {
  it('aggregates duplicate legacy rows and detail rows by part number', () => {
    const result = reconcileInventoryQuantities(
      [
        { partNumber: 'PN-2', quantity: 3 },
        { partNumber: 'PN-1', quantity: 2 },
        { partNumber: 'PN-1', quantity: 1 },
      ],
      [
        { partNumber: 'PN-1', quantity: 3 },
        { partNumber: 'PN-2', quantity: 2 },
      ],
    );

    expect(result).toMatchObject({
      checkedPartNumbers: 2,
      legacyTotal: 6,
      detailTotal: 5,
      mismatches: [{ partNumber: 'PN-2', legacyQuantity: 3, detailQuantity: 2, delta: 1 }],
    });
  });

  it('reports orphaned part numbers on either side', () => {
    const result = reconcileInventoryQuantities(
      [{ partNumber: 'LEGACY-ONLY', quantity: 4 }],
      [{ partNumber: 'DETAIL-ONLY', quantity: 2 }],
    );

    expect(result.mismatches).toEqual([
      { partNumber: 'DETAIL-ONLY', legacyQuantity: 0, detailQuantity: 2, delta: -2 },
      { partNumber: 'LEGACY-ONLY', legacyQuantity: 4, detailQuantity: 0, delta: 4 },
    ]);
  });

  it('passes when both models have the same total by part number', () => {
    const result = reconcileInventoryQuantities(
      [{ partNumber: 'PN-1', quantity: 5 }],
      [
        { partNumber: 'PN-1', quantity: 2 },
        { partNumber: 'PN-1', quantity: 3 },
      ],
    );

    expect(result.mismatches).toEqual([]);
    expect(result.legacyTotal).toBe(result.detailTotal);
  });

  it('keeps post-cutover canonical-only details visible without treating them as legacy mismatches', () => {
    const result = reconcileLegacyInventorySnapshot(
      [{ id: 'legacy-1', partNumber: 'PN-1', quantity: 5 }],
      [
        { id: 'legacy-1', partNumber: 'PN-1', quantity: 5 },
        { id: 'canonical-2', partNumber: 'PN-2', quantity: 3 },
      ],
    );

    expect(result).toMatchObject({
      checkedPartNumbers: 2,
      legacyTotal: 5,
      comparedLegacyTotal: 5,
      comparedDetailTotal: 5,
      detailTotal: 8,
      canonicalOnlyDetails: 1,
      canonicalOnlyQuantity: 3,
      mismatches: [],
    });
  });

  it('keeps ledger-backed legacy details out of the frozen snapshot comparison', () => {
    const result = reconcileLegacyInventorySnapshot(
      [{ id: 'legacy-1', partNumber: 'PN-1', quantity: 5 }],
      [{ id: 'legacy-1', partNumber: 'PN-1', quantity: 3 }],
      ['legacy-1'],
    );

    expect(result).toMatchObject({
      legacyTotal: 5,
      comparedLegacyTotal: 0,
      detailTotal: 3,
      comparedDetailTotal: 0,
      transactionalLegacyDetails: 1,
      transactionalLegacyQuantity: 3,
      mismatches: [],
    });
  });
});
