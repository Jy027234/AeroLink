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
import { agentRuntimeApi, customerApi, rfqApi, supplierApi, aiApi } from '@/api/client';
import { mockCustomers, mockSuppliers } from '@/data/mockData';
import {
  buildInquiryDispatchSummary,
  selectSuppliersForSourcing,
  synthesizeSupplierQuotes,
  type SupplierCapabilityProfile,
} from '@/lib/supplierCapability';
import { useAuthStore, useCustomerStore, useRFQStore, useSupplierFollowUpStore, useSupplierStore } from '@/store';

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

function formatDateOnly(date: Date): string {
  return date.toISOString().split('T')[0];
}

function getDefaultRequiredDate(urgency: string | undefined): string {
  const date = new Date();
  date.setDate(date.getDate() + (urgency?.toLowerCase() === 'aog' ? 1 : 7));
  return formatDateOnly(date);
}

function buildDemoSuppliers(sourceSuppliers: Supplier[]): Supplier[] {
  const baseSuppliers = sourceSuppliers.length > 0 ? sourceSuppliers : mockSuppliers;
  const manualCandidateIndex = baseSuppliers.findIndex((supplier) => normalizePhone(supplier.phone).startsWith('86'));
  const fallbackIndex = baseSuppliers.length > 0 ? Math.min(baseSuppliers.length - 1, 2) : 0;
  const manualIndex = manualCandidateIndex >= 0 ? manualCandidateIndex : fallbackIndex;

  return baseSuppliers.map((supplier, index) => {
    if (index !== manualIndex) {
      return supplier;
    }

    return {
      ...supplier,
      email: undefined,
      performanceScore: typeof supplier.performanceScore === 'number' ? Math.min(supplier.performanceScore, 82) : 82,
      leadTime: typeof supplier.leadTime === 'number' ? supplier.leadTime : 12,
    };
  });
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

  private getCurrentSuppliers(): Supplier[] {
    const currentSuppliers = useSupplierStore.getState().suppliers;
    return currentSuppliers.length > 0 ? currentSuppliers : mockSuppliers;
  }

  private resolveFollowUpSupplier(
    supplier: NonNullable<AgentData['followUpQueue']>[number],
    fallbackIndex: number
  ): Supplier | undefined {
    const currentSuppliers = this.getCurrentSuppliers();

    if (supplier.id) {
      const matchedById = currentSuppliers.find((candidate) => candidate.id === supplier.id);
      if (matchedById) {
        return matchedById;
      }
    }

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

    return currentSuppliers[fallbackIndex % currentSuppliers.length];
  }

  private getSupplierProfiles(context: AgentData): SupplierCapabilityProfile[] {
    const currentSuppliers = this.getCurrentSuppliers();

    if (context.demoMode === true) {
      return selectSuppliersForSourcing(buildDemoSuppliers(currentSuppliers), context.parsedData?.urgency === 'aog' ? 3 : 3);
    }

    if (Array.isArray(context.selectedSupplierProfiles) && context.selectedSupplierProfiles.length > 0) {
      return context.selectedSupplierProfiles as SupplierCapabilityProfile[];
    }

    return selectSuppliersForSourcing(currentSuppliers, context.parsedData?.urgency === 'aog' ? 3 : 3);
  }

  private async getAvailableCustomers(): Promise<Customer[]> {
    const existingCustomers = useCustomerStore.getState().customers;
    if (existingCustomers.length > 0) {
      return existingCustomers;
    }

    try {
      const customers = (await customerApi.getAll()).data;
      if (customers.length > 0) {
        useCustomerStore.getState().setCustomers(customers);
        return customers;
      }
    } catch {
      // Fallback to mock data to keep demo flow usable when customer bootstrap is late.
    }

    return mockCustomers;
  }

  private async resolveDemoCustomer(requestedName?: string): Promise<Customer> {
    const customers = await this.getAvailableCustomers();
    const normalizedRequestedName = normalizeText(requestedName);

    const matchedCustomer = normalizedRequestedName
      ? customers.find((customer) => {
          const normalizedCustomerName = normalizeText(customer.name);
          return normalizedCustomerName === normalizedRequestedName
            || normalizedCustomerName.includes(normalizedRequestedName)
            || normalizedRequestedName.includes(normalizedCustomerName);
        })
      : undefined;

    return matchedCustomer
      || customers.find((customer) => customer.name === '海南航空')
      || customers[0]
      || mockCustomers[0];
  }

  private getNextTaskType(type: TaskType): TaskType | null {
    const transitions: Partial<Record<TaskType, TaskType>> = {
      email_received: 'rfq_created',
      rfq_created: 'sourcing_started',
      sourcing_started: 'quotes_compared',
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
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
        description: '请确认AI解析的需求信息是否正确',
        descriptionZh: '请确认AI解析的需求信息是否正确',
        descriptionEn: 'Please confirm the AI-parsed RFQ details before creating the RFQ.',
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
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
        const descriptionZh = `$${q.unitPrice ?? '-'} | ${q.leadTimeDays ?? '-'}天 | ${automationMode} | 得分${q.aiScore?.toFixed(0) ?? '-'}`;
        const descriptionEn = `$${q.unitPrice ?? '-'} | ${q.leadTimeDays ?? '-'} days | ${automationModeEn} | score ${q.aiScore?.toFixed(0) ?? '-'}`;
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
        description: 'AI询比价完成，请选择最优供应商',
        descriptionZh: 'AI询比价完成，请选择最优供应商',
        descriptionEn: 'AI quote comparison is complete. Please choose the preferred supplier.',
        data: { quotes, summary: task.context.compareSummary },
        options: [
          ...options,
          createConfirmationOption('cancel', '暂不选择', 'Skip for now', 'cancel'),
        ],
      };
    }

    if (step.capability === 'quotation' && step.action === 'create') {
      const margin = task.context.margin || 0;
      const warning = margin < 15 ? `⚠️ 利润率${margin.toFixed(1)}%低于15%阈值` : null;

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
        descriptionEn: warning
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
      const customer = await this.resolveDemoCustomer(
        typeof context.parsedData?.customerName === 'string' ? context.parsedData.customerName : 'XX航空'
      );
      const urgency = typeof context.parsedData?.urgency === 'string' ? context.parsedData.urgency : 'aog';

      const emailSubject = typeof context.emailSubject === 'string' ? context.emailSubject : undefined;
      const emailBody = typeof context.emailBody === 'string' ? context.emailBody : undefined;

      if (emailSubject && emailBody) {
        try {
          const aiResult = await aiApi.parseEmail(emailSubject, emailBody);
          return {
            success: true,
            data: {
              emailId: context.emailId || 'email_001',
              parsedData: {
                partNumber: aiResult.partNumbers[0] || 'BAC31GK0020',
                quantity: aiResult.quantities[0] || 2,
                customerId: customer.id,
                customerName: customer.name,
                requiredDate: getDefaultRequiredDate(aiResult.urgency),
                aircraftType: aiResult.aircraftType || 'Boeing 737-800',
                targetPrice: 1200,
                urgency: aiResult.urgency?.toLowerCase() || urgency,
                aiClassified: true,
                aiType: aiResult.type,
              },
            },
          };
        } catch (error) {
          console.warn('AI email parse failed, falling back to demo data:', error);
        }
      }

      return {
        success: true,
        data: {
          emailId: context.emailId || 'email_001',
          parsedData: {
            partNumber: 'BAC31GK0020',
            quantity: 2,
            customerId: customer.id,
            customerName: customer.name,
            requiredDate: getDefaultRequiredDate(urgency),
            aircraftType: 'Boeing 737-800',
            targetPrice: 1200,
            urgency,
          },
        },
      };
    }

    if (action === 'send') {
      return { success: true, data: { sent: true, messageId: `msg_${Date.now()}` } };
    }

    return { success: true, data: {} };
  }

  private async executeRFQCapability(action: string, context: AgentData): Promise<CapabilityResult> {
    await delay(800);

    if (action === 'create') {
      const parsedData = context.parsedData || {};
      const resolvedCustomer = await this.resolveDemoCustomer(
        typeof parsedData.customerName === 'string' ? parsedData.customerName : undefined
      );
      const customerId = typeof parsedData.customerId === 'string' ? parsedData.customerId : resolvedCustomer.id;
      const customerName = typeof parsedData.customerName === 'string' ? parsedData.customerName : resolvedCustomer.name;
      const requiredDate = typeof parsedData.requiredDate === 'string'
        ? parsedData.requiredDate
        : getDefaultRequiredDate(typeof parsedData.urgency === 'string' ? parsedData.urgency : undefined);
      const urgency = typeof parsedData.urgency === 'string' ? parsedData.urgency.toUpperCase() : 'AOG';

      const createdRFQ = await rfqApi.create({
        customerId,
        partNumber: typeof parsedData.partNumber === 'string' ? parsedData.partNumber : 'BAC31GK0020',
        quantity: typeof parsedData.quantity === 'number' ? parsedData.quantity : 1,
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
            customerName: createdRFQ.customerName || customerName,
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
          inventoryMatch: null,
          message: '内部库存无匹配',
        },
      };
    }

    if (action === 'selectSuppliers') {
      const selectedProfiles = this.getSupplierProfiles(context);
      if (selectedProfiles.length === 0) {
        return { success: false, error: '当前没有可用于询价的供应商，请先补充供应商主数据' };
      }

      return {
        success: true,
        data: {
          selectedSuppliers: selectedProfiles.map((profile) => this.toSupplierSummary(profile)),
          selectedSupplierProfiles: selectedProfiles,
          sourcingSummary: buildInquiryDispatchSummary(selectedProfiles),
        },
      };
    }

    if (action === 'sendInquiry') {
      const selectedProfiles = this.getSupplierProfiles(context);
      const inquiryDispatch = buildInquiryDispatchSummary(selectedProfiles);

      return {
        success: true,
        data: {
          inquirySent: inquiryDispatch.suppliersNotified > 0,
          suppliersNotified: inquiryDispatch.suppliersNotified,
          inquiryDispatch,
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
      const selectedProfiles = this.getSupplierProfiles(context);
      const quotes = synthesizeSupplierQuotes(selectedProfiles, context);

      if (quotes.length === 0) {
        return { success: false, error: '没有可收集的供应商报价，请先补充供应商联系方式' };
      }

      return {
        success: true,
        data: {
          quotes,
          quoteCollectionSummary: {
            collectedQuotes: quotes.length,
            awaitingManualFollowUp: selectedProfiles.filter((profile) => profile.automationMode === 'manual').length,
            blockedSuppliers: selectedProfiles.filter((profile) => profile.automationMode === 'blocked').length,
          },
        },
      };
    }

    if (action === 'compare') {
      const quotes = context.quotes || [];
      if (quotes.length === 0) {
        return { success: false, error: '没有报价可用于比对' };
      }

      const quotePrices = quotes
        .map((q: QuoteCandidate) => (typeof q.unitPrice === 'number' ? q.unitPrice : Infinity))
        .filter((value) => Number.isFinite(value));
      const minPrice = quotePrices.length > 0 ? Math.min(...quotePrices) : 0;

      const comparedQuotes = quotes.map((q: QuoteCandidate, index: number) => {
        const unitPrice = q.unitPrice ?? 0;
        const leadTimeDays = q.leadTimeDays ?? 0;
        const quantity = context.parsedData?.quantity || 1;
        const safeMinPrice = minPrice > 0 ? minPrice : 1;
        const priceScore = ((unitPrice - safeMinPrice) / safeMinPrice) * -35 + 35;
        const leadTimeScore = leadTimeDays <= 7 ? 20 : Math.max(5, 20 - (leadTimeDays - 7) * 2);
        const supplierPerformance = typeof q.supplier?.performanceScore === 'number' ? q.supplier.performanceScore : 70;
        const supplierScore = Math.max(8, supplierPerformance / 5 + (q.supplier?.automationMode === 'auto' ? 3 : 0));
        const aiScore = priceScore + leadTimeScore + supplierScore;

        return {
          ...q,
          supplier: q.supplier || { name: `供应商${index + 1}`, level: 'C' },
          totalPrice: unitPrice * quantity,
          aiScore,
          aiRecommendation: aiScore >= 80 ? '强烈推荐' : aiScore >= 60 ? '推荐' : '考虑',
        };
      });

      comparedQuotes.sort((a, b) => (b.aiScore ?? 0) - (a.aiScore ?? 0));

      let aiAnalysis: string | undefined;
      try {
        const rfqDetails = `件号: ${context.parsedData?.partNumber || '-'}, 数量: ${context.parsedData?.quantity || 1}, 客户: ${context.parsedData?.customerName || '-'}, 紧急度: ${context.parsedData?.urgency || 'standard'}`;
        const supplierQuotes = quotes.map((q: QuoteCandidate, i: number) =>
          `${i + 1}. ${q.supplier?.name || '供应商'}: 单价 $${q.unitPrice || '-'}, 交期 ${q.leadTimeDays || '-'}天, 绩效分 ${q.supplier?.performanceScore || '-'}`
        ).join('\n');
        const analysisResult = await aiApi.analyzeQuotes(rfqDetails, supplierQuotes);
        aiAnalysis = analysisResult.analysis;
      } catch (error) {
        console.warn('AI quote analysis failed:', error);
      }

      return {
        success: true,
        data: {
          comparedQuotes,
          bestMatch: comparedQuotes[0],
          compareSummary: {
            totalQuotes: quotes.length,
            lowestPrice: minPrice,
            autoCapableSuppliers: comparedQuotes.filter((quote) => quote.supplier?.automationMode === 'auto').length,
            aiAnalysis,
          },
        },
      };
    }

    if (action === 'selectWinner') {
      return { success: true, data: { winnerSelected: true } };
    }

    return { success: true, data: {} };
  }

  private async executeQuotationCapability(action: string, context: AgentData): Promise<CapabilityResult> {
    await delay(600);

    if (action === 'create') {
      const bestQuote = context.bestMatch || { unitPrice: 1050 };
      const quantityCandidate = context.parsedData?.quantity;
      const quantity =
        typeof quantityCandidate === 'number'
          ? quantityCandidate
          : Number(quantityCandidate ?? 1) || 1;
      const unitPrice = typeof bestQuote.unitPrice === 'number' ? bestQuote.unitPrice : 1050;
      const totalPrice = unitPrice * quantity;
      const costPrice = unitPrice * 0.9;
      const margin = ((unitPrice - costPrice) / unitPrice) * 100;

      let customerEmail: string | undefined;
      try {
        const leadTimeDays =
          typeof bestQuote.leadTimeDays === 'number'
            ? bestQuote.leadTimeDays
            : Number(bestQuote.leadTimeDays ?? 7) || 7;
        const emailResult = await aiApi.generateEmail({
          customerName: context.parsedData?.customerName || '客户',
          partNumber: context.parsedData?.partNumber || '-',
          quantity,
          unitPrice,
          totalPrice,
          leadTimeDays,
          validityDays: 30,
        });
        customerEmail = emailResult.email;
      } catch (error) {
        console.warn('AI email generation failed:', error);
      }

      return {
        success: true,
        data: {
          quotationId: `QT-${Date.now()}`,
          quotationNumber: `QT-2026-${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
          unitPrice,
          totalPrice,
          costPrice,
          margin,
          validityDays: 30,
          customerEmail,
        },
      };
    }

    if (action === 'send') {
      return { success: true, data: { sent: true, sentAt: new Date().toISOString() } };
    }

    return { success: true, data: {} };
  }

  private async executeApprovalCapability(action: string): Promise<CapabilityResult> {
    await delay(500);

    if (action === 'request') {
      return {
        success: true,
        data: {
          approvalId: `AP-${Date.now()}`,
          status: 'pending_approval',
          requestedAt: new Date().toISOString(),
        },
      };
    }

    return { success: true, data: {} };
  }

  private async executeOrderCapability(action: string): Promise<CapabilityResult> {
    await delay(700);

    if (action === 'create') {
      return {
        success: true,
        data: {
          orderId: `ORD-${Date.now()}`,
          orderNumber: `ORD-2026-${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
          status: 'confirmed',
          createdAt: new Date().toISOString(),
        },
      };
    }

    if (action === 'track') {
      return {
        success: true,
        data: {
          status: 'in_production',
          progress: 45,
          estimatedDelivery: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      };
    }

    if (action === 'complete') {
      return { success: true, data: { completed: true, completedAt: new Date().toISOString() } };
    }

    return { success: true, data: {} };
  }

  private async executeNotificationCapability(): Promise<CapabilityResult> {
    await delay(300);

    return {
      success: true,
      data: {
        notified: true,
        method: 'system',
        timestamp: new Date().toISOString(),
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
    const resolvedFollowUpQueue = followUpQueue.map((supplier, index) => {
      const resolvedSupplier = this.resolveFollowUpSupplier(supplier, index);

      if (!resolvedSupplier) {
        return supplier;
      }

      return {
        ...supplier,
        id: resolvedSupplier.id,
        name: resolvedSupplier.name,
        email: resolvedSupplier.email || supplier.email,
        phone: resolvedSupplier.phone || supplier.phone,
      };
    });
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
