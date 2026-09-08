import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import {
  buildTransactionLineBackfillPlan,
  type TransactionLineBackfillInput,
  type TransactionLineBackfillPlan,
} from '../lib/transactionLineBackfill.js';
import {
  reconcileTransactionLines,
  type TransactionLineReconciliationInput,
} from '../lib/transactionLineReconciliation.js';

type DbClient = Prisma.TransactionClient | PrismaClient;

type Snapshot = {
  input: TransactionLineBackfillInput;
  reconciliation: TransactionLineReconciliationInput;
};

async function readSnapshot(db: DbClient): Promise<Snapshot> {
  const [rfqs, inquiries, inquiryItems, supplierQuotes, quotations, orders, rfqLines, quotationLines, orderLines] = await Promise.all([
    db.rFQ.findMany({ select: { id: true, lineItemsMode: true, partNumber: true, quantity: true, uom: true, conditionCode: true, description: true, serialNumber: true, batchNumber: true, alternatePartNumbers: true, certificateRequired: true, certificateType: true, requiredDate: true, leadTimeDays: true, targetPrice: true, targetPriceCurrency: true, status: true } }),
    db.inquiry.findMany({ select: { id: true, supplierId: true, rfqId: true } }),
    db.inquiryItem.findMany({ select: { id: true, inquiryId: true, lineNo: true, rfqLineId: true, partNumber: true, quantity: true, requiredDate: true, certificateRequired: true } }),
    db.supplierQuote.findMany({ select: { id: true, inquiryId: true, rfqId: true, rfqLineId: true, inquiryItemId: true, supplierId: true, partNumber: true, description: true, quantity: true, unitPrice: true, unitPriceDecimal: true, totalPrice: true, totalPriceDecimal: true, currency: true, validUntil: true, status: true, isWinner: true } }),
    db.quotation.findMany({ select: { id: true, lineItemsMode: true, rfqId: true, partNumber: true, quantity: true, unitPrice: true, unitPriceDecimal: true, totalPrice: true, totalPriceDecimal: true, costPrice: true, costPriceDecimal: true, currency: true, costSourceType: true, costSourceId: true, reservedQuantity: true, inventoryDetailId: true, serialNumber: true, batchNumber: true, status: true } }),
    db.order.findMany({ select: { id: true, lineItemsMode: true, quotationId: true, partNumber: true, quantity: true, totalAmount: true, totalAmountDecimal: true, outboundQuantity: true, outboundStatus: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
    db.rfqLine.findMany({ select: { id: true, rfqId: true, lineNo: true, partNumber: true, quantity: true, uom: true, conditionCode: true, description: true, serialNumber: true, batchNumber: true, alternatePartNumbers: true, certificateRequired: true, certificateType: true, requiredDate: true, leadTimeDays: true, targetPriceDecimal: true, targetPriceCurrency: true, status: true } }),
    db.quotationLine.findMany({ select: { id: true, quotationId: true, lineNo: true, rfqLineId: true, sourceSupplierQuoteId: true, costSourceType: true, costSourceId: true, costSourceReason: true, costSourceSnapshotJson: true, costSourceCapturedAt: true, partNumber: true, description: true, uom: true, quantity: true, unitPrice: true, costPrice: true, lineTotal: true, marginAmount: true, marginPercent: true, currency: true, status: true, acceptedQuantity: true, reservedQuantity: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
    db.orderLine.findMany({ select: { id: true, orderId: true, lineNo: true, quotationLineId: true, partNumber: true, uom: true, quantity: true, unitPrice: true, lineTotal: true, currency: true, outboundQuantity: true, outboundStatus: true, inventoryDetailId: true, serialNumber: true, batchNumber: true } }),
  ]);

  const rfqLinesByRfq = new Map<string, typeof rfqLines>();
  for (const line of rfqLines) rfqLinesByRfq.set(line.rfqId, [...(rfqLinesByRfq.get(line.rfqId) ?? []), line]);
  const quotationLinesByQuotation = new Map<string, typeof quotationLines>();
  for (const line of quotationLines) quotationLinesByQuotation.set(line.quotationId, [...(quotationLinesByQuotation.get(line.quotationId) ?? []), line]);
  const orderLinesByOrder = new Map<string, typeof orderLines>();
  for (const line of orderLines) orderLinesByOrder.set(line.orderId, [...(orderLinesByOrder.get(line.orderId) ?? []), line]);

  const input: TransactionLineBackfillInput = {
    preflight: {
      rfqs: rfqs.map(({ id, lineItemsMode, partNumber, quantity, requiredDate, certificateRequired, targetPriceCurrency, alternatePartNumbers }) => ({ id, lineItemsMode, partNumber, quantity, requiredDate, certificateRequired, targetPriceCurrency, alternatePartNumbers })),
      inquiries: inquiries.map(({ id, supplierId, rfqId }) => ({ id, supplierId, rfqId })),
      inquiryItems: inquiryItems.map(({ id, inquiryId, partNumber, quantity, requiredDate, certificateRequired }) => ({ id, inquiryId, partNumber, quantity, requiredDate, certificateRequired })),
      supplierQuotes: supplierQuotes.map(({ id, inquiryId, rfqId, supplierId, partNumber, quantity, unitPrice, unitPriceDecimal, totalPrice, totalPriceDecimal }) => ({ id, inquiryId, rfqId, supplierId, partNumber, quantity, unitPrice, unitPriceDecimal, totalPrice, totalPriceDecimal })),
      quotations: quotations.map(({ id, lineItemsMode, rfqId, partNumber, quantity, unitPrice, unitPriceDecimal, totalPrice, totalPriceDecimal, costPrice, costPriceDecimal, currency }) => ({ id, lineItemsMode, rfqId, partNumber, quantity, unitPrice, unitPriceDecimal, totalPrice, totalPriceDecimal, costPrice, costPriceDecimal, currency })),
      orders: orders.map(({ id, lineItemsMode, quotationId, partNumber, quantity, totalAmount, totalAmountDecimal, outboundQuantity }) => ({ id, lineItemsMode, quotationId, partNumber, quantity, totalAmount, totalAmountDecimal, outboundQuantity })),
    },
    rfqs,
    inquiries,
    inquiryItems,
    supplierQuotes,
    quotations,
    orders,
    existingRfqLines: rfqLines,
    existingQuotationLines: quotationLines,
    existingOrderLines: orderLines,
  };

  const reconciliation: TransactionLineReconciliationInput = {
    rfqs: rfqs.map(rfq => ({ ...rfq, lines: rfqLinesByRfq.get(rfq.id) ?? [] })),
    inquiries,
    inquiryItems,
    supplierQuotes,
    quotations: quotations.map(quotation => ({ ...quotation, lines: quotationLinesByQuotation.get(quotation.id) ?? [] })),
    orders: orders.map(order => ({ ...order, lines: orderLinesByOrder.get(order.id) ?? [] })),
  };
  return { input, reconciliation };
}

async function writePlan(db: Prisma.TransactionClient, plan: TransactionLineBackfillPlan) {
  if (plan.rfqLines.length > 0) await db.rfqLine.createMany({ data: plan.rfqLines });
  if (plan.quotationLines.length > 0) await db.quotationLine.createMany({ data: plan.quotationLines });
  if (plan.orderLines.length > 0) await db.orderLine.createMany({ data: plan.orderLines });

  for (const link of plan.inquiryItemLinks) {
    const result = await db.inquiryItem.updateMany({ where: { id: link.id, rfqLineId: null }, data: { rfqLineId: link.rfqLineId } });
    if (result.count !== 1) throw new Error(`InquiryItem ${link.id} changed while applying its source link`);
  }
  for (const link of plan.supplierQuoteLinks) {
    if (link.rfqLineId) {
      const result = await db.supplierQuote.updateMany({ where: { id: link.id, rfqLineId: null }, data: { rfqLineId: link.rfqLineId } });
      if (result.count !== 1) throw new Error(`SupplierQuote ${link.id} changed while applying its RFQ line link`);
    }
    if (link.inquiryItemId) {
      const result = await db.supplierQuote.updateMany({ where: { id: link.id, inquiryItemId: null }, data: { inquiryItemId: link.inquiryItemId } });
      if (result.count !== 1) throw new Error(`SupplierQuote ${link.id} changed while applying its InquiryItem link`);
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply') || process.env.TRANSACTION_LINE_APPLY === 'true';
  try {
    const initial = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return readSnapshot(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
    const initialPlan = buildTransactionLineBackfillPlan(initial.input, () => randomUUID());
    const report: Record<string, unknown> = {
      mode: apply ? 'apply' : 'preflight-only',
      preflight: initialPlan.preflight,
      plan: initialPlan,
      preApplyReconciliation: reconcileTransactionLines(initial.reconciliation),
    };
    console.log(JSON.stringify(report, null, 2));

    if (!apply) {
      // A review or blocker must be explicitly acknowledged with --apply.
      if (initialPlan.status !== 'READY') process.exitCode = 1;
      return;
    }
    if (initialPlan.status === 'BLOCKED') throw new Error('Transaction-line backfill blocked by strict preflight; no rows were written.');

    const applied = await prisma.$transaction(async tx => {
      const latest = await readSnapshot(tx);
      const latestPlan = buildTransactionLineBackfillPlan(latest.input, () => randomUUID());
      if (latestPlan.status === 'BLOCKED') throw new Error('Transaction-line backfill changed during apply; strict preflight blocked the write.');
      await writePlan(tx, latestPlan);
      const afterWrite = await readSnapshot(tx);
      const reconciliation = reconcileTransactionLines(afterWrite.reconciliation);
      if (reconciliation.status === 'BLOCKED') throw new Error('Post-write transaction-line reconciliation blocked; the Serializable transaction was rolled back.');
      return { plan: latestPlan, reconciliation };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });

    const after = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return readSnapshot(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });
    const afterReport = reconcileTransactionLines(after.reconciliation);
    console.log(JSON.stringify({ appliedPlan: applied.plan, postApplyTransactionReconciliation: applied.reconciliation, postApplyEvidence: afterReport }, null, 2));
    if (afterReport.status === 'BLOCKED') process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
