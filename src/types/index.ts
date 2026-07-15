// ============================================
// AeroLink 航材智能销售管理系统 - 类型定义
// ============================================

// 用户相关
export interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  role: 'sales' | 'manager' | 'finance' | 'admin' | 'gm';
  department: string;
  token?: string;
  lastLoginAt?: string;
  isActive?: boolean;
  activationPending?: boolean;
  activationExpiresAt?: string;
}

// 邮件相关
export type EmailType = 'aog' | 'standard' | 'inquiry' | 'spam';

export interface Email {
  id: string;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  receivedAt: string;
  type: EmailType;
  isRead: boolean;
  attachments?: string[];
}

// 需求单 (RFQ)
export type RFQStatus = 'pending' | 'sourcing' | 'quoting' | 'approved' | 'sent' | 'won' | 'lost';
export type UrgencyLevel = 'aog' | 'urgent' | 'standard';
export type ConditionCode = 'NE' | 'NS' | 'OH' | 'SV' | 'AR' | 'FN' | 'RP' | 'US';
export type CertificateType = 'AAC-038' | 'FAA-8130-3' | 'EASA-Form-1' | 'COC' | 'NONE';

export interface RFQ {
  id: string;
  rfqNumber: string;
  emailId?: string;
  customerId: string;
  customerName: string;
  partNumber: string;
  quantity: number;
  uom: string;
  conditionCode: ConditionCode;
  description?: string;
  serialNumber?: string;
  batchNumber?: string;
  ataChapter?: string;
  aircraftType?: string;
  aircraftModel?: string;
  alternatePartNumbers?: string[];
  targetPrice?: number;
  targetPriceCurrency: string;
  certificateRequired: boolean;
  certificateType?: CertificateType;
  requiredDate: string;
  responseDeadline?: string;
  leadTimeDays?: number;
  urgency: UrgencyLevel;
  urgencyJustification?: string;
  status: RFQStatus;
  createdAt: string;
  createdBy: string;
  notes?: string;
  partCategory?: PartCategory;
  trackingType?: TrackingType;
}

// 库存相关
export type InventoryStatus = 'NE' | 'NS' | 'OH' | 'SV' | 'AR' | 'RP' | 'US' | 'FN';
export type InventoryType = 'own' | 'in_transit' | 'virtual';
export type PartCategory = 'ROTABLE' | 'REPAIRABLE' | 'CONSUMABLE' | 'CHEMICAL' | 'STANDARD_PART' | 'RAW_MATERIAL';
export type TrackingType = 'SERIAL' | 'BATCH';

export interface Inventory {
  id: string;
  partNumber: string;
  description: string;
  quantity: number;
  // 航材核心标识
  serialNumber?: string;
  batchNumber?: string;
  // 航材分类体系
  partCategory: PartCategory;
  trackingType: TrackingType;
  manufacturer?: string;
  manufacturerCageCode?: string;
  ataChapter?: string;
  alternatePartNumbers?: string[];
  // 状态与条件
  conditionCode: InventoryStatus;
  certificateType: CertificateType;
  certificateNumber?: string;
  certificateFileUrl?: string;
  // 时寿与寿命
  lifeLimited?: boolean;
  totalHours?: number;
  totalCycles?: number;
  remainingHours?: number;
  remainingCycles?: number;
  manufactureDate?: string;
  shelfLifeDate?: string;
  overhaulDate?: string;
  nextOverhaulDue?: string;
  // 适航与维修状态
  adStatus?: string;
  sbStatus?: string;
  repairScheme?: string;
  // 来源追溯
  previousOperator?: string;
  removalAircraftReg?: string;
  removalDate?: string;
  removalReason?: string;
  nonIncidentStatement?: boolean;
  militarySource?: boolean;
  traceabilityDocs?: string[];
  // 存储与包装
  location: string;
  warehouse?: string;
  shelf?: string;
  storageCondition?: string;
  ata300Packaging?: boolean;
  // 化工品专用
  shelfLifeDays?: number;
  storageTempMin?: number;
  storageTempMax?: number;
  hazardClass?: string;
  // 商务属性
  unitCost: number;
  unitOfMeasure: string;
  countryOfOrigin?: string;
  hsCode?: string;
  type: InventoryType;
  supplierId?: string;
  supplierName?: string;
  eta?: string;
}

// ===== Phase 3: 库存明细层类型 =====

