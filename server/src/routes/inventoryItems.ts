import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { canViewInventoryCost } from '../lib/costVisibility.js';
import { projectInventoryItem } from '../lib/inventoryProjection.js';
import { assertInventoryItemIdentityMutable } from '../modules/inventoryQuality/index.js';
import prisma from '../lib/prisma.js';

const router = Router();

const optionalNullableText = z.string().nullable().optional();

/**
 * InventoryItem is a shared identity row.  PATCH intentionally accepts only
 * its scalar metadata; relation objects, generated timestamps, and IDs must
 * never reach Prisma's nested-write surface.
 */
export const inventoryItemUpdateSchema = z.object({
  partNumber: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  partCategory: z.string().min(1).optional(),
  trackingType: z.string().min(1).optional(),
  manufacturer: optionalNullableText,
  manufacturerCageCode: optionalNullableText,
  ataChapter: optionalNullableText,
  alternatePartNumbers: optionalNullableText,
  unitOfMeasure: z.string().min(1).optional(),
  countryOfOrigin: optionalNullableText,
  hsCode: optionalNullableText,
}).strict();

// GET / - list all inventory items
router.get(
  '/',
  requireCapability('inventory', 'read'),
  asyncHandler(async (req, res) => {
    const includeCost = canViewInventoryCost((req as AuthRequest).user!);
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

    res.json(items.map((item) => projectInventoryItem(item, includeCost)));
  })
);

// GET /part/:partNumber
router.get(
  '/part/:partNumber',
  requireCapability('inventory', 'read'),
  asyncHandler(async (req, res) => {
    const includeCost = canViewInventoryCost((req as AuthRequest).user!);
    const item = await prisma.inventoryItem.findFirst({
      where: { partNumber: req.params.partNumber },
      include: { details: true },
    });
    if (!item) throw new AppError('InventoryItem not found', 404);
    res.json(projectInventoryItem(item, includeCost));
  })
);

// GET /:id
router.get(
  '/:id',
  requireCapability('inventory', 'read'),
  asyncHandler(async (req, res) => {
    const includeCost = canViewInventoryCost((req as AuthRequest).user!);
    const item = await prisma.inventoryItem.findUnique({
      where: { id: req.params.id },
      include: { details: true },
    });
    if (!item) throw new AppError('InventoryItem not found', 404);
    res.json(projectInventoryItem(item, includeCost));
  })
);

// POST /
router.post(
  '/',
  requireCapability('inventory', 'manage'),
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
  requireCapability('inventory', 'manage'),
  validateBody(inventoryItemUpdateSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof inventoryItemUpdateSchema>;
    const item = await prisma.$transaction(async (tx) => {
      const existing = await tx.inventoryItem.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          partNumber: true,
          trackingType: true,
          unitOfMeasure: true,
          updatedAt: true,
          details: {
            where: { allocatedQuantity: { gt: 0 } },
            select: { id: true, allocatedQuantity: true },
          },
        },
      });
      if (!existing) throw new AppError('InventoryItem not found', 404, 'RESOURCE_NOT_FOUND');

      const hasActiveModernAllocation = existing.details.length > 0;
      const partNumberChanges = input.partNumber !== undefined && input.partNumber !== existing.partNumber;
      const trackingTypeChanges = input.trackingType !== undefined && input.trackingType !== existing.trackingType;
      const unitChanges = input.unitOfMeasure !== undefined && input.unitOfMeasure !== existing.unitOfMeasure;
      if (hasActiveModernAllocation && (partNumberChanges || trackingTypeChanges || unitChanges)) {
        throw new AppError('存在现代库存分配时不能修改主件件号或追踪类型', 409, 'RESOURCE_CONFLICT');
      }
      if (partNumberChanges || trackingTypeChanges || unitChanges) {
        await assertInventoryItemIdentityMutable(tx, existing.id);
      }

      const updated = await tx.inventoryItem.updateMany({
        where: { id: existing.id, updatedAt: existing.updatedAt },
        data: input,
      });
      if (updated.count !== 1) {
        throw new AppError('库存主件已被其他操作修改，请刷新后重试', 409, 'STATE_CONFLICT');
      }

      const result = await tx.inventoryItem.findUnique({ where: { id: existing.id } });
      if (!result) throw new AppError('InventoryItem not found', 404, 'RESOURCE_NOT_FOUND');
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    res.json(item);
  })
);

export default router;
