import { Router } from 'express';
import { Prisma } from '@prisma/client';
import type { AuthRequest } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { agentCreateSchema, agentUpdateSchema } from '../lib/validation.js';
import { classifyRFQEmail, generateQuoteAnalysis, generateCompletion, logAgentAction } from '../lib/aiService.js';
import { logger } from '../lib/logger.js';
import { emitWebhookEvent } from '../lib/webhookService.js';
import { normalizeRole } from '../lib/capabilityPolicy.js';
import prisma from '../lib/prisma.js';

const router = Router();
const requireAgentManagementRole = requireCapability('agent', 'manage');
const requireAgentRunCapability = requireCapability('agent', 'run');
const requireAgentReadCapability = requireCapability('agent', 'read');

type RuntimePrismaClient = Prisma.TransactionClient | typeof prisma;

function parseRuntimeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function extractRuntimeStepId(recordId: string): string {
  const separatorIndex = recordId.indexOf('::');
  return separatorIndex >= 0 ? recordId.slice(separatorIndex + 2) : recordId;
}

function extractRuntimeConfirmationId(recordId: string): string {
  const separatorIndex = recordId.indexOf('::');
  return separatorIndex >= 0 ? recordId.slice(separatorIndex + 2) : recordId;
}

async function getRuntimeTaskById(client: RuntimePrismaClient, id: string) {
  return client.agentRuntimeTask.findUnique({
    where: { id },
    include: {
      steps: {
        orderBy: { sequence: 'asc' },
      },
      confirmation: true,
    },
  });
}

type AgentRuntimeTaskRecord = NonNullable<Awaited<ReturnType<typeof getRuntimeTaskById>>>;

type RuntimeTrust = 'server_trusted' | 'legacy_untrusted';
type RuntimeExecutionState = 'manual_workflow_required' | 'not_dispatched';

function getRuntimeTrust(_context: unknown): RuntimeTrust {
  // The legacy table has no server-owned attribution column. Context/result data
  // may have been written by the old client PUT endpoint, so it cannot establish
  // ownership or trust. A future server-controlled task creation path must add
  // independent metadata before this can return server_trusted.
  return 'legacy_untrusted';
}

function getRuntimeExecutionStateFromData(data: unknown): RuntimeExecutionState | undefined {
  if (!data || typeof data !== 'object') return undefined;

  const directState = (data as Record<string, unknown>).executionState;
  if (directState === 'manual_workflow_required' || directState === 'not_dispatched') {
    return directState;
  }

  for (const key of ['approvalStatus', 'orderStatus', 'notificationStatus', 'dispatchStatus']) {
    const marker = (data as Record<string, unknown>)[key];
    if (marker === 'manual_workflow_required' || marker === 'not_dispatched') {
      return marker;
    }
  }

  return undefined;
}

function getRuntimeExecutionState(task: AgentRuntimeTaskRecord): RuntimeExecutionState | undefined {
  const context = parseRuntimeJson(task.context, {});
  const result = task.result ? parseRuntimeJson(task.result, {}) : undefined;
  return getRuntimeExecutionStateFromData(context)
    || getRuntimeExecutionStateFromData(result)
    || task.steps.reduce<RuntimeExecutionState | undefined>(
      (state, step) => state || getRuntimeExecutionStateFromData(step.result ? parseRuntimeJson(step.result, {}) : undefined),
      undefined
    );
}

function isPrivilegedRuntimeReader(user: NonNullable<AuthRequest['user']>): boolean {
  return normalizeRole(user.role) === 'admin';
}

function canReadRuntimeTask(user: NonNullable<AuthRequest['user']>, _context: unknown): boolean {
  // Until D15 supplies server-owned attribution, only the explicit admin role
  // may inspect legacy history. Capability manage/read does not grant history
  // access because it cannot establish task ownership.
  return isPrivilegedRuntimeReader(user);
}

function getAuthenticatedRuntimeReader(req: AuthRequest): NonNullable<AuthRequest['user']> {
  if (!req.user) {
    throw new AppError('未授权，请先登录', 401, 'AUTH_UNAUTHORIZED');
  }

  return req.user;
}

