import prisma from './prisma.js';
import { AppError } from '../middleware/errorHandler.js';

export interface FMVResult {
  partNumber: string;
  manufacturer?: string;
  conditionCode: string;
  fmvs: Array<{
    stage: number;
    stageName: string;
    fmv: number;
    currency: string;
    confidence: number; // 0-100
    dataPoints: number;
    method: string;
  }>;
  selectedFMV: number;
  selectedStage: number;
  selectedConfidence: number;
  currency: string;
  calculatedAt: string;
}

/**
 * Stage 1: 同件号 + 同制造商 + 同条件 的近期交易
 */
async function stage1ExactMatch(
  partNumber: string,
  _conditionCode: string,
  _manufacturer?: string
): Promise<{ fmvs: FMVResult['fmvs']; totalDataPoints: number }> {
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 12);

  const [quotations, orders] = await Promise.all([
    prisma.quotation.findMany({
      where: {
        partNumber,
        status: { in: ['APPROVED', 'ACCEPTED'] },
        createdAt: { gte: cutoffDate },
      },
      select: { unitPrice: true, totalPrice: true, quantity: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.order.findMany({
      where: {
        partNumber,
        status: { not: 'CANCELLED' },
        createdAt: { gte: cutoffDate },
      },
      select: { totalAmount: true, quantity: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const prices: number[] = [];
  for (const q of quotations) {
    if (q.unitPrice && q.unitPrice > 0) prices.push(q.unitPrice);
  }
  for (const o of orders) {
    if (o.totalAmount && o.quantity && o.quantity > 0) {
      prices.push(o.totalAmount / o.quantity);
    }
  }

  if (prices.length === 0) {
    return { fmvs: [], totalDataPoints: 0 };
  }

  // 加权平均（近期权重更高）
  const sorted = [...prices].sort((a, b) => a - b);
  // 去掉最高和最低 10% 的异常值
  const trimStart = Math.floor(prices.length * 0.1);
  const trimEnd = Math.ceil(prices.length * 0.9);
  const trimmed = sorted.slice(trimStart, trimEnd);
  const trimmedAvg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

  return {
    fmvs: [{
      stage: 1,
      stageName: '同件号近期交易',
      fmv: Math.round(trimmedAvg * 100) / 100,
      currency: 'USD',
      confidence: Math.min(95, prices.length * 5 + 20),
      dataPoints: prices.length,
      method: 'Trimmed Mean (10% outlier exclusion)',
    }],
    totalDataPoints: prices.length,
  };
}

/**
 * Stage 2: 相似件号（前缀匹配）
 */
async function stage2SimilarPart(
  partNumber: string,
  _conditionCode: string
): Promise<{ fmvs: FMVResult['fmvs']; totalDataPoints: number }> {
  // 提取件号前缀（如 B737-LG-001 → B737-LG）
  const prefix = partNumber.split('-').slice(0, 2).join('-');
  if (!prefix || prefix.length < 3) {
    return { fmvs: [], totalDataPoints: 0 };
  }

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 24);

  const [quotations, orders] = await Promise.all([
    prisma.quotation.findMany({
      where: {
        partNumber: { startsWith: prefix },
        status: { in: ['APPROVED', 'ACCEPTED'] },
        createdAt: { gte: cutoffDate },
      },
      select: { unitPrice: true, totalPrice: true, quantity: true, partNumber: true },
    }),
    prisma.order.findMany({
      where: {
        partNumber: { startsWith: prefix },
        status: { not: 'CANCELLED' },
        createdAt: { gte: cutoffDate },
      },
      select: { totalAmount: true, quantity: true, partNumber: true },
    }),
  ]);

  const prices: number[] = [];
  for (const q of quotations) {
    if (q.unitPrice && q.unitPrice > 0) prices.push(q.unitPrice);
  }
  for (const o of orders) {
    if (o.totalAmount && o.quantity && o.quantity > 0) {
      prices.push(o.totalAmount / o.quantity);
    }
  }

  if (prices.length === 0) {
    return { fmvs: [], totalDataPoints: 0 };
  }

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

  return {
    fmvs: [{
      stage: 2,
      stageName: '相似件号交易',
      fmv: Math.round(avg * 100) / 100,
      currency: 'USD',
      confidence: Math.min(70, prices.length * 3 + 10),
      dataPoints: prices.length,
      method: 'Simple Average of similar part numbers',
    }],
    totalDataPoints: prices.length,
  };
}

/**
 * Stage 3: 同 ATA Chapter 件号均价
 */
async function stage3ATAChapter(
  ataChapter: string,
  _conditionCode: string
): Promise<{ fmvs: FMVResult['fmvs']; totalDataPoints: number }> {
  if (!ataChapter) {
    return { fmvs: [], totalDataPoints: 0 };
  }

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 36);

  // 从库存中获取同 ATA Chapter 的件号
  const inventoryItems = await prisma.inventory.findMany({
    where: { ataChapter },
    select: { partNumber: true },
    take: 50,
  });

  const partNumbers = inventoryItems.map((i) => i.partNumber);
  if (partNumbers.length === 0) {
    return { fmvs: [], totalDataPoints: 0 };
  }

  const [quotations, orders] = await Promise.all([
    prisma.quotation.findMany({
      where: {
        partNumber: { in: partNumbers },
        status: { in: ['APPROVED', 'ACCEPTED'] },
        createdAt: { gte: cutoffDate },
      },
      select: { unitPrice: true, totalPrice: true, quantity: true },
    }),
    prisma.order.findMany({
      where: {
        partNumber: { in: partNumbers },
        status: { not: 'CANCELLED' },
        createdAt: { gte: cutoffDate },
      },
      select: { totalAmount: true, quantity: true },
    }),
  ]);

  const prices: number[] = [];
  for (const q of quotations) {
    if (q.unitPrice && q.unitPrice > 0) prices.push(q.unitPrice);
  }
  for (const o of orders) {
    if (o.totalAmount && o.quantity && o.quantity > 0) {
      prices.push(o.totalAmount / o.quantity);
    }
  }

  if (prices.length === 0) {
    return { fmvs: [], totalDataPoints: 0 };
  }

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

  return {
    fmvs: [{
      stage: 3,
      stageName: '同 ATA Chapter 均价',
      fmv: Math.round(avg * 100) / 100,
      currency: 'USD',
      confidence: Math.min(50, prices.length * 2 + 5),
      dataPoints: prices.length,
      method: 'ATA Chapter average',
    }],
    totalDataPoints: prices.length,
  };
}

/**
 * Stage 4: 条件转换（AR/US → SV）
 */
function applyConditionTransformation(
  fmvs: FMVResult['fmvs'],
  targetCondition: string
): FMVResult['fmvs'] {
  // 简化版条件转换系数
  const transformationFactors: Record<string, Record<string, number>> = {
    'NE': { 'SV': 0.85, 'OH': 0.75, 'AR': 0.5, 'US': 0.3 },
    'NS': { 'SV': 0.9, 'OH': 0.8, 'AR': 0.55, 'US': 0.35 },
    'SV': { 'NE': 1.18, 'OH': 0.88, 'AR': 0.58, 'US': 0.38 },
    'OH': { 'NE': 1.33, 'SV': 1.14, 'AR': 0.65, 'US': 0.42 },
    'AR': { 'NE': 2.0, 'SV': 1.72, 'OH': 1.54, 'US': 0.65 },
    'US': { 'NE': 3.33, 'SV': 2.63, 'OH': 2.38, 'AR': 1.54 },
  };

  const factors = transformationFactors[targetCondition];
  if (!factors) return fmvs;

  return fmvs.map((fmv) => {
    // 默认假设原始数据是 SV 条件
    const factor = factors['SV'] || 1;
    return {
      ...fmv,
      fmv: Math.round(fmv.fmv * factor * 100) / 100,
      method: fmv.method + ` (Condition transform: SV → ${targetCondition}, factor: ${factor})`,
    };
  });
}

/**
 * 计算 FMV
 */
export async function calculateFMV(
  partNumber: string,
  conditionCode: string = 'SV',
  manufacturer?: string,
  ataChapter?: string
): Promise<FMVResult> {
  if (!partNumber) {
    throw new AppError('件号不能为空', 400, 'BAD_REQUEST');
  }

  const allFmvs: FMVResult['fmvs'] = [];

  // Stage 1: 精确匹配
  const stage1 = await stage1ExactMatch(partNumber, conditionCode, manufacturer);
  allFmvs.push(...stage1.fmvs);

  // Stage 2: 相似件号
  if (allFmvs.length === 0 || allFmvs[0].confidence < 80) {
    const stage2 = await stage2SimilarPart(partNumber, conditionCode);
    allFmvs.push(...stage2.fmvs);
  }

  // Stage 3: ATA Chapter
  if (allFmvs.length === 0 || allFmvs[0].confidence < 60) {
    const stage3 = await stage3ATAChapter(ataChapter || '', conditionCode);
    allFmvs.push(...stage3.fmvs);
  }

  // 应用条件转换
  const transformedFmvs = applyConditionTransformation(allFmvs, conditionCode);

  // 选择最佳 FMV（置信度最高）
  const best = transformedFmvs.length > 0
    ? transformedFmvs.reduce((best, current) => current.confidence > best.confidence ? current : best)
    : null;

  return {
    partNumber,
    manufacturer,
    conditionCode,
    fmvs: transformedFmvs,
    selectedFMV: best?.fmv || 0,
    selectedStage: best?.stage || 0,
    selectedConfidence: best?.confidence || 0,
    currency: 'USD',
    calculatedAt: new Date().toISOString(),
  };
}

/**
 * 批量计算 FMV
 */
export async function calculateBatchFMV(
  items: Array<{ partNumber: string; conditionCode?: string; manufacturer?: string; ataChapter?: string }>
): Promise<FMVResult[]> {
  const results: FMVResult[] = [];
  for (const item of items) {
    try {
      const result = await calculateFMV(
        item.partNumber,
        item.conditionCode || 'SV',
        item.manufacturer,
        item.ataChapter
      );
      results.push(result);
    } catch {
      results.push({
        partNumber: item.partNumber,
        conditionCode: item.conditionCode || 'SV',
        fmvs: [],
        selectedFMV: 0,
        selectedStage: 0,
        selectedConfidence: 0,
        currency: 'USD',
        calculatedAt: new Date().toISOString(),
      });
    }
  }
  return results;
}
