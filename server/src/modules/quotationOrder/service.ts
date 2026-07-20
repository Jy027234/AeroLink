import type { Customer, Order, Prisma, Quotation } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { enqueueBusinessEvent, enqueueOutboundEmail } from '../../lib/outboxService.js';
import { isOrderStatusTransitionAllowed, normalizeOrderStatus } from '../../lib/orderStateMachine.js';
import { isQuotationTransitionAllowed, normalizeQuotationStatus, type QuotationStatus } from '../../lib/quotationStateMachine.js';
import {
  calculateMarginPercent,
  calculateMoneyTotal,
  normalizeMoney,
  normalizeOptionalMoney,
  preferredMoneyValue,
} from '../../lib/money.js';
import { isRfqStatusTransitionAllowed, normalizeRfqStatus } from '../../lib/rfqStateMachine.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { releaseInventoryReservation } from '../inventoryQuality/index.js';
import {
  createInitialStatusHistory,
  transitionOrderStatus,
  transitionQuotationStatus,
  transitionRfqStatus,
} from '../../lib/transactionStateService.js';
import {
  preferredOrderStatus,
  preferredQuotationStatus,
  preferredRfqStatus,
  toOrderStatusEnum,
  toQuotationStatusEnum,
} from '../../lib/transactionStatusShadows.js';

export { createInitialStatusHistory, transitionOrderStatus, transitionQuotationStatus, transitionRfqStatus };

export function buildSalesOrderNumber() {
  return `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

type QuotationRfqAccess = {
  createdBy: string;
  creator?: { department?: string | null } | null;
};

type CreateQuotationArgs = {
  tx: Prisma.TransactionClient;
  actorId: string;
  rfqId: string;
  customerId: string;
  partNumber: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  certificateFiles?: string[] | string;
  template?: string;
  validityDays?: number;
  saleType?: string;
  shipToId?: string;
  shipForId?: string;
  incoterm?: string;
  incotermLocation?: string;
  leadTimeDays?: number;
  leadTimeBasis?: string;
  moq?: number;
  mpq?: number;
  priceBasis?: string;
  taxIncluded?: boolean;
  taxRate?: number;
  warrantyDays?: number;
  warrantyTerms?: string;
  packagingRequirement?: string;
  shippingMethod?: string;
  ccRecipients?: string[] | string;
  commonNote?: string;
  eSignature?: string;
  eSignatureStatus?: string;
  countryOfOrigin?: string;
  hsCode?: string;
  eccn?: string;
  dualUse?: boolean;
  authorizeRfq?: (rfq: QuotationRfqAccess) => void;
};

function quotationStatus(quotation: Pick<Quotation, 'status' | 'statusEnum'>) {
  return preferredQuotationStatus(quotation.statusEnum, quotation.status);
}

function rfqStatus(rfq: { status: string; statusEnum?: Parameters<typeof preferredRfqStatus>[0] }) {
  return preferredRfqStatus(rfq.statusEnum, rfq.status);
}

function quotationTotalPrice(quotation: Pick<Quotation, 'totalPrice' | 'totalPriceDecimal'>) {
  return preferredMoneyValue(quotation.totalPriceDecimal, quotation.totalPrice) ?? 0;
}

/**
 * Creates a quotation and owns the AOG RFQ transition, approval notification,
 * status history and outbox events in the same transaction as the write.
 * Capability checks remain injected by the HTTP boundary so this service does
 * not depend on Express or actor request objects.
 */
export async function createQuotationAggregate(args: CreateQuotationArgs) {
  const relatedRfq = args.rfqId
    ? await args.tx.rFQ.findUnique({
      where: { id: args.rfqId },
      include: { creator: { select: { department: true } } },
    })
    : null;

  if (relatedRfq) {
    args.authorizeRfq?.(relatedRfq);
  }

  const isAog = relatedRfq?.urgency.toUpperCase() === 'AOG';
  const finalValidityDays = isAog ? 1 : (args.validityDays || 7);
  const unitPriceDecimal = normalizeMoney(args.unitPrice);
  const costPriceDecimal = normalizeMoney(args.costPrice);
  const totalPriceDecimal = calculateMoneyTotal(unitPriceDecimal, args.quantity);
  const margin = calculateMarginPercent(totalPriceDecimal, costPriceDecimal, args.quantity);
  const quoteNumber = `QT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + finalValidityDays);

  const initialStatus = isAog ? 'PENDING_APPROVAL' : 'DRAFT';
  const initialStatusEnum = toQuotationStatusEnum(initialStatus)!;
  const quotation = await args.tx.quotation.create({
    data: {
      quoteNumber,
      rfqId: args.rfqId,
      customerId: args.customerId,
      partNumber: args.partNumber,
      quantity: args.quantity,
      unitPrice: unitPriceDecimal.toNumber(),
      unitPriceDecimal,
      totalPrice: totalPriceDecimal.toNumber(),
      totalPriceDecimal,
      costPrice: costPriceDecimal.toNumber(),
      costPriceDecimal,
      margin,
      certificateFiles: Array.isArray(args.certificateFiles) ? args.certificateFiles.join(',') : args.certificateFiles,
      template: args.template?.toUpperCase() || 'STANDARD',
      status: initialStatus,
      statusEnum: initialStatusEnum,
      validityDays: finalValidityDays,
      saleType: args.saleType || 'Sale',
      shipToId: args.shipToId || null,
      shipForId: args.shipForId || null,
      incoterm: args.incoterm || null,
      incotermLocation: args.incotermLocation || null,
      leadTimeDays: args.leadTimeDays || null,
      leadTimeBasis: args.leadTimeBasis || null,
      moq: args.moq || null,
      mpq: args.mpq || null,
      priceBasis: args.priceBasis || null,
      taxIncluded: args.taxIncluded !== undefined ? args.taxIncluded : true,
      taxRate: args.taxRate || null,
      warrantyDays: args.warrantyDays || 90,
      warrantyTerms: args.warrantyTerms || null,
      packagingRequirement: args.packagingRequirement || null,
      shippingMethod: args.shippingMethod || null,
      ccRecipients: Array.isArray(args.ccRecipients) ? JSON.stringify(args.ccRecipients) : args.ccRecipients || null,
      commonNote: args.commonNote || null,
      eSignature: args.eSignature || null,
      eSignatureStatus: args.eSignatureStatus || 'Unsigned',
      countryOfOrigin: args.countryOfOrigin || null,
      hsCode: args.hsCode || null,
      eccn: args.eccn || null,
      dualUse: args.dualUse !== undefined ? args.dualUse : false,
      expiryDate,
      createdBy: args.actorId,
    },
    include: { customer: true },
  });

  await createInitialStatusHistory(args.tx, {
    entityType: 'QUOTATION',
    entityId: quotation.id,
    toStatus: quotationStatus(quotation),
    reasonCode: isAog ? 'AOG_QUOTATION_CREATED' : 'QUOTATION_CREATED',
    actorId: args.actorId,
    version: quotation.version,
  });

  const relatedRfqStatus = relatedRfq ? rfqStatus(relatedRfq) : null;
  if (isAog && relatedRfq && relatedRfqStatus !== 'QUOTING') {
    if (!normalizeRfqStatus(relatedRfqStatus) || !isRfqStatusTransitionAllowed(relatedRfqStatus, 'QUOTING')) {
      throw new AppError('AOG 报价不能将当前 RFQ 变更为报价中', 409, 'INVALID_STATE_TRANSITION');
    }
    const updatedRfq = await transitionRfqStatus(args.tx, {
      id: relatedRfq.id,
      currentStatus: relatedRfq.status,
      currentVersion: relatedRfq.version,
      nextStatus: 'QUOTING',
      actorId: args.actorId,
      reasonCode: 'AOG_QUOTATION_CREATED',
      reason: `AOG quotation ${quotation.quoteNumber} created.`,
    });
    await enqueueBusinessEvent(args.tx, {
      eventType: 'rfq.status.changed',
      aggregateType: 'RFQ',
      aggregateId: updatedRfq.id,
      data: {
        rfqId: updatedRfq.id,
        rfqNumber: updatedRfq.rfqNumber,
        oldStatus: relatedRfqStatus,
        newStatus: rfqStatus(updatedRfq),
        changedBy: args.actorId,
        changedAt: new Date().toISOString(),
      },
      socket: { room: SocketRooms.RFQS, event: SocketEvents.RFQ_UPDATED },
      createdById: args.actorId,
    });
  }

  if (isAog) {
    const managers = await args.tx.user.findMany({
      where: { role: { in: ['MANAGER', 'GM'] }, isActive: true },
      select: { id: true },
    });
    if (managers.length > 0) {
      await args.tx.notification.createMany({
        data: managers.map((manager) => ({
          userId: manager.id,
          title: 'AOG 报价单待审批',
          message: `AOG 紧急报价单 ${quotation.quoteNumber}（件号 ${quotation.partNumber}）已创建，请尽快审批。有效期仅 1 天。`,
          type: 'warning',
          link: `/quotations/${quotation.id}`,
        })),
      });
    }
  }

  await enqueueBusinessEvent(args.tx, {
    eventType: 'quotation.created',
    aggregateType: 'QUOTATION',
    aggregateId: quotation.id,
    data: {
      quotationId: quotation.id,
      quoteNumber: quotation.quoteNumber,
      customerId: quotation.customerId,
      customerName: quotation.customer.name,
      rfqId: quotation.rfqId,
      status: quotationStatus(quotation),
      totalPrice: quotationTotalPrice(quotation),
      margin: quotation.margin,
      createdBy: args.actorId,
    },
    socket: { room: SocketRooms.QUOTATIONS, event: SocketEvents.QUOTATION_CREATED },
    createdById: args.actorId,
  });

  return { quotation, relatedRfq };
}

