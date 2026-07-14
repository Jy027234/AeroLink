import { z } from 'zod';
import { ORDER_STATUSES, normalizeOrderStatus } from './orderStateMachine.js';

export const loginSchema = z.object({
  email: z.string().email('请提供有效的邮箱'),
  password: z.string().min(1, '密码不能为空'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('请提供有效的邮箱'),
});

export const tokenPasswordSchema = z.object({
  token: z.string().min(1, '令牌不能为空'),
  password: z.string().min(8, '密码至少需要 8 位'),
});

export function validatePasswordStrength(password: string): { valid: boolean; message: string } {
  if (password.length < 8) {
    return { valid: false, message: '密码至少需要 8 位' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: '密码需要包含至少 1 个大写字母' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: '密码需要包含至少 1 个小写字母' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: '密码需要包含至少 1 个数字' };
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    return { valid: false, message: '密码需要包含至少 1 个特殊字符' };
  }
  return { valid: true, message: '密码强度符合要求' };
}

export const rfqCreateSchema = z.object({
  customerId: z.string().min(1, '客户ID不能为空'),
  partNumber: z.string().min(1, '件号不能为空'),
  quantity: z.number().int().min(1, '数量必须大于0'),
  uom: z.string().optional().default('EA'),
  conditionCode: z.string().optional().default('NE'),
  description: z.string().optional(),
  serialNumber: z.string().optional(),
  batchNumber: z.string().optional(),
  ataChapter: z.string().optional(),
  aircraftType: z.string().optional(),
  aircraftModel: z.string().optional(),
  alternatePartNumbers: z.union([z.string(), z.array(z.string())]).optional().transform((v) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  }),
  targetPrice: z.number().optional(),
  targetPriceCurrency: z.string().optional().default('USD'),
  certificateRequired: z.boolean().optional().default(true),
  certificateType: z.string().optional(),
  requiredDate: z.string().optional(),
  responseDeadline: z.string().optional(),
  leadTimeDays: z.number().int().optional(),
  urgency: z.enum(['AOG', 'URGENT', 'STANDARD']).optional().default('STANDARD'),
  urgencyJustification: z.string().optional(),
  notes: z.string().optional(),
  emailId: z.string().optional(),
});

const rfqStatusAliases = [
  'PENDING', 'SOURCING', 'QUOTING', 'APPROVING', 'ORDERED', 'COMPLETED', 'CANCELLED',
  'pending', 'sourcing', 'quoting', 'approved', 'sent', 'won', 'lost',
] as const;

const rfqStatusPersistenceMap: Record<(typeof rfqStatusAliases)[number], string> = {
  PENDING: 'PENDING',
  SOURCING: 'SOURCING',
  QUOTING: 'QUOTING',
  APPROVING: 'APPROVING',
  ORDERED: 'ORDERED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  pending: 'PENDING',
  sourcing: 'SOURCING',
  quoting: 'QUOTING',
  approved: 'APPROVING',
  sent: 'ORDERED',
  won: 'COMPLETED',
  lost: 'CANCELLED',
};

export const rfqStatusUpdateSchema = z.object({
  status: z.enum(rfqStatusAliases).transform((status) => rfqStatusPersistenceMap[status]),
});

export const quotationCreateSchema = z.object({
  rfqId: z.string().min(1, 'RFQ ID不能为空'),
  customerId: z.string().min(1, '客户ID不能为空'),
  partNumber: z.string().min(1, '件号不能为空'),
  quantity: z.number().int().min(1, '数量必须大于0'),
  unitPrice: z.number().min(0, '单价必须大于0'),
  costPrice: z.number().min(0, '成本价必须大于0'),
  certificateFiles: z.array(z.string()).optional(),
  template: z.string().optional(),
  validityDays: z.number().int().min(1).optional(),
  // P0 新增字段
  saleType: z.string().optional().default('Sale'),
  shipToId: z.string().optional(),
  shipForId: z.string().optional(),
  incoterm: z.string().optional(),
  incotermLocation: z.string().optional(),
  leadTimeDays: z.number().int().optional(),
  leadTimeBasis: z.string().optional(),
  moq: z.number().int().optional(),
  mpq: z.number().int().optional(),
  priceBasis: z.string().optional(),
  taxIncluded: z.boolean().optional().default(true),
  taxRate: z.number().optional(),
  warrantyDays: z.number().int().optional().default(90),
  warrantyTerms: z.string().optional(),
  packagingRequirement: z.string().optional(),
  shippingMethod: z.string().optional(),
  ccRecipients: z.union([z.string(), z.array(z.string())]).optional(),
  commonNote: z.string().optional(),
  eSignature: z.string().optional(),
  eSignatureStatus: z.string().optional().default('Unsigned'),
  // P2 进出口合规字段
  countryOfOrigin: z.string().optional(),
  hsCode: z.string().optional(),
  eccn: z.string().optional(),
  dualUse: z.boolean().optional().default(false),
});

