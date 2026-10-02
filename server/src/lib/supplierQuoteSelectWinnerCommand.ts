import { Prisma, type SupplierQuoteStatusEnum } from '@prisma/client';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { assertCapability } from '../middleware/capability.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  assertQuotationMatchesRfq,
  supplierQuoteCurrencyStatus,
  VERIFIED_CURRENCY_STATUS,
} from './commercialCostSource.js';
import { buildRfqReadScope } from './rfqAccess.js';
import prisma from './prisma.js';
import { compareQuantityUnits } from './validation.js';
import { preferredSupplierQuoteStatus, toSupplierQuoteStatusEnum } from './transactionStatusShadows.js';

const supplierQuoteLineSelect = {
  id: true,
  rfqId: true,
  partNumber: true,
  quantity: true,
  uom: true,
  alternatePartNumbers: true,
  certificateRequired: true,
  certificateType: true,
  conditionCode: true,
} satisfies Prisma.RfqLineSelect;

const supplierQuoteRfqSelect = {
  id: true,
  partNumber: true,
  quantity: true,
  uom: true,
  alternatePartNumbers: true,
  certificateRequired: true,
  certificateType: true,
  conditionCode: true,
} satisfies Prisma.RFQSelect;

type WinnerQuote = {
  rfqId: string | null;
  rfqLineId: string | null;
  inquiryId: string | null;
  inquiryItemId: string | null;
  supplierId: string;
  partNumber: string;
  quantity: number;
  quantityUnit?: string | null;
};

type WinnerStatusQuote = {
  status: string;
  statusEnum?: SupplierQuoteStatusEnum | null;
};

async function assertWinnerQuoteSource(
  tx: Prisma.TransactionClient,
  quote: WinnerQuote,
  expectedRfqId: string | null,
  expectedRfqLineId: string | null,
) {
  if (quote.inquiryId) {
    const inquiry = await tx.inquiry.findUnique({
      where: { id: quote.inquiryId },
      select: { id: true, rfqId: true, supplierId: true },
    });
    if (!inquiry || inquiry.supplierId !== quote.supplierId || (inquiry.rfqId && expectedRfqId && inquiry.rfqId !== expectedRfqId)) {
      throw new AppError('供应商报价的询价来源与 RFQ 或供应商不一致，不能标记中选', 409, 'RESOURCE_CONFLICT');
    }
  }
  if (quote.inquiryItemId) {
    const item = await tx.inquiryItem.findUnique({
      where: { id: quote.inquiryItemId },
      select: {
        id: true,
        inquiryId: true,
        rfqLineId: true,
        partNumber: true,
        quantity: true,
        inquiry: { select: { id: true, rfqId: true, supplierId: true } },
      },
    });
    if (
      !item || item.inquiryId !== quote.inquiryId || item.inquiry.supplierId !== quote.supplierId ||
      (item.inquiry.rfqId && expectedRfqId && item.inquiry.rfqId !== expectedRfqId) ||
      (expectedRfqLineId && item.rfqLineId !== expectedRfqLineId &&
        !(quote.rfqLineId === null && item.rfqLineId === null))
    ) {
      throw new AppError('供应商报价与询价需求项来源不一致，不能标记中选', 409, 'RESOURCE_CONFLICT');
    }
    if (item.rfqLineId) {
      const itemLine = await tx.rfqLine.findUnique({ where: { id: item.rfqLineId }, select: supplierQuoteLineSelect });
      if (!itemLine || (expectedRfqId && itemLine.rfqId !== expectedRfqId) ||
        (expectedRfqLineId && itemLine.id !== expectedRfqLineId)) {
        throw new AppError('供应商报价的询价需求项不属于中选需求行', 409, 'INVALID_RFQ_LINE');
      }
    }
  }
}

