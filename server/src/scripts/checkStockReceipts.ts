import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { CapabilityActor } from '../lib/capabilityPolicy.js';
import { captureQuotationLineCost, buildCommercialApprovalSnapshot } from '../lib/lineQuotationPolicy.js';
import { buildQuotationApprovalSnapshot, QUOTATION_APPROVAL_POLICY_VERSION } from '../lib/quotationApprovalPolicy.js';
import { reserveLineInventory } from '../modules/inventoryQuality/allocationService.js';
import { deriveReceiptQuantities } from '../modules/procurementSettlement/receiptQuantities.js';
import {
  getStockReceiptReviewContext,
  receivePurchaseStock,
  reviewPurchaseStock,
  type StockReceiptArrivalInput,
} from '../modules/procurementSettlement/stockReceiptCommands.js';

/**
 * Synthetic local-only D14 stock-receipt integration evidence.
 *
 * The database is deliberately pinned to the disposable clone named below.
 * This script never starts Express, Socket.IO, the worker, object storage, or
 * sends mail. StoredObject rows are metadata-only synthetic evidence; no file
 * bytes are read or written.
 */
const expectedDatabase = 'aerolink_procurement_test_receipts_20260909';
const expectedPort = '55970';
const databaseUrlValue = process.env.DATABASE_URL;
if (process.env.AEROLINK_STOCK_RECEIPTS_INTEGRATION !== 'true' || !databaseUrlValue) {
  throw new Error(`Explicit AEROLINK_STOCK_RECEIPTS_INTEGRATION=true and ${expectedDatabase} DATABASE_URL are required`);
}
const databaseUrl = new URL(databaseUrlValue);
if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.port !== expectedPort
  || databaseUrl.pathname !== `/${expectedDatabase}`) {
  throw new Error(`Refusing non-local/non-${expectedDatabase} DATABASE_URL`);
}

const db = new PrismaClient();
const transact = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async (tx) => {
  const result = await run(tx);
  // PostgreSQL deferred guards must be checked before Prisma resolves the
  // interactive transaction callback (Prisma 5 can otherwise hide COMMIT
  // trigger failures).
  await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  return result;
}, { isolationLevel: 'Serializable', timeout: 60_000 });

type ActorRow = { id: string; role: string; department: string | null };
type ErrorLike = { code?: unknown; statusCode?: unknown; message?: unknown };
type RejectionRecord = { label: string; code?: unknown; statusCode?: unknown; message?: unknown };

function actor(user: ActorRow): CapabilityActor {
  return { id: user.id, role: user.role, department: user.department };
}

function describeError(error: unknown): Record<string, unknown> {
  if (error && typeof error === 'object') {
    const value = error as ErrorLike;
    return {
      code: value.code,
      statusCode: value.statusCode,
      message: typeof value.message === 'string' ? value.message : String(error),
    };
  }
  return { message: String(error) };
}

async function expectRejected(label: string, run: () => Promise<unknown>): Promise<RejectionRecord> {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${label} unexpectedly succeeded`);
  return { label, ...describeError(error) };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} is not an object`);
  return value as Record<string, unknown>;
}

