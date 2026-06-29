import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import {
  startWorkflow,
  processStep,
  cancelWorkflow,
  duplicateDefinition,
} from '../lib/workflowEngine.js';

const router = Router();

// Validation schemas
const workflowDefinitionCreateSchema = z.object({
  name: z.string().min(1, '名称不能为空'),
  code: z.string().min(1, '编码不能为空'),
  description: z.string().optional(),
  entityType: z.string().min(1, '实体类型不能为空'),
  isActive: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),
  steps: z.array(
    z.object({
      name: z.string().min(1, '步骤名称不能为空'),
      stepOrder: z.number().int().min(1),
      stepType: z.enum(['APPROVAL', 'NOTIFICATION', 'CONDITION', 'AUTOMATION']).optional().default('APPROVAL'),
      approverRole: z.string().optional(),
      approverUserId: z.string().optional(),
      approverDepartment: z.string().optional(),
      isParallel: z.boolean().optional().default(false),
      parallelMinCount: z.number().int().optional(),
      timeoutHours: z.number().int().min(1).optional().default(24),
      timeoutAction: z.string().optional().default('ESCALATE'),
      conditionExpression: z.string().optional(),
      autoAction: z.string().optional(),
      notificationTemplate: z.string().optional(),
    })
  ).optional().default([]),
});

const workflowDefinitionUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  entityType: z.string().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  steps: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string().min(1, '步骤名称不能为空'),
      stepOrder: z.number().int().min(1),
      stepType: z.enum(['APPROVAL', 'NOTIFICATION', 'CONDITION', 'AUTOMATION']).optional().default('APPROVAL'),
      approverRole: z.string().optional(),
      approverUserId: z.string().optional(),
      approverDepartment: z.string().optional(),
      isParallel: z.boolean().optional().default(false),
      parallelMinCount: z.number().int().optional(),
      timeoutHours: z.number().int().min(1).optional().default(24),
      timeoutAction: z.string().optional().default('ESCALATE'),
      conditionExpression: z.string().optional(),
      autoAction: z.string().optional(),
      notificationTemplate: z.string().optional(),
    })
  ).optional(),
});

const startInstanceSchema = z.object({
  definitionId: z.string().min(1, '工作流定义ID不能为空'),
  entityType: z.string().min(1, '实体类型不能为空'),
  entityId: z.string().min(1, '实体ID不能为空'),
  context: z.record(z.any()).optional(),
});

const _processActionSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'TRANSFER', 'COMMENT', 'ESCALATE']),
  comment: z.string().optional(),
  payload: z.record(z.any()).optional(),
});

// ==================== Definitions ====================

router.get(
  '/definitions',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { entityType, isActive } = req.query;
    const where: Prisma.WorkflowDefinitionWhereInput = {};
    if (entityType) where.entityType = entityType as string;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    const definitions = await prisma.workflowDefinition.findMany({
      where,
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
        _count: { select: { instances: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({
      success: true,
      data: definitions.map((d) => ({
        ...d,
        instanceCount: d._count.instances,
        _count: undefined,
      })),
    });
  })
);

router.post(
  '/definitions',
  authenticate,
  validateBody(workflowDefinitionCreateSchema),
  asyncHandler(async (req: AuthRequest, res) => {
    const { steps, ...data } = req.body;

    // Check code uniqueness
    const existing = await prisma.workflowDefinition.findUnique({
      where: { code: data.code },
    });
    if (existing) {
      throw new AppError('工作流编码已存在', 409, 'RESOURCE_CONFLICT');
    }

    const definition = await prisma.workflowDefinition.create({
      data: {
        ...data,
        steps: {
          create: steps.map((step: Record<string, unknown>, index: number) => ({
            ...step,
            stepOrder: (step.stepOrder as number) || index + 1,
          })),
        },
      },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });

    res.status(201).json({ success: true, data: definition });
  })
);

router.get(
  '/definitions/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const definition = await prisma.workflowDefinition.findUnique({
      where: { id },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });

    if (!definition) {
      throw new AppError('工作流定义不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({ success: true, data: definition });
  })
);

router.put(
  '/definitions/:id',
  authenticate,
  validateBody(workflowDefinitionUpdateSchema),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { steps, ...data } = req.body;

    const existing = await prisma.workflowDefinition.findUnique({
      where: { id },
      include: { steps: true },
    });

    if (!existing) {
      throw new AppError('工作流定义不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    // If there are running instances, prevent structural changes
    const runningCount = await prisma.workflowInstance.count({
      where: { definitionId: id, status: 'RUNNING' },
    });

    if (runningCount > 0 && steps) {
      throw new AppError('存在运行中的实例，无法修改步骤结构', 400, 'BAD_REQUEST');
    }

    const updateData: Prisma.WorkflowDefinitionUpdateInput = { ...data };

    if (steps) {
      // Delete existing steps and recreate
      await prisma.workflowStep.deleteMany({ where: { workflowId: id } });
      updateData.steps = {
        create: steps.map((step: Record<string, unknown>, index: number) => {
          const { id: _id, ...rest } = step;
          return {
            ...rest,
            stepOrder: (rest.stepOrder as number) || index + 1,
          };
        }),
      };
    }

    const definition = await prisma.workflowDefinition.update({
      where: { id },
      data: updateData,
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });

    res.json({ success: true, data: definition });
  })
);

