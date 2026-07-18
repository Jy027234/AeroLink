import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { agentCreateSchema, agentRuntimeTaskSyncSchema, agentUpdateSchema } from '../lib/validation.js';
import { classifyRFQEmail, generateQuoteAnalysis, generateCompletion, logAgentAction } from '../lib/aiService.js';
import { logger } from '../lib/logger.js';
import { emitWebhookEvent } from '../lib/webhookService.js';
import { assertProductFeatureEnabled } from '../lib/productFeatures.js';
import prisma from '../lib/prisma.js';

const router = Router();
const requireAgentManagementRole = requireCapability('agent', 'manage');
const requireAgentRunCapability = requireCapability('agent', 'run');

type RuntimePrismaClient = Prisma.TransactionClient | typeof prisma;

function parseRuntimeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function buildRuntimeStepRecordId(taskId: string, stepId: string): string {
  return `${taskId}::${stepId}`;
}

function extractRuntimeStepId(recordId: string): string {
  const separatorIndex = recordId.indexOf('::');
  return separatorIndex >= 0 ? recordId.slice(separatorIndex + 2) : recordId;
}

function buildRuntimeConfirmationRecordId(taskId: string, confirmationId: string): string {
  return `${taskId}::${confirmationId}`;
}

function extractRuntimeConfirmationId(recordId: string): string {
  const separatorIndex = recordId.indexOf('::');
  return separatorIndex >= 0 ? recordId.slice(separatorIndex + 2) : recordId;
}

