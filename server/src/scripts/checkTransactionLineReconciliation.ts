import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { reconcileTransactionLines } from '../lib/transactionLineReconciliation.js';

async function main() {
  try {
    const report = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const [rfqs, inquiries, inquiryItems, supplierQuotes, quotations, orders, rfqLines, quotationLines, orderLines] = await Promise.all([
        tx.rFQ.findMany({ select: { id: true, partNumber: true, quantity: true, uom: true, conditionCode: true, description: true, serialNumber: true, batchNumber: true, certificateType: true, leadTimeDays: true, requiredDate: true, certificateRequired: true, targetPrice: true, targetPriceCurrency: true, alternatePartNumbers: true } }),
        tx.inquiry.findMany({ select: { id: true, supplierId: true, rfqId: true } }),
        tx.inquiryItem.findMany({ select: { id: true, inquiryId: true, lineNo: true, rfqLineId: true, partNumber: true, quantity: true, requiredDate: true, certificateRequired: true } }),
        tx.supplierQuote.findMany({ select: { id: true, inquiryId: true, rfqId: true, rfqLineId: true, inquiryItemId: true, supplierId: true, partNumber: true, quantity: true, unitPrice: true, unitPriceDecimal: true, totalPrice: true, totalPriceDecimal: true, currency: true } }),
        tx.quotation.findMany({ select: { id: true, rfqId: true, partNumber: true, quantity: true, unitPrice: true, unitPriceDecimal: true, totalPrice: true, totalPriceDecimal: true, costPrice: true, costPriceDecimal: true, currency: true, costSourceType: true, costSourceId: true, reservedQuantity: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
        tx.order.findMany({ select: { id: true, quotationId: true, partNumber: true, quantity: true, totalAmount: true, totalAmountDecimal: true, outboundQuantity: true, outboundStatus: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
        tx.rfqLine.findMany({ select: { id: true, rfqId: true, lineNo: true, partNumber: true, quantity: true, uom: true, conditionCode: true, description: true, serialNumber: true, batchNumber: true, alternatePartNumbers: true, certificateType: true, leadTimeDays: true, requiredDate: true, certificateRequired: true, targetPriceDecimal: true, targetPriceCurrency: true } }),
        tx.quotationLine.findMany({ select: { id: true, quotationId: true, lineNo: true, rfqLineId: true, sourceSupplierQuoteId: true, partNumber: true, quantity: true, unitPrice: true, costPrice: true, lineTotal: true, marginAmount: true, marginPercent: true, currency: true, acceptedQuantity: true, reservedQuantity: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
        tx.orderLine.findMany({ select: { id: true, orderId: true, lineNo: true, quotationLineId: true, partNumber: true, quantity: true, unitPrice: true, lineTotal: true, currency: true, outboundQuantity: true, outboundStatus: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
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
