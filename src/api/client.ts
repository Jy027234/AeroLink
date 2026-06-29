// ============================================
// AeroLink API Client - 真实后端API调用
// ============================================

import type {
  AgentTask,
  ConfirmationNode,
  ConfirmationOption,
  TaskStep,
} from '@/types/agent';
import type {
  User,
  RFQ,
  Quotation,
  Order,
  InventoryItem,
  InventoryDetail,
  DocumentTemplate,
  GeneratedDocument,
  Inventory,
  Customer,
  Supplier,
  SupplierFollowUpAction,
  SupplierFollowUpLog,
  SupplierFollowUpOutcome,
  Email,
  Notification as AppNotification,
  Certificate,
  CertificateTemplate,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowInstanceStep,
} from '@/types';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

type ApiRecord = Record<string, unknown>;
type ApiPayload = object;

export interface AuthSuccessResponse {
  token: string;
  refreshToken: string;
  user: User;
}

export interface ActivationInfo {
  email: string;
  name: string;
  activationExpiresAt: string;
}

export interface ResetInfo {
  email: string;
  name: string;
  resetExpiresAt: string;
}

export type AuthEmailDeliveryStatus = 'sent' | 'failed' | 'skipped';

export interface AuthEmailDeliveryRecord {
  id: string;
  purpose: string;
  deliveryStatus: AuthEmailDeliveryStatus | 'pending';
  toEmail: string;
  subject: string;
  accountEmail?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  sentAt?: string | null;
}

export interface AuthEmailDeliveryHistory {
  items: AuthEmailDeliveryRecord[];
  summary: {
    total: number;
    sent: number;
    failed: number;
    skipped: number;
    pending: number;
  };
}

export interface UserOnboardingResponse {
  user: User;
  activationToken: string;
  activationLink: string;
  activationExpiresAt: string;
  emailDeliveryStatus: AuthEmailDeliveryStatus;
  emailDeliveryError?: string;
  outboundEmailId?: string;
}

export interface SupplierFollowUpLogCreateInput {
  supplierId: string;
  taskId: string;
  rfqId?: string;
  rfqNumber?: string;
  actionType: SupplierFollowUpAction;
  outcome: SupplierFollowUpOutcome;
  notes?: string;
  preferredChannel?: 'email' | 'phone' | 'manual';
}

export interface ClientAIAgent {
  id: string;
  name: string;
  type: string;
  description: string | null;
  isActive: boolean;
  config: Record<string, unknown>;
  prompts: Array<{ role: string; content: string }>;
}

export interface AgentAuditLog {
  id: string;
  agentId: string;
  action: string;
  input?: string | null;
  output?: string | null;
  status: string;
  error?: string | null;
  duration?: number | null;
  createdAt: string;
}

export interface ClientAIModel {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string | null;
  baseUrl: string | null;
  isActive: boolean;
  isDefault: boolean;
  config: Record<string, unknown>;
  capabilities: string[];
}

interface RuntimeConfirmationOptionPayload {
  id: string;
  label: string;
  labelZh?: string;
  labelEn?: string;
  description?: string;
  descriptionZh?: string;
  descriptionEn?: string;
  action: string;
  data?: Record<string, unknown>;
}

interface RuntimeConfirmationPayload {
  id: string;
  taskId: string;
  stepId: string;
  type: ConfirmationNode['type'];
  title: string;
  titleZh?: string;
  titleEn?: string;
  description: string;
  descriptionZh?: string;
  descriptionEn?: string;
  data: Record<string, unknown>;
  options: RuntimeConfirmationOptionPayload[];
  selectedOption?: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

interface RuntimeTaskStepPayload {
  id: string;
  capability: TaskStep['capability'];
  action: string;
  params: Record<string, unknown>;
  status: TaskStep['status'];
  result?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface RuntimeTaskPayload {
  id: string;
  trigger: {
    type: AgentTask['trigger']['type'];
    source?: string;
    referenceId?: string;
  };
  type: AgentTask['type'];
  status: AgentTask['status'];
  currentStepIndex: number;
  steps: RuntimeTaskStepPayload[];
  confirmationNode?: RuntimeConfirmationPayload;
  context: Record<string, unknown>;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

function toIsoDate(value?: Date | string): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  return value.toISOString();
}

function toDate(value?: string): Date | undefined {
  return value ? new Date(value) : undefined;
}

function cloneRecord<T extends Record<string, unknown> | undefined>(value: T): T | undefined {
  if (!value) return undefined;
  return JSON.parse(JSON.stringify(value)) as T;
}

function serializeConfirmationOption(option: ConfirmationOption): RuntimeConfirmationOptionPayload {
  return {
    id: option.id,
    label: option.label,
    labelZh: option.labelZh,
    labelEn: option.labelEn,
    description: option.description,
    descriptionZh: option.descriptionZh,
    descriptionEn: option.descriptionEn,
    action: option.action,
    data: cloneRecord(option.data),
  };
}

function serializeConfirmationNode(confirmation: ConfirmationNode): RuntimeConfirmationPayload {
  return {
    id: confirmation.id,
    taskId: confirmation.taskId,
    stepId: confirmation.stepId,
    type: confirmation.type,
    title: confirmation.title,
    titleZh: confirmation.titleZh,
    titleEn: confirmation.titleEn,
    description: confirmation.description,
    descriptionZh: confirmation.descriptionZh,
    descriptionEn: confirmation.descriptionEn,
    data: cloneRecord(confirmation.data) || {},
    options: confirmation.options.map(serializeConfirmationOption),
    selectedOption: confirmation.selectedOption,
    confirmedAt: toIsoDate(confirmation.confirmedAt),
    confirmedBy: confirmation.confirmedBy,
  };
}

function serializeTaskStep(step: TaskStep): RuntimeTaskStepPayload {
  return {
    id: step.id,
    capability: step.capability,
    action: step.action,
    params: cloneRecord(step.params) || {},
    status: step.status,
    result: cloneRecord(step.result),
    error: step.error,
    startedAt: toIsoDate(step.startedAt),
    completedAt: toIsoDate(step.completedAt),
  };
}

function serializeAgentTask(task: AgentTask): RuntimeTaskPayload {
  return {
    id: task.id,
    trigger: {
      type: task.trigger.type,
      source: task.trigger.source,
      referenceId: task.trigger.referenceId,
    },
    type: task.type,
    status: task.status,
    currentStepIndex: task.currentStepIndex,
    steps: task.steps.map(serializeTaskStep),
    confirmationNode: task.confirmationNode ? serializeConfirmationNode(task.confirmationNode) : undefined,
    context: cloneRecord(task.context) || {},
    result: cloneRecord(task.result),
    createdAt: toIsoDate(task.createdAt) || new Date().toISOString(),
    updatedAt: toIsoDate(task.updatedAt) || new Date().toISOString(),
    completedAt: toIsoDate(task.completedAt),
    error: task.error,
  };
}

function deserializeConfirmationOption(option: RuntimeConfirmationOptionPayload): ConfirmationOption {
  return {
    id: option.id,
    label: option.label,
    labelZh: option.labelZh,
    labelEn: option.labelEn,
    description: option.description,
    descriptionZh: option.descriptionZh,
    descriptionEn: option.descriptionEn,
    action: option.action,
    data: cloneRecord(option.data),
  };
}

function deserializeConfirmationNode(confirmation: RuntimeConfirmationPayload): ConfirmationNode {
  return {
    id: confirmation.id,
    taskId: confirmation.taskId,
    stepId: confirmation.stepId,
    type: confirmation.type,
    title: confirmation.title,
    titleZh: confirmation.titleZh,
    titleEn: confirmation.titleEn,
    description: confirmation.description,
    descriptionZh: confirmation.descriptionZh,
    descriptionEn: confirmation.descriptionEn,
    data: cloneRecord(confirmation.data) || {},
    options: confirmation.options.map(deserializeConfirmationOption),
    selectedOption: confirmation.selectedOption,
    confirmedAt: toDate(confirmation.confirmedAt),
    confirmedBy: confirmation.confirmedBy,
  };
}

function deserializeTaskStep(step: RuntimeTaskStepPayload): TaskStep {
  return {
    id: step.id,
    capability: step.capability,
    action: step.action,
    params: cloneRecord(step.params) || {},
    status: step.status,
    result: cloneRecord(step.result),
    error: step.error,
    startedAt: toDate(step.startedAt),
    completedAt: toDate(step.completedAt),
  };
}

function deserializeAgentTask(task: RuntimeTaskPayload): AgentTask {
  return {
    id: task.id,
    trigger: {
      type: task.trigger.type,
      source: task.trigger.source,
      referenceId: task.trigger.referenceId,
    },
    type: task.type,
    status: task.status,
    currentStepIndex: task.currentStepIndex,
    steps: task.steps.map(deserializeTaskStep),
    confirmationNode: task.confirmationNode ? deserializeConfirmationNode(task.confirmationNode) : undefined,
    context: cloneRecord(task.context) || {},
    result: cloneRecord(task.result),
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
    completedAt: toDate(task.completedAt),
    error: task.error,
  };
}

export interface SupplierQuoteItem {
  id: string;
  rfqId: string | null;
  inquiryId: string | null;
  partNumber: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  leadTimeDays: number;
  validUntil: string | null;
  notes: string | null;
  status: string;
  isWinner: boolean;
  aiScore: number | null;
  aiRecommendation: string | null;
  createdAt: string;
  supplier: {
    id: string;
    name: string;
    level: string;
    performanceScore: number;
    contactName: string | null;
    contactEmail: string | null;
  };
}

interface SupplierQuoteComparedItem {
  id: string;
  partNumber: string;
  supplier: {
    id: string;
    name: string;
    level: string;
    performanceScore: number;
  };
  unitPrice: number;
  totalPrice: number;
  quantity: number;
  leadTimeDays: number;
  priceDiff: string;
  isLowestPrice: boolean;
  scores: {
    price: number;
    leadTime: number;
    supplier: number;
    quality: number;
    response: number;
  };
  aiScore: number;
  aiRecommendation: string;
  status: string;
  isWinner: boolean;
}

export interface SupplierQuoteCompareResult {
  quotes: SupplierQuoteComparedItem[];
  bestMatch: SupplierQuoteComparedItem;
  summary: {
    totalQuotes: number;
    lowestPrice: number;
    highestPrice: number;
    averagePrice: number;
  };
}

class ApiException extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ApiException';
    this.statusCode = statusCode;
  }
}

