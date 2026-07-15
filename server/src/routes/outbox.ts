import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { requirePrivilegedRole } from '../lib/accessControl.js';
import {
  cancelOutboxEvent,
  getOutboxStats,
  isOutboxChannel,
  OutboxStatus,
  retryOutboxEvent,
} from '../lib/outboxService.js';
import prisma from '../lib/prisma.js';

const router = Router();
const outboxStatuses = new Set<string>(Object.values(OutboxStatus));

function requireOperationsAccess(req: AuthRequest) {
  requirePrivilegedRole(req, '无权查看或处置 Outbox，仅管理员或总经理可执行此操作');
}

function parsePage(value: unknown, fallback: number) {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    requireOperationsAccess(req as AuthRequest);

    const page = parsePage(req.query.page, 1);
    const limit = Math.min(100, parsePage(req.query.limit, 20));
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : undefined;
    const channel = typeof req.query.channel === 'string' ? req.query.channel.trim().toUpperCase() : undefined;
    const where = {
      ...(status && outboxStatuses.has(status) ? { status } : {}),
      ...(channel && isOutboxChannel(channel) ? { channel } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.outboxEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          channel: true,
          eventType: true,
          aggregateType: true,
          aggregateId: true,
          status: true,
          attemptCount: true,
          maxAttempts: true,
          nextRetryAt: true,
          lockedAt: true,
          deliveredAt: true,
          lastError: true,
          createdById: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.outboxEvent.count({ where }),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  }),
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    requireOperationsAccess(req as AuthRequest);
    res.json({ success: true, data: await getOutboxStats() });
  }),
);

router.post(
  '/:id/retry',
  asyncHandler(async (req, res) => {
    requireOperationsAccess(req as AuthRequest);
    const event = await retryOutboxEvent(req.params.id);
    res.json({ success: true, data: event });
  }),
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    requireOperationsAccess(req as AuthRequest);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    await cancelOutboxEvent(req.params.id, reason);
    res.json({ success: true, data: { id: req.params.id, status: OutboxStatus.CANCELLED } });
  }),
);

export default router;