export interface InventoryItem {
  id: string;
  partNumber: string;
  description: string;
  partCategory: PartCategory;
  trackingType: TrackingType;
  manufacturer?: string;
  manufacturerCageCode?: string;
  ataChapter?: string;
  alternatePartNumbers?: string[];
  unitOfMeasure: string;
  countryOfOrigin?: string;
  hsCode?: string;
  createdAt: string;
  updatedAt: string;
  // 聚合统计
  totalQuantity?: number;
  availableQty?: number;
  reservedQty?: number;
  details?: InventoryDetail[];
}

export type InventoryDetailStatus = 'AVAILABLE' | 'RESERVED' | 'QUARANTINE' | 'SCRAPPED';

export interface InventoryDetail {
  id: string;
  inventoryItemId: string;
  // 追踪标识
  serialNumber?: string;
  batchNumber?: string;
  // 数量与状态
  quantity: number;
  conditionCode: InventoryStatus;
  status: InventoryDetailStatus;
  // 位置
  warehouse?: string;
  shelf?: string;
  location: string;
  // 证书
  certificateType: CertificateType;
  certificateNumber?: string;
  certificateFileUrl?: string;
  // 时寿与寿命
  lifeLimited?: boolean;
  totalHours?: number;
  remainingHours?: number;
  totalCycles?: number;
  remainingCycles?: number;
  manufactureDate?: string;
  shelfLifeDate?: string;
  overhaulDate?: string;
  nextOverhaulDue?: string;
  // 适航与维修状态
  adStatus?: string;
  sbStatus?: string;
  repairScheme?: string;
  // 来源追溯
  previousOperator?: string;
  removalAircraftReg?: string;
  removalDate?: string;
  removalReason?: string;
  nonIncidentStatement?: boolean;
  militarySource?: boolean;
  traceabilityDocs?: string[];
  // 存储与包装
  storageCondition?: string;
  ata300Packaging?: boolean;
  // 化工品专用
  shelfLifeDays?: number;
  storageTempMin?: number;
  storageTempMax?: number;
  hazardClass?: string;
  // 成本
  unitCost: number;
  // 来源
  supplierId?: string;
  supplierName?: string;
  eta?: string;
  // 类型
  type: InventoryType;
  createdAt: string;
  updatedAt: string;
  // 关联
  inventoryItem?: InventoryItem;
}

// 聚合视图：用于列表展示（兼容旧 Inventory 接口）
export interface InventoryAggregate extends InventoryItem {
  details: InventoryDetail[];
}

// ===== Phase 5: 库存事务（支持部分发货）=====
export type InventoryTransactionType = 'INBOUND' | 'OUTBOUND' | 'ADJUSTMENT' | 'TRANSFER' | 'RETURN';

export interface InventoryTransaction {
  id: string;
  inventoryDetailId: string;
  type: InventoryTransactionType;
  quantity: number; // 正数增加，负数减少
  beforeQuantity: number;
  afterQuantity: number;
  // 关联单据
  orderId?: string;
  quotationId?: string;
  referenceNo?: string;
  referenceType?: 'ORDER' | 'QUOTATION' | 'MANUAL' | 'SYSTEM';
  notes?: string;
  createdBy: string;
  createdAt: string;
  // 关联对象
  inventoryDetail?: InventoryDetail;
  order?: Order;
}

// 供应商相关
export type SupplierLevel = 'S' | 'A' | 'B' | 'C';
export type SupplierStatus = 'active' | 'pending' | 'inactive' | 'blocked';

export type SupplierType = 'OEM' | 'MRO' | 'Distributor' | 'Broker' | '145RepairStation';

export interface Supplier {
  id: string;
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  // 资质与合规（P2）
  supplierType: SupplierType;
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
  approvedPartCategories?: string[];
  specializesInAircraft?: string[];
  incotermsOffered?: string[];
  // Phase 4: 供应能力标签
  canSupplyRotable?: boolean;
  canSupplyChemical?: boolean;
  hasDangerousGoodsLicense?: boolean;
  hasColdChain?: boolean;
  // 绩效与商务
  level: SupplierLevel;
  status?: SupplierStatus;
  paymentTerms?: string;
  leadTime?: number;
  leadTimeAverage?: number;
  onTimeDeliveryRate?: number;
  performanceScore?: number;
  certificateTypesProvided?: string[];
  moqPolicy?: string;
  warrantyPolicy?: string;
  returnPolicy?: string;
  bankAccountInfo?: string;
  lastOrderDate?: string;
}