export const quotationApproveSchema = z.object({
  action: z.enum(['approve', 'reject']),
  comment: z.string().optional(),
});

export const quotationSendSchema = z.object({
  subject: z.string().min(1, '邮件主题不能为空').optional(),
  message: z.string().min(1, '邮件正文不能为空').optional(),
});

export const quotationWithdrawSchema = z.object({
  reason: z.string().min(1, '撤回原因不能为空'),
  sendWithdrawalNotice: z.boolean().optional().default(true),
});

export const quotationAcceptSchema = z.object({
  poNumber: z.string().optional(),
  deliveryDate: z.string().optional(),
  templateId: z.string().optional(),
  confirmationNote: z.string().optional(),
});

export const orderCreateSchema = z.object({
  quotationId: z.string().min(1, '报价单ID不能为空'),
  customerId: z.string().min(1, '客户ID不能为空'),
  poNumber: z.string().optional(),
  deliveryDate: z.string().optional(),
  templateId: z.string().optional(),
  // P2 新增字段
  saleType: z.string().optional().default('Sale'),
  incoterm: z.string().optional(),
  incotermLocation: z.string().optional(),
  shipToId: z.string().optional(),
  shipForId: z.string().optional(),
  warrantyDays: z.number().int().optional(),
  warrantyStartDate: z.string().optional(),
  certificateRequired: z.boolean().optional().default(true),
  certificateType: z.string().optional(),
  certificateDelivered: z.boolean().optional().default(false),
  packagingStandard: z.string().optional(),
  shippingMethod: z.string().optional(),
  carrierAccount: z.string().optional(),
  inspectionRequired: z.boolean().optional().default(false),
  inspectionPassed: z.boolean().optional(),
  inspectionDate: z.string().optional(),
  customsClearanceRequired: z.boolean().optional().default(false),
  customsDeclarationNo: z.string().optional(),
  importDuty: z.number().optional(),
  vatAmount: z.number().optional(),
  totalLandCost: z.number().optional(),
  exchangeCoreCharge: z.number().optional(),
  exchangeCoreDueDate: z.string().optional(),
  eSignatureCustomer: z.string().optional(),
  eSignatureSupplier: z.string().optional(),
});

export const orderUpdateSchema = z.object({
  poNumber: z.string().optional(),
  deliveryDate: z.string().optional(),
  saleType: z.string().optional(),
  incoterm: z.string().optional(),
  incotermLocation: z.string().optional(),
  shipToId: z.string().optional(),
  shipForId: z.string().optional(),
  warrantyDays: z.number().int().optional(),
  warrantyStartDate: z.string().optional(),
  certificateRequired: z.boolean().optional(),
  certificateType: z.string().optional(),
  certificateDelivered: z.boolean().optional(),
  packagingStandard: z.string().optional(),
  shippingMethod: z.string().optional(),
  carrierAccount: z.string().optional(),
  inspectionRequired: z.boolean().optional(),
  inspectionPassed: z.boolean().optional(),
  inspectionDate: z.string().optional(),
  customsClearanceRequired: z.boolean().optional(),
  customsDeclarationNo: z.string().optional(),
  importDuty: z.number().optional(),
  vatAmount: z.number().optional(),
  totalLandCost: z.number().optional(),
  exchangeCoreCharge: z.number().optional(),
  exchangeCoreDueDate: z.string().optional(),
  eSignatureCustomer: z.string().optional(),
  eSignatureSupplier: z.string().optional(),
  trackingNumber: z.string().optional(),
  carrier: z.string().optional(),
});

