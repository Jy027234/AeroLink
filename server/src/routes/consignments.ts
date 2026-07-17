import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import prisma from '../lib/prisma.js';

const router = Router();

function generateAgreementNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `CON-${year}-${random}`;
}

/**
 * GET /api/consignments - list consignments
 */
router.get(
  '/',
  requireCapability('consignment', 'read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { status, supplierId, partNumber, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: any = {};
    if (status) where.status = status;
    if (supplierId) where.supplierId = supplierId;
    if (partNumber) where.partNumber = { contains: partNumber };

    const [consignments, total] = await Promise.all([
      prisma.consignment.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.consignment.count({ where }),
    ]);

    res.json({
      success: true,
      data: consignments,
      pagination: { page: pageNum, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  })
);

/**
 * POST /api/consignments - create consignment
 */
router.post(
  '/',
  requireCapability('consignment', 'create'),
  asyncHandler(async (req: AuthRequest, res) => {
    const data = req.body;
    const agreementNumber = generateAgreementNumber();

    const consignment = await prisma.consignment.create({
      data: {
        ...data,
        agreementNumber,
        currentQuantity: data.quantity || 0,
        initialQuantity: data.quantity || 0,
        createdBy: req.user!.id,
      },
    });

    res.json({ success: true, data: consignment });
  })
);

/**
 * GET /api/consignments/:id
 */
router.get(
  '/:id',
  requireCapability('consignment', 'read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const consignment = await prisma.consignment.findUnique({ where: { id } });
    if (!consignment) throw new AppError('寄售协议不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data: consignment });
  })
);

/**
 * PUT /api/consignments/:id
 */
router.put(
  '/:id',
  requireCapability('consignment', 'update'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const data = req.body;

    const consignment = await prisma.consignment.update({
      where: { id },
      data: {
        ...data,
        updatedAt: new Date(),
      },
    });

    res.json({ success: true, data: consignment });
  })
);

/**
 * POST /api/consignments/:id/consume - record consumption
 */
router.post(
  '/:id/consume',
  requireCapability('consignment', 'update'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity <= 0) {
      throw new AppError('消耗数量必须大于0', 400, 'BAD_REQUEST');
    }

    const consignment = await prisma.consignment.findUnique({ where: { id } });
    if (!consignment) throw new AppError('寄售协议不存在', 404, 'RESOURCE_NOT_FOUND');
    if (consignment.status !== 'ACTIVE') {
      throw new AppError('寄售协议未激活', 400, 'BAD_REQUEST');
    }
    if (consignment.currentQuantity < quantity) {
      throw new AppError('库存不足', 400, 'BAD_REQUEST');
    }

    const updated = await prisma.consignment.update({
      where: { id },
      data: {
        consumedQuantity: { increment: quantity },
        currentQuantity: { decrement: quantity },
        updatedAt: new Date(),
      },
    });

    res.json({ success: true, data: updated });
  })
);

/**
 * POST /api/consignments/:id/terminate - terminate agreement
 */
router.post(
  '/:id/terminate',
  requireCapability('consignment', 'update'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const consignment = await prisma.consignment.findUnique({ where: { id } });
    if (!consignment) throw new AppError('寄售协议不存在', 404, 'RESOURCE_NOT_FOUND');

    const updated = await prisma.consignment.update({
      where: { id },
      data: {
        status: 'TERMINATED',
        updatedAt: new Date(),
      },
    });

    res.json({ success: true, data: updated });
  })
);

/**
 * GET /api/consignments/alerts - get consignment alerts
 */
router.get(
  '/alerts',
  requireCapability('consignment', 'read'),
  asyncHandler(async (_req: AuthRequest, res) => {
    const now = new Date();
    const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [expiring, lowStock] = await Promise.all([
      prisma.consignment.findMany({
        where: {
          status: 'ACTIVE',
          endDate: { lte: thirtyDaysLater },
        },
        orderBy: { endDate: 'asc' },
        take: 20,
      }),
      prisma.consignment.findMany({
        where: {
          status: 'ACTIVE',
          currentQuantity: { lte: prisma.consignment.fields.minStockLevel },
        },
        orderBy: { currentQuantity: 'asc' },
        take: 20,
      }),
    ]);

    res.json({
      success: true,
      data: {
        expiring,
        lowStock,
        totalAlerts: expiring.length + lowStock.length,
      },
    });
  })
);

export default router;
