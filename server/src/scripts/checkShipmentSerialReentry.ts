import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import db from '../lib/prisma.js';
import { runIdempotentOperation } from '../lib/idempotencyService.js';
import { createRfqAggregate } from '../modules/rfqSourcing/index.js';
import { createQuotationAggregate, submitQuotationAggregate, approveQuotationAggregate, acceptQuotationAggregate } from '../modules/quotationOrder/service.js';
import { reserveLineInventory, getAllocationFulfillmentContext, createAllocationFulfillmentReview, consumeAllocatedInventory,
  createShipment, receiveShipmentReturn, getReturnReleaseContext, releaseShipmentReturn, updateInventoryAggregate } from '../modules/inventoryQuality/index.js';

const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_SHIPMENT_INTEGRATION !== 'true' || !['localhost', '127.0.0.1'].includes(url.hostname)
  || !/^\/aerolink_shipment_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error('Explicit opt-in and dedicated local aerolink_shipment_test_* database required');
const tag = randomUUID().slice(0, 8);
const tx = async <T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) => (await runIdempotentOperation({
  actorId: 'synthetic', scope: 'synthetic', requestHash: 'synthetic',
}, async transaction => ({ payload: await operation(transaction) }),
{ isolationLevel: 'Serializable', timeout: 20_000, validateDeferredConstraints: true })).payload;