function stringifyRuntimeJson(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;

  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function toDate(value?: string | null): Date | undefined {
  return value ? new Date(value) : undefined;
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

type RuntimeConfirmationAuditRecord = {
  confirmationId?: string;
  taskId?: string;
  stepId?: string;
  type?: string;
  optionId?: string;
  action?: string;
  optionLabel?: string;
  optionLabelZh?: string;
  optionLabelEn?: string;
  confirmedAt?: string;
  confirmedBy?: string;
  note?: string;
  reasonCode?: string;
  reasonLabel?: string;
  reasonLabelZh?: string;
  reasonLabelEn?: string;
};

function getLatestRuntimeConfirmationAudit(context: unknown): RuntimeConfirmationAuditRecord | undefined {
  if (!context || typeof context !== 'object') {
    return undefined;
  }

  const latestConfirmation = (context as Record<string, unknown>).latestConfirmation;
  if (!latestConfirmation || typeof latestConfirmation !== 'object') {
    return undefined;
  }

  const audit = latestConfirmation as RuntimeConfirmationAuditRecord;
  if (!audit.confirmationId || !audit.confirmedAt) {
    return undefined;
  }

  return audit;
}

function isSameRuntimeConfirmationAudit(
  previousAudit?: RuntimeConfirmationAuditRecord,
  nextAudit?: RuntimeConfirmationAuditRecord
): boolean {
  if (!previousAudit || !nextAudit) {
    return false;
  }

  return (
    previousAudit.confirmationId === nextAudit.confirmationId &&
    previousAudit.optionId === nextAudit.optionId &&
    previousAudit.confirmedAt === nextAudit.confirmedAt
  );
}

function mapRuntimeTask(task: AgentRuntimeTaskRecord) {
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
    steps: task.steps.map((step) => ({
      id: extractRuntimeStepId(step.id),
      capability: step.capability,
      action: step.action,
      params: parseRuntimeJson(step.params, {}),
      status: step.status,
      result: step.result ? parseRuntimeJson(step.result, {}) : undefined,
      error: step.error || undefined,
      startedAt: step.startedAt?.toISOString(),
      completedAt: step.completedAt?.toISOString(),
    })),
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
    context: parseRuntimeJson(task.context, {}),
    result: task.result ? parseRuntimeJson(task.result, {}) : undefined,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString(),
    error: task.error || undefined,
  };
}

router.get(
  '/runtime/tasks',
  asyncHandler(async (req, res) => {
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

    res.json({
      success: true,
      data: tasks.map(mapRuntimeTask),
    });
  })
);

router.get(
  '/runtime/tasks/:id',
  asyncHandler(async (req, res) => {
    const task = await getRuntimeTaskById(prisma, req.params.id);

    if (!task) {
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
  asyncHandler(async (_req, res) => {
    const recentTasks = await prisma.agentRuntimeTask.findMany({
      include: {
        steps: {
          orderBy: { sequence: 'asc' },
        },
        confirmation: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    const recentTaskPayload = recentTasks.map(mapRuntimeTask);

    res.json({
      success: true,
      data: {
        tasks: {
          total: await prisma.agentRuntimeTask.count(),
          running: await prisma.agentRuntimeTask.count({ where: { status: 'running' } }),
          pending: await prisma.agentRuntimeTask.count({ where: { status: 'pending' } }),
          waitingConfirmation: await prisma.agentRuntimeTask.count({ where: { status: 'waiting_confirmation' } }),
          completedToday: await prisma.agentRuntimeTask.count({
            where: {
              status: 'completed',
              completedAt: {
                gte: new Date(new Date().setHours(0, 0, 0, 0)),
              },
            },
          }),
          failedToday: await prisma.agentRuntimeTask.count({
            where: {
              status: 'failed',
              updatedAt: {
                gte: new Date(new Date().setHours(0, 0, 0, 0)),
              },
            },
          }),
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
  validateBody(agentRuntimeTaskSyncSchema),
  asyncHandler(async (req, res) => {
    const payload = req.body;

    if (req.params.id !== payload.id) {
      throw new AppError('路径任务ID与请求体任务ID不一致', 400);
    }

    if (payload.context?.demoMode === true) {
      assertProductFeatureEnabled('agentDemo');
    }

    const task = await prisma.$transaction(async (tx) => {
      const existingTask = await getRuntimeTaskById(tx, payload.id);
      const previousContext = existingTask ? parseRuntimeJson<Record<string, unknown>>(existingTask.context, {}) : {};
      const previousLatestConfirmation = getLatestRuntimeConfirmationAudit(previousContext);
      const nextLatestConfirmation = getLatestRuntimeConfirmationAudit(payload.context);

      await tx.agentRuntimeTask.upsert({
        where: { id: payload.id },
        update: {
          triggerType: payload.trigger.type,
          triggerSource: payload.trigger.source,
          triggerReferenceId: payload.trigger.referenceId,
          type: payload.type,
          status: payload.status,
          currentStepIndex: payload.currentStepIndex,
          context: stringifyRuntimeJson(payload.context, '{}'),
          result: payload.result ? stringifyRuntimeJson(payload.result, '{}') : null,
          error: payload.error,
          createdAt: new Date(payload.createdAt),
          updatedAt: new Date(payload.updatedAt),
          completedAt: toDate(payload.completedAt) || null,
        },
        create: {
          id: payload.id,
          triggerType: payload.trigger.type,
          triggerSource: payload.trigger.source,
          triggerReferenceId: payload.trigger.referenceId,
          type: payload.type,
          status: payload.status,
          currentStepIndex: payload.currentStepIndex,
          context: stringifyRuntimeJson(payload.context, '{}'),
          result: payload.result ? stringifyRuntimeJson(payload.result, '{}') : null,
          error: payload.error,
          createdAt: new Date(payload.createdAt),
          updatedAt: new Date(payload.updatedAt),
          completedAt: toDate(payload.completedAt) || null,
        },
      });

      await tx.agentRuntimeStep.deleteMany({ where: { taskId: payload.id } });

      if (payload.steps.length > 0) {
        await tx.agentRuntimeStep.createMany({
          data: payload.steps.map((step: typeof payload.steps[number], index: number) => ({
            id: buildRuntimeStepRecordId(payload.id, step.id),
            taskId: payload.id,
            sequence: index,
            capability: step.capability,
            action: step.action,
            params: stringifyRuntimeJson(step.params, '{}'),
            status: step.status,
            result: step.result ? stringifyRuntimeJson(step.result, '{}') : null,
            error: step.error,
            startedAt: toDate(step.startedAt) || null,
            completedAt: toDate(step.completedAt) || null,
          })),
        });
      }

      if (payload.confirmationNode) {
        await tx.agentRuntimeConfirmation.upsert({
          where: { taskId: payload.id },
          update: {
            id: buildRuntimeConfirmationRecordId(payload.id, payload.confirmationNode.id),
            stepId: payload.confirmationNode.stepId,
            type: payload.confirmationNode.type,
            title: payload.confirmationNode.title,
            titleZh: payload.confirmationNode.titleZh,
            titleEn: payload.confirmationNode.titleEn,
            description: payload.confirmationNode.description,
            descriptionZh: payload.confirmationNode.descriptionZh,
            descriptionEn: payload.confirmationNode.descriptionEn,
            data: stringifyRuntimeJson(payload.confirmationNode.data, '{}'),
            options: stringifyRuntimeJson(payload.confirmationNode.options, '[]'),
            selectedOption: payload.confirmationNode.selectedOption,
            confirmedAt: toDate(payload.confirmationNode.confirmedAt) || null,
            confirmedBy: payload.confirmationNode.confirmedBy,
          },
          create: {
            id: buildRuntimeConfirmationRecordId(payload.id, payload.confirmationNode.id),
            taskId: payload.id,
            stepId: payload.confirmationNode.stepId,
            type: payload.confirmationNode.type,
            title: payload.confirmationNode.title,
            titleZh: payload.confirmationNode.titleZh,
            titleEn: payload.confirmationNode.titleEn,
            description: payload.confirmationNode.description,
            descriptionZh: payload.confirmationNode.descriptionZh,
            descriptionEn: payload.confirmationNode.descriptionEn,
            data: stringifyRuntimeJson(payload.confirmationNode.data, '{}'),
            options: stringifyRuntimeJson(payload.confirmationNode.options, '[]'),
            selectedOption: payload.confirmationNode.selectedOption,
            confirmedAt: toDate(payload.confirmationNode.confirmedAt) || null,
            confirmedBy: payload.confirmationNode.confirmedBy,
          },
        });
      } else {
        await tx.agentRuntimeConfirmation.deleteMany({ where: { taskId: payload.id } });
      }

      if (nextLatestConfirmation && !isSameRuntimeConfirmationAudit(previousLatestConfirmation, nextLatestConfirmation)) {
        await tx.agentLog.create({
          data: {
            agentId: payload.id,
            action: 'CONFIRMATION_RECORDED',
            input: stringifyRuntimeJson(
              {
                taskId: payload.id,
                taskType: payload.type,
                confirmationId: nextLatestConfirmation.confirmationId,
                stepId: nextLatestConfirmation.stepId,
                type: nextLatestConfirmation.type,
                optionId: nextLatestConfirmation.optionId,
                action: nextLatestConfirmation.action,
                confirmedAt: nextLatestConfirmation.confirmedAt,
                confirmedBy: nextLatestConfirmation.confirmedBy,
                note: nextLatestConfirmation.note,
                reasonCode: nextLatestConfirmation.reasonCode,
              },
              '{}'
            ),
            output: stringifyRuntimeJson(
              {
                optionLabel: nextLatestConfirmation.optionLabel,
                optionLabelZh: nextLatestConfirmation.optionLabelZh,
                optionLabelEn: nextLatestConfirmation.optionLabelEn,
                reasonLabel: nextLatestConfirmation.reasonLabel,
                reasonLabelZh: nextLatestConfirmation.reasonLabelZh,
                reasonLabelEn: nextLatestConfirmation.reasonLabelEn,
                taskStatus: payload.status,
              },
              '{}'
            ),
            status: 'SUCCESS',
          },
        });
      }

      return getRuntimeTaskById(tx, payload.id);
    });

    if (!task) {
      throw new AppError('运行时任务同步失败', 500);
    }

    res.json({
      success: true,
      data: mapRuntimeTask(task),
    });
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