export type SupplierFollowUpAction =
  | 'portal_follow_up'
  | 'wechat_follow_up'
  | 'whatsapp_follow_up'
  | 'phone_follow_up'
  | 'contact_missing';

export type SupplierFollowUpOutcome =
  | 'contacted_waiting_quote'
  | 'quote_promised'
  | 'portal_message_sent'
  | 'contact_invalid';

export interface SupplierFollowUpLog {
  id: string;
  supplierId: string;
  supplierName: string;
  taskId: string;
  rfqId?: string;
  rfqNumber?: string;
  actionType: SupplierFollowUpAction;
  outcome: SupplierFollowUpOutcome;
  notes?: string;
  preferredChannel?: 'email' | 'phone' | 'manual';
  createdAt: string;
  createdBy: string;
}

// 客户相关
export type BuyerType = 'Broker' | 'MRO' | 'End User' | 'OEM' | 'Distributor';
export type CustomerStatus = 'active' | 'inactive' | 'at_risk';

export interface CustomerContact {
  id: string;
  customerId: string;
  name: string;
  email: string;
  phone?: string;
  role: 'purchaser' | 'quality_manager' | 'engineering_manager' | 'logistics' | 'gm';
  isDefault?: boolean;
  receiveRFQ?: boolean;
  receivePO?: boolean;
}

export interface CompetitorListing {
  id: string;
  customerId: string;
  competitorName: string;
  advantageParts?: string;
  priceLevel?: 'High' | 'Medium' | 'Low';
  notes?: string;
}

export interface Customer {
  id: string;
  name: string;
  buyerType: BuyerType;
  businessDescription?: string;
  contactName: string;
  email: string;
  phone?: string;
  registeredAddress?: string;
  shipToAddress?: string;
  shipForAddress?: string;
  shippingContactName?: string;
  shippingContactPhone?: string;
  creditLimit?: number;
  creditRating?: 'A' | 'B' | 'C' | 'D';
  paymentTerms?: string;
  paymentMethod?: string;
  annualRevenue?: number;
  vatNumber?: string;
  iataCode?: string;
  icaoCode?: string;
  aocNumber?: string;
  preferredIncoterm?: string;
  customsBroker?: string;
  qualityApprovalStatus?: 'Pending' | 'Approved' | 'Rejected';
  status: CustomerStatus;
  lastOrderDate?: string;
  qualityRequirements?: string[];
  decisionMakers?: DecisionMaker[];
  contacts?: CustomerContact[];
  competitorListings?: CompetitorListing[];
}

export interface DecisionMaker {
  id: string;
  name: string;
  title: string;
  role: 'purchaser' | 'quality_manager' | 'engineering_manager' | 'gm';
  concerns: string[];
  vetoItems?: string[];
}

// 报价单相关
export type QuoteStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'sent' | 'accepted' | 'expired' | 'withdrawn';
export type QuoteTemplate = 'standard' | 'aog' | 'rfp';
export type SaleType = 'Sale' | 'Exchange' | 'Loan' | 'Consign' | 'Repair';
export type Incoterm = 'EXW' | 'FCA' | 'CPT' | 'CIP' | 'DAP' | 'DPU' | 'DDP' | 'FAS' | 'FOB' | 'CFR' | 'CIF';

export interface Quotation {
  id: string;
  quoteNumber: string;
  rfqId: string;
  customerId: string;
  customerName: string;
  customerEmail?: string;
  customerContactName?: string;
  partNumber: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  costPrice: number;
  margin: number;
  // 销售与交付
  saleType: SaleType;
  shipToId?: string;
  shipForId?: string;
  incoterm?: Incoterm;
  incotermLocation?: string;
  leadTimeDays?: number;
  leadTimeBasis?: string;
  // 商务条款
  moq?: number;
  mpq?: number;
  priceBasis?: string;
  taxIncluded: boolean;
  taxRate?: number;
  warrantyDays: number;
  warrantyTerms?: string;
  validityDays: number;
  validityDeadline: string;
  // 物流与包装
  packagingRequirement?: string;
  shippingMethod?: string;
  // 质量与合规
  inspectionStandard?: string;
  inspectionReportIncluded?: boolean;
  certificateOfConformance?: boolean;
  countryOfOrigin?: string;
  hsCode?: string;
  eccn?: string;
  dualUse?: boolean;
  // 沟通
  ccRecipients?: string[];
  commonNote?: string;
  // 证书与文件
  certificateFiles: string[];
  template: QuoteTemplate;
  status: QuoteStatus;
  // 审批与流程
  createdAt: string;
  createdBy: string;
  approvedBy?: string;
  approvedAt?: string;
  sentAt?: string;
  acceptedAt?: string;
  withdrawnAt?: string;
  withdrawalReason?: string;
  customerConfirmationNote?: string;
  // 电子签名
  eSignature?: string;
  eSignatureStatus?: 'Unsigned' | 'Signed' | 'Rejected';
  orderId?: string;
  orderNumber?: string;
  contractDocumentId?: string;
  contractDocumentTitle?: string;
  lastEmailStatus?: string;
  lastEmailSentAt?: string;
  expiryDate: string;
  // AOG 快速审批
  rfqUrgency?: string;
  // Phase 4: 库存明细绑定
  inventoryDetailId?: string;
  serialNumber?: string;
  batchNumber?: string;
  // Phase 5: 部分发货支持（报价阶段可预留库存）
  reservedQuantity?: number;
}

