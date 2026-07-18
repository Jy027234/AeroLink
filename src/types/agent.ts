export type TaskStatus = 'pending' | 'running' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';

export type TaskType =
  | 'email_received'
  | 'rfq_created'
  | 'manual_follow_up'
  | 'sourcing_started'
  | 'quotes_collected'
  | 'quotes_compared'
  | 'quotation_created'
  | 'quotation_sent'
  | 'approval_requested'
  | 'approval_completed'
  | 'order_created'
  | 'order_tracking'
  | 'order_completed';

export type CapabilityName =
  | 'email'
  | 'rfq'
  | 'sourcing'
  | 'supplierQuote'
  | 'quotation'
  | 'approval'
  | 'order'
  | 'notification';

type AgentRecord = Record<string, unknown>;

interface ParsedData extends AgentRecord {
  partNumber?: string;
  customerId?: string;
  customerName?: string;
  quantity?: number;
  requiredDate?: string;
  aircraftType?: string;
  targetPrice?: number;
  urgency?: string;
}

export interface SupplierSummary extends AgentRecord {
  id?: string;
  name?: string;
  level?: string;
  email?: string;
  phone?: string;
  status?: string;
  performanceScore?: number;
  automationMode?: 'auto' | 'manual' | 'blocked';
  preferredChannel?: 'email' | 'phone' | 'manual';
  manualActionType?: 'portal_follow_up' | 'wechat_follow_up' | 'whatsapp_follow_up' | 'phone_follow_up' | 'contact_missing';
  profileCompleteness?: number;
  nextAction?: string;
}

export interface QuoteCandidate extends AgentRecord {
  id?: string;
  supplier?: SupplierSummary;
  unitPrice?: number;
  leadTimeDays?: number;
  ruleScore?: number;
  scoreComponents?: {
    price?: number | null;
    leadTime?: number | null;
    supplierPerformance?: number | null;
  };
}

export interface ConfirmationAuditEntry extends AgentRecord {
  confirmationId: string;
  taskId: string;
  stepId: string;
  type: ConfirmationNode['type'];
  optionId: string;
  action: string;
  optionLabel?: string;
  optionLabelZh?: string;
  optionLabelEn?: string;
  confirmedAt: string;
  confirmedBy?: string;
  note?: string;
  reasonCode?: string;
  reasonLabel?: string;
  reasonLabelZh?: string;
  reasonLabelEn?: string;
}

export interface AgentData extends AgentRecord {
  parsedData?: ParsedData;
  selectedSuppliers?: SupplierSummary[];
  selectedSupplierProfiles?: AgentRecord[];
  sourcingSummary?: AgentRecord;
  inquiryDispatch?: AgentRecord;
  followUpQueue?: SupplierSummary[];
  quotes?: QuoteCandidate[];
  bestMatch?: AgentRecord & { supplier?: SupplierSummary };
  summary?: AgentRecord;
  comparedQuotes?: QuoteCandidate[];
  compareSummary?: AgentRecord;
  rfqNumber?: string;
  quotationNumber?: string;
  unitPrice?: number;
  totalPrice?: number;
  costPrice?: number;
  margin?: number;
  confirmationResult?: string;
  latestConfirmation?: ConfirmationAuditEntry;
  confirmationHistory?: ConfirmationAuditEntry[];
}

export interface TaskStep {
  id: string;
  capability: CapabilityName;
  action: string;
  params: AgentRecord;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: AgentData;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ConfirmationNode {
  id: string;
  taskId: string;
  stepId: string;
  type: 'rfq_confirm' | 'supplier_select' | 'quotation_confirm' | 'approval_confirm';
  title: string;
  titleZh?: string;
  titleEn?: string;
  description: string;
  descriptionZh?: string;
  descriptionEn?: string;
  data: AgentData;
  options: ConfirmationOption[];
  selectedOption?: string;
  confirmedAt?: Date;
  confirmedBy?: string;
}

export interface ConfirmationOption {
  id: string;
  label: string;
  labelZh?: string;
  labelEn?: string;
  description?: string;
  descriptionZh?: string;
  descriptionEn?: string;
  action: string;
  data?: AgentData;
}

export interface AgentTask {
  id: string;
  trigger: {
    type: 'email' | 'manual' | 'scheduled' | 'system';
    source?: string;
    referenceId?: string;
  };
  type: TaskType;
  status: TaskStatus;
  currentStepIndex: number;
  steps: TaskStep[];
  confirmationNode?: ConfirmationNode;
  context: AgentData;
  result?: AgentData;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  error?: string;
}

export interface CapabilityResult<T = AgentData> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: AgentRecord;
}

