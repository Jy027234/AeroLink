import db from '../lib/prisma.js';
import { reconcileDirectDeliveryProjection } from '../lib/directDeliveryReconciliation.js';
import { calculateShippableQuantities, calculateShipmentLineQuantities, deriveOrderDeliveryProgress } from '../modules/inventoryQuality/shipmentQuantities.js';

const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
const isDirectTestDatabase = url.port === '55970' && [
  '/aerolink_procurement_test_direct_20260909',
  '/aerolink_settlement_test_20260910',
].includes(url.pathname);
if (process.env.AEROLINK_SHIPMENT_RECONCILIATION !== 'true' || !['localhost', '127.0.0.1'].includes(url.hostname)
  || (!/^\/aerolink_shipment_test_[a-z0-9_]+$/.test(url.pathname) && !isDirectTestDatabase)) {
  throw new Error('Explicit opt-in and dedicated local shipment or direct-shipment test database required');
}
try {
  const result = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const [shipments, sources, orders, directPurchaseLines, directShipments] = await Promise.all([
      tx.shipment.findMany({ include: { lines: { include: { events: true, returnHolds: { include: { events: true, returnTransaction: true } } } } } }),
      tx.inventoryTransaction.findMany({ where: { type: 'OUTBOUND', assignmentId: { not: null } }, select: {
        id: true, quantity: true, orderId: true, inventoryDetailId: true, assignmentId: true, fulfillmentReviewId: true,
        assignment: { select: { orderLineId: true, allocation: { select: { inventoryDetailId: true } } } },
        fulfillmentReview: { select: { approved: true, consumedAt: true, quantity: true, assignmentId: true, inventoryDetailId: true, orderId: true } },
      } }),
      tx.order.findMany({ where: { lineItemsMode: true }, select: { id: true, status: true, quantity: true, outboundQuantity: true, directShippedQuantity: true,
        lines: { select: { id: true, orderId: true, quantity: true, outboundQuantity: true, directShippedQuantity: true } } } }),
      tx.purchaseCommitmentLine.findMany({ select: { id: true, purchaseCommitmentId: true, orderLineId: true, quantity: true,
        cancelledQuantity: true, receivedQuantity: true, directShippedQuantity: true, fulfillmentMode: true } }),
      tx.supplierDirectShipment.findMany({ select: { id: true, status: true, orderId: true, purchaseCommitmentId: true,
        lines: { select: { id: true, purchaseCommitmentLineId: true, quantity: true, receivedQuantity: true, reviewStatus: true } } } }),
    ]);
    const issues: string[] = [];
    const lines = shipments.flatMap(shipment => shipment.lines);
    const directReport = reconcileDirectDeliveryProjection({
      orders: orders.map(order => ({
        id: order.id,
        quantity: order.quantity,
        outboundQuantity: order.outboundQuantity,
        directShippedQuantity: order.directShippedQuantity,
        lineItemsMode: true,
        status: order.status,
        lines: order.lines.map(line => ({
          id: line.id,
          orderId: line.orderId,
          quantity: line.quantity,
          outboundQuantity: line.outboundQuantity,
          directShippedQuantity: line.directShippedQuantity,
        })),
      })),
      purchaseLines: directPurchaseLines.map(line => ({
        id: line.id,
        purchaseCommitmentId: line.purchaseCommitmentId,
        orderLineId: line.orderLineId,
        quantity: line.quantity,
        cancelledQuantity: line.cancelledQuantity,
        receivedQuantity: line.receivedQuantity,
        directShippedQuantity: line.directShippedQuantity,
        fulfillmentMode: line.fulfillmentMode,
      })),
      directLines: directShipments.flatMap(shipment => shipment.lines.map(line => {
        const purchaseLine = directPurchaseLines.find(candidate => candidate.id === line.purchaseCommitmentLineId);
        return {
          id: line.id,
          shipmentId: shipment.id,
          shipmentStatus: shipment.status,
          orderId: shipment.orderId,
          orderLineId: purchaseLine?.orderLineId ?? '',
          purchaseCommitmentId: shipment.purchaseCommitmentId,
          purchaseCommitmentLineId: line.purchaseCommitmentLineId,
          quantity: line.quantity,
          receivedQuantity: line.receivedQuantity,
          reviewStatus: line.reviewStatus,
        };
      })),
      localReceipts: lines.map(line => ({ orderLineId: line.orderLineId, receivedQuantity: line.receivedQuantity })),
    });
    for (const issue of directReport.issues) issues.push(`direct ${issue.code} ${issue.id}`);
    try { calculateShippableQuantities(sources.map(source => ({ id: source.id, quantity: -source.quantity })),
      lines.map(line => ({ id: line.id, outboundTransactionId: line.outboundTransactionId, quantity: line.quantity }))); }
    catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    for (const shipment of shipments) {
      if (!shipment.lines.length) issues.push(`empty shipment ${shipment.id}`);
      const fullyReceived = shipment.lines.length > 0 && shipment.lines.every(line => line.receivedQuantity === line.quantity);
      if ((shipment.status === 'DELIVERED') !== fullyReceived) issues.push(`shipment delivery status mismatch ${shipment.id}`);
      for (const line of shipment.lines) {
        try { calculateShipmentLineQuantities({ shipmentLineId: line.id, shippedQuantity: line.quantity,
          receivedQuantity: line.receivedQuantity, returnedQuantity: line.returnedQuantity }); }
        catch (error) { issues.push(`${line.id}: ${error instanceof Error ? error.message : String(error)}`); }
        const source = sources.find(row => row.id === line.outboundTransactionId);
        const review = source?.fulfillmentReview;
        if (!source || source.orderId !== shipment.orderId || source.assignmentId !== line.assignmentId
          || source.assignment?.orderLineId !== line.orderLineId || source.assignment.allocation.inventoryDetailId !== source.inventoryDetailId
          || !review?.approved || !review.consumedAt || review.quantity !== -source.quantity
          || review.assignmentId !== source.assignmentId || review.inventoryDetailId !== source.inventoryDetailId || review.orderId !== shipment.orderId) {
          issues.push(`unproven outbound/review source ${line.id}`);
        }
        if (line.events.filter(event => event.kind === 'RECEIPT').reduce((sum, event) => sum + event.quantity, 0) !== line.receivedQuantity) issues.push(`receipt/event mismatch ${line.id}`);
        if (line.returnHolds.reduce((sum, hold) => sum + hold.quantity, 0) !== line.returnedQuantity) issues.push(`return/hold mismatch ${line.id}`);
        for (const hold of line.returnHolds) {
          if (hold.inventoryDetailId !== source?.inventoryDetailId) issues.push(`return source mismatch ${hold.id}`);
          if (hold.events.filter(event => event.kind === 'RECEIVED').reduce((sum, event) => sum + event.quantity, 0) !== hold.quantity) issues.push(`return receipt/event mismatch ${hold.id}`);
          const released = hold.status === 'RELEASED';
          const movement = hold.returnTransaction;
          if (released && (!movement || movement.type !== 'RETURN' || movement.quantity !== hold.quantity
            || movement.inventoryDetailId !== hold.inventoryDetailId || movement.orderId !== shipment.orderId
            || movement.assignmentId !== line.assignmentId || movement.afterQuantity - movement.beforeQuantity !== hold.quantity
            || !hold.releasedById || hold.releasedById === hold.receivedById)) issues.push(`return release/ledger mismatch ${hold.id}`);
          if (!released && movement) issues.push(`quarantined custody already entered stock ${hold.id}`);
          const releasedEvents = hold.events.filter(event => event.kind === 'RELEASED').reduce((sum, event) => sum + event.quantity, 0);
          if (releasedEvents !== (released ? hold.quantity : 0)) issues.push(`release/event mismatch ${hold.id}`);
        }
      }
    }
    for (const order of orders) {
      try {
        const directByLine = new Map(directReport.byOrderLine.map(row => [row.orderLineId, row]));
        const progress = deriveOrderDeliveryProgress(order.lines.map(line => ({ orderLineId: line.id, quantity: line.quantity,
          receivedQuantity: directByLine.get(line.id)?.totalReceivedQuantity ?? 0 })));
        if (progress.complete !== ['DELIVERED', 'COMPLETED'].includes(order.status)) issues.push(`order delivery status mismatch ${order.id}`);
      } catch (error) { issues.push(`${order.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { status: issues.length ? 'BLOCKED' : 'PASS', checked: { shipments: shipments.length, shipmentLines: lines.length,
      modernOutbound: sources.length, modernOrders: orders.length, directShipments: directShipments.length,
      directShipmentLines: directShipments.reduce((sum, shipment) => sum + shipment.lines.length, 0),
      returnHolds: lines.reduce((sum, line) => sum + line.returnHolds.length, 0) }, issues };
  }, { isolationLevel: 'RepeatableRead', timeout: 20_000 });
  console.log(JSON.stringify(result, null, 2));
  if (result.issues.length) process.exitCode = 1;
} finally { await db.$disconnect(); }
