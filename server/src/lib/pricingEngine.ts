import prisma from './prisma.js';
import { AppError } from '../middleware/errorHandler.js';

export interface PriceRecommendation {
  partNumber: string;
  quantity: number;
  customerId?: string;

  // 历史价格统计
  historicalStats: {
    avgPrice: number;
    minPrice: number;
    maxPrice: number;
    medianPrice: number;
    transactionCount: number;
    lastTransactionDate: string | null;
    priceTrend: 'up' | 'down' | 'stable';
    trendPercent: number;
  };

  // 推荐价格
  recommendedPrice: number;
  priceRange: {
    low: number;
    high: number;
  };

  // 折扣分析
  discountAnalysis: {
    customerTierDiscount: number; // 客户等级折扣 %
    volumeDiscount: number; // 批量折扣 %
    paymentTermDiscount: number; // 账期折扣 %
    totalDiscount: number; // 总折扣 %
  };

  // 胜率预测
  winProbability: number; // 0-100
  winProbabilityFactors: {
    priceFactor: number; // 价格竞争力贡献
    customerFactor: number; // 客户关系贡献
    marketFactor: number; // 市场趋势贡献
  };

  // 竞品参考（预留，后续对接外部数据）
  marketReference?: {
    source: string;
    avgPrice: number;
    currency: string;
  };

  generatedAt: string;
}

/**
 * 获取历史价格统计
 */
async function getHistoricalPriceStats(partNumber: string): Promise<PriceRecommendation['historicalStats']> {
  // 查询该件号的所有已接受报价和订单
  const quotations = await prisma.quotation.findMany({
    where: {
      partNumber,
      status: { in: ['APPROVED', 'ACCEPTED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      unitPrice: true,
      totalPrice: true,
      quantity: true,
      createdAt: true,
      status: true,
    },
  });

  const orders = await prisma.order.findMany({
    where: {
      partNumber,
      status: { not: 'CANCELLED' },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      totalAmount: true,
      quantity: true,
      createdAt: true,
    },
  });

  // 合并所有交易记录（统一为单价）
  const prices: number[] = [];
  const dates: Date[] = [];

  for (const q of quotations) {
    if (q.unitPrice && q.unitPrice > 0) {
      prices.push(q.unitPrice);
      dates.push(q.createdAt);
    }
  }

  for (const o of orders) {
    if (o.totalAmount && o.quantity && o.quantity > 0) {
      const unitPrice = o.totalAmount / o.quantity;
      if (unitPrice > 0) {
        prices.push(unitPrice);
        dates.push(o.createdAt);
      }
    }
  }

  if (prices.length === 0) {
    return {
      avgPrice: 0,
      minPrice: 0,
      maxPrice: 0,
      medianPrice: 0,
      transactionCount: 0,
      lastTransactionDate: null,
      priceTrend: 'stable',
      trendPercent: 0,
    };
  }

  // 排序计算中位数
  const sortedPrices = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sortedPrices.length / 2);
  const medianPrice = sortedPrices.length % 2 === 0
    ? (sortedPrices[mid - 1] + sortedPrices[mid]) / 2
    : sortedPrices[mid];

  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const minPrice = sortedPrices[0];
  const maxPrice = sortedPrices[sortedPrices.length - 1];

  // 计算价格趋势（最近3笔 vs 之前3笔）
  let priceTrend: 'up' | 'down' | 'stable' = 'stable';
  let trendPercent = 0;

  if (prices.length >= 6) {
    const recent = prices.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const previous = prices.slice(3, 6).reduce((a, b) => a + b, 0) / 3;
    if (previous > 0) {
      trendPercent = ((recent - previous) / previous) * 100;
      if (trendPercent > 5) priceTrend = 'up';
      else if (trendPercent < -5) priceTrend = 'down';
    }
  }

  // 按日期排序找最后交易日期
  const sortedDates = [...dates].sort((a, b) => b.getTime() - a.getTime());

  return {
    avgPrice: Math.round(avgPrice * 100) / 100,
    minPrice: Math.round(minPrice * 100) / 100,
    maxPrice: Math.round(maxPrice * 100) / 100,
    medianPrice: Math.round(medianPrice * 100) / 100,
    transactionCount: prices.length,
    lastTransactionDate: sortedDates[0]?.toISOString() || null,
    priceTrend,
    trendPercent: Math.round(trendPercent * 100) / 100,
  };
}

/**
 * 获取客户等级折扣
 */
async function getCustomerTierDiscount(customerId?: string): Promise<number> {
  if (!customerId) return 0;

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { creditRating: true, annualRevenue: true },
  });

  if (!customer) return 0;

  // 基于信用等级和年收入的折扣规则
  const tierDiscounts: Record<string, number> = {
    'AAA': 15,
    'AA': 10,
    'A': 5,
    'B': 2,
    'C': 0,
  };

  let discount = tierDiscounts[customer.creditRating || 'C'] || 0;

  // 大客户额外折扣
  if (customer.annualRevenue && customer.annualRevenue > 10000000) {
    discount += 3;
  } else if (customer.annualRevenue && customer.annualRevenue > 1000000) {
    discount += 1;
  }

  return Math.min(discount, 20); // 最高20%
}

