import type {
  AgentTask,
  AgentData,
  QuoteCandidate,
  TaskStep,
  TaskType,
  CapabilityName,
  CapabilityResult,
  ConfirmationNode,
  ConfirmationOption,
  ConfirmationAuditEntry,
  AgentDashboard,
} from '@/types/agent';
import type { Customer, Supplier, SupplierFollowUpLog, SupplierFollowUpOutcome } from '@/types';
import { agentRuntimeApi, customerApi, rfqApi, supplierApi, supplierQuoteApi, aiApi } from '@/api/client';
import {
  buildInquiryDispatchSummary,
  selectSuppliersForSourcing,
  type SupplierCapabilityProfile,
} from '@/lib/supplierCapability';
import { useAuthStore, useRFQStore, useSupplierFollowUpStore } from '@/store';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function createConfirmationOption(
  id: string,
  labelZh: string,
  labelEn: string,
  action: string,
  data?: AgentData,
  descriptionZh?: string,
  descriptionEn?: string
): ConfirmationOption {
  return {
    id,
    label: labelZh,
    labelZh,
    labelEn,
    description: descriptionZh,
    descriptionZh,
    descriptionEn,
    action,
    data,
  };
}

function getConfirmationActor(): string | undefined {
  const user = useAuthStore.getState().user;
  if (!user) return undefined;
  if (user.name && user.email) {
    return `${user.name} <${user.email}>`;
  }
  return user.name || user.email;
}

function getConfirmationHistory(context: AgentData): ConfirmationAuditEntry[] {
  return Array.isArray(context.confirmationHistory)
    ? (context.confirmationHistory as ConfirmationAuditEntry[])
    : [];
}

function normalizeOptionalText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

type ConfirmationAuditMetadata = {
  note?: string;
  reasonCode?: string;
  reasonLabel?: string;
  reasonLabelZh?: string;
  reasonLabelEn?: string;
};

