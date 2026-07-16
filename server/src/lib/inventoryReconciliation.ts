import prisma from './prisma.js';

export interface InventoryQuantityRow {
  id?: string;
  partNumber: string;
  quantity: number;
}

export interface InventoryReconciliationMismatch {
  partNumber: string;
  legacyQuantity: number;
  detailQuantity: number;
  delta: number;
}

export interface InventoryReconciliationResult {
  checkedPartNumbers: number;
  /** Full frozen legacy snapshot quantity. */
  legacyTotal: number;
  /** Legacy quantity still eligible for a strict migration snapshot comparison. */
  comparedLegacyTotal: number;
  /** Full canonical InventoryDetail quantity, including post-cutover writes. */
  detailTotal: number;
  /** Canonical quantity that originated from a matching legacy record. */
  comparedDetailTotal: number;
  /** Legacy-mapped details with ledger activity after cutover. */
  transactionalLegacyDetails: number;
  /** Current canonical quantity represented by those transactional details. */
  transactionalLegacyQuantity: number;
  /** Canonical records created after the cutover are expected to have no legacy row. */
  canonicalOnlyDetails: number;
  canonicalOnlyQuantity: number;
  mismatches: InventoryReconciliationMismatch[];
}

function sumQuantities(rows: InventoryQuantityRow[]) {
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

/**
 * Compares two supplied snapshots by part number. This pure helper keeps the
 * strict legacy-vs-detail behavior for migration tests and diagnostics.
 */
export function reconcileInventoryQuantities(
  legacyRows: InventoryQuantityRow[],
  detailRows: InventoryQuantityRow[],
): InventoryReconciliationResult {
  const legacyByPart = new Map<string, number>();
  const detailByPart = new Map<string, number>();

  for (const row of legacyRows) {
    legacyByPart.set(row.partNumber, (legacyByPart.get(row.partNumber) ?? 0) + row.quantity);
  }
  for (const row of detailRows) {
    detailByPart.set(row.partNumber, (detailByPart.get(row.partNumber) ?? 0) + row.quantity);
  }

  const partNumbers = new Set([...legacyByPart.keys(), ...detailByPart.keys()]);
  const mismatches = Array.from(partNumbers)
    .sort((a, b) => a.localeCompare(b))
    .map((partNumber) => {
      const legacyQuantity = legacyByPart.get(partNumber) ?? 0;
      const detailQuantity = detailByPart.get(partNumber) ?? 0;
      return {
        partNumber,
        legacyQuantity,
        detailQuantity,
        delta: legacyQuantity - detailQuantity,
      };
    })
    .filter((row) => row.delta !== 0);

  const detailTotal = sumQuantities(detailRows);
  return {
    checkedPartNumbers: partNumbers.size,
    legacyTotal: sumQuantities(legacyRows),
    comparedLegacyTotal: sumQuantities(legacyRows),
    detailTotal,
    comparedDetailTotal: detailTotal,
    transactionalLegacyDetails: 0,
    transactionalLegacyQuantity: 0,
    canonicalOnlyDetails: 0,
    canonicalOnlyQuantity: 0,
    mismatches,
  };
}

/**
 * During cutover, Inventory is a frozen historical snapshot. A new canonical
 * detail deliberately has no legacy twin, so it is reported separately rather
 * than treated as a mismatch that would pressure the application into dual
 * writes. Likewise, a legacy-mapped detail with an immutable transaction
 * ledger has legitimately diverged from the frozen legacy snapshot and is
 * shown separately. Rows without post-cutover ledger activity remain subject
 * to a strict same-ID migration comparison.
 */
export function reconcileLegacyInventorySnapshot(
  legacyRows: InventoryQuantityRow[],
  canonicalRows: Required<Pick<InventoryQuantityRow, 'id' | 'partNumber' | 'quantity'>>[],
  transactionalDetailIds: Iterable<string> = [],
): InventoryReconciliationResult {
  const legacyIds = new Set(legacyRows.map((row) => row.id).filter((id): id is string => Boolean(id)));
  const transactionalIds = new Set(transactionalDetailIds);
  const comparedLegacyRows = legacyRows.filter((row) => !row.id || !transactionalIds.has(row.id));
  const comparedRows = canonicalRows.filter((row) => legacyIds.has(row.id) && !transactionalIds.has(row.id));
  const transactionalRows = canonicalRows.filter((row) => legacyIds.has(row.id) && transactionalIds.has(row.id));
  const canonicalOnlyRows = canonicalRows.filter((row) => !legacyIds.has(row.id));
  const comparison = reconcileInventoryQuantities(comparedLegacyRows, comparedRows);
  const checkedPartNumbers = new Set([
    ...legacyRows.map((row) => row.partNumber),
    ...canonicalRows.map((row) => row.partNumber),
  ]).size;

  return {
    ...comparison,
    checkedPartNumbers,
    legacyTotal: sumQuantities(legacyRows),
    comparedLegacyTotal: sumQuantities(comparedLegacyRows),
    detailTotal: sumQuantities(canonicalRows),
    comparedDetailTotal: sumQuantities(comparedRows),
    transactionalLegacyDetails: transactionalRows.length,
    transactionalLegacyQuantity: sumQuantities(transactionalRows),
    canonicalOnlyDetails: canonicalOnlyRows.length,
    canonicalOnlyQuantity: sumQuantities(canonicalOnlyRows),
  };
}

export async function loadInventoryReconciliation(): Promise<InventoryReconciliationResult> {
  const [legacyRows, details, transactions] = await Promise.all([
    prisma.inventory.findMany({
      select: { id: true, partNumber: true, quantity: true },
    }),
    prisma.inventoryDetail.findMany({
      select: {
        id: true,
        quantity: true,
        inventoryItem: { select: { partNumber: true } },
      },
    }),
    prisma.inventoryTransaction.findMany({
      distinct: ['inventoryDetailId'],
      select: { inventoryDetailId: true },
    }),
  ]);

  return reconcileLegacyInventorySnapshot(
    legacyRows,
    details.map((detail) => ({
      id: detail.id,
      partNumber: detail.inventoryItem.partNumber,
      quantity: detail.quantity,
    })),
    transactions.map((transaction) => transaction.inventoryDetailId),
  );
}
