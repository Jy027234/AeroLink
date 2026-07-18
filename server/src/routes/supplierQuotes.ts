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

type RfqStatusShadow = {
  status: string;
  statusEnum?: RfqStatusEnum | null;
};

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
  T extends SupplierQuoteMoneySource & SupplierQuoteStatusShadow & SupplierQuoteLegacyComparison,
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
    ...rest
  } = quote;
  return {
    ...rest,
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
        inquiryId: q.inquiryId,
        partNumber: q.partNumber,
        description: q.description,
        quantity: q.quantity,
        unitPrice: supplierQuoteUnitPrice(q),
        totalPrice: supplierQuoteTotalPrice(q),
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
      inquiryId,
      supplierId,
      partNumber,
      description,
      quantity,
      unitPrice,
      leadTimeDays,
      validUntil,
      notes,
    } = req.body;
    const unitPriceDecimal = normalizeMoney(unitPrice);
    const totalPriceDecimal = calculateMoneyTotal(unitPriceDecimal, quantity);

    const quote = await prisma.supplierQuote.create({
      data: {
        rfqId,
        inquiryId,
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
      },
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
      leadTimeDays,
      validUntil,
      notes,
      status,
      isWinner,
    } = req.body;

    const existing = await prisma.supplierQuote.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('供应商报价不存在', 404);
    }

    const updateData: Prisma.SupplierQuoteUpdateInput = {};
    const unitPriceDecimal = unitPrice === undefined ? undefined : normalizeMoney(unitPrice);
    if (unitPriceDecimal) {
      updateData.unitPrice = unitPriceDecimal.toNumber();
      updateData.unitPriceDecimal = unitPriceDecimal;
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

    if (unitPriceDecimal && existing.quantity) {
      const totalPriceDecimal = calculateMoneyTotal(unitPriceDecimal, existing.quantity);
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
    const comparisonAvailable = quotes.length >= 2 && missingPerformanceCount === 0;

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
      const priceDiff = minPrice > 0
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
        leadTimeDays: quote.leadTimeDays,
        priceDiff,
        isLowestPrice: unitPrice === minPrice,
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