/** Submit a quotation for approval while keeping its state history and event transactional. */
export async function submitQuotationAggregate(args: {
  tx: Prisma.TransactionClient;
  quotationId: string;
  actorId: string;
  expectedVersion?: number;
  reasonCode?: string;
  reason?: string;
  authorize?: QuotationAuthorization;
}) {
  const currentQuotation = await args.tx.quotation.findUnique({
    where: { id: args.quotationId },
    include: { creator: { select: { department: true } } },
  });
  if (!currentQuotation) throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
  args.authorize?.(currentQuotation);

  const currentQuotationStatus = quotationStatus(currentQuotation);
  assertQuotationTransition(currentQuotationStatus, 'PENDING_APPROVAL');
  const isNoop = currentQuotationStatus === 'PENDING_APPROVAL';
  const quotation = isNoop
    ? currentQuotation
    : await transitionQuotationStatus(args.tx, {
      id: currentQuotation.id,
      currentStatus: currentQuotation.status,
      currentVersion: currentQuotation.version,
      nextStatus: 'PENDING_APPROVAL',
      expectedVersion: args.expectedVersion,
      actorId: args.actorId,
      reasonCode: args.reasonCode || 'QUOTATION_SUBMITTED_FOR_APPROVAL',
      reason: args.reason,
    });

  if (!isNoop) {
    await enqueueBusinessEvent(args.tx, {
      eventType: 'quotation.submitted',
      aggregateType: 'QUOTATION',
      aggregateId: quotation.id,
      data: {
        quotationId: quotation.id,
        quoteNumber: quotation.quoteNumber,
        status: quotationStatus(quotation),
        submittedBy: args.actorId,
        submittedAt: new Date().toISOString(),
      },
      socket: { room: SocketRooms.QUOTATIONS, event: SocketEvents.QUOTATION_SUBMITTED },
      createdById: args.actorId,
    });
  }

  return { quotation, isNoop };
}