export interface DocumentTemplate {
  id: string;
  name: string;
  code: string;
  documentType: string;
  description?: string;
  bodyTemplate: string;
  headerTemplate?: string;
  footerTemplate?: string;
  isActive: boolean;
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdById?: string;
}

export interface GeneratedDocument {
  id: string;
  templateId?: string;
  templateName?: string;
  quotationId?: string;
  orderId?: string;
  customerId?: string;
  documentType: string;
  title: string;
  status: string;
  generatedAt: string;
  generatedById?: string;
  contentHtml?: string;
}

// 审批相关
export type ApprovalLevel = 'manager' | 'finance' | 'gm';
export type ApprovalAction = 'approve' | 'reject' | 'revise';

export interface Approval {
  id: string;
  quotationId: string;
  quoteNumber: string;
  level: ApprovalLevel;
  approverId: string;
  approverName: string;
  action: ApprovalAction;
  comment?: string;
  createdAt: string;
}

// 订单相关
export type OrderStatus = 
  | 'so_created' 
  | 'po_created' 
  | 'shipped' 
  | 'in_transit' 
  | 'customs' 
  | 'inspection' 
  | 'delivered' 
  | 'completed';

export interface Order {
  id: string;
  orderNumber: string;
  soNumber: string;
  poNumber?: string;
  quotationId: string;
  customerId: string;
  customerName: string;
  partNumber: string;
  quantity: number;
  totalAmount: number;
  status: OrderStatus;
  createdAt: string;
  deliveryDate?: string;
  trackingNumber?: string;
  carrier?: string;
  contractDocumentId?: string;
  contractDocumentTitle?: string;
  // 销售与交付（P2）
  saleType?: string;
  incoterm?: string;
  incotermLocation?: string;
  shipToId?: string;
  shipForId?: string;
  // 质保（P2）
  warrantyDays?: number;
  warrantyStartDate?: string;
  // 证书与合规（P2）
  certificateRequired?: boolean;
  certificateType?: string;
  certificateDelivered?: boolean;
  // 物流与包装（P2）
  packagingStandard?: string;
  shippingMethod?: string;
  carrierAccount?: string;
  // 检验（P2）
  inspectionRequired?: boolean;
  inspectionPassed?: boolean;
  inspectionDate?: string;
  // 清关与税务（P2）
  customsClearanceRequired?: boolean;
  customsDeclarationNo?: string;
  importDuty?: number;
  vatAmount?: number;
  totalLandCost?: number;
  estimatedShipping?: number;
  estimatedInsurance?: number;
  // 订单号映射（P2）
  poNumberCustomer?: string;
  soNumberInternal?: string;
  // 交换件（P2）
  exchangeCoreCharge?: number;
  exchangeCoreDueDate?: string;
  // 电子签名（P2）
  eSignatureCustomer?: string;
  eSignatureSupplier?: string;
  // Phase 4: 库存明细绑定
  inventoryDetailId?: string;
  serialNumber?: string;
  batchNumber?: string;
  // Phase 5: 部分发货支持
  outboundQuantity?: number;
  outboundStatus?: 'PENDING' | 'PARTIAL' | 'COMPLETED';
}

// 看板数据
export interface DashboardStats {
  pendingRFQs: number;
  pendingQuotes: number;
  pendingApprovals: number;
  weeklyRevenue: number;
  rfqTrend: number;
  quoteTrend: number;
  approvalTrend: number;
  revenueTrend: number;
}