export const documentTemplateCreateSchema = z.object({
  name: z.string().min(1, '模板名称不能为空'),
  code: z.string().min(1, '模板编码不能为空'),
  documentType: z.string().optional().default('ORDER_CONTRACT'),
  description: z.string().optional(),
  bodyTemplate: z.string().min(1, '模板正文不能为空'),
  headerTemplate: z.string().optional(),
  footerTemplate: z.string().optional(),
  isActive: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),
});

export const documentTemplateUpdateSchema = documentTemplateCreateSchema.partial().extend({
  version: z.number().int().min(1).optional(),
});

export const orderStatusUpdateSchema = z.object({
  status: z.string()
    .trim()
    .min(1, '状态不能为空')
    .transform(normalizeOrderStatus)
    .pipe(z.enum(ORDER_STATUSES)),
});

export const customerCreateSchema = z.object({
  name: z.string().min(1, '客户名称不能为空'),
  contactName: z.string().min(1, '联系人不能为空'),
  email: z.string().email('请提供有效的邮箱'),
  phone: z.string().optional(),
  buyerType: z.string().optional(),
  businessDescription: z.string().optional(),
  registeredAddress: z.string().optional(),
  shipToAddress: z.string().optional(),
  shipForAddress: z.string().optional(),
  shippingContactName: z.string().optional(),
  shippingContactPhone: z.string().optional(),
  creditLimit: z.number().optional(),
  creditRating: z.string().optional(),
  paymentTerms: z.string().optional(),
  paymentMethod: z.string().optional(),
  annualRevenue: z.number().optional(),
  vatNumber: z.string().optional(),
  iataCode: z.string().optional(),
  icaoCode: z.string().optional(),
  aocNumber: z.string().optional(),
  preferredIncoterm: z.string().optional(),
  customsBroker: z.string().optional(),
  qualityApprovalStatus: z.string().optional(),
  contacts: z.array(z.object({
    name: z.string().min(1, '联系人姓名不能为空'),
    email: z.string().email('请提供有效的邮箱'),
    phone: z.string().optional(),
    role: z.string().min(1, '角色不能为空'),
    isDefault: z.boolean().optional(),
    receiveRFQ: z.boolean().optional(),
    receivePO: z.boolean().optional(),
  })).optional(),
  competitorListings: z.array(z.object({
    competitorName: z.string().min(1, '竞争对手名称不能为空'),
    advantageParts: z.string().optional(),
    priceLevel: z.string().optional(),
    notes: z.string().optional(),
  })).optional(),
});

export const customerUpdateSchema = z.object({
  name: z.string().optional(),
  contactName: z.string().optional(),
  email: z.string().email('请提供有效的邮箱').optional(),
  phone: z.string().optional(),
  buyerType: z.string().optional(),
  businessDescription: z.string().optional(),
  registeredAddress: z.string().optional(),
  shipToAddress: z.string().optional(),
  shipForAddress: z.string().optional(),
  shippingContactName: z.string().optional(),
  shippingContactPhone: z.string().optional(),
  creditLimit: z.number().optional(),
  creditRating: z.string().optional(),
  paymentTerms: z.string().optional(),
  paymentMethod: z.string().optional(),
  annualRevenue: z.number().optional(),
  vatNumber: z.string().optional(),
  iataCode: z.string().optional(),
  icaoCode: z.string().optional(),
  aocNumber: z.string().optional(),
  preferredIncoterm: z.string().optional(),
  customsBroker: z.string().optional(),
  qualityApprovalStatus: z.string().optional(),
  status: z.string().optional(),
  contacts: z.array(z.object({
    id: z.string().optional(),
    name: z.string().min(1, '联系人姓名不能为空'),
    email: z.string().email('请提供有效的邮箱'),
    phone: z.string().optional(),
    role: z.string().min(1, '角色不能为空'),
    isDefault: z.boolean().optional(),
    receiveRFQ: z.boolean().optional(),
    receivePO: z.boolean().optional(),
  })).optional(),
  competitorListings: z.array(z.object({
    id: z.string().optional(),
    competitorName: z.string().min(1, '竞争对手名称不能为空'),
    advantageParts: z.string().optional(),
    priceLevel: z.string().optional(),
    notes: z.string().optional(),
  })).optional(),
});

