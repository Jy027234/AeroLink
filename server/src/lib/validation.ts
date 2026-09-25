import { z } from 'zod';
import { ORDER_STATUSES, normalizeOrderStatus } from './orderStateMachine.js';
import { normalizeRfqStatus } from './rfqStateMachine.js';

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

export { rfqCreateSchema, rfqUpdateSchema } from '../modules/rfqSourcing/index.js';

const stateTransitionMetadataSchema = {
  version: z.number().int().positive('状态版本必须为正整数').optional(),
  reasonCode: z.string()
    .trim()
    .min(1, '原因码不能为空')
    .max(64, '原因码不能超过64个字符')
    .regex(/^[A-Z][A-Z0-9_]*$/, '原因码只能包含大写字母、数字和下划线')
    .optional(),
  reason: z.string().trim().max(1000, '原因说明不能超过1000个字符').optional(),
};

export const rfqStatusUpdateSchema = z.object({
  status: z.string()
    .trim()
    .min(1, '状态不能为空')
    .refine((status) => normalizeRfqStatus(status) !== null, 'RFQ状态无效')
    .transform((status) => normalizeRfqStatus(status)!),
  ...stateTransitionMetadataSchema,
});

const legacyQuotationCreateSchema = z.object({
  rfqId: z.string().min(1, 'RFQ ID不能为空'),
  customerId: z.string().min(1, '客户ID不能为空'),
  partNumber: z.string().min(1, '件号不能为空'),
  quantity: z.number().int().min(1, '数量必须大于0'),
  unitPrice: z.number().min(0, '单价必须大于0'),
  costPrice: z.number().min(0, '成本价必须大于0'),
  currency: z.string().trim().toUpperCase().default('USD').refine((value) => value === 'USD', '首期报价仅支持 USD 币种'),
  costSourceType: z.enum(['SUPPLIER_QUOTE', 'INVENTORY_DETAIL', 'MANUAL'], { message: '必须明确报价成本来源' }),
  costSourceId: z.string().trim().min(1, '成本来源 ID 不能为空').optional(),
  costSourceReason: z.string().trim().max(1000, '成本来源原因不能超过1000个字符').optional(),
  // Legacy requests reject lines; explicit line requests use their own union branch.
  lines: z.never().optional(),
  certificateFiles: z.array(z.string()).optional(),
  template: z.string().optional(),
  validityDays: z.number().int().min(1).optional(),
  // P0 新增字段
  saleType: z.literal('Sale').optional().default('Sale'),
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
}).superRefine((data, ctx) => {
  if (data.costSourceType === 'MANUAL') {
    if (!data.costSourceReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costSourceReason'], message: '人工成本必须填写来源原因' });
    }
    if (data.costSourceId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costSourceId'], message: '人工成本不能填写来源 ID' });
    }
  } else if (!data.costSourceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costSourceId'], message: '引用型成本必须填写来源 ID' });
  }
});

const quotationLineCreateSchema = legacyQuotationCreateSchema.innerType().pick({
  partNumber: true, quantity: true, unitPrice: true, costPrice: true, costSourceType: true, costSourceId: true, costSourceReason: true,
}).extend({ rfqLineId: z.string().min(1) }).strict().superRefine((data, ctx) => {
  if (data.costSourceType === 'MANUAL' ? !data.costSourceReason || !!data.costSourceId : !data.costSourceId || !!data.costSourceReason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costSourceType'], message: '每行必须明确有效成本来源，人工成本需要原因，引用来源需要 ID' });
  }
});
const multiLineQuotationCreateSchema = legacyQuotationCreateSchema.innerType().omit({
  partNumber: true, quantity: true, unitPrice: true, costPrice: true, costSourceType: true, costSourceId: true, costSourceReason: true, lines: true,
}).extend({ lines: z.array(quotationLineCreateSchema).min(1).max(100) }).strict();
export const quotationCreateSchema = z.union([legacyQuotationCreateSchema, multiLineQuotationCreateSchema]);

