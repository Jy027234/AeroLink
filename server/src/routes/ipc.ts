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