export const inventoryUpdateSchema = z.object({
  quantity: z.number().int().optional(),
  location: z.string().optional(),
  warehouse: z.string().optional(),
  shelf: z.string().optional(),
  conditionCode: z.string().optional(),
  certificateType: z.string().optional(),
  certificateNumber: z.string().optional(),
  certificateFileUrl: z.string().optional(),
  serialNumber: z.string().optional(),
  batchNumber: z.string().optional(),
  manufacturer: z.string().optional(),
  manufacturerCageCode: z.string().optional(),
  ataChapter: z.string().optional(),
  alternatePartNumbers: z.string().optional(),
  unitOfMeasure: z.string().optional(),
  countryOfOrigin: z.string().optional(),
  hsCode: z.string().optional(),
  // 时寿件管理（P1）
  lifeLimited: z.boolean().optional(),
  totalHours: z.number().optional(),
  totalCycles: z.number().optional(),
  remainingHours: z.number().optional(),
  remainingCycles: z.number().optional(),
  manufactureDate: z.string().optional(),
  shelfLifeDate: z.string().optional(),
  overhaulDate: z.string().optional(),
  nextOverhaulDue: z.string().optional(),
  adStatus: z.string().optional(),
  sbStatus: z.string().optional(),
  repairScheme: z.string().optional(),
  // 二手件追溯（P2）
  previousOperator: z.string().optional(),
  removalAircraftReg: z.string().optional(),
  removalDate: z.string().optional(),
  removalReason: z.string().optional(),
  nonIncidentStatement: z.boolean().optional(),
  militarySource: z.boolean().optional(),
  traceabilityDocs: z.string().optional(),
  // 存储与包装（P2）
  storageCondition: z.string().optional(),
  ata300Packaging: z.boolean().optional(),
});

export const inventoryCreateSchema = z.object({
  partNumber: z.string().min(1, '件号不能为空'),
  description: z.string().min(1, '描述不能为空'),
  quantity: z.number().int().min(0).optional().default(0),
  location: z.string().min(1, '库位不能为空'),
  warehouse: z.string().optional(),
  shelf: z.string().optional(),
  conditionCode: z.string().optional().default('NE'),
  certificateType: z.string().optional().default('NONE'),
  certificateNumber: z.string().optional(),
  certificateFileUrl: z.string().optional(),
  serialNumber: z.string().optional(),
  batchNumber: z.string().optional(),
  manufacturer: z.string().optional(),
  manufacturerCageCode: z.string().optional(),
  ataChapter: z.string().optional(),
  alternatePartNumbers: z.string().optional(),
  unitOfMeasure: z.string().optional().default('EA'),
  countryOfOrigin: z.string().optional(),
  hsCode: z.string().optional(),
  unitCost: z.number().min(0).optional().default(0),
  type: z.string().optional().default('OWN'),
  supplierId: z.string().optional(),
  // 时寿件管理（P1）
  lifeLimited: z.boolean().optional().default(false),
  totalHours: z.number().optional(),
  totalCycles: z.number().optional(),
  remainingHours: z.number().optional(),
  remainingCycles: z.number().optional(),
  manufactureDate: z.string().optional(),
  shelfLifeDate: z.string().optional(),
  overhaulDate: z.string().optional(),
  nextOverhaulDue: z.string().optional(),
  adStatus: z.string().optional(),
  sbStatus: z.string().optional(),
  repairScheme: z.string().optional(),
  // 二手件追溯（P2）
  previousOperator: z.string().optional(),
  removalAircraftReg: z.string().optional(),
  removalDate: z.string().optional(),
  removalReason: z.string().optional(),
  nonIncidentStatement: z.boolean().optional().default(false),
  militarySource: z.boolean().optional().default(false),
  traceabilityDocs: z.string().optional(),
  // 存储与包装（P2）
  storageCondition: z.string().optional(),
  ata300Packaging: z.boolean().optional().default(false),
});

export const emailClassifySchema = z.object({
  type: z.enum(['AOG', 'STANDARD', 'INQUIRY', 'SPAM']),
});