function mapRuntimeTask(task: AgentRuntimeTaskRecord) {
  const context = parseRuntimeJson(task.context, {});
  const result = task.result ? parseRuntimeJson(task.result, {}) : undefined;
  const executionState = getRuntimeExecutionState(task);

  return {
    id: task.id,
    trigger: {
      type: task.triggerType,
      source: task.triggerSource || undefined,
      referenceId: task.triggerReferenceId || undefined,
    },
    type: task.type,
    status: task.status,
    currentStepIndex: task.currentStepIndex,
    steps: task.steps.map((step) => {
      const stepResult = step.result ? parseRuntimeJson(step.result, {}) : undefined;
      return {
        id: extractRuntimeStepId(step.id),
        capability: step.capability,
        action: step.action,
        params: parseRuntimeJson(step.params, {}),
        status: step.status,
        executionState: getRuntimeExecutionStateFromData(stepResult),
        result: stepResult,
        error: step.error || undefined,
        startedAt: step.startedAt?.toISOString(),
        completedAt: step.completedAt?.toISOString(),
      };
    }),
    confirmationNode: task.confirmation
      ? {
          id: extractRuntimeConfirmationId(task.confirmation.id),
          taskId: task.confirmation.taskId,
          stepId: task.confirmation.stepId,
          type: task.confirmation.type,
          title: task.confirmation.title,
          titleZh: task.confirmation.titleZh || undefined,
          titleEn: task.confirmation.titleEn || undefined,
          description: task.confirmation.description,
          descriptionZh: task.confirmation.descriptionZh || undefined,
          descriptionEn: task.confirmation.descriptionEn || undefined,
          data: parseRuntimeJson(task.confirmation.data, {}),
          options: parseRuntimeJson(task.confirmation.options, []),
          selectedOption: task.confirmation.selectedOption || undefined,
          confirmedAt: task.confirmation.confirmedAt?.toISOString(),
          confirmedBy: task.confirmation.confirmedBy || undefined,
        }
      : undefined,
    context,
    result,
    executionState,
    runtimeTrust: getRuntimeTrust(context),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString(),
    error: task.error || undefined,
  };
}

router.get(
  '/runtime/tasks',
  requireAgentReadCapability,
  asyncHandler(async (req, res) => {
    const reader = getAuthenticatedRuntimeReader(req as AuthRequest);
    const limitValue = parseInt(String(req.query.limit || '50'), 10);
    const limit = Number.isNaN(limitValue) ? 50 : Math.min(Math.max(limitValue, 1), 100);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;

    const tasks = await prisma.agentRuntimeTask.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
      },
      include: {
        steps: {
          orderBy: { sequence: 'asc' },
        },
        confirmation: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    const visibleTasks = tasks.filter((task) => {
      const context = parseRuntimeJson(task.context, {});
      return canReadRuntimeTask(reader, context);
    });

    res.json({
      success: true,
      data: visibleTasks.map(mapRuntimeTask),
    });
  })
);

router.get(
  '/runtime/tasks/:id',
  requireAgentReadCapability,
  asyncHandler(async (req, res) => {
    const reader = getAuthenticatedRuntimeReader(req as AuthRequest);
    const task = await getRuntimeTaskById(prisma, req.params.id);

    if (!task || !canReadRuntimeTask(reader, parseRuntimeJson(task.context, {}))) {
      throw new AppError('运行时任务不存在', 404);
    }

    res.json({
      success: true,
      data: mapRuntimeTask(task),
    });
  })
);

router.get(
  '/runtime/dashboard',
  requireAgentReadCapability,
  asyncHandler(async (req, res) => {
    const reader = getAuthenticatedRuntimeReader(req as AuthRequest);
    const recentTasks = await prisma.agentRuntimeTask.findMany({
      include: {
        steps: {
          orderBy: { sequence: 'asc' },
        },
        confirmation: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const visibleTasks = recentTasks.filter((task) => canReadRuntimeTask(reader, parseRuntimeJson(task.context, {})));
    const recentTaskPayload = visibleTasks.slice(0, 20).map(mapRuntimeTask);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const taskCounts = {
      total: visibleTasks.length,
      running: visibleTasks.filter((task) => task.status === 'running').length,
      pending: visibleTasks.filter(
        (task) => task.status === 'pending' || getRuntimeExecutionState(task)
      ).length,
      waitingConfirmation: visibleTasks.filter((task) => task.status === 'waiting_confirmation').length,
      completedToday: visibleTasks.filter(
        (task) => task.status === 'completed'
          && !getRuntimeExecutionState(task)
          && task.completedAt
          && task.completedAt >= today
      ).length,
      failedToday: visibleTasks.filter(
        (task) => task.status === 'failed' && task.updatedAt >= today
      ).length,
    };

    res.json({
      success: true,
      data: {
        tasks: {
          ...taskCounts,
        },
        recentTasks: recentTaskPayload,
        pendingConfirmations: recentTaskPayload
          .filter((task) => task.status === 'waiting_confirmation' && task.confirmationNode)
          .map((task) => task.confirmationNode),
      },
    });
  })
);

router.put(
  '/runtime/tasks/:id',
  requireAgentRunCapability,
  asyncHandler(async (req, res) => {
    void req;
    void res;
    throw new AppError(
      '客户端运行时任务状态同步已禁用；请使用服务端受控任务接口或人工业务流程',
      410,
      'BAD_REQUEST'
    );
  })
);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const agents = await prisma.aIAgent.findMany({
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: agents.map((agent) => ({
        ...agent,
        config: JSON.parse(agent.config),
        prompts: JSON.parse(agent.prompts),
      })),
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const agent = await prisma.aIAgent.findUnique({
      where: { id: req.params.id },
    });

    if (!agent) {
      throw new AppError('Agent不存在', 404);
    }

    res.json({
      success: true,
      data: {
        ...agent,
        config: JSON.parse(agent.config),
        prompts: JSON.parse(agent.prompts),
      },
    });
  })
);

router.post(
  '/',
  requireAgentManagementRole,
  validateBody(agentCreateSchema),
  asyncHandler(async (req, res) => {
    const { name, type, description, isActive, config, prompts } = req.body;

    const agent = await prisma.aIAgent.create({
      data: {
        name,
        type,
        description,
        isActive: isActive ?? true,
        config: JSON.stringify(config || {}),
        prompts: JSON.stringify(prompts || []),
      },
    });

    res.status(201).json({
      success: true,
      data: {
        ...agent,
        config: JSON.parse(agent.config),
        prompts: JSON.parse(agent.prompts),
      },
    });
  })
);

router.patch(
  '/:id',
  requireAgentManagementRole,
  validateBody(agentUpdateSchema),
  asyncHandler(async (req, res) => {
    const { name, type, description, isActive, config, prompts } = req.body;

    const agent = await prisma.aIAgent.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(type !== undefined && { type }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
        ...(config !== undefined && { config: JSON.stringify(config) }),
        ...(prompts !== undefined && { prompts: JSON.stringify(prompts) }),
      },
    });

    res.json({
      success: true,
      data: {
        ...agent,
        config: JSON.parse(agent.config),
        prompts: JSON.parse(agent.prompts),
      },
    });
  })
);

