import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthRequest } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { normalizeRole } from '../lib/capabilityPolicy.js';
import prisma from '../lib/prisma.js';
import { executeAgent } from '../lib/aiAgentExecution.js';
import {
  AgentDraftValidationError,
  agentConfigValidationSchema,
  agentPromptsSchema,
  getBuiltinAgent,
  parseAgentJson,
  validateAgentDraft,
} from '../lib/aiAgentRegistry.js';

const router = Router();
const requireAgentManagementRole = requireCapability('agent', 'manage');
const requireAgentRunCapability = requireCapability('agent', 'run');
const requireAgentReadCapability = requireCapability('agent', 'read');

const agentCreateRequestSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空'),
  type: z.string().trim().min(1, '类型不能为空'),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  config: agentConfigValidationSchema.optional().default({}),
  prompts: agentPromptsSchema.optional().default([]),
}).strict();

const agentPatchRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative('expectedRevision 必须为非负整数'),
  name: z.string().trim().min(1, '名称不能为空').optional(),
  type: z.string().trim().min(1, '类型不能为空').optional(),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  config: agentConfigValidationSchema.optional(),
  prompts: agentPromptsSchema.optional(),
  builtinKey: z.string().nullable().optional(),
}).strict();

const expectedRevisionSchema = z.object({
  expectedRevision: z.number().int().nonnegative('expectedRevision 必须为非负整数'),
}).strict();

const restoreRequestSchema = expectedRevisionSchema.extend({
  version: z.number().int().positive('version 必须为正整数'),
}).strict();

const testRequestSchema = z.object({
  input: z.record(z.unknown()),
}).strict();

const agentRunRequestSchema = z.object({
  task: z.string().max(100, 'task 不能超过100个字符').optional(),
  input: z.record(z.unknown()),
}).strict();

type AgentResponseRecord = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  isActive: boolean;
  config: string;
  prompts: string;
  builtinKey: string | null;
  draftRevision: number;
  publishedVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRegistryValidationError(error: unknown): never {
  if (error instanceof AgentDraftValidationError) {
    throw new AppError('智能体草稿校验失败', 400, 'VALIDATION_ERROR', error.details);
  }
  throw error;
}

function mapAgent(agent: AgentResponseRecord) {
  const workflowDefinition = agent.builtinKey ? getBuiltinAgent(agent.builtinKey) : undefined;
  return {
    ...agent,
    config: parseAgentJson(agent.config, {} as Record<string, unknown>),
    prompts: parseAgentJson(agent.prompts, [] as Array<{ role: string; content: string }>),
    workflow: workflowDefinition
      ? {
          label: workflowDefinition.name,
          description: workflowDefinition.description,
          variables: workflowDefinition.variables,
          inputExample: workflowDefinition.inputExample,
        }
      : null,
  };
}

function getAuthenticatedAgentUser(req: AuthRequest) {
  if (!req.user) throw new AppError('未授权，请先登录', 401, 'AUTH_UNAUTHORIZED');
  return req.user;
}

function assertDraftRevision(agent: AgentResponseRecord, expectedRevision: number) {
  if (agent.draftRevision !== expectedRevision) {
    throw new AppError(
      '智能体草稿已被其他用户修改，请刷新后重试',
      409,
      'RESOURCE_CONFLICT',
      { expectedRevision: [`当前版本为 ${agent.draftRevision}`] },
    );
  }
}

function assertBuiltinType(agent: AgentResponseRecord, type: string | undefined) {
  if (agent.builtinKey && type !== undefined && type !== agent.type) {
    throw new AppError('内置智能体类型不可修改', 400, 'BAD_REQUEST');
  }
}

function rejectSystemPromptOverride(input: Record<string, unknown>) {
  if (Object.prototype.hasOwnProperty.call(input, 'systemPrompt')) {
    throw new AppError('运行请求不能通过 input.systemPrompt 覆盖已发布提示词', 400, 'BAD_REQUEST');
  }
}

const builtinTaskAliases: Record<string, string[]> = {
  rfq_extraction: ['classify_email', 'rfq_extraction'],
  quote_analysis: ['quote_analysis'],
  customer_email: ['customer_email', 'generate_customer_email'],
  business_chat: ['chat', 'business_chat'],
};

function assertBuiltinTask(agent: AgentResponseRecord, task: string | undefined) {
  if (!agent.builtinKey) return;
  const allowedTasks = builtinTaskAliases[agent.builtinKey] || [];
  if (!task || !allowedTasks.includes(task)) {
    throw new AppError(`内置智能体不支持任务：${task || '未提供'}`, 400, 'BAD_REQUEST');
  }
}

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
  requireAgentReadCapability,
  asyncHandler(async (_req, res) => {
    const agents = await prisma.aIAgent.findMany({
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: agents.map((agent) => mapAgent(agent as AgentResponseRecord)),
    });
  })
);

