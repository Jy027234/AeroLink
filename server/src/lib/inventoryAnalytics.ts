import prisma from './prisma.js';

export interface ConsumptionTrend {
  period: string; // YYYY-MM
  totalQuantity: number;
  totalValue: number;
  transactionCount: number;
  topPartNumbers: Array<{ partNumber: string; quantity: number; value: number }>;
}

export interface SafetyStockRecommendation {
  partNumber: string;
  currentStock: number;
  avgMonthlyConsumption: number;
  maxMonthlyConsumption: number;
  leadTimeDays: number;
  safetyStockLevel: number; // 安全库存量
  reorderPoint: number; // 再订货点
  reorderQuantity: number; // 建议订货量
  stockStatus: 'adequate' | 'low' | 'critical' | 'excess';
  daysOfSupply: number; // 当前库存可供应天数
  confidence: number; // 置信度 0-100
}

export interface InventoryHealthSummary {
  totalItems: number;
  criticalItems: number;
  lowItems: number;
  excessItems: number;
  adequateItems: number;
  totalInventoryValue: number;
  recommendations: SafetyStockRecommendation[];
}

/**
 * 获取件号消耗趋势（按月聚合）
 */
export async function getConsumptionTrend(
  partNumber?: string,
  months: number = 12
): Promise<ConsumptionTrend[]> {
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  // 从订单中获取消耗数据
  const orders = await prisma.order.findMany({
    where: {
      status: { not: 'CANCELLED' },
      createdAt: { gte: cutoffDate },
      ...(partNumber ? { partNumber } : {}),
    },
    select: {
      partNumber: true,
      quantity: true,
      totalAmount: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // 按月聚合
  const monthlyData: Record<string, {
    totalQuantity: number;
    totalValue: number;
    transactionCount: number;
    partNumbers: Record<string, { quantity: number; value: number }>;
  }> = {};

  for (const order of orders) {
    const period = order.createdAt.toISOString().slice(0, 7); // YYYY-MM
    if (!monthlyData[period]) {
      monthlyData[period] = {
        totalQuantity: 0,
        totalValue: 0,
        transactionCount: 0,
        partNumbers: {},
      };
    }

    monthlyData[period].totalQuantity += order.quantity;
    monthlyData[period].totalValue += order.totalAmount || 0;
    monthlyData[period].transactionCount += 1;

    const pn = order.partNumber;
    if (!monthlyData[period].partNumbers[pn]) {
      monthlyData[period].partNumbers[pn] = { quantity: 0, value: 0 };
    }
    monthlyData[period].partNumbers[pn].quantity += order.quantity;
    monthlyData[period].partNumbers[pn].value += order.totalAmount || 0;
  }

  // 转换为数组并排序
  const trends: ConsumptionTrend[] = Object.entries(monthlyData)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, data]) => ({
      period,
      totalQuantity: data.totalQuantity,
      totalValue: Math.round(data.totalValue * 100) / 100,
      transactionCount: data.transactionCount,
      topPartNumbers: Object.entries(data.partNumbers)
        .map(([partNumber, stats]) => ({
          partNumber,
          quantity: stats.quantity,
          value: Math.round(stats.value * 100) / 100,
        }))
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 5),
    }));

  return trends;
}

/**
 * 计算安全库存建议
 */
