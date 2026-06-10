import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import {
  getConsumptionTrend,
  calculateSafetyStockRecommendations,
  getInventoryHealthSummary,
  getSeasonalForecast,
} from '../lib/inventoryAnalytics.js';

const router = Router();

/**
 * GET /api/inventory-analytics/consumption-trend?partNumber=xxx&months=12
 * 获取消耗趋势
 */
router.get(
  '/consumption-trend',
  asyncHandler(async (req: AuthRequest, res) => {
    const { partNumber, months } = req.query;
    const monthsNum = parseInt(months as string, 10) || 12;

    const trends = await getConsumptionTrend(
      partNumber as string | undefined,
      monthsNum
    );

    res.json({
      success: true,
      data: trends,
    });
  })
);

/**
 * GET /api/inventory-analytics/safety-stock?partNumber=xxx&leadTimeDays=30
 * 获取安全库存建议
 */
router.get(
  '/safety-stock',
  asyncHandler(async (req: AuthRequest, res) => {
    const { partNumber, leadTimeDays } = req.query;
    const leadTime = parseInt(leadTimeDays as string, 10) || 30;

    const recommendations = await calculateSafetyStockRecommendations(
      partNumber as string | undefined,
      leadTime
    );

    res.json({
      success: true,
      data: recommendations,
    });
  })
);

/**
 * GET /api/inventory-analytics/health-summary
 * 获取库存健康度摘要
 */
router.get(
  '/health-summary',
  asyncHandler(async (_req: AuthRequest, res) => {
    const summary = await getInventoryHealthSummary();

    res.json({
      success: true,
      data: summary,
    });
  })
);

/**
 * GET /api/inventory-analytics/seasonal-forecast/:partNumber
 * 获取季节性预测
 */
router.get(
  '/seasonal-forecast/:partNumber',
  asyncHandler(async (req: AuthRequest, res) => {
    const { partNumber } = req.params;

    if (!partNumber) {
      throw new AppError('件号不能为空', 400, 'BAD_REQUEST');
    }

    const forecast = await getSeasonalForecast(partNumber);

    res.json({
      success: true,
      data: forecast,
    });
  })
);

export default router;
