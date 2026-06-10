import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = Router();

function getUserId(req: AuthRequest): string | undefined {
  return req.user?.id;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const notifications = await prisma.notification.findMany({
      where: userId ? { OR: [{ userId }, { userId: null }] } : { userId: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      success: true,
      data: notifications.map((n) => ({
        id: n.id,
        userId: n.userId,
        title: n.title,
        message: n.message,
        type: n.type.toLowerCase(),
        isRead: n.isRead,
        link: n.link,
        createdAt: n.createdAt.toISOString(),
      })),
    });
  })
);

router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const count = await prisma.notification.count({
      where: userId
        ? { isRead: false, OR: [{ userId }, { userId: null }] }
        : { isRead: false, userId: null },
    });

    res.json({
      success: true,
      data: { count },
    });
  })
);

router.patch(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const notification = await prisma.notification.findUnique({
      where: { id: req.params.id },
    });
    if (!notification) {
      throw new AppError('通知不存在', 404);
    }
    if (notification.userId && notification.userId !== userId) {
      throw new AppError('无权操作此通知', 403);
    }
    await prisma.notification.update({
      where: { id: req.params.id },
      data: { isRead: true },
    });

    res.json({
      success: true,
      data: { message: '已标记为已读' },
    });
  })
);

router.patch(
  '/read-all',
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    await prisma.notification.updateMany({
      where: userId
        ? { isRead: false, OR: [{ userId }, { userId: null }] }
        : { isRead: false, userId: null },
      data: { isRead: true },
    });

    res.json({
      success: true,
      data: { message: '所有通知已标记为已读' },
    });
  })
);

export default router;
