import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { assessTransactionLineMigration } from '../lib/transactionLinePreflight.js';

try {
  const report = await prisma.$transaction(async tx => {
    // A database-enforced read-only, consistent snapshot; no backfill or inferred link is written.
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const rfqs = await tx.rFQ.findMany({ select: { id: true, partNumber: true, alternatePartNumbers: true, quantity: true, requiredDate: true, certificateRequired: true, targetPriceCurrency: true } });
    const inquiries = await tx.inquiry.findMany({ select: { id: true, supplierId: true } });
    const inquiryItems = await tx.inquiryItem.findMany({ select: { id: true, inquiryId: true, partNumber: true, quantity: true, requiredDate: true, certificateRequired: true } });
    const supplierQuotes = await tx.supplierQuote.findMany({ select: { id: true, rfqId: true, inquiryId: true, supplierId: true, partNumber: true, quantity: true, unitPrice: true, unitPriceDecimal: true, totalPrice: true, totalPriceDecimal: true } });
    const quotations = await tx.quotation.findMany({ select: { id: true, rfqId: true, partNumber: true, quantity: true, unitPrice: true, unitPriceDecimal: true, totalPrice: true, totalPriceDecimal: true, costPrice: true, costPriceDecimal: true, currency: true } });
    const orders = await tx.order.findMany({ select: { id: true, quotationId: true, partNumber: true, quantity: true, totalAmount: true, totalAmountDecimal: true, outboundQuantity: true } });
    return assessTransactionLineMigration({ rfqs, inquiries, inquiryItems, supplierQuotes, quotations, orders });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 });
  console.log(JSON.stringify(report, null, 2));
  // Review findings also require explicit resolution before a later automatic migration.
  if (report.status !== 'PASS') process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
