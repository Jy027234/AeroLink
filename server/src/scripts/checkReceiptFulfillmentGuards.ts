import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Database-only negative evidence for migration 010.
 *
 * The script is deliberately opt-in and clone-bound. Every write is made in
 * a transaction that must fail at SET CONSTRAINTS and is then rolled back.
 * It proves that a receipt allocation cannot omit its origin assignment and
 * that an OUTBOUND cannot advance a consumed counter-free allocation.
 */
const expectedDatabase = 'aerolink_procurement_test_receipts_20260909';
const expectedPort = '55970';
const preferredPurchaseCommitmentId = 'ff2c589d-1831-4502-b2cb-2c52ba4f18ee';

const databaseUrlValue = process.env.DATABASE_URL;
if (process.env.AEROLINK_RECEIPT_FULFILLMENT_GUARDS !== 'true' || !databaseUrlValue) {
  throw new Error(
    `Explicit AEROLINK_RECEIPT_FULFILLMENT_GUARDS=true and ${expectedDatabase} DATABASE_URL are required`,
  );
}
const databaseUrl = new URL(databaseUrlValue);
if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.port !== expectedPort
  || databaseUrl.pathname !== `/${expectedDatabase}`) {
  throw new Error(`Refusing non-local/non-${expectedDatabase} DATABASE_URL`);
}

type Tx = Prisma.TransactionClient;
type Fixture = {
  receiptLineId: string;
  detailId: string;
  quotationLineId: string;
  orderLineId: string;
  orderId: string;
  actorId: string;
  quantity: number;
  allocatedQuantity: number;
};

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

async function expectRejected(label: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return { label, message: messageOf(error) };
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function inSerializableTransaction<T>(db: PrismaClient, run: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    const result = await run(tx);
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return result;
  }, { isolationLevel: 'Serializable', timeout: 60_000, maxWait: 10_000 });
}