/** Approves/rejects a quotation and records the approval decision atomically. */
export async function approveQuotationAggregate(args: {
  tx: Prisma.TransactionClient;
  quotationId: string;
  actorId: string;
  action: 'approve' | 'reject';
  comment?: string;
  expectedVersion?: number;
  reasonCode?: string;
  authorize?: QuotationAuthorization;
}) {
  const quotationWithRfq = await args.tx.quotation.findUnique({
    where: { id: args.quotationId },
    include: {
      rfq: true,
      creator: { select: { department: true } },
    },
  });
  if (!quotationWithRfq) throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
  args.authorize?.(quotationWithRfq);

  const isAog = quotationWithRfq.rfq?.urgency?.toUpperCase() === 'AOG';
  const targetStatus = args.action === 'approve' ? 'APPROVED' : 'REJECTED';
  const currentQuotationStatus = quotationStatus(quotationWithRfq);
  assertQuotationTransition(currentQuotationStatus, targetStatus);
  const isNoop = currentQuotationStatus === targetStatus;
  const quotation = isNoop
    ? quotationWithRfq
    : await transitionQuotationStatus(args.tx, {
      id: quotationWithRfq.id,
      currentStatus: quotationWithRfq.status,
      currentVersion: quotationWithRfq.version,
      nextStatus: targetStatus,
      expectedVersion: args.expectedVersion,
      actorId: args.actorId,
      reasonCode: args.reasonCode || (args.action === 'approve' ? 'QUOTATION_APPROVED' : 'QUOTATION_REJECTED'),
      reason: args.comment,
      data: {
        approvedBy: args.action === 'approve' ? args.actorId : null,
        approvedAt: args.action === 'approve' ? new Date() : null,
      },
    });

  if (!isNoop) {
    await args.tx.approval.create({
      data: {
        quotationId: args.quotationId,
        level: isAog ? 'AOG' : (quotationTotalPrice(quotation) > 50000 ? 'GM' : quotationTotalPrice(quotation) > 5000 ? 'FINANCE' : 'MANAGER'),
        approverId: args.actorId,
        action: args.action.toUpperCase(),
        comment: args.comment,
      },
    });
    await enqueueBusinessEvent(args.tx, {
      eventType: args.action === 'approve' ? 'quotation.approved' : 'quotation.rejected',
      aggregateType: 'QUOTATION',
      aggregateId: quotation.id,
      data: {
        quotationId: quotation.id,
        quoteNumber: quotation.quoteNumber,
        status: quotationStatus(quotation),
        totalPrice: quotationTotalPrice(quotation),
        comment: args.comment,
        approvedBy: args.action === 'approve' ? args.actorId : null,
        reviewedBy: args.actorId,
        reviewedAt: new Date().toISOString(),
      },
      socket: {
        room: SocketRooms.QUOTATIONS,
        event: args.action === 'approve' ? SocketEvents.QUOTATION_APPROVED : SocketEvents.QUOTATION_UPDATED,
      },
      createdById: args.actorId,
    });
  }

  return { quotation, isNoop };
}

type QuotationAuthorization = (quotation: {
  createdBy: string;
  creator?: { department?: string | null } | null;
}) => void;

function textToHtml(text: string) {
  return text
    .split('\n')
    .map((line) => `<p>${line}</p>`)
    .join('');
}

/**
 * Queues a quotation email and owns the send-time validation/write set.
 * Delivery remains a Worker concern; this use case only creates the
 * OutboundEmail record and its transactional outbox event.
 */
export async function sendQuotationAggregate(args: {
  tx: Prisma.TransactionClient;
  quotationId: string;
  actorId: string;
  subject?: string;
  message?: string;
  authorize?: QuotationAuthorization;
  getDefaultOutboundAccount: OutboundAccountLookup;
}) {
  const quotation = await args.tx.quotation.findUnique({
    where: { id: args.quotationId },
    include: {
      customer: true,
      creator: { select: { department: true } },
    },
  });
  if (!quotation) throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
  args.authorize?.(quotation);

  const currentQuotationStatus = quotationStatus(quotation);
  if (currentQuotationStatus === 'WITHDRAWN') {
    throw new AppError('已撤回的报价不能再次发送，请复制或新建报价后重新发送', 400, 'BAD_REQUEST');
  }
  assertQuotationTransition(currentQuotationStatus, 'SENT');
  if (!['APPROVED', 'SENT'].includes(currentQuotationStatus)) {
    throw new AppError('只有已审批报价才能发送给客户', 400, 'BAD_REQUEST');
  }
  if (!quotation.customer.email) {
    throw new AppError('客户未配置邮箱地址，无法发送报价', 400, 'BAD_REQUEST');
  }

  const account = await args.getDefaultOutboundAccount(args.tx);
  const subject = args.subject || `Quotation ${quotation.quoteNumber} - ${quotation.partNumber}`;
  const plainBody = args.message || [
    `${quotation.customer.contactName || quotation.customer.name} 您好，`,
    '',
    `附件为报价单 ${quotation.quoteNumber}，对应件号 ${quotation.partNumber}。`,
    `数量：${quotation.quantity}`,
    `总价：USD ${quotationTotalPrice(quotation).toLocaleString('en-US')}`,
    `销售类型：${quotation.saleType || 'Sale'}`,
    `贸易术语：${quotation.incoterm || '-'} ${quotation.incotermLocation || ''}`,
    `交货期：${quotation.leadTimeDays || '-'} 天`,
    `含税：${quotation.taxIncluded ? '是' : '否'}${quotation.taxRate ? ` (税率 ${quotation.taxRate}%)` : ''}`,
    `质保：${quotation.warrantyDays || 90} 天`,
    '',
    '如确认报价，请在系统中登记客户确认，系统将自动生成销售订单与合同。',
    '',
    'AeroLink 销售团队',
  ].join('\n');
  const pendingEmail = await args.tx.outboundEmail.create({
    data: {
      purpose: 'QUOTATION_SEND',
      quotationId: quotation.id,
      customerId: quotation.customerId,
      accountId: account.id,
      toEmail: quotation.customer.email,
      subject,
      textBody: plainBody,
      htmlBody: textToHtml(plainBody),
      status: 'PENDING',
    },
  });
  await enqueueOutboundEmail(args.tx, {
    eventType: 'quotation.email.send',
    aggregateType: 'QUOTATION',
    aggregateId: quotation.id,
    outboundEmailId: pendingEmail.id,
    includeQuotationPdf: true,
    createdById: args.actorId,
  });

  return { quotation, pendingEmail };
}

