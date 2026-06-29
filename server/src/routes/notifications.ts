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

router.post(
  '/dispatch',
  asyncHandler(async (req, res) => {
    const { event, targetUserIds, payload } = req.body as {
      event?: string;
      targetUserIds?: string[];
      payload?: Record<string, string>;
    };

    const titleMap: Record<string, string> = {
      AOG_RFQ_CREATED: 'AOG 需求单已创建',
      AOG_RFQ_UPDATED: 'AOG 需求单已更新',
      AOG_QUOTE_APPROVED: 'AOG 报价已审批通过',
      AOG_ORDER_CONFIRMED: 'AOG 订单已确认',
      AOG_SHIPMENT_DELAYED: 'AOG 物流发生延误',
      AOG_INVENTORY_ALERT: 'AOG 库存预警',
    };

    const partNumber = payload?.partNumber ? `件号 ${payload.partNumber}` : '相关单据';
    const messageMap: Record<string, string> = {
      AOG_RFQ_CREATED: `${payload?.rfqNumber || 'RFQ'} 已创建，${partNumber}`,
      AOG_RFQ_UPDATED: `${payload?.rfqNumber || 'RFQ'} 已更新，${partNumber}`,
      AOG_QUOTE_APPROVED: `${payload?.quoteNumber || '报价单'} 已审批通过，${partNumber}`,
      AOG_ORDER_CONFIRMED: `${payload?.orderNumber || '订单'} 已确认，${partNumber}`,
      AOG_SHIPMENT_DELAYED: `${payload?.trackingNumber || '物流单'} 出现延误，${partNumber}`,
      AOG_INVENTORY_ALERT: `${partNumber} 触发库存预警`,
    };

    const targetIds =
      Array.isArray(targetUserIds) && targetUserIds.length > 0
        ? Array.from(new Set(targetUserIds))
        : (
            await prisma.user.findMany({
              where: {
                isActive: true,
                role: { in: ['GM', 'MANAGER', 'ADMIN', 'SALES'] },
              },
              select: { id: true },
            })
          ).map((user) => user.id);

    const data =
      targetIds.length > 0
        ? targetIds.map((userId) => ({
            userId,
            title: titleMap[event || ''] || '系统通知',
            message: messageMap[event || ''] || '您有一条新的系统通知',
            type: event?.includes('AOG') ? 'WARNING' : 'INFO',
          }))
        : [
            {
              userId: null,
              title: titleMap[event || ''] || '系统通知',
              message: messageMap[event || ''] || '您有一条新的系统通知',
              type: event?.includes('AOG') ? 'WARNING' : 'INFO',
            },
          ];

    await prisma.notification.createMany({ data });

    res.json({
      success: true,
      data: {
        dispatched: data.length,
        channels: [{ channel: 'SYSTEM', count: data.length }],
      },
    });
  })
);

export default router;
