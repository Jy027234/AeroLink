import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { createRfqAggregate } from '../modules/rfqSourcing/index.js';
import { createQuotationAggregate } from '../modules/quotationOrder/service.js';

const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_ALLOCATION_INTEGRATION !== 'true'
  || !['localhost', '127.0.0.1'].includes(url.hostname)
  || !/^\/aerolink_allocation_test_[a-z0-9_]+$/.test(url.pathname)) {
  throw new Error('Explicit opt-in and local aerolink_allocation_test_* database required');
}
const db = new PrismaClient();
const transact = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async tx => {
  const result = await run(tx);
  // Prisma 5's interactive commit can discard a deferred-constraint error;
  // surface it as an explicit query before the transaction callback returns.
  await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  return result;
},
  { isolationLevel: 'Serializable', timeout: 20_000 });
const tag = randomUUID().slice(0, 8);
try {
  const actor = await db.user.create({ data: { name: 'Allocation schema fixture', email: `allocation-${tag}@example.invalid`, password: 'unusable' } });
  const customer = await db.customer.create({ data: { name: `Allocation schema ${tag}`, contactName: 'Synthetic customer', email: 'allocation@example.invalid' } });
  const rfq = await transact(tx => createRfqAggregate(tx, { customerId: customer.id, createdBy: actor.id,
    partNumber: `ALLOC-${tag}`, quantity: 10, requiredDate: new Date('2027-01-15'),
    lines: [{ partNumber: `ALLOC-${tag}`, quantity: 10, requiredDate: new Date('2027-01-15') }] }, actor.id));
  const quote = await transact(tx => createQuotationAggregate({ tx, actorId: actor.id, rfqId: rfq.id,
    customerId: customer.id, currency: 'USD', validityDays: 7, lines: [{ rfqLineId: rfq.lines![0].id,
      partNumber: `ALLOC-${tag}`, quantity: 10, unitPrice: 100, costPrice: 50,
      costSourceType: 'MANUAL', costSourceReason: 'Synthetic database constraint fixture' }] }));
  const line = await db.quotationLine.findFirstOrThrow({ where: { quotationId: quote.quotation.id } });
  const detail = await db.inventoryDetail.create({ data: { quantity: 10, unitCost: 50, location: 'TEST',
    inventoryItem: { create: { partNumber: `ALLOC-${tag}`, description: 'Synthetic allocation fixture' } } } });
  const order = await db.order.create({ data: { orderNumber: `O-${tag}`, soNumber: `SO-${tag}`,
    lineItemsMode: true, quotationId: quote.quotation.id, customerId: customer.id, partNumber: `ALLOC-${tag}`,
    quantity: 5, totalAmount: 500, totalAmountDecimal: 500, status: 'SO_CREATED', statusEnum: 'SO_CREATED',
    lines: { create: { quotationLineId: line.id, lineNo: 1, partNumber: line.partNumber, quantity: 5, unitPrice: 100, lineTotal: 500 } },
  }, include: { lines: true } });
  await assert.rejects(db.inventoryDetail.update({ where: { id: detail.id }, data: { allocatedQuantity: 1 } }), /projection does not match/);
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: detail.id } })).allocatedQuantity, 0);
  const allocation = await transact(async tx => {
    await tx.inventoryDetail.update({ where: { id: detail.id }, data: { allocatedQuantity: 6 } });
    return tx.inventoryAllocation.create({ data: { quotationLineId: line.id, inventoryDetailId: detail.id,
      allocatedQuantity: 6, commandId: `schema-${tag}`, commandLineNo: 1, createdById: actor.id } });
  });
  const assignment = await transact(tx => tx.allocationAssignment.create({ data: { allocationId: allocation.id,
    orderLineId: order.lines[0].id, assignedQuantity: 4, commandId: `schema-assign-${tag}`, commandLineNo: 1, createdById: actor.id } }));
  await assert.rejects(transact(tx => tx.allocationAssignment.create({ data: { allocationId: allocation.id,
    orderLineId: order.lines[0].id, assignedQuantity: 3, commandId: `schema-over-${tag}`, commandLineNo: 1, createdById: actor.id } })), /conserve quantity/);
  await assert.rejects(db.inventoryAllocation.update({ where: { id: allocation.id }, data: { quotationLineId: randomUUID(), version: 2 } }), /source facts/);
  await assert.rejects(db.allocationAssignment.update({ where: { id: assignment.id }, data: { consumedQuantity: 1, version: 2 } }), /conserve quantity/);
  await transact(async tx => {
    await tx.inventoryAllocation.update({ where: { id: allocation.id }, data: { consumedQuantity: 1, releasedQuantity: 1, version: 2 } });
    await tx.allocationAssignment.update({ where: { id: assignment.id }, data: { consumedQuantity: 1, version: 2 } });
    await tx.inventoryDetail.update({ where: { id: detail.id }, data: { quantity: 9, allocatedQuantity: 4 } });
  });
  await assert.rejects(db.inventoryAllocation.update({ where: { id: allocation.id }, data: { consumedQuantity: 0, version: 3 } }), /monotonic/);
  await assert.rejects(db.inventoryDetail.update({ where: { id: detail.id }, data: { quantity: 3 } }), /inventory_allocated_quantity_range/);
  const event = await db.inventoryAllocationEvent.create({ data: { allocationId: allocation.id, kind: 'SCHEMA_FIXTURE', quantity: 1,
    before: { consumedQuantity: 0 }, after: { consumedQuantity: 1 }, commandId: `schema-event-${tag}`, eventNo: 1, actorId: actor.id } });
  await assert.rejects(db.inventoryAllocationEvent.update({ where: { id: event.id }, data: { quantity: 2 } }), /history cannot/);
  await assert.rejects(db.inventoryAllocationEvent.delete({ where: { id: event.id } }), /history cannot/);
  const stock = await db.inventoryDetail.findUniqueOrThrow({ where: { id: detail.id } });
  assert.equal(stock.quantity, 9);
  assert.equal(stock.allocatedQuantity, 4);
  console.log(JSON.stringify({ result: 'PASS', detailId: detail.id, checks: [
    'counter-only change rejected', 'balanced reservation commits', 'assignment over-allocation rejected',
    'source mutation rejected', 'unbalanced consumption rejected', 'balanced consume/release commits',
    'counter reversal rejected', 'quantity cannot fall below allocated', 'event update/delete rejected',
  ] }, null, 2));
} finally {
  await db.$disconnect();
}