router.get(
  '/:id',
  requireAgentReadCapability,
  asyncHandler(async (req, res) => {
    const agent = await prisma.aIAgent.findUnique({
      where: { id: req.params.id },
    });

    if (!agent) {
      throw new AppError('Agent不存在', 404);
    }

    res.json({
      success: true,
      data: mapAgent(agent as AgentResponseRecord),
    });
  })
);

router.post(
  '/',
  requireAgentManagementRole,
  validateBody(agentCreateRequestSchema),
  asyncHandler(async (req, res) => {
    const { name, type, description, isActive, config, prompts } = req.body;
    let draft: ReturnType<typeof validateAgentDraft>;
    try {
      draft = validateAgentDraft(prompts, config);
    } catch (error) {
      toRegistryValidationError(error);
    }

    const agent = await prisma.aIAgent.create({
      data: {
        name,
        type,
        description,
        isActive: isActive ?? true,
        config: JSON.stringify(draft.config),
        prompts: JSON.stringify(draft.prompts),
        draftRevision: 0,
        publishedVersion: null,
      },
    });

    res.status(201).json({
      success: true,
      data: mapAgent(agent as AgentResponseRecord),
    });
  })
);

router.patch(
  '/:id',
  requireAgentManagementRole,
  validateBody(agentPatchRequestSchema),
  asyncHandler(async (req, res) => {
    const { expectedRevision, name, type, description, isActive, config, prompts, builtinKey } = req.body;
    const current = await prisma.aIAgent.findUnique({ where: { id: req.params.id } });
    if (!current) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');
    const agent = current as AgentResponseRecord;
    assertDraftRevision(agent, expectedRevision);
    assertBuiltinType(agent, type);
    if (builtinKey !== undefined && builtinKey !== agent.builtinKey) {
      throw new AppError('内置标识不可修改', 400, 'BAD_REQUEST');
    }

    const nextPrompts = prompts ?? parseAgentJson(agent.prompts, []);
    const nextConfig = config ?? parseAgentJson(agent.config, {});
    let draft: ReturnType<typeof validateAgentDraft>;
    try {
      draft = validateAgentDraft(nextPrompts, nextConfig, agent.builtinKey);
    } catch (error) {
      toRegistryValidationError(error);
    }

    const updatedCount = await prisma.aIAgent.updateMany({
      where: { id: req.params.id, draftRevision: expectedRevision },
      data: {
        ...(name !== undefined && { name }),
        ...(type !== undefined && { type }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
        config: JSON.stringify(draft.config),
        prompts: JSON.stringify(draft.prompts),
        draftRevision: { increment: 1 },
      },
    });
    if (updatedCount.count !== 1) {
      throw new AppError('智能体草稿已被其他用户修改，请刷新后重试', 409, 'RESOURCE_CONFLICT');
    }
    const updated = await prisma.aIAgent.findUnique({ where: { id: req.params.id } });
    if (!updated) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');

    res.json({
      success: true,
      data: mapAgent(updated as AgentResponseRecord),
    });
  })
);

router.delete(
  '/:id',
  requireAgentManagementRole,
  asyncHandler(async (req, res) => {
    const agent = await prisma.aIAgent.findUnique({ where: { id: req.params.id } });
    if (!agent) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');
    if (agent.builtinKey) {
      throw new AppError('内置智能体不可删除，请停用或修改草稿', 400, 'BAD_REQUEST');
    }
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
  validateBody(expectedRevisionSchema),
  asyncHandler(async (req, res) => {
    const agent = await prisma.aIAgent.findUnique({
      where: { id: req.params.id },
    });

    if (!agent) {
      throw new AppError('Agent不存在', 404);
    }

    assertDraftRevision(agent as AgentResponseRecord, req.body.expectedRevision);
    const updatedCount = await prisma.aIAgent.updateMany({
      where: { id: req.params.id, draftRevision: req.body.expectedRevision },
      data: {
        isActive: !agent.isActive,
        draftRevision: { increment: 1 },
      },
    });
    if (updatedCount.count !== 1) {
      throw new AppError('智能体草稿已被其他用户修改，请刷新后重试', 409, 'RESOURCE_CONFLICT');
    }
    const updated = await prisma.aIAgent.findUnique({ where: { id: req.params.id } });
    if (!updated) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');

    res.json({
      success: true,
      data: mapAgent(updated as AgentResponseRecord),
    });
  })
);

router.get(
  '/:id/versions',
  requireAgentReadCapability,
  asyncHandler(async (req, res) => {
    const agent = await prisma.aIAgent.findUnique({ where: { id: req.params.id } });
    if (!agent) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');

    const versions = await prisma.aIAgentVersion.findMany({
      where: { agentId: req.params.id },
      orderBy: { version: 'asc' },
    });
    res.json({
      success: true,
      data: versions.map((version) => ({
        version: version.version,
        prompts: parseAgentJson(version.prompts, []),
        config: parseAgentJson(version.config, {}),
        createdBy: version.createdBy,
        createdAt: version.createdAt,
      })),
    });
  })
);

router.post(
  '/:id/publish',
  requireAgentManagementRole,
  validateBody(expectedRevisionSchema),
  asyncHandler(async (req, res) => {
    const actor = getAuthenticatedAgentUser(req as AuthRequest);
    const { expectedRevision } = req.body;
    const current = await prisma.aIAgent.findUnique({ where: { id: req.params.id } });
    if (!current) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');
    assertDraftRevision(current as AgentResponseRecord, expectedRevision);

    try {
      validateAgentDraft(
        parseAgentJson(current.prompts, []),
        parseAgentJson(current.config, {}),
        current.builtinKey,
      );
    } catch (error) {
      toRegistryValidationError(error);
    }

    const published = await prisma.$transaction(async (tx) => {
      const latest = await tx.aIAgent.findUnique({ where: { id: req.params.id } });
      if (!latest) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');
      assertDraftRevision(latest as AgentResponseRecord, expectedRevision);
      const latestVersion = await tx.aIAgentVersion.findMany({
        where: { agentId: req.params.id },
        orderBy: { version: 'desc' },
        take: 1,
      });
      const nextVersion = Math.max(
        latest.publishedVersion ?? 0,
        latestVersion[0]?.version ?? 0,
      ) + 1;
      const updatedCount = await tx.aIAgent.updateMany({
        where: {
          id: req.params.id,
          draftRevision: expectedRevision,
          publishedVersion: latest.publishedVersion,
        },
        data: {
          publishedVersion: nextVersion,
          draftRevision: { increment: 1 },
        },
      });
      if (updatedCount.count !== 1) {
        throw new AppError('智能体草稿已被其他用户修改，请刷新后重试', 409, 'RESOURCE_CONFLICT');
      }
      await tx.aIAgentVersion.create({
        data: {
          agentId: req.params.id,
          version: nextVersion,
          prompts: latest.prompts,
          config: latest.config,
          createdBy: actor.id,
        },
      });
      const updated = await tx.aIAgent.findUnique({ where: { id: req.params.id } });
      if (!updated) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');
      return updated;
    });

    res.json({ success: true, data: mapAgent(published as AgentResponseRecord) });
  })
);

router.post(
  '/:id/restore',
  requireAgentManagementRole,
  validateBody(restoreRequestSchema),
  asyncHandler(async (req, res) => {
    const { version, expectedRevision } = req.body;
    const current = await prisma.aIAgent.findUnique({ where: { id: req.params.id } });
    if (!current) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');
    const agent = current as AgentResponseRecord;
    assertDraftRevision(agent, expectedRevision);

    const source = await prisma.aIAgentVersion.findUnique({
      where: { agentId_version: { agentId: req.params.id, version } },
    });
    if (!source) throw new AppError('提示词版本不存在', 404, 'RESOURCE_NOT_FOUND');
    try {
      validateAgentDraft(
        parseAgentJson(source.prompts, []),
        parseAgentJson(source.config, {}),
        agent.builtinKey,
      );
    } catch (error) {
      toRegistryValidationError(error);
    }

    const updatedCount = await prisma.aIAgent.updateMany({
      where: { id: req.params.id, draftRevision: expectedRevision },
      data: {
        prompts: source.prompts,
        config: source.config,
        draftRevision: { increment: 1 },
      },
    });
    if (updatedCount.count !== 1) {
      throw new AppError('智能体草稿已被其他用户修改，请刷新后重试', 409, 'RESOURCE_CONFLICT');
    }
    const updated = await prisma.aIAgent.findUnique({ where: { id: req.params.id } });
    if (!updated) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');
    res.json({ success: true, data: mapAgent(updated as AgentResponseRecord) });
  })
);

router.post(
  '/:id/test',
  requireAgentManagementRole,
  requireAgentRunCapability,
  validateBody(testRequestSchema),
  asyncHandler(async (req, res) => {
    const actor = getAuthenticatedAgentUser(req as AuthRequest);
    const { input } = req.body as { input: Record<string, unknown> };
    rejectSystemPromptOverride(input);
    const result = await executeAgent(req.params.id, input, { actorId: actor.id, action: 'test' });
    res.json({ success: true, data: result });
  })
);

router.post(
  '/:id/run',
  requireAgentRunCapability,
  validateBody(agentRunRequestSchema),
  asyncHandler(async (req, res) => {
    const actor = getAuthenticatedAgentUser(req as AuthRequest);
    const { id } = req.params;
    const { task, input } = req.body as { task?: string; input: Record<string, unknown> };
    const agent = await prisma.aIAgent.findUnique({ where: { id } });
    if (!agent) throw new AppError('Agent不存在', 404, 'RESOURCE_NOT_FOUND');
    rejectSystemPromptOverride(input as Record<string, unknown>);
    assertBuiltinTask(agent as AgentResponseRecord, task);
    const result = await executeAgent(id, input as Record<string, unknown>, {
      actorId: actor.id,
      action: task ? `run:${task}` : 'run',
    });
    res.json({
      success: true,
      data: {
        ...result,
        duration: `${result.latency}ms`,
        status: 'SUCCESS',
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
