import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { CapabilityActor } from '../lib/capabilityPolicy.js';
import { createPurchaseCommitment, transitionPurchaseCommitment } from '../modules/procurementSettlement/purchaseCommands.js';
import type { PurchaseLineInput } from '../modules/procurementSettlement/purchaseSources.js';

/**
 * Synthetic, local-only command-chain evidence for D14.
 *
 * This script deliberately does not start the API or the outbox worker.  The
 * command service writes only the webhook/socket outbox rows in the same
 * transaction; no delivery side effect is performed here.
 */
const expectedDatabase = 'aerolink_procurement_test_commands_20260909';
const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_PURCHASE_COMMANDS_INTEGRATION !== 'true'
  || !['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.pathname !== `/${expectedDatabase}`) {
  throw new Error(`Explicit opt-in and local ${expectedDatabase} database required`);
}

const db = new PrismaClient();
const transact = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async tx => {
  const result = await run(tx);
  // Prisma 5 may resolve an interactive transaction before PostgreSQL reports
  // a deferred trigger failure at COMMIT.  Surface it inside the callback.
  await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  return result;
}, { isolationLevel: 'Serializable', timeout: 30_000 });

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

async function eventCount(purchaseCommitmentId: string) {
  return db.purchaseCommitmentEvent.count({ where: { purchaseCommitmentId } });
}

async function loadPurchase(id: string) {
  return db.purchaseCommitment.findUniqueOrThrow({
    where: { id },
    include: { lines: true },
  });
}

const tag = randomUUID().replaceAll('-', '').slice(0, 12);
const now = new Date();
const future = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
const promisedDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

