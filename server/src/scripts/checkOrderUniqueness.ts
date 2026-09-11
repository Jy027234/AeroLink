import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';

async function main() {
  try {
    const [modeColumn] = await prisma.$queryRaw<Array<{ present: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = 'lineItemsMode') AS present
    `;
    const groups = await prisma.order.groupBy({
      by: ['quotationId'],
      ...(modeColumn?.present ? { where: { lineItemsMode: false } } : {}),
      _count: { quotationId: true },
    });
    const duplicates = groups.filter((group) => group._count.quotationId > 1);

    if (duplicates.length > 0) {
      const details = duplicates
        .map((group) => `${group.quotationId} (${group._count.quotationId} orders)`)
        .join(', ');
      throw new Error(
        `Duplicate Order.quotationId values detected: ${details}. `
          + 'Clean up duplicate orders before applying the unique constraint.'
      );
    }

    if (modeColumn?.present) {
      const mixedModes = await prisma.order.count({ where: { OR: [
        { lineItemsMode: true, quotation: { lineItemsMode: false } },
        { lineItemsMode: false, quotation: { lineItemsMode: true } },
      ] } });
      if (mixedModes) throw new Error(`${mixedModes} orders have a line mode inconsistent with their quotation; review explicit line provenance.`);
    }
    console.log(`Order uniqueness preflight passed (${groups.length} legacy quotation references checked; explicit line orders allow partial acceptance).`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
      console.log('Orders table does not exist yet; skipping order uniqueness preflight for an empty database.');
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