let unauthorizedRedirecting = false;

async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  signal?: AbortSignal
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const token = localStorage.getItem('aerolink_token');

  const config: RequestInit = {
    ...options,
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  };

  try {
    const response = await fetch(url, config);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      if (response.status === 404) {
        throw new ApiException(`接口不存在: ${endpoint}`, 404);
      }
      throw new ApiException(
        response.ok
          ? `接口 ${endpoint} 返回了非 JSON 响应`
          : `请求失败 (${response.status}): ${text.slice(0, 100)}`,
        response.status
      );
    }
    const data = await response.json();
    const isAuthRequest =
      endpoint === '/auth/login' ||
      endpoint === '/auth/refresh' ||
      endpoint === '/auth/forgot-password' ||
      endpoint === '/auth/activate' ||
      endpoint === '/auth/reset-password' ||
      endpoint.startsWith('/auth/activation/') ||
      endpoint.startsWith('/auth/reset/');

    if (response.status === 401) {
      if (!isAuthRequest) {
        localStorage.removeItem('aerolink_token');
        localStorage.removeItem('aerolink_user');
        localStorage.removeItem('aerolink_refresh_token');
        localStorage.removeItem('auth-storage');
        if (!unauthorizedRedirecting) {
          unauthorizedRedirecting = true;
          window.location.replace('/');
        }
      }
      throw new ApiException(data.message || '登录已过期，请重新登录', 401);
    }

    if (!response.ok) {
      throw new ApiException(data.message || '请求失败', response.status);
    }

    // 兼容两类后端响应:
    // 1) { success: true, data: ... }
    // 2) 直接返回业务对象或 { data: ... }
    if (typeof data === 'object' && data !== null && 'success' in data) {
      const wrapped = data as { success?: boolean; message?: string; data?: T };
      if (!wrapped.success) {
        throw new ApiException(wrapped.message || '请求失败');
      }
      return (wrapped.data as T) ?? (data as T);
    }

    if (typeof data === 'object' && data !== null && 'data' in data) {
      return (data as { data: T }).data;
    }

    return data as T;
  } catch (error) {
    if (error instanceof ApiException) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiException('请求已取消');
    }
    throw new ApiException(
      error instanceof Error ? error.message : '网络错误，请检查服务器是否启动'
    );
  }
}

async function requestBlob(
  endpoint: string,
  options: RequestInit = {},
  signal?: AbortSignal
): Promise<Blob> {
  const url = `${API_BASE_URL}${endpoint}`;
  const token = localStorage.getItem('aerolink_token');

  const headers = new Headers(options.headers || undefined);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/pdf, application/octet-stream');
  }

  const response = await fetch(url, {
    ...options,
    signal,
    headers,
  });

  if (response.status === 401) {
    localStorage.removeItem('aerolink_token');
    localStorage.removeItem('aerolink_user');
    localStorage.removeItem('aerolink_refresh_token');
    localStorage.removeItem('auth-storage');
    if (!unauthorizedRedirecting) {
      unauthorizedRedirecting = true;
      window.location.replace('/');
    }
    throw new ApiException('登录已过期，请重新登录', 401);
  }

  if (!response.ok) {
    throw new ApiException('文件下载失败', response.status);
  }

  return response.blob();
}

