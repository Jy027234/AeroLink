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

function projectSupplierQuoteMoney<T extends SupplierQuoteMoneySource & SupplierQuoteStatusShadow>(quote: T) {
  const { unitPriceDecimal, totalPriceDecimal, unitPrice, totalPrice, status, statusEnum, ...rest } = quote;
  return {
    ...rest,
    status: supplierQuoteStatus({ status, statusEnum }),
    unitPrice: preferredMoneyValue(unitPriceDecimal, unitPrice) ?? 0,
    totalPrice: preferredMoneyValue(totalPriceDecimal, totalPrice) ?? 0,
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
          { aiScore: 'desc' },
          { unitPrice: 'asc' },
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
        aiScore: q.aiScore,
        aiRecommendation: q.aiRecommendation,
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
        leadTimeDays: leadTimeDays || 0,
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
      throw new AppError('没有找到供应商报价', 404);
    }

    const minPrice = Math.min(...quotes.map(supplierQuoteUnitPrice));
    const maxPrice = Math.max(...quotes.map(supplierQuoteUnitPrice));
    const avgPrice = quotes.reduce((sum, q) => sum + supplierQuoteUnitPrice(q), 0) / quotes.length;

    const comparedQuotes = quotes.map((quote) => {
      const unitPrice = supplierQuoteUnitPrice(quote);
      const totalPrice = supplierQuoteTotalPrice(quote);
      const priceScore = maxPrice === minPrice ? 100 : ((maxPrice - unitPrice) / (maxPrice - minPrice)) * 100;
      const leadTimeScore = quote.leadTimeDays <= 7 ? 100 : Math.max(0, 100 - (quote.leadTimeDays - 7) * 5);
      const supplierScore = quote.supplier.performanceScore || 50;
      const qualityScore = (quote.supplier.performanceScore || 50) * 0.8 + 10;
      const responseScore = quote.supplier.leadTime ? Math.max(0, 100 - quote.supplier.leadTime / 6) : 50;

      const aiScore =
        priceScore * 0.35 +
        leadTimeScore * 0.2 +
        supplierScore * 0.2 +
        qualityScore * 0.15 +
        responseScore * 0.1;

      let recommendation = '';
      if (aiScore >= 80) {
        recommendation = '强烈推荐 - 综合表现优异';
      } else if (aiScore >= 60) {
        recommendation = '推荐 - 可作为首选供应商';
      } else if (aiScore >= 40) {
        recommendation = '考虑 - 性价比一般';
      } else {
        recommendation = '不推荐 - 存在明显劣势';
      }

      const priceDiff = ((unitPrice - minPrice) / minPrice * 100).toFixed(1);

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
        scores: {
          price: Math.round(priceScore),
          leadTime: Math.round(leadTimeScore),
          supplier: Math.round(supplierScore),
          quality: Math.round(qualityScore),
          response: Math.round(responseScore),
        },
        aiScore: Math.round(aiScore * 100) / 100,
        aiRecommendation: recommendation,
        status: supplierQuoteStatus(quote),
        isWinner: quote.isWinner,
      };
    });

    comparedQuotes.sort((a, b) => b.aiScore - a.aiScore);

    const bestMatch = comparedQuotes[0];

    await Promise.all(
      comparedQuotes.map((q) =>
        prisma.supplierQuote.update({
          where: { id: q.id },
          data: {
            aiScore: q.aiScore,
            aiRecommendation: q.aiRecommendation,
          },
        })
      )
    );

    res.json({
      success: true,
      data: {
        quotes: comparedQuotes,
        bestMatch,
        summary: {
          totalQuotes: quotes.length,
          lowestPrice: minPrice,
          highestPrice: maxPrice,
          averagePrice: Math.round(avgPrice * 100) / 100,
        },
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
      message: '已选择最优供应商',
      data: projectSupplierQuoteMoney(updated),
    });
  })
);

export default router;