try {
  const sales = await db.user.create({
    data: {
      email: `d14-command-sales-${tag}@example.invalid`,
      name: `D14 synthetic sales ${tag}`,
      password: 'synthetic-only',
      role: 'SALES',
      department: 'Sales',
    },
  });
  const buyer = await db.user.create({
    data: {
      email: `d14-command-buyer-${tag}@example.invalid`,
      name: `D14 synthetic buyer ${tag}`,
      password: 'synthetic-only',
      role: 'MANAGER',
      department: 'Sales',
    },
  });
  const approver = await db.user.create({
    data: {
      email: `d14-command-approver-${tag}@example.invalid`,
      name: `D14 synthetic approver ${tag}`,
      password: 'synthetic-only',
      role: 'MANAGER',
      department: 'Sales',
    },
  });
  const administrator = await db.user.create({
    data: {
      email: `d14-command-admin-${tag}@example.invalid`,
      name: `D14 synthetic administrator ${tag}`,
      password: 'synthetic-only',
      role: 'ADMIN',
      department: 'Sales',
    },
  });
  const customer = await db.customer.create({
    data: {
      name: `D14 synthetic customer ${tag}`,
      contactName: 'Synthetic buyer',
      email: `d14-command-customer-${tag}@example.invalid`,
    },
  });
  const supplier = await db.supplier.create({
    data: { name: `D14 synthetic supplier ${tag}` },
  });
  const wrongSupplier = await db.supplier.create({
    data: { name: `D14 wrong source supplier ${tag}` },
  });
  const partNumber = `D14-CMD-PN-${tag}`;
  const rfq = await db.rFQ.create({
    data: {
      rfqNumber: `D14-CMD-RFQ-${tag}`,
      customerId: customer.id,
      partNumber,
      quantity: 2,
      requiredDate: future,
      createdBy: sales.id,
      status: 'OPEN',
      lines: {
        create: {
          lineNo: 1,
          partNumber,
          quantity: 2,
          uom: 'EA',
          conditionCode: 'NE',
          certificateRequired: false,
          requiredDate: future,
          status: 'OPEN',
        },
      },
    },
    include: { lines: true },
  });
  const rfqLine = rfq.lines[0];
  assert.ok(rfqLine, 'synthetic RFQ line was not created');
  const quotation = await db.quotation.create({
    data: {
      lineItemsMode: true,
      quoteNumber: `D14-CMD-Q-${tag}`,
      rfqId: rfq.id,
      customerId: customer.id,
      partNumber,
      quantity: 2,
      unitPrice: 4000,
      totalPrice: 8000,
      costPrice: 2500,
      margin: 3000,
      currency: 'USD',
      unitPriceDecimal: new Prisma.Decimal('4000.0000'),
      totalPriceDecimal: new Prisma.Decimal('8000.0000'),
      costPriceDecimal: new Prisma.Decimal('2500.0000'),
      status: 'APPROVED',
      statusEnum: 'APPROVED',
      expiryDate: future,
      validityDays: 7,
      validityDeadline: future,
      createdBy: sales.id,
      lines: {
        create: {
          lineNo: 1,
          rfqLineId: rfqLine.id,
          partNumber,
          uom: 'EA',
          quantity: 2,
          unitPrice: new Prisma.Decimal('4000.0000'),
          costPrice: new Prisma.Decimal('2500.0000'),
          lineTotal: new Prisma.Decimal('8000.0000'),
          marginAmount: new Prisma.Decimal('3000.0000'),
          marginPercent: new Prisma.Decimal('37.5000'),
          currency: 'USD',
          status: 'APPROVED',
        },
      },
    },
    include: { lines: true },
  });
  const quotationLine = quotation.lines[0];
  assert.ok(quotationLine, 'synthetic quotation line was not created');
  const order = await db.order.create({
    data: {
      lineItemsMode: true,
      orderNumber: `D14-CMD-ORDER-${tag}`,
      soNumber: `D14-CMD-SO-${tag}`,
      quotationId: quotation.id,
      customerId: customer.id,
      partNumber,
      quantity: 2,
      totalAmount: 8000,
      totalAmountDecimal: new Prisma.Decimal('8000.0000'),
      status: 'SO_CREATED',
      statusEnum: 'SO_CREATED',
      lines: {
        create: {
          lineNo: 1,
          quotationLineId: quotationLine.id,
          partNumber,
          uom: 'EA',
          quantity: 2,
          unitPrice: new Prisma.Decimal('4000.0000'),
          lineTotal: new Prisma.Decimal('8000.0000'),
          currency: 'USD',
        },
      },
    },
    include: { lines: true },
  });
  const orderLine = order.lines[0];
  assert.ok(orderLine, 'synthetic order line was not created');
  const supplierQuote = await db.supplierQuote.create({
    data: {
      rfqId: rfq.id,
      rfqLineId: rfqLine.id,
      supplierId: supplier.id,
      partNumber,
      quantity: 2,
      unitPrice: 2500,
      totalPrice: 5000,
      unitPriceDecimal: new Prisma.Decimal('2500.0000'),
      totalPriceDecimal: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
      currencyReviewStatus: 'VERIFIED',
      status: 'pending',
      leadTimeDays: 7,
      validUntil: future,
    },
  });
  const wrongSourceQuote = await db.supplierQuote.create({
    data: {
      rfqId: rfq.id,
      rfqLineId: rfqLine.id,
      supplierId: wrongSupplier.id,
      partNumber,
      quantity: 2,
      unitPrice: 2500,
      totalPrice: 5000,
      unitPriceDecimal: new Prisma.Decimal('2500.0000'),
      totalPriceDecimal: new Prisma.Decimal('5000.0000'),
      currency: 'USD',
      currencyReviewStatus: 'VERIFIED',
      status: 'pending',
      leadTimeDays: 7,
      validUntil: future,
    },
  });
  const euroSourceQuote = await db.supplierQuote.create({
    data: {
      rfqId: rfq.id,
      rfqLineId: rfqLine.id,
      supplierId: supplier.id,
      partNumber,
      quantity: 2,
      unitPrice: 2500,
      totalPrice: 5000,
      unitPriceDecimal: new Prisma.Decimal('2500.0000'),
      totalPriceDecimal: new Prisma.Decimal('5000.0000'),
      currency: 'EUR',
      currencyReviewStatus: 'VERIFIED',
      status: 'pending',
      leadTimeDays: 7,
      validUntil: future,
    },
  });
  const proof = await db.storedObject.create({
    data: {
      objectKey: `synthetic/d14-purchase/${tag}/confirmation-proof.pdf`,
      sha256: 'b'.repeat(64),
      sizeBytes: 16,
      mimeType: 'application/pdf',
      originalName: 'synthetic-confirmation-proof.pdf',
      ownerId: approver.id,
      status: 'AVAILABLE',
      metadata: { synthetic: true, tag, purpose: 'D14 purchase confirmation' },
    },
  });

  const buyerActor = actor(buyer);
  const approverActor = actor(approver);
  const adminActor = actor(administrator);
  const line: PurchaseLineInput = {
    orderLineId: orderLine.id,
    quantity: 2,
    promisedDate,
    fulfillmentMode: 'STOCK_RECEIPT',
    source: { type: 'SUPPLIER_QUOTE', supplierQuoteId: supplierQuote.id },
  };
  const created = await transact(tx => createPurchaseCommitment({
    tx,
    actor: buyerActor,
    orderId: order.id,
    supplierId: supplier.id,
    lines: [line],
    paymentTerms: 'NET 30 synthetic',
    commandId: `d14-create-${tag}`,
  }));
  const purchaseId = created.id;
  let purchase = await loadPurchase(purchaseId);
  assert.equal(purchase.status, 'DRAFT');
  assert.equal(purchase.version, 1);
  assert.equal(purchase.totalCost.toFixed(4), '5000.0000');
  assert.equal(purchase.lines[0]?.unitCost.toFixed(4), '2500.0000');
  assert.equal(await eventCount(purchaseId), 1);

  const replayCreate = await transact(tx => createPurchaseCommitment({
    tx,
    actor: buyerActor,
    orderId: order.id,
    supplierId: supplier.id,
    lines: [line],
    paymentTerms: 'NET 30 synthetic',
    commandId: `d14-create-${tag}`,
  }));
  assert.deepEqual(replayCreate, { id: purchaseId });
  assert.equal(await eventCount(purchaseId), 1, 'create replay appended a duplicate event');

  const submit = await transact(tx => transitionPurchaseCommitment({
    tx,
    actor: buyerActor,
    purchaseCommitmentId: purchaseId,
    version: purchase.version,
    action: 'SUBMIT',
    reason: 'Synthetic source and USD review complete',
    commandId: `d14-submit-${tag}`,
  }));
  assert.deepEqual(submit, { id: purchaseId });
  purchase = await loadPurchase(purchaseId);
  assert.equal(purchase.status, 'PENDING_APPROVAL');
  assert.equal(purchase.version, 2);
  assert.ok(purchase.approvalSnapshot);
  assert.equal(await eventCount(purchaseId), 2);

  const replaySubmit = await transact(tx => transitionPurchaseCommitment({
    tx,
    actor: buyerActor,
    purchaseCommitmentId: purchaseId,
    // Replays must resend the exact original request hash, including the
    // optimistic-lock version that was submitted the first time.
    version: 1,
    action: 'SUBMIT',
    reason: 'Synthetic source and USD review complete',
    commandId: `d14-submit-${tag}`,
  }));
  assert.deepEqual(replaySubmit, { id: purchaseId });
  assert.equal(await eventCount(purchaseId), 2, 'submit replay appended a duplicate event');

  const selfApproval = await expectRejected('self approval', () => transact(tx => transitionPurchaseCommitment({
    tx,
    actor: buyerActor,
    purchaseCommitmentId: purchaseId,
    version: 2,
    action: 'APPROVE',
    reason: 'Synthetic self-approval must fail',
    commandId: `d14-self-approve-${tag}`,
  })));
  assert.equal(selfApproval.code, 'SELF_APPROVAL_FORBIDDEN');
  const adminApproval = await expectRejected('administrator approval', () => transact(tx => transitionPurchaseCommitment({
    tx,
    actor: adminActor,
    purchaseCommitmentId: purchaseId,
    version: 2,
    action: 'APPROVE',
    reason: 'Synthetic administrator approval must fail',
    commandId: `d14-admin-approve-${tag}`,
  })));
  assert.equal(adminApproval.statusCode, 403);
  purchase = await loadPurchase(purchaseId);
  assert.equal(purchase.status, 'PENDING_APPROVAL');
  assert.equal(purchase.version, 2);
  assert.equal(await eventCount(purchaseId), 2, 'rejected approvals changed event history');

  await transact(tx => transitionPurchaseCommitment({
    tx,
    actor: approverActor,
    purchaseCommitmentId: purchaseId,
    version: purchase.version,
    action: 'APPROVE',
    reason: 'Independent MANAGER approval at USD 5,000.0000',
    commandId: `d14-approve-${tag}`,
  }));
  purchase = await loadPurchase(purchaseId);
  assert.equal(purchase.status, 'APPROVED');
  assert.equal(purchase.version, 3);
  assert.equal(purchase.approvedById, approver.id);
  assert.equal(await eventCount(purchaseId), 3);

  await transact(tx => transitionPurchaseCommitment({
    tx,
    actor: approverActor,
    purchaseCommitmentId: purchaseId,
    version: purchase.version,
    action: 'CONFIRM',
    reason: 'Synthetic supplier confirmation with bound proof',
    supplierReferenceNo: `SUP-CONF-${tag}`,
    evidenceIds: [proof.id],
    commandId: `d14-confirm-${tag}`,
  }));
  purchase = await loadPurchase(purchaseId);
  assert.equal(purchase.status, 'CONFIRMED');
  assert.equal(purchase.version, 4);
  assert.equal(purchase.confirmedById, approver.id);
  const boundProof = await db.storedObject.findUniqueOrThrow({ where: { id: proof.id } });
  assert.equal(boundProof.domain, 'purchase_commitment');
  assert.equal(boundProof.resourceId, purchaseId);
  assert.equal(boundProof.version, 2);
  assert.equal(await eventCount(purchaseId), 4);

  await transact(tx => transitionPurchaseCommitment({
    tx,
    actor: buyerActor,
    purchaseCommitmentId: purchaseId,
    version: purchase.version,
    action: 'CANCEL',
    reason: 'Synthetic cancellation before any receipt or direct shipment',
    commandId: `d14-cancel-${tag}`,
  }));
  purchase = await loadPurchase(purchaseId);
  assert.equal(purchase.status, 'CANCELLED');
  assert.equal(purchase.version, 5);
  assert.equal(purchase.lines[0]?.cancelledQuantity, 2);
  assert.equal(await eventCount(purchaseId), 5);

  const beforeRejectedCreates = await db.purchaseCommitment.count({ where: { orderId: order.id } });
  const wrongSource = await expectRejected('supplier source identity mismatch', () => transact(tx => createPurchaseCommitment({
    tx,
    actor: buyerActor,
    orderId: order.id,
    supplierId: supplier.id,
    lines: [{ ...line, source: { type: 'SUPPLIER_QUOTE', supplierQuoteId: wrongSourceQuote.id } }],
    commandId: `d14-wrong-source-${tag}`,
  })));
  assert.equal(wrongSource.statusCode, 409);
  const wrongCurrency = await expectRejected('unverified currency', () => transact(tx => createPurchaseCommitment({
    tx,
    actor: buyerActor,
    orderId: order.id,
    supplierId: supplier.id,
    lines: [{ ...line, source: { type: 'SUPPLIER_QUOTE', supplierQuoteId: euroSourceQuote.id } }],
    commandId: `d14-eur-source-${tag}`,
  })));
  assert.equal(wrongCurrency.statusCode, 409);
  const overage = await expectRejected('purchase quantity overage', () => transact(tx => createPurchaseCommitment({
    tx,
    actor: buyerActor,
    orderId: order.id,
    supplierId: supplier.id,
    lines: [{ ...line, quantity: 3 }],
    commandId: `d14-overage-${tag}`,
  })));
  assert.equal(overage.statusCode, 409);
  assert.equal(await db.purchaseCommitment.count({ where: { orderId: order.id } }), beforeRejectedCreates);
  assert.equal(await eventCount(purchaseId), 5);

  const outboxChannels = await db.outboxEvent.findMany({
    where: { aggregateType: 'ORDER', aggregateId: order.id },
    select: { channel: true },
  });
  assert.ok(outboxChannels.length >= 5);
  assert.ok(outboxChannels.every(event => event.channel === 'WEBHOOK' || event.channel === 'SOCKET'));
  console.log(JSON.stringify({
    result: 'PASS',
    database: expectedDatabase,
    tag,
    orderId: order.id,
    purchaseCommitmentId: purchaseId,
    statuses: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CANCELLED'],
    eventCount: await eventCount(purchaseId),
    checks: [
      'modern RFQ/quotation/order/source identity seed',
      'Decimal(18,4) USD source and server-calculated total',
      'create command idempotency replay without duplicate event',
      'submit command idempotency replay without duplicate event',
      'self approval rejected',
      'administrator approval rejected without commercial authority',
      'independent MANAGER approval at 5,000 USD',
      'supplier confirmation binds AVAILABLE synthetic proof',
      'confirmed commitment cancellation before receipt/direct shipment',
      'supplier identity, currency, and quantity overage rejected',
      'outbox contains webhook/socket only; no worker or email delivery started',
    ],
    rejected: [wrongSource, wrongCurrency, overage],
  }, null, 2));
} finally {
  await db.$disconnect();
}
