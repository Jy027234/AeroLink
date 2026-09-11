import { Router } from 'express';
import { Prisma, type RfqStatusEnum, type SupplierQuoteStatusEnum } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { calculateMoneyTotal, normalizeMoney, preferredMoneyValue } from '../lib/money.js';
import {
  preferredRfqStatus,
  preferredSupplierQuoteStatus,
  toSupplierQuoteStatusEnum,
} from '../lib/transactionStatusShadows.js';
import { supplierQuoteCreateSchema, supplierQuoteUpdateSchema } from '../lib/validation.js';
import prisma from '../lib/prisma.js';
import {
  assertQuotationMatchesRfq,
  supplierQuoteCurrencyStatus,
  VERIFIED_CURRENCY_STATUS,
} from '../lib/commercialCostSource.js';

const router = Router();

type SupplierQuoteMoneySource = {
  unitPrice: number;
  unitPriceDecimal: Prisma.Decimal | null;
  totalPrice: number;
  totalPriceDecimal: Prisma.Decimal | null;
};

type SupplierQuoteStatusShadow = {
  status: string;
  statusEnum?: SupplierQuoteStatusEnum | null;
};

type SupplierQuoteLegacyComparison = {
  aiScore?: number | null;
  aiRecommendation?: string | null;
};

type SupplierQuoteCurrency = {
  currency?: string | null;
  currencyReviewStatus?: string | null;
};

type RfqStatusShadow = {
  status: string;
  statusEnum?: RfqStatusEnum | null;
};

type SupplierQuoteSourceBindingInput = {
  rfqId?: string | null;
  rfqLineId?: string | null;
  inquiryId?: string | null;
  inquiryItemId?: string | null;
  supplierId: string;
  partNumber: string;
  quantity: number;
};

type SupplierQuoteSourceBinding = {
  rfqId: string | null;
  rfqLineId: string | null;
  inquiryId: string | null;
  inquiryItemId: string | null;
};

const supplierQuoteLineSelect = {
  id: true,
  rfqId: true,
  partNumber: true,
  quantity: true,
  alternatePartNumbers: true,
} satisfies Prisma.RfqLineSelect;

const supplierQuoteRfqSelect = {
  id: true,
  partNumber: true,
  quantity: true,
  alternatePartNumbers: true,
} satisfies Prisma.RFQSelect;

/**
 * Resolve supplier quote provenance by immutable IDs inside the create
 * transaction. A legacy RFQ with no lines remains unbound; a multi-line RFQ
 * must carry an explicit line ID so later quotation-line reconciliation cannot
 * silently attach a quote by part-number text alone.
 */