export interface SalesFunnel {
  stage: string;
  count: number;
  amount: number;
}

export interface CustomerAlert {
  customerId: string;
  customerName: string;
  daysSinceQuote: number;
  quoteNumber: string;
}

export interface InventoryAlert {
  partNumber: string;
  currentStock: number;
  safetyStock: number;
  warehouse: string;
}

// 询价单相关
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
  status: 'draft' | 'sent' | 'responded' | 'expired';
  createdAt: string;
  sentAt?: string;
}

// 通知相关
export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: string;
  title: string;
  message: string;
  type: NotificationType;
  isRead: boolean;
  createdAt: string;
  link?: string;
}

// ============================================
// Phase 2 新增类型定义
// ============================================

// IPC数据相关
export interface IPCData {
  id: string;
  partNumber: string;
  description: string;
  ataChapter: string;
  aircraftTypes: string[];
  supersededBy?: string;
  interchangeableWith?: string[];
  alternateParts?: string[];
  sbList?: ServiceBulletin[];
}

export interface ServiceBulletin {
  id: string;
  sbNumber: string;
  title: string;
  applicability: string[];
  mandatory: boolean;
  issueDate: string;
}

// 件号适用性检查
export interface PartCompatibility {
  partNumber: string;
  aircraftType: string;
  msn: string;
  isCompatible: boolean;
  warnings?: string[];
  sbRequirements?: string[];
}

// Exchange管理相关
export interface ExchangeQuote {
  id: string;
  quoteId: string;
  coreCharge: number;
  coreEvaluationCriteria: string;
  acceptableDamageRange: string;
  returnDeadline: number; // days
  coreReturnLabel?: string;
  coreReturned: boolean;
  coreReturnDate?: string;
  coreTrackingNumber?: string;
}

// VMI管理相关
export interface VMIAgreement {
  id: string;
  customerId: string;
  customerName: string;
  partNumber: string;
  minStock: number;
  maxStock: number;
  reorderPoint: number;
  reorderQty: number;
  consumptionData: VMICosumption[];
}

export interface VMICosumption {
  month: string;
  quantity: number;
}

export interface VMIRestockSuggestion {
  id: string;
  vmiId: string;
  partNumber: string;
  customerName: string;
  currentStock: number;
  suggestedQty: number;
  reason: string;
  expectedDeliveryDate: string;
}

// 市场情报相关
export interface MarketIntelligence {
  partNumber: string;
  avgMarketPrice: number;
  priceRange: { min: number; max: number };
  marketDemand: 'high' | 'medium' | 'low';
  demandTrend: 'up' | 'down' | 'stable';
  inquiryCount30d: number;
  lastUpdated: string;
  source: string;
}

// 丢单原因分析
export interface LostOrderAnalysis {
  quotationId: string;
  partNumber: string;
  customerId: string;
  reason: 'price' | 'delivery' | 'certificate' | 'no_demand' | 'other';
  reasonDetail?: string;
  competitorPrice?: number;
  competitorDelivery?: number;
  createdAt: string;
}

// 证书管理相关
export type CertificateStatus = 'ISSUED' | 'REVOKED' | 'EXPIRED' | 'RENEWED';

