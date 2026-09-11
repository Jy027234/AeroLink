import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import prisma from '../lib/prisma.js';
import { createFulfillmentReview, getFulfillmentReviewContext, outboundInventoryForOrder, reserveInventoryForQuotation, type FulfillmentReviewInput } from '../modules/inventoryQuality/index.js';
import { transitionOrderAggregate, updateOrderAggregate } from '../modules/quotationOrder/index.js';

// Explicit disposable-database guard: this script creates test records and
// never runs against the developer's configured application database.
const target = new URL(process.env.DATABASE_URL || '');
if (process.env.AEROLINK_SAFETY_INTEGRATION !== 'true' || target.hostname !== '127.0.0.1' || target.pathname !== '/aerolink_review') {
  throw new Error('Requires AEROLINK_SAFETY_INTEGRATION=true and an isolated 127.0.0.1/aerolink_review database');
}
const prefix = `safety-${crypto.randomUUID()}`;
const transactionOptions = { isolationLevel: 'Serializable' as const };

try {
  const fixture = await prisma.$transaction(async (tx) => {
    const sales = await tx.user.create({ data: { email: `${prefix}-sales@example.invalid`, name: 'Test sales', password: 'not-a-login-hash', role: 'SALES' } });
    const quality = await tx.user.create({ data: { email: `${prefix}-quality@example.invalid`, name: 'Test quality', password: 'not-a-login-hash', role: 'QUALITY_MANAGER' } });
    const customer = await tx.customer.create({ data: { name: 'Safety test customer', contactName: 'Test', email: `${prefix}-customer@example.invalid` } });
    const item = await tx.inventoryItem.create({ data: { partNumber: prefix, description: 'Safety test batch', trackingType: 'BATCH' } });
    const detail = await tx.inventoryDetail.create({ data: { inventoryItemId: item.id, quantity: 10, batchNumber: 'B1', location: 'TEST', unitCost: 10 } });
    const rfq = await tx.rFQ.create({ data: { rfqNumber: prefix, customerId: customer.id, partNumber: prefix, quantity: 10, createdBy: sales.id, requiredDate: new Date('2099-01-01') } });
    const quotation = await tx.quotation.create({ data: { quoteNumber: prefix, rfqId: rfq.id, customerId: customer.id, partNumber: prefix, quantity: 10, unitPrice: 20, totalPrice: 200, costPrice: 10, margin: 50, createdBy: sales.id, status: 'APPROVED', statusEnum: 'APPROVED', expiryDate: new Date('2099-01-01') } });
    const order = await tx.order.create({ data: { orderNumber: prefix, soNumber: prefix, quotationId: quotation.id, customerId: customer.id, partNumber: prefix, quantity: 10, totalAmount: 200 } });
    await reserveInventoryForQuotation(tx, { inventoryDetailId: detail.id, quotationId: quotation.id, quantity: 10, actorId: sales.id });
    const file = await tx.storedObject.create({ data: { objectKey: `test/${prefix}`, sha256: 'test-content-v1', mimeType: 'application/pdf', sizeBytes: 1, ownerId: quality.id } });
    return { sales, quality, detail, order, file };
  });
  const outbound = () => prisma.$transaction((tx) => outboundInventoryForOrder(tx, { inventoryDetailId: fixture.detail.id, orderId: fixture.order.id, quantity: 4, actorId: fixture.sales.id }), transactionOptions);
  await assert.rejects(outbound, { code: 'QUALITY_REVIEW_REQUIRED' });
  await assert.rejects(prisma.$transaction((tx) => transitionOrderAggregate(tx, { id: fixture.order.id, nextStatus: 'SHIPPED', actorId: fixture.sales.id, reasonCode: 'TEST' })), { code: 'FULFILLMENT_REQUIRED' });
  await assert.rejects(prisma.$transaction((tx) => updateOrderAggregate(tx, { id: fixture.order.id, data: { inspectionPassed: true }, include: {} })), { code: 'QUALITY_REVIEW_REQUIRED' });
  const approve = async () => prisma.$transaction(async (tx) => {
    const context = await getFulfillmentReviewContext(tx, fixture.order.id, 4);
    const input: FulfillmentReviewInput = { orderId: fixture.order.id, quantity: 4, snapshotHash: context.snapshotHash, approved: true, evidenceIds: [fixture.file.id], verifiedSerialNumber: '', verifiedBatchNumber: 'B1', reason: 'Checked customer evidence and batch identity; life restrictions not applicable.', checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true } };
    return createFulfillmentReview(tx, input, { id: fixture.quality.id, role: 'quality_manager' });
  }, transactionOptions);
  await approve();
  const results = await Promise.allSettled([outbound(), outbound()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, `exactly one concurrent outbound succeeds: ${results.map((result) => result.status === 'rejected' ? String(result.reason) : 'success').join('; ')}`);
  const [detail, order, ledger] = await Promise.all([
    prisma.inventoryDetail.findUniqueOrThrow({ where: { id: fixture.detail.id } }),
    prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } }),
    prisma.inventoryTransaction.findMany({ where: { orderId: fixture.order.id, type: 'OUTBOUND' } }),
  ]);
  assert.equal(detail.quantity, 6); assert.equal(order.outboundQuantity, 4); assert.equal(ledger.length, 1);
  await approve();
  await prisma.storedObject.update({ where: { id: fixture.file.id }, data: { version: 2, sha256: 'test-content-v2' } });
  await assert.rejects(outbound, { code: 'QUALITY_REVIEW_STALE' });
  assert.equal((await prisma.inventoryDetail.findUniqueOrThrow({ where: { id: fixture.detail.id } })).quantity, 6);
  console.log('PASS: missing review, manual shipped bypass, ordinary quality edits, concurrent outbound and replaced evidence (real PostgreSQL).');
} finally {
  await prisma.$disconnect();
}