async function findFixture(db: PrismaClient): Promise<Fixture> {
  const rows = await db.stockReceiptLine.findMany({
    where: { status: 'ACCEPTED', inventoryDetailId: { not: null } },
    include: {
      purchaseCommitmentLine: {
        select: {
          purchaseCommitmentId: true,
          orderLineId: true,
          orderLine: { select: { id: true, quotationLineId: true, orderId: true } },
        },
      },
      inventoryDetail: { select: { id: true, quantity: true, allocatedQuantity: true, stockLotKey: true } },
    },
    orderBy: [{ reviewedAt: 'desc' }, { id: 'desc' }],
  });
  const actor = await db.user.findFirst({
    where: { role: { in: ['ADMIN', 'GM'] } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!actor) throw new Error('No ADMIN/GM actor exists in the dedicated receipt database');

  for (const row of rows) {
    const detail = row.inventoryDetail;
    const orderLine = row.purchaseCommitmentLine.orderLine;
    if (row.purchaseCommitmentLine.purchaseCommitmentId !== preferredPurchaseCommitmentId
      || !detail || !orderLine || detail.stockLotKey !== row.id
      || detail.quantity - detail.allocatedQuantity < 1) continue;
    const allocationCount = await db.inventoryAllocation.count({ where: { inventoryDetailId: detail.id } });
    // The negative OUTBOUND needs one untouched unit so its setup cannot
    // borrow or alter another agent's active allocation.
    if (allocationCount !== 0) continue;
    return {
      receiptLineId: row.id,
      detailId: detail.id,
      quotationLineId: orderLine.quotationLineId,
      orderLineId: orderLine.id,
      orderId: orderLine.orderId,
      actorId: actor.id,
      quantity: detail.quantity,
      allocatedQuantity: detail.allocatedQuantity,
    };
  }
  throw new Error(`No untouched ACCEPTED receipt unit exists for purchase ${preferredPurchaseCommitmentId}`);
}

async function assertFixtureUnchanged(db: PrismaClient, fixture: Fixture): Promise<void> {
  const detail = await db.inventoryDetail.findUniqueOrThrow({
    where: { id: fixture.detailId },
    select: { quantity: true, allocatedQuantity: true, stockLotKey: true },
  });
  assert.deepEqual(detail, {
    quantity: fixture.quantity,
    allocatedQuantity: fixture.allocatedQuantity,
    stockLotKey: fixture.receiptLineId,
  });
  const [allocationCount, outboundCount, reviewCount] = await Promise.all([
    db.inventoryAllocation.count({ where: { commandId: { startsWith: 'd14-v10-' } } }),
    db.inventoryTransaction.count({ where: { id: { startsWith: 'd14-v10-' } } }),
    db.fulfillmentReview.count({ where: { id: { startsWith: 'd14-v10-' } } }),
  ]);
  assert.equal(allocationCount, 0);
  assert.equal(outboundCount, 0);
  assert.equal(reviewCount, 0);
}

async function run(): Promise<void> {
  const db = new PrismaClient();
  try {
    const fixture = await findFixture(db);
    const tag = randomUUID().replaceAll('-', '');
    const noAssignmentId = `d14-v10-no-assignment-${tag}`;
    const noAssignmentCommand = `d14-v10-no-assignment-command-${tag}`;
    const parentId = `d14-v10-parent-${tag}`;
    const assignmentId = `d14-v10-assignment-${tag}`;
    const reviewId = `d14-v10-review-${tag}`;
    const outboundId = `d14-v10-outbound-${tag}`;

    const noAssignment = await expectRejected('receipt allocation without origin assignment', () =>
      inSerializableTransaction(db, async tx => {
        const incremented = await tx.$executeRaw(Prisma.sql`
          UPDATE "inventory_details"
          SET "allocatedQuantity" = "allocatedQuantity" + 1, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${fixture.detailId}
            AND "quantity" - "allocatedQuantity" >= 1
        `);
        assert.equal(incremented, 1);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "inventory_allocations"
            ("id", "quotationLineId", "inventoryDetailId", "allocatedQuantity", "commandId", "commandLineNo", "createdById", "updatedAt", "stockReceiptLineId")
          VALUES
            (${noAssignmentId}, ${fixture.quotationLineId}, ${fixture.detailId}, 1, ${noAssignmentCommand}, 1, ${fixture.actorId}, CURRENT_TIMESTAMP, ${fixture.receiptLineId})
        `);
        return undefined;
      }));

    const consumedMismatch = await expectRejected('receipt OUTBOUND without consumed counters', () =>
      inSerializableTransaction(db, async tx => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "inventory_details"
          SET "allocatedQuantity" = "allocatedQuantity" + 1, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${fixture.detailId}
            AND "quantity" - "allocatedQuantity" >= 1
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "inventory_allocations"
            ("id", "quotationLineId", "inventoryDetailId", "allocatedQuantity", "commandId", "commandLineNo", "createdById", "updatedAt", "stockReceiptLineId")
          VALUES
            (${parentId}, ${fixture.quotationLineId}, ${fixture.detailId}, 1, ${`${parentId}-command`}, 1, ${fixture.actorId}, CURRENT_TIMESTAMP, ${fixture.receiptLineId})
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "allocation_assignments"
            ("id", "allocationId", "orderLineId", "assignedQuantity", "commandId", "commandLineNo", "createdById", "updatedAt")
          VALUES
            (${assignmentId}, ${parentId}, ${fixture.orderLineId}, 1, ${`${assignmentId}-command`}, 1, ${fixture.actorId}, CURRENT_TIMESTAMP)
        `);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "inventory_allocations"
          SET "releasedQuantity" = 1, "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${parentId}
        `);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "allocation_assignments"
          SET "releasedQuantity" = 1, "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${assignmentId}
        `);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "inventory_details"
          SET "quantity" = "quantity" - 1, "allocatedQuantity" = "allocatedQuantity" - 1, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${fixture.detailId}
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "fulfillment_reviews"
            ("id", "orderId", "inventoryDetailId", "quantity", "approved", "snapshotHash", "snapshot", "evidence", "checks", "reason", "reviewedById", "consumedAt", "assignmentId")
          VALUES
            (${reviewId}, ${fixture.orderId}, ${fixture.detailId}, 1, true, ${`d14-v10-hash-${tag}`}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'D14 migration negative proof', ${fixture.actorId}, CURRENT_TIMESTAMP, ${assignmentId})
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "inventory_transactions"
            ("id", "inventoryDetailId", "type", "quantity", "beforeQuantity", "afterQuantity", "orderId", "createdBy", "allocationId", "assignmentId", "fulfillmentReviewId")
          VALUES
            (${outboundId}, ${fixture.detailId}, 'OUTBOUND', -1, ${fixture.quantity}, ${fixture.quantity - 1}, ${fixture.orderId}, ${fixture.actorId}, ${parentId}, ${assignmentId}, ${reviewId})
        `);
        return undefined;
      }));

    await assertFixtureUnchanged(db, fixture);
    console.log(JSON.stringify({
      passed: true,
      fixture: { receiptLineId: fixture.receiptLineId, detailId: fixture.detailId },
      rejected: [noAssignment, consumedMismatch],
      rolledBack: true,
    }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

await run();
