import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import db from '../lib/prisma.js';
import { runIdempotentOperation } from '../lib/idempotencyService.js';
import { resolveReceiptAllocationSource } from '../modules/procurementSettlement/receiptAllocationAccess.js';
import { createRfqAggregate } from '../modules/rfqSourcing/index.js';
import { createQuotationAggregate, submitQuotationAggregate, approveQuotationAggregate, acceptQuotationAggregate } from '../modules/quotationOrder/service.js';
import { reserveLineInventory, getAllocationFulfillmentContext, createAllocationFulfillmentReview, consumeAllocatedInventory,
  createShipment, receiveShipmentReturn, getReturnReleaseContext, releaseShipmentReturn } from '../modules/inventoryQuality/index.js';

const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_RECEIPT_FULFILLMENT !== 'true' || !['localhost', '127.0.0.1'].includes(url.hostname)
  || url.port !== '55970' || url.pathname !== '/aerolink_procurement_test_receipts_20260909') {
  throw new Error('Explicit opt-in and dedicated local receipt test clone on port 55970 required');
}
const tag = randomUUID().slice(0, 8);
const tx = async <T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) => (await runIdempotentOperation({
  actorId: 'synthetic-receipt-fulfillment', scope: 'synthetic', requestHash: 'synthetic',
}, async transaction => ({ payload: await operation(transaction) }),
{ isolationLevel: 'Serializable', timeout: 20_000, validateDeferredConstraints: true })).payload;
const checks = { identity: true, documents: true, conditionAndLife: true, customerRequirements: true };

