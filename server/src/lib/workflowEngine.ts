import prisma from './prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from './logger.js';

export type WorkflowActionType = 'APPROVE' | 'REJECT' | 'TRANSFER' | 'COMMENT' | 'ESCALATE' | 'AUTO_ACTION';

function generateWorkflowNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `WF-${year}-${random}`;
}

export async function startWorkflow(
  definitionId: string,
  entityType: string,
  entityId: string,
  startedBy: string,
  context: Record<string, unknown> = {}
) {
  const definition = await prisma.workflowDefinition.findUnique({
    where: { id: definitionId, isActive: true },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });

  if (!definition) {
    throw new AppError('工作流定义不存在或已禁用', 404, 'RESOURCE_NOT_FOUND');
  }

  if (definition.entityType !== entityType) {
    throw new AppError('工作流定义与实体类型不匹配', 400, 'BAD_REQUEST');
  }

  // Check if there's already a running instance for this entity
  const existingRunning = await prisma.workflowInstance.findFirst({
    where: {
      entityType,
      entityId,
      status: { in: ['RUNNING'] },
    },
  });

  if (existingRunning) {
    throw new AppError('该实体已存在运行中的工作流实例', 409, 'RESOURCE_CONFLICT');
  }

  const instanceNumber = generateWorkflowNumber();
  const enrichedContext = { ...context, instanceNumber };

  const instance = await prisma.workflowInstance.create({
    data: {
      definitionId,
      entityType,
      entityId,
      status: 'RUNNING',
      startedBy,
      context: JSON.stringify(enrichedContext),
    },
  });

  // Create instance steps from definition steps
  const now = new Date();
  for (const step of definition.steps) {
    const dueAt = new Date(now.getTime() + step.timeoutHours * 60 * 60 * 1000);
    await prisma.workflowInstanceStep.create({
      data: {
        instanceId: instance.id,
        stepId: step.id,
        stepOrder: step.stepOrder,
        status: step.stepOrder === 1 ? 'IN_PROGRESS' : 'PENDING',
        assignedTo: step.approverUserId || null,
        assignedRole: step.approverRole || null,
        startedAt: step.stepOrder === 1 ? now : null,
        dueAt: step.stepOrder === 1 ? dueAt : null,
      },
    });
  }

  // Set current step to first step
  const firstStep = definition.steps[0];
  if (firstStep) {
    await prisma.workflowInstance.update({
      where: { id: instance.id },
      data: { currentStepId: firstStep.id },
    });
  }

  // Record start action
  await prisma.workflowAction.create({
    data: {
      instanceId: instance.id,
      actionType: 'AUTO_ACTION',
      actorId: startedBy,
      comment: `工作流已启动: ${definition.name}`,
      payload: JSON.stringify({ instanceNumber }),
    },
  });

  logger.info({ instanceId: instance.id, definitionId, entityType, entityId }, 'Workflow started');

  return prisma.workflowInstance.findUnique({
    where: { id: instance.id },
    include: {
      definition: true,
      steps: { orderBy: { stepOrder: 'asc' }, include: { step: true } },
      actions: { orderBy: { createdAt: 'desc' } },
    },
  });
}