type ContractDocument = { id: string; title: string };

type EnsureContractDocument = (args: {
  quotation: Quotation;
  customer: Customer;
  order: Order & { customer: Customer };
  templateId?: string;
  generatedById: string;
  tx: Prisma.TransactionClient;
}) => Promise<ContractDocument>;

/**
 * Accepts a quotation and creates/reuses the sales order and contract in one
 * transaction. The document generator and order factory are injected so the
 * module remains independent from the HTTP and document infrastructure.
 */
export async function acceptQuotationAggregate(args: {
  tx: Prisma.TransactionClient;
  quotationId: string;
  actorId: string;
  poNumber?: string;
  deliveryDate?: string;
  templateId?: string;
  confirmationNote?: string;
  reasonCode?: string;
  reason?: string;
  expectedVersion?: number;
  authorize?: QuotationAuthorization;
  createOrder?: typeof createOrderFromQuotation;
  ensureContractDocument: EnsureContractDocument;
}) {
  const quotation = await args.tx.quotation.findUnique({
    where: { id: args.quotationId },
    include: {
      customer: true,
      creator: { select: { department: true } },
    },
  });
  if (!quotation) throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
  args.authorize?.(quotation);

  const currentQuotationStatus = quotationStatus(quotation);
  if (currentQuotationStatus === 'WITHDRAWN') {
    throw new AppError('已撤回的报价不能登记客户确认', 400, 'BAD_REQUEST');
  }
  assertQuotationTransition(currentQuotationStatus, 'ACCEPTED');
  if (!['APPROVED', 'SENT', 'ACCEPTED'].includes(currentQuotationStatus)) {
    throw new AppError('当前报价状态不能登记客户确认', 400, 'BAD_REQUEST');
  }

  const wasAlreadyAccepted = currentQuotationStatus === 'ACCEPTED';
  const updatedQuotation = wasAlreadyAccepted
    ? quotation
    : await transitionQuotationStatus(args.tx, {
      id: quotation.id,
      currentStatus: quotation.status,
      currentVersion: quotation.version,
      nextStatus: 'ACCEPTED',
      expectedVersion: args.expectedVersion,
      actorId: args.actorId,
      reasonCode: args.reasonCode || 'CUSTOMER_ACCEPTED_QUOTATION',
      reason: args.confirmationNote ?? args.reason,
      data: {
        acceptedAt: quotation.acceptedAt || new Date(),
        customerConfirmationNote: args.confirmationNote ?? quotation.customerConfirmationNote,
      },
    });

  const existingOrder = await args.tx.order.findFirst({
    where: { quotationId: quotation.id },
    include: { customer: true },
  });
  const createOrder = args.createOrder || createOrderFromQuotation;
  const order = existingOrder || await createOrder({
    tx: args.tx,
    quotation: updatedQuotation,
    customer: quotation.customer,
    poNumber: args.poNumber,
    deliveryDate: args.deliveryDate,
    actorId: args.actorId,
    reasonCode: 'ORDER_CREATED_FROM_ACCEPTED_QUOTATION',
    reason: args.confirmationNote ?? args.reason,
  });
  const isNewOrder = !existingOrder;
  const generatedDocument = await args.ensureContractDocument({
    quotation: updatedQuotation,
    customer: quotation.customer,
    order,
    templateId: args.templateId,
    generatedById: args.actorId,
    tx: args.tx,
  });

  if (isNewOrder || !wasAlreadyAccepted) {
    await enqueueBusinessEvent(args.tx, {
      eventType: 'quotation.accepted',
      aggregateType: 'QUOTATION',
      aggregateId: updatedQuotation.id,
      data: {
        quotationId: updatedQuotation.id,
        quoteNumber: updatedQuotation.quoteNumber,
        acceptedAt: updatedQuotation.acceptedAt?.toISOString(),
        orderId: order.id,
        contractDocumentId: generatedDocument.id,
        autoCreatedOrder: isNewOrder,
      },
      socket: { room: SocketRooms.QUOTATIONS, event: SocketEvents.QUOTATION_UPDATED },
      createdById: args.actorId,
    });
  }
  if (isNewOrder) {
    await enqueueBusinessEvent(args.tx, {
      eventType: 'order.created',
      aggregateType: 'ORDER',
      aggregateId: order.id,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        soNumber: order.soNumber,
        quotationId: order.quotationId,
        customerId: order.customerId,
        customerName: order.customer.name,
        status: preferredOrderStatus(order.statusEnum, order.status),
        totalAmount: mapOrderResponse(order).totalAmount,
        createdAt: order.createdAt.toISOString(),
      },
      socket: { room: SocketRooms.ORDERS, event: SocketEvents.ORDER_CREATED },
      createdById: args.actorId,
    });
  }

  return { quotation: updatedQuotation, order, generatedDocument, isNewOrder, wasAlreadyAccepted };
}