async function resolveSupplierQuoteSourceBinding(
  tx: Prisma.TransactionClient,
  input: SupplierQuoteSourceBindingInput,
): Promise<SupplierQuoteSourceBinding> {
  let rfqId = input.rfqId || null;
  let rfqLineId = input.rfqLineId || null;
  let inquiryId = input.inquiryId || null;
  let inquiryItemId = input.inquiryItemId || null;

  let rfq = rfqId
    ? await tx.rFQ.findUnique({ where: { id: rfqId }, select: supplierQuoteRfqSelect })
    : null;
  if (rfqId && !rfq) {
    throw new AppError('关联 RFQ 不存在', 404, 'RESOURCE_NOT_FOUND');
  }

  let inquiry = inquiryId
    ? await tx.inquiry.findUnique({
      where: { id: inquiryId },
      select: { id: true, rfqId: true, supplierId: true },
    })
    : null;
  if (inquiryId && !inquiry) {
    throw new AppError('关联询价单不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  if (inquiry && inquiry.supplierId !== input.supplierId) {
    throw new AppError('供应商报价的供应商与询价单不一致', 409, 'RESOURCE_CONFLICT');
  }
  if (inquiry?.rfqId) {
    if (rfqId && rfqId !== inquiry.rfqId) {
      throw new AppError('询价单与 RFQ 不一致', 409, 'RESOURCE_CONFLICT');
    }
    rfqId = inquiry.rfqId;
    if (!rfq) {
      rfq = await tx.rFQ.findUnique({ where: { id: rfqId }, select: supplierQuoteRfqSelect });
    }
    if (!rfq) {
      throw new AppError('询价单关联的 RFQ 不存在', 409, 'RESOURCE_CONFLICT');
    }
  }

  let rfqLine = rfqLineId
    ? await tx.rfqLine.findUnique({ where: { id: rfqLineId }, select: supplierQuoteLineSelect })
    : null;
  if (rfqLineId && !rfqLine) {
    throw new AppError('指定的 RFQ 需求行不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  if (rfqLine) {
    if (rfqId && rfqLine.rfqId !== rfqId) {
      throw new AppError('RFQ 需求行不属于当前 RFQ', 409, 'INVALID_RFQ_LINE');
    }
    if (!rfqId) {
      rfqId = rfqLine.rfqId;
      rfq = await tx.rFQ.findUnique({ where: { id: rfqId }, select: supplierQuoteRfqSelect });
      if (!rfq) {
        throw new AppError('RFQ 需求行关联的 RFQ 不存在', 409, 'RESOURCE_CONFLICT');
      }
    }
    assertQuotationMatchesRfq(input.partNumber, input.quantity, rfqLine);
  } else if (rfq) {
    const lines = await tx.rfqLine.findMany({
      where: { rfqId: rfq.id },
      select: supplierQuoteLineSelect,
      orderBy: { lineNo: 'asc' },
    });
    if (lines.length > 1) {
      throw new AppError('多行 RFQ 必须明确指定 rfqLineId，不能按件号猜测', 409, 'LINE_ID_REQUIRED');
    }
    if (lines.length === 1) {
      [rfqLine] = lines;
      rfqLineId = rfqLine.id;
      assertQuotationMatchesRfq(input.partNumber, input.quantity, rfqLine);
    } else {
      // Legacy RFQs have no immutable line identity. Keep the quote readable
      // for migration/review, but do not invent a line binding.
      assertQuotationMatchesRfq(input.partNumber, input.quantity, rfq);
    }
  }

  if (rfq && !rfqLine && rfqId) {
    assertQuotationMatchesRfq(input.partNumber, input.quantity, rfq);
  }

  let inquiryItem = inquiryItemId
    ? await tx.inquiryItem.findUnique({
      where: { id: inquiryItemId },
      select: {
        id: true,
        inquiryId: true,
        rfqLineId: true,
        partNumber: true,
        quantity: true,
        inquiry: { select: { id: true, rfqId: true, supplierId: true } },
      },
    })
    : null;
  if (inquiryItemId && !inquiryItem) {
    throw new AppError('指定的询价需求项不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  if (inquiryItem) {
    if (inquiryId && inquiryItem.inquiryId !== inquiryId) {
      throw new AppError('询价需求项不属于当前询价单', 409, 'RESOURCE_CONFLICT');
    }
    if (!inquiryId) inquiryId = inquiryItem.inquiryId;
    inquiry = inquiry ?? inquiryItem.inquiry;
    if (inquiry.supplierId !== input.supplierId) {
      throw new AppError('供应商报价的供应商与询价需求项不一致', 409, 'RESOURCE_CONFLICT');
    }
    if (inquiry.rfqId) {
      if (rfqId && inquiry.rfqId !== rfqId) {
        throw new AppError('询价需求项与 RFQ 不一致', 409, 'RESOURCE_CONFLICT');
      }
      rfqId = inquiry.rfqId;
    }
    if (rfqLineId && inquiryItem.rfqLineId !== rfqLineId) {
      throw new AppError('询价需求项与 RFQ 需求行不一致', 409, 'INVALID_RFQ_LINE');
    }
    if (rfqLineId && inquiryItem.rfqLineId === rfqLineId) {
      if (input.quantity > inquiryItem.quantity) {
        throw new AppError('供应商报价数量不能超过询价需求项数量', 409, 'RESOURCE_CONFLICT');
      }
    } else if (inquiryItem.rfqLineId) {
      rfqLineId = inquiryItem.rfqLineId;
      rfqLine = await tx.rfqLine.findUnique({ where: { id: rfqLineId }, select: supplierQuoteLineSelect });
      if (!rfqLine) {
        throw new AppError('询价需求项关联的 RFQ 需求行不存在', 409, 'RESOURCE_CONFLICT');
      }
      if (rfqId && rfqLine.rfqId !== rfqId) {
        throw new AppError('询价需求项与 RFQ 不一致', 409, 'INVALID_RFQ_LINE');
      }
      if (!rfqId) rfqId = rfqLine.rfqId;
      assertQuotationMatchesRfq(input.partNumber, input.quantity, rfqLine);
      if (input.quantity > inquiryItem.quantity) {
        throw new AppError('供应商报价数量不能超过询价需求项数量', 409, 'RESOURCE_CONFLICT');
      }
    } else if (rfqLine) {
      throw new AppError('询价需求项缺少 RFQ 需求行，不能安全绑定', 409, 'LINE_ID_REQUIRED');
    }
  }

  if (inquiry && rfqLineId && !inquiryItemId) {
    const matchingItems = await tx.inquiryItem.findMany({
      where: { inquiryId: inquiry.id, rfqLineId },
      select: {
        id: true,
        inquiryId: true,
        rfqLineId: true,
        partNumber: true,
        quantity: true,
      },
    });
    if (matchingItems.length !== 1) {
      throw new AppError('指定询价单无法唯一匹配 RFQ 需求项', 409, 'LINE_ID_REQUIRED');
    }
    const matchedItem = matchingItems[0];
    inquiryItemId = matchedItem.id;
    if (input.quantity > matchedItem.quantity) {
      throw new AppError('供应商报价数量不能超过询价需求项数量', 409, 'RESOURCE_CONFLICT');
    }
  }

  return { rfqId, rfqLineId, inquiryId, inquiryItemId };
}

function supplierQuoteStatus(quote: SupplierQuoteStatusShadow) {
  return preferredSupplierQuoteStatus(quote.statusEnum, quote.status);
}

function projectRfqStatus<T extends RfqStatusShadow>(rfq: T | null) {
  if (!rfq) {
    return rfq;
  }

  const { status, statusEnum, ...rest } = rfq;
  return {
    ...rest,
    status: preferredRfqStatus(statusEnum, status),
  };
}

function supplierQuoteUnitPrice(quote: Pick<SupplierQuoteMoneySource, 'unitPrice' | 'unitPriceDecimal'>) {
  return preferredMoneyValue(quote.unitPriceDecimal, quote.unitPrice) ?? 0;
}

function supplierQuoteTotalPrice(quote: Pick<SupplierQuoteMoneySource, 'totalPrice' | 'totalPriceDecimal'>) {
  return preferredMoneyValue(quote.totalPriceDecimal, quote.totalPrice) ?? 0;
}

function projectSupplierQuoteMoney<
  T extends SupplierQuoteMoneySource & SupplierQuoteStatusShadow & SupplierQuoteLegacyComparison & SupplierQuoteCurrency,
>(quote: T) {
  const {
    unitPriceDecimal,
    totalPriceDecimal,
    unitPrice,
    totalPrice,
    status,
    statusEnum,
    aiScore: _legacyAiScore,
    aiRecommendation: _legacyAiRecommendation,
    currency: rawCurrency,
    currencyReviewStatus,
    ...rest
  } = quote;
  return {
    ...rest,
    currency: rawCurrency || null,
    currencyStatus: supplierQuoteCurrencyStatus(rawCurrency, currencyReviewStatus),
    status: supplierQuoteStatus({ status, statusEnum }),
    unitPrice: preferredMoneyValue(unitPriceDecimal, unitPrice) ?? 0,
    totalPrice: preferredMoneyValue(totalPriceDecimal, totalPrice) ?? 0,
    // Legacy aiScore/aiRecommendation values did not retain the inputs or
    // version needed to audit them. Do not project them as current analysis.
    ruleScore: null,
  };
}

router.get(
  '/',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const { rfqId, inquiryId, status, partNumber } = req.query;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.SupplierQuoteWhereInput = {};
    if (rfqId) where.rfqId = rfqId.toString();
    if (inquiryId) where.inquiryId = inquiryId.toString();
    if (status) where.status = status.toString();
    if (partNumber) where.partNumber = { contains: partNumber.toString() };

    const [quotes, total] = await Promise.all([
      prisma.supplierQuote.findMany({
        where,
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              level: true,
              performanceScore: true,
              contactName: true,
              email: true,
            },
          },
        },
        orderBy: [
          { isWinner: 'desc' },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
        skip,
        take: limit,
      }),
      prisma.supplierQuote.count({ where }),
    ]);

    res.json({
      success: true,
      data: quotes.map((q) => ({
        id: q.id,
        rfqId: q.rfqId,
        rfqLineId: q.rfqLineId,
        inquiryId: q.inquiryId,
        inquiryItemId: q.inquiryItemId,
        partNumber: q.partNumber,
        description: q.description,
        quantity: q.quantity,
        unitPrice: supplierQuoteUnitPrice(q),
         totalPrice: supplierQuoteTotalPrice(q),
         currency: q.currency || null,
         currencyStatus: supplierQuoteCurrencyStatus(q.currency, q.currencyReviewStatus),
        leadTimeDays: q.leadTimeDays,
        validUntil: q.validUntil?.toISOString() || null,
        notes: q.notes,
        status: supplierQuoteStatus(q),
        isWinner: q.isWinner,
        ruleScore: null,
        createdAt: q.createdAt.toISOString(),
        supplier: {
          id: q.supplier.id,
          name: q.supplier.name,
          level: q.supplier.level,
          performanceScore: q.supplier.performanceScore,
          contactName: q.supplier.contactName,
          contactEmail: q.supplier.email,
        },
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

router.get(
  '/:id',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const quote = await prisma.supplierQuote.findUnique({
      where: { id: req.params.id },
      include: {
        supplier: true,
        rfq: true,
        inquiry: true,
      },
    });

    if (!quote) {
      throw new AppError('供应商报价不存在', 404);
    }

    res.json({
      success: true,
      data: {
        ...projectSupplierQuoteMoney(quote),
        rfq: projectRfqStatus(quote.rfq),
      },
    });
  })
);

router.post(
  '/',
  requireCapability('supplier_quote', 'create'),
  validateBody(supplierQuoteCreateSchema),
  asyncHandler(async (req, res) => {
    const {
      rfqId,
      rfqLineId,
      inquiryId,
      inquiryItemId,
      supplierId,
      partNumber,
      description,
      quantity,
      unitPrice,
      currency,
      leadTimeDays,
      validUntil,
      notes,
    } = req.body;
    const unitPriceDecimal = normalizeMoney(unitPrice);
    const totalPriceDecimal = calculateMoneyTotal(unitPriceDecimal, quantity);
    const quote = await prisma.$transaction(async (tx) => {
      const source = await resolveSupplierQuoteSourceBinding(tx, {
        rfqId,
        rfqLineId,
        inquiryId,
        inquiryItemId,
        supplierId,
        partNumber,
        quantity,
      });
      return tx.supplierQuote.create({
        data: {
          rfqId: source.rfqId,
          rfqLineId: source.rfqLineId,
          inquiryId: source.inquiryId,
          inquiryItemId: source.inquiryItemId,
          supplierId,
          partNumber,
          description,
          quantity,
          unitPrice: unitPriceDecimal.toNumber(),
          unitPriceDecimal,
          totalPrice: totalPriceDecimal.toNumber(),
          totalPriceDecimal,
          leadTimeDays,
          validUntil: validUntil ? new Date(validUntil) : null,
          notes,
          status: 'pending',
          statusEnum: toSupplierQuoteStatusEnum('pending')!,
          currency,
          currencyReviewStatus: VERIFIED_CURRENCY_STATUS,
        },
      });
    });

    res.status(201).json({
      success: true,
      data: projectSupplierQuoteMoney(quote),
    });
  })
);

router.put(
  '/:id',
  requireCapability('supplier_quote', 'update'),
  validateBody(supplierQuoteUpdateSchema),
  asyncHandler(async (req, res) => {
    const {
      unitPrice,
      quantity,
      currency,
      leadTimeDays,
      validUntil,
      notes,
      status,
      isWinner,
      rfqId,
      rfqLineId,
      inquiryId,
      inquiryItemId,
      partNumber,
    } = req.body;

    const existing = await prisma.supplierQuote.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('供应商报价不存在', 404);
    }

    const identityChanges = [
      ['rfqId', rfqId, existing.rfqId],
      ['rfqLineId', rfqLineId, existing.rfqLineId],
      ['inquiryId', inquiryId, existing.inquiryId],
      ['inquiryItemId', inquiryItemId, existing.inquiryItemId],
      ['partNumber', partNumber, existing.partNumber],
    ].filter(([, requested, current]) => requested !== undefined && requested !== current);
    if (identityChanges.length > 0) {
      const [quotationReference, quotationLineReference] = await Promise.all([
        prisma.quotation.findFirst({
          where: { costSourceType: 'SUPPLIER_QUOTE', costSourceId: existing.id },
          select: { id: true },
        }),
        prisma.quotationLine.findFirst({
          where: { sourceSupplierQuoteId: existing.id },
          select: { id: true },
        }),
      ]);
      if (quotationReference || quotationLineReference) {
        throw new AppError('供应商报价已被报价或报价行引用，不能修改来源身份', 409, 'STATE_CONFLICT');
      }
      throw new AppError('供应商报价来源身份不可修改，请新建供应商报价', 409, 'STATE_CONFLICT');
    }

    if (quantity !== undefined && existing.rfqId) {
      const currentScope = existing.rfqLineId
        ? await prisma.rfqLine.findUnique({ where: { id: existing.rfqLineId }, select: supplierQuoteLineSelect })
        : await prisma.rFQ.findUnique({ where: { id: existing.rfqId }, select: supplierQuoteRfqSelect });
      if (!currentScope) {
        throw new AppError('供应商报价来源 RFQ 需求范围不存在', 409, 'RESOURCE_CONFLICT');
      }
      assertQuotationMatchesRfq(existing.partNumber, quantity, currentScope);
      if (existing.inquiryItemId) {
        const currentItem = await prisma.inquiryItem.findUnique({ where: { id: existing.inquiryItemId }, select: { quantity: true } });
        if (!currentItem || quantity > currentItem.quantity) {
          throw new AppError('供应商报价数量不能超过询价需求项数量', 409, 'RESOURCE_CONFLICT');
        }
      }
    }

    const updateData: Prisma.SupplierQuoteUpdateInput = {};
    const unitPriceDecimal = unitPrice === undefined ? undefined : normalizeMoney(unitPrice);
    const nextQuantity = quantity ?? existing.quantity;
    if (unitPriceDecimal) {
      updateData.unitPrice = unitPriceDecimal.toNumber();
      updateData.unitPriceDecimal = unitPriceDecimal;
    }
    if (currency !== undefined) {
      updateData.currency = currency;
      updateData.currencyReviewStatus = VERIFIED_CURRENCY_STATUS;
    }
    if (leadTimeDays !== undefined) updateData.leadTimeDays = leadTimeDays;
    if (validUntil !== undefined) updateData.validUntil = new Date(validUntil);
    if (notes !== undefined) updateData.notes = notes;
    if (status !== undefined) {
      const statusEnum = toSupplierQuoteStatusEnum(status);
      if (!statusEnum) {
        throw new AppError('供应商报价状态无效', 400, 'BAD_REQUEST');
      }
      updateData.status = statusEnum;
      updateData.statusEnum = statusEnum;
    }
    if (isWinner !== undefined) updateData.isWinner = isWinner;

    if (quantity !== undefined) updateData.quantity = quantity;
    if (unitPriceDecimal || quantity !== undefined) {
      const nextUnitPriceDecimal = unitPriceDecimal ?? normalizeMoney(preferredMoneyValue(existing.unitPriceDecimal, existing.unitPrice) ?? 0);
      const totalPriceDecimal = calculateMoneyTotal(nextUnitPriceDecimal, nextQuantity);
      updateData.totalPrice = totalPriceDecimal.toNumber();
      updateData.totalPriceDecimal = totalPriceDecimal;
    }

    const quote = await prisma.supplierQuote.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json({
      success: true,
      data: projectSupplierQuoteMoney(quote),
    });
  })
);

router.delete(
  '/:id',
  requireCapability('supplier_quote', 'delete'),
  asyncHandler(async (req, res) => {
    const quote = await prisma.supplierQuote.findUnique({
      where: { id: req.params.id },
    });

    if (!quote) {
      throw new AppError('供应商报价不存在', 404);
    }

    await prisma.supplierQuote.delete({
      where: { id: req.params.id },
    });

    res.json({
      success: true,
      message: '供应商报价已删除',
    });
  })
);

router.post(
  '/compare',
  requireCapability('supplier_quote', 'update'),
  asyncHandler(async (req, res) => {
    const { rfqId, inquiryId } = req.body;

    if (!rfqId && !inquiryId) {
      throw new AppError('必须提供 RFQ 或询价单标识，不能跨业务单据比较供应商报价', 400, 'BAD_REQUEST');
    }

    const where: Prisma.SupplierQuoteWhereInput = {};
    if (rfqId) where.rfqId = rfqId;
    if (inquiryId) where.inquiryId = inquiryId;

    const quotes = await prisma.supplierQuote.findMany({
      where,
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            level: true,
            performanceScore: true,
            leadTime: true,
          },
        },
      },
    });

    if (quotes.length === 0) {
      res.json({
        success: true,
        data: {
          quotes: [],
          topRanked: null,
          summary: {
            totalQuotes: 0,
            lowestPrice: null,
            highestPrice: null,
            averagePrice: null,
          },
          metadata: {
            status: 'unavailable',
            source: 'AeroLink supplier quote and supplier master records',
            algorithmVersion: 'supplier-quote-rule-v2',
            sampleSize: 0,
            asOf: new Date().toISOString(),
            reason: '尚无该 RFQ 或询价单的供应商报价，无法进行规则排序。',
            decisionBoundary: '不会根据其他 RFQ、估算价格或默认供应商表现生成比较结果。',
          },
        },
      });
      return;
    }

    const minPrice = Math.min(...quotes.map(supplierQuoteUnitPrice));
    const maxPrice = Math.max(...quotes.map(supplierQuoteUnitPrice));
    const avgPrice = quotes.reduce((sum, q) => sum + supplierQuoteUnitPrice(q), 0) / quotes.length;
    const missingPerformanceCount = quotes.filter((quote) => typeof quote.supplier.performanceScore !== 'number').length;
    const missingCurrencyCount = quotes.filter(
      (quote) => supplierQuoteCurrencyStatus(quote.currency, quote.currencyReviewStatus) !== VERIFIED_CURRENCY_STATUS,
    ).length;
    const comparisonAvailable = quotes.length >= 2 && missingPerformanceCount === 0 && missingCurrencyCount === 0;

    const comparedQuotes = quotes.map((quote) => {
      const unitPrice = supplierQuoteUnitPrice(quote);
      const totalPrice = supplierQuoteTotalPrice(quote);
      const priceScore = comparisonAvailable
        ? (maxPrice === minPrice ? 100 : ((maxPrice - unitPrice) / (maxPrice - minPrice)) * 100)
        : null;
      const leadTimeScore = comparisonAvailable
        ? (quote.leadTimeDays <= 7 ? 100 : Math.max(0, 100 - (quote.leadTimeDays - 7) * 5))
        : null;
      const supplierPerformanceScore = comparisonAvailable
        ? Math.min(100, Math.max(0, quote.supplier.performanceScore!))
        : null;
      const ruleScore = comparisonAvailable
        ? Math.round((priceScore! * 0.5 + leadTimeScore! * 0.3 + supplierPerformanceScore! * 0.2) * 10) / 10
        : null;
      const priceDiff = comparisonAvailable && minPrice > 0
        ? Math.round(((unitPrice - minPrice) / minPrice) * 1000) / 10
        : null;

      return {
        id: quote.id,
        partNumber: quote.partNumber,
        supplier: {
          id: quote.supplier.id,
          name: quote.supplier.name,
          level: quote.supplier.level,
          performanceScore: quote.supplier.performanceScore,
        },
         unitPrice,
         totalPrice,
         currency: quote.currency || null,
         currencyStatus: supplierQuoteCurrencyStatus(quote.currency, quote.currencyReviewStatus),
        leadTimeDays: quote.leadTimeDays,
        priceDiff,
        isLowestPrice: comparisonAvailable && unitPrice === minPrice,
        scoreComponents: {
          price: priceScore === null ? null : Math.round(priceScore),
          leadTime: leadTimeScore === null ? null : Math.round(leadTimeScore),
          supplierPerformance: supplierPerformanceScore === null ? null : Math.round(supplierPerformanceScore),
        },
        ruleScore,
        status: supplierQuoteStatus(quote),
        isWinner: quote.isWinner,
      };
    });

    if (comparisonAvailable) {
      comparedQuotes.sort((left, right) => (right.ruleScore ?? 0) - (left.ruleScore ?? 0));
    }

    const metadata = {
      status: comparisonAvailable ? 'available' : 'insufficient_data',
      source: 'AeroLink supplier quote and supplier master records',
      algorithmVersion: 'supplier-quote-rule-v2',
      sampleSize: quotes.length,
      asOf: new Date().toISOString(),
      reason: comparisonAvailable
        ? '规则仅对已录入的单价、交期和供应商绩效进行相对排序。'
        : quotes.length < 2
          ? '仅有 1 份报价，无法进行相对规则排序。'
          : missingCurrencyCount > 0
            ? `${missingCurrencyCount} 份报价币种仍待核，无法生成完整规则排序。`
            : `${missingPerformanceCount} 家供应商缺少绩效记录，无法生成完整规则排序。`,
      decisionBoundary: '不推测质量、响应速度、适航资质、可供货量、外部市场价格或客户偏好；规则排序仅供人工复核，不构成中选建议。',
    };

    res.json({
      success: true,
      data: {
        quotes: comparedQuotes,
        topRanked: comparisonAvailable ? comparedQuotes[0] : null,
        summary: {
          totalQuotes: quotes.length,
          lowestPrice: minPrice,
          highestPrice: maxPrice,
          averagePrice: Math.round(avgPrice * 100) / 100,
        },
        metadata,
      },
    });
  })
);

router.post(
  '/:id/select-winner',
  requireCapability('supplier_quote', 'update'),
  asyncHandler(async (req, res) => {
    const quoteId = req.params.id;

    const quote = await prisma.supplierQuote.findUnique({
      where: { id: quoteId },
    });

    if (!quote) {
      throw new AppError('供应商报价不存在', 404);
    }
    if (supplierQuoteCurrencyStatus(quote.currency, quote.currencyReviewStatus) !== VERIFIED_CURRENCY_STATUS) {
      throw new AppError('历史供应商报价币种待核，确认 USD 后才能标记中选', 409, 'STATE_CONFLICT');
    }
    if (quote.validUntil && quote.validUntil.getTime() <= Date.now()) {
      throw new AppError('供应商报价已过期，不能标记中选', 409, 'STATE_CONFLICT');
    }

    await prisma.supplierQuote.updateMany({
      where: {
        rfqId: quote.rfqId,
        inquiryId: quote.inquiryId,
      },
      data: { isWinner: false },
    });

    const updated = await prisma.supplierQuote.update({
      where: { id: quoteId },
      data: {
        isWinner: true,
        status: 'accepted',
        statusEnum: toSupplierQuoteStatusEnum('accepted')!,
      },
    });

    res.json({
      success: true,
      message: '供应商已标记为中选',
      data: projectSupplierQuoteMoney(updated),
    });
  })
);

export default router;