export interface CapabilityInterface {
  name: CapabilityName;
  execute(action: string, params: AgentRecord, context: AgentData): Promise<CapabilityResult>;
  getStatus(): Promise<{ available: boolean; details?: string }>;
}

export interface EmailCapability {
  receive(accountId: string): Promise<CapabilityResult<unknown[]>>;
  send(to: string, subject: string, body: string, attachments?: string[]): Promise<CapabilityResult>;
  classify(emailId: string): Promise<CapabilityResult<{ type: string; confidence: number }>>;
  parse(emailId: string): Promise<CapabilityResult<unknown>>;
}

export interface RFQCapability {
  create(data: unknown): Promise<CapabilityResult<unknown>>;
  update(id: string, data: unknown): Promise<CapabilityResult<unknown>>;
  getStatus(id: string): Promise<CapabilityResult<unknown>>;
  getByEmail(emailId: string): Promise<CapabilityResult<unknown>>;
}

export interface SourcingCapability {
  matchInventory(rfqId: string): Promise<CapabilityResult<unknown[]>>;
  selectSuppliers(rfqId: string, criteria: unknown): Promise<CapabilityResult<unknown[]>>;
  sendInquiry(rfqId: string, supplierIds: string[]): Promise<CapabilityResult>;
}

export interface SupplierQuoteCapability {
  collect(rfqId: string): Promise<CapabilityResult<unknown[]>>;
  compare(rfqId: string): Promise<CapabilityResult<{
    quotes: unknown[];
    bestMatch: unknown;
    summary: unknown;
  }>>;
  selectWinner(quoteId: string): Promise<CapabilityResult>;
}

export interface QuotationCapability {
  create(rfqId: string, data: unknown): Promise<CapabilityResult<unknown>>;
  send(quotationId: string): Promise<CapabilityResult>;
  resend(quotationId: string): Promise<CapabilityResult>;
}

export interface ApprovalCapability {
  request(quotationId: string, approvers: string[]): Promise<CapabilityResult>;
  approve(taskId: string, comment?: string): Promise<CapabilityResult>;
  reject(taskId: string, reason: string): Promise<CapabilityResult>;
  getStatus(taskId: string): Promise<CapabilityResult<unknown>>;
}

export interface OrderCapability {
  create(quotationId: string, data: unknown): Promise<CapabilityResult<unknown>>;
  track(orderId: string): Promise<CapabilityResult<unknown>>;
  updateStatus(orderId: string, status: string, data?: unknown): Promise<CapabilityResult>;
  complete(orderId: string): Promise<CapabilityResult>;
}

export interface NotificationCapability {
  alert(type: string, title: string, message: string, recipients: string[]): Promise<CapabilityResult>;
  remind(userId: string, taskId: string): Promise<CapabilityResult>;
}

export interface AgentDashboard {
  tasks: {
    total: number;
    running: number;
    pending: number;
    waitingConfirmation: number;
    completedToday: number;
    failedToday: number;
  };
  pipeline: {
    emailsReceived: number;
    rfqsCreated: number;
    quotationsSent: number;
    ordersCompleted: number;
  };
  pendingConfirmations: ConfirmationNode[];
  recentTasks: AgentTask[];
  alerts: Array<{
    type: 'warning' | 'error' | 'info';
    message: string;
    timestamp: Date;
  }>;
}