function assertWinnerQuantityUnit(quantityUnit: string | null | undefined, demandUnit: string | null | undefined) {
  const comparison = compareQuantityUnits(quantityUnit, demandUnit);
  if (comparison.compatible) return;
  const message = comparison.reason === 'UNIT_MISMATCH'
    ? '供应商报价数量单位与需求单位不兼容，不能标记中选'
    : comparison.reason === 'DEMAND_UNIT_UNKNOWN'
      ? '需求单位未知，不能标记供应商报价中选'
      : '供应商报价数量单位未知，不能标记中选';
  throw new AppError(message, 409, 'STATE_CONFLICT');
}

async function inquiryItemDemandUnit(tx: Prisma.TransactionClient, inquiryItemId: string): Promise<string | null> {
  const item = await tx.inquiryItem.findUnique({
    where: { id: inquiryItemId },
    select: {
      rfqLineId: true,
      rfqLine: { select: { uom: true } },
      inquiry: { select: { rfqId: true } },
    },
  });
  if (!item) return null;
  if (item.rfqLineId) return item.rfqLine?.uom ?? null;
  if (!item.inquiry.rfqId) return null;
  const lines = await tx.rfqLine.findMany({
    where: { rfqId: item.inquiry.rfqId },
    select: { id: true, uom: true },
  });
  if (lines.length > 1) return null;
  if (lines.length === 1) return lines[0].uom;
  const rfq = await tx.rFQ.findUnique({ where: { id: item.inquiry.rfqId }, select: { uom: true } });
  return rfq?.uom ?? null;
}