function id(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} is not a string`);
  assert.ok((value as string).trim(), `${label} is empty`);
  return value as string;
}

function text(value: unknown, label: string): string {
  return id(value, label).trim();
}

async function createSyntheticEvidence(ownerId: string, tag: string, purpose: string) {
  const content = `${tag}:${purpose}`;
  return db.storedObject.create({
    data: {
      objectKey: `synthetic/d14-receipt/${tag}/${purpose}.pdf`,
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length,
      mimeType: 'application/pdf',
      originalName: `synthetic-${purpose}.pdf`,
      ownerId,
      status: 'AVAILABLE',
      metadata: { synthetic: true, tag, purpose },
    },
  });
}

/**
 * The receipt database is cloned from the procurement-command database. That
 * command fixture intentionally stops at a valid purchase commitment, while
 * receipt quality also requires the preceding D12 commercial facts. Prepare
 * only the disposable D14-CMD fixture here; never broaden this repair to
 * arbitrary production-looking rows.
 */
async function prepareSyntheticCommercialFixture(tag: string) {
  const prepared = await transact(async (tx) => {
    const candidates = await tx.purchaseCommitment.findMany({
      where: {
        status: 'CONFIRMED',
        order: { outboundQuantity: 0, quotation: { rfq: { rfqNumber: { startsWith: 'D14-CMD-RFQ-' } } } },
        lines: {
          some: {
            quantity: 2,
            directShippedQuantity: 0,
          },
        },
      },
      include: {
        order: {
          include: {
            quotation: { include: { rfq: true, lines: { include: { rfqLine: true } } } },
          },
        },
        lines: {
          include: {
            stockReceiptLines: { select: { id: true } },
            orderLine: { include: { quotationLine: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (candidates.length === 0) {
      throw new Error('No disposable D14-CMD confirmed purchase without receipt facts was found');
    }
    const finance = await tx.user.create({
      data: {
        email: `d14-receipt-finance-${tag}@example.invalid`,
        name: `D14 synthetic finance receipt fixture ${tag}`,
        password: 'synthetic-only',
        role: 'FINANCE',
        department: 'Finance',
      },
      select: { id: true, role: true, department: true },
    });
    const results: Array<Record<string, unknown>> = [];
    for (const purchase of candidates) {
      const purchaseLine = purchase.lines.find((line) => line.quantity === 2 && line.orderLine.quantity === 2);
      if (!purchaseLine) continue;
      const quotation = purchase.order.quotation;
      const quotationLine = quotation.lines.find((line) => line.id === purchaseLine.orderLine.quotationLineId);
      if (!quotationLine || !quotationLine.rfqLine) continue;
      const rfq = quotation.rfq;
      const rfqLine = quotationLine.rfqLine;
      const manualCostReason = `Synthetic D14 manual cost evidence for receipt fixture ${tag}`;
      const capturedCost = await captureQuotationLineCost({
        tx,
        rfqId: rfq.id,
        rfqLine,
        quotationId: quotation.id,
        input: {
          partNumber: quotationLine.partNumber,
          quantity: quotationLine.quantity,
          costPrice: quotationLine.costPrice.toNumber(),
          currency: 'USD',
          costSourceType: 'MANUAL',
          costSourceReason: manualCostReason,
        },
      });
      await tx.rFQ.update({ where: { id: rfq.id }, data: { lineItemsMode: true, certificateRequired: false, certificateType: null } });
      await tx.rfqLine.update({ where: { id: rfqLine.id }, data: { certificateRequired: false, certificateType: null } });
      await tx.order.update({ where: { id: purchase.order.id }, data: { certificateRequired: false, certificateType: null, inspectionRequired: false } });
      await tx.quotation.update({
        where: { id: quotation.id },
        data: {
          costSourceType: capturedCost.costSourceType,
          costSourceId: capturedCost.costSourceId,
          costSourceReason: capturedCost.costSourceReason,
          costSourceSnapshotJson: capturedCost.costSourceSnapshotJson,
          costSourceCapturedAt: capturedCost.costSourceCapturedAt,
          status: 'ACCEPTED',
          statusEnum: 'ACCEPTED',
          approvedBy: finance.id,
          approvedAt: new Date(),
          acceptedAt: new Date(),
          orderId: purchase.order.id,
          orderNumber: purchase.order.orderNumber,
        },
      });
      await tx.quotationLine.update({
        where: { id: quotationLine.id },
        data: {
          costSourceType: capturedCost.costSourceType,
          costSourceId: capturedCost.costSourceId,
          costSourceReason: capturedCost.costSourceReason,
          costSourceSnapshotJson: capturedCost.costSourceSnapshotJson,
          costSourceCapturedAt: capturedCost.costSourceCapturedAt,
          acceptedQuantity: quotationLine.quantity,
          status: 'ACCEPTED',
        },
      });
      const current = await tx.quotation.findUniqueOrThrow({
        where: { id: quotation.id },
        include: { lines: true, rfq: true },
      });
      const snapshot = buildCommercialApprovalSnapshot({
        headerTerms: buildQuotationApprovalSnapshot(current),
        lines: current.lines,
      });
      // Preparation recaptures the synthetic cost source, so append an approval
      // for these exact current terms instead of reusing an older decision.
      const approval = await tx.approval.create({
        data: {
          quotationId: current.id,
          level: 'FINANCE',
          requiredLevel: 'FINANCE',
          policyVersion: `${QUOTATION_APPROVAL_POLICY_VERSION}-lines-v1`,
          reviewedVersion: current.version,
          snapshotJson: JSON.stringify(snapshot),
          approverId: finance.id,
          action: 'APPROVE',
          comment: 'Synthetic-only independent FINANCE approval for D14 receipt integration',
        },
        select: { id: true },
      });
      results.push({
        rfqId: rfq.id,
        rfqNumber: rfq.rfqNumber,
        quotationId: current.id,
        quotationLineId: quotationLine.id,
        orderId: purchase.order.id,
        orderLineId: purchaseLine.orderLineId,
        purchaseCommitmentId: purchase.id,
        purchaseCommitmentLineId: purchaseLine.id,
        quotationApprovalId: approval.id,
        financeApproverId: finance.id,
        acceptedQuantity: quotationLine.quantity,
        certificateRequired: false,
        costSourceType: 'MANUAL',
      });
    }
    if (results.length === 0) throw new Error('D14-CMD purchase rows lacked a quantity-2 quotation/RFQ line');
    return results;
  });
  return prepared;
}

async function findFixture() {
  const candidates = await db.purchaseCommitment.findMany({
    where: {
      status: 'CONFIRMED',
      order: { orderNumber: { startsWith: 'D14-CMD-ORDER-' } },
      lines: { some: { quantity: 2, receivedQuantity: 0, directShippedQuantity: 0 } },
    },
    include: {
      createdBy: { select: { id: true, role: true, department: true } },
      confirmedBy: { select: { id: true, role: true, department: true } },
      order: {
        select: {
          id: true,
          lineItemsMode: true,
          status: true,
          quotation: { select: { rfq: { select: { lineItemsMode: true } } } },
        },
      },
      lines: {
        include: {
          stockReceiptLines: { select: { id: true, status: true, receiptId: true, quantity: true } },
          orderLine: { include: { quotationLine: { include: { rfqLine: true } } } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const fixture = candidates.find((purchase) => purchase.lines.some((line) => (
    line.quantity === 2
    && line.receivedQuantity === 0
    && line.cancelledQuantity === 0
    && line.directShippedQuantity === 0
    && line.orderLine.quantity === 2
    && line.orderLine.orderId === purchase.orderId
    && purchase.order.lineItemsMode === true
    && purchase.order.quotation.rfq.lineItemsMode === true
    && (line.stockReceiptLines.length === 0 || (line.stockReceiptLines.length === 2
      && line.stockReceiptLines.every(row => row.status === 'PENDING_REVIEW' && row.quantity === 1)
      && new Set(line.stockReceiptLines.map(row => row.receiptId)).size === 1))
  )));
  if (!fixture) throw new Error('No unreceived CONFIRMED quantity-2 purchase fixture with modern order, quotation, and RFQ flags was found');
  const line = fixture.lines.find((candidate) => candidate.quantity === 2 && candidate.orderLine.quantity === 2);
  assert.ok(line, 'selected purchase has no usable quantity-2 line');
  return { purchase: fixture, line };
}

function sourceIdentity(line: {
  identitySnapshot: Prisma.JsonValue;
  partNumber: string;
  uom: string;
  orderLine: { quotationLine: { rfqLine: { conditionCode: string; serialNumber: string | null; batchNumber: string | null } | null } };
}) {
  const identity = asRecord(line.identitySnapshot, 'purchase identitySnapshot');
  const rfqLine = line.orderLine.quotationLine.rfqLine;
  assert.ok(rfqLine, 'purchase fixture has no RFQ line');
  return {
    partNumber: text(line.partNumber, 'part number'),
    uom: text(line.uom, 'uom'),
    conditionCode: text(identity.conditionCode ?? rfqLine.conditionCode, 'condition code'),
    serialNumber: typeof identity.serialNumber === 'string' ? identity.serialNumber : rfqLine.serialNumber,
    batchNumber: typeof identity.batchNumber === 'string' ? identity.batchNumber : rfqLine.batchNumber,
    trackingType: typeof identity.trackingType === 'string' ? identity.trackingType.toUpperCase() : undefined,
  };
}

function physicalFor(
  identity: ReturnType<typeof sourceIdentity>,
  tag: string,
  quantity = 1,
  trackingTypeOverride?: string,
  batchOverride?: string,
) {
  const trackingType = trackingTypeOverride?.toUpperCase() === 'SERIAL'
    || (!trackingTypeOverride && (identity.trackingType === 'SERIAL' || identity.serialNumber))
    ? 'SERIAL'
    : 'BATCH';
  return {
    partNumber: identity.partNumber,
    uom: identity.uom,
    trackingType,
    quantity,
    serialNumber: trackingType === 'SERIAL' ? (identity.serialNumber || `S-${tag}`) : null,
    batchNumber: trackingType === 'BATCH' ? (batchOverride || identity.batchNumber || `B-${tag}`) : null,
    conditionCode: identity.conditionCode,
    certificateReferences: [],
    certificateType: null,
    certificateNumber: null,
    lifeLimited: false,
    remainingHours: null,
    remainingCycles: null,
    shelfLifeDate: null,
    shelfLifeDays: null,
    nextOverhaulDue: null,
    storageCondition: null,
  };
}

function storageFor(tag: string) {
  return { location: `RECEIVING-${tag}`, warehouse: 'SYNTHETIC-WH', shelf: `SHELF-${tag}` };
}

function checks() {
  return { identity: true, documents: true, conditionAndLife: true, customerRequirements: true };
}

async function loadReceipt(receiptId: string) {
  return db.stockReceipt.findUniqueOrThrow({
    where: { id: receiptId },
    include: {
      lines: { orderBy: { lineNo: 'asc' }, include: { inventoryDetail: true, inventoryTransaction: true } },
    },
  });
}

async function currentPurchase(purchaseId: string) {
  return db.purchaseCommitment.findUniqueOrThrow({ where: { id: purchaseId }, include: { lines: true } });
}

async function main() {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  const fixturePreparation = process.env.AEROLINK_STOCK_RECEIPTS_RESUME === 'true'
    ? { resumedPreviouslyPreparedSyntheticFixture: true } : await prepareSyntheticCommercialFixture(tag);
  if (process.env.AEROLINK_STOCK_RECEIPTS_PREPARE_ONLY === 'true') {
    console.log(JSON.stringify({
      result: 'FIXTURE_PREPARED',
      database: expectedDatabase,
      tag,
      syntheticFixturePreparation: fixturePreparation,
    }, null, 2));
    return;
  }
  const fixture = await findFixture();
  const purchase = fixture.purchase;
  const purchaseLine = fixture.line;
  // Resume an earlier interrupted synthetic run without deleting custody history.
  const resumedReceipt = purchaseLine.stockReceiptLines.length ? await loadReceipt(purchaseLine.stockReceiptLines[0]!.receiptId) : null;
  const identity = sourceIdentity(purchaseLine);
  // The confirmed purchase fixture may intentionally predate its first
  // inventory receipt and therefore have no InventoryItem row yet. The
  // server creates that master from the reviewed physical facts. This run is
  // deliberately batch-tracked so two same-batch arrivals can prove that
  // receipt-line stockLotKey keeps their InventoryDetail rows distinct.
  const trackingType = identity.trackingType || 'BATCH';
  assert.equal(trackingType, 'BATCH', 'this synthetic receipt run requires a batch-tracked fixture');
  const sameBatch = identity.batchNumber || `B-${tag}-SAME`;
  assert.equal(purchase.status, 'CONFIRMED');
  assert.equal(purchaseLine.quantity, 2);
  assert.equal(purchaseLine.receivedQuantity, 0);
  assert.equal(purchaseLine.directShippedQuantity, 0);

  const buyerRow = purchase.createdBy as ActorRow;
  const buyer = actor(buyerRow);
  const order = await db.order.findUniqueOrThrow({
    where: { id: purchase.orderId },
    select: { id: true, lineItemsMode: true, status: true, quotation: { select: { createdBy: true, creator: { select: { department: true } } } } },
  });
  assert.equal(order.lineItemsMode, true);
  assert.ok(['SO_CREATED', 'PO_CREATED'].includes(order.status), `fixture order status ${order.status} cannot receive`);
  const qualityRow = await db.user.create({
    data: {
      email: `d14-receipt-quality-${tag}@example.invalid`,
      name: `D14 synthetic quality ${tag}`,
      password: 'synthetic-only',
      role: 'QUALITY_MANAGER',
      department: order.quotation.creator.department || buyerRow.department || 'Quality',
    },
    select: { id: true, role: true, department: true },
  });
  const quality = actor(qualityRow);
  const receiverEvidence = await createSyntheticEvidence(buyer.id, tag, 'arrival-proof-1');
  const replacementEvidence = await createSyntheticEvidence(buyer.id, tag, 'arrival-proof-2');
  const overarrivalEvidence = await createSyntheticEvidence(buyer.id, tag, 'arrival-proof-over');

  const firstArrival: StockReceiptArrivalInput = {
    purchaseCommitmentId: purchase.id,
    purchaseVersion: purchase.version,
    supplierDeliveryReference: `D14-DELIVERY-${tag}-1`,
    reason: 'Synthetic supplier arrival, segregated pending independent QC',
    evidenceIds: [receiverEvidence.id],
    lines: [
      { purchaseCommitmentLineId: purchaseLine.id, physical: physicalFor(identity, `${tag}-A`, 1, trackingType, sameBatch), storage: storageFor(`${tag}-A`) },
      { purchaseCommitmentLineId: purchaseLine.id, physical: physicalFor(identity, `${tag}-B`, 1, trackingType, sameBatch), storage: storageFor(`${tag}-B`) },
    ],
  };
  if (resumedReceipt) {
    for (const reference of resumedReceipt.evidence as Array<{ id: string }>) {
      // Only restore this script's metadata-only proof after its interrupted revocation test.
      await db.storedObject.updateMany({ where: { id: reference.id, ownerId: buyer.id, status: 'REVOKED',
        originalName: { startsWith: 'synthetic-' } }, data: { status: 'AVAILABLE' } });
    }
  }
  const receiveResult = resumedReceipt ? { id: resumedReceipt.id }
    : await transact((tx) => receivePurchaseStock({ tx, actor: buyer, commandId: `d14-receive-${tag}-1`, ...firstArrival }));
  const firstReceipt = await loadReceipt(receiveResult.id);
  assert.equal(firstReceipt.lines.length, 2);
  assert.ok(firstReceipt.lines.every((line) => line.status === 'PENDING_REVIEW' && line.inventoryDetailId === null && line.inventoryTransaction === null));
  assert.ok(firstReceipt.lines[0]!.identitySnapshot);
  assert.ok(firstReceipt.lines[0]!.qualitySnapshot);
  assert.ok(firstReceipt.lines.every((line) => Array.isArray(line.evidence) && line.evidence.length === 1));
  assert.equal((await currentPurchase(purchase.id)).lines.find((line) => line.id === purchaseLine.id)?.receivedQuantity, 0);
  const inboundBeforeAccept = await db.inventoryTransaction.count({ where: { stockReceiptLineId: { not: null } } });

  const lineA = firstReceipt.lines[0]!;
  const lineB = firstReceipt.lines[1]!;
  const contextA = await transact((tx) => getStockReceiptReviewContext({ tx, actor: quality, receiptLineId: lineA.id }));
  const contextB = await transact((tx) => getStockReceiptReviewContext({ tx, actor: quality, receiptLineId: lineB.id }));
  assert.equal(contextA.status, 'PENDING_REVIEW');
  assert.equal(contextB.status, 'PENDING_REVIEW');

  // A quality-capable actor with the arrival owner's identity is rejected by
  // the independent-review guard before any purchase/version write.
  const selfReview = await expectRejected('self review', () => transact((tx) => reviewPurchaseStock({
    tx, actor: { ...quality, id: buyer.id }, commandId: `d14-self-review-${tag}`,
    receiptLineId: lineA.id, version: contextA.version, snapshotHash: contextA.snapshotHash,
    decision: 'ACCEPTED', reason: 'Synthetic self-review must fail', checks: checks(),
  })));
  assert.equal(selfReview.code, 'SELF_APPROVAL_FORBIDDEN');
  assert.equal((await loadReceipt(firstReceipt.id)).lines.find((line) => line.id === lineA.id)?.status, 'PENDING_REVIEW');

  // Change a current order requirement after the reviewer captured context.
  // ReceiptLine.qualitySnapshot is immutable arrival evidence, so the test
  // must not mutate it. inspectionRequired is a live requirement included in
  // the rebuilt quality snapshot and therefore exercises the real stale path.
  const orderBeforeStale = await db.order.findUniqueOrThrow({
    where: { id: purchase.orderId },
    select: { inspectionRequired: true },
  });
  await db.order.update({ where: { id: purchase.orderId }, data: { inspectionRequired: !orderBeforeStale.inspectionRequired } });
  let staleReview: RejectionRecord;
  try {
    staleReview = await expectRejected('stale current requirement', () => transact((tx) => reviewPurchaseStock({
      tx, actor: quality, commandId: `d14-stale-review-${tag}`,
      receiptLineId: lineB.id, version: contextB.version, snapshotHash: contextB.snapshotHash,
      decision: 'ACCEPTED', reason: 'Synthetic stale current requirement must fail', checks: checks(),
    })));
  } finally {
    await db.order.update({ where: { id: purchase.orderId }, data: { inspectionRequired: orderBeforeStale.inspectionRequired } });
  }
  assert.equal(staleReview.code, 'QUALITY_REVIEW_STALE');

  // Revoking the bound metadata makes the evidence read fail; restoring the
  // status keeps this synthetic fixture usable for the remaining checks.
  const boundEvidenceId = (firstReceipt.evidence as Array<{ id: string }>)[0]!.id;
  await db.storedObject.update({ where: { id: boundEvidenceId }, data: { status: 'REVOKED' } });
  try {
    const missingEvidence = await expectRejected('revoked arrival evidence', () => transact((tx) => getStockReceiptReviewContext({
      tx, actor: quality, receiptLineId: lineB.id,
    })));
    assert.equal(missingEvidence.code, 'QUALITY_EVIDENCE_INVALID');
  } finally {
    await db.storedObject.update({ where: { id: boundEvidenceId }, data: { status: 'AVAILABLE' } });
  }

  const acceptedContextA = await transact((tx) => getStockReceiptReviewContext({ tx, actor: quality, receiptLineId: lineA.id }));
  const acceptA = await transact((tx) => reviewPurchaseStock({
    tx, actor: quality, commandId: `d14-review-${tag}-a`, receiptLineId: lineA.id,
    version: acceptedContextA.version, snapshotHash: acceptedContextA.snapshotHash,
    decision: 'ACCEPTED', reason: 'Synthetic independent QC accepted batch A', checks: checks(),
  }));
  assert.equal(acceptA.id, firstReceipt.id);
  const afterAcceptA = await loadReceipt(firstReceipt.id);
  const acceptedLineA = afterAcceptA.lines.find((line) => line.id === lineA.id)!;
  assert.equal(acceptedLineA.status, 'ACCEPTED');
  assert.ok(acceptedLineA.inventoryDetailId);
  assert.ok(acceptedLineA.inventoryTransaction);
  assert.equal(acceptedLineA.inventoryTransaction?.type, 'INBOUND');
  assert.equal(acceptedLineA.inventoryTransaction?.quantity, 1);
  assert.equal((await currentPurchase(purchase.id)).lines.find((line) => line.id === purchaseLine.id)?.receivedQuantity, 1);

  const eventsAfterAccept = await db.stockReceiptEvent.count({ where: { stockReceiptId: firstReceipt.id } });
  const replayAccept = await transact((tx) => reviewPurchaseStock({
    tx, actor: quality, commandId: `d14-review-${tag}-a`, receiptLineId: lineA.id,
    version: acceptedContextA.version, snapshotHash: acceptedContextA.snapshotHash,
    decision: 'ACCEPTED', reason: 'Synthetic independent QC accepted batch A', checks: checks(),
  }));
  assert.deepEqual(replayAccept, { id: firstReceipt.id });
  assert.equal(await db.stockReceiptEvent.count({ where: { stockReceiptId: firstReceipt.id } }), eventsAfterAccept);
  const replayConflict = await expectRejected('review command hash reuse', () => transact((tx) => reviewPurchaseStock({
    tx, actor: quality, commandId: `d14-review-${tag}-a`, receiptLineId: lineA.id,
    version: acceptedContextA.version, snapshotHash: acceptedContextA.snapshotHash,
    decision: 'ACCEPTED', reason: 'Changed reason must not reuse command', checks: checks(),
  })));
  assert.equal(replayConflict.code, 'IDEMPOTENCY_KEY_REUSED');

  const contextBForReject = await transact((tx) => getStockReceiptReviewContext({ tx, actor: quality, receiptLineId: lineB.id }));
  const rejectB = await transact((tx) => reviewPurchaseStock({
    tx, actor: quality, commandId: `d14-review-${tag}-b`, receiptLineId: lineB.id,
    version: contextBForReject.version, snapshotHash: contextBForReject.snapshotHash,
    decision: 'REJECTED', reason: 'Synthetic condition rejection; replacement permitted', checks: checks(),
  }));
  assert.equal(rejectB.id, firstReceipt.id);
  const afterRejectB = await loadReceipt(firstReceipt.id);
  const rejectedLineB = afterRejectB.lines.find((line) => line.id === lineB.id)!;
  assert.equal(rejectedLineB.status, 'REJECTED');
  assert.equal(rejectedLineB.inventoryDetailId, null);
  assert.equal(rejectedLineB.inventoryTransaction, null);
  assert.equal((await currentPurchase(purchase.id)).lines.find((line) => line.id === purchaseLine.id)?.receivedQuantity, 1);

  const replacementPurchase = await currentPurchase(purchase.id);
  const replacementArrival: StockReceiptArrivalInput = {
    purchaseCommitmentId: purchase.id,
    purchaseVersion: replacementPurchase.version,
    supplierDeliveryReference: `D14-DELIVERY-${tag}-2`,
    reason: 'Synthetic replacement for rejected batch B',
    evidenceIds: [replacementEvidence.id],
    lines: [{
      purchaseCommitmentLineId: purchaseLine.id,
      physical: physicalFor(identity, `${tag}-C`, 1, trackingType, sameBatch),
      storage: storageFor(`${tag}-C`),
    }],
  };
  const replacementReceiptResult = await transact((tx) => receivePurchaseStock({
    tx, actor: buyer, commandId: `d14-receive-${tag}-2`, ...replacementArrival,
  }));
  const replacementReceipt = await loadReceipt(replacementReceiptResult.id);
  const replacementLine = replacementReceipt.lines[0]!;
  const replacementContext = await transact((tx) => getStockReceiptReviewContext({ tx, actor: quality, receiptLineId: replacementLine.id }));
  await transact((tx) => reviewPurchaseStock({
    tx, actor: quality, commandId: `d14-review-${tag}-c`, receiptLineId: replacementLine.id,
    version: replacementContext.version, snapshotHash: replacementContext.snapshotHash,
    decision: 'ACCEPTED', reason: 'Synthetic independent QC accepted replacement batch C', checks: checks(),
  }));
  const replayReplacement = await transact((tx) => reviewPurchaseStock({
    tx, actor: quality, commandId: `d14-review-${tag}-c`, receiptLineId: replacementLine.id,
    version: replacementContext.version, snapshotHash: replacementContext.snapshotHash,
    decision: 'ACCEPTED', reason: 'Synthetic independent QC accepted replacement batch C', checks: checks(),
  }));
  assert.deepEqual(replayReplacement, { id: replacementReceipt.id });

  const completedPurchase = await currentPurchase(purchase.id);
  const completedLine = completedPurchase.lines.find((line) => line.id === purchaseLine.id)!;
  assert.equal(completedLine.receivedQuantity, 2);
  const allReceiptLines = await db.stockReceiptLine.findMany({
    where: { purchaseCommitmentLineId: purchaseLine.id },
    include: { inventoryTransaction: true, inventoryDetail: true },
    orderBy: { createdAt: 'asc' },
  });
  assert.equal(allReceiptLines.filter((line) => line.status === 'ACCEPTED').reduce((sum, line) => sum + line.quantity, 0), 2);
  assert.equal(allReceiptLines.filter((line) => line.status === 'REJECTED').reduce((sum, line) => sum + line.quantity, 0), 1);
  assert.equal(allReceiptLines.filter((line) => line.status === 'PENDING_REVIEW').length, 0);
  assert.equal(allReceiptLines.filter((line) => line.inventoryTransaction).length, 2);
  assert.equal(new Set(allReceiptLines.filter((line) => line.inventoryTransaction).map((line) => line.inventoryTransaction!.stockReceiptLineId)).size, 2);
  assert.ok(allReceiptLines.filter((line) => line.status === 'ACCEPTED').every((line) => line.inventoryDetail?.type === 'OWN'));
  assert.ok(allReceiptLines.filter((line) => line.status === 'REJECTED').every((line) => line.inventoryDetail === null && line.inventoryTransaction === null));
  assert.equal(await db.inventoryTransaction.count({ where: { stockReceiptLineId: { not: null } } }), inboundBeforeAccept + 2);

  const projection = deriveReceiptQuantities({
    purchaseLines: [{ id: purchaseLine.id, quantity: completedLine.quantity, cancelledQuantity: completedLine.cancelledQuantity,
      receivedQuantity: completedLine.receivedQuantity, directShippedQuantity: completedLine.directShippedQuantity }],
    receiptLines: allReceiptLines.map((line) => ({ id: line.id, purchaseLineId: line.purchaseCommitmentLineId,
      quantity: line.quantity, status: line.status as 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED' })),
  });
  assert.equal(projection.headTotals.accepted, completedLine.receivedQuantity);
  assert.equal(projection.headTotals.rejected, 1);
  assert.equal(projection.headTotals.pendingReview, 0);
  assert.equal(projection.headTotals.outstandingArrival, 0);

  // A quantity overage must be rejected and rolled back as a whole. The
  // deliberate throw catches a command that incorrectly persists an overage.
  let overarrivalCommitted = false;
  const overarrival = await expectRejected('overarrival', () => transact(async (tx) => {
    const result = await receivePurchaseStock({
      tx, actor: buyer, commandId: `d14-receive-${tag}-over`,
      purchaseCommitmentId: purchase.id, purchaseVersion: completedPurchase.version,
      supplierDeliveryReference: `D14-DELIVERY-${tag}-OVER`, reason: 'Synthetic over-arrival must roll back',
        evidenceIds: [overarrivalEvidence.id], lines: [{ purchaseCommitmentLineId: purchaseLine.id,
        physical: physicalFor(identity, `${tag}-OVER`, 1, trackingType, sameBatch), storage: storageFor(`${tag}-OVER`) }],
    });
    overarrivalCommitted = true;
    throw new Error(`UNEXPECTED_OVERARRIVAL_ACCEPTED:${result.id}`);
  }));
  assert.equal(overarrivalCommitted, false, `overarrival command unexpectedly committed: ${JSON.stringify(overarrival)}`);
  assert.equal((await currentPurchase(purchase.id)).lines.find((line) => line.id === purchaseLine.id)?.receivedQuantity, 2);
  assert.equal(await db.stockReceipt.count({ where: { purchaseCommitmentId: purchase.id } }), 2);

  // D12 source coverage is required; a fixture or product failure fails this script.
  let allocationEvidence: Record<string, unknown>;
  const acceptedForAllocation = allReceiptLines.find((line) => line.status === 'ACCEPTED' && line.inventoryDetailId);
  if (!acceptedForAllocation?.inventoryDetailId) {
    allocationEvidence = { status: 'NOT_RUN', reason: 'No accepted inventory detail was available' };
  } else {
    try {
      const allocation = await transact((tx) => reserveLineInventory({
        tx,
        actor: buyer,
        quotationLineId: purchaseLine.orderLine.quotationLineId,
        orderLineId: purchaseLine.orderLineId,
        allocations: [{ inventoryDetailId: acceptedForAllocation.inventoryDetailId!, quantity: 1,
          stockReceiptLineId: acceptedForAllocation.id }],
        commandId: `d14-receipt-reserve-${tag}`,
      }));
      const persisted = await db.inventoryAllocation.findFirst({ where: { commandId: `d14-receipt-reserve-${tag}` }, select: {
        id: true, stockReceiptLineId: true, allocatedQuantity: true, assignments: { select: { orderLineId: true, assignedQuantity: true } },
      } });
      assert.ok(persisted, 'reserveLineInventory did not persist an allocation');
      assert.equal(persisted.stockReceiptLineId, acceptedForAllocation.id);
      assert.equal(persisted.allocatedQuantity, 1);
      assert.equal(persisted.assignments[0]?.orderLineId, purchaseLine.orderLineId);
      allocationEvidence = { status: 'PASS', result: allocation, allocationId: persisted.id, stockReceiptLineId: persisted.stockReceiptLineId };
    } catch (error) { throw error; }
  }

  const finalRows = await db.stockReceiptLine.findMany({ where: { purchaseCommitmentLineId: purchaseLine.id }, select: {
    id: true, status: true, quantity: true, inventoryDetailId: true,
    inventoryTransaction: { select: { id: true, type: true, quantity: true, stockReceiptLineId: true } },
  } });
  console.log(JSON.stringify({
    result: 'PASS', database: expectedDatabase, tag, resumedReceiptId: resumedReceipt?.id ?? null, purchaseCommitmentId: purchase.id,
    purchaseCommitmentLineId: purchaseLine.id, orderId: purchase.orderId, orderLineId: purchaseLine.orderLineId,
    syntheticFixturePreparation: fixturePreparation,
    receipts: { count: await db.stockReceipt.count({ where: { purchaseCommitmentId: purchase.id } }), lines: finalRows },
    projection, allocationCoverage: allocationEvidence,
    checks: [
      'arrival creates two same-batch physical receipt lines with PENDING_REVIEW and no inventory ledger',
      'quality actor self-review rejected without mutation',
      'stale quality snapshot rejected before inventory write',
      'revoked/missing arrival evidence rejected',
      'independent ACCEPT creates one OWN detail and one unique INBOUND per receipt line',
      'REJECT preserves physical history without inventory or receivedQuantity projection',
      'rejected line permits a replacement arrival and accepted replacement',
      'ACCEPT quantity equals PurchaseCommitmentLine.receivedQuantity',
      'same command replay returns cached id without duplicate event/INBOUND',
      'same command with changed request is rejected',
      'over-arrival rolls back without a persisted receipt',
    ],
  }, null, 2));
}

try {
  await main();
} finally {
  await db.$disconnect();
}