export async function calculateSafetyStockRecommendations(
  partNumber?: string,
  leadTimeDays: number = 30
): Promise<SafetyStockRecommendation[]> {
  // 获取当前库存
  const inventoryItems = await prisma.inventory.findMany({
    where: partNumber ? { partNumber } : {},
    select: {
      id: true,
      partNumber: true,
      quantity: true,
      unitCost: true,
      conditionCode: true,
    },
  });

  const recommendations: SafetyStockRecommendation[] = [];

  for (const item of inventoryItems) {
    // 获取该件号过去12个月的订单数据
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 12);

    const orders = await prisma.order.findMany({
      where: {
        partNumber: item.partNumber,
        status: { not: 'CANCELLED' },
        createdAt: { gte: cutoffDate },
      },
      select: {
        quantity: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // 按月聚合消耗量
    const monthlyConsumption: Record<string, number> = {};
    for (const order of orders) {
      const month = order.createdAt.toISOString().slice(0, 7);
      monthlyConsumption[month] = (monthlyConsumption[month] || 0) + order.quantity;
    }

    const monthlyValues = Object.values(monthlyConsumption);

    // 计算统计值
    const avgMonthlyConsumption = monthlyValues.length > 0
      ? monthlyValues.reduce((a, b) => a + b, 0) / monthlyValues.length
      : 0;

    const maxMonthlyConsumption = monthlyValues.length > 0
      ? Math.max(...monthlyValues)
      : 0;

    // 计算标准差（用于安全库存）
    let stdDeviation = 0;
    if (monthlyValues.length > 1) {
      const variance = monthlyValues.reduce((sum, val) => sum + Math.pow(val - avgMonthlyConsumption, 2), 0) / monthlyValues.length;
      stdDeviation = Math.sqrt(variance);
    }

    // 安全库存 = 最大月消耗 * (交货周期/30) * 安全系数(1.5)
    // 或使用标准差法：安全库存 = Z * σ * √(LT)
    const zScore = 1.65; // 95% 服务水平
    const leadTimeMonths = leadTimeDays / 30;

    const safetyStockLevel = Math.ceil(
      Math.max(
        avgMonthlyConsumption * leadTimeMonths * 0.5, // 基础安全库存
        zScore * stdDeviation * Math.sqrt(leadTimeMonths) // 统计安全库存
      )
    );

    // 再订货点 = 交货周期内消耗 + 安全库存
    const reorderPoint = Math.ceil(avgMonthlyConsumption * leadTimeMonths + safetyStockLevel);

    // 建议订货量 = 经济订货量（简化版：2个月消耗量）
    const reorderQuantity = Math.ceil(avgMonthlyConsumption * 2);

    // 当前库存可供应天数
    const dailyConsumption = avgMonthlyConsumption / 30;
    const daysOfSupply = dailyConsumption > 0 ? Math.floor(item.quantity / dailyConsumption) : 999;

    // 库存状态
    let stockStatus: SafetyStockRecommendation['stockStatus'] = 'adequate';
    if (item.quantity <= safetyStockLevel * 0.5) {
      stockStatus = 'critical';
    } else if (item.quantity <= safetyStockLevel) {
      stockStatus = 'low';
    } else if (item.quantity > safetyStockLevel * 4) {
      stockStatus = 'excess';
    }

    // 置信度（基于历史数据量）
    const confidence = Math.min(95, monthlyValues.length * 8);

    recommendations.push({
      partNumber: item.partNumber,
      currentStock: item.quantity,
      avgMonthlyConsumption: Math.round(avgMonthlyConsumption * 100) / 100,
      maxMonthlyConsumption,
      leadTimeDays,
      safetyStockLevel,
      reorderPoint,
      reorderQuantity,
      stockStatus,
      daysOfSupply,
      confidence,
    });
  }

  return recommendations;
}

/**
 * 获取库存健康度摘要
 */
export async function getInventoryHealthSummary(): Promise<InventoryHealthSummary> {
  const recommendations = await calculateSafetyStockRecommendations();

  const criticalItems = recommendations.filter((r) => r.stockStatus === 'critical').length;
  const lowItems = recommendations.filter((r) => r.stockStatus === 'low').length;
  const excessItems = recommendations.filter((r) => r.stockStatus === 'excess').length;
  const adequateItems = recommendations.filter((r) => r.stockStatus === 'adequate').length;

  // 计算总库存价值
  const inventory = await prisma.inventory.findMany({
    select: { quantity: true, unitCost: true },
  });
  const totalInventoryValue = inventory.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);

  return {
    totalItems: recommendations.length,
    criticalItems,
    lowItems,
    excessItems,
    adequateItems,
    totalInventoryValue: Math.round(totalInventoryValue * 100) / 100,
    recommendations: recommendations
      .filter((r) => r.stockStatus === 'critical' || r.stockStatus === 'low')
      .sort((a, b) => a.daysOfSupply - b.daysOfSupply)
      .slice(0, 20),
  };
}

/**
 * 获取季节性预测（简化版：基于过去3年同期数据）
 */
export async function getSeasonalForecast(partNumber: string): Promise<{
  partNumber: string;
  seasonalFactors: Array<{ month: number; factor: number; trend: 'high' | 'normal' | 'low' }>;
  nextQuarterForecast: number;
}> {
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 36); // 3年

  const orders = await prisma.order.findMany({
    where: {
      partNumber,
      status: { not: 'CANCELLED' },
      createdAt: { gte: cutoffDate },
    },
    select: {
      quantity: true,
      createdAt: true,
    },
  });

  // 按月聚合（跨年份）
  const monthlyTotals: Record<number, { total: number; years: number }> = {};
  for (const order of orders) {
    const month = order.createdAt.getMonth() + 1; // 1-12
    if (!monthlyTotals[month]) {
      monthlyTotals[month] = { total: 0, years: 0 };
    }
    monthlyTotals[month].total += order.quantity;
  }

  // 计算年均值
  const years = 3;
  const avgMonthly = Object.values(monthlyTotals).reduce((sum, m) => sum + m.total, 0) / (years * 12);

  const seasonalFactors = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const data = monthlyTotals[month];
    const avg = data ? data.total / years : 0;
    const factor = avgMonthly > 0 ? avg / avgMonthly : 1;

    let trend: 'high' | 'normal' | 'low' = 'normal';
    if (factor > 1.3) trend = 'high';
    else if (factor < 0.7) trend = 'low';

    return { month, factor: Math.round(factor * 100) / 100, trend };
  });

  // 下季度预测
  const currentMonth = new Date().getMonth() + 1;
  const nextQuarterMonths = [
    (currentMonth) % 12 + 1,
    (currentMonth + 1) % 12 + 1,
    (currentMonth + 2) % 12 + 1,
  ];
  const nextQuarterForecast = nextQuarterMonths.reduce((sum, m) => {
    const factor = seasonalFactors[m - 1]?.factor || 1;
    return sum + avgMonthly * factor;
  }, 0);

  return {
    partNumber,
    seasonalFactors,
    nextQuarterForecast: Math.round(nextQuarterForecast),
  };
}