/**
 * 获取批量折扣
 */
function getVolumeDiscount(quantity: number): number {
  if (quantity >= 1000) return 12;
  if (quantity >= 500) return 8;
  if (quantity >= 100) return 5;
  if (quantity >= 50) return 3;
  if (quantity >= 10) return 1;
  return 0;
}

/**
 * 获取账期折扣（预留，基于付款条件）
 */
async function getPaymentTermDiscount(customerId?: string): Promise<number> {
  if (!customerId) return 0;

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { paymentTerms: true },
  });

  if (!customer?.paymentTerms) return 0;

  // 预付款有额外折扣
  const terms = customer.paymentTerms.toLowerCase();
  if (terms.includes('prepay') || terms.includes('advance') || terms.includes('预付')) {
    return 3;
  }
  if (terms.includes('net 15') || terms.includes('15天')) {
    return 1;
  }

  return 0;
}

/**
 * 计算胜率预测
 */
function calculateWinProbability(
  proposedPrice: number,
  historicalStats: PriceRecommendation['historicalStats'],
  totalDiscount: number
): { winProbability: number; factors: PriceRecommendation['winProbabilityFactors'] } {
  if (historicalStats.transactionCount === 0) {
    return {
      winProbability: 50,
      factors: { priceFactor: 0, customerFactor: 30, marketFactor: 20 },
    };
  }

  // 价格竞争力：与历史均价的比较
  const priceRatio = proposedPrice / historicalStats.avgPrice;
  let priceFactor = 0;

  if (priceRatio <= 0.85) priceFactor = 40;
  else if (priceRatio <= 0.95) priceFactor = 35;
  else if (priceRatio <= 1.0) priceFactor = 30;
  else if (priceRatio <= 1.05) priceFactor = 25;
  else if (priceRatio <= 1.15) priceFactor = 15;
  else priceFactor = 5;

  // 折扣加成
  const discountBonus = Math.min(totalDiscount * 0.5, 10);

  // 市场趋势加成
  let marketFactor = 20;
  if (historicalStats.priceTrend === 'down') {
    marketFactor = 25; // 市场下行，价格敏感
  } else if (historicalStats.priceTrend === 'up') {
    marketFactor = 15; // 市场上行，价格容忍度高
  }

  // 客户关系（基础分）
  const customerFactor = 30;

  const winProbability = Math.min(95, Math.max(10,
    priceFactor + discountBonus + marketFactor + customerFactor
  ));

  return {
    winProbability: Math.round(winProbability),
    factors: {
      priceFactor: Math.round(priceFactor + discountBonus),
      customerFactor,
      marketFactor,
    },
  };
}

/**
 * 生成价格推荐
 */
