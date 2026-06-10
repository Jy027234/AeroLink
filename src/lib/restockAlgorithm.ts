/**
 * VMI 自动补货算法
 * 
 * 基于历史消耗数据计算安全库存和再订货点，生成补货建议。
 * 
 * 算法公式：
 * - 平均日消耗 = SUM(历史消耗) / 历史天数
 * - 消耗标准差 = SQRT(SUM((日消耗 - 平均)^2) / n)
 * - 安全库存 = Z × 标准差 × SQRT(交货期)  （Z为服务水平系数）
 * - 再订货点 ROP = 平均日消耗 × 交货期 + 安全库存
 * - 建议补货量 = MAX(最大库存 - 当前库存, 最小订货量)
 */

export interface ConsumptionRecord {
  date: string;
  quantity: number;
}

export interface RestockParams {
  currentStock: number;
  leadTimeDays: number;        // 供应商交货期（天）
  minStock: number;            // 最小库存
  maxStock: number;            // 最大库存
  minOrderQty?: number;        // 最小订货量
  serviceLevel?: number;       // 服务水平 0-1，默认0.95
}

export interface RestockResult {
  shouldRestock: boolean;
  suggestedQty: number;
  reorderPoint: number;
  safetyStock: number;
  avgDailyConsumption: number;
  consumptionStdDev: number;
  daysUntilStockout: number | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

// 常用服务水平对应的Z值
const SERVICE_LEVEL_Z: Record<number, number> = {
  0.90: 1.28,
  0.95: 1.65,
  0.99: 2.33,
};

function getZValue(serviceLevel: number): number {
  const sorted = Object.keys(SERVICE_LEVEL_Z)
    .map(Number)
    .sort((a, b) => a - b);
  for (const level of sorted) {
    if (serviceLevel <= level) {
      return SERVICE_LEVEL_Z[level];
    }
  }
  return SERVICE_LEVEL_Z[0.99];
}

/**
 * 计算补货建议
 */
export function calculateRestock(
  consumptionHistory: ConsumptionRecord[],
  params: RestockParams
): RestockResult {
  const {
    currentStock,
    leadTimeDays,
    minStock,
    maxStock,
    minOrderQty = 1,
    serviceLevel = 0.95,
  } = params;

  // 如果没有历史数据，返回低置信度建议
  if (consumptionHistory.length < 7) {
    const shouldRestock = currentStock <= minStock;
    return {
      shouldRestock,
      suggestedQty: shouldRestock ? Math.max(maxStock - currentStock, minOrderQty) : 0,
      reorderPoint: minStock,
      safetyStock: minStock,
      avgDailyConsumption: 0,
      consumptionStdDev: 0,
      daysUntilStockout: null,
      confidence: 'low',
      reason: '历史消耗数据不足，基于最小库存阈值判断',
    };
  }

  // 按日期排序
  const sorted = [...consumptionHistory].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  // 计算平均日消耗
  const totalConsumption = sorted.reduce((sum, r) => sum + r.quantity, 0);
  const daysSpan = Math.max(
    1,
    Math.ceil(
      (new Date(sorted[sorted.length - 1].date).getTime() -
        new Date(sorted[0].date).getTime()) /
        (1000 * 60 * 60 * 24)
    )
  );
  const avgDailyConsumption = totalConsumption / daysSpan;

  // 计算标准差（按日聚合）
  const dailyMap = new Map<string, number>();
  for (const record of sorted) {
    const day = record.date.slice(0, 10);
    dailyMap.set(day, (dailyMap.get(day) || 0) + record.quantity);
  }
  const dailyValues = Array.from(dailyMap.values());
  const mean = dailyValues.reduce((s, v) => s + v, 0) / dailyValues.length;
  const variance =
    dailyValues.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / dailyValues.length;
  const consumptionStdDev = Math.sqrt(variance);

  // 计算安全库存
  const z = getZValue(serviceLevel);
  const safetyStock = z * consumptionStdDev * Math.sqrt(leadTimeDays);

  // 计算再订货点
  const reorderPoint = avgDailyConsumption * leadTimeDays + safetyStock;

  // 判断是否需补货
  const shouldRestock = currentStock <= reorderPoint || currentStock <= minStock;

  // 计算建议补货量
  let suggestedQty = 0;
  if (shouldRestock) {
    suggestedQty = Math.max(maxStock - currentStock, minOrderQty);
    // 向上取整到最小订货量的倍数
    if (minOrderQty > 1) {
      suggestedQty = Math.ceil(suggestedQty / minOrderQty) * minOrderQty;
    }
  }

  // 计算预计缺货天数
  const daysUntilStockout =
    avgDailyConsumption > 0 ? Math.floor(currentStock / avgDailyConsumption) : null;

  // 置信度判断
  let confidence: 'high' | 'medium' | 'low' = 'medium';
  if (dailyValues.length >= 30) {
    confidence = 'high';
  } else if (dailyValues.length >= 14) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // 生成原因说明
  let reason = '';
  if (currentStock <= minStock) {
    reason = `当前库存(${currentStock})已低于最小库存阈值(${minStock})`;
  } else if (currentStock <= reorderPoint) {
    reason = `当前库存(${currentStock})已低于再订货点(${Math.round(reorderPoint)})`;
  } else {
    reason = '库存充足，无需补货';
  }

  return {
    shouldRestock,
    suggestedQty,
    reorderPoint: Math.round(reorderPoint),
    safetyStock: Math.round(safetyStock),
    avgDailyConsumption: Math.round(avgDailyConsumption * 100) / 100,
    consumptionStdDev: Math.round(consumptionStdDev * 100) / 100,
    daysUntilStockout,
    confidence,
    reason,
  };
}

/**
 * 批量计算多个VMI协议的补货建议
 */
export function calculateRestockBatch(
  items: Array<{
    id: string;
    customerName: string;
    partNumber: string;
    currentStock: number;
    consumptionHistory: ConsumptionRecord[];
    params: RestockParams;
  }>
): Array<RestockResult & { id: string; customerName: string; partNumber: string }> {
  return items.map((item) => ({
    id: item.id,
    customerName: item.customerName,
    partNumber: item.partNumber,
    ...calculateRestock(item.consumptionHistory, item.params),
  }));
}