/**
 * Creates an order directly from a quotation endpoint. This is the same
 * cross-aggregate rule as quotation acceptance, with the order form's full
 * commercial/logistics fields passed through to the order factory.
 */
export async function createOrderAggregate(args: {
  tx: Prisma.TransactionClient;
  quotationId: string;
  customerId: string;
  quotationVersion?: number;
  actorId: string;
  poNumber?: string;
  deliveryDate?: string;
  templateId?: string;
  saleType?: string;
  incoterm?: string;
  incotermLocation?: string;
  shipToId?: string;
  shipForId?: string;
  warrantyDays?: number;
  warrantyStartDate?: string;
  certificateRequired?: boolean;
  certificateType?: string;
  certificateDelivered?: boolean;
  packagingStandard?: string;
  shippingMethod?: string;
  carrierAccount?: string;
  inspectionRequired?: boolean;
  inspectionPassed?: boolean;
  inspectionDate?: string;
  customsClearanceRequired?: boolean;
  customsDeclarationNo?: string;
  importDuty?: number;
  vatAmount?: number;
  totalLandCost?: number;
  exchangeCoreCharge?: number;
  exchangeCoreDueDate?: string;
  eSignatureCustomer?: string;
  eSignatureSupplier?: string;
  authorize?: QuotationAuthorization;
  createOrder?: typeof createOrderFromQuotation;
  ensureContractDocument: EnsureContractDocument;
}) {
  const quotation = await args.tx.quotation.findUnique({
    where: { id: args.quotationId },
    include: {
      customer: true,
      creator: { select: { department: true } },
    },
  });
  if (!quotation) throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
  args.authorize?.(quotation);
  if (quotation.customerId !== args.customerId) {
    throw new AppError('订单客户与报价客户不一致', 400, 'BAD_REQUEST');
  }

  const existingOrder = await args.tx.order.findUnique({
    where: { quotationId: args.quotationId },
    include: { customer: true },
  });

  let order: Order & { customer: Customer };
  let updatedQuotation: Quotation;
  let isNewOrder = false;

  if (existingOrder) {
    order = existingOrder;
    updatedQuotation = quotation;
  } else {
    const currentStatus = normalizeQuotationStatus(
      preferredQuotationStatus(quotation.statusEnum, quotation.status),
    );
    if (!currentStatus || !['APPROVED', 'SENT', 'ACCEPTED'].includes(currentStatus)) {
      throw new AppError('当前报价状态不能创建订单', 409, 'INVALID_STATE_TRANSITION');
    }
    if (currentStatus !== 'ACCEPTED' && !isQuotationTransitionAllowed(currentStatus, 'ACCEPTED')) {
      throw new AppError('当前报价状态不能创建订单', 409, 'INVALID_STATE_TRANSITION');
    }

    updatedQuotation = currentStatus === 'ACCEPTED'
      ? quotation
      : await transitionQuotationStatus(args.tx, {
        id: quotation.id,
        currentStatus: quotation.status,
        currentVersion: quotation.version,
        nextStatus: 'ACCEPTED',
        expectedVersion: args.quotationVersion,
        actorId: args.actorId,
        reasonCode: 'ORDER_CREATED_FROM_QUOTATION',
        data: { acceptedAt: quotation.acceptedAt || new Date() },
      });

    const createOrder = args.createOrder || createOrderFromQuotation;
    order = await createOrder({
      tx: args.tx,
      quotation: updatedQuotation,
      customer: quotation.customer,
      poNumber: args.poNumber,
      deliveryDate: args.deliveryDate,
      saleType: args.saleType,
      incoterm: args.incoterm,
      incotermLocation: args.incotermLocation,
      shipToId: args.shipToId,
      shipForId: args.shipForId,
      warrantyDays: args.warrantyDays,
      warrantyStartDate: args.warrantyStartDate,
      certificateRequired: args.certificateRequired,
      certificateType: args.certificateType,
      certificateDelivered: args.certificateDelivered,
      packagingStandard: args.packagingStandard,
      shippingMethod: args.shippingMethod,
      carrierAccount: args.carrierAccount,
      inspectionRequired: args.inspectionRequired,
      inspectionPassed: args.inspectionPassed,
      inspectionDate: args.inspectionDate,
      customsClearanceRequired: args.customsClearanceRequired,
      customsDeclarationNo: args.customsDeclarationNo,
      importDuty: args.importDuty,
      vatAmount: args.vatAmount,
      totalLandCost: args.totalLandCost,
      exchangeCoreCharge: args.exchangeCoreCharge,
      exchangeCoreDueDate: args.exchangeCoreDueDate,
      eSignatureCustomer: args.eSignatureCustomer,
      eSignatureSupplier: args.eSignatureSupplier,
      actorId: args.actorId,
      reasonCode: 'ORDER_CREATED_FROM_QUOTATION',
    });
    isNewOrder = true;
  }

  const generatedDocument = await args.ensureContractDocument({
    quotation: updatedQuotation,
    customer: quotation.customer,
    order,
    templateId: args.templateId,
    generatedById: args.actorId,
    tx: args.tx,
  });

  if (isNewOrder) {
    await enqueueBusinessEvent(args.tx, {
      eventType: 'order.created',
      aggregateType: 'ORDER',
      aggregateId: order.id,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        soNumber: order.soNumber,
        quotationId: order.quotationId,
        customerId: order.customerId,
        customerName: order.customer.name,
        status: preferredOrderStatus(order.statusEnum, order.status),
        totalAmount: mapOrderResponse(order).totalAmount,
        createdAt: order.createdAt.toISOString(),
      },
      socket: { room: SocketRooms.ORDERS, event: SocketEvents.ORDER_CREATED },
      createdById: args.actorId,
    });
    await enqueueBusinessEvent(args.tx, {
      eventType: 'quotation.accepted',
      aggregateType: 'QUOTATION',
      aggregateId: updatedQuotation.id,
      data: {
        quotationId: updatedQuotation.id,
        quoteNumber: updatedQuotation.quoteNumber,
        acceptedAt: updatedQuotation.acceptedAt?.toISOString(),
        orderId: order.id,
        contractDocumentId: generatedDocument.id,
      },
      socket: { room: SocketRooms.QUOTATIONS, event: SocketEvents.QUOTATION_UPDATED },
      createdById: args.actorId,
    });
  }

  return { quotation: updatedQuotation, order, generatedDocument, isNewOrder };
}