export async function generatePriceRecommendation(
  partNumber: string,
  quantity: number,
  customerId?: string,
  proposedPrice?: number
): Promise<PriceRecommendation> {
  if (!partNumber || quantity <= 0) {
    throw new AppError('件号和数量不能为空', 400, 'BAD_REQUEST');
  }

  const historicalStats = await getHistoricalPriceStats(partNumber);

  // 计算折扣
  const customerTierDiscount = await getCustomerTierDiscount(customerId);
  const volumeDiscount = getVolumeDiscount(quantity);
  const paymentTermDiscount = await getPaymentTermDiscount(customerId);
  const totalDiscount = customerTierDiscount + volumeDiscount + paymentTermDiscount;

  // 计算推荐价格
  let recommendedPrice = historicalStats.avgPrice;
  if (recommendedPrice > 0) {
    // 基于历史均价，应用折扣
    recommendedPrice = recommendedPrice * (1 - totalDiscount / 100);
    // 确保不低于最低价的 90%（防止恶性竞争）
    const floorPrice = historicalStats.minPrice * 0.9;
    if (recommendedPrice < floorPrice && floorPrice > 0) {
      recommendedPrice = floorPrice;
    }
  }

  // 价格区间
  const priceRange = {
    low: historicalStats.minPrice > 0 ? historicalStats.minPrice * 0.95 : recommendedPrice * 0.9,
    high: historicalStats.maxPrice > 0 ? historicalStats.maxPrice * 1.05 : recommendedPrice * 1.1,
  };

  // 胜率预测
  const priceForWinCalc = proposedPrice || recommendedPrice;
  const { winProbability, factors } = calculateWinProbability(
    priceForWinCalc,
    historicalStats,
    totalDiscount
  );

  return {
    partNumber,
    quantity,
    customerId,
    historicalStats,
    recommendedPrice: Math.round(recommendedPrice * 100) / 100,
    priceRange: {
      low: Math.round(priceRange.low * 100) / 100,
      high: Math.round(priceRange.high * 100) / 100,
    },
    discountAnalysis: {
      customerTierDiscount,
      volumeDiscount,
      paymentTermDiscount,
      totalDiscount,
    },
    winProbability,
    winProbabilityFactors: factors,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 批量价格推荐（用于RFQ批量报价）
 */
export async function generateBatchPriceRecommendations(
  items: Array<{ partNumber: string; quantity: number; customerId?: string }>
): Promise<PriceRecommendation[]> {
  const results: PriceRecommendation[] = [];
  for (const item of items) {
    try {
      const rec = await generatePriceRecommendation(item.partNumber, item.quantity, item.customerId);
      results.push(rec);
    } catch {
      // 单个失败不影响其他
      results.push({
        partNumber: item.partNumber,
        quantity: item.quantity,
        customerId: item.customerId,
        historicalStats: {
          avgPrice: 0, minPrice: 0, maxPrice: 0, medianPrice: 0,
          transactionCount: 0, lastTransactionDate: null,
          priceTrend: 'stable', trendPercent: 0,
        },
        recommendedPrice: 0,
        priceRange: { low: 0, high: 0 },
        discountAnalysis: {
          customerTierDiscount: 0, volumeDiscount: 0,
          paymentTermDiscount: 0, totalDiscount: 0,
        },
        winProbability: 50,
        winProbabilityFactors: { priceFactor: 0, customerFactor: 30, marketFactor: 20 },
        generatedAt: new Date().toISOString(),
      });
    }
  }
  return results;
}

/**
 * 获取件号价格历史趋势（用于图表）
 */
export async function getPriceHistoryTrend(partNumber: string) {
  const quotations = await prisma.quotation.findMany({
    where: {
      partNumber,
      status: { in: ['APPROVED', 'ACCEPTED'] },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      unitPrice: true,
      quantity: true,
      createdAt: true,
    },
  });

  const orders = await prisma.order.findMany({
    where: {
      partNumber,
      status: { not: 'CANCELLED' },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      totalAmount: true,
      quantity: true,
      createdAt: true,
    },
  });

  const dataPoints = [
    ...quotations
      .filter((q) => q.unitPrice && q.unitPrice > 0)
      .map((q) => ({
        date: q.createdAt.toISOString().split('T')[0],
        price: q.unitPrice,
        quantity: q.quantity,
        type: 'quotation' as const,
      })),
    ...orders
      .filter((o) => o.totalAmount && o.quantity && o.quantity > 0)
      .map((o) => ({
        date: o.createdAt.toISOString().split('T')[0],
        price: o.totalAmount / o.quantity,
        quantity: o.quantity,
        type: 'order' as const,
      })),
  ];

  // 按日期排序
  dataPoints.sort((a, b) => a.date.localeCompare(b.date));

  return {
    partNumber,
    dataPoints,
    summary: {
      totalTransactions: dataPoints.length,
      firstTransactionDate: dataPoints[0]?.date || null,
      lastTransactionDate: dataPoints[dataPoints.length - 1]?.date || null,
    },
  };
}