try {
  const candidates = await db.stockReceiptLine.findMany({ where: { status: 'ACCEPTED', quantity: 1,
    ...(process.env.AEROLINK_RECEIPT_FULFILLMENT_LINE_ID ? { id: process.env.AEROLINK_RECEIPT_FULFILLMENT_LINE_ID } : {}),
    inventoryDetail: { quantity: 1 } }, include: { inventoryDetail: { include: { inventoryItem: true, allocations: { include: { assignments: true } } } },
    purchaseCommitmentLine: { include: { orderLine: { include: { order: { include: { quotation: { include: { creator: true } } } } } } } } } });
  const receipt = candidates.find(row => row.inventoryDetail && row.inventoryDetail.allocations.every(a => a.consumedQuantity === 0)
    && !row.purchaseCommitmentLine.orderLine.order.certificateRequired && !row.purchaseCommitmentLine.orderLine.order.inspectionRequired);
  assert.ok(receipt?.inventoryDetail, 'Run receipt integration first; requires an unconsumed accepted one-unit no-certificate fixture');
  const detail = receipt.inventoryDetail;
  const source = receipt.purchaseCommitmentLine;
  const originalOrder = source.orderLine.order;
  const receivedBefore = source.receivedQuantity;
  const department = originalOrder.quotation.creator.department;
  const operator = await db.user.create({ data: { name: 'Synthetic receipt fulfillment operator',
    email: `receipt-fulfill-${tag}@example.invalid`, role: 'ADMIN', password: 'unusable', department } });
  const quality = await db.user.create({ data: { name: 'Synthetic independent receipt fulfillment quality',
    email: `receipt-fulfill-qc-${tag}@example.invalid`, role: 'QUALITY_MANAGER', password: 'unusable', department } });
  const approver = await db.user.create({ data: { name: 'Synthetic independent resale approver',
    email: `receipt-resale-approve-${tag}@example.invalid`, role: 'MANAGER', password: 'unusable', department } });
  const evidence = (ownerId: string) => db.storedObject.create({ data: { objectKey: `synthetic-receipt-fulfillment/${randomUUID()}`,
    ownerId, sha256: 'c'.repeat(64), sizeBytes: 20, mimeType: 'application/pdf', originalName: 'synthetic-receipt-proof.pdf' } });
  const operatorEvidence = await evidence(operator.id);
  const qualityEvidence = await evidence(quality.id);
  let assignment = detail.allocations.flatMap(a => a.assignments).find(a => a.assignedQuantity - a.releasedQuantity - a.consumedQuantity >= 1);
  if (!assignment) {
    const reserveCommandId = randomUUID();
    await tx(transaction => reserveLineInventory({ tx: transaction, actor: operator,
      quotationLineId: source.orderLine.quotationLineId, orderLineId: source.orderLineId,
      allocations: [{ inventoryDetailId: detail.id, quantity: 1, stockReceiptLineId: receipt.id }], commandId: reserveCommandId }));
    assignment = await db.allocationAssignment.findFirstOrThrow({ where: { allocation: { commandId: reserveCommandId } } });
  }
  const consume = async (assignmentId: string) => {
    const context = await getAllocationFulfillmentContext(db, assignmentId, 1);
    const review = await tx(transaction => createAllocationFulfillmentReview(transaction, { assignmentId, quantity: 1,
      snapshotHash: context.snapshotHash, approved: true, evidenceIds: [qualityEvidence.id],
      verifiedSerialNumber: detail.serialNumber || '', verifiedBatchNumber: detail.batchNumber || '',
      checks, reason: 'Synthetic independent receipt-derived stock quality check' }, quality));
    return tx(transaction => consumeAllocatedInventory({ tx: transaction, actor: operator, assignmentId,
      quantity: 1, reviewId: review.id, commandId: randomUUID() }));
  };
  const first = await consume(assignment.id);
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: detail.id } })).quantity, 0);
  const shipment = await tx(transaction => createShipment({ tx: transaction, actor: operator, orderId: originalOrder.id,
    carrier: 'Synthetic', trackingNumber: `RECEIPT-RETURN-${tag}`, origin: 'Synthetic warehouse', destination: 'Synthetic customer',
    evidenceIds: [], lines: [{ outboundTransactionId: first.transaction.id, quantity: 1 }], commandId: randomUUID() }));
  const hold = await tx(transaction => receiveShipmentReturn({ tx: transaction, actor: operator,
    shipmentLineId: shipment.lines[0].id, quantity: 1, evidenceIds: [operatorEvidence.id],
    verifiedSerialNumber: detail.serialNumber || '', verifiedBatchNumber: detail.batchNumber || '',
    reason: 'Synthetic customer refusal and actual return to custody', commandId: randomUUID() }));
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: detail.id } })).quantity, 0);
  const returnContext = await getReturnReleaseContext({ tx: db, actor: quality, returnHoldId: hold.id });
  const release = { returnHoldId: hold.id, snapshotHash: returnContext.snapshotHash, evidenceIds: [qualityEvidence.id],
    verifiedSerialNumber: detail.serialNumber || '', verifiedBatchNumber: detail.batchNumber || '', checks,
    reason: 'Synthetic independent release of receipt-derived returned stock', commandId: randomUUID() };
  await tx(transaction => releaseShipmentReturn({ tx: transaction, actor: quality, ...release }));
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: detail.id } })).quantity, 1);
  await assert.rejects(tx(transaction => reserveLineInventory({ tx: transaction, actor: operator,
    quotationLineId: source.orderLine.quotationLineId, orderLineId: source.orderLineId,
    allocations: [{ inventoryDetailId: detail.id, quantity: 1, stockReceiptLineId: receipt.id }], commandId: randomUUID() })),
  /采购|来源|验收|订单已关闭/);
  await assert.rejects(tx(transaction => resolveReceiptAllocationSource(transaction, { inventoryDetailId: detail.id,
    stockReceiptLineId: receipt.id, orderLineId: source.orderLineId, quantity: 1 })), /采购|来源|验收/);

  const demand = { partNumber: detail.inventoryItem.partNumber, quantity: 1, uom: detail.inventoryItem.unitOfMeasure,
    conditionCode: detail.conditionCode, requiredDate: new Date('2027-01-15'), certificateRequired: false };
  const rfq = await tx(transaction => createRfqAggregate(transaction, { ...demand, customerId: originalOrder.customerId,
    createdBy: operator.id, lines: [demand] }, operator.id));
  const offer = await tx(transaction => createQuotationAggregate({ tx: transaction, actorId: operator.id,
    rfqId: rfq.id, customerId: originalOrder.customerId, currency: 'USD', validityDays: 7,
    lines: [{ rfqLineId: rfq.lines[0].id, partNumber: demand.partNumber, quantity: 1, unitPrice: 100,
      costPrice: 50, costSourceType: 'MANUAL', costSourceReason: 'Synthetic returned stock resale cost' }] }));
  await tx(transaction => submitQuotationAggregate({ tx: transaction, quotationId: offer.quotation.id, actorId: operator.id }));
  await tx(transaction => approveQuotationAggregate({ tx: transaction, quotationId: offer.quotation.id,
    actorId: approver.id, actorRole: approver.role, action: 'approve' }));
  const quoteLine = await db.quotationLine.findFirstOrThrow({ where: { quotationId: offer.quotation.id } });
  await assert.rejects(tx(transaction => reserveLineInventory({ tx: transaction, actor: operator,
    quotationLineId: quoteLine.id, allocations: [{ inventoryDetailId: detail.id, quantity: 1 }], commandId: randomUUID() })), /来源/);
  const resale = await tx(transaction => reserveLineInventory({ tx: transaction, actor: operator,
    quotationLineId: quoteLine.id, allocations: [{ inventoryDetailId: detail.id, quantity: 1, sourceReturnHoldId: hold.id }], commandId: randomUUID() }));
  const currentOffer = await db.quotation.findUniqueOrThrow({ where: { id: offer.quotation.id } });
  const accepted = await tx(transaction => acceptQuotationAggregate({ tx: transaction, quotationId: currentOffer.id,
    actorId: operator.id, expectedVersion: currentOffer.version, lines: [{ quotationLineId: quoteLine.id, quantity: 1,
      allocations: [{ allocationId: resale.allocations[0].id, quantity: 1 }] }],
    ensureContractDocument: async () => ({ id: 'synthetic-receipt-resale-contract', title: 'Synthetic contract' }) }));
  // Match the explicit no-certificate synthetic demand, as in the D12/D13 fixture.
  await db.order.update({ where: { id: accepted.order.id }, data: { certificateRequired: false, inspectionRequired: false } });
  const resaleAssignment = await db.allocationAssignment.findFirstOrThrow({ where: { allocationId: resale.allocations[0].id } });
  await consume(resaleAssignment.id);
  await tx(transaction => releaseShipmentReturn({ tx: transaction, actor: quality, ...release }));
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: detail.id } })).quantity, 0);
  assert.equal((await db.purchaseCommitmentLine.findUniqueOrThrow({ where: { id: source.id } })).receivedQuantity, receivedBefore);
  const ledger = await db.inventoryTransaction.findMany({ where: { inventoryDetailId: detail.id },
    select: { id: true, type: true, quantity: true, stockReceiptLineId: true, assignmentId: true, returnHold: { select: { id: true } } } });
  assert.equal(ledger.filter(row => row.type === 'OUTBOUND').length, 2);
  assert.equal(ledger.filter(row => row.type === 'RETURN').length, 1);
  assert.equal(ledger.filter(row => row.type === 'INBOUND').length, 1);
  assert.equal(ledger.reduce((sum, row) => sum + row.quantity, 0), 0);
  console.log(JSON.stringify({ result: 'PASS', tag, receiptLineId: receipt.id, inventoryDetailId: detail.id,
    originalOrderId: originalOrder.id, resaleOrderId: accepted.order.id, returnHoldId: hold.id, receivedBefore, ledger,
    checks: ['received stock passes independent D12 review and actual outbound', 'return custody does not restore available quantity',
      'independent return release restores one unit', 'consumed original receipt source cannot be reused',
      'receipt-derived resale cannot omit explicit return source', 'separate return source fulfills a new OWN sale',
      'release replay after resale does not restore stock', 'one INBOUND + two OUTBOUND + one RETURN reconcile to zero'] }, null, 2));
} finally { await db.$disconnect(); }