export const quotationReviseSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(1, '请说明本次商业修订的原因').max(1000),
  quotation: quotationCreateSchema.refine(value => value.validityDays !== undefined, {
    message: '修订报价必须明确新报价有效天数', path: ['validityDays'],
  }),
}).strict();

export const quotationSubmitSchema = z.object({
  ...stateTransitionMetadataSchema,
});

export const quotationApproveSchema = z.object({
  action: z.enum(['approve', 'reject']),
  comment: z.string().optional(),
  costSourceType: z.enum(['SUPPLIER_QUOTE', 'INVENTORY_DETAIL', 'MANUAL']).optional(),
  costSourceId: z.string().trim().min(1, '成本来源 ID 不能为空').optional(),
  costSourceReason: z.string().trim().max(1000, '成本来源原因不能超过1000个字符').optional(),
  ...stateTransitionMetadataSchema,
}).superRefine((data, ctx) => {
  if (!data.costSourceType) {
    if (data.costSourceId || data.costSourceReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costSourceType'], message: '补录成本来源时必须明确来源类型' });
    }
    return;
  }
  if (data.costSourceType === 'MANUAL') {
    if (!data.costSourceReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costSourceReason'], message: '人工成本必须填写来源原因' });
    }
    if (data.costSourceId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costSourceId'], message: '人工成本不能填写来源 ID' });
    }
  } else if (!data.costSourceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costSourceId'], message: '引用型成本必须填写来源 ID' });
  } else if (data.costSourceReason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costSourceReason'], message: '引用型成本不能用人工原因替代来源记录' });
  }
});

export const quotationSendSchema = z.object({
  subject: z.string().min(1, '邮件主题不能为空').optional(),
  message: z.string().min(1, '邮件正文不能为空').optional(),
  ...stateTransitionMetadataSchema,
});

export const quotationWithdrawSchema = z.object({
  ...stateTransitionMetadataSchema,
  reason: z.string().min(1, '撤回原因不能为空'),
  sendWithdrawalNotice: z.boolean().optional().default(true),
});

export const quotationAcceptSchema = z.object({
  lines: z.array(z.object({ quotationLineId: z.string().min(1), quantity: z.number().int().positive(),
    allocations: z.array(z.object({ allocationId: z.string().min(1), quantity: z.number().int().positive().max(2147483647) }).strict()).min(1).max(100).optional(),
  }).strict()).min(1).max(100).optional(),
  ...stateTransitionMetadataSchema,
  poNumber: z.string().optional(),
  deliveryDate: z.string().optional(),
  templateId: z.string().optional(),
  confirmationNote: z.string().optional(),
});