function buildConfirmationAuditEntry(
  taskId: string,
  confirmation: ConfirmationNode,
  option: ConfirmationOption,
  confirmedAt: Date,
  confirmedBy?: string,
  metadata?: ConfirmationAuditMetadata
): ConfirmationAuditEntry {
  return {
    confirmationId: confirmation.id,
    taskId,
    stepId: confirmation.stepId,
    type: confirmation.type,
    optionId: option.id,
    action: option.action,
    optionLabel: option.label,
    optionLabelZh: option.labelZh,
    optionLabelEn: option.labelEn,
    confirmedAt: confirmedAt.toISOString(),
    confirmedBy,
    note: metadata?.note,
    reasonCode: metadata?.reasonCode,
    reasonLabel: metadata?.reasonLabel,
    reasonLabelZh: metadata?.reasonLabelZh,
    reasonLabelEn: metadata?.reasonLabelEn,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string | undefined): string {
  return (value || '').replace(/\s+/g, '').toLowerCase();
}

function normalizePhone(value: string | undefined): string {
  return (value || '').replace(/\D/g, '');
}

function createRuntimeTaskId(): string {
  return `task_${crypto.randomUUID()}`;
}

class AgentOrchestrator {
  private static instance: AgentOrchestrator;
  private tasks: Map<string, AgentTask> = new Map();
  private listeners: Set<(task: AgentTask) => void> = new Set();
  private confirmingTasks: Set<string> = new Set();
  private syncTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private syncInFlight: Map<string, Promise<void>> = new Map();
  private syncRetryRequested: Set<string> = new Set();
  private hydrationPromise: Promise<void> | null = null;
  private hasHydrated = false;

  private constructor() {}

  static getInstance(): AgentOrchestrator {
    if (!AgentOrchestrator.instance) {
      AgentOrchestrator.instance = new AgentOrchestrator();
    }
    return AgentOrchestrator.instance;
  }

  subscribe(callback: (task: AgentTask) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify(task: AgentTask): void {
    this.listeners.forEach((callback) => callback(task));
    this.queueTaskSync(task.id);
  }

  private queueTaskSync(taskId: string): void {
    const existingTimer = this.syncTimers.get(taskId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.syncTimers.delete(taskId);
      void this.flushTaskSync(taskId);
    }, 80);

    this.syncTimers.set(taskId, timer);
  }

  private async flushTaskSync(taskId: string): Promise<void> {
    if (this.syncInFlight.has(taskId)) {
      this.syncRetryRequested.add(taskId);
      return;
    }

    const syncPromise = this.persistTask(taskId)
      .finally(() => {
        this.syncInFlight.delete(taskId);

        if (this.syncRetryRequested.has(taskId)) {
          this.syncRetryRequested.delete(taskId);
          this.queueTaskSync(taskId);
        }
      });

    this.syncInFlight.set(taskId, syncPromise);
    await syncPromise;
  }

  private async persistTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    try {
      await agentRuntimeApi.syncTask(task);
    } catch (error) {
      console.warn('Failed to sync agent runtime task', error);
    }
  }

  private emitSnapshot(): void {
    const tasks = this.getAllTasks();
    tasks.forEach((task) => {
      this.listeners.forEach((callback) => callback(task));
    });
  }

  async hydrateFromServer(force = false): Promise<void> {
    if (this.hydrationPromise && !force) {
      return this.hydrationPromise;
    }

    if (this.hasHydrated && !force) {
      return;
    }

    const shouldReplaceLocalTasks = force || this.tasks.size === 0;

    this.hydrationPromise = (async () => {
      try {
        const persistedTasks = await agentRuntimeApi.getTasks({ limit: 50 });

        if (!shouldReplaceLocalTasks) {
          this.hasHydrated = true;
          return;
        }

        this.tasks.clear();
        persistedTasks.forEach((task) => {
          this.tasks.set(task.id, task);
        });
        this.hasHydrated = true;
        this.emitSnapshot();
      } catch (error) {
        console.warn('Failed to hydrate agent runtime tasks', error);
      } finally {
        this.hydrationPromise = null;
      }
    })();

    return this.hydrationPromise;
  }

  private toSupplierSummary(profile: SupplierCapabilityProfile) {
    return {
      id: profile.id,
      name: profile.name,
      level: profile.level,
      email: profile.email,
      phone: profile.phone,
      status: profile.status,
      performanceScore: profile.performanceScore,
      automationMode: profile.automationMode,
      preferredChannel: profile.preferredChannel,
      profileCompleteness: profile.profileCompleteness,
      nextAction: profile.nextAction,
      manualActionType: profile.manualActionType,
    };
  }

  private async getAvailableSuppliers(search?: string): Promise<Supplier[]> {
    const suppliers = (await supplierApi.getAll({
      search,
      page: 1,
      limit: 20,
      sort: 'performanceScore',
      direction: 'desc',
    })).data;
    return suppliers;
  }

  private async resolveFollowUpSupplier(
    supplier: NonNullable<AgentData['followUpQueue']>[number]
  ): Promise<Supplier | undefined> {

    if (supplier.id) {
      try {
        return await supplierApi.getById(supplier.id);
      } catch {
        // A deleted supplier can still be represented by the queued payload below.
      }
    }

    const currentSuppliers = await this.getAvailableSuppliers(supplier.name);

    const normalizedName = normalizeText(supplier.name);
    const normalizedEmail = normalizeText(supplier.email);
    const normalizedPhoneValue = normalizePhone(supplier.phone);

    const matchedSupplier = currentSuppliers.find((candidate) => {
      const candidateName = normalizeText(candidate.name);
      const candidateEmail = normalizeText(candidate.email);
      const candidatePhone = normalizePhone(candidate.phone);

      if (normalizedName && (candidateName === normalizedName || candidateName.includes(normalizedName) || normalizedName.includes(candidateName))) {
        return true;
      }

      if (normalizedEmail && candidateEmail === normalizedEmail) {
        return true;
      }

      if (normalizedPhoneValue && candidatePhone === normalizedPhoneValue) {
        return true;
      }

      if (normalizedPhoneValue.startsWith('86') && candidatePhone.startsWith('86')) {
        return true;
      }

      return false;
    });

    if (matchedSupplier) {
      return matchedSupplier;
    }

    return undefined;
  }

  private async getSupplierProfiles(context: AgentData): Promise<SupplierCapabilityProfile[]> {
    if (Array.isArray(context.selectedSupplierProfiles) && context.selectedSupplierProfiles.length > 0) {
      return context.selectedSupplierProfiles as SupplierCapabilityProfile[];
    }

    const currentSuppliers = await this.getAvailableSuppliers();

    return selectSuppliersForSourcing(currentSuppliers, context.parsedData?.urgency === 'aog' ? 3 : 3);
  }

  private async getAvailableCustomers(search?: string): Promise<Customer[]> {
    const customers = (await customerApi.getAll({ search, page: 1, limit: 20 })).data;
    return customers;
  }

  private async resolveCustomer(requestedId?: string, requestedName?: string): Promise<Customer | undefined> {
    if (requestedId) {
      try {
        return await customerApi.getById(requestedId);
      } catch {
        return undefined;
      }
    }

    if (!requestedName?.trim()) {
      return undefined;
    }

    const customers = await this.getAvailableCustomers(requestedName);
    const normalizedRequestedName = normalizeText(requestedName);

    const matchedCustomer = normalizedRequestedName
      ? customers.find((customer) => {
          const normalizedCustomerName = normalizeText(customer.name);
          return normalizedCustomerName === normalizedRequestedName
            || normalizedCustomerName.includes(normalizedRequestedName)
            || normalizedRequestedName.includes(normalizedCustomerName);
        })
      : undefined;

    return matchedCustomer;
  }

  private getNextTaskType(type: TaskType): TaskType | null {
    const transitions: Partial<Record<TaskType, TaskType>> = {
      email_received: 'rfq_created',
      rfq_created: 'sourcing_started',
    };

    return transitions[type] || null;
  }

  private scheduleNextTask(task: AgentTask): void {
    const nextType = this.getNextTaskType(task.type);
    if (!nextType) return;

    const alreadyScheduled = this.getAllTasks().some(
      (existingTask) => existingTask.trigger.referenceId === task.id && existingTask.type === nextType
    );

    if (alreadyScheduled) return;

    void this.createTask(
      {
        type: 'system',
        source: `${task.type}:${task.id}`,
        referenceId: task.id,
      },
      nextType,
      task.context
    );
  }

  private scheduleManualFollowUpTask(task: AgentTask): void {
    if (task.type !== 'rfq_created') return;

    const followUpQueue = Array.isArray(task.context.followUpQueue)
      ? task.context.followUpQueue
      : [];

    if (followUpQueue.length === 0) return;

    const alreadyScheduled = this.getAllTasks().some(
      (existingTask) => existingTask.trigger.referenceId === task.id && existingTask.type === 'manual_follow_up'
    );

    if (alreadyScheduled) return;

    const createdAt = new Date();
    const followUpTask: AgentTask = {
      id: createRuntimeTaskId(),
      trigger: {
        type: 'system',
        source: `${task.type}:${task.id}`,
        referenceId: task.id,
      },
      type: 'manual_follow_up',
      status: 'pending',
      currentStepIndex: 0,
      steps: [
        {
          id: 'step_1',
          capability: 'notification',
          action: 'manualFollowUp',
          params: {},
          status: 'pending',
        },
      ],
      context: {
        rfqId: task.context.rfqId,
        rfqNumber: task.context.rfqNumber,
        parsedData: task.context.parsedData,
        inquiryDispatch: task.context.inquiryDispatch,
        followUpQueue,
      },
      createdAt,
      updatedAt: createdAt,
    };

    this.tasks.set(followUpTask.id, followUpTask);
    this.notify(followUpTask);
  }

  private getPreExecutionConfirmation(step: TaskStep, task: AgentTask): ConfirmationNode | null {
    if (step.capability === 'rfq' && step.action === 'create' && !task.context.rfqConfirmed) {
      return {
        id: `confirm_${Date.now()}`,
        taskId: task.id,
        stepId: step.id,
        type: 'rfq_confirm',
        title: '需求单生成确认',
        titleZh: '需求单生成确认',
        titleEn: 'RFQ Creation Confirmation',
        description: '请确认已提取的需求信息是否正确',
        descriptionZh: '请确认已提取的需求信息是否正确',
        descriptionEn: 'Please confirm the extracted RFQ details before creating the RFQ.',
        data: task.context,
        options: [
          createConfirmationOption('confirm', '确认生成', 'Create RFQ', 'proceed'),
          createConfirmationOption('cancel', '取消', 'Cancel', 'cancel'),
        ],
      };
    }

    return null;
  }

  async createTask(
    trigger: AgentTask['trigger'],
    type: TaskType,
    context: AgentData = {}
  ): Promise<AgentTask> {
    const steps = this.generateSteps(type);

    const task: AgentTask = {
      id: createRuntimeTaskId(),
      trigger,
      type,
      status: 'running',
      currentStepIndex: 0,
      steps,
      context,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.tasks.set(task.id, task);
    this.notify(task);

    this.executeTask(task.id);

    return task;
  }

  private generateSteps(type: TaskType): TaskStep[] {
    const baseSteps: Record<TaskType, TaskStep[]> = {
      email_received: [
        { id: 'step_1', capability: 'email', action: 'parse', params: {}, status: 'pending' },
        { id: 'step_2', capability: 'rfq', action: 'create', params: {}, status: 'pending' },
        { id: 'step_3', capability: 'notification', action: 'alert', params: {}, status: 'pending' },
      ],
      rfq_created: [
        { id: 'step_1', capability: 'sourcing', action: 'matchInventory', params: {}, status: 'pending' },
        { id: 'step_2', capability: 'sourcing', action: 'selectSuppliers', params: {}, status: 'pending' },
        { id: 'step_3', capability: 'sourcing', action: 'sendInquiry', params: {}, status: 'pending' },
      ],
      manual_follow_up: [
        { id: 'step_1', capability: 'notification', action: 'manualFollowUp', params: {}, status: 'pending' },
      ],
      sourcing_started: [
        { id: 'step_1', capability: 'supplierQuote', action: 'collect', params: {}, status: 'pending' },
        { id: 'step_2', capability: 'supplierQuote', action: 'compare', params: {}, status: 'pending' },
      ],
      quotes_collected: [
        { id: 'step_1', capability: 'supplierQuote', action: 'compare', params: {}, status: 'pending' },
      ],
      quotes_compared: [
        { id: 'step_1', capability: 'quotation', action: 'create', params: {}, status: 'pending' },
        { id: 'step_2', capability: 'approval', action: 'request', params: {}, status: 'pending' },
      ],
      quotation_created: [
        { id: 'step_1', capability: 'approval', action: 'request', params: {}, status: 'pending' },
      ],
      quotation_sent: [
        { id: 'step_1', capability: 'order', action: 'create', params: {}, status: 'pending' },
        { id: 'step_2', capability: 'order', action: 'track', params: {}, status: 'pending' },
      ],
      approval_requested: [],
      approval_completed: [
        { id: 'step_1', capability: 'quotation', action: 'send', params: {}, status: 'pending' },
      ],
      order_created: [
        { id: 'step_1', capability: 'order', action: 'track', params: {}, status: 'pending' },
      ],
      order_tracking: [
        { id: 'step_1', capability: 'notification', action: 'remind', params: {}, status: 'pending' },
      ],
      order_completed: [
        { id: 'step_1', capability: 'notification', action: 'alert', params: {}, status: 'pending' },
      ],
    };

    return baseSteps[type] || [];
  }

  async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    while (task.currentStepIndex < task.steps.length) {
      const step = task.steps[task.currentStepIndex];

      if (step.status === 'skipped') {
        task.currentStepIndex++;
        continue;
      }

      const preExecutionConfirmation = this.getPreExecutionConfirmation(step, task);
      if (preExecutionConfirmation) {
        task.status = 'waiting_confirmation';
        task.confirmationNode = preExecutionConfirmation;
        task.updatedAt = new Date();
        this.notify(task);
        return;
      }

      step.status = 'running';
      step.startedAt = new Date();
      task.updatedAt = new Date();
      this.notify(task);

      try {
        const result = await this.executeCapability(step.capability, step.action, task.context);

        if (result.success) {
          step.status = 'completed';
          step.completedAt = new Date();
          step.result = result.data;
          task.context = { ...task.context, ...result.data };
        } else {
          step.status = 'failed';
          step.error = result.error;
          task.status = 'failed';
          task.error = result.error;
          task.updatedAt = new Date();
          this.notify(task);
          return;
        }
      } catch (error: unknown) {
        step.status = 'failed';
        step.error = toErrorMessage(error);
        task.status = 'failed';
        task.error = toErrorMessage(error);
        task.updatedAt = new Date();
        this.notify(task);
        return;
      }

      const confirmationNeeded = this.checkConfirmationNeed(step, task);
      if (confirmationNeeded) {
        task.status = 'waiting_confirmation';
        task.confirmationNode = confirmationNeeded;
        task.updatedAt = new Date();
        this.notify(task);
        return;
      }

      task.currentStepIndex++;
    }

    task.status = 'completed';
    task.completedAt = new Date();
    task.updatedAt = new Date();
    this.notify(task);
    this.scheduleManualFollowUpTask(task);
    this.scheduleNextTask(task);
  }

  private checkConfirmationNeed(step: TaskStep, task: AgentTask): ConfirmationNode | null {
    if (step.capability === 'supplierQuote' && step.action === 'compare') {
      if (task.context.compareSummary?.status !== 'available') {
        return null;
      }

      const quotes = task.context.comparedQuotes || [];
      const options: ConfirmationOption[] = quotes.map((q: QuoteCandidate, index: number) => {
        const automationMode = q.supplier?.automationMode === 'auto'
          ? '自动触达'
          : q.supplier?.automationMode === 'manual'
            ? '人工跟进'
            : '资料待补';
        const automationModeEn = q.supplier?.automationMode === 'auto'
          ? 'Auto outreach'
          : q.supplier?.automationMode === 'manual'
            ? 'Manual follow-up'
            : 'Profile incomplete';
        const descriptionZh = `$${q.unitPrice ?? '-'} | ${q.leadTimeDays ?? '-'}天 | ${automationMode} | 规则得分${q.ruleScore?.toFixed(0) ?? '-'}`;
        const descriptionEn = `$${q.unitPrice ?? '-'} | ${q.leadTimeDays ?? '-'} days | ${automationModeEn} | rule score ${q.ruleScore?.toFixed(0) ?? '-'}`;
        return {
          ...createConfirmationOption(
            `select_${index}`,
            `${index + 1}. ${q.supplier?.name || '供应商'}`,
            `${index + 1}. ${q.supplier?.name || 'Supplier'}`,
            'selectSupplier',
            q as AgentData,
            descriptionZh,
            descriptionEn
          ),
        };
      });

      return {
        id: `confirm_${Date.now()}`,
        taskId: task.id,
        stepId: step.id,
        type: 'supplier_select',
        title: '供应商选择确认',
        titleZh: '供应商选择确认',
        titleEn: 'Supplier Selection Confirmation',
        description: '已基于真实报价完成规则比对，请选择供应商',
        descriptionZh: '已基于真实报价完成规则比对，请选择供应商',
        descriptionEn: 'Rule-based comparison of recorded supplier quotes is complete. Please choose a supplier.',
        data: { quotes, summary: task.context.compareSummary },
        options: [
          ...options,
          createConfirmationOption('cancel', '暂不选择', 'Skip for now', 'cancel'),
        ],
      };
    }

    if (step.capability === 'quotation' && step.action === 'create') {
      const margin = typeof task.context.margin === 'number' ? task.context.margin : null;
      const warning = margin !== null && margin < 15 ? `⚠️ 利润率${margin.toFixed(1)}%低于15%阈值` : null;

      return {
        id: `confirm_${Date.now()}`,
        taskId: task.id,
        stepId: step.id,
        type: 'quotation_confirm',
        title: '报价单确认',
        titleZh: '报价单确认',
        titleEn: 'Quotation Confirmation',
        description: warning || '请确认报价单信息',
        descriptionZh: warning || '请确认报价单信息',
        descriptionEn: warning && margin !== null
          ? `Warning: margin ${margin.toFixed(1)}% is below the 15% threshold.`
          : 'Please confirm the quotation details.',
        data: task.context,
        options: [
          createConfirmationOption('confirm', '确认发送', 'Send quotation', 'proceed'),
          createConfirmationOption('cancel', '取消', 'Cancel', 'cancel'),
        ],
      };
    }

    return null;
  }

  async confirmTask(taskId: string, optionId: string, additionalData?: Record<string, unknown>): Promise<void> {
    if (this.confirmingTasks.has(taskId)) return;
    this.confirmingTasks.add(taskId);

    try {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'waiting_confirmation') return;

      const confirmation = task.confirmationNode;
      if (!confirmation) return;

      const selectedOption = confirmation.options.find((o) => o.id === optionId);
      if (!selectedOption) return;

      const {
        confirmationNote,
        confirmationReasonCode,
        confirmationReasonLabel,
        confirmationReasonLabelZh,
        confirmationReasonLabelEn,
        ...contextPatch
      } = additionalData || {};
      const normalizedConfirmationNote = normalizeOptionalText(confirmationNote);
      const normalizedConfirmationReasonCode = normalizeOptionalText(confirmationReasonCode);
      const normalizedConfirmationReasonLabel = normalizeOptionalText(confirmationReasonLabel);
      const normalizedConfirmationReasonLabelZh = normalizeOptionalText(confirmationReasonLabelZh);
      const normalizedConfirmationReasonLabelEn = normalizeOptionalText(confirmationReasonLabelEn);

      const confirmedAt = new Date();
      const confirmedBy = getConfirmationActor();
      confirmation.selectedOption = optionId;
      confirmation.confirmedAt = confirmedAt;
      confirmation.confirmedBy = confirmedBy;

      const confirmationAudit = buildConfirmationAuditEntry(
        task.id,
        confirmation,
        selectedOption,
        confirmedAt,
        confirmedBy,
        {
          note: normalizedConfirmationNote,
          reasonCode: normalizedConfirmationReasonCode,
          reasonLabel: normalizedConfirmationReasonLabel,
          reasonLabelZh: normalizedConfirmationReasonLabelZh,
          reasonLabelEn: normalizedConfirmationReasonLabelEn,
        }
      );
      task.context = {
        ...task.context,
        ...contextPatch,
        confirmationResult: selectedOption.action,
        latestConfirmation: confirmationAudit,
        confirmationHistory: [...getConfirmationHistory(task.context), confirmationAudit],
      };

      if (selectedOption.action === 'cancel') {
        task.status = 'cancelled';
        task.completedAt = new Date();
        task.confirmationNode = undefined;
      } else if (confirmation.type === 'rfq_confirm') {
        task.context = {
          ...task.context,
          confirmationResult: selectedOption.action,
          rfqConfirmed: true,
          ...contextPatch,
        };
        task.confirmationNode = undefined;
        task.status = 'running';
      } else if (selectedOption.action === 'selectSupplier') {
        task.context.selectedSupplier = selectedOption.data;
        task.confirmationNode = undefined;
        task.currentStepIndex++;
        task.status = 'running';
      } else {
        task.confirmationNode = undefined;
        task.currentStepIndex++;
        task.status = 'running';
      }

      task.updatedAt = new Date();
      this.notify(task);

      if (task.status === 'running') {
        setTimeout(() => this.executeTask(taskId), 100);
      }
    } finally {
      this.confirmingTasks.delete(taskId);
    }
  }

  private async executeCapability(
    capability: CapabilityName,
    action: string,
    context: AgentData
  ): Promise<CapabilityResult> {
    switch (capability) {
      case 'email':
        return this.executeEmailCapability(action, context);
      case 'rfq':
        return this.executeRFQCapability(action, context);
      case 'sourcing':
        return this.executeSourcingCapability(action, context);
      case 'supplierQuote':
        return this.executeSupplierQuoteCapability(action, context);
      case 'quotation':
        return this.executeQuotationCapability(action, context);
      case 'approval':
        return this.executeApprovalCapability(action);
      case 'order':
        return this.executeOrderCapability(action);
      case 'notification':
        return this.executeNotificationCapability();
      default:
        return { success: false, error: `Unknown capability: ${capability}` };
    }
  }

  private async executeEmailCapability(action: string, context: AgentData): Promise<CapabilityResult> {
    await delay(500);

    if (action === 'parse') {
      const existingParsedData = context.parsedData || {};
      const customer = await this.resolveCustomer(
        typeof existingParsedData.customerId === 'string' ? existingParsedData.customerId : undefined,
        typeof existingParsedData.customerName === 'string' ? existingParsedData.customerName : undefined
      );
      if (!customer) {
        return {
          success: false,
          error: '无法将来源邮件匹配到现有客户；请先补充真实客户 ID 或客户名称后再创建 RFQ。',
        };
      }

      const emailSubject = typeof context.emailSubject === 'string' ? context.emailSubject : undefined;
      const emailBody = typeof context.emailBody === 'string' ? context.emailBody : undefined;

      if (
        typeof existingParsedData.partNumber === 'string'
        && typeof existingParsedData.quantity === 'number'
        && existingParsedData.quantity > 0
        && typeof existingParsedData.requiredDate === 'string'
      ) {
        return {
          success: true,
          data: {
            ...(typeof context.emailId === 'string' ? { emailId: context.emailId } : {}),
            parsedData: {
              ...existingParsedData,
              customerId: customer.id,
              customerName: customer.name,
              source: context.demoMode === true ? 'controlled_demo_fixture' : 'upstream_parsed_payload',
            },
          },
        };
      }

      if (!emailSubject || !emailBody) {
        return {
          success: false,
          error: '缺少可追溯的邮件主题和正文，Agent 不会生成示例需求数据。',
        };
      }

      if (emailSubject && emailBody) {
        try {
          const aiResult = await aiApi.parseEmail(emailSubject, emailBody);
          const partNumber = aiResult.partNumbers[0];
          const quantity = aiResult.quantities[0];
          const requiredDate = existingParsedData.requiredDate;
          if (!partNumber || !quantity || quantity <= 0 || typeof requiredDate !== 'string') {
            return {
              success: false,
              error: '邮件解析结果缺少件号、数量或需求日期；请人工补充并确认，Agent 不会填充默认值。',
            };
          }

          return {
            success: true,
            data: {
              ...(typeof context.emailId === 'string' ? { emailId: context.emailId } : {}),
              parsedData: {
                ...existingParsedData,
                partNumber,
                quantity,
                customerId: customer.id,
                customerName: customer.name,
                requiredDate,
                aircraftType: aiResult.aircraftType || existingParsedData.aircraftType,
                urgency: aiResult.urgency?.toLowerCase() || existingParsedData.urgency,
                aiClassified: true,
                aiType: aiResult.type,
                source: 'email_parser',
              },
            },
          };
        } catch (error) {
          console.warn('AI email parse failed; manual review is required:', error);
          return {
            success: false,
            error: '邮件解析服务不可用；请转为人工需求录入，不会回退到示例数据。',
          };
        }
      }

      return { success: false, error: '缺少可处理的来源邮件。' };
    }

    if (action === 'send') {
      return { success: false, error: 'Agent 不会模拟邮件发送；请通过已配置的邮件工作流发送。' };
    }

    return { success: true, data: {} };
  }

  private async executeRFQCapability(action: string, context: AgentData): Promise<CapabilityResult> {
    await delay(800);

    if (action === 'create') {
      const parsedData = context.parsedData || {};
      const resolvedCustomer = await this.resolveCustomer(
        typeof parsedData.customerId === 'string' ? parsedData.customerId : undefined,
        typeof parsedData.customerName === 'string' ? parsedData.customerName : undefined
      );
      const partNumber = typeof parsedData.partNumber === 'string' ? parsedData.partNumber.trim() : '';
      const quantity = typeof parsedData.quantity === 'number' ? parsedData.quantity : 0;
      const requiredDate = typeof parsedData.requiredDate === 'string' ? parsedData.requiredDate : undefined;
      const urgency = typeof parsedData.urgency === 'string' ? parsedData.urgency.toUpperCase() : 'STANDARD';

      if (!resolvedCustomer || !partNumber || quantity <= 0 || !requiredDate) {
        return {
          success: false,
          error: 'RFQ 缺少已匹配客户、件号、数量或需求日期；请人工补全真实信息后再建单。',
        };
      }

      const createdRFQ = await rfqApi.create({
        customerId: resolvedCustomer.id,
        partNumber,
        quantity,
        requiredDate,
        aircraftType: typeof parsedData.aircraftType === 'string' ? parsedData.aircraftType : undefined,
        targetPrice: typeof parsedData.targetPrice === 'number' ? parsedData.targetPrice : undefined,
        urgency,
      });

      useRFQStore.getState().addRFQ(createdRFQ);

      return {
        success: true,
        data: {
          ...createdRFQ,
          rfqId: createdRFQ.id,
          rfqNumber: createdRFQ.rfqNumber,
          parsedData: {
            ...parsedData,
            customerId: createdRFQ.customerId,
            customerName: createdRFQ.customerName || resolvedCustomer.name,
            requiredDate: createdRFQ.requiredDate || requiredDate,
            urgency: createdRFQ.urgency || urgency.toLowerCase(),
          },
        },
      };
    }

    if (action === 'update') {
      return { success: true, data: { updated: true } };
    }

    return { success: true, data: {} };
  }

  private async executeSourcingCapability(action: string, context: AgentData): Promise<CapabilityResult> {
    await delay(1000);

    if (action === 'matchInventory') {
      return {
        success: true,
        data: {
          inventoryMatchStatus: 'not_evaluated',
          message: '当前 Agent 未接入库存可用性检索；请在库存中心确认可用库存，不能据此认定无匹配。',
        },
      };
    }

    if (action === 'selectSuppliers') {
      const selectedProfiles = await this.getSupplierProfiles(context);
      if (selectedProfiles.length === 0) {
        return { success: false, error: '当前没有可用于询价的供应商，请先补充供应商主数据' };
      }

      return {
        success: true,
        data: {
          selectedSuppliers: selectedProfiles.map((profile) => this.toSupplierSummary(profile)),
          selectedSupplierProfiles: selectedProfiles,
          sourcingSummary: {
            ...buildInquiryDispatchSummary(selectedProfiles),
            source: 'supplier_master_data',
            algorithmVersion: 'supplier-readiness-v1',
            sampleSize: selectedProfiles.length,
            decisionBoundary: '候选排序仅供人工询价准备，不代表已验证供货能力、价格或交期。',
          },
        },
      };
    }

    if (action === 'sendInquiry') {
      const selectedProfiles = await this.getSupplierProfiles(context);
      const inquiryDispatch = buildInquiryDispatchSummary(selectedProfiles);

      return {
        success: true,
        data: {
          inquirySent: false,
          suppliersNotified: 0,
          inquiryDispatch: {
            ...inquiryDispatch,
            readyCandidateCount: inquiryDispatch.suppliersNotified,
            dispatchStatus: 'manual_confirmation_required',
            decisionBoundary: '候选供应商尚未被系统发送询价；请在正式询价工作流中人工确认并发送。',
          },
          followUpQueue: selectedProfiles
            .filter((profile) => profile.automationMode !== 'auto')
            .map((profile) => this.toSupplierSummary(profile)),
        },
      };
    }

    return { success: true, data: {} };
  }

  private async executeSupplierQuoteCapability(action: string, context: AgentData): Promise<CapabilityResult> {
    await delay(800);

    if (action === 'collect') {
      const rfqId = typeof context.rfqId === 'string' ? context.rfqId : undefined;
      const inquiryId = typeof context.inquiryId === 'string' ? context.inquiryId : undefined;
      if (!rfqId && !inquiryId) {
        return { success: false, error: '缺少 RFQ 或询价单标识，无法读取真实供应商报价。' };
      }

      const supplierQuotes = await supplierQuoteApi.getAll({ rfqId, inquiryId });
      const quotes = supplierQuotes.map((quote) => ({
        id: quote.id,
        supplierId: quote.supplier.id,
        unitPrice: quote.unitPrice,
        totalPrice: quote.totalPrice,
        leadTimeDays: quote.leadTimeDays,
        supplier: {
          id: quote.supplier.id,
          name: quote.supplier.name,
          level: quote.supplier.level,
          email: quote.supplier.contactEmail || undefined,
          performanceScore: quote.supplier.performanceScore ?? undefined,
        },
      }));

      if (quotes.length === 0) {
        return { success: false, error: '尚未收到真实供应商报价；请等待回传或由人工录入报价。' };
      }

      return {
        success: true,
        data: {
          quotes,
          quoteCollectionSummary: {
            collectedQuotes: quotes.length,
            source: 'supplier_quote_records',
            algorithmVersion: null,
            sampleSize: quotes.length,
            decisionBoundary: '仅收集已记录的供应商报价，不会合成报价、价格或交期。',
          },
        },
      };
    }

    if (action === 'compare') {
      const rfqId = typeof context.rfqId === 'string' ? context.rfqId : undefined;
      const inquiryId = typeof context.inquiryId === 'string' ? context.inquiryId : undefined;
      if (!rfqId && !inquiryId) {
        return { success: false, error: '缺少 RFQ 或询价单标识，无法比对真实供应商报价。' };
      }

      const comparison = await supplierQuoteApi.compare({ rfqId, inquiryId });
      const profileBySupplierId = new Map(
        (Array.isArray(context.selectedSupplierProfiles) ? context.selectedSupplierProfiles : [])
          .map((profile) => profile as SupplierCapabilityProfile)
          .filter((profile) => typeof profile.id === 'string')
          .map((profile) => [profile.id as string, profile])
      );
      const comparedQuotes: QuoteCandidate[] = comparison.quotes.map((quote) => {
        const profile = profileBySupplierId.get(quote.supplier.id);
        return {
          id: quote.id,
          supplierId: quote.supplier.id,
          unitPrice: quote.unitPrice,
          totalPrice: quote.totalPrice,
          leadTimeDays: quote.leadTimeDays,
          ruleScore: quote.ruleScore ?? undefined,
          scoreComponents: quote.scoreComponents,
          supplier: {
            id: quote.supplier.id,
            name: quote.supplier.name,
            level: quote.supplier.level,
            performanceScore: quote.supplier.performanceScore ?? undefined,
            automationMode: profile?.automationMode,
            preferredChannel: profile?.preferredChannel,
            profileCompleteness: profile?.profileCompleteness,
            nextAction: profile?.nextAction,
          },
        };
      });

      return {
        success: true,
        data: {
          comparedQuotes,
          bestMatch: comparison.topRanked
            ? comparedQuotes.find((quote) => quote.id === comparison.topRanked?.id)
            : undefined,
          compareSummary: {
            ...comparison.summary,
            ...comparison.metadata,
          },
        },
      };
    }

    if (action === 'selectWinner') {
      return { success: false, error: '请在供应商报价页面完成正式中选；Agent 不会模拟中选结果。' };
    }

    return { success: true, data: {} };
  }

  private async executeQuotationCapability(action: string, context: AgentData): Promise<CapabilityResult> {
    void action;
    void context;
    return {
      success: false,
      error: 'Agent 不会合成报价、成本、利润或邮件内容；请在报价管理中基于已确认的真实供应商报价创建草稿。',
    };
  }

  private async executeApprovalCapability(action: string): Promise<CapabilityResult> {
    void action;
    return {
      success: true,
      data: {
        approvalStatus: 'manual_workflow_required',
        message: '未创建模拟审批；请在报价管理中提交真实报价进入审批流程。',
      },
    };
  }

  private async executeOrderCapability(action: string): Promise<CapabilityResult> {
    void action;
    return {
      success: true,
      data: {
        orderStatus: 'manual_workflow_required',
        message: '未创建模拟订单或物流进度；请在订单管理中处理真实客户确认和履约状态。',
      },
    };
  }

  private async executeNotificationCapability(): Promise<CapabilityResult> {
    await delay(300);

    return {
      success: true,
      data: {
        notificationStatus: 'not_dispatched',
        message: '未模拟发送通知；请通过已配置的通知渠道执行实际通知。',
      },
    };
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): AgentTask[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }

  getPendingConfirmations(): ConfirmationNode[] {
    return this.getAllTasks()
      .filter((t) => t.status === 'waiting_confirmation' && t.confirmationNode)
      .map((t) => t.confirmationNode!);
  }

  getDashboard(): AgentDashboard {
    const tasks = this.getAllTasks();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const runningTasks = tasks.filter((t) => t.status === 'running');
    const pendingTasks = tasks.filter((t) => t.status === 'pending');
    const waitingConfirmationTasks = tasks.filter((t) => t.status === 'waiting_confirmation');
    const completedToday = tasks.filter(
      (t) => t.status === 'completed' && t.completedAt && t.completedAt >= today
    );
    const failedToday = tasks.filter(
      (t) => t.status === 'failed' && t.updatedAt >= today
    );

    return {
      tasks: {
        total: tasks.length,
        running: runningTasks.length,
        pending: pendingTasks.length,
        waitingConfirmation: waitingConfirmationTasks.length,
        completedToday: completedToday.length,
        failedToday: failedToday.length,
      },
      pipeline: {
        emailsReceived: tasks.filter((t) => t.type === 'email_received').length,
        rfqsCreated: tasks.filter((t) => t.type === 'rfq_created' || t.context.rfqId).length,
        quotationsSent: tasks.filter((t) => t.type === 'quotation_sent' || t.context.quotationId).length,
        ordersCompleted: completedToday.filter((t) => t.type === 'order_completed').length,
      },
      pendingConfirmations: this.getPendingConfirmations(),
      recentTasks: tasks.slice(0, 10),
      alerts: [],
    };
  }

  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'cancelled';
      task.completedAt = new Date();
      task.updatedAt = new Date();
      this.notify(task);
    }
  }

  async completeManualFollowUpTask(
    taskId: string,
    payload?: { outcome?: SupplierFollowUpOutcome; notes?: string }
  ): Promise<SupplierFollowUpLog[]> {
    const task = this.tasks.get(taskId);
    if (!task || task.type !== 'manual_follow_up' || task.status !== 'pending') return [];

    const completedAt = new Date();
    const manualStep = task.steps[0];
    const followUpQueue = Array.isArray(task.context.followUpQueue) ? task.context.followUpQueue : [];
    const followUpNotes = payload?.notes?.trim() || undefined;
    const followUpOutcome = payload?.outcome || 'contacted_waiting_quote';
    const resolvedFollowUpQueue = await Promise.all(followUpQueue.map(async (supplier) => {
      const resolvedSupplier = await this.resolveFollowUpSupplier(supplier);
      if (!resolvedSupplier) {
        throw new Error(`无法定位待跟进供应商“${supplier.name || supplier.id || '未知供应商'}”；请刷新供应商主数据后重试。`);
      }

      return {
        ...supplier,
        id: resolvedSupplier.id,
        name: resolvedSupplier.name,
        email: resolvedSupplier.email || supplier.email,
        phone: resolvedSupplier.phone || supplier.phone,
      };
    }));
    const followUpDrafts = resolvedFollowUpQueue.map((supplier, index) => ({
      supplierId: supplier.id || `supplier_${index + 1}`,
      taskId,
      rfqId: typeof task.context.rfqId === 'string' ? task.context.rfqId : undefined,
      rfqNumber: typeof task.context.rfqNumber === 'string' ? task.context.rfqNumber : undefined,
      actionType: supplier.manualActionType || 'phone_follow_up',
      outcome: followUpOutcome,
      notes: followUpNotes,
      preferredChannel: supplier.preferredChannel,
    }));

    const followUpLogs = followUpDrafts.length > 0
      ? await supplierApi.createFollowUpLogs({ logs: followUpDrafts })
      : [];

    if (followUpLogs.length > 0) {
      useSupplierFollowUpStore.getState().addLogs(followUpLogs);
    }

    if (manualStep) {
      manualStep.status = 'completed';
      manualStep.startedAt ??= completedAt;
      manualStep.completedAt = completedAt;
      manualStep.result = {
        followUpQueue: resolvedFollowUpQueue,
        manualFollowUpCompleted: true,
        followUpCompletedAt: completedAt.toISOString(),
        followUpLogs,
        followUpOutcome,
        followUpNotes,
      };
    }

    task.currentStepIndex = task.steps.length;
    task.status = 'completed';
    task.completedAt = completedAt;
    task.updatedAt = completedAt;
    task.context = {
      ...task.context,
      followUpQueue: resolvedFollowUpQueue,
      manualFollowUpCompleted: true,
      followUpCompletedAt: completedAt.toISOString(),
      followUpLogs,
      followUpOutcome,
      followUpNotes,
    };
    this.notify(task);
    return followUpLogs;
  }
}

export const agentOrchestrator = AgentOrchestrator.getInstance();
