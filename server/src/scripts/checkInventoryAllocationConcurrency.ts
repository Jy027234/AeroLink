import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import db from '../lib/prisma.js';
import { runIdempotentOperation } from '../lib/idempotencyService.js';
import { createRfqAggregate } from '../modules/rfqSourcing/index.js';
import { createQuotationAggregate, submitQuotationAggregate, approveQuotationAggregate, acceptQuotationAggregate } from '../modules/quotationOrder/service.js';
import { reviseQuotationAggregate } from '../modules/quotationOrder/revisionService.js';
import { reserveLineInventory, releaseLineInventory, getLineInventoryAvailability, updateInventoryAggregate,
  getAllocationFulfillmentContext, createAllocationFulfillmentReview, consumeAllocatedInventory } from '../modules/inventoryQuality/index.js';
import { expireUnassignedAllocations } from '../modules/inventoryQuality/allocationExpiry.js';

const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_ALLOCATION_INTEGRATION !== 'true' || !['localhost', '127.0.0.1'].includes(url.hostname)
  || !/^\/aerolink_allocation_test_[a-z0-9_]+$/.test(url.pathname)) {
  throw new Error('Explicit opt-in and dedicated local aerolink_allocation_test_* database required');
}
const tag = randomUUID().slice(0, 8);
const checks: string[] = [];
const transaction = async <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => {
  const result = await runIdempotentOperation({ actorId: 'fixture', scope: 'fixture', requestHash: 'fixture' },
    async tx => ({ payload: await run(tx) }), { isolationLevel: 'Serializable', timeout: 20_000, validateDeferredConstraints: true });
  return result.payload;
};
try {
  const actor = await db.user.create({ data: { name: 'Synthetic stock operator', email: `stock-${tag}@example.invalid`, password: 'unusable', role: 'ADMIN' } });
  const reviewer = await db.user.create({ data: { name: 'Synthetic independent reviewer', email: `quality-${tag}@example.invalid`, password: 'unusable', role: 'QUALITY_MANAGER' } });
  const approver = await db.user.create({ data: { name: 'Synthetic quote approver', email: `manager-${tag}@example.invalid`, password: 'unusable', role: 'MANAGER' } });
  const customer = await db.customer.create({ data: { name: `Allocation test ${tag}`, contactName: 'Synthetic buyer', email: 'allocation@example.invalid' } });
  const createOffer = async (partNumber: string, quantity: number, validityDays = 7) => {
    const demand = { partNumber, quantity, requiredDate: new Date('2027-01-15'), certificateRequired: false };
    const rfq = await transaction(tx => createRfqAggregate(tx, { ...demand, customerId: customer.id, createdBy: actor.id, lines: [demand] }, actor.id));
    const input = { rfqId: rfq.id, customerId: customer.id, currency: 'USD', validityDays,
      lines: [{ rfqLineId: rfq.lines[0].id, partNumber, quantity, unitPrice: 100, costPrice: 50,
        costSourceType: 'MANUAL', costSourceReason: 'Synthetic integration cost evidence' }] };
    const created = await transaction(tx => createQuotationAggregate({ ...input, tx, actorId: actor.id }));
    await transaction(tx => submitQuotationAggregate({ tx, quotationId: created.quotation.id, actorId: actor.id }));
    await transaction(tx => approveQuotationAggregate({ tx, quotationId: created.quotation.id, actorId: approver.id, actorRole: approver.role, action: 'approve' }));
    const line = await db.quotationLine.findFirstOrThrow({ where: { quotationId: created.quotation.id } });
    return { id: created.quotation.id, line, input };
  };
  const createStock = (partNumber: string, quantity: number, serialNumber?: string) => db.inventoryDetail.create({ data: {
    quantity, unitCost: 50, location: 'SYNTHETIC', type: 'OWN', batchNumber: serialNumber ? null : `B-${tag}`, serialNumber,
    inventoryItem: { create: { partNumber, description: 'Synthetic integration inventory', trackingType: serialNumber ? 'SERIAL' : 'BATCH' } },
  } });
  const reserve = (lineId: string, detailId: string, quantity: number, key = randomUUID()) => runIdempotentOperation({
    actorId: actor.id, scope: `integration-reserve-${tag}`, key, requestHash: JSON.stringify([lineId, detailId, quantity]),
  }, async tx => ({ payload: await reserveLineInventory({ tx, actor, quotationLineId: lineId,
    allocations: [{ inventoryDetailId: detailId, quantity }], commandId: key }) }),
  { isolationLevel: 'Serializable', timeout: 20_000, validateDeferredConstraints: true });

  const stock = await createStock(`CONCURRENT-${tag}`, 10);
  const first = await createOffer(`CONCURRENT-${tag}`, 10);
  const second = await createOffer(`CONCURRENT-${tag}`, 10);
  const race = await Promise.allSettled([reserve(first.line.id, stock.id, 6), reserve(second.line.id, stock.id, 6)]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: stock.id } })).allocatedQuantity, 6);
  const winner = await db.inventoryAllocation.findFirstOrThrow({ where: { inventoryDetailId: stock.id } });
  await transaction(tx => releaseLineInventory({ tx, actor, allocationId: winner.id, quantity: 6, reason: 'Synthetic race reset', commandId: randomUUID() }));
  await Promise.all([reserve(first.line.id, stock.id, 4), reserve(second.line.id, stock.id, 4)]);
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: stock.id } })).allocatedQuantity, 8);
  checks.push('concurrent 6+6 cannot oversell 10; concurrent 4+4 both commit after bounded retry');

  const serial = await createStock(`SERIAL-${tag}`, 1, `S-${tag}`);
  const serialOffer = await createOffer(`SERIAL-${tag}`, 2);
  const serialRace = await Promise.allSettled([reserve(serialOffer.line.id, serial.id, 1), reserve(serialOffer.line.id, serial.id, 1)]);
  assert.equal(serialRace.filter(result => result.status === 'fulfilled').length, 1);
  checks.push('serial-number stock has exactly one active allocation');
  const serialAllocation = await db.inventoryAllocation.findFirstOrThrow({ where: { inventoryDetailId: serial.id } });
  const serialQuote = await db.quotation.findUniqueOrThrow({ where: { id: serialOffer.id } });
  const serialAccepted = await transaction(tx => acceptQuotationAggregate({ tx, quotationId: serialOffer.id, actorId: actor.id,
    expectedVersion: serialQuote.version, lines: [{ quotationLineId: serialOffer.line.id, quantity: 1,
      allocations: [{ allocationId: serialAllocation.id, quantity: 1 }] }],
    ensureContractDocument: async () => ({ id: 'synthetic-serial-contract', title: 'Synthetic serial contract' }) }));
  await db.order.update({ where: { id: serialAccepted.order.id }, data: { certificateRequired: false, inspectionRequired: false } });
  const serialAssignment = await db.allocationAssignment.findFirstOrThrow({ where: { allocationId: serialAllocation.id } });
  const serialContext = await getAllocationFulfillmentContext(db, serialAssignment.id, 1);
  const serialReview = await transaction(tx => createAllocationFulfillmentReview(tx, {
    assignmentId: serialAssignment.id, quantity: 1, snapshotHash: serialContext.snapshotHash, approved: true,
    evidenceIds: [], verifiedSerialNumber: serial.serialNumber!, verifiedBatchNumber: '',
    checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
    reason: 'Synthetic serial identity independently verified' }, reviewer));
  await transaction(tx => consumeAllocatedInventory({ tx, actor, assignmentId: serialAssignment.id, quantity: 1,
    reviewId: serialReview.id, commandId: randomUUID() }));
  await transaction(tx => updateInventoryAggregate(tx, { id: serial.id, itemData: {}, detailData: { quantity: 1 },
    include: { inventoryItem: true }, quantityProvided: true, quantity: 1, actorId: actor.id, notes: 'Synthetic adversarial quantity restoration' }));
  await assert.rejects(reserve(serialOffer.line.id, serial.id, 1), /已有出库记录/);
  await assert.rejects(transaction(tx => updateInventoryAggregate(tx, {
    id: serial.id, itemData: { trackingType: 'BATCH' }, detailData: { serialNumber: null },
    include: { inventoryItem: true }, quantityProvided: false, actorId: actor.id,
    notes: 'Synthetic attempt to erase outbound serial identity',
  })), /历史|分配|出库/);
  const protectedSerial = await db.inventoryDetail.findUniqueOrThrow({ where: { id: serial.id }, include: { inventoryItem: true } });
  assert.equal(protectedSerial.serialNumber, serial.serialNumber);
  assert.equal(protectedSerial.inventoryItem.trackingType, 'SERIAL');
  checks.push('restoring physical quantity cannot resell an outbound serial without controlled return authorization');
  checks.push('historical allocation/outbound identity cannot be erased to bypass serial reuse protection');

  const mainStock = await createStock(`FLOW-${tag}`, 20);
  const offer = await createOffer(`FLOW-${tag}`, 20);
  const replayKey = randomUUID();
  const replayRace = await Promise.all([reserve(offer.line.id, mainStock.id, 10, replayKey), reserve(offer.line.id, mainStock.id, 10, replayKey)]);
  assert.equal(replayRace.filter(result => result.replayed).length, 1);
  assert.equal(await db.inventoryAllocation.count({ where: { commandId: replayKey } }), 1);
  const allocation = await db.inventoryAllocation.findFirstOrThrow({ where: { commandId: replayKey } });
  const current = await db.quotation.findUniqueOrThrow({ where: { id: offer.id } });
  const accepted = await transaction(tx => acceptQuotationAggregate({ tx, quotationId: offer.id, actorId: actor.id, expectedVersion: current.version,
    lines: [{ quotationLineId: offer.line.id, quantity: 4, allocations: [{ allocationId: allocation.id, quantity: 4 }] }],
    // Contract rendering is covered separately; this test exercises quantity transactions only.
    ensureContractDocument: async () => ({ id: 'synthetic-contract', title: 'Synthetic contract' }) }));
  const assignment = await db.allocationAssignment.findFirstOrThrow({ where: { allocationId: allocation.id } });
  // Simulate the ordinary response cache being pruned after its replay window.
  await db.idempotencyRecord.deleteMany({ where: { actorId: actor.id, idempotencyKey: replayKey } });
  const persistentReplay = await reserve(offer.line.id, mainStock.id, 10, replayKey);
  assert.equal(persistentReplay.payload.replayed, true);
  assert.equal(await db.inventoryAllocation.count({ where: { commandId: replayKey } }), 1);
  checks.push('persistent reserve replay survives later assignments and response-cache pruning');
  const invalidKey = randomUUID();
  await assert.rejects(runIdempotentOperation({ actorId: actor.id, scope: 'invalid-allocation-fixture', key: invalidKey, requestHash: invalidKey },
    async tx => {
      await tx.allocationAssignment.create({ data: { allocationId: allocation.id, orderLineId: assignment.orderLineId,
        assignedQuantity: 7, commandId: invalidKey, commandLineNo: 1, createdById: actor.id } });
      return { payload: { mustNotReturn: true } };
    }, { isolationLevel: 'Serializable', validateDeferredConstraints: true }), /conserve quantity/);
  assert.equal(await db.allocationAssignment.count({ where: { commandId: invalidKey } }), 0);
  assert.equal(await db.idempotencyRecord.count({ where: { idempotencyKey: invalidKey } }), 0);
  checks.push('deferred constraint failure rejects API transaction and rolls back both assignment and cached success');
  assert.equal((await db.quotationLine.findUniqueOrThrow({ where: { id: offer.line.id } })).reservedQuantity, 6);
  await transaction(tx => reviseQuotationAggregate({ tx, quotationId: offer.id, actorId: actor.id, version: accepted.quotation.version,
    reason: 'Synthetic remaining offer revision', quotation: { ...offer.input, lines: offer.input.lines.map(line => ({ ...line, quantity: 16 })) },
    authorize: () => {}, authorizeRfq: () => {} }));
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: mainStock.id } })).allocatedQuantity, 4);
  assert.equal((await db.allocationAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).releasedQuantity, 0);
  checks.push('same-key concurrency writes once; explicit acceptance assigns 4; revision releases only unassigned 6');

  // This synthetic order explicitly has no certificate requirement, matching its demand.
  await db.order.update({ where: { id: accepted.order.id }, data: { certificateRequired: false, inspectionRequired: false } });
  const makeReview = async (quantity: number) => {
    const context = await getAllocationFulfillmentContext(db, assignment.id, quantity);
    const input = { assignmentId: assignment.id, quantity, snapshotHash: context.snapshotHash, approved: true,
      evidenceIds: [], verifiedSerialNumber: '', verifiedBatchNumber: mainStock.batchNumber!,
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true }, reason: 'Synthetic no-certificate requirement reviewed' };
    await assert.rejects(transaction(tx => createAllocationFulfillmentReview(tx, input, actor)), /审核自己的|经办人|权限/);
    return transaction(tx => createAllocationFulfillmentReview(tx, input, reviewer));
  };
  const staleReview = await makeReview(2);
  await db.inventoryDetail.update({ where: { id: mainStock.id }, data: { storageCondition: 'Synthetic updated quality evidence' } });
  await assert.rejects(transaction(tx => consumeAllocatedInventory({ tx, actor, assignmentId: assignment.id, quantity: 2, reviewId: staleReview.id, commandId: randomUUID() })), /变化|失效|重新/);
  const review = await makeReview(2);
  await transaction(tx => consumeAllocatedInventory({ tx, actor, assignmentId: assignment.id, quantity: 2, reviewId: review.id, commandId: randomUUID() }));
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: mainStock.id } })).quantity, 18);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: accepted.order.id } })).outboundQuantity, 2);
  await assert.rejects(transaction(tx => consumeAllocatedInventory({ tx, actor, assignmentId: assignment.id, quantity: 2, reviewId: review.id, commandId: randomUUID() })), /审核|数量/);
  const lastReview = await makeReview(2);
  const consumeReleaseRace = await Promise.allSettled([
    transaction(tx => consumeAllocatedInventory({ tx, actor, assignmentId: assignment.id, quantity: 2, reviewId: lastReview.id, commandId: randomUUID() })),
    transaction(tx => releaseLineInventory({ tx, actor, allocationId: allocation.id, assignmentId: assignment.id, quantity: 2, reason: 'Synthetic cancellation', commandId: randomUUID() })),
  ]);
  assert.equal(consumeReleaseRace.filter(result => result.status === 'fulfilled').length, 1);
  const facts = await db.inventoryAllocation.findUniqueOrThrow({ where: { id: allocation.id } });
  assert.equal(facts.allocatedQuantity - facts.releasedQuantity - facts.consumedQuantity, 0);
  const view = await getLineInventoryAvailability({ tx: db, actor, quotationLineId: offer.line.id });
  assert.equal(view.activeQuantity, 0);
  assert(!/unitCost|costPrice|totalAmount/.test(JSON.stringify(view)));
  checks.push('independent review, stale evidence and consumed review rejected; old revised order still fulfills; consume/release race conserves stock');

  const expiryStock = await createStock(`EXPIRY-${tag}`, 10);
  const expiryOffer = await createOffer(`EXPIRY-${tag}`, 8);
  const futureOffer = await createOffer(`EXPIRY-${tag}`, 2, 30);
  const expiryReserve = await reserve(expiryOffer.line.id, expiryStock.id, 8);
  await reserve(futureOffer.line.id, expiryStock.id, 2);
  const expiryQuote = await db.quotation.findUniqueOrThrow({ where: { id: expiryOffer.id } });
  const expiryAccepted = await transaction(tx => acceptQuotationAggregate({ tx, quotationId: expiryOffer.id, actorId: actor.id,
    expectedVersion: expiryQuote.version, lines: [{ quotationLineId: expiryOffer.line.id, quantity: 3,
      allocations: [{ allocationId: expiryReserve.payload.allocations[0].id, quantity: 3 }] }],
    ensureContractDocument: async () => ({ id: 'synthetic-expiry-contract', title: 'Synthetic expiry contract' }) }));
  const afterDeadline = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  let released = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await expireUnassignedAllocations({ now: afterDeadline, limit: 1 });
    released += result.releasedQuantity;
    if (result.releasedAllocations === 0) break;
    assert(attempt < 99, 'expiry cleanup did not drain its bounded fixture');
  }
  assert(released >= 5);
  const expiryView = await getLineInventoryAvailability({ tx: db, actor, quotationLineId: expiryOffer.line.id });
  assert.equal(expiryView.unassignedQuantity, 0);
  assert.equal(expiryView.assignedActiveQuantity, 3);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: expiryAccepted.order.id } })).outboundQuantity, 0);
  assert.equal((await getLineInventoryAvailability({ tx: db, actor, quotationLineId: futureOffer.line.id })).unassignedQuantity, 2);
  const expiryEventCount = await db.inventoryAllocationEvent.count({ where: { commandId: { startsWith: 'allocation-expiry:' } } });
  await expireUnassignedAllocations({ now: afterDeadline, limit: 1 });
  assert.equal(await db.inventoryAllocationEvent.count({ where: { commandId: { startsWith: 'allocation-expiry:' } } }), expiryEventCount);
  checks.push('expiry pagination drains unused holds while preserving assigned orders and future holds; repeat adds no event');
  console.log(JSON.stringify({ result: 'PASS', tag, database: url.pathname.slice(1), checks }, null, 2));
} finally { await db.$disconnect(); }