export const agentCreateSchema = z.object({
  name: z.string().min(1, '名称不能为空'),
  type: z.string().min(1, '类型不能为空'),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
  config: z.record(z.any()).optional(),
  prompts: z.array(z.any()).optional(),
});

const agentRuntimeTaskStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_confirmation',
  'completed',
  'failed',
  'cancelled',
]);

const agentRuntimeTaskTypeSchema = z.enum([
  'email_received',
  'rfq_created',
  'manual_follow_up',
  'sourcing_started',
  'quotes_collected',
  'quotes_compared',
  'quotation_created',
  'quotation_sent',
  'approval_requested',
  'approval_completed',
  'order_created',
  'order_tracking',
  'order_completed',
]);

const agentRuntimeCapabilitySchema = z.enum([
  'email',
  'rfq',
  'sourcing',
  'supplierQuote',
  'quotation',
  'approval',
  'order',
  'notification',
]);

const agentRuntimeStepSchema = z.object({
  id: z.string().min(1, '步骤ID不能为空'),
  capability: agentRuntimeCapabilitySchema,
  action: z.string().min(1, '步骤动作不能为空'),
  params: z.record(z.unknown()),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
  result: z.record(z.unknown()).optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

const agentRuntimeConfirmationOptionSchema = z.object({
  id: z.string().min(1, '确认选项ID不能为空'),
  label: z.string().min(1, '确认选项标题不能为空'),
  labelZh: z.string().optional(),
  labelEn: z.string().optional(),
  description: z.string().optional(),
  descriptionZh: z.string().optional(),
  descriptionEn: z.string().optional(),
  action: z.string().min(1, '确认动作不能为空'),
  data: z.record(z.unknown()).optional(),
});

const agentRuntimeConfirmationSchema = z.object({
  id: z.string().min(1, '确认节点ID不能为空'),
  taskId: z.string().min(1, '确认节点任务ID不能为空'),
  stepId: z.string().min(1, '确认节点步骤ID不能为空'),
  type: z.enum(['rfq_confirm', 'supplier_select', 'quotation_confirm', 'approval_confirm']),
  title: z.string().min(1, '确认标题不能为空'),
  titleZh: z.string().optional(),
  titleEn: z.string().optional(),
  description: z.string().min(1, '确认说明不能为空'),
  descriptionZh: z.string().optional(),
  descriptionEn: z.string().optional(),
  data: z.record(z.unknown()),
  options: z.array(agentRuntimeConfirmationOptionSchema),
  selectedOption: z.string().optional(),
  confirmedAt: z.string().optional(),
  confirmedBy: z.string().optional(),
});

export const agentRuntimeTaskSyncSchema = z.object({
  id: z.string().min(1, '任务ID不能为空'),
  trigger: z.object({
    type: z.enum(['email', 'manual', 'scheduled', 'system']),
    source: z.string().optional(),
    referenceId: z.string().optional(),
  }),
  type: agentRuntimeTaskTypeSchema,
  status: agentRuntimeTaskStatusSchema,
  currentStepIndex: z.number().int().min(0, '当前步骤索引不能小于0'),
  steps: z.array(agentRuntimeStepSchema),
  confirmationNode: agentRuntimeConfirmationSchema.optional(),
  context: z.record(z.unknown()),
  result: z.record(z.unknown()).optional(),
  createdAt: z.string().min(1, '创建时间不能为空'),
  updatedAt: z.string().min(1, '更新时间不能为空'),
  completedAt: z.string().optional(),
  error: z.string().optional(),
});

export const modelCreateSchema = z.object({
  name: z.string().min(1, '名称不能为空'),
  provider: z.string().min(1, '供应商不能为空'),
  modelId: z.string().min(1, '模型ID不能为空'),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  config: z.record(z.any()).optional(),
  capabilities: z.array(z.string()).optional(),
});

export const emailAccountCreateSchema = z.object({
  email: z.string().email('请提供有效的邮箱'),
  displayName: z.string().optional(),
  imapServer: z.string().min(1, 'IMAP服务器不能为空'),
  imapPort: z.string().optional(),
  smtpServer: z.string().min(1, 'SMTP服务器不能为空'),
  smtpPort: z.string().optional(),
  authCode: z.string().min(1, '授权码不能为空'),
  accountType: z.string().optional(),
  isDefault: z.boolean().optional(),
  syncInterval: z.number().int().min(0).optional(),
});

export const emailAccountUpdateSchema = z.object({
  email: z.string().email('请提供有效的邮箱').optional(),
  displayName: z.string().optional(),
  imapServer: z.string().min(1, 'IMAP服务器不能为空').optional(),
  imapPort: z.string().optional(),
  smtpServer: z.string().min(1, 'SMTP服务器不能为空').optional(),
  smtpPort: z.string().optional(),
  authCode: z.string().min(1, '授权码不能为空').optional(),
  accountType: z.string().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  syncInterval: z.number().int().min(0).optional(),
});

export const supplierQuoteCreateSchema = z.object({
  rfqId: z.string().optional(),
  inquiryId: z.string().optional(),
  supplierId: z.string().min(1, '供应商ID不能为空'),
  partNumber: z.string().min(1, '件号不能为空'),
  description: z.string().optional(),
  quantity: z.number().int().min(1, '数量必须大于0'),
  unitPrice: z.number().min(0, '单价必须大于0'),
  leadTimeDays: z.number().int().optional(),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
});

export const paginationSchema = z.object({
  page: z.string().optional().transform((v) => {
    const n = v ? parseInt(v, 10) : 1;
    return Number.isNaN(n) || n < 1 ? 1 : n;
  }),
  limit: z.string().optional().transform((v) => {
    const n = v ? parseInt(v, 10) : 20;
    return Number.isNaN(n) || n < 1 ? 20 : n > 100 ? 100 : n;
  }),
});

export const supplierInviteSchema = z.object({
  email: z.string().email('请提供有效的邮箱'),
  message: z.string().optional(),
});

export const supplierCreateSchema = z.object({
  name: z.string().min(1, '供应商名称不能为空'),
  contactName: z.string().min(1, '联系人不能为空'),
  email: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined)
    .refine((value) => !value || z.string().email().safeParse(value).success, '请提供有效的邮箱'),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  address: z.string().optional(),
  level: z.enum(['S', 'A', 'B', 'C']).optional(),
  paymentTerms: z.string().optional(),
  leadTime: z.number().int().min(0).optional(),
  // P2 新增字段
  supplierType: z.enum(['OEM', 'MRO', 'Distributor', 'Broker', '145RepairStation']).optional(),
  cageCode: z.string().optional(),
  caac145CertificateNo: z.string().optional(),
  caac145CertificateUrl: z.string().optional(),
  pmaHolder: z.boolean().optional(),
  ctsoaHolder: z.boolean().optional(),
  oemAuthorized: z.boolean().optional(),
  oemAuthorizationUrl: z.string().optional(),
  qualityApprovalExpiry: z.string().optional(),
  lastAuditDate: z.string().optional(),
  nextAuditDue: z.string().optional(),
  approvedPartCategories: z.union([z.string(), z.array(z.string())]).optional().transform((v) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  }),
  specializesInAircraft: z.union([z.string(), z.array(z.string())]).optional().transform((v) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  }),
  incotermsOffered: z.union([z.string(), z.array(z.string())]).optional().transform((v) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  }),
  leadTimeAverage: z.number().int().min(0).optional(),
  onTimeDeliveryRate: z.number().min(0).max(100).optional(),
  certificateTypesProvided: z.union([z.string(), z.array(z.string())]).optional().transform((v) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  }),
  moqPolicy: z.string().optional(),
  warrantyPolicy: z.string().optional(),
  returnPolicy: z.string().optional(),
  bankAccountInfo: z.string().optional(),
}).superRefine((data, ctx) => {
  if (!data.email && !data.phone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '邮箱和电话至少填写一项',
      path: ['email'],
    });
  }
});

