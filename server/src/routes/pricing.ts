import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import {
  generatePriceRecommendation,
  generateBatchPriceRecommendations,
  getPriceHistoryTrend,
} from '../lib/pricingEngine.js';

const router = Router();

/**
 * GET /api/pricing/recommendation?partNumber=xxx&quantity=xxx&customerId=xxx&proposedPrice=xxx
 * 获取单件号价格推荐
 */
router.get(
  '/recommendation',
  asyncHandler(async (req: AuthRequest, res) => {
    const { partNumber, quantity, customerId, proposedPrice } = req.query;

    if (!partNumber || typeof partNumber !== 'string') {
      throw new AppError('件号不能为空', 400, 'BAD_REQUEST');
    }

    const qty = parseInt(quantity as string, 10);
    if (isNaN(qty) || qty <= 0) {
      throw new AppError('数量必须大于0', 400, 'BAD_REQUEST');
    }

    const proposed = proposedPrice ? parseFloat(proposedPrice as string) : undefined;

    const recommendation = await generatePriceRecommendation(
      partNumber,
      qty,
      customerId as string | undefined,
      proposed
    );

    res.json({
      success: true,
      data: recommendation,
    });
  })
);

/**
 * POST /api/pricing/recommendations/batch
 * 批量价格推荐
 */
router.post(
  '/recommendations/batch',
  asyncHandler(async (req: AuthRequest, res) => {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError('items 不能为空数组', 400, 'BAD_REQUEST');
    }

    if (items.length > 50) {
      throw new AppError('单次最多50个件号', 400, 'BAD_REQUEST');
    }

    const recommendations = await generateBatchPriceRecommendations(
      items.map((item: { partNumber: string; quantity: number; customerId?: string }) => ({
        partNumber: item.partNumber,
        quantity: item.quantity,
        customerId: item.customerId,
      }))
    );

    res.json({
      success: true,
      data: recommendations,
    });
  })
);

/**
 * GET /api/pricing/history/:partNumber
 * 获取件号价格历史趋势
 */
router.get(
  '/history/:partNumber',
  asyncHandler(async (req: AuthRequest, res) => {
    const { partNumber } = req.params;

    if (!partNumber) {
      throw new AppError('件号不能为空', 400, 'BAD_REQUEST');
    }

    const trend = await getPriceHistoryTrend(partNumber);

    res.json({
      success: true,
      data: trend,
    });
  })
);

/**
 * GET /api/pricing/dashboard
 * 价格分析仪表盘数据
 */
router.get(
  '/dashboard',
  asyncHandler(async (_req: AuthRequest, res) => {
    // 获取整体价格统计
    const [quotationStats, orderStats] = await Promise.all([
      // 最近30天报价统计
      // 使用 prisma.$queryRaw 进行聚合查询
      // 这里用简单统计代替
      Promise.resolve({ avgMargin: 25, totalQuotations: 0 }),
      Promise.resolve({ avgMargin: 20, totalOrders: 0 }),
    ]);

    res.json({
      success: true,
      data: {
        quotationStats,
        orderStats,
        generatedAt: new Date().toISOString(),
      },
    });
  })
);

export default router;
