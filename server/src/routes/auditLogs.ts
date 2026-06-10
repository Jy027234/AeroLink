import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const {
      page,
      limit,
      userId,
      action,
      resourceType,
      resourceId,
      status,
      startDate,
      endDate,
      search,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.AuditLogWhereInput = {};

    if (userId) where.userId = userId as string;
    if (action) where.action = (action as string).toUpperCase();
    if (resourceType) where.resourceType = (resourceType as string).toUpperCase();
    if (resourceId) where.resourceId = resourceId as string;
    if (status) where.status = (status as string).toUpperCase();
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
    }
    if (search) {
      where.OR = [
        { userName: { contains: search as string, mode: 'insensitive' } },
        { resourceName: { contains: search as string, mode: 'insensitive' } },
        { details: { contains: search as string, mode: 'insensitive' } },
        { resourceId: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: logs.map((log) => ({
        ...log,
        createdAt: log.createdAt.toISOString(),
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
  '/stats',
  asyncHandler(async (_req, res) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      actionStats,
      resourceStats,
      dailyTrend,
      totalToday,
      failedToday,
      topUsers,
      topResourceTypes,
    ] = await Promise.all([
      prisma.auditLog.groupBy({
        by: ['action'],
        _count: { action: true },
        orderBy: { _count: { action: 'desc' } },
      }),
      prisma.auditLog.groupBy({
        by: ['resourceType'],
        _count: { resourceType: true },
        orderBy: { _count: { resourceType: 'desc' } },
      }),
      prisma.auditLog.groupBy({
        by: ['createdAt'],
        where: {
          createdAt: {
            gte: new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000),
          },
        },
        _count: { id: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.auditLog.count({
        where: { createdAt: { gte: today } },
      }),
      prisma.auditLog.count({
        where: { createdAt: { gte: today }, status: 'FAILURE' },
      }),
      prisma.auditLog.groupBy({
        by: ['userId', 'userName'],
        where: { createdAt: { gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000) } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
      prisma.auditLog.groupBy({
        by: ['resourceType'],
        where: { createdAt: { gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000) } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
    ]);

    // Normalize daily trend to date strings
    const trendMap = new Map<string, number>();
    for (const row of dailyTrend) {
      const dateKey = row.createdAt.toISOString().split('T')[0];
      trendMap.set(dateKey, (trendMap.get(dateKey) || 0) + row._count.id);
    }

    const dailyTrendResult = Array.from(trendMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      success: true,
      data: {
        actionsByType: actionStats.map((s) => ({ action: s.action, count: s._count.action })),
        resourcesByType: resourceStats.map((s) => ({ resourceType: s.resourceType, count: s._count.resourceType })),
        dailyTrend: dailyTrendResult,
        totalToday,
        failedToday,
        topUsers: topUsers.map((u) => ({ userId: u.userId, userName: u.userName, count: u._count.id })),
        topResourceTypes: topResourceTypes.map((r) => ({ resourceType: r.resourceType, count: r._count.id })),
      },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const log = await prisma.auditLog.findUnique({
      where: { id: req.params.id },
    });

    if (!log) {
      throw new AppError('审计日志不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: {
        ...log,
        createdAt: log.createdAt.toISOString(),
      },
    });
  })
);

router.get(
  '/resource/:type/:id',
  asyncHandler(async (req, res) => {
    const { type, id } = req.params;
    const { page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: {
          resourceType: type.toUpperCase(),
          resourceId: id,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.auditLog.count({
        where: {
          resourceType: type.toUpperCase(),
          resourceId: id,
        },
      }),
    ]);

    res.json({
      success: true,
      data: logs.map((log) => ({
        ...log,
        createdAt: log.createdAt.toISOString(),
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
  '/user/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.auditLog.count({
        where: { userId: id },
      }),
    ]);

    res.json({
      success: true,
      data: logs.map((log) => ({
        ...log,
        createdAt: log.createdAt.toISOString(),
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

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthRequest).user;
    const {
      action,
      resourceType,
      resourceId,
      resourceName,
      changes,
      details,
      status,
      errorMessage,
    } = req.body;

    if (!action || !resourceType) {
      throw new AppError('action 和 resourceType 为必填项', 400, 'VALIDATION_ERROR');
    }

    const log = await prisma.auditLog.create({
      data: {
        userId: user?.id,
        userName: user?.name,
        userRole: user?.role,
        action: action.toUpperCase(),
        resourceType: resourceType.toUpperCase(),
        resourceId: resourceId || null,
        resourceName: resourceName || null,
        changes: changes ? JSON.stringify(changes) : null,
        details: details || null,
        ipAddress: req.ip || req.socket.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
        status: status?.toUpperCase() || 'SUCCESS',
        errorMessage: errorMessage || null,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        ...log,
        createdAt: log.createdAt.toISOString(),
      },
    });
  })
);

export default router;