export async function processStep(
  instanceId: string,
  action: WorkflowActionType,
  actorId: string,
  comment?: string,
  payload: Record<string, unknown> = {}
) {
  const instance = await prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    include: {
      definition: { include: { steps: { orderBy: { stepOrder: 'asc' } } } },
      steps: { orderBy: { stepOrder: 'asc' }, include: { step: true } },
    },
  });

  if (!instance) {
    throw new AppError('工作流实例不存在', 404, 'RESOURCE_NOT_FOUND');
  }

  if (instance.status !== 'RUNNING') {
    throw new AppError(`工作流已${getStatusLabel(instance.status)}，无法执行操作`, 400, 'BAD_REQUEST');
  }

  const currentInstanceStep = instance.steps.find((s) => s.status === 'IN_PROGRESS');
  if (!currentInstanceStep) {
    throw new AppError('当前没有正在进行的步骤', 400, 'BAD_REQUEST');
  }

  // Authorization check: actor must be assigned user or have assigned role
  const actor = await prisma.user.findUnique({ where: { id: actorId } });
  const canAct =
    currentInstanceStep.assignedTo === actorId ||
    (currentInstanceStep.assignedRole && actor?.role?.toLowerCase() === currentInstanceStep.assignedRole.toLowerCase()) ||
    action === 'COMMENT';

  if (!canAct) {
    throw new AppError('您没有权限处理此步骤', 403, 'AUTH_FORBIDDEN');
  }

  const now = new Date();

  if (action === 'APPROVE') {
    await prisma.workflowInstanceStep.update({
      where: { id: currentInstanceStep.id },
      data: {
        status: 'APPROVED',
        completedAt: now,
        result: comment || '已批准',
      },
    });

    await prisma.workflowAction.create({
      data: {
        instanceId: instance.id,
        instanceStepId: currentInstanceStep.id,
        actionType: 'APPROVE',
        actorId,
        actorRole: actor?.role || null,
        actorName: actor?.name || null,
        comment: comment || '批准',
        payload: JSON.stringify(payload),
      },
    });

    const nextStep = getNextStep(instance, currentInstanceStep);
    if (nextStep) {
      const nextDefStep = instance.definition.steps.find((s: { id: string; timeoutHours?: number | null }) => s.id === nextStep.stepId);
      const timeoutHours = nextDefStep?.timeoutHours || 24;
      await prisma.workflowInstanceStep.update({
        where: { id: nextStep.id },
        data: {
          status: 'IN_PROGRESS',
          startedAt: now,
          dueAt: new Date(now.getTime() + timeoutHours * 60 * 60 * 1000),
        },
      });

      await prisma.workflowInstance.update({
        where: { id: instance.id },
        data: { currentStepId: nextStep.stepId },
      });
    } else {
      // Complete workflow
      await prisma.workflowInstance.update({
        where: { id: instance.id },
        data: { status: 'COMPLETED', completedAt: now, currentStepId: null },
      });
    }
  } else if (action === 'REJECT') {
    await prisma.workflowInstanceStep.update({
      where: { id: currentInstanceStep.id },
      data: {
        status: 'REJECTED',
        completedAt: now,
        result: comment || '已驳回',
      },
    });

    await prisma.workflowAction.create({
      data: {
        instanceId: instance.id,
        instanceStepId: currentInstanceStep.id,
        actionType: 'REJECT',
        actorId,
        actorRole: actor?.role || null,
        actorName: actor?.name || null,
        comment: comment || '驳回',
        payload: JSON.stringify(payload),
      },
    });

    await prisma.workflowInstance.update({
      where: { id: instance.id },
      data: { status: 'REJECTED', completedAt: now, currentStepId: null },
    });
  } else if (action === 'TRANSFER') {
    const targetUserId = payload.targetUserId as string | undefined;
    const targetRole = payload.targetRole as string | undefined;
    if (!targetUserId && !targetRole) {
      throw new AppError('转交目标用户或角色不能为空', 400, 'BAD_REQUEST');
    }

    await prisma.workflowInstanceStep.update({
      where: { id: currentInstanceStep.id },
      data: {
        assignedTo: targetUserId || null,
        assignedRole: targetRole || null,
      },
    });

    await prisma.workflowAction.create({
      data: {
        instanceId: instance.id,
        instanceStepId: currentInstanceStep.id,
        actionType: 'TRANSFER',
        actorId,
        actorRole: actor?.role || null,
        actorName: actor?.name || null,
        comment: comment || `转交给 ${targetUserId || targetRole}`,
        payload: JSON.stringify(payload),
      },
    });
  } else if (action === 'COMMENT') {
    await prisma.workflowAction.create({
      data: {
        instanceId: instance.id,
        instanceStepId: currentInstanceStep.id,
        actionType: 'COMMENT',
        actorId,
        actorRole: actor?.role || null,
        actorName: actor?.name || null,
        comment: comment || '',
        payload: JSON.stringify(payload),
      },
    });
  } else if (action === 'ESCALATE') {
    await escalateStep(currentInstanceStep, actorId, actor, comment);
  } else if (action === 'AUTO_ACTION') {
    await prisma.workflowAction.create({
      data: {
        instanceId: instance.id,
        instanceStepId: currentInstanceStep.id,
        actionType: 'AUTO_ACTION',
        actorId,
        actorRole: actor?.role || null,
        actorName: actor?.name || null,
        comment: comment || '自动执行',
        payload: JSON.stringify(payload),
      },
    });
  }

  logger.info({ instanceId, action, actorId, stepId: currentInstanceStep.id }, 'Workflow step processed');

  return prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    include: {
      definition: true,
      steps: { orderBy: { stepOrder: 'asc' }, include: { step: true } },
      actions: { orderBy: { createdAt: 'desc' } },
    },
  });
}

