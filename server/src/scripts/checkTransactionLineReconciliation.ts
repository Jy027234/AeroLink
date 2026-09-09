import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { reconcileTransactionLines } from '../lib/transactionLineReconciliation.js';

async function main() {
  try {
    const report = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const [rfqs, inquiries, inquiryItems, supplierQuotes, quotations, orders, rfqLines, quotationLines, orderLines,
        directPurchaseLines, directShipments, localShipmentLines] = await Promise.all([
        tx.rFQ.findMany({ select: { id: true, lineItemsMode: true, partNumber: true, quantity: true, uom: true, conditionCode: true, description: true, serialNumber: true, batchNumber: true, certificateType: true, leadTimeDays: true, requiredDate: true, certificateRequired: true, targetPrice: true, targetPriceCurrency: true, alternatePartNumbers: true } }),
        tx.inquiry.findMany({ select: { id: true, supplierId: true, rfqId: true } }),
        tx.inquiryItem.findMany({ select: { id: true, inquiryId: true, lineNo: true, rfqLineId: true, partNumber: true, quantity: true, requiredDate: true, certificateRequired: true } }),
        tx.supplierQuote.findMany({ select: { id: true, inquiryId: true, rfqId: true, rfqLineId: true, inquiryItemId: true, supplierId: true, partNumber: true, quantity: true, unitPrice: true, unitPriceDecimal: true, totalPrice: true, totalPriceDecimal: true, currency: true } }),
        tx.quotation.findMany({ select: { id: true, lineItemsMode: true, rfqId: true, partNumber: true, quantity: true, unitPrice: true, unitPriceDecimal: true, totalPrice: true, totalPriceDecimal: true, costPrice: true, costPriceDecimal: true, currency: true, costSourceType: true, costSourceId: true, reservedQuantity: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
        tx.order.findMany({ select: { id: true, lineItemsMode: true, quotationId: true, partNumber: true, quantity: true, totalAmount: true, totalAmountDecimal: true, outboundQuantity: true, directShippedQuantity: true, outboundStatus: true, status: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
        tx.rfqLine.findMany({ select: { id: true, rfqId: true, lineNo: true, partNumber: true, quantity: true, uom: true, conditionCode: true, description: true, serialNumber: true, batchNumber: true, alternatePartNumbers: true, certificateType: true, leadTimeDays: true, requiredDate: true, certificateRequired: true, targetPriceDecimal: true, targetPriceCurrency: true } }),
        tx.quotationLine.findMany({ select: { id: true, quotationId: true, lineNo: true, rfqLineId: true, sourceSupplierQuoteId: true, costSourceType: true, costSourceId: true, costSourceReason: true, costSourceSnapshotJson: true, costSourceCapturedAt: true, partNumber: true, quantity: true, unitPrice: true, costPrice: true, lineTotal: true, marginAmount: true, marginPercent: true, currency: true, acceptedQuantity: true, reservedQuantity: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
        tx.orderLine.findMany({ select: { id: true, orderId: true, lineNo: true, quotationLineId: true, partNumber: true, quantity: true, unitPrice: true, lineTotal: true, currency: true, outboundQuantity: true, directShippedQuantity: true, outboundStatus: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
        tx.purchaseCommitmentLine.findMany({ select: { id: true, purchaseCommitmentId: true, orderLineId: true, quantity: true, cancelledQuantity: true, receivedQuantity: true, directShippedQuantity: true, fulfillmentMode: true } }),
        tx.supplierDirectShipment.findMany({ select: { id: true, status: true, orderId: true, purchaseCommitmentId: true,
          lines: { select: { id: true, purchaseCommitmentLineId: true, quantity: true, receivedQuantity: true, reviewStatus: true } } } }),
        tx.shipmentLine.findMany({ select: { orderLineId: true, receivedQuantity: true } }),
      ]);
      const rfqLinesByRfq = new Map<string, typeof rfqLines>();
      const quotationLinesByQuotation = new Map<string, typeof quotationLines>();
      const orderLinesByOrder = new Map<string, typeof orderLines>();
      for (const line of rfqLines) rfqLinesByRfq.set(line.rfqId, [...(rfqLinesByRfq.get(line.rfqId) ?? []), line]);
      for (const line of quotationLines) quotationLinesByQuotation.set(line.quotationId, [...(quotationLinesByQuotation.get(line.quotationId) ?? []), line]);
      for (const line of orderLines) orderLinesByOrder.set(line.orderId, [...(orderLinesByOrder.get(line.orderId) ?? []), line]);
      return reconcileTransactionLines({
        rfqs: rfqs.map(rfq => ({ ...rfq, lines: rfqLinesByRfq.get(rfq.id) ?? [] })),
        inquiries,
        inquiryItems,
        supplierQuotes,
        quotations: quotations.map(quotation => ({ ...quotation, lines: quotationLinesByQuotation.get(quotation.id) ?? [] })),
        orders: orders.map(order => ({ ...order, lines: orderLinesByOrder.get(order.id) ?? [] })),
        directPurchaseLines: directPurchaseLines.map(line => ({
          id: line.id,
          purchaseCommitmentId: line.purchaseCommitmentId,
          orderLineId: line.orderLineId,
          quantity: line.quantity,
          cancelledQuantity: line.cancelledQuantity,
          receivedQuantity: line.receivedQuantity,
          directShippedQuantity: line.directShippedQuantity,
          fulfillmentMode: line.fulfillmentMode,
        })),
        directShipmentLines: directShipments.flatMap(shipment => shipment.lines.map(line => {
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
        localShipmentReceipts: localShipmentLines.map(line => ({
          orderLineId: line.orderLineId,
          receivedQuantity: line.receivedQuantity,
        })),
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
