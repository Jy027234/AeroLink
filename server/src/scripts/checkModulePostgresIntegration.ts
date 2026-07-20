import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import {
  createOrderFromQuotation,
  orderRepository,
  quotationRepository,
  transitionRfqStatus,
} from '../modules/quotationOrder/index.js';
import {
  createSupplierAggregate,
  customerRepository,
  supplierRepository,
  updateCustomerAggregate,
} from '../modules/customerSupplier/index.js';
import { assertInventoryQuantityAdjustmentAllowed, inventoryRepository } from '../modules/inventoryQuality/index.js';
import { rfqRepository } from '../modules/rfqSourcing/index.js';

/**
 * Runs a small real-PostgreSQL module smoke test. It is intentionally guarded:
 * the test performs a temporary supplier write and a transaction rollback, so
 * it may only run against an explicitly named integration database.
 */
if (process.env.P2_MODULE_INTEGRATION !== 'true') {
  throw new Error('P2_MODULE_INTEGRATION=true is required for the PostgreSQL module integration check');
}

const databaseUrl = process.env.DATABASE_URL || '';
if (!/(p2|integration|test)/i.test(databaseUrl)) {
  throw new Error('Refusing module integration check unless DATABASE_URL names a p2/integration/test database');
}

const ROLLBACK = Symbol('module-integration-rollback');
let createdSupplierId: string | undefined;

try {
  const [customer, supplier, inventory, rfq, quotation] = await Promise.all([
    customerRepository.findFirst(),
    supplierRepository.findFirst(),
    inventoryRepository.findFirst({ orderBy: { createdAt: 'asc' } }),
    rfqRepository.findFirst({ orderBy: { createdAt: 'asc' } }),
    quotationRepository.findFirst({ include: { customer: true } }),
  ]);

  assert(customer, 'seeded customer is required');
  assert(supplier, 'seeded supplier is required');
  assert(inventory, 'seeded inventory detail is required');
  assert(rfq, 'seeded RFQ is required');
  assert(quotation, 'seeded quotation is required');

  const baseline = await Promise.all([
    prisma.transactionStatusHistory.count({ where: { entityType: 'RFQ', entityId: rfq.id } }),
    orderRepository.count({ where: { quotationId: quotation.id } }),
  ]);

  await prisma.$transaction(async (tx) => {
    const changedRfq = await transitionRfqStatus(tx, {
      id: rfq.id,
      currentStatus: rfq.status,
      currentVersion: rfq.version,
      nextStatus: rfq.status,
      reasonCode: 'P2_MODULE_INTEGRATION_ROLLBACK',
    });
    assert.equal(changedRfq.version, rfq.version + 1);

    assertInventoryQuantityAdjustmentAllowed(inventory.status, false);
    expectDefined(await tx.inventoryDetail.findUnique({ where: { id: inventory.id } }));

    const existingOrder = await tx.order.findUnique({ where: { quotationId: quotation.id } });
    if (!existingOrder) {
      const createdOrder = await createOrderFromQuotation({
        tx,
        quotation,
        customer: quotation.customer,
        actorId: customer.id,
        reasonCode: 'P2_MODULE_INTEGRATION_ROLLBACK',
      });
      assert.equal(createdOrder.quotationId, quotation.id);
    }

    throw ROLLBACK;
  }).catch((error) => {
    if (error !== ROLLBACK) throw error;
  });

  const afterRollback = await Promise.all([
    prisma.transactionStatusHistory.count({ where: { entityType: 'RFQ', entityId: rfq.id } }),
    orderRepository.count({ where: { quotationId: quotation.id } }),
  ]);
  assert.deepEqual(afterRollback, baseline, 'transaction rollback did not restore aggregate state');

  const updatedCustomer = await updateCustomerAggregate(
    customer.id,
    { status: customer.status } satisfies Prisma.CustomerUpdateInput,
    {},
    { contactsProvided: false, competitorListingsProvided: false },
  );
  assert.equal(updatedCustomer.id, customer.id);

  const tempEmail = `p2-module-${Date.now()}@example.invalid`;
  const createdSupplier = await createSupplierAggregate({
    name: 'P2 module integration temporary supplier',
    email: tempEmail,
  });
  createdSupplierId = createdSupplier.id;
  assert.equal(createdSupplier.email, tempEmail);

  console.log(JSON.stringify({
    status: 'PASS',
    modules: ['quotationOrder', 'rfqSourcing', 'inventoryQuality', 'customerSupplier'],
    transactionRollback: true,
    supplierCreateUpdate: true,
  }));
} finally {
  if (createdSupplierId) {
    await supplierRepository.delete({ where: { id: createdSupplierId } });
  }
  await prisma.$disconnect();
}

function expectDefined<T>(value: T | null): asserts value is T {
  assert(value, 'expected seeded aggregate row');
}
