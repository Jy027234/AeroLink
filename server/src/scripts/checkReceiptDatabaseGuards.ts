import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { CapabilityActor } from '../lib/capabilityPolicy.js';
import { releaseLineInventory, reserveLineInventory } from '../modules/inventoryQuality/allocationService.js';

/**
 * Database-only D14 receipt guard evidence.
 *
 * This script is intentionally fail-closed.  It never creates a receipt or
 * rewrites existing facts; the receiving integration script must first leave
 * an accepted receipt line in the disposable clone below.  Every negative
 * case runs in a transaction which is expected to roll back.  The race uses
 * two independent clients against the same physical source lot.
 */
const expectedDatabase = 'aerolink_procurement_test_receipts_20260909';
const expectedPort = '55970';
const optIn = process.env.AEROLINK_RECEIPT_DATABASE_GUARDS;
const databaseUrlValue = process.env.DATABASE_URL;
if (optIn !== 'true' || !databaseUrlValue) {
  throw new Error(
    `Explicit AEROLINK_RECEIPT_DATABASE_GUARDS=true and ${expectedDatabase} DATABASE_URL are required`,
  );
}
const databaseUrl = new URL(databaseUrlValue);
if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.port !== expectedPort
  || databaseUrl.pathname !== `/${expectedDatabase}`) {
  throw new Error(`Refusing non-local/non-${expectedDatabase} DATABASE_URL`);
}

type Tx = Prisma.TransactionClient;
type ErrorLike = { code?: unknown; statusCode?: unknown; message?: unknown };
type Rejection = { label: string; code?: unknown; statusCode?: unknown; message?: unknown };

type ActorRow = { id: string; role: string; department: string | null };

type Fixture = {
  receipt: {
    id: string;
    version: number;
    purchaseCommitmentId: string;
    supplierDeliveryReference: string;
  };
  receiptLine: {
    id: string;
    quantity: number;
    version: number;
    purchaseCommitmentLineId: string;
    inventoryDetailId: string;
    inventoryTransactionId: string;
    orderLineId: string;
    quotationLineId: string;
    actor: CapabilityActor;
  };
  detail: {
    id: string;
    quantity: number;
    allocatedQuantity: number;
    status: string;
    stockLotKey: string;
    inventoryItemId: string;
    inventoryItem: {
      id: string;
      partNumber: string;
      trackingType: string;
      unitOfMeasure: string;
    };
  };
  inbound: {
    id: string;
    quantity: number;
    beforeQuantity: number;
    afterQuantity: number;
  };
  otherDetailId: string;
};

function toActor(row: ActorRow): CapabilityActor {
  return { id: row.id, role: row.role, department: row.department };
}

function errorRecord(error: unknown): Omit<Rejection, 'label'> {
  if (error && typeof error === 'object') {
    const value = error as ErrorLike;
    return {
      ...(value.code === undefined ? {} : { code: value.code }),
      ...(value.statusCode === undefined ? {} : { statusCode: value.statusCode }),
      message: typeof value.message === 'string' ? value.message : String(error),
    };
  }
  return { message: String(error) };
}

