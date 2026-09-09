import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { CapabilityActor } from '../lib/capabilityPolicy.js';
import { captureQuotationLineCost, buildCommercialApprovalSnapshot } from '../lib/lineQuotationPolicy.js';
import { buildQuotationApprovalSnapshot, QUOTATION_APPROVAL_POLICY_VERSION } from '../lib/quotationApprovalPolicy.js';
import { createPurchaseCommitment, transitionPurchaseCommitment } from '../modules/procurementSettlement/purchaseCommands.js';
import type { PurchaseLineInput } from '../modules/procurementSettlement/purchaseSources.js';
import {
  cancelDirectShipment,
  createDirectShipment,
  dispatchDirectShipment,
  getDirectShipmentReviewContext,
  receiveDirectShipment,
  reviewDirectShipment,
} from '../modules/procurementSettlement/directShipmentCommands.js';

/**
 * Synthetic local-only D14 supplier-direct command-chain evidence.
 *
 * This script is deliberately independent of Express, Socket.IO, the worker,
 * object-storage bytes, and all non-disposable databases. It creates a modern
 * two-line sale plus a confirmed SUPPLIER_DIRECT purchase commitment, then
 * exercises direct plan, quality review, dispatch and customer receipt facts.
 */
const expectedDatabase = 'aerolink_procurement_test_direct_20260909';
const databaseUrlValue = process.env.DATABASE_URL;
if (process.env.AEROLINK_DIRECT_SHIPMENT_INTEGRATION !== 'true' || !databaseUrlValue) {
  throw new Error(`Explicit AEROLINK_DIRECT_SHIPMENT_INTEGRATION=true and ${expectedDatabase} DATABASE_URL are required`);
}
const databaseUrl = new URL(databaseUrlValue);
if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.port !== '55970'
  || databaseUrl.pathname !== `/${expectedDatabase}`) {
  throw new Error(`Refusing non-local/non-${expectedDatabase} DATABASE_URL`);
}

const db = new PrismaClient();
const transact = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async (tx) => {
  const result = await run(tx);
  // Prisma 5 can resolve an interactive callback before PostgreSQL reports a
  // deferred trigger failure at COMMIT. Force the check inside the callback.
  await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  return result;
}, { isolationLevel: 'Serializable', timeout: 60_000 });

type ActorRow = { id: string; role: string; department: string | null };
type ErrorLike = { code?: unknown; statusCode?: unknown; message?: unknown };
type RejectionRecord = { label: string; code?: unknown; statusCode?: unknown; message?: unknown };

function actor(user: ActorRow): CapabilityActor {
  return { id: user.id, role: user.role, department: user.department };
}

async function reloadActor(userId: string): Promise<CapabilityActor> {
  return actor(await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, role: true, department: true },
  }));
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

async function createSyntheticEvidence(ownerId: string, tag: string, purpose: string) {
  const content = `synthetic-direct:${tag}:${purpose}`;
  return db.storedObject.create({
    data: {
      objectKey: `synthetic/d14-direct/${tag}/${purpose}.pdf`,
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length,
      mimeType: 'application/pdf',
      originalName: `synthetic-${purpose}.pdf`,
      ownerId,
      status: 'AVAILABLE',
      metadata: { synthetic: true, tag, purpose },
    },
    select: { id: true, version: true, status: true },
  });
}

