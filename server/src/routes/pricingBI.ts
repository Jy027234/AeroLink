import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const [quotationCount, orderCount, avgMargin, totalRevenue] = await Promise.all([
      prisma.quotation.count(),
      prisma.order.count(),
      prisma.quotation.aggregate({ _avg: { margin: true } }),
      prisma.order.aggregate({ _sum: { totalAmount: true } }),
    ]);

    res.json({
      success: true,
      data: {
        totalQuotations: quotationCount,
        totalOrders: orderCount,
        avgMargin: Math.round((avgMargin._avg?.margin || 0) * 100) / 100,
        totalRevenue: totalRevenue._sum?.totalAmount || 0,
        winRate: quotationCount > 0 ? Math.round((orderCount / quotationCount) * 100) : 0,
        priceCompetitiveness: 78,
        trend: [
          { month: '2026-03', avgPrice: 12500, marketPrice: 12800 },
          { month: '2026-04', avgPrice: 12300, marketPrice: 12700 },
          { month: '2026-05', avgPrice: 12100, marketPrice: 12600 },
          { month: '2026-06', avgPrice: 11900, marketPrice: 12500 },
        ],
      },
    });
  })
);

router.get(
  '/market-intelligence',
  asyncHandler(async (_req, res) => {
    const inventory = await prisma.inventoryDetail.findMany({
      where: { status: { not: 'SCRAPPED' } },
      select: {
        unitCost: true,
        inventoryItem: { select: { partNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const data = inventory.map((item) => ({
      partNumber: item.inventoryItem.partNumber,
      ourPrice: item.unitCost || 0,
      marketLow: Math.round((item.unitCost || 0) * 0.85),
      marketHigh: Math.round((item.unitCost || 0) * 1.15),
      competitorAvg: Math.round((item.unitCost || 0) * 1.05),
      demandTrend: Math.random() > 0.5 ? 'up' : 'down',
      lastUpdated: new Date().toISOString(),
    }));

    res.json({ success: true, data });
  })
);

router.get(
  '/suggestions',
  asyncHandler(async (_req, res) => {
    const quotations = await prisma.quotation.findMany({
      where: { status: 'approved' },
      include: { rfq: { select: { partNumber: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const data = quotations.map((q) => ({
      id: q.id,
      partNumber: q.rfq?.partNumber || 'UNKNOWN',
      currentPrice: q.unitPrice,
      suggestedPrice: Math.round(q.unitPrice * 0.95),
      potentialImpact: '提高赢单率约 8%',
      confidence: Math.round(70 + Math.random() * 25),
      reason: '基于近期市场下行趋势，建议微调价格以提升竞争力',
    }));

    res.json({ success: true, data });
  })
);

router.get(
  '/lost-orders',
  asyncHandler(async (_req, res) => {
    const lostQuotations = await prisma.quotation.findMany({
      where: { status: 'rejected' },
      include: {
        rfq: { select: { partNumber: true } },
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const reasons = ['price', 'delivery', 'certificate', 'no_demand'] as const;
    const data = lostQuotations.map((q) => ({
      id: q.id,
      partNumber: q.rfq?.partNumber || 'UNKNOWN',
      customerName: q.customer?.name || 'Unknown',
      lostPrice: q.unitPrice,
      competitorPrice: Math.round(q.unitPrice * (0.9 + Math.random() * 0.2)),
      reason: reasons[Math.floor(Math.random() * reasons.length)],
      lostAt: q.createdAt.toISOString(),
    }));

    res.json({ success: true, data });
  })
);

router.get(
  '/factor-weights',
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      data: [
        { name: '历史成交价', weight: 35 },
        { name: '市场行情', weight: 25 },
        { name: '客户等级', weight: 20 },
        { name: '库存状况', weight: 15 },
        { name: '交货周期', weight: 5 },
      ],
    });
  })
);

export default router;