async function resolveWinnerClearScope(
  tx: Prisma.TransactionClient,
  quote: WinnerQuote,
): Promise<Prisma.SupplierQuoteWhereInput> {
  if (quote.rfqLineId) {
    const line = await tx.rfqLine.findUnique({ where: { id: quote.rfqLineId }, select: supplierQuoteLineSelect });
    if (!line || quote.rfqId !== line.rfqId) {
      throw new AppError('供应商报价与 RFQ 需求行来源不一致，不能标记中选', 409, 'INVALID_RFQ_LINE');
    }
    assertQuotationMatchesRfq(quote.partNumber, quote.quantity, line);
    assertWinnerQuantityUnit(quote.quantityUnit, line.uom);
    await assertWinnerQuoteSource(tx, quote, line.rfqId, line.id);
    const siblingLines = await tx.rfqLine.findMany({ where: { rfqId: line.rfqId }, select: supplierQuoteLineSelect });
    if (siblingLines.length === 1 && siblingLines[0].id === line.id) {
      // A historical quote for a one-line RFQ may predate rfqLineId. It still
      // represents this same line, so selecting a bound quote must clear both
      // shapes in the same transaction. Multi-line RFQs remain ID-only.
      return { rfqId: line.rfqId, OR: [{ rfqLineId: line.id }, { rfqLineId: null }] };
    }
    return { rfqLineId: line.id };
  }

  if (quote.rfqId) {
    const rfq = await tx.rFQ.findUnique({ where: { id: quote.rfqId }, select: supplierQuoteRfqSelect });
    if (!rfq) throw new AppError('供应商报价来源 RFQ 不存在', 409, 'RESOURCE_CONFLICT');
    const lines = await tx.rfqLine.findMany({ where: { rfqId: rfq.id }, select: supplierQuoteLineSelect });
    if (lines.length > 1) {
      throw new AppError('多行 RFQ 的报价没有需求行绑定，不能标记中选', 409, 'LINE_ID_REQUIRED');
    }
    const line = lines[0];
    assertQuotationMatchesRfq(quote.partNumber, quote.quantity, line ?? rfq);
    assertWinnerQuantityUnit(quote.quantityUnit, line?.uom ?? rfq.uom);
    await assertWinnerQuoteSource(tx, quote, rfq.id, line?.id ?? null);
    if (line) {
      return { rfqId: rfq.id, OR: [{ rfqLineId: line.id }, { rfqLineId: null }] };
    }
    return { rfqId: rfq.id, rfqLineId: null };
  }

  if (quote.inquiryItemId && quote.inquiryId) {
    await assertWinnerQuoteSource(tx, quote, null, null);
    assertWinnerQuantityUnit(quote.quantityUnit, await inquiryItemDemandUnit(tx, quote.inquiryItemId));
    return { inquiryId: quote.inquiryId, inquiryItemId: quote.inquiryItemId };
  }

  if (quote.inquiryId) {
    const inquiry = await tx.inquiry.findUnique({
      where: { id: quote.inquiryId },
      select: { id: true, rfqId: true, supplierId: true },
    });
    if (!inquiry || inquiry.supplierId !== quote.supplierId) {
      throw new AppError('供应商报价的询价来源与供应商不一致，不能标记中选', 409, 'RESOURCE_CONFLICT');
    }
    const lines = inquiry.rfqId
      ? await tx.rfqLine.findMany({ where: { rfqId: inquiry.rfqId }, select: supplierQuoteLineSelect })
      : [];
    if (lines.length > 1) {
      throw new AppError('多行 RFQ 的报价没有需求行绑定，不能标记中选', 409, 'LINE_ID_REQUIRED');
    }
    if (lines.length === 1) {
      assertQuotationMatchesRfq(quote.partNumber, quote.quantity, lines[0]);
      assertWinnerQuantityUnit(quote.quantityUnit, lines[0].uom);
      await assertWinnerQuoteSource(tx, quote, inquiry.rfqId, null);
      return { inquiryId: inquiry.id, OR: [{ rfqLineId: lines[0].id }, { rfqLineId: null }] };
    }
    const items = await tx.inquiryItem.findMany({
      where: { inquiryId: inquiry.id },
      select: { id: true, rfqLineId: true, partNumber: true, quantity: true },
    });
    if (items.length === 0) {
      throw new AppError('询价单缺少可复核的需求项，不能安全标记中选', 409, 'LINE_ID_REQUIRED');
    }
    const itemScopes = new Set(items.map((item) => item.rfqLineId || item.id));
    if (itemScopes.size > 1) {
      throw new AppError('询价单包含多条需求项，报价没有需求行绑定，不能标记中选', 409, 'LINE_ID_REQUIRED');
    }
    const onlyItemLineId = items[0].rfqLineId;
    if (onlyItemLineId) {
      const itemLine = await tx.rfqLine.findUnique({ where: { id: onlyItemLineId }, select: supplierQuoteLineSelect });
      if (!itemLine || (inquiry.rfqId && itemLine.rfqId !== inquiry.rfqId) || quote.rfqId !== itemLine.rfqId) {
        throw new AppError('供应商报价与询价需求项的 RFQ 来源不一致', 409, 'INVALID_RFQ_LINE');
      }
      assertQuotationMatchesRfq(quote.partNumber, quote.quantity, itemLine);
      assertWinnerQuantityUnit(quote.quantityUnit, itemLine.uom);
      await assertWinnerQuoteSource(tx, quote, itemLine.rfqId, null);
      return { rfqLineId: itemLine.id };
    }
    await assertWinnerQuoteSource(tx, quote, inquiry.rfqId, null);
    const demandUnit = inquiry.rfqId
      ? (await tx.rFQ.findUnique({ where: { id: inquiry.rfqId }, select: { uom: true } }))?.uom ?? null
      : null;
    assertWinnerQuantityUnit(quote.quantityUnit, demandUnit);
    return { inquiryId: inquiry.id, inquiryItemId: null };
  }

  throw new AppError('供应商报价缺少可复核的 RFQ 或询价需求行来源，不能标记中选', 409, 'LINE_ID_REQUIRED');
}

function supplierQuoteStatus(quote: WinnerStatusQuote) {
  return preferredSupplierQuoteStatus(quote.statusEnum, quote.status);
}

