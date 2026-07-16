import prisma from './prisma.js';

export interface CanonicalInventoryBalance {
  quantity: number;
  value: number;
  detailCount: number;
}

/**
 * Loads sellable balances from the canonical detail layer. Reservations remain
 * physically owned stock, but cannot satisfy another VMI replenishment need,
 * so only AVAILABLE details contribute here.
 */
export async function loadAvailableInventoryBalances(partNumbers: Iterable<string>) {
  const uniquePartNumbers = Array.from(new Set(
    Array.from(partNumbers)
      .map((partNumber) => partNumber.trim())
      .filter(Boolean),
  ));
  const balances = new Map<string, CanonicalInventoryBalance>();

  for (const partNumber of uniquePartNumbers) {
    balances.set(partNumber, { quantity: 0, value: 0, detailCount: 0 });
  }
  if (uniquePartNumbers.length === 0) {
    return balances;
  }

  const details = await prisma.inventoryDetail.findMany({
    where: {
      status: 'AVAILABLE',
      inventoryItem: { partNumber: { in: uniquePartNumbers } },
    },
    select: {
      quantity: true,
      unitCost: true,
      inventoryItem: { select: { partNumber: true } },
    },
  });

  for (const detail of details) {
    const partNumber = detail.inventoryItem.partNumber;
    const current = balances.get(partNumber) ?? { quantity: 0, value: 0, detailCount: 0 };
    balances.set(partNumber, {
      quantity: current.quantity + detail.quantity,
      value: current.value + detail.quantity * detail.unitCost,
      detailCount: current.detailCount + 1,
    });
  }

  return balances;
}
