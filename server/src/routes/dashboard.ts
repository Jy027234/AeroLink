import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import prisma from '../lib/prisma.js';
import { cache, CACHE_TTL, CACHE_KEY } from '../lib/cache.js';

const router = Router();

router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const data = await cache.getOrSet(
      CACHE_KEY.DASHBOARD_STATS,
      async () => {
        const [pendingRFQs, pendingQuotes, pendingApprovals, weeklyOrders] = await Promise.all([
          prisma.rFQ.count({ where: { status: 'PENDING' } }),
          prisma.quotation.count({ where: { status: { in: ['DRAFT', 'PENDING_APPROVAL'] } } }),
          prisma.quotation.count({ where: { status: 'PENDING_APPROVAL' } }),
          prisma.order.findMany({
            where: {
              createdAt: {
                gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
              },
            },
          }),
        ]);

        const weeklyRevenue = weeklyOrders.reduce((sum, o) => sum + o.totalAmount, 0);

        // 计算环比趋势（与上周对比）
        const lastWeekOrders = await prisma.order.findMany({
          where: {
            createdAt: {
              gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
              lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        });
        const lastWeekRevenue = lastWeekOrders.reduce((sum, o) => sum + o.totalAmount, 0);
        const revenueTrend = lastWeekRevenue > 0
          ? Math.round(((weeklyRevenue - lastWeekRevenue) / lastWeekRevenue) * 100)
          : 0;

        const lastWeekRFQs = await prisma.rFQ.count({
          where: {
            createdAt: {
              gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
              lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        });
        const thisWeekRFQs = await prisma.rFQ.count({
          where: {
            createdAt: {
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        });
        const rfqTrend = lastWeekRFQs > 0
          ? Math.round(((thisWeekRFQs - lastWeekRFQs) / lastWeekRFQs) * 100)
          : 0;

        return {
          pendingRFQs,
          pendingQuotes,
          pendingApprovals,
          weeklyRevenue,
          rfqTrend,
          quoteTrend: 0,
          approvalTrend: 0,
          revenueTrend,
        };
      },
      CACHE_TTL.DASHBOARD_STATS
    );

    res.json({
      success: true,
      data,
    });
  })
);

router.get(
  '/funnel',
  asyncHandler(async (_req, res) => {
    const data = await cache.getOrSet(
      CACHE_KEY.DASHBOARD_FUNNEL,
      async () => {
        const [pendingCount, inquiryCount, approvalCount, quoteCount, orderCount] = await Promise.all([
          prisma.rFQ.count({ where: { status: 'PENDING' } }),
          prisma.rFQ.count({ where: { status: 'SOURCING' } }),
          prisma.quotation.count({ where: { status: 'PENDING_APPROVAL' } }),
          prisma.quotation.count({ where: { status: 'SENT' } }),
          prisma.order.count({ where: { status: 'COMPLETED' } }),
        ]);

        const quotations = await prisma.quotation.findMany({
          where: { status: 'ACCEPTED' },
          select: { totalPrice: true },
        });
        const completedRevenue = quotations.reduce((sum, q) => sum + q.totalPrice, 0);

        // 计算各阶段实际金额
        const [inquiryAmount, approvalAmount, quoteAmount] = await Promise.all([
          prisma.quotation.findMany({ where: { status: 'DRAFT' }, select: { totalPrice: true } }).then(qs => qs.reduce((s, q) => s + q.totalPrice, 0)),
          prisma.quotation.findMany({ where: { status: 'PENDING_APPROVAL' }, select: { totalPrice: true } }).then(qs => qs.reduce((s, q) => s + q.totalPrice, 0)),
          prisma.quotation.findMany({ where: { status: 'SENT' }, select: { totalPrice: true } }).then(qs => qs.reduce((s, q) => s + q.totalPrice, 0)),
        ]);

        return [
          { stage: '待处理需求', count: pendingCount, amount: 0 },
          { stage: '已询价', count: inquiryCount, amount: inquiryAmount },
          { stage: '待审批', count: approvalCount, amount: approvalAmount },
          { stage: '已报价', count: quoteCount, amount: quoteAmount },
          { stage: '已成交', count: orderCount, amount: completedRevenue },
        ];
      },
      CACHE_TTL.DASHBOARD_FUNNEL
    );

    res.json({
      success: true,
      data,
    });
  })
);

router.get(
  '/activities',
  asyncHandler(async (_req, res) => {
    const data = await cache.getOrSet(
      CACHE_KEY.DASHBOARD_ACTIVITIES,
      async () => {
        const [recentRFQs, recentQuotations, recentOrders] = await Promise.all([
          prisma.rFQ.findMany({
            take: 3,
            orderBy: { createdAt: 'desc' },
            include: { customer: true },
          }),
          prisma.quotation.findMany({
            take: 3,
            orderBy: { createdAt: 'desc' },
          }),
          prisma.order.findMany({
            take: 3,
            orderBy: { createdAt: 'desc' },
            include: { customer: true },
          }),
        ]);

        const activities = [
          ...recentRFQs.map((r) => ({
            id: r.id,
            type: 'rfq',
            description: `新RFQ来自${r.customer.name}`,
            timestamp: r.createdAt.toISOString(),
          })),
          ...recentQuotations.map((q) => ({
            id: q.id,
            type: 'quote',
            description: `报价 ${q.quoteNumber} 已创建`,
            timestamp: q.createdAt.toISOString(),
          })),
          ...recentOrders.map((o) => ({
            id: o.id,
            type: 'order',
            description: `订单 ${o.orderNumber} 已${o.status === 'SHIPPED' ? '发货' : '创建'}`,
            timestamp: o.createdAt.toISOString(),
          })),
        ]
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, 10);

        return activities;
      },
      CACHE_TTL.DASHBOARD_ACTIVITIES
    );

    res.json({
      success: true,
      data,
    });
  })
);

export default router;