export const supplierUpdateSchema = z.object({
  name: z.string().min(1, '供应商名称不能为空').optional(),
  contactName: z.string().min(1, '联系人不能为空').optional(),
  email: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined)
    .refine((value) => !value || z.string().email().safeParse(value).success, '请提供有效的邮箱'),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  address: z.string().optional(),
  level: z.enum(['S', 'A', 'B', 'C']).optional(),
  paymentTerms: z.string().optional(),
  leadTime: z.number().int().min(0).optional(),
  // P2 新增字段
  supplierType: z.enum(['OEM', 'MRO', 'Distributor', 'Broker', '145RepairStation']).optional(),
  cageCode: z.string().optional(),
  caac145CertificateNo: z.string().optional(),
  caac145CertificateUrl: z.string().optional(),
  pmaHolder: z.boolean().optional(),
  ctsoaHolder: z.boolean().optional(),
  oemAuthorized: z.boolean().optional(),
  oemAuthorizationUrl: z.string().optional(),
  qualityApprovalExpiry: z.string().optional(),
  lastAuditDate: z.string().optional(),
  nextAuditDue: z.string().optional(),
  approvedPartCategories: z.union([z.string(), z.array(z.string())]).optional().transform((v) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  }),
  specializesInAircraft: z.union([z.string(), z.array(z.string())]).optional().transform((v) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  }),
  incotermsOffered: z.union([z.string(), z.array(z.string())]).optional().transform((v) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  }),
  leadTimeAverage: z.number().int().min(0).optional(),
  onTimeDeliveryRate: z.number().min(0).max(100).optional(),
  certificateTypesProvided: z.union([z.string(), z.array(z.string())]).optional().transform((v) => {
    if (Array.isArray(v)) return JSON.stringify(v);
    return v;
  }),
  moqPolicy: z.string().optional(),
  warrantyPolicy: z.string().optional(),
  returnPolicy: z.string().optional(),
  bankAccountInfo: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.email === '' && data.phone === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '邮箱和电话至少填写一项',
      path: ['email'],
    });
  }
});

