import { Router } from 'express';
import { requireCapability } from '../middleware/capability.js';
import prisma from '../lib/prisma.js';
import { calculateFMV } from '../lib/fmvEngine.js';

const router = Router();

router.use(requireCapability('fmv', 'read'));

/**
 * GET /api/fmv/:partNumber
 * Calculate FMV for a part number (requires authentication)
 */
router.get('/:partNumber', async (req, res, next) => {
  try {
    const { partNumber } = req.params;
    const { conditionCode = 'SV' } = req.query;

    const result = await calculateFMV(
      partNumber,
      conditionCode as string
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/fmv/:partNumber/history
 * Get historical price data for a part number
 */
router.get('/:partNumber/history', async (req, res, next) => {
  try {
    const { partNumber } = req.params;
    const { months = '12' } = req.query;

    const since = new Date();
    since.setMonth(since.getMonth() - parseInt(months as string));

    // Get historical transactions from quotations and orders
    const quotations = await prisma.quotation.findMany({
      where: {
        partNumber,
        status: { in: ['ACCEPTED', 'CONVERTED'] },
        createdAt: { gte: since },
      },
      select: {
        unitPrice: true,
        quantity: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const orders = await prisma.order.findMany({
      where: {
        partNumber,
        status: { in: ['CONFIRMED', 'SHIPPED', 'DELIVERED'] },
        createdAt: { gte: since },
      },
      select: {
        totalAmount: true,
        quantity: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const history = [
      ...quotations.map((item) => ({
        date: item.createdAt,
        price: item.unitPrice,
        quantity: item.quantity,
        source: 'quotation' as const,
      })),
      ...orders.map((item) => ({
        date: item.createdAt,
        price: item.quantity > 0 ? item.totalAmount / item.quantity : 0,
        quantity: item.quantity,
        source: 'order' as const,
      })),
    ];

    res.json({
      success: true,
      data: {
        partNumber,
        history,
        count: history.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/fmv/batch
 * Batch FMV calculation
 */
router.post('/batch', async (req, res, next) => {
  try {
    const { items } = req.body as {
      items: Array<{ partNumber: string; conditionCode?: string }>;
    };

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Items array is required',
      });
    }

    if (items.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 50 items per batch',
      });
    }

    const results = await Promise.all(
      items.map(async (item) => {
        try {
          const result = await calculateFMV(
            item.partNumber,
            item.conditionCode || 'SV'
          );
          return {
            partNumber: item.partNumber,
            success: true,
            data: result,
          };
        } catch (err) {
          return {
            partNumber: item.partNumber,
            success: false,
            error: (err as Error).message,
          };
        }
      })
    );

    res.json({
      success: true,
      data: {
        results,
        total: items.length,
        successful: results.filter((r) => r.success).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
