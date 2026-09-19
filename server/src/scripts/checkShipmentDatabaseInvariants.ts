import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
const expectedDatabase = 'aerolink_d13_shipments_20260909_root';
if (process.env.AEROLINK_D13_INTEGRATION !== 'true'
  || !['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.pathname !== `/${expectedDatabase}`) {
  throw new Error(`Explicit opt-in and local ${expectedDatabase} database required`);
}

const db = new PrismaClient();
const transact = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async tx => {
  const result = await run(tx);
  // Prisma 5 may otherwise resolve an interactive transaction before a
  // deferred constraint failure is surfaced by PostgreSQL COMMIT.
  await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  return result;
}, { isolationLevel: 'Serializable', timeout: 20_000 });

const tag = randomUUID().slice(0, 8);
const now = new Date();

try {
  const actor = await db.user.create({
    data: { name: `D13 schema fixture ${tag}`, email: `d13-schema-${tag}@example.invalid`, password: 'unusable', role: 'QUALITY_MANAGER' },
  });
  const customer = await db.customer.create({
    data: { name: `D13 schema customer ${tag}`, contactName: 'D13 fixture', email: `d13-customer-${tag}@example.invalid` },
  });
  const rfq = await db.rFQ.create({
    data: {
      rfqNumber: `D13-RFQ-${tag}`,
      customerId: customer.id,
      partNumber: `D13-PN-${tag}`,
      quantity: 2,
      requiredDate: new Date('2027-01-15'),
      createdBy: actor.id,
      lines: {
        create: {
          lineNo: 1,
          partNumber: `D13-PN-${tag}`,
          quantity: 2,
          requiredDate: new Date('2027-01-15'),
        },
      },
    },
    include: { lines: true },
  });
  const rfqLine = rfq.lines[0];
  const quotation = await db.quotation.create({
    data: {
      quoteNumber: `D13-Q-${tag}`,
      rfqId: rfq.id,
      customerId: customer.id,
      partNumber: rfqLine.partNumber,
      quantity: 2,
      unitPrice: 100,
      totalPrice: 200,
      costPrice: 50,
      margin: 100,
      currency: 'USD',
      status: 'APPROVED',
      statusEnum: 'APPROVED',
      expiryDate: new Date('2027-01-15'),
      createdBy: actor.id,
      lines: {
        create: {
          lineNo: 1,
          rfqLineId: rfqLine.id,
          partNumber: rfqLine.partNumber,
          quantity: 2,
          unitPrice: 100,
          costPrice: 50,
          lineTotal: 200,
          marginAmount: 100,
          marginPercent: 50,
          currency: 'USD',
        },
      },
    },
    include: { lines: true },
  });
  const quotationLine = quotation.lines[0];
  const detail = await db.inventoryDetail.create({
    data: {
      quantity: 2,
      unitCost: 50,
      location: `D13-${tag}`,
      conditionCode: 'NE',
      inventoryItem: { create: { partNumber: rfqLine.partNumber, description: 'D13 schema fixture', trackingType: 'BATCH' } },
    },
  });
  const order = await db.order.create({
    data: {
      lineItemsMode: true,
      orderNumber: `D13-O-${tag}`,
      soNumber: `D13-SO-${tag}`,
      quotationId: quotation.id,
      customerId: customer.id,
      partNumber: rfqLine.partNumber,
      quantity: 2,
      totalAmount: 200,
      totalAmountDecimal: 200,
      status: 'SO_CREATED',
      statusEnum: 'SO_CREATED',
      lines: {
        create: {
          lineNo: 1,
          quotationLineId: quotationLine.id,
          partNumber: rfqLine.partNumber,
          quantity: 2,
          unitPrice: 100,
          lineTotal: 200,
        },
      },
    },
    include: { lines: true },
  });
  const orderLine = order.lines[0];

  const allocation = await transact(async tx => {
    await tx.inventoryDetail.update({ where: { id: detail.id }, data: { allocatedQuantity: 2 } });
    return tx.inventoryAllocation.create({
      data: {
        quotationLineId: quotationLine.id,
        inventoryDetailId: detail.id,
        allocatedQuantity: 2,
        commandId: `d13-allocation-${tag}`,
        commandLineNo: 1,
        createdById: actor.id,
      },
    });
  });
  const assignment = await transact(tx => tx.allocationAssignment.create({
    data: {
      allocationId: allocation.id,
      orderLineId: orderLine.id,
      assignedQuantity: 2,
      commandId: `d13-assignment-${tag}`,
      commandLineNo: 1,
      createdById: actor.id,
    },
  }));
  const review = await db.fulfillmentReview.create({
    data: {
      orderId: order.id,
      inventoryDetailId: detail.id,
      assignmentId: assignment.id,
      quantity: 2,
      approved: true,
      snapshotHash: `d13-review-${tag}`,
      snapshot: { orderId: order.id, assignmentId: assignment.id, inventoryDetailId: detail.id },
      evidence: { ids: [] },
      checks: { identity: true },
      reason: 'D13 schema fixture',
      reviewedById: actor.id,
      reviewedAt: now,
      consumedAt: now,
    },
  });
  const outbound = await transact(async tx => {
    await tx.inventoryAllocation.update({ where: { id: allocation.id }, data: { consumedQuantity: 2, version: 2 } });
    await tx.allocationAssignment.update({ where: { id: assignment.id }, data: { consumedQuantity: 2, version: 2 } });
    await tx.inventoryDetail.update({ where: { id: detail.id }, data: { quantity: 0, allocatedQuantity: 0 } });
    await tx.orderLine.update({ where: { id: orderLine.id }, data: { outboundQuantity: 2, outboundStatus: 'COMPLETED', updatedAt: now } });
    return tx.inventoryTransaction.create({
      data: {
        inventoryDetailId: detail.id,
        type: 'OUTBOUND',
        quantity: -2,
        beforeQuantity: 2,
        afterQuantity: 0,
        orderId: order.id,
        quotationId: quotation.id,
        allocationId: allocation.id,
        assignmentId: assignment.id,
        fulfillmentReviewId: review.id,
        referenceNo: order.orderNumber,
        referenceType: 'ORDER',
        createdBy: actor.id,
      },
    });
  });
  const shipment = await db.shipment.create({
    data: {
      orderId: order.id,
      shipmentNumber: `D13-SHP-${tag}`,
      carrier: 'D13-CARRIER',
      trackingNumber: `D13-TRK-${tag}`,
      origin: 'D13-WH',
      destination: 'D13-CUSTOMER',
      evidence: { source: 'schema-fixture' },
      commandId: `d13-shipment-${tag}`,
      requestHash: `d13-request-${tag}`,
      createdById: actor.id,
      lines: {
        create: {
          lineNo: 1,
          orderLineId: orderLine.id,
          assignmentId: assignment.id,
          outboundTransactionId: outbound.id,
          quantity: 2,
          identitySnapshot: { partNumber: rfqLine.partNumber, inventoryDetailId: detail.id },
        },
      },
    },
    include: { lines: true },
  });
  const shipmentLine = shipment.lines[0];

  await transact(async tx => {
    await tx.shipmentLine.update({ where: { id: shipmentLine.id }, data: { receivedQuantity: 1, version: 2 } });
    await tx.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        shipmentLineId: shipmentLine.id,
        kind: 'RECEIPT',
        quantity: 1,
        commandId: `d13-receipt-${tag}`,
        eventNo: 1,
        actorId: actor.id,
        evidence: { source: 'schema-fixture' },
      },
    });
    await tx.shipment.update({
      where: { id: shipment.id },
      data: { status: 'PARTIALLY_RECEIVED', version: 2 },
    });
  });
  await assert.rejects(
    transact(tx => tx.shipmentLine.update({ where: { id: shipmentLine.id }, data: { receivedQuantity: 2, version: 3 } })),
    /receipt counter does not match/,
  );
  await assert.rejects(
    db.returnHold.create({
      data: {
        shipmentLineId: shipmentLine.id,
        inventoryDetailId: detail.id,
        quantity: 1,
        status: 'RELEASED',
        version: 1,
        identitySnapshot: { partNumber: rfqLine.partNumber, inventoryDetailId: detail.id },
        evidence: { source: 'schema-fixture' },
        snapshotHash: `d13-invalid-return-${tag}`,
        receivedById: actor.id,
        commandId: `d13-invalid-return-${tag}`,
        requestHash: `d13-invalid-return-request-${tag}`,
      },
    }),
    /must be created as an unreleased quarantine record/,
  );

  const returnHold = await transact(async tx => {
    const hold = await tx.returnHold.create({
      data: {
        shipmentLineId: shipmentLine.id,
        inventoryDetailId: detail.id,
        quantity: 1,
        identitySnapshot: { partNumber: rfqLine.partNumber, inventoryDetailId: detail.id },
        evidence: { source: 'schema-fixture' },
        snapshotHash: `d13-return-${tag}`,
        receivedById: actor.id,
        commandId: `d13-return-${tag}`,
        requestHash: `d13-return-request-${tag}`,
      },
    });
    await tx.shipmentLine.update({ where: { id: shipmentLine.id }, data: { returnedQuantity: 1, version: 3 } });
    return hold;
  });
  const returnTransaction = await transact(tx => tx.inventoryTransaction.create({
    data: {
      inventoryDetailId: detail.id,
      type: 'RETURN',
      quantity: 1,
      beforeQuantity: 0,
      afterQuantity: 1,
      orderId: order.id,
      quotationId: quotation.id,
      allocationId: allocation.id,
      assignmentId: assignment.id,
      referenceNo: order.orderNumber,
      referenceType: 'RETURN',
      createdBy: actor.id,
    },
  }));
  await transact(tx => tx.returnHold.update({
    where: { id: returnHold.id },
    data: {
      status: 'RELEASED',
      version: 2,
      releasedById: actor.id,
      releasedAt: new Date(),
      releaseCommandId: `d13-release-${tag}`,
      releaseRequestHash: `d13-release-request-${tag}`,
      releaseEvidence: { authorization: 'D13 schema fixture' },
      releaseReason: 'D13 schema fixture release',
      returnTransactionId: returnTransaction.id,
    },
  }));

  await assert.rejects(
    db.shipmentEvent.delete({ where: { id: (await db.shipmentEvent.findFirstOrThrow({ where: { shipmentId: shipment.id } })).id } }),
    /history cannot be deleted|Shipment and return history cannot be deleted/,
  );
  await assert.rejects(
    db.shipmentLine.update({ where: { id: shipmentLine.id }, data: { quantity: 1 } }),
    /source facts cannot be replaced/,
  );
  await assert.rejects(
    transact(tx => tx.fulfillmentReview.update({ where: { id: review.id }, data: { quantity: 1 } })),
    /exact quantity/,
  );
  await assert.rejects(
    transact(tx => tx.shipment.update({ where: { id: shipment.id }, data: { status: 'DELIVERED', version: 3 } })),
    /all lines fully received/,
  );
  await assert.rejects(
    db.shipment.update({ where: { id: shipment.id }, data: { status: 'ARCHIVED', version: 3 } }),
    /shipments_status_value_check|violates check constraint/,
  );

  console.log(JSON.stringify({
    result: 'PASS',
    database: expectedDatabase,
    shipmentId: shipment.id,
    returnHoldId: returnHold.id,
    checks: [
      'matching OUTBOUND and consumed fulfillment review accepted',
      'receipt counter must equal receipt events',
      'return holds must start quarantined',
      'return hold remains bounded by shipment line quantity',
      'RETURN release requires one matching positive transaction',
      'shipment events cannot be deleted',
      'shipment line source facts cannot be replaced',
      'consumed fulfillment review quantity must equal OUTBOUND magnitude',
      'shipment status must match receipt projection',
      'shipment status is limited to the modern lifecycle values',
    ],
  }, null, 2));
} finally {
  await db.$disconnect();
}