export interface InboundWebhookEndpoint {
  id: string;
  name: string;
  sourceSystem: string;
  urlPath: string;
  authMethod: 'HMAC' | 'API_KEY' | 'NONE' | string;
  secret: string | null;
  isActive: boolean;
  createdBy?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface InboundWebhookDelivery {
  id: string;
  endpointId: string;
  payload: string;
  status: string;
  errorMessage?: string | null;
  attempts: number;
  processedAt?: string | null;
  receivedAt: string;
}

export interface WebhookAuditLogItem {
  id: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  changes?: string | null;
  sourceIp?: string | null;
  createdAt: string;
}

export interface WebhookDLQItem {
  id: string;
  endpointId: string;
  status: string;
  failureReason?: string | null;
  lastError?: string | null;
  retryCount: number;
  createdAt: string;
}

export interface AuditLogItem {
  id: string;
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  resourceName?: string | null;
  changes?: string | null;
  details?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  status: string;
  errorMessage?: string | null;
  createdAt: string;
}

export interface AuditLogStats {
  actionsByType: { action: string; count: number }[];
  resourcesByType: { resourceType: string; count: number }[];
  dailyTrend: { date: string; count: number }[];
  totalToday: number;
  failedToday: number;
  topUsers: { userId: string | null; userName: string | null; count: number }[];
  topResourceTypes: { resourceType: string; count: number }[];
}

export interface PaginatedAuditLogs {
  data: AuditLogItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ===== Audit Log API =====
export const auditLogApi = {
  getAll: async (filters?: {
    page?: number;
    limit?: number;
    userId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
  }) => {
    const params = new URLSearchParams();
    if (filters?.page) params.append('page', String(filters.page));
    if (filters?.limit) params.append('limit', String(filters.limit));
    if (filters?.userId) params.append('userId', filters.userId);
    if (filters?.action) params.append('action', filters.action);
    if (filters?.resourceType) params.append('resourceType', filters.resourceType);
    if (filters?.resourceId) params.append('resourceId', filters.resourceId);
    if (filters?.status) params.append('status', filters.status);
    if (filters?.startDate) params.append('startDate', filters.startDate);
    if (filters?.endDate) params.append('endDate', filters.endDate);
    if (filters?.search) params.append('search', filters.search);
    const query = params.toString();
    return request<PaginatedAuditLogs>(`/audit-logs${query ? `?${query}` : ''}`);
  },

  getById: async (id: string) => {
    return request<AuditLogItem>(`/audit-logs/${id}`);
  },

  getStats: async () => {
    return request<AuditLogStats>('/audit-logs/stats');
  },

  getByResource: async (type: string, id: string, page?: number, limit?: number) => {
    const params = new URLSearchParams();
    if (page) params.append('page', String(page));
    if (limit) params.append('limit', String(limit));
    const query = params.toString();
    return request<PaginatedAuditLogs>(`/audit-logs/resource/${type}/${id}${query ? `?${query}` : ''}`);
  },

  getByUser: async (userId: string, page?: number, limit?: number) => {
    const params = new URLSearchParams();
    if (page) params.append('page', String(page));
    if (limit) params.append('limit', String(limit));
    const query = params.toString();
    return request<PaginatedAuditLogs>(`/audit-logs/user/${userId}${query ? `?${query}` : ''}`);
  },

  create: async (data: {
    action: string;
    resourceType: string;
    resourceId?: string;
    resourceName?: string;
    changes?: Record<string, unknown>;
    details?: string;
    status?: string;
    errorMessage?: string;
  }) => {
    return request<AuditLogItem>('/audit-logs', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
};

// ===== Pricing / AI Recommendation API =====
export interface PriceRecommendation {
  partNumber: string;
  quantity: number;
  customerId?: string;
  historicalStats: {
    avgPrice: number;
    minPrice: number;
    maxPrice: number;
    medianPrice: number;
    transactionCount: number;
    lastTransactionDate: string | null;
    priceTrend: 'up' | 'down' | 'stable';
    trendPercent: number;
  };
  recommendedPrice: number;
  priceRange: {
    low: number;
    high: number;
  };
  discountAnalysis: {
    customerTierDiscount: number;
    volumeDiscount: number;
    paymentTermDiscount: number;
    totalDiscount: number;
  };
  winProbability: number;
  winProbabilityFactors: {
    priceFactor: number;
    customerFactor: number;
    marketFactor: number;
  };
  generatedAt: string;
}

export interface PriceHistoryTrend {
  partNumber: string;
  dataPoints: Array<{
    date: string;
    price: number;
    quantity: number;
    type: 'quotation' | 'order';
  }>;
  summary: {
    totalTransactions: number;
    firstTransactionDate: string | null;
    lastTransactionDate: string | null;
  };
}

export const pricingApi = {
  getRecommendation: async (params: {
    partNumber: string;
    quantity: number;
    customerId?: string;
    proposedPrice?: number;
  }) => {
    const search = new URLSearchParams();
    search.append('partNumber', params.partNumber);
    search.append('quantity', String(params.quantity));
    if (params.customerId) search.append('customerId', params.customerId);
    if (params.proposedPrice) search.append('proposedPrice', String(params.proposedPrice));
    return request<PriceRecommendation>(`/pricing/recommendation?${search.toString()}`);
  },

  getBatchRecommendations: async (items: Array<{ partNumber: string; quantity: number; customerId?: string }>) => {
    return request<PriceRecommendation[]>('/pricing/recommendations/batch', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  },

  getPriceHistory: async (partNumber: string) => {
    return request<PriceHistoryTrend>(`/pricing/history/${encodeURIComponent(partNumber)}`);
  },
};


// ===== Auth API =====
export const authApi = {
  login: async (email: string, password: string) => {
    return request<AuthSuccessResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  refresh: async (refreshToken: string) => {
    return request<{ accessToken: string; refreshToken: string }>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
  },

  getMe: async () => {
    return request<User>('/auth/me');
  },

  updateMe: async (data: ApiPayload) => {
    return request<User>('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  changePassword: async (data: { currentPassword: string; newPassword: string }) => {
    return request<ApiRecord>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  getActivationInfo: async (token: string) => {
    return request<ActivationInfo>(`/auth/activation/${encodeURIComponent(token)}`);
  },

  activateAccount: async (token: string, password: string) => {
    return request<AuthSuccessResponse>('/auth/activate', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  },

  forgotPassword: async (email: string) => {
    return request<{ message: string }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  getResetInfo: async (token: string) => {
    return request<ResetInfo>(`/auth/reset/${encodeURIComponent(token)}`);
  },

  resetPassword: async (token: string, password: string) => {
    return request<AuthSuccessResponse>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  },
};

// ===== User Management API =====
export const userApi = {
  getAll: async () => {
    return request<User[]>('/users');
  },

  getById: async (id: string) => {
    return request<User>(`/users/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<UserOnboardingResponse>('/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<User>(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  regenerateActivationLink: async (id: string) => {
    return request<UserOnboardingResponse>(`/users/${id}/activation-link`, {
      method: 'POST',
    });
  },

  delete: async (id: string) => {
    return request<ApiRecord>(`/users/${id}`, {
      method: 'DELETE',
    });
  },
};

// ===== Dashboard API =====
export const dashboardApi = {
  getStats: async () => {
    return request<{
      pendingRFQs: number;
      pendingQuotes: number;
      pendingApprovals: number;
      weeklyRevenue: number;
      rfqTrend: number;
      quoteTrend: number;
      approvalTrend: number;
      revenueTrend: number;
    }>('/dashboard/stats');
  },

  getFunnel: async () => {
    return request<{ stage: string; count: number; amount: number }[]>('/dashboard/funnel');
  },

  getActivities: async () => {
    return request<{ id: string; type: string; description: string; timestamp: string }[]>(
      '/dashboard/activities'
    );
  },
};

// ===== Report API =====
export interface SalesTrendItem {
  month: string;
  rfqs: number;
  quotes: number;
  orders: number;
  revenue: number;
}

export interface ConversionAnalysis {
  overallRate: number;
  avgOrderValue: number;
  avgMargin: number;
  avgResponseTime: number;
  lostReasons: { name: string; value: number; color: string }[];
}

export interface CustomerContributionItem {
  name: string;
  value: number;
}

export interface InventoryTurnoverItem {
  category: string;
  days: number;
  target: number;
}

export interface ReportSummary {
  rfqsThisMonth: number;
  rfqTrend: number;
  quotesThisMonth: number;
  quoteTrend: number;
  ordersThisMonth: number;
  orderTrend: number;
  revenueThisMonth: number;
  revenueTrend: number;
  activeCustomers: number;
  customerRetention: number;
  avgCustomerValue: number;
  totalInventoryValue: number;
  avgTurnoverDays: number;
  slowMovingValue: number;
  slowMovingShare: number;
  inventoryAlerts: number;
}

export const reportApi = {
  getSummary: async () => {
    return request<ReportSummary>('/reports/summary');
  },

  getSalesTrend: async (months?: number) => {
    const search = new URLSearchParams();
    if (months) search.append('months', String(months));
    return request<SalesTrendItem[]>(`/reports/sales-trend?${search.toString()}`);
  },

  getConversionAnalysis: async () => {
    return request<ConversionAnalysis>('/reports/conversion');
  },

  getCustomerContribution: async () => {
    return request<CustomerContributionItem[]>('/reports/customer-contribution');
  },

  getInventoryTurnover: async () => {
    return request<InventoryTurnoverItem[]>('/reports/inventory-turnover');
  },
};

// ===== IPC API =====
export const ipcApi = {
  search: async (q: string) => {
    return request<{ id: string; partNumber: string; description: string; ataChapter: string; aircraftTypes: string[]; supersededBy?: string; interchangeableWith: string[]; alternateParts: string[] }[]>(`/ipc/search?q=${encodeURIComponent(q)}`);
  },

  getByPartNumber: async (partNumber: string) => {
    return request<{ id: string; partNumber: string; description: string; ataChapter: string; aircraftTypes: string[]; supersededBy?: string; interchangeableWith: string[]; alternateParts: string[] }>(`/ipc/${encodeURIComponent(partNumber)}`);
  },
};

// ===== RFQ API =====
export const rfqApi = {
  getAll: async (filters?: { status?: string; urgency?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.append('status', filters.status);
    if (filters?.urgency) params.append('urgency', filters.urgency);
    const query = params.toString();
    return request<RFQ[]>(`/rfqs${query ? `?${query}` : ''}`);
  },

  getById: async (id: string) => {
    return request<RFQ>(`/rfqs/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<RFQ>('/rfqs', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<RFQ>(`/rfqs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  updateStatus: async (id: string, status: string) => {
    return request<ApiRecord>(`/rfqs/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },
};

// ===== Quotation API =====
export const quotationApi = {
  getAll: async (filters?: { status?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.append('status', filters.status);
    const query = params.toString();
    return request<Quotation[]>(`/quotations${query ? `?${query}` : ''}`);
  },

  getById: async (id: string) => {
    return request<Quotation>(`/quotations/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<Quotation>('/quotations', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  submitForApproval: async (id: string) => {
    return request<ApiRecord>(`/quotations/${id}/submit`, {
      method: 'POST',
    });
  },

  approve: async (id: string, action: 'approve' | 'reject') => {
    return request<ApiRecord>(`/quotations/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
  },

  send: async (id: string, data?: { subject?: string; message?: string }) => {
    return request<ApiRecord>(`/quotations/${id}/send`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
  },

  withdraw: async (id: string, data: { reason: string; sendWithdrawalNotice?: boolean }) => {
    return request<ApiRecord>(`/quotations/${id}/withdraw`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  accept: async (id: string, data?: { poNumber?: string; deliveryDate?: string; templateId?: string; confirmationNote?: string }) => {
    return request<ApiRecord>(`/quotations/${id}/accept`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
  },

  getPdfBlob: async (id: string) => {
    return requestBlob(`/quotations/${id}/pdf`, {
      method: 'GET',
    });
  },
};

// ===== Order API =====
export const orderApi = {
  getAll: async () => {
    return request<Order[]>('/orders');
  },

  getById: async (id: string) => {
    return request<Order>(`/orders/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<Order>('/orders', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<Order>(`/orders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  updateStatus: async (id: string, status: string) => {
    return request<ApiRecord>(`/orders/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },
};

export const documentTemplateApi = {
  getAll: async (params?: { documentType?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.documentType) searchParams.append('documentType', params.documentType);
    const query = searchParams.toString();
    return request<DocumentTemplate[]>(`/document-templates${query ? `?${query}` : ''}`);
  },

  getById: async (id: string) => {
    return request<DocumentTemplate>(`/document-templates/${id}`);
  },

  create: async (data: Partial<DocumentTemplate>) => {
    return request<DocumentTemplate>('/document-templates', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: Partial<DocumentTemplate>) => {
    return request<DocumentTemplate>(`/document-templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
};

export const documentApi = {
  getAll: async (params?: { quotationId?: string; orderId?: string; documentType?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.quotationId) searchParams.append('quotationId', params.quotationId);
    if (params?.orderId) searchParams.append('orderId', params.orderId);
    if (params?.documentType) searchParams.append('documentType', params.documentType);
    const query = searchParams.toString();
    return request<GeneratedDocument[]>(`/documents${query ? `?${query}` : ''}`);
  },

  getById: async (id: string) => {
    return request<GeneratedDocument>(`/documents/${id}`);
  },

  getPdfBlob: async (id: string) => {
    return requestBlob(`/documents/${id}/pdf`, { method: 'GET' });
  },
};

// ===== Inventory API =====
export const inventoryApi = {
  getAll: async () => {
    return request<Inventory[]>('/inventory');
  },

  getById: async (id: string) => {
    return request<Inventory>(`/inventory/${id}`);
  },

  getByPartNumber: async (partNumber: string) => {
    return request<Inventory[]>(`/inventory/part/${partNumber}`);
  },

  create: async (data: ApiPayload) => {
    return request<Inventory>('/inventory', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<ApiRecord>(`/inventory/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
};

// ===== Phase 3: 库存明细层 API =====
export const inventoryItemApi = {
  getAll: async () => {
    return request<InventoryItem[]>('/inventory-items');
  },

  getById: async (id: string) => {
    return request<InventoryItem>(`/inventory-items/${id}`);
  },

  getByPartNumber: async (partNumber: string) => {
    return request<InventoryItem>(`/inventory-items/part/${partNumber}`);
  },

  create: async (data: ApiPayload) => {
    return request<InventoryItem>('/inventory-items', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<InventoryItem>(`/inventory-items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
};

export const inventoryDetailApi = {
  getAll: async () => {
    return request<InventoryDetail[]>('/inventory-details');
  },

  getByItemId: async (itemId: string) => {
    return request<InventoryDetail[]>(`/inventory-details/item/${itemId}`);
  },

  getById: async (id: string) => {
    return request<InventoryDetail>(`/inventory-details/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<InventoryDetail>('/inventory-details', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<InventoryDetail>(`/inventory-details/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
};

// ===== Customer API =====
export const customerApi = {
  getAll: async () => {
    return request<Customer[]>('/customers');
  },

  getById: async (id: string) => {
    return request<Customer>(`/customers/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<Customer>('/customers', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<Customer>(`/customers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
};

// ===== Supplier API =====
export const supplierApi = {
  getAll: async (params?: { level?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.level) searchParams.append('level', params.level);
    if (params?.page) searchParams.append('page', String(params.page));
    if (params?.limit) searchParams.append('limit', String(params.limit));
    const query = searchParams.toString();
    return request<Supplier[]>(`/suppliers${query ? `?${query}` : ''}`);
  },

  getById: async (id: string) => {
    return request<Supplier>(`/suppliers/${id}`);
  },

  getFollowUpLogs: async (params?: { supplierId?: string; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.supplierId) searchParams.append('supplierId', params.supplierId);
    if (params?.limit) searchParams.append('limit', String(params.limit));
    const query = searchParams.toString();
    return request<SupplierFollowUpLog[]>(`/suppliers/follow-up-logs${query ? `?${query}` : ''}`);
  },

  createFollowUpLogs: async (data: { logs: SupplierFollowUpLogCreateInput[] }) => {
    return request<SupplierFollowUpLog[]>('/suppliers/follow-up-logs', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  create: async (data: {
    name: string;
    contactName: string;
    email?: string;
    phone?: string;
    address?: string;
    level?: 'S' | 'A' | 'B' | 'C';
    paymentTerms?: string;
    leadTime?: number;
    supplierType?: 'OEM' | 'MRO' | 'Distributor' | 'Broker' | '145RepairStation';
    cageCode?: string;
    caac145CertificateNo?: string;
    caac145CertificateUrl?: string;
    pmaHolder?: boolean;
    ctsoaHolder?: boolean;
    oemAuthorized?: boolean;
    oemAuthorizationUrl?: string;
    qualityApprovalExpiry?: string;
    lastAuditDate?: string;
    nextAuditDue?: string;
    approvedPartCategories?: string | string[];
    specializesInAircraft?: string | string[];
    incotermsOffered?: string | string[];
    leadTimeAverage?: number;
    onTimeDeliveryRate?: number;
    certificateTypesProvided?: string | string[];
    moqPolicy?: string;
    warrantyPolicy?: string;
    returnPolicy?: string;
    bankAccountInfo?: string;
  }) => {
    return request<Supplier>('/suppliers', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: {
    name?: string;
    contactName?: string;
    email?: string;
    phone?: string;
    address?: string;
    level?: 'S' | 'A' | 'B' | 'C';
    paymentTerms?: string;
    leadTime?: number;
    supplierType?: 'OEM' | 'MRO' | 'Distributor' | 'Broker' | '145RepairStation';
    cageCode?: string;
    caac145CertificateNo?: string;
    caac145CertificateUrl?: string;
    pmaHolder?: boolean;
    ctsoaHolder?: boolean;
    oemAuthorized?: boolean;
    oemAuthorizationUrl?: string;
    qualityApprovalExpiry?: string;
    lastAuditDate?: string;
    nextAuditDue?: string;
    approvedPartCategories?: string | string[];
    specializesInAircraft?: string | string[];
    incotermsOffered?: string | string[];
    leadTimeAverage?: number;
    onTimeDeliveryRate?: number;
    certificateTypesProvided?: string | string[];
    moqPolicy?: string;
    warrantyPolicy?: string;
    returnPolicy?: string;
    bankAccountInfo?: string;
  }) => {
    return request<Supplier>(`/suppliers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  invite: async (data: { email: string; message?: string }) => {
    return request<ApiRecord>('/suppliers/invite', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
};

// ===== Supplier Quote API =====
export const supplierQuoteApi = {
  getAll: async (filters?: { rfqId?: string; inquiryId?: string; status?: string; partNumber?: string }) => {
    const params = new URLSearchParams();
    if (filters?.rfqId) params.append('rfqId', filters.rfqId);
    if (filters?.inquiryId) params.append('inquiryId', filters.inquiryId);
    if (filters?.status) params.append('status', filters.status);
    if (filters?.partNumber) params.append('partNumber', filters.partNumber);
    const query = params.toString();
    return request<SupplierQuoteItem[]>(`/supplier-quotes${query ? `?${query}` : ''}`);
  },

  getById: async (id: string) => {
    return request<SupplierQuoteItem>(`/supplier-quotes/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<SupplierQuoteItem>('/supplier-quotes', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<SupplierQuoteItem>(`/supplier-quotes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  compare: async (body: { rfqId?: string; inquiryId?: string }) => {
    return request<SupplierQuoteCompareResult>('/supplier-quotes/compare', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  selectWinner: async (id: string) => {
    return request<SupplierQuoteItem>(`/supplier-quotes/${id}/select-winner`, {
      method: 'POST',
    });
  },
};

// ===== Notification API =====
export const notificationApi = {
  getAll: async () => {
    return request<AppNotification[]>('/notifications');
  },

  getUnreadCount: async () => {
    return request<{ count: number }>('/notifications/unread-count');
  },

  markAsRead: async (id: string) => {
    return request<ApiRecord>(`/notifications/${id}/read`, {
      method: 'PATCH',
    });
  },

  markAllAsRead: async () => {
    return request<ApiRecord>('/notifications/read-all', {
      method: 'PATCH',
    });
  },
};

// ===== Notification Preference API =====
export interface NotificationPreference {
  id: string;
  userId: string;
  emailNotify: boolean;
  systemNotify: boolean;
  approvalNotify: boolean;
  aogAlert: boolean;
  weeklyReport: boolean;
  wechatNotify: boolean;
  dingtalkNotify: boolean;
  larkNotify: boolean;
  smsNotify: boolean;
  pushNotify: boolean;
  slackNotify: boolean;
  teamsNotify: boolean;
  createdAt: string;
  updatedAt: string;
}

export const notificationPreferenceApi = {
  getMine: async () => {
    return request<NotificationPreference>('/notification-preferences/mine');
  },

  updateMine: async (data: Partial<NotificationPreference>) => {
    return request<NotificationPreference>('/notification-preferences/mine', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
};

// ===== Email API =====
export const emailApi = {
  getAll: async (filters?: { type?: string; isRead?: boolean }) => {
    const params = new URLSearchParams();
    if (filters?.type) params.append('type', filters.type);
    if (filters?.isRead !== undefined) params.append('isRead', String(filters.isRead));
    const query = params.toString();
    return request<Email[]>(`/emails${query ? `?${query}` : ''}`);
  },

  getById: async (id: string) => {
    return request<Email>(`/emails/${id}`);
  },

  markAsRead: async (id: string) => {
    return request<ApiRecord>(`/emails/${id}/read`, {
      method: 'PATCH',
    });
  },

  classify: async (id: string, type: string) => {
    return request<ApiRecord>(`/emails/${id}/classify`, {
      method: 'PATCH',
      body: JSON.stringify({ type }),
    });
  },
};

// ===== Email Account API =====
export const emailAccountApi = {
  getAll: async (params?: { page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.append('page', String(params.page));
    if (params?.limit) searchParams.append('limit', String(params.limit));
    const query = searchParams.toString();
    return request<ApiRecord>(`/email-accounts${query ? `?${query}` : ''}`);
  },

  getById: async (id: string) => {
    return request<ApiRecord>(`/email-accounts/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<ApiRecord>('/email-accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<ApiRecord>(`/email-accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  delete: async (id: string) => {
    return request<ApiRecord>(`/email-accounts/${id}`, {
      method: 'DELETE',
    });
  },

  test: async (id: string) => {
    return request<{ imap: boolean; smtp: boolean }>(`/email-accounts/${id}/test`, {
      method: 'POST',
    });
  },

  sync: async (id: string) => {
    return request<ApiRecord>(`/email-accounts/${id}/sync`, {
      method: 'POST',
    });
  },

  getAuthDeliveryHistory: async (limit = 10) => {
    const searchParams = new URLSearchParams({ limit: String(limit) });
    return request<AuthEmailDeliveryHistory>(`/email-accounts/auth-deliveries?${searchParams.toString()}`);
  },
};

// ===== Agents API =====
export const agentApi = {
  getAll: async () => {
    return request<ClientAIAgent[]>('/agents');
  },

  getById: async (id: string) => {
    return request<ClientAIAgent>(`/agents/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<ClientAIAgent>('/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<ClientAIAgent>(`/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  delete: async (id: string) => {
    return request<ApiRecord>(`/agents/${id}`, {
      method: 'DELETE',
    });
  },

  toggle: async (id: string) => {
    return request<ClientAIAgent>(`/agents/${id}/toggle`, {
      method: 'POST',
    });
  },

  getLogs: async (id: string) => {
    return request<AgentAuditLog[]>(`/agents/${id}/logs`);
  },
};

export const agentRuntimeApi = {
  getTasks: async (params?: {
    status?: AgentTask['status'];
    type?: AgentTask['type'];
    limit?: number;
  }) => {
    const search = new URLSearchParams();
    if (params?.status) search.append('status', params.status);
    if (params?.type) search.append('type', params.type);
    if (params?.limit) search.append('limit', String(params.limit));
    const query = search.toString();
    const tasks = await request<RuntimeTaskPayload[]>(`/agents/runtime/tasks${query ? `?${query}` : ''}`);
    return tasks.map(deserializeAgentTask);
  },

  getById: async (id: string) => {
    const task = await request<RuntimeTaskPayload>(`/agents/runtime/tasks/${id}`);
    return deserializeAgentTask(task);
  },

  syncTask: async (task: AgentTask) => {
    const persistedTask = await request<RuntimeTaskPayload>(`/agents/runtime/tasks/${task.id}`, {
      method: 'PUT',
      body: JSON.stringify(serializeAgentTask(task)),
    });
    return deserializeAgentTask(persistedTask);
  },
};

// ===== Models API =====
export const modelApi = {
  getAll: async () => {
    return request<ClientAIModel[]>('/models');
  },

  getById: async (id: string) => {
    return request<ClientAIModel>(`/models/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<ClientAIModel>('/models', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<ClientAIModel>(`/models/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  delete: async (id: string) => {
    return request<ApiRecord>(`/models/${id}`, {
      method: 'DELETE',
    });
  },

  setDefault: async (id: string) => {
    return request<ApiRecord>(`/models/${id}/set-default`, {
      method: 'POST',
    });
  },
};

// ===== AI API =====
export interface AICompletionResult {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latency: number;
}

export const aiApi = {
  parseEmail: async (subject: string, body: string) => {
    return request<{ type: string; partNumbers: string[]; quantities: number[]; urgency: string; aircraftType?: string }>('/ai/parse-email', {
      method: 'POST',
      body: JSON.stringify({ subject, body }),
    });
  },

  analyzeQuotes: async (rfqDetails: string, supplierQuotes: string) => {
    return request<{ analysis: string }>('/ai/analyze-quotes', {
      method: 'POST',
      body: JSON.stringify({ rfqDetails, supplierQuotes }),
    });
  },

  generateEmail: async (context: {
    customerName: string;
    partNumber: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    incoterm?: string;
    incotermLocation?: string;
    leadTimeDays?: number;
    validityDays?: number;
  }) => {
    return request<{ email: string }>('/ai/generate-email', {
      method: 'POST',
      body: JSON.stringify(context),
    });
  },

  chat: async (message: string, systemPrompt?: string, temperature?: number, maxTokens?: number) => {
    return request<AICompletionResult>('/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message, systemPrompt, temperature, maxTokens }),
    });
  },
};

// ===== Webhook Phase 2 API =====
export interface WebhookDLQStats {
  totalQuarantined: number;
  byEndpoint: { endpointId: string; endpointName: string; count: number }[];
  byReason: { reason: string; count: number }[];
  byAge: {
    lessThan1h: number;
    between1hAnd24h: number;
    moreThan24h: number;
  };
  oldestQuarantineAt: string | null;
}

export const webhooksPhase2Api = {
  getDlqStats: async () => {
    return request<WebhookDLQStats>('/webhooks/phase2/dlq/stats');
  },

  getDlqList: async (params?: {
    limit?: number;
    offset?: number;
    endpointId?: string;
    failureReason?: string;
  }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.append('limit', String(params.limit));
    if (params?.offset) search.append('offset', String(params.offset));
    if (params?.endpointId) search.append('endpointId', params.endpointId);
    if (params?.failureReason) search.append('failureReason', params.failureReason);
    const query = search.toString();
    const result = await request<
      WebhookDLQItem[] | { data: WebhookDLQItem[]; pagination?: { limit: number; offset: number; total: number } }
    >(`/webhooks/phase2/dlq${query ? `?${query}` : ''}`);

    if (Array.isArray(result)) {
      return {
        data: result,
        pagination: { limit: params?.limit ?? 20, offset: params?.offset ?? 0, total: result.length },
      };
    }

    return {
      data: result.data ?? [],
      pagination:
        result.pagination ?? { limit: params?.limit ?? 20, offset: params?.offset ?? 0, total: result.data?.length ?? 0 },
    };
  },

  markReviewed: async (id: string) => {
    return request<{ message: string }>(`/webhooks/phase2/dlq/${id}/review`, {
      method: 'POST',
    });
  },

  retry: async (id: string, payload?: { resetAttemptCount?: boolean; newMaxRetries?: number }) => {
    return request<{ message: string }>(`/webhooks/phase2/dlq/${id}/retry`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    });
  },

  abandon: async (id: string, reason?: string) => {
    return request<{ message: string }>(`/webhooks/phase2/dlq/${id}/abandon`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
};

// ===== Certificate API =====
export const certificateApi = {
  list: async (params?: { status?: string; certificateType?: string; partNumber?: string; expiringWithinDays?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.certificateType) searchParams.append('certificateType', params.certificateType);
    if (params?.partNumber) searchParams.append('partNumber', params.partNumber);
    if (params?.expiringWithinDays !== undefined) searchParams.append('expiringWithinDays', String(params.expiringWithinDays));
    const query = searchParams.toString();
    return request<Certificate[]>(`/certificates${query ? `?${query}` : ''}`);
  },

  get: async (id: string) => {
    return request<Certificate>(`/certificates/${id}`);
  },

  issue: async (data: ApiPayload) => {
    return request<Certificate>('/certificates/issue', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  verify: async (id: string) => {
    return request<Certificate>(`/certificates/${id}/verify`, {
      method: 'POST',
    });
  },

  revoke: async (id: string, reason: string) => {
    return request<Certificate>(`/certificates/${id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  renew: async (id: string) => {
    return request<Certificate>(`/certificates/${id}/renew`, {
      method: 'POST',
    });
  },

  expiring: async (days?: number) => {
    const searchParams = new URLSearchParams();
    if (days !== undefined) searchParams.append('days', String(days));
    const query = searchParams.toString();
    return request<Certificate[]>(`/certificates/expiring${query ? `?${query}` : ''}`);
  },
};

// ===== Certificate Template API =====
export const certificateTemplateApi = {
  list: async (params?: { certificateType?: string; isActive?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (params?.certificateType) searchParams.append('certificateType', params.certificateType);
    if (params?.isActive !== undefined) searchParams.append('isActive', String(params.isActive));
    const query = searchParams.toString();
    return request<CertificateTemplate[]>(`/certificate-templates${query ? `?${query}` : ''}`);
  },

  get: async (id: string) => {
    return request<CertificateTemplate>(`/certificate-templates/${id}`);
  },

  create: async (data: ApiPayload) => {
    return request<CertificateTemplate>('/certificate-templates', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: ApiPayload) => {
    return request<CertificateTemplate>(`/certificate-templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  delete: async (id: string) => {
    return request<ApiRecord>(`/certificate-templates/${id}`, {
      method: 'DELETE',
    });
  },

  duplicate: async (id: string) => {
    return request<CertificateTemplate>(`/certificate-templates/${id}/duplicate`, {
      method: 'POST',
    });
  },
};

// ===== Inbound Webhook API =====
export const inboundWebhookApi = {
  listEndpoints: async () => {
    return request<InboundWebhookEndpoint[]>('/inbound-webhooks/endpoints');
  },

  createEndpoint: async (payload: {
    name: string;
    sourceSystem: string;
    urlPath: string;
    authMethod?: string;
    secret?: string | null;
    isActive?: boolean;
  }) => {
    return request<InboundWebhookEndpoint>('/inbound-webhooks/endpoints', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getEndpoint: async (id: string) => {
    return request<InboundWebhookEndpoint>(`/inbound-webhooks/endpoints/${id}`);
  },

  updateEndpoint: async (
    id: string,
    payload: Partial<Pick<InboundWebhookEndpoint, 'name' | 'sourceSystem' | 'authMethod' | 'secret'>>
  ) => {
    return request<InboundWebhookEndpoint>(`/inbound-webhooks/endpoints/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  enableEndpoint: async (id: string) => {
    return request<InboundWebhookEndpoint>(`/inbound-webhooks/endpoints/${id}/enable`, {
      method: 'POST',
    });
  },

  disableEndpoint: async (id: string) => {
    return request<InboundWebhookEndpoint>(`/inbound-webhooks/endpoints/${id}/disable`, {
      method: 'POST',
    });
  },

  deleteEndpoint: async (id: string) => {
    return request<{ message: string }>(`/inbound-webhooks/endpoints/${id}`, {
      method: 'DELETE',
    });
  },

  listDeliveries: async (params?: {
    limit?: number;
    offset?: number;
    endpointId?: string;
    status?: string;
  }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.append('limit', String(params.limit));
    if (params?.offset) search.append('offset', String(params.offset));
    if (params?.endpointId) search.append('endpointId', params.endpointId);
    if (params?.status) search.append('status', params.status);
    const query = search.toString();
    const result = await request<
      InboundWebhookDelivery[] | {
        data: InboundWebhookDelivery[];
        pagination?: { limit: number; offset: number; total: number };
      }
    >(
      `/inbound-webhooks/deliveries${query ? `?${query}` : ''}`
    );

    if (Array.isArray(result)) {
      return {
        data: result,
        pagination: { limit: params?.limit ?? 20, offset: params?.offset ?? 0, total: result.length },
      };
    }

    return {
      data: result.data ?? [],
      pagination:
        result.pagination ?? { limit: params?.limit ?? 20, offset: params?.offset ?? 0, total: result.data?.length ?? 0 },
    };
  },

  listAudit: async (params?: {
    limit?: number;
    offset?: number;
    action?: string;
    resourceType?: string;
  }) => {
    const search = new URLSearchParams();
    if (params?.limit) search.append('limit', String(params.limit));
    if (params?.offset) search.append('offset', String(params.offset));
    if (params?.action) search.append('action', params.action);
    if (params?.resourceType) search.append('resourceType', params.resourceType);
    const query = search.toString();

    const result = await request<
      WebhookAuditLogItem[] | {
        data: WebhookAuditLogItem[];
        pagination?: { limit: number; offset: number; total: number };
      }
    >(`
      /inbound-webhooks/audit${query ? `?${query}` : ''}`.replace(/\s+/g, '')
    );

    if (Array.isArray(result)) {
      return {
        data: result,
        pagination: { limit: params?.limit ?? 20, offset: params?.offset ?? 0, total: result.length },
      };
    }

    return {
      data: result.data ?? [],
      pagination:
        result.pagination ?? { limit: params?.limit ?? 20, offset: params?.offset ?? 0, total: result.data?.length ?? 0 },
    };
  },
};

// ===== Workflow API =====
export const workflowApi = {
  listDefinitions: async (params?: { entityType?: string; isActive?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (params?.entityType) searchParams.append('entityType', params.entityType);
    if (params?.isActive !== undefined) searchParams.append('isActive', String(params.isActive));
    const query = searchParams.toString();
    return request<WorkflowDefinition[]>(`/workflows/definitions${query ? `?${query}` : ''}`);
  },

  getDefinition: async (id: string) => {
    return request<WorkflowDefinition>(`/workflows/definitions/${id}`);
  },

  createDefinition: async (data: ApiPayload) => {
    return request<WorkflowDefinition>('/workflows/definitions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  updateDefinition: async (id: string, data: ApiPayload) => {
    return request<WorkflowDefinition>(`/workflows/definitions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  deleteDefinition: async (id: string) => {
    return request<ApiRecord>(`/workflows/definitions/${id}`, {
      method: 'DELETE',
    });
  },

  duplicateDefinition: async (id: string) => {
    return request<WorkflowDefinition>(`/workflows/definitions/${id}/duplicate`, {
      method: 'POST',
    });
  },

  listInstances: async (params?: { entityType?: string; entityId?: string; status?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.entityType) searchParams.append('entityType', params.entityType);
    if (params?.entityId) searchParams.append('entityId', params.entityId);
    if (params?.status) searchParams.append('status', params.status);
    if (params?.page) searchParams.append('page', String(params.page));
    if (params?.limit) searchParams.append('limit', String(params.limit));
    const query = searchParams.toString();
    return request<{ data: WorkflowInstance[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(
      `/workflows/instances${query ? `?${query}` : ''}`
    );
  },

  getInstance: async (id: string) => {
    return request<WorkflowInstance>(`/workflows/instances/${id}`);
  },

  startInstance: async (payload: { definitionId: string; entityType: string; entityId: string; context?: ApiPayload }) => {
    return request<WorkflowInstance>('/workflows/instances', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  instanceAction: async (id: string, action: string, payload?: ApiPayload) => {
    return request<WorkflowInstance>(`/workflows/instances/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  getPendingTasks: async () => {
    return request<WorkflowInstanceStep[]>('/workflows/instances/pending');
  },

  getEntityHistory: async (entityType: string, entityId: string) => {
    return request<WorkflowInstance[]>(`/workflows/instances/entity/${entityType}/${entityId}`);
  },
};

// ===== Audit Log API =====
export interface AuditLogItem {
  id: string;
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  resourceName?: string | null;
  changes?: string | null;
  details?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  status: string;
  errorMessage?: string | null;
  createdAt: string;
}

// ===== Inventory Analytics API =====
export interface ConsumptionTrend {
  period: string;
  totalQuantity: number;
  totalValue: number;
  transactionCount: number;
  topPartNumbers: Array<{ partNumber: string; quantity: number; value: number }>;
}

export interface SafetyStockRecommendation {
  partNumber: string;
  partCategory?: string;
  currentStock: number;
  avgMonthlyConsumption: number;
  maxMonthlyConsumption: number;
  leadTimeDays: number;
  safetyStockLevel: number;
  reorderPoint: number;
  reorderQuantity: number;
  stockStatus: 'adequate' | 'low' | 'critical' | 'excess';
  daysOfSupply: number;
  confidence: number;
}

export interface InventoryHealthSummary {
  totalItems: number;
  criticalItems: number;
  lowItems: number;
  excessItems: number;
  adequateItems: number;
  totalInventoryValue: number;
  byCategory?: Record<string, { critical: number; low: number; adequate: number; excess: number }>;
  recommendations: SafetyStockRecommendation[];
}

export interface SeasonalForecast {
  partNumber: string;
  seasonalFactors: Array<{ month: number; factor: number; trend: 'high' | 'normal' | 'low' }>;
  nextQuarterForecast: number;
}

export const inventoryAnalyticsApi = {
  getConsumptionTrend: async (params?: { partNumber?: string; months?: number }) => {
    const search = new URLSearchParams();
    if (params?.partNumber) search.append('partNumber', params.partNumber);
    if (params?.months) search.append('months', String(params.months));
    return request<ConsumptionTrend[]>(`/inventory-analytics/consumption-trend?${search.toString()}`);
  },

  getSafetyStock: async (params?: { partNumber?: string; leadTimeDays?: number }) => {
    const search = new URLSearchParams();
    if (params?.partNumber) search.append('partNumber', params.partNumber);
    if (params?.leadTimeDays) search.append('leadTimeDays', String(params.leadTimeDays));
    return request<SafetyStockRecommendation[]>(`/inventory-analytics/safety-stock?${search.toString()}`);
  },

  getHealthSummary: async () => {
    return request<InventoryHealthSummary>('/inventory-analytics/health-summary');
  },

  getSeasonalForecast: async (partNumber: string) => {
    return request<SeasonalForecast>(`/inventory-analytics/seasonal-forecast/${encodeURIComponent(partNumber)}`);
  },
};

// ===== Auction Types =====
export interface Auction {
  id: string;
  auctionNumber: string;
  title: string;
  description?: string;
  type: 'SALES' | 'REVERSE' | 'SEALED';
  status: 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'CANCELLED';
  partNumber: string;
  partDescription?: string;
  quantity: number;
  conditionCode?: string;
  certificateType?: string;
  startingPrice?: number;
  reservePrice?: number;
  buyNowPrice?: number;
  currency: string;
  startAt: string;
  endAt: string;
  autoExtend: boolean;
  extendMinutes: number;
  sellerId?: string;
  buyerId?: string;
  invitedSupplierIds?: string;
  winnerBidId?: string;
  finalPrice?: number;
  closedAt?: string;
  closedReason?: string;
  inventoryId?: string;
  rfqId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  bids?: AuctionBid[];
}

export interface AuctionBid {
  id: string;
  auctionId: string;
  bidderId: string;
  bidderType: 'USER' | 'SUPPLIER';
  bidderName: string;
  amount: number;
  currency: string;
  quantity: number;
  isAutoBid: boolean;
  maxAutoBid?: number;
  bidTime: string;
  isWinning: boolean;
  isSealed: boolean;
  notes?: string;
}

export interface PlaceBidInput {
  amount: number;
  quantity?: number;
  isAutoBid?: boolean;
  maxAutoBid?: number;
  notes?: string;
}

// ===== Auction API =====
export const auctionApi = {
  list: async (params?: { status?: string; type?: string; partNumber?: string; search?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.type) searchParams.append('type', params.type);
    if (params?.partNumber) searchParams.append('partNumber', params.partNumber);
    if (params?.search) searchParams.append('search', params.search);
    const query = searchParams.toString();
    return request<Auction[]>(`/auctions${query ? `?${query}` : ''}`);
  },

  create: async (data: object) => {
    return request<Auction>('/auctions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  get: async (id: string) => {
    return request<Auction>(`/auctions/${id}`);
  },

  update: async (id: string, data: object) => {
    return request<Auction>(`/auctions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  activate: async (id: string) => {
    return request<Auction>(`/auctions/${id}/activate`, {
      method: 'POST',
    });
  },

  cancel: async (id: string) => {
    return request<Auction>(`/auctions/${id}/cancel`, {
      method: 'POST',
    });
  },

  close: async (id: string) => {
    return request<Auction>(`/auctions/${id}/close`, {
      method: 'POST',
    });
  },

  placeBid: async (id: string, data: PlaceBidInput) => {
    return request<AuctionBid>(`/auctions/${id}/bid`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  getBids: async (id: string) => {
    return request<AuctionBid[]>(`/auctions/${id}/bids`);
  },

  getActive: async () => {
    return request<Auction[]>('/auctions/active');
  },

  getMyBids: async () => {
    return request<Auction[]>('/auctions/my-bids');
  },
};

// ===== Phase 5: 库存事务 API（支持部分发货）=====
export interface InventoryTransaction {
  id: string;
  inventoryDetailId: string;
  type: 'INBOUND' | 'OUTBOUND' | 'ADJUSTMENT' | 'TRANSFER' | 'RETURN';
  quantity: number;
  beforeQuantity: number;
  afterQuantity: number;
  orderId?: string;
  quotationId?: string;
  referenceNo?: string;
  referenceType?: 'ORDER' | 'QUOTATION' | 'MANUAL' | 'SYSTEM';
  notes?: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateOutboundPayload {
  inventoryDetailId: string;
  orderId: string;
  quantity: number; // 正数，表示出库数量
  notes?: string;
}

export const inventoryTransactionApi = {
  getByDetailId: async (detailId: string) => {
    return request<InventoryTransaction[]>(`/inventory-transactions/detail/${detailId}`);
  },

  getByOrderId: async (orderId: string) => {
    return request<InventoryTransaction[]>(`/inventory-transactions/order/${orderId}`);
  },

  createOutbound: async (payload: CreateOutboundPayload) => {
    return request<InventoryTransaction>('/inventory-transactions/outbound', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};

// ===== Shipment Tracking API =====
export interface ShipmentTracking {
  id: string;
  orderId: string;
  trackingNumber: string;
  carrier: string;
  origin: string;
  destination: string;
  status: string;
  events: TrackingEvent[];
  estimatedDelivery: string;
}

export interface TrackingEvent {
  timestamp: string;
  location: string;
  status: string;
  description: string;
}

export interface CustomsRisk {
  partNumber: string;
  hsCode: string;
  riskLevel: 'high' | 'medium' | 'low';
  inspectionRate: number;
  requiredDocs: string[];
  recommendations: string[];
}

export interface ShipmentAlert {
  id: string;
  type: 'delay' | 'customs' | 'resolved';
  title: string;
  description: string;
  orderId?: string;
  partNumber?: string;
  status: 'open' | 'in_progress' | 'resolved';
  createdAt: string;
}

export const shipmentTrackingApi = {
  getAll: async () => {
    return request<ShipmentTracking[]>('/shipment-tracking');
  },

  getByOrderId: async (orderId: string) => {
    return request<ShipmentTracking | null>(`/shipment-tracking/order/${orderId}`);
  },

  getByTrackingNumber: async (trackingNumber: string) => {
    return request<ShipmentTracking>(`/shipment-tracking/${encodeURIComponent(trackingNumber)}`);
  },

  getCustomsRisks: async () => {
    return request<CustomsRisk[]>('/shipment-tracking/customs-risks');
  },

  getAlerts: async () => {
    return request<ShipmentAlert[]>('/shipment-tracking/alerts');
  },
};

// ===== Inquiry API =====
export interface InquiryItem {
  partNumber: string;
  quantity: number;
  requiredDate: string;
  certificateRequired: boolean;
}

export interface Inquiry {
  id: string;
  inquiryNumber: string;
  supplierId: string;
  supplierName: string;
  items: InquiryItem[];
  isAOG: boolean;
  status: 'draft' | 'sent' | 'responded' | 'closed';
  notes?: string;
  createdAt: string;
  sentAt?: string;
}

export interface CreateInquiryPayload {
  rfqId: string;
  supplierIds: string[];
  isAOG: boolean;
  notes?: string;
}

export const inquiryApi = {
  getAll: async () => {
    return request<Inquiry[]>('/inquiries');
  },

  getById: async (id: string) => {
    return request<Inquiry>(`/inquiries/${id}`);
  },

  create: async (payload: CreateInquiryPayload) => {
    return request<Inquiry[]>('/inquiries', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  send: async (id: string) => {
    return request<Inquiry>(`/inquiries/${id}/send`, {
      method: 'POST',
    });
  },
};

// ===== Pricing BI API =====
export interface MarketIntelligenceItem {
  partNumber: string;
  avgMarketPrice: number;
  priceRange: { min: number; max: number };
  marketDemand: 'high' | 'medium' | 'low';
  inquiryCount30d: number;
  demandTrend: 'up' | 'down' | 'stable';
}

export interface PricingSuggestion {
  id: string;
  partNumber: string;
  description: string;
  currentPrice: number;
  suggestedPrice: number;
  priceDiff: number;
  demandTrend: 'up' | 'down' | 'stable';
  daysOfStock: number;
}

export interface LostOrderItem {
  quotationId: string;
  partNumber: string;
  customerId: string;
  reason: 'price' | 'delivery' | 'certificate' | 'no_demand';
  reasonDetail: string;
  createdAt: string;
}

export interface PricingSummary {
  avgMargin: number;
  marginTrend: number;
  priceCompetitiveness: number;
  competitivenessTrend: number;
  pendingSuggestions: number;
  potentialUpside: number;
  totalQuotes: number;
  wonDeals: number;
  lostDeals: number;
  winRate: number;
}

export interface PricingFactorWeight {
  name: string;
  weight: number;
}

export const pricingBIApi = {
  getSummary: async () => {
    return request<PricingSummary>('/pricing-bi/summary');
  },

  getMarketIntelligence: async () => {
    return request<MarketIntelligenceItem[]>('/pricing-bi/market-intelligence');
  },

  getPricingSuggestions: async () => {
    return request<PricingSuggestion[]>('/pricing-bi/suggestions');
  },

  getLostOrders: async () => {
    return request<LostOrderItem[]>('/pricing-bi/lost-orders');
  },

  getFactorWeights: async () => {
    return request<PricingFactorWeight[]>('/pricing-bi/factor-weights');
  },
};

// ===== Blockchain Verification API =====
export interface BlockchainBlock {
  index: number;
  timestamp: string;
  certificateId: string;
  certificateHash: string;
  previousHash: string;
  hash: string;
  nonce: number;
}

export interface BlockchainVerificationResult {
  verified: boolean;
  block?: BlockchainBlock;
  certificateHash?: string;
  reason?: string;
}

export const blockchainApi = {
  verify: async (certificateId: string) => {
    return request<BlockchainVerificationResult>(`/blockchain/verify/${certificateId}`);
  },
};

// ===== FMV API =====
export interface FMVStage {
  stage: number;
  stageName: string;
  fmv: number;
  currency: string;
  confidence: number;
  dataPoints: number;
  method: string;
}

export interface FMVResult {
  partNumber: string;
  manufacturer?: string;
  conditionCode: string;
  fmvs: FMVStage[];
  selectedFMV: number;
  selectedStage: number;
  selectedConfidence: number;
  currency: string;
  calculatedAt: string;
}

export const fmvApi = {
  calculate: async (partNumber: string, conditionCode: string) => {
    const params = new URLSearchParams({ conditionCode });
    return request<FMVResult>(`/fmv/${encodeURIComponent(partNumber)}?${params.toString()}`);
  },
};

// ===== API Key Management API =====
export interface ApiKeyItem {
  id: string;
  name: string;
  key?: string;
  keyPrefix: string;
  scopes: string[];
  rateLimit: number;
  isActive: boolean;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface CreateApiKeyPayload {
  name: string;
  scopes: string[];
  rateLimit: number;
}

export const apiKeyApi = {
  getAll: async () => {
    return request<ApiKeyItem[]>('/api-keys');
  },

  create: async (payload: CreateApiKeyPayload) => {
    return request<ApiKeyItem>('/api-keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  revoke: async (id: string) => {
    return request<ApiRecord>(`/api-keys/${id}`, {
      method: 'DELETE',
    });
  },
};

// ===== Consignment API =====
export interface ConsignmentItem {
  id: string;
  agreementNumber: string;
  title: string;
  supplierName: string;
  partNumber: string;
  quantity: number;
  currentQuantity: number;
  consumedQuantity: number;
  status: 'ACTIVE' | 'EXPIRED' | 'TERMINATED' | 'SETTLING';
  endDate: string;
  minStockLevel: number;
}

export interface ConsignmentStats {
  activeCount: number;
  stockAlertCount: number;
  expiringSoonCount: number;
  totalConsumed: number;
}

export const consignmentApi = {
  getAll: async () => {
    return request<ConsignmentItem[]>('/consignments');
  },

  getStats: async () => {
    return request<ConsignmentStats>('/consignments/stats');
  },

  create: async (data: object) => {
    return request<ConsignmentItem>('/consignments', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
};

// ===== Exchange / VMI API =====
export interface ExchangeQuote {
  id: string;
  quoteId: string;
  coreCharge: number;
  coreReturned: boolean;
  returnDeadline: number;
  coreEvaluationCriteria: string;
  acceptableDamageRange: string;
}

export interface VMIAgreement {
  id: string;
  customerName: string;
  partNumber: string;
  minStock: number;
  maxStock: number;
  reorderPoint: number;
  reorderQty: number;
  consumptionData: Array<{ month: string; quantity: number }>;
}

export interface RestockSuggestion {
  id: string;
  partNumber: string;
  customerName: string;
  currentStock: number;
  suggestedQty: number;
  reason: string;
  expectedDeliveryDate: string;
}

export interface VMIStats {
  activeExchanges: number;
  pendingCoreReturns: number;
  totalCoreDeposit: number;
  monthlySettlement: number;
  vmiCustomers: number;
  vmiPartNumbers: number;
  pendingRestock: number;
  totalVmiInventoryValue: number;
}

export const exchangeVmiApi = {
  getExchanges: async () => {
    return request<ExchangeQuote[]>('/exchange-vmi/exchanges');
  },

  getVMIAgreements: async () => {
    return request<VMIAgreement[]>('/exchange-vmi/vmi-agreements');
  },

  getRestockSuggestions: async () => {
    return request<RestockSuggestion[]>('/exchange-vmi/restock-suggestions');
  },

  getStats: async () => {
    return request<VMIStats>('/exchange-vmi/stats');
  },
};

// ===== IPC / Technical Kit API (extends existing ipcApi) =====
export interface IPCItem {
  id: string;
  partNumber: string;
  description: string;
  ataChapter: string;
  aircraftTypes: string[];
  supersededBy?: string;
  interchangeableWith: string[];
  alternateParts: string[];
  sbList?: Array<{ sbNumber: string; title: string; applicability: string[]; mandatory: boolean }>;
}

export interface CompatibilityResult {
  isCompatible: boolean;
  warnings: string[];
  sbRequirements: string[];
}

export const technicalKitApi = {
  search: async (q: string) => {
    return request<IPCItem[]>(`/ipc/search?q=${encodeURIComponent(q)}`);
  },

  checkCompatibility: async (partNumber: string, aircraftType: string, msn?: string) => {
    const params = new URLSearchParams();
    params.append('partNumber', partNumber);
    params.append('aircraftType', aircraftType);
    if (msn) params.append('msn', msn);
    return request<CompatibilityResult>(`/ipc/compatibility?${params.toString()}`);
  },
};

// ===== IM / SMS Channel API =====
export interface UserChannelBinding {
  id: string;
  userId: string;
  channel: 'WECHAT' | 'DINGTALK' | 'LARK' | 'SMS' | 'SLACK' | 'TEAMS';
  config: Record<string, string>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationTemplate {
  id: string;
  event: string;
  channel: 'EMAIL' | 'WECHAT' | 'DINGTALK' | 'LARK' | 'SMS' | 'SLACK' | 'TEAMS' | 'SYSTEM';
  subject: string;
  body: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export const channelBindingApi = {
  getMine: async () => {
    return request<UserChannelBinding[]>('/channel-bindings/mine');
  },

  create: async (data: { channel: string; config: Record<string, string> }) => {
    return request<UserChannelBinding>('/channel-bindings', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: { config?: Record<string, string>; isActive?: boolean }) => {
    return request<UserChannelBinding>(`/channel-bindings/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  delete: async (id: string) => {
    return request<ApiRecord>(`/channel-bindings/${id}`, {
      method: 'DELETE',
    });
  },
};

export const notificationTemplateApi = {
  getAll: async () => {
    return request<NotificationTemplate[]>('/notification-templates');
  },

  getByEvent: async (event: string) => {
    return request<NotificationTemplate[]>(`/notification-templates/event/${encodeURIComponent(event)}`);
  },

  create: async (data: object) => {
    return request<NotificationTemplate>('/notification-templates', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update: async (id: string, data: object) => {
    return request<NotificationTemplate>(`/notification-templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
};

export const imApi = {
  sendWechat: async (userId: string, message: { title: string; description: string; url?: string }) => {
    return request<{ success: boolean; messageId?: string }>('/im/wechat/send', {
      method: 'POST',
      body: JSON.stringify({ userId, message }),
    });
  },

  sendDingtalk: async (userId: string, message: { title: string; text: string; url?: string }) => {
    return request<{ success: boolean; messageId?: string }>('/im/dingtalk/send', {
      method: 'POST',
      body: JSON.stringify({ userId, message }),
    });
  },

  sendLark: async (userId: string, message: { title: string; content: string; url?: string }) => {
    return request<{ success: boolean; messageId?: string }>('/im/lark/send', {
      method: 'POST',
      body: JSON.stringify({ userId, message }),
    });
  },

  sendSms: async (phone: string, message: string) => {
    return request<{ success: boolean; messageId?: string }>('/im/sms/send', {
      method: 'POST',
      body: JSON.stringify({ phone, message }),
    });
  },

  sendSlack: async (userId: string, message: { title: string; text: string; url?: string }) => {
    return request<{ success: boolean; messageId?: string }>('/im/slack/send', {
      method: 'POST',
      body: JSON.stringify({ userId, message }),
    });
  },

  sendTeams: async (userId: string, message: { title: string; text: string; url?: string }) => {
    return request<{ success: boolean; messageId?: string }>('/im/teams/send', {
      method: 'POST',
      body: JSON.stringify({ userId, message }),
    });
  },
};

// ===== Unified Notification Dispatcher (AOG / Event-driven) =====
export interface DispatchNotificationPayload {
  event: 'AOG_RFQ_CREATED' | 'AOG_RFQ_UPDATED' | 'AOG_QUOTE_APPROVED' | 'AOG_ORDER_CONFIRMED' | 'AOG_SHIPMENT_DELAYED' | 'AOG_INVENTORY_ALERT';
  targetUserIds?: string[];
  payload: Record<string, string>;
}

export interface DispatchNotificationResult {
  dispatched: number;
  channels: { channel: string; count: number }[];
}

export const notificationDispatcherApi = {
  dispatch: async (data: DispatchNotificationPayload) => {
    return request<DispatchNotificationResult>('/notifications/dispatch', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
};

// ===== PWA Web Push API =====
export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export const pushApi = {
  getVapidPublicKey: async () => {
    return request<{ publicKey: string }>('/push/vapid-public-key');
  },

  subscribe: async (payload: PushSubscriptionPayload) => {
    return request<{ success: boolean }>('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  unsubscribe: async () => {
    return request<{ success: boolean }>('/push/unsubscribe', {
      method: 'DELETE',
    });
  },

  getSubscriptionStatus: async () => {
    return request<{ subscribed: boolean }>('/push/status');
  },
};