router.delete(
  '/definitions/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;

    const definition = await prisma.workflowDefinition.findUnique({
      where: { id },
      include: { _count: { select: { instances: true } } },
    });

    if (!definition) {
      throw new AppError('工作流定义不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (definition._count.instances > 0) {
      // Soft delete: mark as inactive
      await prisma.workflowDefinition.update({
        where: { id },
        data: { isActive: false },
      });
      res.json({ success: true, message: '工作流定义已禁用（存在关联实例）' });
    } else {
      await prisma.workflowDefinition.delete({ where: { id } });
      res.json({ success: true, message: '工作流定义已删除' });
    }
  })
);

router.post(
  '/definitions/:id/duplicate',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const newDefinition = await duplicateDefinition(id, req.user!.id);
    res.status(201).json({ success: true, data: newDefinition });
  })
);

// ==================== Instances ====================

router.get(
  '/instances',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { entityType, entityId, status, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.WorkflowInstanceWhereInput = {};
    if (entityType) where.entityType = entityType as string;
    if (entityId) where.entityId = entityId as string;
    if (status) where.status = status as string;

    const [instances, total] = await Promise.all([
      prisma.workflowInstance.findMany({
        where,
        include: {
          definition: { select: { name: true, code: true, entityType: true } },
          steps: {
            orderBy: { stepOrder: 'asc' },
            include: { step: { select: { name: true } } },
          },
          _count: { select: { actions: true } },
        },
        orderBy: { startedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.workflowInstance.count({ where }),
    ]);

    res.json({
      success: true,
      data: instances,
      pagination: { page: pageNum, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  })
);

router.get(
  '/instances/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const instance = await prisma.workflowInstance.findUnique({
      where: { id },
      include: {
        definition: true,
        steps: {
          orderBy: { stepOrder: 'asc' },
          include: { step: true, actions: { orderBy: { createdAt: 'desc' } } },
        },
        actions: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!instance) {
      throw new AppError('工作流实例不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({ success: true, data: instance });
  })
);

router.post(
  '/instances',
  authenticate,
  validateBody(startInstanceSchema),
  asyncHandler(async (req: AuthRequest, res) => {
    const { definitionId, entityType, entityId, context } = req.body;
    const instance = await startWorkflow(
      definitionId,
      entityType,
      entityId,
      req.user!.id,
      context || {}
    );
    res.status(201).json({ success: true, data: instance });
  })
);

router.post(
  '/instances/:id/approve',
  authenticate,
  validateBody(z.object({ comment: z.string().optional(), payload: z.record(z.any()).optional() })),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { comment, payload } = req.body;
    const instance = await processStep(id, 'APPROVE', req.user!.id, comment, payload);
    res.json({ success: true, data: instance });
  })
);

router.post(
  '/instances/:id/reject',
  authenticate,
  validateBody(z.object({ comment: z.string().optional(), payload: z.record(z.any()).optional() })),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { comment, payload } = req.body;
    const instance = await processStep(id, 'REJECT', req.user!.id, comment, payload);
    res.json({ success: true, data: instance });
  })
);

router.post(
  '/instances/:id/transfer',
  authenticate,
  validateBody(
    z.object({
      targetUserId: z.string().optional(),
      targetRole: z.string().optional(),
      comment: z.string().optional(),
    })
  ),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { targetUserId, targetRole, comment } = req.body;
    const instance = await processStep(id, 'TRANSFER', req.user!.id, comment, {
      targetUserId,
      targetRole,
    });
    res.json({ success: true, data: instance });
  })
);

router.post(
  '/instances/:id/cancel',
  authenticate,
  validateBody(z.object({ reason: z.string().optional() })),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const instance = await cancelWorkflow(id, req.user!.id, reason);
    res.json({ success: true, data: instance });
  })
);

router.get(
  '/instances/pending',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user!.id;
    const userRole = req.user!.role;

    const pendingSteps = await prisma.workflowInstanceStep.findMany({
      where: {
        status: 'IN_PROGRESS',
        OR: [
          { assignedTo: userId },
          { assignedRole: { equals: userRole, mode: 'insensitive' } },
        ],
      },
      include: {
        instance: {
          include: {
            definition: { select: { name: true, code: true, entityType: true } },
          },
        },
        step: { select: { name: true, timeoutHours: true } },
        actions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { dueAt: 'asc' },
    });

    res.json({ success: true, data: pendingSteps });
  })
);

router.get(
  '/instances/entity/:entityType/:entityId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { entityType, entityId } = req.params;

    const instances = await prisma.workflowInstance.findMany({
      where: { entityType, entityId },
      include: {
        definition: { select: { name: true, code: true } },
        steps: {
          orderBy: { stepOrder: 'asc' },
          include: { step: { select: { name: true } }, actions: { orderBy: { createdAt: 'desc' } } },
        },
        actions: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { startedAt: 'desc' },
    });

    res.json({ success: true, data: instances });
  })
);

export default router;
