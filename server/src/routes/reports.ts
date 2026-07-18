import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import prisma from '../lib/prisma.js';

const router = Router();

type DataAvailabilityStatus = 'available' | 'insufficient_data' | 'unavailable';

interface DataAvailability {
  status: DataAvailabilityStatus;
  source: string;
  algorithmVersion: string | null;
  sampleSize: number;
  asOf: string;
  reason?: string;
  decisionBoundary: string;
}

function createAvailability(
  status: DataAvailabilityStatus,
  options: Omit<DataAvailability, 'status' | 'asOf'>
): DataAvailability {
  return {
    status,
    ...options,
    asOf: new Date().toISOString(),
  };
}

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// GET /summary - 报表汇总
router.get(
  '/summary',
  requireCapability('report', 'read'),
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      rfqsThisMonth,
      rfqsLastMonth,
      quotesThisMonth,
      quotesLastMonth,
      ordersThisMonth,
      ordersLastMonth,
      activeCustomers,
      inventoryDetails,
    ] = await Promise.all([
      prisma.rFQ.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.rFQ.count({ where: { createdAt: { gte: lastMonthStart, lt: monthStart } } }),
      prisma.quotation.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.quotation.count({ where: { createdAt: { gte: lastMonthStart, lt: monthStart } } }),
      prisma.order.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.order.count({ where: { createdAt: { gte: lastMonthStart, lt: monthStart } } }),
      prisma.customer.count({ where: { status: 'ACTIVE' } }),
      prisma.inventoryDetail.findMany({
        where: { status: { not: 'SCRAPPED' } },
        select: {
          quantity: true,
          unitCost: true,
          status: true,
        },
      }),
    ]);

    // Calculate order revenue this month
    const ordersWithTotal = await prisma.order.findMany({
      where: { createdAt: { gte: monthStart } },
      select: { totalAmount: true },
    });
    const revenueThisMonth = ordersWithTotal.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);

    const lastOrdersWithTotal = await prisma.order.findMany({
      where: { createdAt: { gte: lastMonthStart, lt: monthStart } },
      select: { totalAmount: true },
    });
    const revenueLastMonth = lastOrdersWithTotal.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);

    const trend = (current: number, previous: number) =>
      previous === 0 ? null : Math.round(((current - previous) / previous) * 100);

    // The detail layer is the valuation source. A reserved unit remains an
    // owned asset; only SCRAPPED details are excluded from asset value.
    const totalInvValue = inventoryDetails.reduce((sum, i) => sum + (Number(i.unitCost) || 0) * i.quantity, 0);

    res.json({
      rfqsThisMonth,
      rfqTrend: trend(rfqsThisMonth, rfqsLastMonth),
      quotesThisMonth,
      quoteTrend: trend(quotesThisMonth, quotesLastMonth),
      ordersThisMonth,
      orderTrend: trend(ordersThisMonth, ordersLastMonth),
      revenueThisMonth,
      revenueTrend: trend(revenueThisMonth, revenueLastMonth),
      activeCustomers,
      customerRetention: null,
      avgCustomerValue: null,
      totalInventoryValue: totalInvValue,
      avgTurnoverDays: null,
      slowMovingValue: null,
      slowMovingShare: null,
      inventoryAlerts: inventoryDetails.filter((detail) => detail.status === 'AVAILABLE' && detail.quantity <= 2).length,
      metadata: createAvailability(
        inventoryDetails.length > 0 || rfqsThisMonth > 0 || quotesThisMonth > 0 || ordersThisMonth > 0
          ? 'available'
          : 'insufficient_data',
        {
          source: 'AeroLink RFQ, quotation, order, customer and inventory-detail records',
          algorithmVersion: 'operational-summary-v1',
          sampleSize: inventoryDetails.length + rfqsThisMonth + quotesThisMonth + ordersThisMonth,
          reason: '客户留存、客户终身价值、库存周转和呆滞库存需要受批准的周期、成本和出入库口径；当前模型未提供这些定义。',
          decisionBoundary: '本页只展示可由当前业务记录直接计算的运营数据；空值不是零，也不可替代财务或库存决策。',
        }
      ),
    });
  })
);

// GET /sales-trend - 销售趋势
router.get(
  '/sales-trend',
  requireCapability('report', 'read'),
  asyncHandler(async (req, res) => {
    const months = Math.min(12, Math.max(1, parseInt(req.query.months as string, 10) || 6));
    const result: Array<{ month: string; rfqs: number; quotes: number; orders: number; revenue: number }> = [];

    for (let i = months - 1; i >= 0; i--) {
      const start = new Date();
      start.setMonth(start.getMonth() - i, 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);

      const [rfqs, quotes, orders] = await Promise.all([
        prisma.rFQ.count({ where: { createdAt: { gte: start, lt: end } } }),
        prisma.quotation.count({ where: { createdAt: { gte: start, lt: end } } }),
        prisma.order.findMany({ where: { createdAt: { gte: start, lt: end } }, select: { totalAmount: true } }),
      ]);

      const revenue = orders.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);
      const label = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
      result.push({ month: label, rfqs, quotes, orders: orders.length, revenue });
    }

    res.json(result);
  })
);