async function loadPurchase(id: string) {
  return db.purchaseCommitment.findUniqueOrThrow({
    where: { id },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
}

async function loadDirectShipment(id: string) {
  return db.supplierDirectShipment.findUniqueOrThrow({
    where: { id },
    include: {
      lines: { orderBy: { lineNo: 'asc' } },
      events: { orderBy: { createdAt: 'asc' } },
    },
  });
}

async function loadOrder(id: string) {
  return db.order.findUniqueOrThrow({
    where: { id },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
}

async function directEventCount(shipmentId: string) {
  return db.supplierDirectShipmentEvent.count({ where: { shipmentId } });
}

async function localArtifactCounts(orderId: string, purchaseId: string) {
  const [inventoryTransactions, stockReceipts] = await Promise.all([
    db.inventoryTransaction.count({ where: { orderId } }),
    db.stockReceipt.count({ where: { purchaseCommitmentId: purchaseId } }),
  ]);
  return { inventoryTransactions, stockReceipts };
}

function batchPhysical(partNumber: string, batchNumber: string, quantity = 2) {
  return {
    partNumber,
    uom: 'EA',
    trackingType: 'BATCH' as const,
    quantity,
    serialNumber: null,
    batchNumber,
    conditionCode: 'NE',
    certificateReferences: [],
    certificateType: null,
    certificateNumber: null,
    lifeLimited: false,
    remainingHours: null,
    remainingCycles: null,
    shelfLifeDate: null,
    shelfLifeDays: null,
    nextOverhaulDue: null,
    storageCondition: 'SYNTHETIC-DRY',
  };
}

function serialPhysical(partNumber: string, serialNumber: string) {
  return {
    partNumber,
    uom: 'EA',
    trackingType: 'SERIAL' as const,
    quantity: 1,
    serialNumber,
    batchNumber: null,
    conditionCode: 'NE',
    certificateReferences: [],
    certificateType: null,
    certificateNumber: null,
    lifeLimited: false,
    remainingHours: null,
    remainingCycles: null,
    shelfLifeDate: null,
    shelfLifeDays: null,
    nextOverhaulDue: null,
    storageCondition: 'SYNTHETIC-DRY',
  };
}

const checks = { identity: true, documents: true, conditionAndLife: true, customerRequirements: true };

async function main() {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const promisedDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Every fixture is synthetic and uniquely tagged. No existing row is read as
  // a source of commercial or identity facts, and no cleanup/delete is issued.
  const sales = await db.user.create({ data: {
    email: `d14-direct-sales-${tag}@example.invalid`, name: `D14 direct synthetic sales ${tag}`,
    password: 'synthetic-only', role: 'SALES', department: 'Sales',
  }, select: { id: true, role: true, department: true } });
  const buyer = await db.user.create({ data: {
    email: `d14-direct-buyer-${tag}@example.invalid`, name: `D14 direct synthetic buyer ${tag}`,
    password: 'synthetic-only', role: 'MANAGER', department: 'Sales',
  }, select: { id: true, role: true, department: true } });
  const managerApprover = await db.user.create({ data: {
    email: `d14-direct-manager-approver-${tag}@example.invalid`, name: `D14 direct synthetic manager approver ${tag}`,
    password: 'synthetic-only', role: 'MANAGER', department: 'Sales',
  }, select: { id: true, role: true, department: true } });
  const approver = await db.user.create({ data: {
    email: `d14-direct-approver-${tag}@example.invalid`, name: `D14 direct synthetic approver ${tag}`,
    password: 'synthetic-only', role: 'FINANCE', department: 'Finance',
  }, select: { id: true, role: true, department: true } });
  const quality = await db.user.create({ data: {
    email: `d14-direct-quality-${tag}@example.invalid`, name: `D14 direct synthetic quality ${tag}`,
    password: 'synthetic-only', role: 'QUALITY_MANAGER', department: 'Sales',
  }, select: { id: true, role: true, department: true } });
  const customer = await db.customer.create({ data: {
    name: `D14 direct synthetic customer ${tag}`, contactName: 'Synthetic receiver',
    email: `d14-direct-customer-${tag}@example.invalid`,
  } });
  const supplier = await db.supplier.create({ data: { name: `D14 direct synthetic supplier ${tag}`, status: 'active' } });

  const batchPart = `D14-DIRECT-BATCH-${tag}`;
  const serialPart = `D14-DIRECT-SERIAL-${tag}`;
  const serialNumber = `SN-DIRECT-${tag}`;
  const batchNumber = `BATCH-DIRECT-${tag}`;
  const rfq = await db.rFQ.create({
    data: {
      lineItemsMode: true,
      rfqNumber: `D14-DIRECT-RFQ-${tag}`,
      customerId: customer.id,
      partNumber: batchPart,
      quantity: 3,
      requiredDate: future,
      createdBy: sales.id,
      status: 'OPEN',
      lines: { create: [
        { lineNo: 1, partNumber: batchPart, quantity: 2, uom: 'EA', conditionCode: 'NE',
          certificateRequired: false, requiredDate: future, status: 'OPEN' },
        { lineNo: 2, partNumber: serialPart, quantity: 1, uom: 'EA', conditionCode: 'NE',
          serialNumber, certificateRequired: false, requiredDate: future, status: 'OPEN' },
      ] },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
  const [rfqBatchLine, rfqSerialLine] = rfq.lines;
  assert.ok(rfqBatchLine && rfqSerialLine, 'synthetic RFQ lines were not created');

  // Create the supplier sources before the quotation so each modern quotation
  // line can capture a real, exact RFQ-line source snapshot.
  const batchQuote = await db.supplierQuote.create({ data: {
    rfqId: rfq.id, rfqLineId: rfqBatchLine.id, supplierId: supplier.id, partNumber: batchPart,
    quantity: 2, unitPrice: 2500, totalPrice: 5000, unitPriceDecimal: new Prisma.Decimal('2500.0000'),
    totalPriceDecimal: new Prisma.Decimal('5000.0000'), currency: 'USD', currencyReviewStatus: 'VERIFIED',
    status: 'pending', leadTimeDays: 7, validUntil: future,
  } });
  const serialQuote = await db.supplierQuote.create({ data: {
    rfqId: rfq.id, rfqLineId: rfqSerialLine.id, supplierId: supplier.id, partNumber: serialPart,
    quantity: 1, unitPrice: 2500, totalPrice: 2500, unitPriceDecimal: new Prisma.Decimal('2500.0000'),
    totalPriceDecimal: new Prisma.Decimal('2500.0000'), currency: 'USD', currencyReviewStatus: 'VERIFIED',
    status: 'pending', leadTimeDays: 7, validUntil: future,
  } });

  const quotation = await db.quotation.create({
    data: {
      lineItemsMode: true,
      quoteNumber: `D14-DIRECT-Q-${tag}`,
      rfqId: rfq.id,
      customerId: customer.id,
      partNumber: batchPart,
      quantity: 3,
      unitPrice: 4000,
      totalPrice: 12000,
      costPrice: 2500,
      margin: 4500,
      currency: 'USD',
      unitPriceDecimal: new Prisma.Decimal('4000.0000'),
      totalPriceDecimal: new Prisma.Decimal('12000.0000'),
      costPriceDecimal: new Prisma.Decimal('2500.0000'),
      status: 'APPROVED', statusEnum: 'APPROVED', expiryDate: future,
      validityDays: 30, validityDeadline: future, createdBy: sales.id,
      lines: { create: [
        { lineNo: 1, rfqLineId: rfqBatchLine.id, partNumber: batchPart, uom: 'EA', quantity: 2,
          unitPrice: new Prisma.Decimal('4000.0000'), costPrice: new Prisma.Decimal('2500.0000'),
          lineTotal: new Prisma.Decimal('8000.0000'), marginAmount: new Prisma.Decimal('3000.0000'),
          marginPercent: new Prisma.Decimal('37.5000'), currency: 'USD', status: 'APPROVED', acceptedQuantity: 2 },
        { lineNo: 2, rfqLineId: rfqSerialLine.id, partNumber: serialPart, uom: 'EA', quantity: 1,
          unitPrice: new Prisma.Decimal('4000.0000'), costPrice: new Prisma.Decimal('2500.0000'),
          lineTotal: new Prisma.Decimal('4000.0000'), marginAmount: new Prisma.Decimal('1500.0000'),
          marginPercent: new Prisma.Decimal('37.5000'), currency: 'USD', status: 'APPROVED',
          acceptedQuantity: 1, serialNumber },
      ] },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
  const [quotationBatchLine, quotationSerialLine] = quotation.lines;
  assert.ok(quotationBatchLine && quotationSerialLine, 'synthetic quotation lines were not created');

  const order = await db.order.create({
    data: {
      lineItemsMode: true,
      orderNumber: `D14-DIRECT-ORDER-${tag}`,
      soNumber: `D14-DIRECT-SO-${tag}`,
      quotationId: quotation.id,
      customerId: customer.id,
      partNumber: batchPart,
      quantity: 3,
      totalAmount: 12000,
      totalAmountDecimal: new Prisma.Decimal('12000.0000'),
      status: 'SO_CREATED', statusEnum: 'SO_CREATED',
      certificateRequired: false, inspectionRequired: false,
      lines: { create: [
        { lineNo: 1, quotationLineId: quotationBatchLine.id, partNumber: batchPart, uom: 'EA', quantity: 2,
          unitPrice: new Prisma.Decimal('4000.0000'), lineTotal: new Prisma.Decimal('8000.0000'), currency: 'USD' },
        { lineNo: 2, quotationLineId: quotationSerialLine.id, partNumber: serialPart, uom: 'EA', quantity: 1,
          unitPrice: new Prisma.Decimal('4000.0000'), lineTotal: new Prisma.Decimal('4000.0000'), currency: 'USD', serialNumber },
      ] },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
  const [orderBatchLine, orderSerialLine] = order.lines;
  assert.ok(orderBatchLine && orderSerialLine, 'synthetic order lines were not created');

  // Populate the immutable commercial evidence on every modern quotation
  // line before the purchase/direct chain reads the order. The header remains
  // a multi-line projection; line-level source snapshots are the authoritative
  // cost facts used by reconciliation and approval.
  await transact(async (tx) => {
    const batchCost = await captureQuotationLineCost({
      tx,
      rfqId: rfq.id,
      rfqLine: rfqBatchLine,
      quotationId: quotation.id,
      input: {
        partNumber: batchPart,
        quantity: 2,
        costPrice: 2500,
        currency: 'USD',
        costSourceType: 'SUPPLIER_QUOTE',
        costSourceId: batchQuote.id,
      },
    });
    const serialCost = await captureQuotationLineCost({
      tx,
      rfqId: rfq.id,
      rfqLine: rfqSerialLine,
      quotationId: quotation.id,
      input: {
        partNumber: serialPart,
        quantity: 1,
        costPrice: 2500,
        currency: 'USD',
        costSourceType: 'SUPPLIER_QUOTE',
        costSourceId: serialQuote.id,
      },
    });
    await tx.quotation.update({ where: { id: quotation.id }, data: {
      status: 'ACCEPTED',
      statusEnum: 'ACCEPTED',
      approvedBy: approver.id,
      approvedAt: now,
      acceptedAt: now,
      orderId: order.id,
      orderNumber: order.orderNumber,
    } });
    await tx.quotationLine.update({ where: { id: quotationBatchLine.id }, data: {
      sourceSupplierQuoteId: batchQuote.id,
      costSourceType: batchCost.costSourceType,
      costSourceId: batchCost.costSourceId,
      costSourceReason: batchCost.costSourceReason,
      costSourceSnapshotJson: batchCost.costSourceSnapshotJson,
      costSourceCapturedAt: batchCost.costSourceCapturedAt,
      status: 'ACCEPTED',
      acceptedQuantity: 2,
    } });
    await tx.quotationLine.update({ where: { id: quotationSerialLine.id }, data: {
      sourceSupplierQuoteId: serialQuote.id,
      costSourceType: serialCost.costSourceType,
      costSourceId: serialCost.costSourceId,
      costSourceReason: serialCost.costSourceReason,
      costSourceSnapshotJson: serialCost.costSourceSnapshotJson,
      costSourceCapturedAt: serialCost.costSourceCapturedAt,
      status: 'ACCEPTED',
      acceptedQuantity: 1,
    } });
    const current = await tx.quotation.findUniqueOrThrow({
      where: { id: quotation.id },
      include: { lines: true, rfq: true },
    });
    const approvalSnapshot = buildCommercialApprovalSnapshot({
      headerTerms: buildQuotationApprovalSnapshot(current),
      lines: current.lines,
    });
    await tx.approval.create({ data: {
      quotationId: current.id,
      level: 'FINANCE',
      requiredLevel: 'FINANCE',
      policyVersion: `${QUOTATION_APPROVAL_POLICY_VERSION}-lines-v1`,
      reviewedVersion: current.version,
      snapshotJson: JSON.stringify(approvalSnapshot),
      approverId: approver.id,
      action: 'APPROVE',
      comment: 'Synthetic independent FINANCE approval for D14 direct shipment coverage',
    } });
  });
  const auditedQuotation = await db.quotation.findUniqueOrThrow({
    where: { id: quotation.id },
    include: { lines: { orderBy: { lineNo: 'asc' } }, approvals: true },
  });
  assert.equal(auditedQuotation.status, 'ACCEPTED');
  assert.equal(auditedQuotation.lines.length, 2);
  for (const line of auditedQuotation.lines) {
    assert.equal(line.costSourceType, 'SUPPLIER_QUOTE');
    assert.equal(line.sourceSupplierQuoteId, line.costSourceId);
    assert.ok(line.costSourceSnapshotJson, `quotation line ${line.id} is missing cost snapshot`);
    const snapshot = JSON.parse(line.costSourceSnapshotJson) as Record<string, unknown>;
    assert.equal(snapshot.type, 'SUPPLIER_QUOTE');
    assert.equal(snapshot.id, line.costSourceId);
    assert.equal(snapshot.currency, 'USD');
  }
  const quotationApproval = auditedQuotation.approvals.find((row) => row.action === 'APPROVE');
  assert.ok(quotationApproval, 'modern quotation is missing its approval evidence');
  assert.equal(quotationApproval?.level, 'FINANCE');
  assert.equal(quotationApproval?.policyVersion, `${QUOTATION_APPROVAL_POLICY_VERSION}-lines-v1`);
  assert.ok(quotationApproval?.snapshotJson);
  const commercialSnapshot = JSON.parse(quotationApproval!.snapshotJson) as { lines?: unknown[] };
  assert.equal(commercialSnapshot.lines?.length, 2);

  // Browser procurement acceptance uses a real modern sale with complete
  // line-level source/approval evidence but deliberately no purchase rows.
  // Keep this separate from the confirmed-purchase fixture above so the UI
  // can exercise purchase create -> submit -> approve -> confirm itself.
  if (process.env.AEROLINK_DIRECT_SHIPMENT_SALES_FIXTURE_ONLY === 'true') {
    const fixture = {
      result: 'SALES_FIXTURE_ONLY', database: expectedDatabase, tag,
      rfqId: rfq.id, quotationId: quotation.id, customerId: customer.id,
      supplierId: supplier.id, orderId: order.id,
      orderLineIds: order.lines.map(line => line.id),
      sourceQuoteIds: [batchQuote.id, serialQuote.id],
      users: { salesId: sales.id, buyerId: buyer.id, managerApproverId: managerApprover.id,
        approverId: approver.id, qualityId: quality.id },
    };
    assert.equal(fixture.orderLineIds.length, 2);
    console.log(JSON.stringify(fixture, null, 2));
    return;
  }

  const confirmationProof = await db.storedObject.create({ data: {
    objectKey: `synthetic/d14-direct/${tag}/purchase-confirmation.pdf`, sha256: 'a'.repeat(64), sizeBytes: 16,
    mimeType: 'application/pdf', originalName: 'synthetic-purchase-confirmation.pdf', ownerId: buyer.id,
    status: 'AVAILABLE', metadata: { synthetic: true, tag, purpose: 'purchase-confirmation' },
  } });

  const purchaseLines: PurchaseLineInput[] = [
    { orderLineId: orderBatchLine.id, quantity: 2, promisedDate, fulfillmentMode: 'SUPPLIER_DIRECT',
      source: { type: 'SUPPLIER_QUOTE', supplierQuoteId: batchQuote.id } },
    { orderLineId: orderSerialLine.id, quantity: 1, promisedDate, fulfillmentMode: 'SUPPLIER_DIRECT',
      source: { type: 'SUPPLIER_QUOTE', supplierQuoteId: serialQuote.id } },
  ];
  const buyerActor = actor(buyer);
  const managerApproverActor = actor(managerApprover);
  const approverActor = actor(approver);
  const qualityActor = actor(quality);
  const salesActor = actor(sales);
  const createdPurchase = await transact(tx => createPurchaseCommitment({ tx, actor: buyerActor,
    orderId: order.id, supplierId: supplier.id, lines: purchaseLines, paymentTerms: 'NET 30 synthetic direct',
    commandId: `d14-direct-purchase-create-${tag}` }));
  let purchase = await loadPurchase(createdPurchase.id);
  assert.equal(purchase.status, 'DRAFT');
  await transact(tx => transitionPurchaseCommitment({ tx, actor: buyerActor, purchaseCommitmentId: purchase.id,
    version: purchase.version, action: 'SUBMIT', reason: 'Synthetic SUPPLIER_DIRECT source review',
    commandId: `d14-direct-purchase-submit-${tag}` }));
  purchase = await loadPurchase(purchase.id);
  const managerApproval = await expectRejected('manager cannot approve FINANCE-level purchase', () => transact(tx =>
    transitionPurchaseCommitment({ tx, actor: managerApproverActor, purchaseCommitmentId: purchase.id,
      version: purchase.version, action: 'APPROVE', reason: 'Synthetic insufficient approval tier',
      commandId: `d14-direct-purchase-manager-approve-${tag}` })));
  assert.equal(managerApproval.statusCode, 403);
  assert.ok(managerApproval.code === 'AUTH_FORBIDDEN' || String(managerApproval.message).includes('FINANCE'));
  purchase = await loadPurchase(purchase.id);
  await transact(tx => transitionPurchaseCommitment({ tx, actor: approverActor, purchaseCommitmentId: purchase.id,
    version: purchase.version, action: 'APPROVE', reason: 'Independent synthetic direct procurement approval',
    commandId: `d14-direct-purchase-approve-${tag}` }));
  purchase = await loadPurchase(purchase.id);
  await transact(tx => transitionPurchaseCommitment({ tx, actor: buyerActor, purchaseCommitmentId: purchase.id,
    version: purchase.version, action: 'CONFIRM', supplierReferenceNo: `SUP-DIRECT-${tag}`,
    evidenceIds: [confirmationProof.id], reason: 'Synthetic supplier direct confirmation',
    commandId: `d14-direct-purchase-confirm-${tag}` }));
  purchase = await loadPurchase(purchase.id);
  assert.equal(purchase.status, 'CONFIRMED');
  assert.ok(purchase.lines.every(line => line.fulfillmentMode === 'SUPPLIER_DIRECT'));
  assert.ok(purchase.lines.every(line => line.receivedQuantity === 0 && line.directShippedQuantity === 0));

  // The HTTP companion uses this explicit fixture-only mode to reuse the
  // same fully sourced modern sale/purchase setup without running the command
  // chain a second time.  It is intentionally opt-in and emits only synthetic
  // identifiers; no token or secret is written to the output.
  if (process.env.AEROLINK_DIRECT_SHIPMENT_FIXTURE_ONLY === 'true') {
    const fixture = {
      result: 'FIXTURE_ONLY', database: expectedDatabase, tag,
      rfqId: rfq.id, quotationId: quotation.id, orderId: order.id,
      purchaseCommitmentId: purchase.id,
      batchPurchaseLineId: purchase.lines.find(line => line.orderLineId === orderBatchLine.id)?.id,
      serialPurchaseLineId: purchase.lines.find(line => line.orderLineId === orderSerialLine.id)?.id,
      batchPart, batchNumber, serialPart, serialNumber,
      users: { salesId: sales.id, buyerId: buyer.id, managerApproverId: managerApprover.id,
        approverId: approver.id, qualityId: quality.id },
    };
    assert.ok(fixture.batchPurchaseLineId && fixture.serialPurchaseLineId, 'fixture-only purchase lines missing');
    console.log(JSON.stringify(fixture, null, 2));
    return;
  }

  const batchPurchaseLine = purchase.lines.find(line => line.orderLineId === orderBatchLine.id)!;
  const serialPurchaseLine = purchase.lines.find(line => line.orderLineId === orderSerialLine.id)!;
  const batch = batchPhysical(batchPart, batchNumber);
  const serial = serialPhysical(serialPart, serialNumber);
  const baselineLocal = await localArtifactCounts(order.id, purchase.id);
  assert.deepEqual(baselineLocal, { inventoryTransactions: 0, stockReceipts: 0 });

  const unauthorizedEvidence = await createSyntheticEvidence(sales.id, tag, 'unauthorized-scope');
  const salesCreate = await expectRejected('sales cannot create direct shipment', () => transact(tx => createDirectShipment({
    tx, actor: salesActor, commandId: `d14-direct-unauthorized-${tag}`, purchaseCommitmentId: purchase.id,
    purchaseVersion: purchase.version, carrier: 'Synthetic Carrier', trackingNumber: `NO-${tag}`,
    origin: 'Supplier', destination: 'Customer', reason: 'Unauthorized synthetic attempt', evidenceIds: [unauthorizedEvidence.id],
    lines: [{ purchaseCommitmentLineId: batchPurchaseLine.id, physical: batch }],
  })));
  assert.equal(salesCreate.statusCode, 403);

  const overEvidence = await createSyntheticEvidence(buyer.id, tag, 'over-capacity');
  const beforeOver = await loadPurchase(purchase.id);
  const overPlan = await expectRejected('direct shipment overage', () => transact(tx => createDirectShipment({
    tx, actor: buyerActor, commandId: `d14-direct-over-${tag}`, purchaseCommitmentId: purchase.id,
    purchaseVersion: beforeOver.version, carrier: 'Synthetic Carrier', trackingNumber: `OVER-${tag}`,
    origin: 'Supplier', destination: 'Customer', reason: 'Over-capacity synthetic attempt', evidenceIds: [overEvidence.id],
    lines: [{ purchaseCommitmentLineId: batchPurchaseLine.id, physical: batchPhysical(batchPart, batchNumber, 3) }],
  })));
  assert.equal(overPlan.statusCode, 409);
  assert.equal((await loadPurchase(purchase.id)).version, beforeOver.version);

  // SERIAL claim release: prepare, approve, reject dispatch after evidence
  // revocation, cancel, then prepare the same PN/SN again successfully.
  const serialEvidence = await createSyntheticEvidence(buyer.id, tag, 'serial-plan-1');
  const serialCreateInput = {
    tx: undefined as never, actor: buyerActor, commandId: `d14-direct-serial-create-${tag}`,
    purchaseCommitmentId: purchase.id, purchaseVersion: beforeOver.version,
    carrier: 'Synthetic Carrier', trackingNumber: `SERIAL-${tag}`,
    origin: 'Supplier', destination: 'Customer', reason: 'Synthetic serial direct plan',
    evidenceIds: [serialEvidence.id], lines: [{ purchaseCommitmentLineId: serialPurchaseLine.id, physical: serial }],
  };
  const serialCreated = await transact(tx => createDirectShipment({ ...serialCreateInput, tx }));
  const serialShipmentId = serialCreated.id;
  const serialReplay = await transact(tx => createDirectShipment({ ...serialCreateInput, tx }));
  assert.deepEqual(serialReplay, serialCreated);
  let serialShipment = await loadDirectShipment(serialShipmentId);
  assert.equal(serialShipment.status, 'PREPARED');
  assert.equal(serialShipment.lines[0]?.serialClaimKey, `${serialPart.length}:${serialPart}${serialNumber}`);
  assert.equal(await directEventCount(serialShipmentId), 1);
  const serialContext = await transact(tx => getDirectShipmentReviewContext({ tx, actor: qualityActor,
    shipmentLineId: serialShipment.lines[0]!.id }));
  assert.equal(serialContext.canApprove, true);
  await transact(tx => reviewDirectShipment({ tx, actor: qualityActor, commandId: `d14-direct-serial-review-${tag}`,
    shipmentLineId: serialShipment.lines[0]!.id, version: serialContext.version,
    snapshotHash: serialContext.snapshotHash, decision: 'APPROVED', reason: 'Independent serial quality review',
    checks, evidenceIds: [] }));
  serialShipment = await loadDirectShipment(serialShipmentId);
  assert.equal(serialShipment.lines[0]?.reviewStatus, 'APPROVED');
  await db.storedObject.update({ where: { id: serialEvidence.id }, data: { status: 'REVOKED', version: { increment: 1 } } });
  const staleDispatch = await expectRejected('revoked direct evidence blocks dispatch', () => transact(tx => dispatchDirectShipment({
    tx, actor: buyerActor, commandId: `d14-direct-serial-dispatch-stale-${tag}`, shipmentId: serialShipmentId,
    version: serialShipment.version, reason: 'Synthetic stale evidence dispatch',
  })));
  assert.equal(staleDispatch.code, 'QUALITY_EVIDENCE_INVALID');
  serialShipment = await loadDirectShipment(serialShipmentId);
  assert.equal(serialShipment.status, 'PREPARED');
  assert.equal((await loadPurchase(purchase.id)).lines.find(line => line.id === serialPurchaseLine.id)?.directShippedQuantity, 0);
  await transact(tx => cancelDirectShipment({ tx, actor: buyerActor, commandId: `d14-direct-serial-cancel-${tag}`,
    shipmentId: serialShipmentId, version: serialShipment.version, reason: 'Release serial claim after stale evidence' }));
  serialShipment = await loadDirectShipment(serialShipmentId);
  assert.equal(serialShipment.status, 'CANCELLED');
  assert.equal(serialShipment.lines[0]?.serialClaimKey, null);

  const serialEvidence2 = await createSyntheticEvidence(buyer.id, tag, 'serial-plan-2');
  purchase = await loadPurchase(purchase.id);
  const serialCreatedAgain = await transact(tx => createDirectShipment({ tx, actor: buyerActor,
    commandId: `d14-direct-serial-create-again-${tag}`, purchaseCommitmentId: purchase.id,
    purchaseVersion: purchase.version, carrier: 'Synthetic Carrier', trackingNumber: `SERIAL-AGAIN-${tag}`,
    origin: 'Supplier', destination: 'Customer', reason: 'Same serial claim after cancellation', evidenceIds: [serialEvidence2.id],
    lines: [{ purchaseCommitmentLineId: serialPurchaseLine.id, physical: serial }] }));
  assert.notEqual(serialCreatedAgain.id, serialShipmentId);
  let serialAgain = await loadDirectShipment(serialCreatedAgain.id);
  assert.equal(serialAgain.lines[0]?.serialClaimKey, `${serialPart.length}:${serialPart}${serialNumber}`);
  const serialAgainContext = await transact(tx => getDirectShipmentReviewContext({ tx, actor: qualityActor,
    shipmentLineId: serialAgain.lines[0]!.id }));
  assert.equal(serialAgainContext.canApprove, true);
  await transact(tx => reviewDirectShipment({ tx, actor: qualityActor,
    commandId: `d14-direct-serial-review-again-${tag}`, shipmentLineId: serialAgain.lines[0]!.id,
    version: serialAgainContext.version, snapshotHash: serialAgainContext.snapshotHash,
    decision: 'APPROVED', reason: 'Independent quality review after serial claim recreation', checks, evidenceIds: [] }));
  serialAgain = await loadDirectShipment(serialCreatedAgain.id);
  await transact(tx => dispatchDirectShipment({ tx, actor: buyerActor,
    commandId: `d14-direct-serial-dispatch-again-${tag}`, shipmentId: serialCreatedAgain.id,
    version: serialAgain.version, reason: 'Supplier dispatched recreated serial batch' }));
  serialAgain = await loadDirectShipment(serialCreatedAgain.id);
  assert.equal(serialAgain.status, 'DISPATCHED');
  assert.equal((await loadPurchase(purchase.id)).lines.find(line => line.id === serialPurchaseLine.id)?.directShippedQuantity, 1);
  await transact(tx => receiveDirectShipment({ tx, actor: buyerActor,
    commandId: `d14-direct-serial-receipt-again-${tag}`, shipmentLineId: serialAgain.lines[0]!.id,
    version: serialAgain.lines[0]!.version, quantity: 1, signedBy: 'Synthetic customer receiver',
    signedAt: new Date(now.getTime() - 30_000).toISOString(), reason: 'Synthetic serial customer receipt',
    evidenceIds: [serialEvidence2.id] }));
  serialAgain = await loadDirectShipment(serialCreatedAgain.id);
  assert.equal(serialAgain.status, 'DELIVERED');
  assert.equal(serialAgain.lines[0]?.receivedQuantity, 1);
  assert.equal((await loadPurchase(purchase.id)).lines.find(line => line.id === serialPurchaseLine.id)?.receivedQuantity, 0);
  assert.equal((await loadOrder(order.id)).status, 'SO_CREATED');

  // Main BATCH flow: create -> independent quality approval -> dispatch ->
  // partial receipt -> final receipt. The same command IDs are replayed to
  // prove event and state idempotency without duplicating facts.
  const mainEvidence = await createSyntheticEvidence(buyer.id, tag, 'batch-plan');
  purchase = await loadPurchase(purchase.id);
  const mainCreateInput = {
    purchaseCommitmentId: purchase.id, purchaseVersion: purchase.version, carrier: 'Synthetic Carrier',
    trackingNumber: `BATCH-${tag}`, origin: 'Supplier', destination: 'Customer',
    reason: 'Synthetic batch direct plan', evidenceIds: [mainEvidence.id],
    lines: [{ purchaseCommitmentLineId: batchPurchaseLine.id, physical: batch }],
  };
  const mainCreated = await transact(tx => createDirectShipment({ tx, actor: buyerActor,
    commandId: `d14-direct-main-create-${tag}`, ...mainCreateInput }));
  const mainReplay = await transact(tx => createDirectShipment({ tx, actor: buyerActor,
    commandId: `d14-direct-main-create-${tag}`, ...mainCreateInput }));
  assert.deepEqual(mainReplay, mainCreated);
  let mainShipment = await loadDirectShipment(mainCreated.id);
  assert.equal(mainShipment.status, 'PREPARED');
  assert.equal(mainShipment.lines[0]?.quantity, 2);
  assert.equal(await directEventCount(mainCreated.id), 1);
  const mainContext = await transact(tx => getDirectShipmentReviewContext({ tx, actor: qualityActor,
    shipmentLineId: mainShipment.lines[0]!.id }));
  assert.equal(mainContext.canApprove, true);
  const selfReviewCapability = await expectRejected('manager cannot quality approve', () => transact(tx => reviewDirectShipment({
    tx, actor: buyerActor, commandId: `d14-direct-main-capability-review-${tag}`, shipmentLineId: mainShipment.lines[0]!.id,
    version: mainContext.version, snapshotHash: mainContext.snapshotHash, decision: 'APPROVED',
    reason: 'Synthetic role capability denial', checks, evidenceIds: [] })));
  assert.equal(selfReviewCapability.statusCode, 403);
  assert.equal(selfReviewCapability.code, 'AUTH_FORBIDDEN');
  await db.user.update({ where: { id: buyer.id }, data: { role: 'QUALITY_MANAGER' } });
  let selfReview: RejectionRecord;
  try {
    const buyerReviewActor = await reloadActor(buyer.id);
    selfReview = await expectRejected('shipment creator cannot quality approve', () => transact(tx => reviewDirectShipment({
      tx, actor: buyerReviewActor, commandId: `d14-direct-main-self-review-${tag}`, shipmentLineId: mainShipment.lines[0]!.id,
      version: mainContext.version, snapshotHash: mainContext.snapshotHash, decision: 'APPROVED',
      reason: 'Synthetic self review must fail', checks, evidenceIds: [] })));
  } finally {
    await db.user.update({ where: { id: buyer.id }, data: { role: 'MANAGER' } });
  }
  assert.equal(selfReview.statusCode, 403);
  assert.equal(selfReview.code, 'SELF_APPROVAL_FORBIDDEN');
  await transact(tx => reviewDirectShipment({ tx, actor: qualityActor, commandId: `d14-direct-main-review-${tag}`,
    shipmentLineId: mainShipment.lines[0]!.id, version: mainContext.version,
    snapshotHash: mainContext.snapshotHash, decision: 'APPROVED', reason: 'Independent batch quality review', checks, evidenceIds: [] }));
  mainShipment = await loadDirectShipment(mainCreated.id);
  assert.equal(mainShipment.lines[0]?.reviewStatus, 'APPROVED');
  const reviewReplay = await transact(tx => reviewDirectShipment({ tx, actor: qualityActor,
    commandId: `d14-direct-main-review-${tag}`, shipmentLineId: mainShipment.lines[0]!.id,
    version: mainContext.version, snapshotHash: mainContext.snapshotHash, decision: 'APPROVED',
    reason: 'Independent batch quality review', checks, evidenceIds: [] }));
  assert.deepEqual(reviewReplay, { id: mainCreated.id });
  assert.equal(await directEventCount(mainCreated.id), 2);

  const qualityDispatchCapability = await expectRejected('quality reviewer lacks dispatch capability', () => transact(tx => dispatchDirectShipment({
    tx, actor: qualityActor, commandId: `d14-direct-main-quality-dispatch-${tag}`, shipmentId: mainCreated.id,
    version: mainShipment.version, reason: 'Quality cannot dispatch' })));
  assert.equal(qualityDispatchCapability.statusCode, 403);
  assert.equal(qualityDispatchCapability.code, 'AUTH_FORBIDDEN');
  await db.user.update({ where: { id: quality.id }, data: { role: 'MANAGER' } });
  let qualityDispatch: RejectionRecord;
  try {
    const qualityManageActor = await reloadActor(quality.id);
    qualityDispatch = await expectRejected('quality reviewer cannot dispatch own review', () => transact(tx => dispatchDirectShipment({
      tx, actor: qualityManageActor, commandId: `d14-direct-main-quality-self-dispatch-${tag}`, shipmentId: mainCreated.id,
      version: mainShipment.version, reason: 'Quality reviewer self dispatch must fail' })));
  } finally {
    await db.user.update({ where: { id: quality.id }, data: { role: 'QUALITY_MANAGER' } });
  }
  assert.equal(qualityDispatch.statusCode, 403);
  assert.equal(qualityDispatch.code, 'SELF_APPROVAL_FORBIDDEN');
  const dispatchInput = { actor: buyerActor, commandId: `d14-direct-main-dispatch-${tag}`,
    shipmentId: mainCreated.id, version: mainShipment.version, reason: 'Supplier dispatched synthetic batch' };
  await transact(tx => dispatchDirectShipment({ tx, ...dispatchInput }));
  mainShipment = await loadDirectShipment(mainCreated.id);
  purchase = await loadPurchase(purchase.id);
  let currentOrder = await loadOrder(order.id);
  assert.equal(mainShipment.status, 'DISPATCHED');
  assert.equal(purchase.lines.find(line => line.id === batchPurchaseLine.id)?.directShippedQuantity, 2);
  assert.equal(purchase.lines.find(line => line.id === batchPurchaseLine.id)?.receivedQuantity, 0);
  assert.equal(currentOrder.status, 'SHIPPED');
  assert.deepEqual(await localArtifactCounts(order.id, purchase.id), baselineLocal);
  const dispatchReplay = await transact(tx => dispatchDirectShipment({ tx, ...dispatchInput }));
  assert.deepEqual(dispatchReplay, { id: mainCreated.id });
  assert.equal(await directEventCount(mainCreated.id), 3);

  const receiptInput = { actor: buyerActor, commandId: `d14-direct-main-receipt-1-${tag}`,
    shipmentLineId: mainShipment.lines[0]!.id, version: mainShipment.lines[0]!.version, quantity: 1,
    signedBy: 'Synthetic customer receiver', signedAt: new Date(now.getTime() - 60_000).toISOString(),
    reason: 'Synthetic partial customer receipt', evidenceIds: [mainEvidence.id] };
  await transact(tx => receiveDirectShipment({ tx, ...receiptInput }));
  mainShipment = await loadDirectShipment(mainCreated.id);
  purchase = await loadPurchase(purchase.id);
  currentOrder = await loadOrder(order.id);
  assert.equal(mainShipment.status, 'PARTIALLY_RECEIVED');
  assert.equal(mainShipment.lines[0]?.receivedQuantity, 1);
  assert.equal(purchase.lines.find(line => line.id === batchPurchaseLine.id)?.receivedQuantity, 0);
  assert.equal(currentOrder.status, 'SHIPPED');
  assert.deepEqual(await localArtifactCounts(order.id, purchase.id), baselineLocal);
  const receiptReplay = await transact(tx => receiveDirectShipment({ tx, ...receiptInput }));
  assert.deepEqual(receiptReplay, { id: mainCreated.id });
  assert.equal(await directEventCount(mainCreated.id), 4);

  const overReceipt = await expectRejected('customer receipt overage', () => transact(tx => receiveDirectShipment({
    tx, ...receiptInput, commandId: `d14-direct-main-receipt-over-${tag}`, version: mainShipment.lines[0]!.version, quantity: 2,
  })));
  assert.equal(overReceipt.statusCode, 409);
  mainShipment = await loadDirectShipment(mainCreated.id);
  assert.equal(mainShipment.lines[0]?.receivedQuantity, 1);

  const finalReceipt = await transact(tx => receiveDirectShipment({
    tx, ...receiptInput, commandId: `d14-direct-main-receipt-2-${tag}`, version: mainShipment.lines[0]!.version,
    quantity: 1, reason: 'Synthetic final customer receipt',
  }));
  assert.deepEqual(finalReceipt, { id: mainCreated.id });
  mainShipment = await loadDirectShipment(mainCreated.id);
  purchase = await loadPurchase(purchase.id);
  currentOrder = await loadOrder(order.id);
  assert.equal(mainShipment.status, 'DELIVERED');
  assert.equal(mainShipment.lines[0]?.receivedQuantity, 2);
  assert.equal(purchase.lines.find(line => line.id === batchPurchaseLine.id)?.directShippedQuantity, 2);
  assert.equal(purchase.lines.find(line => line.id === batchPurchaseLine.id)?.receivedQuantity, 0);
  assert.equal(currentOrder.status, 'DELIVERED');
  assert.equal(currentOrder.lines.find(line => line.id === orderBatchLine.id)?.directShippedQuantity, 2);
  assert.equal(await directEventCount(mainCreated.id), 5);
  assert.deepEqual(await localArtifactCounts(order.id, purchase.id), baselineLocal);

  console.log(JSON.stringify({
    result: 'PASS', database: expectedDatabase, tag,
    rfqId: rfq.id, quotationId: quotation.id, orderId: order.id,
    purchaseCommitmentId: purchase.id, mainShipmentId: mainCreated.id,
    serialCancelledShipmentId: serialShipmentId, serialRecreatedShipmentId: serialCreatedAgain.id,
    statuses: ['PREPARED', 'CANCELLED', 'DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED'],
    checks: [
      'modern two-line sale and SUPPLIER_DIRECT purchase source',
      'purchase create/submit/independent approve/confirm with synthetic proof',
      'MANAGER approval is rejected for a FINANCE-level purchase before FINANCE approval',
      'sales inventory-scope denial and quality self-review denial',
      'role capability denials are distinguished from SELF_APPROVAL_FORBIDDEN checks',
      'direct planned overage rejected without version mutation',
      'serial PN/SN claim released only after cancellation and same claim re-prepared',
      'revoked direct evidence blocks dispatch and transaction rolls back',
      'independent quality approval required before dispatch',
      'dispatch increments directShippedQuantity only',
      'partial and final customer receipts preserve purchase receivedQuantity=0',
      'receipt overage rejected',
      'create/review/dispatch/receipt idempotency replay adds no duplicate events',
      'no local stock receipts or inventory transactions were created',
    ],
    mainEventCount: await directEventCount(mainCreated.id),
    localArtifacts: await localArtifactCounts(order.id, purchase.id),
    rejected: [managerApproval, salesCreate, overPlan, staleDispatch, selfReviewCapability, selfReview,
      qualityDispatchCapability, qualityDispatch, overReceipt],
  }, null, 2));
}

try {
  await main();
} finally {
  await db.$disconnect();
}