export function getNextStep(
  instance: {
    steps: Array<{ stepOrder: number; status: string; id: string; stepId: string }>;
    definition: { steps: Array<{ id: string; stepOrder: number; conditionExpression?: string | null }> };
  },
  currentStep: { stepOrder: number; id: string; stepId: string }
) {
  const sortedDefinitionSteps = instance.definition.steps.sort((a, b) => a.stepOrder - b.stepOrder);
  const currentDefIndex = sortedDefinitionSteps.findIndex((s) => s.id === currentStep.stepId);
  const nextDefStep = sortedDefinitionSteps[currentDefIndex + 1];
  if (!nextDefStep) return null;

  const nextInstanceStep = instance.steps.find((s) => s.stepId === nextDefStep.id);
  return nextInstanceStep || null;
}

export async function checkTimeout(instanceId: string) {
  const instance = await prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    include: {
      steps: { orderBy: { stepOrder: 'asc' }, include: { step: true } },
      definition: { include: { steps: { orderBy: { stepOrder: 'asc' } } } },
    },
  });

  if (!instance || instance.status !== 'RUNNING') return null;

  const currentStep = instance.steps.find((s) => s.status === 'IN_PROGRESS');
  if (!currentStep || !currentStep.dueAt) return null;

  const now = new Date();
  if (new Date(currentStep.dueAt) > now) return null;

  // Timeout reached
  const timeoutAction = currentStep.step?.timeoutAction || 'ESCALATE';

  if (timeoutAction === 'ESCALATE') {
    await escalateStep(currentStep, 'system', null, '步骤超时，自动升级');
  } else if (timeoutAction === 'AUTO_APPROVE') {
    await processStep(instanceId, 'APPROVE', 'system', '步骤超时，自动批准', { auto: true });
  } else if (timeoutAction === 'AUTO_REJECT') {
    await processStep(instanceId, 'REJECT', 'system', '步骤超时，自动驳回', { auto: true });
  }

  logger.info({ instanceId, stepId: currentStep.id, timeoutAction }, 'Workflow step timeout handled');

  return prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    include: {
      definition: true,
      steps: { orderBy: { stepOrder: 'asc' }, include: { step: true } },
      actions: { orderBy: { createdAt: 'desc' } },
    },
  });
}

export async function escalateStep(
  instanceStep: {
    id: string;
    instanceId: string;
    assignedRole?: string | null;
    step?: { timeoutHours: number } | null;
  },
  actorId: string,
  actor: { role?: string | null; name?: string | null } | null,
  comment?: string
) {
  // Simple escalation: escalate to higher role or admin
  const roleHierarchy = ['sales', 'manager', 'finance', 'admin', 'gm'];
  const currentRole = instanceStep.assignedRole?.toLowerCase() || 'sales';
  const currentIndex = roleHierarchy.indexOf(currentRole);
  const nextRole = currentIndex >= 0 && currentIndex < roleHierarchy.length - 1
    ? roleHierarchy[currentIndex + 1]
    : 'admin';

  const dueAt = new Date(Date.now() + (instanceStep.step?.timeoutHours || 24) * 60 * 60 * 1000);

  await prisma.workflowInstanceStep.update({
    where: { id: instanceStep.id },
    data: {
      assignedRole: nextRole,
      assignedTo: null,
      dueAt,
    },
  });

  await prisma.workflowAction.create({
    data: {
      instanceId: instanceStep.instanceId,
      instanceStepId: instanceStep.id,
      actionType: 'ESCALATE',
      actorId,
      actorRole: actor?.role || null,
      actorName: actor?.name || null,
      comment: comment || `升级至 ${nextRole}`,
      payload: JSON.stringify({ fromRole: currentRole, toRole: nextRole }),
    },
  });

  logger.info({ instanceStepId: instanceStep.id, fromRole: currentRole, toRole: nextRole }, 'Workflow step escalated');
}

