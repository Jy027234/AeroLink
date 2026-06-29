import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import prisma from '../lib/prisma.js';

const router = Router();

// GET / - list all inventory items
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { partNumber, partCategory, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
    const skip = (pageNum - 1) * pageSize;

    const where: Record<string, unknown> = {};
    if (partNumber) where.partNumber = { contains: partNumber.toString() };
    if (partCategory) where.partCategory = partCategory.toString().toUpperCase();

    const items = await prisma.inventoryItem.findMany({
      where,
      include: { details: true },
      orderBy: { partNumber: 'asc' },
      skip,
      take: pageSize,
    });

    res.json(items);
  })
);

// GET /part/:partNumber
router.get(
  '/part/:partNumber',
  asyncHandler(async (req, res) => {
    const item = await prisma.inventoryItem.findFirst({
      where: { partNumber: req.params.partNumber },
      include: { details: true },
    });
    if (!item) throw new AppError('InventoryItem not found', 404);
    res.json(item);
  })
);

// GET /:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const item = await prisma.inventoryItem.findUnique({
      where: { id: req.params.id },
      include: { details: true },
    });
    if (!item) throw new AppError('InventoryItem not found', 404);
    res.json(item);
  })
);

// POST /
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { partNumber, description, partCategory, trackingType, manufacturer, unitOfMeasure } = req.body;
    if (!partNumber || !description) {
      throw new AppError('partNumber and description are required', 400);
    }
    const item = await prisma.inventoryItem.create({
      data: {
        partNumber,
        description,
        partCategory: partCategory || 'CONSUMABLE',
        trackingType: trackingType || 'BATCH',
        manufacturer,
        unitOfMeasure: unitOfMeasure || 'EA',
      },
    });
    res.status(201).json(item);
  })
);

// PATCH /:id
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.inventoryItem.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new AppError('InventoryItem not found', 404);

    const item = await prisma.inventoryItem.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(item);
  })
);

export default router;
