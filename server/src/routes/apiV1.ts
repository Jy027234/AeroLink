import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { apiKeyAuth, requireScope } from '../middleware/apiKeyAuth.js';
import prisma from '../lib/prisma.js';

const router = Router();

// 所有开放 API 都需要 API Key 认证
router.use(apiKeyAuth);

// ============================================
// RFQ API
// ============================================

router.get(
  '/rfqs',
  asyncHandler(async (req, res) => {
    const { status, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: any = {};
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      prisma.rFQ.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      prisma.rFQ.count({ where }),
    ]);

    res.json({ success: true, data, pagination: { page: pageNum, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  })
);

router.get(
  '/rfqs/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await prisma.rFQ.findUnique({ where: { id } });
    if (!data) throw new AppError('RFQ 不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data });
  })
);

// ============================================
// Quotation API
// ============================================

router.get(
  '/quotations',
  asyncHandler(async (req, res) => {
    const { status, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: any = {};
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      prisma.quotation.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      prisma.quotation.count({ where }),
    ]);

    res.json({ success: true, data, pagination: { page: pageNum, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  })
);

router.get(
  '/quotations/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await prisma.quotation.findUnique({ where: { id } });
    if (!data) throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data });
  })
);

// ============================================
// Order API
// ============================================

router.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const { status, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: any = {};
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      prisma.order.count({ where }),
    ]);

    res.json({ success: true, data, pagination: { page: pageNum, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  })
);

router.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await prisma.order.findUnique({ where: { id } });
    if (!data) throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data });
  })
);

// ============================================
// Inventory API
// ============================================

router.get(
  '/inventory',
  asyncHandler(async (req, res) => {
    const { partNumber, conditionCode, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: any = {};
    if (partNumber) where.partNumber = { contains: partNumber };
    if (conditionCode) where.conditionCode = conditionCode;

    const [data, total] = await Promise.all([
      prisma.inventory.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      prisma.inventory.count({ where }),
    ]);

    res.json({ success: true, data, pagination: { page: pageNum, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  })
);

router.get(
  '/inventory/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await prisma.inventory.findUnique({ where: { id } });
    if (!data) throw new AppError('库存不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data });
  })
);

// ============================================
// Customer API
// ============================================

router.get(
  '/customers',
  asyncHandler(async (req, res) => {
    const { status, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: any = {};
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      prisma.customer.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      prisma.customer.count({ where }),
    ]);

    res.json({ success: true, data, pagination: { page: pageNum, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  })
);

router.get(
  '/customers/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await prisma.customer.findUnique({ where: { id } });
    if (!data) throw new AppError('客户不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data });
  })
);

// ============================================
// Supplier API
// ============================================

router.get(
  '/suppliers',
  asyncHandler(async (req, res) => {
    const { status, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: any = {};
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      prisma.supplier.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      prisma.supplier.count({ where }),
    ]);

    res.json({ success: true, data, pagination: { page: pageNum, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  })
);

router.get(
  '/suppliers/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await prisma.supplier.findUnique({ where: { id } });
    if (!data) throw new AppError('供应商不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data });
  })
);

// ============================================
// Certificate API
// ============================================

router.get(
  '/certificates',
  asyncHandler(async (req, res) => {
    const { status, partNumber, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: any = {};
    if (status) where.status = status;
    if (partNumber) where.partNumber = { contains: partNumber };

    const [data, total] = await Promise.all([
      prisma.certificate.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      prisma.certificate.count({ where }),
    ]);

    res.json({ success: true, data, pagination: { page: pageNum, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  })
);

router.get(
  '/certificates/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await prisma.certificate.findUnique({ where: { id } });
    if (!data) throw new AppError('证书不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data });
  })
);

// ============================================
// Auction API
// ============================================

router.get(
  '/auctions',
  asyncHandler(async (req, res) => {
    const { status, type, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: any = {};
    if (status) where.status = status;
    if (type) where.type = type;

    const [data, total] = await Promise.all([
      prisma.auction.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      prisma.auction.count({ where }),
    ]);

    res.json({ success: true, data, pagination: { page: pageNum, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  })
);

router.get(
  '/auctions/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await prisma.auction.findUnique({
      where: { id },
      include: { bids: { orderBy: { bidTime: 'desc' } } },
    });
    if (!data) throw new AppError('拍卖不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data });
  })
);

// ============================================
// Pricing / Analytics API
// ============================================

router.get(
  '/pricing/recommendation',
  asyncHandler(async (req, res) => {
    const { partNumber, quantity, customerId } = req.query;

    if (!partNumber || !quantity) {
      throw new AppError('partNumber 和 quantity 为必填参数', 400, 'BAD_REQUEST');
    }

    // 返回历史价格统计
    const quotations = await prisma.quotation.findMany({
      where: {
        partNumber: partNumber as string,
        status: { in: ['APPROVED', 'ACCEPTED'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        unitPrice: true,
        totalPrice: true,
        quantity: true,
        createdAt: true,
      },
    });

    const orders = await prisma.order.findMany({
      where: {
        partNumber: partNumber as string,
        status: { not: 'CANCELLED' },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        totalAmount: true,
        quantity: true,
        createdAt: true,
      },
    });

    const prices: number[] = [];
    for (const q of quotations) {
      if (q.unitPrice && q.unitPrice > 0) prices.push(q.unitPrice);
    }
    for (const o of orders) {
      if (o.totalAmount && o.quantity && o.quantity > 0) {
        prices.push(o.totalAmount / o.quantity);
      }
    }

    const sorted = [...prices].sort((a, b) => a - b);
    const avg = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    const min = sorted[0] || 0;
    const max = sorted[sorted.length - 1] || 0;
    const median = sorted.length > 0
      ? sorted.length % 2 === 0
        ? (sorted[Math.floor(sorted.length / 2) - 1] + sorted[Math.floor(sorted.length / 2)]) / 2
        : sorted[Math.floor(sorted.length / 2)]
      : 0;

    res.json({
      success: true,
      data: {
        partNumber,
        quantity: parseInt(quantity as string, 10),
        customerId: customerId || null,
        historicalStats: {
          avgPrice: Math.round(avg * 100) / 100,
          minPrice: Math.round(min * 100) / 100,
          maxPrice: Math.round(max * 100) / 100,
          medianPrice: Math.round(median * 100) / 100,
          transactionCount: prices.length,
        },
        recommendedPrice: Math.round(avg * 100) / 100,
        priceRange: {
          low: Math.round(min * 100) / 100,
          high: Math.round(max * 100) / 100,
        },
      },
    });
  })
);

// ============================================
// Health Check
// ============================================

router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        version: 'v1',
        timestamp: new Date().toISOString(),
      },
    });
  })
);

export default router;