function supplierQuoteStatusIsAvailable(status: string) {
  const normalized = status.trim().toLowerCase();
  return normalized === 'pending' || normalized === 'accepted';
}

export async function assertWinnerRfqReadAccess(actor: AuthenticatedUser, rfqId: string | null, tx: Prisma.TransactionClient) {
  if (!rfqId) return;
  assertCapability(actor, 'rfq', 'read');
  const rfq = await tx.rFQ.findFirst({
    where: { AND: [{ id: rfqId }, buildRfqReadScope(actor)] },
    select: { id: true, createdBy: true, creator: { select: { department: true } } },
  });
  if (!rfq) throw new AppError('关联 RFQ 不存在', 404, 'RESOURCE_NOT_FOUND');
  assertCapability(actor, 'rfq', 'read', { ownerId: rfq.createdBy, department: rfq.creator?.department });
}

export async function prepareSupplierQuoteWinnerInTransaction(
  tx: Prisma.TransactionClient,
  quoteId: string,
  actor: AuthenticatedUser,
  expectedUpdatedAt?: Date,
) {
  assertCapability(actor, 'supplier_quote', 'update');

    const quote = await tx.supplierQuote.findUnique({ where: { id: quoteId } });
    if (!quote) throw new AppError('供应商报价不存在', 404, 'RESOURCE_NOT_FOUND');
    if (expectedUpdatedAt && quote.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      throw new AppError('供应商报价版本已变化，请刷新后确认中选', 409, 'STATE_CONFLICT');
    }
    if (quote.supersededAt) throw new AppError('已修订的报价不能标记中选', 409, 'STATE_CONFLICT');
    if (supplierQuoteCurrencyStatus(quote.currency, quote.currencyReviewStatus) !== VERIFIED_CURRENCY_STATUS) {
      throw new AppError('历史供应商报价币种待核，确认 USD 后才能标记中选', 409, 'STATE_CONFLICT');
    }
    const currentStatus = supplierQuoteStatus(quote);
    if (!supplierQuoteStatusIsAvailable(currentStatus)) {
      throw new AppError('供应商报价状态不可用，不能标记中选', 409, 'STATE_CONFLICT');
    }
    if (quote.validUntil && quote.validUntil.getTime() <= Date.now()) {
      throw new AppError('供应商报价已过期，不能标记中选', 409, 'STATE_CONFLICT');
    }

    await assertWinnerRfqReadAccess(actor, quote.rfqId, tx);
    const clearScope = await resolveWinnerClearScope(tx, quote);
    return { quote, clearScope, currentStatus };
}

export async function selectSupplierQuoteWinnerInTransaction(
  tx: Prisma.TransactionClient,
  quoteId: string,
  actor: AuthenticatedUser,
  expectedUpdatedAt?: Date,
) {
    const { quote, clearScope, currentStatus } = await prepareSupplierQuoteWinnerInTransaction(tx, quoteId, actor, expectedUpdatedAt);
    if (quote.isWinner && currentStatus === 'accepted') return quote;

    // The line scoped clear and winner update share a serializable transaction.
    // Concurrent selections for one line therefore serialize or one fails with P2034.
    await tx.supplierQuote.updateMany({ where: clearScope, data: { isWinner: false } });
    const winner = await tx.supplierQuote.update({
      where: { id: quoteId, supersededAt: null },
      data: {
        isWinner: true,
        status: 'accepted',
        statusEnum: toSupplierQuoteStatusEnum('accepted')!,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: actor.id,
        userName: actor.name || null,
        userRole: actor.role,
        action: 'APPROVE',
        resourceType: 'SUPPLIER_QUOTE',
        resourceId: quoteId,
        details: 'Selected current sourcing winner',
      },
    });
    return winner;
}

export async function selectSupplierQuoteWinner(
  quoteId: string,
  actor: AuthenticatedUser,
) {
  return prisma.$transaction(
    (tx) => selectSupplierQuoteWinnerInTransaction(tx, quoteId, actor),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