type OutboundAccountLookup = (tx: Pick<Prisma.TransactionClient, 'emailAccount'>) => Promise<{ id: string }>;

/**
 * Withdraws a sent quotation, releasing any reservation before the quotation
 * transition and queuing the optional customer notice in the same transaction.
 */
export async function withdrawQuotationAggregate(args: {
  tx: Prisma.TransactionClient;
  quotationId: string;
  actorId: string;
  reason: string;
  sendWithdrawalNotice: boolean;
  expectedVersion?: number;
  reasonCode?: string;
  authorize?: QuotationAuthorization;
  getDefaultOutboundAccount: OutboundAccountLookup;
}) {
  const quotation = await args.tx.quotation.findUnique({
    where: { id: args.quotationId },
    include: {
      customer: true,
      creator: { select: { department: true } },
      outboundEmails: {
        where: { purpose: 'QUOTATION_SEND', status: 'SENT' },
        orderBy: { sentAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!quotation) throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
  args.authorize?.(quotation);

  const currentQuotationStatus = quotationStatus(quotation);
  if (currentQuotationStatus === 'ACCEPTED') {
    throw new AppError('客户已确认的报价不能直接撤回，请通过订单/变更流程处理', 400, 'BAD_REQUEST');
  }
  if (currentQuotationStatus === 'WITHDRAWN') {
    throw new AppError('该报价已撤回，无需重复操作', 400, 'BAD_REQUEST');
  }
  assertQuotationTransition(currentQuotationStatus, 'WITHDRAWN');

  const latestSentEmail = quotation.outboundEmails[0];
  if (!latestSentEmail) {
    throw new AppError('当前报价没有已发送记录，不能执行撤回', 400, 'BAD_REQUEST');
  }
  if (args.sendWithdrawalNotice && !quotation.customer.email) {
    throw new AppError('客户未配置邮箱，无法发送撤回通知', 400, 'BAD_REQUEST');
  }

  let releasedReservation: {
    inventoryDetailId: string;
    partNumber: string;
    quantity: number;
    reservedQuantity: number;
    transactionId: string;
  } | undefined;
  if (quotation.inventoryDetailId && quotation.reservedQuantity > 0) {
    const released = await releaseInventoryReservation(args.tx, {
      quotationId: quotation.id,
      notes: args.reason,
      actorId: args.actorId,
      updateQuotation: false,
    });
    releasedReservation = {
      inventoryDetailId: released.inventoryDetailId,
      partNumber: released.partNumber,
      quantity: released.inventoryQuantity,
      reservedQuantity: released.releasedQuantity,
      transactionId: released.transaction.id,
    };
  }

  const withdrawnAt = new Date();
  const updatedQuotation = await transitionQuotationStatus(args.tx, {
    id: quotation.id,
    currentStatus: quotation.status,
    currentVersion: quotation.version,
    nextStatus: 'WITHDRAWN',
    expectedVersion: args.expectedVersion,
    actorId: args.actorId,
    reasonCode: args.reasonCode || 'QUOTATION_WITHDRAWN',
    reason: args.reason,
    data: {
      withdrawnAt,
      withdrawalReason: args.reason,
      ...(releasedReservation ? { reservedQuantity: 0 } : {}),
    },
  });
  await args.tx.outboundEmail.update({
    where: { id: latestSentEmail.id },
    data: {
      status: 'WITHDRAWN',
      withdrawnAt,
      withdrawalReason: args.reason,
    },
  });

  let noticeId: string | undefined;
  if (args.sendWithdrawalNotice) {
    const account = await args.getDefaultOutboundAccount(args.tx);
    const subject = `Withdrawal Notice: ${quotation.quoteNumber}`;
    const plainBody = [
      `${quotation.customer.contactName || quotation.customer.name} 您好，`,
      '',
      `此前发送的报价单 ${quotation.quoteNumber} 已撤回，请忽略旧版报价。`,
      `撤回原因：${args.reason}`,
      '',
      '如需新版报价，我们会尽快补发。',
      '',
      'AeroLink 销售团队',
    ].join('\n');
    const notice = await args.tx.outboundEmail.create({
      data: {
        purpose: 'QUOTATION_WITHDRAWAL',
        quotationId: quotation.id,
        customerId: quotation.customerId,
        accountId: account.id,
        toEmail: quotation.customer.email,
        subject,
        textBody: plainBody,
        htmlBody: plainBody.split('\n').map((line) => `<p>${line}</p>`).join(''),
        status: 'PENDING',
        withdrawalReason: args.reason,
      },
    });
    await enqueueOutboundEmail(args.tx, {
      eventType: 'quotation.withdrawal.email',
      aggregateType: 'QUOTATION',
      aggregateId: quotation.id,
      outboundEmailId: notice.id,
      createdById: args.actorId,
    });
    noticeId = notice.id;
  }

  await enqueueBusinessEvent(args.tx, {
    eventType: 'quotation.withdrawn',
    aggregateType: 'QUOTATION',
    aggregateId: updatedQuotation.id,
    data: {
      quotationId: updatedQuotation.id,
      quoteNumber: updatedQuotation.quoteNumber,
      withdrawnAt: updatedQuotation.withdrawnAt?.toISOString(),
      withdrawalReason: updatedQuotation.withdrawalReason,
      withdrawalNoticeId: noticeId,
      reservationReleased: Boolean(releasedReservation),
      releasedInventoryDetailId: releasedReservation?.inventoryDetailId,
    },
    socket: { room: SocketRooms.QUOTATIONS, event: SocketEvents.QUOTATION_UPDATED },
    createdById: args.actorId,
  });

  return { quotation: updatedQuotation, noticeId, releasedReservation };
}

export async function createOrderFromQuotation(args: {
  tx: Prisma.TransactionClient;
  quotation: Quotation;
  customer: Customer;
  poNumber?: string;
  deliveryDate?: string;
  saleType?: string;
  incoterm?: string;
  incotermLocation?: string;
  shipToId?: string;
  shipForId?: string;
  warrantyDays?: number;
  warrantyStartDate?: string;
  certificateRequired?: boolean;
  certificateType?: string;
  certificateDelivered?: boolean;
  packagingStandard?: string;
  shippingMethod?: string;
  carrierAccount?: string;
  inspectionRequired?: boolean;
  inspectionPassed?: boolean;
  inspectionDate?: string;
  customsClearanceRequired?: boolean;
  customsDeclarationNo?: string;
  importDuty?: number;
  vatAmount?: number;
  totalLandCost?: number;
  exchangeCoreCharge?: number;
  exchangeCoreDueDate?: string;
  eSignatureCustomer?: string;
  eSignatureSupplier?: string;
  actorId?: string | null;
  reasonCode?: string;
  reason?: string | null;
}) {
  const orderNumber = buildSalesOrderNumber();
  const totalAmountDecimal = normalizeMoney(
    preferredMoneyValue(args.quotation.totalPriceDecimal, args.quotation.totalPrice) ?? args.quotation.totalPrice,
  );
  const importDutyDecimal = normalizeOptionalMoney(args.importDuty);
  const vatAmountDecimal = normalizeOptionalMoney(args.vatAmount);
  const totalLandCostDecimal = normalizeOptionalMoney(args.totalLandCost);
  const exchangeCoreChargeDecimal = normalizeOptionalMoney(args.exchangeCoreCharge);

  const order = await args.tx.order.create({
    data: {
      orderNumber,
      soNumber: orderNumber,
      quotationId: args.quotation.id,
      customerId: args.customer.id,
      partNumber: args.quotation.partNumber,
      quantity: args.quotation.quantity,
      totalAmount: totalAmountDecimal.toNumber(),
      totalAmountDecimal,
      inventoryDetailId: args.quotation.inventoryDetailId,
      serialNumber: args.quotation.serialNumber,
      batchNumber: args.quotation.batchNumber,
      status: 'SO_CREATED',
      statusEnum: toOrderStatusEnum('SO_CREATED')!,
      poNumber: args.poNumber,
      deliveryDate: args.deliveryDate ? new Date(args.deliveryDate) : null,
      saleType: args.saleType || 'Sale',
      incoterm: args.incoterm,
      incotermLocation: args.incotermLocation,
      shipToId: args.shipToId,
      shipForId: args.shipForId,
      warrantyDays: args.warrantyDays,
      warrantyStartDate: args.warrantyStartDate ? new Date(args.warrantyStartDate) : null,
      certificateRequired: args.certificateRequired ?? true,
      certificateType: args.certificateType,
      certificateDelivered: args.certificateDelivered ?? false,
      packagingStandard: args.packagingStandard,
      shippingMethod: args.shippingMethod,
      carrierAccount: args.carrierAccount,
      inspectionRequired: args.inspectionRequired ?? false,
      inspectionPassed: args.inspectionPassed,
      inspectionDate: args.inspectionDate ? new Date(args.inspectionDate) : null,
      customsClearanceRequired: args.customsClearanceRequired ?? false,
      customsDeclarationNo: args.customsDeclarationNo,
      importDuty: importDutyDecimal?.toNumber() ?? null,
      importDutyDecimal,
      vatAmount: vatAmountDecimal?.toNumber() ?? null,
      vatAmountDecimal,
      totalLandCost: totalLandCostDecimal?.toNumber() ?? null,
      totalLandCostDecimal,
      exchangeCoreCharge: exchangeCoreChargeDecimal?.toNumber() ?? null,
      exchangeCoreChargeDecimal,
      exchangeCoreDueDate: args.exchangeCoreDueDate ? new Date(args.exchangeCoreDueDate) : null,
      eSignatureCustomer: args.eSignatureCustomer,
      eSignatureSupplier: args.eSignatureSupplier,
    },
    include: { customer: true },
  });

  await createInitialStatusHistory(args.tx, {
    entityType: 'ORDER',
    entityId: order.id,
    toStatus: order.status,
    reasonCode: args.reasonCode || 'ORDER_CREATED_FROM_QUOTATION',
    reason: args.reason,
    actorId: args.actorId,
    version: order.version,
  });

  return order;
}

export function mapOrderResponse(order: Order & { customer: Customer }) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    soNumber: order.soNumber,
    poNumber: order.poNumber,
    quotationId: order.quotationId,
    customerId: order.customerId,
    customerName: order.customer.name,
    partNumber: order.partNumber,
    quantity: order.quantity,
    totalAmount: preferredMoneyValue(order.totalAmountDecimal, order.totalAmount) ?? 0,
    status: preferredOrderStatus(order.statusEnum, order.status).toLowerCase(),
    version: order.version,
    createdAt: order.createdAt.toISOString(),
    deliveryDate: order.deliveryDate?.toISOString(),
    trackingNumber: order.trackingNumber,
    carrier: order.carrier,
    saleType: order.saleType,
    incoterm: order.incoterm,
    incotermLocation: order.incotermLocation,
    shipToId: order.shipToId,
    shipForId: order.shipForId,
    warrantyDays: order.warrantyDays,
    warrantyStartDate: order.warrantyStartDate?.toISOString(),
    certificateRequired: order.certificateRequired,
    certificateType: order.certificateType,
    certificateDelivered: order.certificateDelivered,
    packagingStandard: order.packagingStandard,
    shippingMethod: order.shippingMethod,
    carrierAccount: order.carrierAccount,
    inspectionRequired: order.inspectionRequired,
    inspectionPassed: order.inspectionPassed,
    inspectionDate: order.inspectionDate?.toISOString(),
    customsClearanceRequired: order.customsClearanceRequired,
    customsDeclarationNo: order.customsDeclarationNo,
    importDuty: preferredMoneyValue(order.importDutyDecimal, order.importDuty),
    vatAmount: preferredMoneyValue(order.vatAmountDecimal, order.vatAmount),
    totalLandCost: preferredMoneyValue(order.totalLandCostDecimal, order.totalLandCost),
    exchangeCoreCharge: preferredMoneyValue(order.exchangeCoreChargeDecimal, order.exchangeCoreCharge),
    exchangeCoreDueDate: order.exchangeCoreDueDate?.toISOString(),
    eSignatureCustomer: order.eSignatureCustomer,
    eSignatureSupplier: order.eSignatureSupplier,
    inventoryDetailId: order.inventoryDetailId || undefined,
    serialNumber: order.serialNumber || undefined,
    batchNumber: order.batchNumber || undefined,
    outboundQuantity: order.outboundQuantity,
    outboundStatus: order.outboundStatus,
  };
}

type OrderAuthorizationContext = {
  createdBy: string;
  creator?: { department?: string | null } | null;
};

type OrderAuthorization = (order: { quotation?: OrderAuthorizationContext | null }) => void;

/**
 * Owns order status policy, optimistic transition and the transactional event
 * emitted for a changed order. The route supplies the capability assertion so
 * this module stays independent of Express request objects.
 */
export async function transitionOrderAggregate(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    nextStatus: string;
    expectedVersion?: number;
    actorId: string;
    reasonCode: string;
    reason?: string;
    authorize?: OrderAuthorization;
  },
) {
  const existing = await tx.order.findUnique({
    where: { id: args.id },
    include: {
      quotation: {
        select: {
          createdBy: true,
          creator: { select: { department: true } },
        },
      },
    },
  });
  if (!existing) throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
  args.authorize?.(existing);

  const currentStatus = normalizeOrderStatus(preferredOrderStatus(existing.statusEnum, existing.status));
  const nextStatus = normalizeOrderStatus(args.nextStatus);
  if (!isOrderStatusTransitionAllowed(currentStatus, nextStatus)) {
    throw new AppError(`订单不允许从 ${currentStatus.toLowerCase()} 变更为 ${nextStatus.toLowerCase()}`, 409, 'INVALID_STATE_TRANSITION');
  }

  const order = currentStatus === nextStatus
    ? existing
    : await transitionOrderStatus(tx, {
      id: existing.id,
      currentStatus: existing.status,
      currentVersion: existing.version,
      nextStatus,
      expectedVersion: args.expectedVersion,
      actorId: args.actorId,
      reasonCode: args.reasonCode,
      reason: args.reason,
    });

  if (currentStatus !== normalizeOrderStatus(preferredOrderStatus(order.statusEnum, order.status))) {
    await enqueueBusinessEvent(tx, {
      eventType: 'order.status.changed',
      aggregateType: 'ORDER',
      aggregateId: order.id,
      data: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        oldStatus: currentStatus,
        newStatus: preferredOrderStatus(order.statusEnum, order.status),
        changedAt: new Date().toISOString(),
      },
      socket: { room: SocketRooms.ORDERS, event: SocketEvents.ORDER_STATUS_CHANGED },
      createdById: args.actorId,
    });
  }

  return { order, currentStatus };
}

/** Update mutable order fields after the module-owned authorization lookup. */
export async function updateOrderAggregate(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    data: Prisma.OrderUpdateInput;
    include: Prisma.OrderInclude;
    authorize?: OrderAuthorization;
  },
) {
  const existing = await tx.order.findUnique({
    where: { id: args.id },
    include: {
      quotation: {
        select: {
          createdBy: true,
          creator: { select: { department: true } },
        },
      },
    },
  });
  if (!existing) throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
  args.authorize?.(existing);

  return tx.order.update({
    where: { id: args.id },
    data: args.data,
    include: args.include,
  });
}

export function assertQuotationTransition(current: string, target: QuotationStatus) {
  if (!isQuotationTransitionAllowed(current, target)) {
    const normalizedCurrent = normalizeQuotationStatus(current) || current;
    throw new AppError(
      `报价状态不能从 ${normalizedCurrent} 转为 ${target}`,
      409,
      'INVALID_STATE_TRANSITION',
    );
  }
}

export function toUiQuotationStatus(status: string) {
  return normalizeQuotationStatus(status)?.toLowerCase() || status.toLowerCase();
}