async function expectRejected(label: string, run: () => Promise<unknown>): Promise<Rejection> {
  try {
    await run();
  } catch (error) {
    return { label, ...errorRecord(error) };
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function transact<T>(
  client: PrismaClient,
  run: (tx: Tx) => Promise<T>,
  isolationLevel: Prisma.TransactionIsolationLevel = 'Serializable',
): Promise<T> {
  return client.$transaction(async (tx) => {
    const result = await run(tx);
    // Receipt and allocation guards are deferred so their cross-table facts
    // can be created atomically.  Make a failed commit visible to this script.
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return result;
  }, { isolationLevel, timeout: 60_000, maxWait: 10_000 });
}

function activeAllocationQuantity(row: {
  allocatedQuantity: number;
  releasedQuantity: number;
}): number {
  return row.allocatedQuantity - row.releasedQuantity;
}

function activeAssignmentQuantity(row: {
  assignedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
}): number {
  return row.assignedQuantity - row.releasedQuantity - row.consumedQuantity;
}

async function findAdminActor(db: PrismaClient): Promise<CapabilityActor> {
  const row = await db.user.findFirst({
    where: { role: { in: ['ADMIN', 'GM'] } },
    select: { id: true, role: true, department: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!row) throw new Error('No ADMIN/GM actor exists in the dedicated receipt database');
  return toActor(row);
}

async function findFixture(db: PrismaClient): Promise<Fixture> {
  const rows = await db.stockReceiptLine.findMany({
    where: { status: 'ACCEPTED', inventoryDetailId: { not: null } },
    include: {
      receipt: {
        select: {
          id: true,
          version: true,
          purchaseCommitmentId: true,
          supplierDeliveryReference: true,
        },
      },
      purchaseCommitmentLine: {
        include: {
          orderLine: { select: { id: true, quotationLineId: true } },
        },
      },
      inventoryDetail: {
        include: {
          inventoryItem: { select: { id: true, partNumber: true, trackingType: true, unitOfMeasure: true } },
        },
      },
      inventoryTransaction: {
        select: { id: true, quantity: true, beforeQuantity: true, afterQuantity: true },
      },
    },
    orderBy: [{ reviewedAt: 'desc' }, { id: 'desc' }],
  });
  const actor = await findAdminActor(db);
  for (const row of rows) {
    const detail = row.inventoryDetail;
    const inbound = row.inventoryTransaction;
    if (!detail || !inbound || detail.stockLotKey !== row.id || inbound.quantity !== row.quantity
      || inbound.beforeQuantity !== 0 || inbound.afterQuantity !== row.quantity) continue;
    const allocations = await db.inventoryAllocation.findMany({
      where: { stockReceiptLineId: row.id },
      select: {
        allocatedQuantity: true,
        releasedQuantity: true,
        consumedQuantity: true,
        assignments: { select: { assignedQuantity: true, releasedQuantity: true, consumedQuantity: true } },
      },
    });
    const used = allocations.reduce((sum, allocation) => sum + activeAllocationQuantity(allocation), 0);
    const canReleaseOne = allocations.some((allocation) => {
      const assigned = allocation.assignments.reduce((sum, item) => sum + item.assignedQuantity, 0);
      const releasedAssignments = allocation.assignments.reduce((sum, item) => sum + item.releasedQuantity, 0);
      const unassigned = allocation.allocatedQuantity - assigned - allocation.releasedQuantity + releasedAssignments;
      return unassigned > 0 || allocation.assignments.some((item) => activeAssignmentQuantity(item) > 0);
    });
    // A prior D12 fixture may have consumed the available physical projection.
    // It is still usable when one unconsumed source allocation can be released
    // below; consumed history itself is never released or deleted here.
    if (used > row.quantity || ((used >= row.quantity || detail.quantity - detail.allocatedQuantity < 1) && !canReleaseOne)) continue;
    const otherDetail = await db.inventoryDetail.findFirst({
      where: { id: { not: detail.id } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (!otherDetail) throw new Error('Accepted receipt fixture has no second inventory detail for source-move guard');
    return {
      receipt: row.receipt,
      receiptLine: {
        id: row.id,
        quantity: row.quantity,
        version: row.version,
        purchaseCommitmentLineId: row.purchaseCommitmentLineId,
        inventoryDetailId: detail.id,
        inventoryTransactionId: inbound.id,
        orderLineId: row.purchaseCommitmentLine.orderLine.id,
        quotationLineId: row.purchaseCommitmentLine.orderLine.quotationLineId,
        actor,
      },
      detail: {
        id: detail.id,
        quantity: detail.quantity,
        allocatedQuantity: detail.allocatedQuantity,
        status: detail.status,
        stockLotKey: detail.stockLotKey,
        inventoryItemId: detail.inventoryItemId,
        inventoryItem: detail.inventoryItem,
      },
      inbound,
      otherDetailId: otherDetail.id,
    };
  }
  throw new Error(
    'No accepted receipt line with an immutable source lot and one available unit was found; run checkStockReceipts first',
  );
}

async function assertFixtureUnchanged(db: PrismaClient, fixture: Fixture): Promise<void> {
  const [item, detail, line, inbound] = await Promise.all([
    db.inventoryItem.findUniqueOrThrow({ where: { id: fixture.detail.inventoryItemId }, select: { partNumber: true, trackingType: true, unitOfMeasure: true } }),
    db.inventoryDetail.findUniqueOrThrow({ where: { id: fixture.detail.id }, select: { quantity: true, allocatedQuantity: true, stockLotKey: true } }),
    db.stockReceiptLine.findUniqueOrThrow({ where: { id: fixture.receiptLine.id }, select: { quantity: true, inventoryDetailId: true, version: true } }),
    db.inventoryTransaction.findUniqueOrThrow({ where: { id: fixture.receiptLine.inventoryTransactionId }, select: { inventoryDetailId: true, quantity: true } }),
  ]);
  assert.deepEqual(item, {
    partNumber: fixture.detail.inventoryItem.partNumber,
    trackingType: fixture.detail.inventoryItem.trackingType,
    unitOfMeasure: fixture.detail.inventoryItem.unitOfMeasure,
  });
  assert.equal(detail.quantity, fixture.detail.quantity);
  assert.equal(detail.allocatedQuantity, fixture.detail.allocatedQuantity);
  assert.equal(detail.stockLotKey, fixture.detail.stockLotKey);
  assert.equal(line.quantity, fixture.receiptLine.quantity);
  assert.equal(line.inventoryDetailId, fixture.receiptLine.inventoryDetailId);
  assert.equal(line.version, fixture.receiptLine.version);
  assert.equal(inbound.inventoryDetailId, fixture.receiptLine.inventoryDetailId);
  assert.equal(inbound.quantity, fixture.receiptLine.quantity);
}

async function runNegativeGuards(db: PrismaClient, fixture: Fixture): Promise<Rejection[]> {
  const rejections: Rejection[] = [];
  const tag = randomUUID().replaceAll('-', '').slice(0, 10);

  rejections.push(await expectRejected('inventory item part number mutation', () => transact(db, async (tx) => {
    await tx.inventoryItem.update({
      where: { id: fixture.detail.inventoryItemId },
      data: { partNumber: `${fixture.detail.inventoryItem.partNumber}-GUARD-${tag}` },
    });
  })));
  rejections.push(await expectRejected('inventory item tracking type mutation', () => transact(db, async (tx) => {
    await tx.inventoryItem.update({
      where: { id: fixture.detail.inventoryItemId },
      data: { trackingType: fixture.detail.inventoryItem.trackingType === 'SERIAL' ? 'BATCH' : 'SERIAL' },
    });
  })));
  rejections.push(await expectRejected('inventory item unit of measure mutation', () => transact(db, async (tx) => {
    await tx.inventoryItem.update({
      where: { id: fixture.detail.inventoryItemId },
      data: { unitOfMeasure: fixture.detail.inventoryItem.unitOfMeasure === 'EA' ? 'KG' : 'EA' },
    });
  })));

  rejections.push(await expectRejected('manual receipt-owned quantity increase', () => transact(db, async (tx) => {
    await tx.inventoryDetail.update({
      where: { id: fixture.detail.id },
      data: { quantity: { increment: 1 } },
    });
  })));

  rejections.push(await expectRejected('unbound manual inbound', () => transact(db, async (tx) => {
    await tx.inventoryTransaction.create({
      data: {
        inventoryDetailId: fixture.detail.id,
        type: 'INBOUND',
        quantity: 1,
        beforeQuantity: fixture.detail.quantity,
        afterQuantity: fixture.detail.quantity + 1,
        referenceType: 'MANUAL',
        notes: `D14 guard negative ${tag}`,
        createdBy: fixture.receiptLine.actor.id,
      },
    });
  })));

  rejections.push(await expectRejected('move inbound to another detail', () => transact(db, async (tx) => {
    await tx.inventoryTransaction.update({
      where: { id: fixture.receiptLine.inventoryTransactionId },
      data: { inventoryDetailId: fixture.otherDetailId },
    });
  })));

  rejections.push(await expectRejected('receipt line quantity mutation', () => transact(db, async (tx) => {
    await tx.stockReceiptLine.update({
      where: { id: fixture.receiptLine.id },
      data: { quantity: { increment: 1 }, version: { increment: 1 } },
    });
  })));

  rejections.push(await expectRejected('receipt header delivery reference mutation', () => transact(db, async (tx) => {
    await tx.stockReceipt.update({
      where: { id: fixture.receipt.id },
      data: {
        supplierDeliveryReference: `${fixture.receipt.supplierDeliveryReference}-MUTATED-${tag}`,
        version: { increment: 1 },
      },
    });
  })));

  const wrongSourceLine = await db.stockReceiptLine.findFirst({
    // Any different receipt line is a wrong source for this physical detail;
    // pending/rejected lines are useful negative fixtures because they must
    // fail closed before they can become an allocation source.
    where: { id: { not: fixture.receiptLine.id } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const wrongSourceLineId = wrongSourceLine?.id ?? fixture.receiptLine.id;
  const wrongSourceDetailId = wrongSourceLine ? fixture.detail.id : fixture.otherDetailId;

  rejections.push(await expectRejected('receipt-owned allocation with both sources absent', () => transact(db, async (tx) => {
    const allocation = await tx.inventoryAllocation.create({
      data: {
        quotationLineId: fixture.receiptLine.quotationLineId,
        inventoryDetailId: fixture.detail.id,
        allocatedQuantity: 1,
        commandId: `d14-guard-double-null-${tag}`,
        commandLineNo: 1,
        createdById: fixture.receiptLine.actor.id,
      },
    });
    await tx.$queryRaw(Prisma.sql`SELECT assert_inventory_allocation_source(${allocation.id})`);
  })));

  rejections.push(await expectRejected('receipt-owned allocation with wrong receipt source', () => transact(db, async (tx) => {
    const allocation = await tx.inventoryAllocation.create({
      data: {
        quotationLineId: fixture.receiptLine.quotationLineId,
        inventoryDetailId: wrongSourceDetailId,
        stockReceiptLineId: wrongSourceLineId,
        allocatedQuantity: 1,
        commandId: `d14-guard-wrong-source-${tag}`,
        commandLineNo: 1,
        createdById: fixture.receiptLine.actor.id,
      },
    });
    await tx.$queryRaw(Prisma.sql`SELECT assert_inventory_allocation_source(${allocation.id})`);
  })));

  await assertFixtureUnchanged(db, fixture);
  return rejections;
}

async function releaseActiveSourceUnit(db: PrismaClient, fixture: Fixture): Promise<{ released: boolean; allocationId?: string }> {
  const allocations = await db.inventoryAllocation.findMany({
    where: { stockReceiptLineId: fixture.receiptLine.id },
    include: { assignments: { orderBy: { id: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  const parent = allocations.find((allocation) => {
    const assigned = allocation.assignments.reduce((sum, item) => sum + item.assignedQuantity, 0);
    const releasedAssignments = allocation.assignments.reduce((sum, item) => sum + item.releasedQuantity, 0);
    const unassigned = allocation.allocatedQuantity - assigned - allocation.releasedQuantity + releasedAssignments;
    return unassigned > 0 || allocation.assignments.some((item) => activeAssignmentQuantity(item) > 0);
  });
  if (!parent) return { released: false };
  const assignment = parent.assignments.find((item) => activeAssignmentQuantity(item) > 0);
  await transact(db, (tx) => releaseLineInventory({
    tx,
    actor: fixture.receiptLine.actor,
    allocationId: parent.id,
    ...(assignment ? { assignmentId: assignment.id } : {}),
    quantity: 1,
    reason: 'D14 database guard race fixture release',
    commandId: `d14-guard-release-${randomUUID()}`,
  }));
  return { released: true, allocationId: parent.id };
}

async function runRace(
  db: PrismaClient,
  fixture: Fixture,
  isolationLevel: Prisma.TransactionIsolationLevel,
  label: string,
): Promise<{ label: string; successes: number; errors: string[]; winnerAllocationIds: string[] }> {
  const left = new PrismaClient();
  const right = new PrismaClient();
  const commands = [`d14-guard-race-${label}-${randomUUID()}`, `d14-guard-race-${label}-${randomUUID()}`];
  const attempt = (client: PrismaClient, commandId: string) => transact(client, (tx) => reserveLineInventory({
    tx,
    actor: fixture.receiptLine.actor,
    quotationLineId: fixture.receiptLine.quotationLineId,
    orderLineId: fixture.receiptLine.orderLineId,
    allocations: [{ inventoryDetailId: fixture.detail.id, quantity: 1, stockReceiptLineId: fixture.receiptLine.id }],
    commandId,
  }), isolationLevel);
  let results: PromiseSettledResult<unknown>[];
  try {
    results = await Promise.allSettled([attempt(left, commands[0]), attempt(right, commands[1])]);
  } finally {
    await Promise.allSettled([left.$disconnect(), right.$disconnect()]);
  }
  const winnerAllocationIds = (await db.inventoryAllocation.findMany({
    where: { commandId: { in: commands } },
    select: { id: true, commandId: true },
  })).map((row) => row.id);
  const successes = results.filter((result) => result.status === 'fulfilled').length;
  assert.equal(successes, 1, `${label} source-pool race expected exactly one committed reserve`);
  assert.equal(winnerAllocationIds.length, 1, `${label} source-pool race persisted an unexpected winner count`);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => String(errorRecord(result.reason).message ?? result.reason));
  try {
    const winner = await db.inventoryAllocation.findUniqueOrThrow({
      where: { id: winnerAllocationIds[0] },
      include: { assignments: { orderBy: { id: 'asc' } } },
    });
    const assignment = winner.assignments.find((item) => activeAssignmentQuantity(item) > 0);
    await transact(db, (tx) => releaseLineInventory({
      tx,
      actor: fixture.receiptLine.actor,
      allocationId: winner.id,
      ...(assignment ? { assignmentId: assignment.id } : {}),
      quantity: 1,
      reason: `D14 database guard ${label} winner cleanup`,
      commandId: `d14-guard-cleanup-${label}-${randomUUID()}`,
    }));
  } finally {
    // The winner remains as immutable allocation/release history; only its
    // active quantity is released so the next isolation run has one unit.
  }
  return { label, successes, errors, winnerAllocationIds };
}

async function main() {
  const db = new PrismaClient();
  try {
    const fixture = await findFixture(db);
    const negative = await runNegativeGuards(db, fixture);
    const releasedFixture = await releaseActiveSourceUnit(db, fixture);
    const beforeRaceDetail = await db.inventoryDetail.findUniqueOrThrow({
      where: { id: fixture.detail.id },
      select: { quantity: true, allocatedQuantity: true, status: true },
    });
    assert.equal(beforeRaceDetail.status, 'AVAILABLE');
    assert.ok(beforeRaceDetail.quantity - beforeRaceDetail.allocatedQuantity >= 1);
    const readCommitted = await runRace(db, fixture, 'ReadCommitted', 'read-committed');
    const serializable = await runRace(db, fixture, 'Serializable', 'serializable');
    const afterRaceDetail = await db.inventoryDetail.findUniqueOrThrow({
      where: { id: fixture.detail.id },
      select: { quantity: true, allocatedQuantity: true },
    });
    assert.equal(afterRaceDetail.quantity, beforeRaceDetail.quantity);
    assert.equal(afterRaceDetail.allocatedQuantity, beforeRaceDetail.allocatedQuantity);
    console.log(JSON.stringify({
      result: 'PASS',
      database: expectedDatabase,
      fixture: {
        receiptLineId: fixture.receiptLine.id,
        inventoryDetailId: fixture.detail.id,
        stockLotKey: fixture.detail.stockLotKey,
        inboundTransactionId: fixture.receiptLine.inventoryTransactionId,
      },
      checks: [
        'receipt-owned inventory item PN/tracking/UOM mutations rejected',
        'manual quantity increase and unbound INBOUND rejected',
        'receipt inbound cannot be moved to another inventory detail',
        'receipt header/line immutable facts rejected on mutation',
        'receipt-owned allocation cannot omit or change its source',
        'read committed and serializable same-source races commit at most one reserve',
        'race winners are released with immutable history retained',
      ],
      negativeRejections: negative,
      fixtureRelease: releasedFixture,
      concurrency: { readCommitted, serializable },
    }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

await main();