try {
  const operator = await db.user.create({ data: { name: 'Synthetic return operator', email: `serial-stock-${tag}@example.invalid`, role: 'ADMIN', password: 'unusable' } });
  const approver = await db.user.create({ data: { name: 'Synthetic approver', email: `serial-approve-${tag}@example.invalid`, role: 'MANAGER', password: 'unusable' } });
  const quality = await db.user.create({ data: { name: 'Synthetic independent quality', email: `serial-quality-${tag}@example.invalid`, role: 'QUALITY_MANAGER', password: 'unusable' } });
  const customer = await db.customer.create({ data: { name: `Serial customer ${tag}`, contactName: 'Synthetic', email: `serial-customer-${tag}@example.invalid` } });
  const partNumber = `SERIAL-RETURN-${tag}`;
  const serialNumber = `SN-${tag}`;
  const detail = await db.inventoryDetail.create({ data: { quantity: 1, unitCost: 50, location: 'SYNTHETIC', serialNumber,
    inventoryItem: { create: { partNumber, description: 'Synthetic serial return fixture', trackingType: 'SERIAL' } } } });
  const evidence = async (ownerId: string) => db.storedObject.create({ data: { objectKey: `synthetic-shipment/${randomUUID()}`, ownerId,
    sha256: 'a'.repeat(64), sizeBytes: 20, mimeType: 'application/pdf', originalName: 'synthetic-serial-proof.pdf' } });
  // Metadata-only fixtures for service invariants. Real uploaded bytes are tested by HTTP/browser tests.
  const operatorEvidence = await evidence(operator.id);
  const qualityEvidence = await evidence(quality.id);
  const makeOffer = async () => {
    const demand = { partNumber, quantity: 1, requiredDate: new Date('2027-01-15'), certificateRequired: false };
    const rfq = await tx(transaction => createRfqAggregate(transaction, { ...demand, customerId: customer.id, createdBy: operator.id, lines: [demand] }, operator.id));
    const result = await tx(transaction => createQuotationAggregate({ tx: transaction, actorId: operator.id, rfqId: rfq.id,
      customerId: customer.id, currency: 'USD', validityDays: 7, lines: [{ rfqLineId: rfq.lines[0].id, partNumber, quantity: 1,
        unitPrice: 100, costPrice: 50, costSourceType: 'MANUAL', costSourceReason: 'Synthetic serial integration cost' }] }));
    await tx(transaction => submitQuotationAggregate({ tx: transaction, quotationId: result.quotation.id, actorId: operator.id }));
    await tx(transaction => approveQuotationAggregate({ tx: transaction, quotationId: result.quotation.id, actorId: approver.id, actorRole: approver.role, action: 'approve' }));
    const line = await db.quotationLine.findFirstOrThrow({ where: { quotationId: result.quotation.id } });
    return { quotationId: result.quotation.id, lineId: line.id };
  };
  const reserve = (lineId: string) => tx(transaction => reserveLineInventory({ tx: transaction, actor: operator,
    quotationLineId: lineId, allocations: [{ inventoryDetailId: detail.id, quantity: 1 }], commandId: randomUUID() }));
  const checks = { identity: true, documents: true, conditionAndLife: true, customerRequirements: true };
  const sellAndConsume = async (offer: Awaited<ReturnType<typeof makeOffer>>) => {
    const reservation = await reserve(offer.lineId);
    const current = await db.quotation.findUniqueOrThrow({ where: { id: offer.quotationId } });
    const accepted = await tx(transaction => acceptQuotationAggregate({ tx: transaction, quotationId: offer.quotationId,
      actorId: operator.id, expectedVersion: current.version, lines: [{ quotationLineId: offer.lineId, quantity: 1,
        allocations: [{ allocationId: reservation.allocations[0].id, quantity: 1 }] }],
      ensureContractDocument: async () => ({ id: 'synthetic-serial-contract', title: 'Synthetic contract' }) }));
    // Demand explicitly has no certificate requirement; avoid unrelated legacy header defaults in this service fixture.
    await db.order.update({ where: { id: accepted.order.id }, data: { certificateRequired: false, inspectionRequired: false } });
    const assignment = await db.allocationAssignment.findFirstOrThrow({ where: { allocationId: reservation.allocations[0].id } });
    const context = await getAllocationFulfillmentContext(db, assignment.id, 1);
    const review = await tx(transaction => createAllocationFulfillmentReview(transaction, { assignmentId: assignment.id, quantity: 1,
      snapshotHash: context.snapshotHash, approved: true, evidenceIds: [qualityEvidence.id], verifiedSerialNumber: serialNumber,
      verifiedBatchNumber: '', checks, reason: 'Synthetic independent serial check' }, quality));
    const consumed = await tx(transaction => consumeAllocatedInventory({ tx: transaction, actor: operator, assignmentId: assignment.id,
      quantity: 1, reviewId: review.id, commandId: randomUUID() }));
    assert.equal(consumed.transaction.fulfillmentReviewId, review.id);
    return { orderId: accepted.order.id, transactionId: consumed.transaction.id, assignmentId: assignment.id };
  };
  const first = await sellAndConsume(await makeOffer());
  const shipment = await tx(transaction => createShipment({ tx: transaction, actor: operator, orderId: first.orderId,
    carrier: 'Synthetic', trackingNumber: `SERIAL-${tag}`, origin: 'A', destination: 'B', evidenceIds: [],
    lines: [{ outboundTransactionId: first.transactionId, quantity: 1 }], commandId: randomUUID() }));
  // Rejected by the customer before receipt: return is legitimate without inventing a delivery receipt.
  const hold = await tx(transaction => receiveShipmentReturn({ tx: transaction, actor: operator, shipmentLineId: shipment.lines[0].id,
    quantity: 1, evidenceIds: [operatorEvidence.id], verifiedSerialNumber: serialNumber, verifiedBatchNumber: '',
    reason: 'Synthetic rejected delivery returned into custody', commandId: randomUUID() }));
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: detail.id } })).quantity, 0);
  const secondOffer = await makeOffer();
  await assert.rejects(reserve(secondOffer.lineId), { statusCode: 409 });
  const context = await getReturnReleaseContext({ tx: db, actor: quality, returnHoldId: hold.id });
  const releaseInput = { returnHoldId: hold.id, snapshotHash: context.snapshotHash, evidenceIds: [qualityEvidence.id],
    verifiedSerialNumber: serialNumber, verifiedBatchNumber: '', checks, reason: 'Synthetic independent return release', commandId: randomUUID() };
  await assert.rejects(tx(transaction => releaseShipmentReturn({ tx: transaction, actor: operator, ...releaseInput })), /本人|自|经办|权限|无权/);
  await tx(transaction => releaseShipmentReturn({ tx: transaction, actor: quality, ...releaseInput }));
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: detail.id } })).quantity, 1);
  await sellAndConsume(secondOffer);
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: detail.id } })).quantity, 0);
  await tx(transaction => releaseShipmentReturn({ tx: transaction, actor: quality, ...releaseInput }));
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: detail.id } })).quantity, 0, 'old release replay must not put the serial back in stock');
  await tx(transaction => updateInventoryAggregate(transaction, { id: detail.id, itemData: {}, detailData: { quantity: 1 }, quantityProvided: true,
    quantity: 1, actorId: operator.id, include: { inventoryItem: true }, notes: 'Synthetic attempt to reuse old return authorization' }));
  const thirdOffer = await makeOffer();
  await assert.rejects(reserve(thirdOffer.lineId), /出库|放行|退货/);
  const [outbound, returns] = await Promise.all([
    db.inventoryTransaction.count({ where: { inventoryDetailId: detail.id, type: 'OUTBOUND' } }),
    db.inventoryTransaction.count({ where: { inventoryDetailId: detail.id, type: 'RETURN' } }),
  ]);
  assert.equal(outbound, 2); assert.equal(returns, 1);
  console.log(JSON.stringify({ result: 'PASS', tag, database: url.pathname.slice(1), outbound, returns,
    checks: ['unreceived refusal may return to quarantine without saleable stock', 'independent release permits one legitimate serial resale',
      'old release replay does not restore stock', 'later outbound invalidates prior return authorization even after manual quantity restoration'] }, null, 2));
} finally { await db.$disconnect(); }