export async function autoAction(step: {
  id: string;
  instanceId: string;
  step?: { autoAction?: string | null } | null;
}) {
  if (!step.step?.autoAction) return;

  // Record auto action
  await prisma.workflowAction.create({
    data: {
      instanceId: step.instanceId,
      instanceStepId: step.id,
      actionType: 'AUTO_ACTION',
      actorId: 'system',
      comment: `自动执行: ${step.step.autoAction}`,
      payload: JSON.stringify({ autoAction: step.step.autoAction }),
    },
  });

  logger.info({ instanceStepId: step.id, autoAction: step.step.autoAction }, 'Workflow auto action executed');
}

function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    RUNNING: '进行中',
    COMPLETED: '已完成',
    REJECTED: '已驳回',
    CANCELLED: '已取消',
    TIMEOUT: '已超时',
  };
  return map[status] || status;
}

export async function cancelWorkflow(instanceId: string, actorId: string, reason?: string) {
  const instance = await prisma.workflowInstance.findUnique({
    where: { id: instanceId },
  });

  if (!instance) {
    throw new AppError('工作流实例不存在', 404, 'RESOURCE_NOT_FOUND');
  }

  if (instance.status !== 'RUNNING') {
    throw new AppError('只能取消运行中的工作流', 400, 'BAD_REQUEST');
  }

  const now = new Date();

  await prisma.workflowInstance.update({
    where: { id: instanceId },
    data: { status: 'CANCELLED', completedAt: now, currentStepId: null },
  });

  // Cancel all pending/in-progress steps
  await prisma.workflowInstanceStep.updateMany({
    where: {
      instanceId,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    data: { status: 'SKIPPED', completedAt: now, result: '工作流已取消' },
  });

  await prisma.workflowAction.create({
    data: {
      instanceId,
      actionType: 'AUTO_ACTION',
      actorId,
      comment: reason || '工作流已取消',
      payload: JSON.stringify({ cancelled: true }),
    },
  });

  logger.info({ instanceId, actorId, reason }, 'Workflow cancelled');

  return prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    include: {
      definition: true,
      steps: { orderBy: { stepOrder: 'asc' }, include: { step: true } },
      actions: { orderBy: { createdAt: 'desc' } },
    },
  });
}

export async function duplicateDefinition(definitionId: string, actorId: string) {
  const definition = await prisma.workflowDefinition.findUnique({
    where: { id: definitionId },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });

  if (!definition) {
    throw new AppError('工作流定义不存在', 404, 'RESOURCE_NOT_FOUND');
  }

  const newCode = `${definition.code}-copy-${Date.now()}`;
  const newName = `${definition.name} (复制)`;

  const newDefinition = await prisma.workflowDefinition.create({
    data: {
      name: newName,
      code: newCode,
      description: definition.description,
      entityType: definition.entityType,
      isActive: false,
      isDefault: false,
      version: 1,
      steps: {
        create: definition.steps.map((step) => ({
          name: step.name,
          stepOrder: step.stepOrder,
          stepType: step.stepType,
          approverRole: step.approverRole,
          approverUserId: step.approverUserId,
          approverDepartment: step.approverDepartment,
          isParallel: step.isParallel,
          parallelMinCount: step.parallelMinCount,
          timeoutHours: step.timeoutHours,
          timeoutAction: step.timeoutAction,
          conditionExpression: step.conditionExpression,
          autoAction: step.autoAction,
          notificationTemplate: step.notificationTemplate,
        })),
      },
    },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });

  logger.info({ originalId: definitionId, newId: newDefinition.id, actorId }, 'Workflow definition duplicated');

  return newDefinition;
}