export const orderCreateSchema = z.object({
  quotationId: z.string().min(1, '报价单ID不能为空'),
  customerId: z.string().min(1, '客户ID不能为空'),
  quotationVersion: z.number().int().positive('报价版本必须为正整数').optional(),
  // Multi-line orders are not enabled in this migration; reject rather than
  // silently creating an order from only the aggregate quotation.
  lines: z.never().optional(),
  poNumber: z.string().optional(),
  deliveryDate: z.string().optional(),
  templateId: z.string().optional(),
  // P2 新增字段
  saleType: z.literal('Sale').optional().default('Sale'),
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
  saleType: z.literal('Sale').optional(),
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
  ...stateTransitionMetadataSchema,
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
  description: z.string().min(1, '描述不能为空').optional(),
  partCategory: z.string().optional(),
  trackingType: z.string().optional(),
  quantity: z.number().int().min(0, '库存数量不能为负数').optional(),
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
  unitCost: z.number().min(0, '单位成本不能为负数').optional(),
  type: z.string().optional(),
  supplierId: z.string().optional(),
  eta: z.string().optional(),
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
  shelfLifeDays: z.number().int().min(0).optional(),
  storageTempMin: z.number().optional(),
  storageTempMax: z.number().optional(),
  hazardClass: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

export const inventoryCreateSchema = z.object({
  partNumber: z.string().min(1, '件号不能为空'),
  description: z.string().min(1, '描述不能为空'),
  partCategory: z.string().optional().default('CONSUMABLE'),
  trackingType: z.string().optional().default('BATCH'),
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
  eta: z.string().optional(),
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
  shelfLifeDays: z.number().int().min(0).optional(),
  storageTempMin: z.number().optional(),
  storageTempMax: z.number().optional(),
  hazardClass: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

export const emailClassifySchema = z.object({
  type: z.enum(['AOG', 'STANDARD', 'INQUIRY', 'SPAM']),
});

export const emailInquiryLinkSchema = z.object({
  inquiryId: z.string().trim().min(1, '询价单ID不能为空'),
  manualReason: z.string().trim().min(5, '人工关联说明至少5个字符').max(500).optional(),
}).strict();

const quoteDraftDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '报价有效期必须使用 YYYY-MM-DD 格式')
  .refine((value) => {
    const date = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, '报价有效期不是有效日期');

const quoteDraftIncotermSchema = z.string().trim().min(2, '贸易术语长度必须为2-20个字符')
  .max(20, '贸易术语长度必须为2-20个字符')
  .transform((value) => value.toUpperCase()).nullable().default(null);

const supplierQuoteDraftItemSchema = z.object({
  itemKey: z.string().trim().min(1, '报价草稿行标识不能为空').optional(),
  inquiryItemId: z.string().trim().min(1).nullable().optional(),
  partNumber: z.string().trim().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  quantityUnit: z.string().trim().min(1).nullable().optional(),
  quantity: z.number().finite().positive().nullable().optional(),
  unitPrice: z.number().finite().min(0).nullable().optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, '币种必须是三位字母代码')
    .transform((value) => value.toUpperCase()).nullable().optional(),
  leadTimeDays: z.number().finite().min(0).nullable().optional(),
  leadTimeMinDays: z.number().finite().min(0).nullable().optional(),
  leadTimeMaxDays: z.number().finite().min(0).nullable().optional(),
  validUntil: quoteDraftDateSchema.nullable().optional(),
  condition: z.string().trim().min(1).nullable().optional(),
  certificate: z.union([z.string(), z.boolean(), z.array(z.string())]).nullable().optional(),
  taxIncluded: z.boolean().nullable().default(null),
  freightIncluded: z.boolean().nullable().default(null),
  incoterm: quoteDraftIncotermSchema,
  evidenceText: z.string().max(10000).nullable().optional(),
  notes: z.string().nullable().optional(),
}).strict();

const supplierQuoteDraftConfirmItemSchema = supplierQuoteDraftItemSchema
  .extend({
    itemKey: z.string().trim().min(1, '报价草稿行标识不能为空'),
    inquiryItemId: z.string().trim().min(1, '询价需求项ID不能为空'),
    partNumber: z.string().trim().min(1, '件号不能为空'),
    quantity: z.number().int().min(1, '数量必须大于0'),
    unitPrice: z.number().finite().min(0, '单价不能小于0'),
    currency: z.literal('USD', { message: '确认报价仅支持 USD 币种' }),
    leadTimeDays: z.number().int().min(0, '交期不能小于0'),
  }).strict().superRefine((item, context) => {
    if (item.leadTimeMinDays != null || item.leadTimeMaxDays != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leadTimeMinDays'],
        message: '确认报价前必须将交期范围人工归一为单一交期',
      });
    }
  });

export const supplierQuoteDraftPayloadSchema = z.object({
  items: z.array(supplierQuoteDraftItemSchema).max(100),
}).strict().superRefine((payload, ctx) => {
  const seen = new Set<string>();
  payload.items.forEach((item, index) => {
    if (!item.itemKey) return;
    if (seen.has(item.itemKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'itemKey'],
        message: '报价草稿行标识不能重复',
      });
    }
    seen.add(item.itemKey);
  });
});

export const supplierQuoteDraftCreateSchema = z.object({
  emailId: z.string().trim().min(1, '邮件ID不能为空'),
  inquiryId: z.string().trim().min(1, '询价单ID不能为空'),
  payload: supplierQuoteDraftPayloadSchema,
}).strict();

export const supplierQuoteDraftPatchSchema = z.object({
  expectedVersion: z.number().int().positive('草稿版本必须为正整数'),
  payload: supplierQuoteDraftPayloadSchema,
}).strict();

