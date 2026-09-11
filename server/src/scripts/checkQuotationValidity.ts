import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { checkQuotationValidity } from '../lib/quotationValidityPreflight.js';

async function main() {
  try {
    const records = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return tx.quotation.findMany({
        select: { id: true, quoteNumber: true, version: true, status: true, expiryDate: true, validityDeadline: true, createdAt: true },
        orderBy: { id: 'asc' },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 });
    const report = checkQuotationValidity(records);
    console.log(JSON.stringify({ mode: 'read-only', ...report }, null, 2));
    if (report.status !== 'READY') process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