export interface Certificate {
  id: string;
  certificateNumber: string;
  partNumber: string;
  certificateType: CertificateType;
  status: CertificateStatus;
  issueDate: string;
  expiryDate: string;
  issuedBy: string;
  issuedTo?: string;
  serialNumber?: string;
  batchNumber?: string;
  description?: string;
  fileUrl?: string;
  revokedAt?: string;
  revokeReason?: string;
  renewedFromId?: string;
  renewedToId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CertificateTemplate {
  id: string;
  name: string;
  code: string;
  certificateType: CertificateType;
  bodyTemplate: string;
  headerTemplate?: string;
  footerTemplate?: string;
  isActive: boolean;
  isDefault: boolean;
  version: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
  createdById?: string;
}

export interface CertificateTraceEvent {
  id: string;
  certificateId: string;
  eventType: 'ISSUED' | 'VERIFIED' | 'RENEWED' | 'REVOKED' | 'VIEWED';
  eventDate: string;
  actor: string;
  notes?: string;
}

// 动态定价建议
export interface PricingSuggestion {
  partNumber: string;
  currentPrice: number;
  suggestedPrice: number;
  suggestedMargin: number;
  reason: string;
  factors: PricingFactor[];
}

export interface PricingFactor {
  factor: string;
  impact: 'positive' | 'negative' | 'neutral';
  weight: number;
}

// ============================================
// Phase 1.3: 工作流引擎类型
// ============================================

export type WorkflowStatus = 'RUNNING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'TIMEOUT';
export type WorkflowStepStatus = 'PENDING' | 'IN_PROGRESS' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'TIMEOUT';
export type WorkflowStepType = 'APPROVAL' | 'NOTIFICATION' | 'CONDITION' | 'AUTOMATION';
export type WorkflowActionType = 'APPROVE' | 'REJECT' | 'TRANSFER' | 'COMMENT' | 'ESCALATE' | 'AUTO_ACTION';

export interface WorkflowDefinition {
  id: string;
  name: string;
  code: string;
  description?: string;
  entityType: string;
  isActive: boolean;
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  instanceCount?: number;
  steps?: WorkflowStep[];
}

export interface WorkflowStep {
  id: string;
  workflowId: string;
  name: string;
  stepOrder: number;
  stepType: WorkflowStepType;
  approverRole?: string;
  approverUserId?: string;
  approverDepartment?: string;
  agentId?: string; // AI Agent 审批人
  isParallel: boolean;
  parallelMinCount?: number;
  timeoutHours: number;
  timeoutAction: string;
  conditionExpression?: string;
  autoAction?: string;
  notificationTemplate?: string;
  createdAt: string;
}

export interface WorkflowInstance {
  id: string;
  definitionId: string;
  definition?: WorkflowDefinition;
  entityType: string;
  entityId: string;
  status: WorkflowStatus;
  currentStepId?: string;
  startedAt: string;
  completedAt?: string;
  startedBy: string;
  context: string;
  steps?: WorkflowInstanceStep[];
  actions?: WorkflowAction[];
}

export interface WorkflowInstanceStep {
  id: string;
  instanceId: string;
  instance?: WorkflowInstance;
  stepId: string;
  step?: WorkflowStep;
  stepOrder: number;
  status: WorkflowStepStatus;
  assignedTo?: string;
  assignedRole?: string;
  startedAt?: string;
  completedAt?: string;
  dueAt?: string;
  result?: string;
  actions?: WorkflowAction[];
}

export interface WorkflowAction {
  id: string;
  instanceId: string;
  instanceStepId?: string;
  actionType: WorkflowActionType;
  actorId: string;
  actorRole?: string;
  actorName?: string;
  comment?: string;
  payload: string;
  createdAt: string;
}

// ============================================
// Phase 1.4: 操作日志审计类型
// ============================================

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'VIEW' | 'LOGIN' | 'LOGOUT' | 'EXPORT' | 'APPROVE' | 'REJECT';
export type AuditResourceType = 'RFQ' | 'QUOTATION' | 'ORDER' | 'INVENTORY' | 'CUSTOMER' | 'SUPPLIER' | 'CERTIFICATE' | 'SETTINGS' | 'WORKFLOW';
export type AuditStatus = 'SUCCESS' | 'FAILURE';

export interface AuditLog {
  id: string;
  userId?: string;
  userName?: string;
  userRole?: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  resourceName?: string;
  changes?: string;
  details?: string;
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  status: AuditStatus;
  errorMessage?: string;
  createdAt: string;
}

export interface AuditLogFilter {
  userId?: string;
  action?: AuditAction;
  resourceType?: AuditResourceType;
  resourceId?: string;
  status?: AuditStatus;
  startDate?: string;
  endDate?: string;
  search?: string;
}

// 物流追踪相关
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

// 清关风险预警
export interface CustomsRisk {
  partNumber: string;
  hsCode: string;
  riskLevel: 'high' | 'medium' | 'low';
  inspectionRate: number;
  requiredDocs: string[];
  recommendations: string[];
}

// 供应商门户相关
export interface SupplierPortalUser {
  id: string;
  supplierId: string;
  email: string;
  name: string;
  role: 'admin' | 'sales' | 'logistics';
  lastLogin?: string;
}

export interface SupplierInventoryUpload {
  id: string;
  supplierId: string;
  uploadDate: string;
  fileName: string;
  items: SupplierInventoryItem[];
  status: 'processing' | 'completed' | 'error';
}

export interface SupplierInventoryItem {
  partNumber: string;
  quantity: number;
  condition: string;
  price: number;
  certificateType: string;
  location: string;
}
