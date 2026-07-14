import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';

async function main() {
  try {
    const groups = await prisma.order.groupBy({
      by: ['quotationId'],
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

    console.log(`Order uniqueness preflight passed (${groups.length} quotation references checked).`);
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
