import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { getProductFeatureStatus } from '../lib/productFeatures.js';
import prisma from '../lib/prisma.js';

const router = Router();

const LOST_QUOTATION_STATUSES = ['REJECTED', 'rejected', 'WITHDRAWN', 'withdrawn'];

type DataAvailabilityStatus = 'available' | 'insufficient_data' | 'unavailable' | 'disabled';

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

function disabledAvailability(): DataAvailability {
  return createAvailability('disabled', {
    source: 'not queried',
    algorithmVersion: null,
    sampleSize: 0,
    reason: '定价 BI 在当前环境未启用。请由服务端设置 FEATURE_PRICING_BI=true 后再使用。',
    decisionBoundary: '功能关闭时不会读取或推导经营数据。',
  });
}

function unavailableAvailability(reason: string, sampleSize = 0): DataAvailability {
  return createAvailability('unavailable', {
    source: 'not configured',
    algorithmVersion: null,
    sampleSize,
    reason,
    decisionBoundary: '当前没有可追溯的数据源或经批准的算法，不得据此作出财务、价格或采购决策。',
  });
}

function getMonthRange(offset: number) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
  return { start, end };
}

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function percentagePointDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return round(current - previous);
}

router.use(requireCapability('report', 'read'));

router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const feature = getProductFeatureStatus('pricingBi');
    if (!feature.enabled) {
      res.json({
        success: true,
        data: {
          feature,
          avgMargin: null,
          marginTrend: null,
          priceCompetitiveness: null,
          competitivenessTrend: null,
          pendingSuggestions: null,
          potentialUpside: null,
          totalQuotes: null,
          wonDeals: null,
          lostDeals: null,
          winRate: null,
          metadata: disabledAvailability(),
        },
      });
      return;
    }

    const currentMonth = getMonthRange(0);
    const previousMonth = getMonthRange(-1);
    const [
      totalQuotes,
      wonDeals,
      lostDeals,
      allMargins,
      currentMargins,
      previousMargins,
    ] = await Promise.all([
      prisma.quotation.count(),
      prisma.order.count(),
      prisma.quotation.count({ where: { status: { in: LOST_QUOTATION_STATUSES } } }),
      prisma.quotation.aggregate({ _avg: { margin: true } }),
      prisma.quotation.aggregate({
        where: { createdAt: { gte: currentMonth.start, lt: currentMonth.end } },
        _avg: { margin: true },
      }),
      prisma.quotation.aggregate({
        where: { createdAt: { gte: previousMonth.start, lt: previousMonth.end } },
        _avg: { margin: true },
      }),
    ]);

    const avgMargin = totalQuotes > 0 && allMargins._avg.margin !== null
      ? round(Number(allMargins._avg.margin))
      : null;
    const currentMargin = currentMargins._avg.margin === null ? null : Number(currentMargins._avg.margin);
    const previousMargin = previousMargins._avg.margin === null ? null : Number(previousMargins._avg.margin);

    res.json({
      success: true,
      data: {
        feature,
        avgMargin,
        marginTrend: percentagePointDelta(currentMargin, previousMargin),
        priceCompetitiveness: null,
        competitivenessTrend: null,
        pendingSuggestions: null,
        potentialUpside: null,
        totalQuotes,
        wonDeals,
        lostDeals,
        winRate: totalQuotes > 0 ? round((wonDeals / totalQuotes) * 100) : null,
        metadata: createAvailability(totalQuotes > 0 ? 'available' : 'insufficient_data', {
          source: 'AeroLink quotation and order records',
          algorithmVersion: 'internal-transaction-summary-v1',
          sampleSize: totalQuotes,
          reason: totalQuotes > 0
            ? undefined
            : '尚无报价记录，无法形成内部成交或毛利统计。',
          decisionBoundary: '仅基于内部交易记录；不含外部市场、竞品价格或预测模型，不能作为最终财务或定价依据。',
        }),
      },
    });
  })
);

router.get(
  '/market-intelligence',
  asyncHandler(async (_req, res) => {
    const feature = getProductFeatureStatus('pricingBi');
    res.json({
      success: true,
      data: {
        feature,
        items: [],
        metadata: feature.enabled
          ? unavailableAvailability('未接入可审计的外部市场、竞品价格或需求数据源，因此不展示市场价格、需求趋势或竞争力。')
          : disabledAvailability(),
      },
    });
  })
);

router.get(
  '/suggestions',
  asyncHandler(async (_req, res) => {
    const feature = getProductFeatureStatus('pricingBi');
    res.json({
      success: true,
      data: {
        feature,
        items: [],
        metadata: feature.enabled
          ? unavailableAvailability('尚未配置经批准的定价规则或模型版本，因此不生成价格建议或潜在增益。')
          : disabledAvailability(),
      },
    });
  })
);

router.get(
  '/lost-orders',
  asyncHandler(async (_req, res) => {
    const feature = getProductFeatureStatus('pricingBi');
    if (!feature.enabled) {
      res.json({
        success: true,
        data: { feature, items: [], unclassifiedCount: 0, metadata: disabledAvailability() },
      });
      return;
    }

    const unclassifiedCount = await prisma.quotation.count({
      where: { status: { in: LOST_QUOTATION_STATUSES } },
    });
    res.json({
      success: true,
      data: {
        feature,
        items: [],
        unclassifiedCount,
        metadata: createAvailability(
          unclassifiedCount > 0 ? 'insufficient_data' : 'unavailable',
          {
            source: 'AeroLink quotation status records',
            algorithmVersion: null,
            sampleSize: unclassifiedCount,
            reason: unclassifiedCount > 0
              ? '系统没有结构化记录丢单原因、竞品报价或客户反馈，不能对这些丢单进行归因。'
              : '尚无标记为丢失/撤回的报价记录。',
            decisionBoundary: '不以推测原因或估算竞品价格替代真实丢单归因。',
          }
        ),
      },
    });
  })
);

router.get(
  '/factor-weights',
  asyncHandler(async (_req, res) => {
    const feature = getProductFeatureStatus('pricingBi');
    res.json({
      success: true,
      data: {
        feature,
        items: [],
        metadata: feature.enabled
          ? unavailableAvailability('尚未配置、审批或版本化定价模型，不能展示看似精确的因素权重。')
          : disabledAvailability(),
      },
    });
  })
);

export default router;
