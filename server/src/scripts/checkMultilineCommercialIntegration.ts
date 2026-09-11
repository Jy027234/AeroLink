import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { createRfqAggregate } from '../modules/rfqSourcing/index.js';
import { createLineQuotation, loadLineQuotation, hasCurrentLineQuotationApproval } from '../modules/quotationOrder/lineService.js';
import { submitQuotationAggregate, approveQuotationAggregate, acceptQuotationAggregate } from '../modules/quotationOrder/service.js';
import { ensureOrderContractDocument } from '../lib/documentTemplateService.js';
import { transitionQuotationStatus, transitionRfqStatus } from '../lib/transactionStateService.js';

// Explicit disposable database opt-in; this script never seeds an ordinary
// development or production database. Fixtures remain for independent review.
const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_MULTILINE_INTEGRATION !== 'true'
  || !['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || !/^\/aerolink_multiline_test_[a-z0-9_]+$/.test(databaseUrl.pathname)) {
  throw new Error('Use an explicitly opted-in local aerolink_multiline_test_* disposable database');
}
const db = new PrismaClient();
const transaction = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(fn, {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000,
});
const suffix = randomUUID().slice(0, 8);
try {
  const [owner, finance, manager, customer] = await transaction(async tx => Promise.all([
    tx.user.create({ data: { name: 'Synthetic owner', email: `owner-${suffix}@example.invalid`, password: 'unusable-test-hash', role: 'SALES' } }),
    tx.user.create({ data: { name: 'Synthetic finance', email: `finance-${suffix}@example.invalid`, password: 'unusable-test-hash', role: 'FINANCE' } }),
    tx.user.create({ data: { name: 'Synthetic manager', email: `manager-${suffix}@example.invalid`, password: 'unusable-test-hash', role: 'MANAGER' } }),
    tx.customer.create({ data: { name: 'Synthetic multiline customer', contactName: 'Fixture', email: 'fixture@example.invalid' } }),
  ]));
  const demands = [4, 3, 5].map((quantity, index) => ({
    partNumber: `MULTILINE-${suffix}-${index + 1}`, quantity, requiredDate: new Date('2027-01-15'),
    uom: 'EA', conditionCode: 'NE', certificateRequired: true,
  }));
  const rfq = await transaction(tx => createRfqAggregate(tx, {
    customerId: customer.id, createdBy: owner.id, ...demands[0], lines: demands,
  }, owner.id));
  assert.equal(rfq.lines.length, 3);
  assert.equal(rfq.lineItemsMode, true);
  const inputLines = rfq.lines.slice(0, 2).map((line, index) => ({
    rfqLineId: line.id, partNumber: line.partNumber, quantity: line.quantity,
    unitPrice: index === 0 ? 1000.0001 : 2000.1234, costPrice: 600.0001,
    costSourceType: 'MANUAL', costSourceReason: 'Synthetic integration approved cost estimate',
  }));
  const create = () => transaction(tx => createLineQuotation({ tx, actorId: owner.id,
    input: { rfqId: rfq.id, customerId: customer.id, currency: 'USD', lines: inputLines }, authorizeRfq: () => {},
  }));
  const created = await create();
  assert.equal(created.quotation.lines.length, 2);
  assert.equal(created.quotation.totalPriceDecimal?.toString(), '10000.3706');
  const submitted = await transaction(tx => submitQuotationAggregate({ tx, quotationId: created.quotation.id, actorId: owner.id, expectedVersion: created.quotation.version }));
  await assert.rejects(transaction(tx => approveQuotationAggregate({ tx, quotationId: created.quotation.id, actorId: manager.id, actorRole: 'MANAGER', action: 'approve', expectedVersion: submitted.quotation.version })));
  await assert.rejects(transaction(tx => approveQuotationAggregate({ tx, quotationId: created.quotation.id, actorId: owner.id, actorRole: 'FINANCE', action: 'approve', expectedVersion: submitted.quotation.version })));
  const approved = await transaction(tx => approveQuotationAggregate({ tx, quotationId: created.quotation.id, actorId: finance.id, actorRole: 'FINANCE', action: 'approve', expectedVersion: submitted.quotation.version }));
  const current = await transaction(tx => loadLineQuotation(tx, approved.quotation.id));
  assert(hasCurrentLineQuotationApproval(current), 'approval survives Decimal JSON serialization');
  const firstLine = current.lines[0];
  const secondLine = current.lines[1];
  const accept = (version: number, lines: Array<{ quotationLineId: string; quantity: number }>, id = current.id) => transaction(tx => acceptQuotationAggregate({
    tx, quotationId: id, actorId: owner.id, expectedVersion: version, lines,
    ensureContractDocument: args => ensureOrderContractDocument(args),
  }));
  const first = await accept(current.version, [{ quotationLineId: firstLine.id, quantity: 1 }]);
  assert.equal(first.order.quantity, 1);
  assert.equal(first.order.totalAmountDecimal?.toString(), '1000.0001');
  const firstContract = await db.generatedDocument.findUniqueOrThrow({ where: { id: first.generatedDocument.id } });
  assert(firstContract.contentHtml.includes(firstLine.partNumber));
  assert(!firstContract.contentHtml.includes(secondLine.partNumber), 'partial contract contains only accepted lines');
  assert.equal(await db.orderLine.count({ where: { orderId: first.order.id } }), 1);
  assert(hasCurrentLineQuotationApproval(await transaction(tx => loadLineQuotation(tx, current.id))), 'accept counters must not invalidate approval');
  await assert.rejects(transaction(tx => approveQuotationAggregate({ tx, quotationId: current.id, actorId: finance.id, actorRole: 'FINANCE', action: 'reject', expectedVersion: first.quotation.version })), /已分批成交/);
  await assert.rejects(accept(current.version, [{ quotationLineId: firstLine.id, quantity: 1 }]), { code: 'STATE_CONFLICT' });
  await assert.rejects(accept(first.quotation.version, [{ quotationLineId: firstLine.id, quantity: 4 }]));
  assert.equal(await db.order.count({ where: { quotationId: current.id } }), 1, 'failed acceptance leaves no order');
  const second = await accept(first.quotation.version, [{ quotationLineId: firstLine.id, quantity: 3 }, { quotationLineId: secondLine.id, quantity: 3 }]);
  assert.notEqual(first.order.id, second.order.id);
  assert.equal(second.quotation.status, 'ACCEPTED');
  assert.equal(second.order.totalAmountDecimal?.toString(), '9000.3705');
  assert.equal(await db.order.count({ where: { quotationId: current.id } }), 2);
  const finalLines = await db.quotationLine.findMany({ where: { quotationId: current.id }, orderBy: { lineNo: 'asc' } });
  assert.deepEqual(finalLines.map(line => line.acceptedQuantity), [4, 3]);
  const sum = await db.order.aggregate({ where: { quotationId: current.id }, _sum: { totalAmountDecimal: true } });
  assert(sum._sum.totalAmountDecimal?.equals(current.totalPriceDecimal!), 'partial order totals reconcile to quotation');
  const alternative = await create();
  const altSubmitted = await transaction(tx => submitQuotationAggregate({ tx, quotationId: alternative.quotation.id, actorId: owner.id }));
  const altApproved = await transaction(tx => approveQuotationAggregate({ tx, quotationId: alternative.quotation.id, actorId: finance.id, actorRole: 'FINANCE', action: 'approve', expectedVersion: altSubmitted.quotation.version }));
  await assert.rejects(accept(altApproved.quotation.version, [{ quotationLineId: alternative.quotation.lines[0].id, quantity: 1 }], alternative.quotation.id), /需求行剩余/);
  assert.equal(await db.order.count({ where: { quotationId: alternative.quotation.id } }), 0);
  const concurrentQuote = await transaction(tx => createLineQuotation({ tx, actorId: owner.id, authorizeRfq: () => {}, input: {
    rfqId: rfq.id, customerId: customer.id, currency: 'USD', lines: [{
      rfqLineId: rfq.lines[2].id, partNumber: rfq.lines[2].partNumber, quantity: 5,
      unitPrice: 100, costPrice: 50, costSourceType: 'MANUAL', costSourceReason: 'Synthetic concurrent quantity check',
    }],
  } }));
  await transaction(tx => submitQuotationAggregate({ tx, quotationId: concurrentQuote.quotation.id, actorId: owner.id }));
  const concurrentApproved = await transaction(tx => approveQuotationAggregate({ tx, quotationId: concurrentQuote.quotation.id, actorId: manager.id, actorRole: 'MANAGER', action: 'approve' }));
  const contenders = await Promise.allSettled([1, 2].map(() => accept(concurrentApproved.quotation.version, [
    { quotationLineId: concurrentQuote.quotation.lines[0].id, quantity: 1 },
  ], concurrentQuote.quotation.id)));
  assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1, 'only one concurrent claim may commit');
  assert.equal(await db.order.count({ where: { quotationId: concurrentQuote.quotation.id } }), 1);
  assert.equal((await db.quotationLine.findUniqueOrThrow({ where: { id: concurrentQuote.quotation.lines[0].id } })).acceptedQuantity, 1);
  const rollbackInventoryCheck = new Error('rollback synthetic shared inventory check');
  await assert.rejects(transaction(async tx => {
    const partNumber = `SHARED-${suffix}`;
    const inventory = await tx.inventoryDetail.create({ data: { quantity: 3, unitCost: 50, type: 'OWN', location: 'TEST',
      inventoryItem: { create: { partNumber, description: 'Synthetic shared inventory source' } },
    } });
    const sharedDemands = [1, 2].map(() => ({ ...demands[0], partNumber, quantity: 2 }));
    const sharedRfq = await createRfqAggregate(tx, { customerId: customer.id, createdBy: owner.id, ...sharedDemands[0], lines: sharedDemands }, owner.id);
    const input = { rfqId: sharedRfq.id, customerId: customer.id, currency: 'USD', lines: sharedRfq.lines.map(line => ({
      rfqLineId: line.id, partNumber, quantity: 2, unitPrice: 100, costPrice: 50, costSourceType: 'INVENTORY_DETAIL', costSourceId: inventory.id,
    })) };
    await assert.rejects(createLineQuotation({ tx, actorId: owner.id, input, authorizeRfq: () => {} }), /共同引用的库存可用数量不足/);
    await tx.inventoryDetail.update({ where: { id: inventory.id }, data: { quantity: 4 } });
    const sharedQuote = await createLineQuotation({ tx, actorId: owner.id, input, authorizeRfq: () => {} });
    await submitQuotationAggregate({ tx, quotationId: sharedQuote.quotation.id, actorId: owner.id });
    await tx.inventoryDetail.update({ where: { id: inventory.id }, data: { quantity: 3 } });
    await assert.rejects(approveQuotationAggregate({ tx, quotationId: sharedQuote.quotation.id, actorId: manager.id, actorRole: 'MANAGER', action: 'approve' }), /共同引用的库存可用数量不足/);
    assert.equal(await tx.approval.count({ where: { quotationId: sharedQuote.quotation.id } }), 0);
    throw rollbackInventoryCheck;
  }), error => error === rollbackInventoryCheck);
  const rollbackStateCheck = new Error('rollback synthetic terminal state check');
  await assert.rejects(transaction(async tx => {
    const sent = await tx.quotation.update({ where: { id: alternative.quotation.id }, data: { status: 'SENT', statusEnum: 'SENT' } });
    await transitionQuotationStatus(tx, { id: sent.id, currentStatus: 'SENT', currentVersion: sent.version,
      nextStatus: 'WITHDRAWN', actorId: owner.id, reasonCode: 'SYNTHETIC_WITHDRAWAL' });
    const withdrawnLines = await tx.quotationLine.findMany({ where: { quotationId: sent.id } });
    assert(withdrawnLines.every(line => line.status === 'CANCELLED'), 'withdrawal must satisfy the real line-state constraint');
    await tx.rfqLine.update({ where: { id: rfq.lines[2].id }, data: { status: 'CANCELLED' } });
    const quotedRfq = await tx.rFQ.update({ where: { id: rfq.id }, data: { status: 'ORDERED', statusEnum: 'ORDERED' } });
    await transitionRfqStatus(tx, { id: rfq.id, currentStatus: 'ORDERED', currentVersion: quotedRfq.version,
      nextStatus: 'COMPLETED', actorId: owner.id, reasonCode: 'SYNTHETIC_COMPLETION' });
    const completedLines = await tx.rfqLine.findMany({ where: { rfqId: rfq.id }, orderBy: { lineNo: 'asc' } });
    assert.deepEqual(completedLines.map(line => line.status), ['COMPLETED', 'COMPLETED', 'CANCELLED']);
    throw rollbackStateCheck;
  }), error => error === rollbackStateCheck);
  console.log(JSON.stringify({ result: 'PASS', rfqId: rfq.id, quotationId: current.id, demandLines: 3, quotedLines: 2,
    orders: [first.order.id, second.order.id], total: sum._sum.totalAmountDecimal?.toString(),
    checks: ['aggregate approval threshold', 'self approval denied', 'Decimal snapshot stable', 'partial contract', 'stale version rollback', 'over acceptance rollback', 'two orders', 'cross quotation demand guard', 'concurrent acceptance single winner', 'shared inventory aggregate capacity', 'withdrawal database constraint', 'cancelled demand preserved'],
  }, null, 2));
} finally { await db.$disconnect(); }