const supplierFollowUpActionSchema = z.enum([
  'portal_follow_up',
  'wechat_follow_up',
  'whatsapp_follow_up',
  'phone_follow_up',
  'contact_missing',
]);

const supplierFollowUpOutcomeSchema = z.enum([
  'contacted_waiting_quote',
  'quote_promised',
  'portal_message_sent',
  'contact_invalid',
]);

const supplierFollowUpLogCreateItemSchema = z.object({
  supplierId: z.string().min(1, '供应商ID不能为空'),
  taskId: z.string().min(1, '任务ID不能为空'),
  rfqId: z.string().optional(),
  rfqNumber: z.string().optional(),
  actionType: supplierFollowUpActionSchema,
  outcome: supplierFollowUpOutcomeSchema,
  notes: z.string().trim().optional(),
  preferredChannel: z.enum(['email', 'phone', 'manual']).optional(),
});

export const supplierFollowUpLogBatchCreateSchema = z.object({
  logs: z.array(supplierFollowUpLogCreateItemSchema).min(1, '至少提交一条跟进日志'),
});

export const supplierQuoteUpdateSchema = z.object({
  unitPrice: z.number().min(0).optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(['pending', 'accepted', 'rejected', 'expired']).optional(),
  isWinner: z.boolean().optional(),
});

export const agentUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  prompts: z.array(z.unknown()).optional(),
});

export const modelUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  capabilities: z.array(z.string()).optional(),
});

export const webhookEndpointCreateSchema = z.object({
  name: z.string().min(1, '名称不能为空'),
  url: z.string().url('请提供有效的URL'),
  method: z.enum(['POST', 'PUT']).optional().default('POST'),
  authType: z.enum(['none', 'bearer']).optional().default('none'),
  authToken: z.string().optional(),
  secret: z.string().min(8, '签名密钥至少8位').optional(),
  customHeaders: z.record(z.string()).optional().default({}),
  timeoutMs: z.number().int().min(1000).max(30000).optional().default(10000),
  maxRetries: z.number().int().min(0).max(10).optional().default(3),
  isActive: z.boolean().optional().default(true),
});

export const webhookEndpointUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  url: z.string().url('请提供有效的URL').optional(),
  method: z.enum(['POST', 'PUT']).optional(),
  authType: z.enum(['none', 'bearer']).optional(),
  authToken: z.string().optional(),
  secret: z.string().min(8, '签名密钥至少8位').optional(),
  customHeaders: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(30000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  isActive: z.boolean().optional(),
});

export const webhookSubscriptionReplaceSchema = z.object({
  eventTypes: z.array(z.string().min(1)).max(100),
});