// GET /conversion - 转化分析
router.get(
  '/conversion',
  requireCapability('report', 'read'),
  asyncHandler(async (_req, res) => {
    const [totalRfqs, totalOrders, allOrders, averageMargin, responseSamples] = await Promise.all([
      prisma.rFQ.count(),
      prisma.order.count(),
      prisma.order.findMany({ select: { totalAmount: true } }),
      prisma.quotation.aggregate({ _avg: { margin: true } }),
      prisma.quotation.findMany({
        select: {
          createdAt: true,
          rfq: { select: { createdAt: true } },
        },
      }),
    ]);

    const avgOrderValue = allOrders.length > 0
      ? Math.round(allOrders.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0) / allOrders.length)
      : null;

    const responseTimeDays = responseSamples
      .map((quotation) => {
        const rfqCreatedAt = quotation.rfq?.createdAt;
        if (!rfqCreatedAt) return null;
        const elapsed = quotation.createdAt.getTime() - rfqCreatedAt.getTime();
        return elapsed >= 0 ? elapsed / (24 * 60 * 60 * 1000) : null;
      })
      .filter((value): value is number => value !== null);

    res.json({
      overallRate: totalRfqs > 0 ? Math.round((totalOrders / totalRfqs) * 100) : null,
      avgOrderValue,
      avgMargin: averageMargin._avg.margin === null ? null : round(Number(averageMargin._avg.margin)),
      avgResponseTime: responseTimeDays.length > 0
        ? round(responseTimeDays.reduce((sum, value) => sum + value, 0) / responseTimeDays.length, 1)
        : null,
      lostReasons: [],
      metadata: createAvailability(
        totalRfqs > 0 || totalOrders > 0 ? 'available' : 'insufficient_data',
        {
          source: 'AeroLink RFQ, quotation and order records',
          algorithmVersion: 'conversion-summary-v1',
          sampleSize: Math.max(totalRfqs, responseSamples.length),
          reason: '系统没有结构化丢单原因字段，因此不展示丢单原因占比；平均响应时间仅在报价关联 RFQ 时计算。',
          decisionBoundary: '成交率和订单金额来自内部记录；丢单归因必须以人工确认的结构化原因补充。',
        }
      ),
    });
  })
);

// GET /customer-contribution - 客户主数据中已录入的年收入
router.get(
  '/customer-contribution',
  requireCapability('report', 'read'),
  asyncHandler(async (_req, res) => {
    const customers = await prisma.customer.findMany({
      where: { status: 'ACTIVE' },
      select: { name: true, annualRevenue: true },
      orderBy: { annualRevenue: 'desc' },
      take: 10,
    });

    const result = customers.flatMap((customer) => {
      if (customer.annualRevenue === null) return [];
      return [{
        name: customer.name,
        value: Number(customer.annualRevenue),
      }];
    });

    res.json(result);
  })
);

// GET /inventory-turnover - 库存周转分析
router.get(
  '/inventory-turnover',
  requireCapability('report', 'read'),
  asyncHandler(async (_req, res) => {
    const categories = ['ROTABLE', 'REPAIRABLE', 'CHEMICAL', 'STANDARD_PART', 'RAW_MATERIAL', 'CONSUMABLE'];
    const categoryNames: Record<string, string> = {
      ROTABLE: '周转件',
      REPAIRABLE: '可修件',
      CHEMICAL: '化工品',
      STANDARD_PART: '标准件',
      RAW_MATERIAL: '原材料',
      CONSUMABLE: '消耗件',
    };

    const items = await prisma.inventoryItem.findMany({
      select: {
        partCategory: true,
        details: {
          where: { status: { not: 'SCRAPPED' } },
          select: { id: true },
        },
      },
    });
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.partCategory, (counts.get(item.partCategory) ?? 0) + item.details.length);
    }

    const result = categories.map((category) => {
      const count = counts.get(category) ?? 0;
      return {
        category: categoryNames[category] || category,
        days: null,
        target: null,
        sampleSize: count,
      };
    });

    // Inventory quantity is known, but a turnover period needs approved cost
    // and outbound-consumption definitions. Do not turn stock counts into a
    // made-up number of days.
    result.unshift({
      category: '全部',
      days: null,
      target: null,
      sampleSize: result.reduce((sum, item) => sum + item.sampleSize, 0),
    });

    const totalSamples = result[0].sampleSize;
    res.json({
      items: result,
      metadata: createAvailability(
        totalSamples > 0 ? 'insufficient_data' : 'unavailable',
        {
          source: 'AeroLink inventory-detail records',
          algorithmVersion: null,
          sampleSize: totalSamples,
          reason: totalSamples > 0
            ? '已有库存数量，但没有经批准的销售成本、平均库存和出入库周期口径，无法计算库存周转天数。'
            : '尚无可用库存明细。',
          decisionBoundary: '库存数量不能被解释为库存周转天数；空值不表示零天周转。',
        }
      ),
    });
  })
);

export default router;