export const supplierQuoteDraftConfirmSchema = z.object({
  expectedVersion: z.number().int().positive('草稿版本必须为正整数'),
}).strict();

export const supplierQuoteDraftExtractSchema = z.object({
  emailId: z.string().trim().min(1, '邮件ID不能为空'),
  inquiryId: z.string().trim().min(1, '询价单ID不能为空'),
}).strict();

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

export const AI_MODEL_PROVIDERS = ['openai', 'deepseek', 'ollama', 'custom'] as const;

const isLocalModelHost = (hostname: string) => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
};

const isValidModelBaseUrl = (value: string): boolean => {
  if (/[?#]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && isLocalModelHost(parsed.hostname);
  } catch {
    return false;
  }
};

const modelBaseUrlSchema = z.union([z.string().trim(), z.null()]).optional().refine(
  (value) => value === undefined || value === null || value === '' || isValidModelBaseUrl(value),
  '模型服务地址必须使用 HTTPS；本机服务仅允许 localhost、127.0.0.1 或 ::1 的 HTTP 地址',
);

const modelProviderSchema = z.string()
  .trim()
  .min(1, '供应商不能为空')
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(AI_MODEL_PROVIDERS, { message: '不支持的模型供应商' }));

const modelConfigSchema = z.record(z.unknown()).optional();

export const modelCreateSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空'),
  provider: modelProviderSchema,
  modelId: z.string().trim().min(1, '模型ID不能为空'),
  apiKey: z.union([z.string(), z.null()]).optional(),
  baseUrl: modelBaseUrlSchema,
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  config: modelConfigSchema,
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
  rfqLineId: z.string().min(1).optional(),
  inquiryId: z.string().optional(),
  inquiryItemId: z.string().min(1).optional(),
  supplierId: z.string().min(1, '供应商ID不能为空'),
  partNumber: z.string().min(1, '件号不能为空'),
  description: z.string().optional(),
  quantity: z.number().int().min(1, '数量必须大于0'),
  unitPrice: z.number().min(0, '单价必须大于0'),
  currency: z.string().trim().toUpperCase().default('USD').refine((value) => value === 'USD', '供应商报价仅支持 USD 币种'),
  leadTimeDays: z.number().int().min(0, '交期不能小于0'),
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

export const supplierQuoteDraftConfirmPayloadSchema = z.object({
  items: z.array(supplierQuoteDraftConfirmItemSchema).min(1).max(100),
}).strict().superRefine((payload, ctx) => {
  const seen = new Set<string>();
  payload.items.forEach((item, index) => {
    if (seen.has(item.itemKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'itemKey'],
        message: '报价草稿行标识不能重复',
      });
    }
    seen.add(item.itemKey);
  });
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
  'recorded_contact_follow_up',
  'portal_follow_up',
  'wechat_follow_up',
  'whatsapp_follow_up',
  'phone_follow_up',
  'contact_missing',
]).transform((value) => value === 'portal_follow_up' ? 'recorded_contact_follow_up' : value);

const supplierFollowUpOutcomeSchema = z.enum([
  'contacted_waiting_quote',
  'quote_promised',
  'follow_up_sent',
  'portal_message_sent',
  'contact_invalid',
]).transform((value) => value === 'portal_message_sent' ? 'follow_up_sent' : value);

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
  rfqId: z.string().min(1).optional(),
  rfqLineId: z.string().min(1).optional(),
  inquiryId: z.string().min(1).optional(),
  inquiryItemId: z.string().min(1).optional(),
  partNumber: z.string().min(1).optional(),
  quantity: z.number().int().min(1).optional(),
  unitPrice: z.number().min(0).optional(),
  currency: z.string().trim().toUpperCase().refine((value) => value === 'USD', '供应商报价仅支持 USD 币种').optional(),
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
  name: z.string().trim().min(1).optional(),
  provider: modelProviderSchema.optional(),
  modelId: z.string().trim().min(1).optional(),
  apiKey: z.union([z.string(), z.null()]).optional(),
  baseUrl: modelBaseUrlSchema,
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
