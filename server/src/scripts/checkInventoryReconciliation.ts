import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import {
  loadInventoryReconciliation,
  type InventoryReconciliationResult,
} from '../lib/inventoryReconciliation.js';

async function main() {
  try {
    const result: InventoryReconciliationResult = await loadInventoryReconciliation();

    console.log(
      `Inventory reconciliation checked ${result.checkedPartNumbers} part numbers `
        + `(legacy total ${result.legacyTotal}, strict legacy total ${result.comparedLegacyTotal}, `
        + `compared detail total ${result.comparedDetailTotal}, `
        + `canonical total ${result.detailTotal}).`
    );
    if (result.transactionalLegacyDetails > 0) {
      console.log(
        `Ledger-backed legacy details: ${result.transactionalLegacyDetails} `
          + `(${result.transactionalLegacyQuantity} EA); their live canonical quantities are excluded from the frozen snapshot comparison.`
      );
    }
    if (result.canonicalOnlyDetails > 0) {
      console.log(
        `Canonical-only post-cutover details: ${result.canonicalOnlyDetails} `
          + `(${result.canonicalOnlyQuantity} EA); these are expected and are not legacy mismatches.`
      );
    }

    if (result.mismatches.length > 0) {
      console.error(`Inventory reconciliation found ${result.mismatches.length} mismatches:`);
      for (const mismatch of result.mismatches) {
        console.error(
          `- ${mismatch.partNumber}: legacy=${mismatch.legacyQuantity}, `
            + `detail=${mismatch.detailQuantity}, delta=${mismatch.delta}`
        );
      }
      process.exitCode = 1;
      return;
    }

    console.log('Inventory reconciliation passed: every non-transactional legacy snapshot row matches its canonical detail.');
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
      console.log('Inventory reconciliation skipped: Inventory or InventoryItem tables are not ready yet.');
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
