import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { emailClassifySchema } from '../lib/validation.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { type, isRead, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.EmailWhereInput = {};
    if (type) where.type = type.toString().toUpperCase();
    if (isRead !== undefined) where.isRead = isRead === 'true';

    const [emails, total] = await Promise.all([
      prisma.email.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.email.count({ where }),
    ]);

    res.json({
      success: true,
      data: emails.map((e) => ({
        id: e.id,
        from: e.from,
        fromName: e.fromName,
        subject: e.subject,
        body: e.body,
        receivedAt: e.receivedAt.toISOString(),
        type: e.type.toLowerCase(),
        isRead: e.isRead,
        attachments: e.attachments?.split(',').filter(Boolean) || [],
      })),
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const email = await prisma.email.findUnique({
      where: { id: req.params.id },
      include: { rfq: true },
    });

    if (!email) {
      throw new AppError('邮件不存在', 404);
    }

    res.json({
      success: true,
      data: {
        ...email,
        type: email.type.toLowerCase(),
        attachments: email.attachments?.split(',').filter(Boolean) || [],
      },
    });
  })
);

router.patch(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const email = await prisma.email.update({
      where: { id: req.params.id },
      data: { isRead: true },
    });

    res.json({
      success: true,
      data: { ...email, type: email.type.toLowerCase() },
    });
  })
);

router.patch(
  '/:id/classify',
  validateBody(emailClassifySchema),
  asyncHandler(async (req, res) => {
    const { type } = req.body;

    const email = await prisma.email.update({
      where: { id: req.params.id },
      data: { type: type.toUpperCase() },
    });

    res.json({
      success: true,
      data: { ...email, type: email.type.toLowerCase() },
    });
  })
);

export default router;
