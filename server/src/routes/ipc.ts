import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import prisma from '../lib/prisma.js';

const router = Router();

function parseJsonField(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const { q } = req.query;
    if (!q || typeof q !== 'string') {
      throw new AppError('查询参数 q 不能为空', 400);
    }

    const items = await prisma.iPCData.findMany({
      where: {
        partNumber: {
          contains: q,
        },
      },
      take: 10,
      orderBy: { partNumber: 'asc' },
    });

    res.json({
      success: true,
      data: items.map((item) => ({
        id: item.id,
        partNumber: item.partNumber,
        description: item.description,
        ataChapter: item.ataChapter,
        aircraftTypes: parseJsonField(item.aircraftTypes),
        supersededBy: item.supersededBy || undefined,
        interchangeableWith: parseJsonField(item.interchangeableWith),
        alternateParts: parseJsonField(item.alternateParts),
      })),
    });
  })
);

router.get(
  '/compatibility',
  asyncHandler(async (req, res) => {
    const { partNumber, aircraftType, msn } = req.query;
    if (!partNumber || !aircraftType || typeof partNumber !== 'string' || typeof aircraftType !== 'string') {
      throw new AppError('partNumber 和 aircraftType 为必填项', 400);
    }

    const item = await prisma.iPCData.findUnique({
      where: { partNumber },
    });

    if (!item) {
      throw new AppError('IPC 数据不存在', 404);
    }

    const aircraftTypes = parseJsonField(item.aircraftTypes);
    const normalizedAircraftType = aircraftType.toLowerCase();
    const exactMatch = aircraftTypes.some((type) => type.toLowerCase() === normalizedAircraftType);
    const fuzzyMatch = aircraftTypes.some(
      (type) =>
        type.toLowerCase().includes(normalizedAircraftType) ||
        normalizedAircraftType.includes(type.toLowerCase())
    );

    const warnings: string[] = [];
    if (item.supersededBy) {
      warnings.push(`当前件号已存在替代件 ${item.supersededBy}`);
    }
    if (!exactMatch && fuzzyMatch) {
      warnings.push('基于机型别名完成近似匹配，请人工复核适用性');
    }
    if (msn) {
      warnings.push(`MSN ${String(msn)} 需要结合构型与改装状态进一步确认`);
    }

    res.json({
      success: true,
      data: {
        isCompatible: exactMatch || fuzzyMatch,
        warnings,
        sbRequirements: [],
      },
    });
  })
);

router.get(
  '/:partNumber',
  asyncHandler(async (req, res) => {
    const { partNumber } = req.params;
    const item = await prisma.iPCData.findUnique({
      where: { partNumber },
    });

    if (!item) {
      throw new AppError('IPC 数据不存在', 404);
    }

    res.json({
      success: true,
      data: {
        id: item.id,
        partNumber: item.partNumber,
        description: item.description,
        ataChapter: item.ataChapter,
        aircraftTypes: parseJsonField(item.aircraftTypes),
        supersededBy: item.supersededBy || undefined,
        interchangeableWith: parseJsonField(item.interchangeableWith),
        alternateParts: parseJsonField(item.alternateParts),
      },
    });
  })
);

export default router;
