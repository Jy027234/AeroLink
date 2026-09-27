import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { assertCapability } from '../middleware/capability.js';
import { AppError } from '../middleware/errorHandler.js';
import { getCapabilityScope } from './capabilityPolicy.js';
import { assertWinnerRfqReadAccess, prepareSupplierQuoteWinnerInTransaction } from './supplierQuoteSelectWinnerCommand.js';

export const SELECT_WINNER_ACTION = 'SELECT_WINNER';

export async function assertWinnerTaskReadAccess(
  tx: Prisma.TransactionClient,
  actor: AuthenticatedUser,
  quoteId: string,
) {
  assertCapability(actor, 'supplier_quote', 'read');
  const quote = await tx.supplierQuote.findUnique({
    where: { id: quoteId },
    select: { id: true, rfqId: true, inquiry: { select: { rfqId: true } } },
  });
  if (!quote) throw new AppError('供应商报价不存在', 404, 'RESOURCE_NOT_FOUND');
  const rfqId = quote.rfqId ?? quote.inquiry?.rfqId ?? null;
  if (rfqId) await assertWinnerRfqReadAccess(actor, rfqId, tx);
  else if (getCapabilityScope(actor, 'rfq.read') !== 'all') {
    throw new AppError('供应商报价来源不可核实', 404, 'RESOURCE_NOT_FOUND');
  }
  return quote;
}

/**
 * Capture the exact quote and related demand/source facts shown for a staged
 * winner decision. Confirmation captures them again and must reject a mismatch
 * before invoking the same transaction-bound command as the manual route.
 */
export async function captureWinnerTargetVersion(
  tx: Prisma.TransactionClient,
  actor: AuthenticatedUser,
  quoteId: string,
) {
  await assertWinnerTaskReadAccess(tx, actor, quoteId);
  const { quote } = await prepareSupplierQuoteWinnerInTransaction(tx, quoteId, actor);
  const [inquiry, inquiryItem] = await Promise.all([
    quote.inquiryId ? tx.inquiry.findUnique({
      where: { id: quote.inquiryId },
      select: { id: true, rfqId: true, supplierId: true, status: true },
    }) : Promise.resolve(null),
    quote.inquiryItemId ? tx.inquiryItem.findUnique({
      where: { id: quote.inquiryItemId },
      select: { id: true, inquiryId: true, rfqLineId: true, partNumber: true, quantity: true },
    }) : Promise.resolve(null),
  ]);
  const rfqId = quote.rfqId ?? inquiry?.rfqId ?? null;
  const [rfq, lines] = rfqId ? await Promise.all([
    tx.rFQ.findUnique({ where: { id: rfqId }, select: { id: true, status: true, version: true } }),
    tx.rfqLine.findMany({
      where: { rfqId },
      orderBy: [{ lineNo: 'asc' }, { id: 'asc' }],
      select: {
        id: true, rfqId: true, lineNo: true, partNumber: true, quantity: true,
        uom: true, status: true, conditionCode: true, certificateRequired: true,
        certificateType: true, alternatePartNumbers: true, updatedAt: true,
      },
    }),
  ]) : [null, []];

  const source = {
    quote: {
      id: quote.id,
      rfqId: quote.rfqId,
      rfqLineId: quote.rfqLineId,
      inquiryId: quote.inquiryId,
      inquiryItemId: quote.inquiryItemId,
      supplierId: quote.supplierId,
      partNumber: quote.partNumber,
      quantity: quote.quantity,
      quantityUnit: quote.quantityUnit,
      unitPrice: quote.unitPrice,
      currency: quote.currency,
      leadTimeDays: quote.leadTimeDays,
      validUntil: quote.validUntil?.toISOString() ?? null,
      status: quote.status,
      isWinner: quote.isWinner,
      updatedAt: quote.updatedAt.toISOString(),
      supersededAt: quote.supersededAt?.toISOString() ?? null,
    },
    inquiry,
    inquiryItem,
    rfq,
    lines,
  };
  const targetVersion = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  return { quote, targetVersion };
}
