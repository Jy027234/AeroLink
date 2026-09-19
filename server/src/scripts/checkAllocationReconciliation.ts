import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { loadAllocationReconciliation } from '../modules/inventoryQuality/allocationReconciliation.js';

function assertDedicatedLocalDatabase(): void {
  if (process.env.AEROLINK_ALLOCATION_RECONCILIATION !== 'true') {
    throw new Error('Refusing allocation reconciliation without AEROLINK_ALLOCATION_RECONCILIATION=true');
  }
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error('DATABASE_URL is required');
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('Allocation reconciliation only permits a local PostgreSQL database');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/^aerolink_allocation_test_[a-z0-9_]+$/i.test(database)) {
    throw new Error('Allocation reconciliation requires a dedicated aerolink_allocation_test_* database');
  }
}

async function main(): Promise<void> {
  assertDedicatedLocalDatabase();
  try {
    const report = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return loadAllocationReconciliation(tx);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 120_000,
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