router.delete(
  '/:id',
  requireAgentManagementRole,
  asyncHandler(async (req, res) => {
    await prisma.aIAgent.delete({
      where: { id: req.params.id },
    });

    res.json({
      success: true,
      data: { message: 'Agent已删除' },
    });
  })
);

router.post(
  '/:id/toggle',
  requireAgentManagementRole,
  asyncHandler(async (req, res) => {
    const agent = await prisma.aIAgent.findUnique({
      where: { id: req.params.id },
    });

    if (!agent) {
      throw new AppError('Agent不存在', 404);
    }

    const updated = await prisma.aIAgent.update({
      where: { id: req.params.id },
      data: { isActive: !agent.isActive },
    });

    res.json({
      success: true,
      data: {
        ...updated,
        config: JSON.parse(updated.config),
        prompts: JSON.parse(updated.prompts),
      },
    });
  })
);

router.post(
  '/:id/run',
  requireAgentRunCapability,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { task, input } = req.body;

    const agent = await prisma.aIAgent.findUnique({
      where: { id },
    });

    if (!agent) {
      throw new AppError('Agent不存在', 404);
    }

    if (!agent.isActive) {
      throw new AppError('Agent未激活', 400);
    }

    const start = Date.now();
    let output = '';
    let status = 'SUCCESS';
    let error: string | undefined;

    try {
      switch (task) {
        case 'classify_email': {
          const { subject, body } = input || {};
          const result = await classifyRFQEmail(subject || '', body || '');
          output = JSON.stringify(result);
          break;
        }
        case 'quote_analysis': {
          const { rfqDetails, supplierQuotes } = input || {};
          output = await generateQuoteAnalysis(rfqDetails || '', supplierQuotes || '');
          break;
        }
        case 'chat': {
          const { message, systemPrompt } = input || {};
          const result = await generateCompletion(
            [
              { role: 'system', content: systemPrompt || '你是AeroLink航材交易平台的AI助手。' },
              { role: 'user', content: message || '' },
            ],
            { temperature: 0.7 }
          );
          output = result.content;
          break;
        }
        default: {
          const result = await generateCompletion(
            [
              { role: 'system', content: '你是AeroLink航材交易平台的AI助手。' },
              { role: 'user', content: input?.message || JSON.stringify(input) || 'Hello' },
            ],
            { temperature: 0.7 }
          );
          output = result.content;
        }
      }
    } catch (err) {
      status = 'ERROR';
      error = err instanceof Error ? err.message : '未知错误';
      output = error;
      logger.error({ err, agentId: id, task }, 'Agent task execution failed');
    }

    const duration = Date.now() - start;
    await logAgentAction(id, task || 'unknown', JSON.stringify(input), output, status, error, duration);

    await emitWebhookEvent(status === 'SUCCESS' ? 'agent.task.completed' : 'agent.task.failed', {
      agentId: id,
      task: task || 'unknown',
      status,
      durationMs: duration,
      error: error || null,
      completedAt: new Date().toISOString(),
    });

    res.json({
      success: status === 'SUCCESS',
      data: {
        output,
        duration: `${duration}ms`,
        status,
      },
    });
  })
);

router.get(
  '/:id/logs',
  requireAgentManagementRole,
  asyncHandler(async (req, res) => {
    const logs = await prisma.agentLog.findMany({
      where: { agentId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      success: true,
      data: logs,
    });
  })
);

export default router;
