export interface InventoryQuantityRow {
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
  legacyTotal: number;
  detailTotal: number;
  mismatches: InventoryReconciliationMismatch[];
}

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

  return {
    checkedPartNumbers: partNumbers.size,
    legacyTotal: Array.from(legacyByPart.values()).reduce((sum, quantity) => sum + quantity, 0),
    detailTotal: Array.from(detailByPart.values()).reduce((sum, quantity) => sum + quantity, 0),
    mismatches,
  };
}

export async function loadInventoryReconciliation(): Promise<InventoryReconciliationResult> {
  const [legacyRows, inventoryItems] = await Promise.all([
    prisma.inventory.findMany({
      select: { partNumber: true, quantity: true },
    }),
    prisma.inventoryItem.findMany({
      select: {
        partNumber: true,
        details: { select: { quantity: true } },
      },
    }),
  ]);

  const detailRows = inventoryItems.flatMap((item) =>
    item.details.map((detail) => ({ partNumber: item.partNumber, quantity: detail.quantity }))
  );

  return reconcileInventoryQuantities(legacyRows, detailRows);
}
import prisma from './prisma.js';
