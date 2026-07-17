import { Router } from 'express';
import { Prisma, type OrderStatusEnum, type QuotationStatusEnum, type RfqStatusEnum } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import { createAuditLog } from '../middleware/auditLogger.js';
import { buildContentDisposition } from '../lib/downloadHeaders.js';
import { validateBody } from '../middleware/validate.js';
import {
  quotationCreateSchema,
  quotationSubmitSchema,
  quotationApproveSchema,
  quotationSendSchema,
  quotationWithdrawSchema,
  quotationAcceptSchema,
} from '../lib/validation.js';
import { AuthRequest } from '../middleware/auth.js';
import { generateQuotationPDF } from '../lib/pdfService.js';
import { createOrderFromQuotation, mapOrderResponse } from '../lib/orderWorkflowService.js';
import { ensureOrderContractDocument, ORDER_CONTRACT_DOCUMENT_TYPE } from '../lib/documentTemplateService.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { calculateMarginPercent, calculateMoneyTotal, normalizeMoney, preferredMoneyValue } from '../lib/money.js';
import { enqueueBusinessEvent, enqueueOutboundEmail } from '../lib/outboxService.js';
import { isQuotationTransitionAllowed, normalizeQuotationStatus, type QuotationStatus } from '../lib/quotationStateMachine.js';
import { isRfqStatusTransitionAllowed, normalizeRfqStatus } from '../lib/rfqStateMachine.js';
import { SocketEvents, SocketRooms } from '../lib/socketEvents.js';
import {
  createInitialStatusHistory,
  transitionQuotationStatus,
  transitionRfqStatus,
} from '../lib/transactionStateService.js';
import {
  preferredOrderStatus,
  preferredQuotationStatus,
  preferredRfqStatus,
  toQuotationStatusEnum,
} from '../lib/transactionStatusShadows.js';
import { getCapabilityScope, hasCapability } from '../lib/capabilityPolicy.js';
import { parseControlledExportWindow, parseListQuery, sendCsv, type SortDirection } from '../lib/listQuery.js';
import prisma from '../lib/prisma.js';

const router = Router();

type ScopedQuotation = {
  createdBy: string;
  creator?: { department?: string | null } | null;
};

function buildQuotationReadScope(actor: NonNullable<AuthRequest['user']>): Prisma.QuotationWhereInput {
  const scope = getCapabilityScope(actor, 'quotation.read');
  if (scope === 'all') return {};

  const own: Prisma.QuotationWhereInput = { createdBy: actor.id };
  const department = actor.department
    ? { creator: { is: { department: actor.department } } } satisfies Prisma.QuotationWhereInput
    : undefined;

  if (scope === 'department') return department ?? own;
  if (scope === 'department_or_own') {
    return department ? { OR: [own, department] } : own;
  }
  return own;
}

type QuotationListSort = 'createdAt' | 'expiryDate' | 'validityDeadline' | 'totalPrice' | 'quoteNumber';

function quotationListOrderBy(
  sort: QuotationListSort,
  direction: SortDirection,
): Prisma.QuotationOrderByWithRelationInput[] {
  switch (sort) {
    case 'expiryDate':
      return [{ expiryDate: direction }, { id: 'asc' }];
    case 'validityDeadline':
      return [{ validityDeadline: direction }, { id: 'asc' }];
    case 'totalPrice':
      return [{ totalPrice: direction }, { id: 'asc' }];
    case 'quoteNumber':
      return [{ quoteNumber: direction }, { id: 'asc' }];
    default:
      return [{ createdAt: direction }, { id: 'asc' }];
  }
}

function buildQuotationListWhere(
  query: Record<string, unknown>,
  actor: NonNullable<AuthRequest['user']>,
): Prisma.QuotationWhereInput {
  const status = typeof query.status === 'string' ? query.status : '';
  const search = typeof query.search === 'string' ? query.search : '';
  const filters: Prisma.QuotationWhereInput[] = [buildQuotationReadScope(actor)];
  if (status) filters.push({ status: status.toUpperCase() });
  const searchValue = search.trim();
  if (searchValue) {
    filters.push({
      OR: [
        { quoteNumber: { contains: searchValue, mode: 'insensitive' } },
        { partNumber: { contains: searchValue, mode: 'insensitive' } },
        { customer: { is: { name: { contains: searchValue, mode: 'insensitive' } } } },
      ],
    });
  }
  return filters.length === 1 ? filters[0] : { AND: filters };
}

function assertQuotationAccess(
  actor: NonNullable<AuthRequest['user']>,
  action: 'read' | 'update' | 'transition' | 'approve' | 'send' | 'accept' | 'withdraw',
  quotation: ScopedQuotation,
) {
  assertCapability(actor, 'quotation', action, {
    ownerId: quotation.createdBy,
    department: quotation.creator?.department,
  });
}

function canViewQuotationCost(actor: NonNullable<AuthRequest['user']>, quotation: ScopedQuotation) {
  return hasCapability(actor, 'quotation', 'view_cost', {
    ownerId: quotation.createdBy,
    department: quotation.creator?.department,
  });
}

type OutboundAccountClient = Pick<Prisma.TransactionClient, 'emailAccount'>;

async function getDefaultOutboundAccount(db: OutboundAccountClient = prisma) {
  const account = await db.emailAccount.findFirst({
    where: { isActive: true },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });

  if (!account) {
    throw new AppError('未配置可用的发件邮箱，请先在系统设置中启用默认邮箱账户', 400, 'BAD_REQUEST');
  }

  return account;
}

function textToHtml(text: string) {
  return text
    .split('\n')
    .map((line) => `<p>${line}</p>`)
    .join('');
}

function assertQuotationTransition(current: string, target: QuotationStatus) {
  if (!isQuotationTransitionAllowed(current, target)) {
    const normalizedCurrent = normalizeQuotationStatus(current) || current;
    throw new AppError(
      `报价状态不能从 ${normalizedCurrent} 转为 ${target}`,
      409,
      'INVALID_STATE_TRANSITION',
    );
  }
}

function toUiQuotationStatus(status: string) {
  return normalizeQuotationStatus(status)?.toLowerCase() || status.toLowerCase();
}

type QuotationMoneySource = {
  unitPrice: number;
  unitPriceDecimal: Prisma.Decimal | null;
  totalPrice: number;
  totalPriceDecimal: Prisma.Decimal | null;
  costPrice: number;
  costPriceDecimal: Prisma.Decimal | null;
};

type QuotationStatusShadow = {
  status: string;
  statusEnum?: QuotationStatusEnum | null;
};

type RelatedOrderMoneySource = {
  totalAmount: number;
  totalAmountDecimal: Prisma.Decimal | null;
  importDuty: number | null;
  importDutyDecimal: Prisma.Decimal | null;
  vatAmount: number | null;
  vatAmountDecimal: Prisma.Decimal | null;
  totalLandCost: number | null;
  totalLandCostDecimal: Prisma.Decimal | null;
  exchangeCoreCharge: number | null;
  exchangeCoreChargeDecimal: Prisma.Decimal | null;
  status: string;
  statusEnum?: OrderStatusEnum | null;
};

type RfqStatusShadow = {
  status: string;
  statusEnum?: RfqStatusEnum | null;
};

function quotationStatus(quotation: QuotationStatusShadow) {
  return preferredQuotationStatus(quotation.statusEnum, quotation.status);
}

function orderStatus(order: Pick<RelatedOrderMoneySource, 'status' | 'statusEnum'>) {
  return preferredOrderStatus(order.statusEnum, order.status);
}

function rfqStatus(rfq: RfqStatusShadow) {
  return preferredRfqStatus(rfq.statusEnum, rfq.status);
}

function projectRfqStatus<T extends RfqStatusShadow>(rfq: T | null) {
  if (!rfq) {
    return rfq;
  }

  const { status, statusEnum, ...rest } = rfq;
  return {
    ...rest,
    status: rfqStatus({ status, statusEnum }),
  };
}

function projectQuotationMoney<T extends QuotationMoneySource & QuotationStatusShadow>(quotation: T) {
  const {
    unitPriceDecimal,
    totalPriceDecimal,
    costPriceDecimal,
    unitPrice,
    totalPrice,
    costPrice,
    status,
    statusEnum,
    ...rest
  } = quotation;

  return {
    ...rest,
    status: quotationStatus({ status, statusEnum }),
    unitPrice: preferredMoneyValue(unitPriceDecimal, unitPrice) ?? 0,
    totalPrice: preferredMoneyValue(totalPriceDecimal, totalPrice) ?? 0,
    costPrice: preferredMoneyValue(costPriceDecimal, costPrice) ?? 0,
  };
}

function quotationTotalPrice(quotation: Pick<QuotationMoneySource, 'totalPrice' | 'totalPriceDecimal'>) {
  return preferredMoneyValue(quotation.totalPriceDecimal, quotation.totalPrice) ?? 0;
}

function projectRelatedOrderMoney<T extends RelatedOrderMoneySource>(order: T) {
  const {
    totalAmountDecimal,
    importDutyDecimal,
    vatAmountDecimal,
    totalLandCostDecimal,
    exchangeCoreChargeDecimal,
    totalAmount,
    importDuty,
    vatAmount,
    totalLandCost,
    exchangeCoreCharge,
    status,
    statusEnum,
    ...rest
  } = order;

  return {
    ...rest,
    status: orderStatus({ status, statusEnum }),
    totalAmount: preferredMoneyValue(totalAmountDecimal, totalAmount) ?? 0,
    importDuty: preferredMoneyValue(importDutyDecimal, importDuty),
    vatAmount: preferredMoneyValue(vatAmountDecimal, vatAmount),
    totalLandCost: preferredMoneyValue(totalLandCostDecimal, totalLandCost),
    exchangeCoreCharge: preferredMoneyValue(exchangeCoreChargeDecimal, exchangeCoreCharge),
  };
}

function mapQuotationStatusHistoryEntry(history: {
  id: string;
  entityType: string;
  entityId: string;
  fromStatus: string | null;
  toStatus: string;
  reasonCode: string;
  reason: string | null;
  actorId: string | null;
  version: number;
  createdAt: Date;
  actor?: { id: string; name: string } | null;
}) {
  return {
    id: history.id,
    entityType: history.entityType,
    entityId: history.entityId,
    fromStatus: history.fromStatus ? toUiQuotationStatus(history.fromStatus) : null,
    toStatus: toUiQuotationStatus(history.toStatus),
    reasonCode: history.reasonCode,
    reason: history.reason,
    actorId: history.actorId,
    actorName: history.actor?.name || null,
    version: history.version,
    createdAt: history.createdAt.toISOString(),
  };
}

router.get(
  '/',
  requireCapability('quotation', 'read'),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const { page: pageNum, limit: pageSize, skip, sort, direction } = parseListQuery<QuotationListSort>(
      query,
      {
        allowedSorts: ['createdAt', 'expiryDate', 'validityDeadline', 'totalPrice', 'quoteNumber'],
        defaultSort: 'createdAt',
        defaultDirection: 'desc',
      },
    );

    const actor = (req as AuthRequest).user!;
    const scopedWhere = buildQuotationReadScope(actor);
    const where = buildQuotationListWhere(query, actor);

    const [quotations, total, statusCounts, acceptedAggregate] = await Promise.all([
      prisma.quotation.findMany({
        where,
        include: {
          customer: true,
          creator: { select: { id: true, name: true, department: true } },
          approver: { select: { id: true, name: true } },
          rfq: { select: { id: true, rfqNumber: true, urgency: true } },
          orders: {
            select: { id: true, orderNumber: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          generatedDocuments: {
            orderBy: { generatedAt: 'desc' },
            take: 3,
          },
          outboundEmails: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
        orderBy: quotationListOrderBy(sort, direction),
        skip,
        take: pageSize,
      }),
      prisma.quotation.count({ where }),
      prisma.quotation.groupBy({
        where,
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.quotation.aggregate({
        where: { AND: [scopedWhere, { status: 'ACCEPTED' }] },
        _sum: { totalPrice: true, totalPriceDecimal: true },
      }),
    ]);

    const summaryCount = (statusValue: string) =>
      statusCounts.find((entry) => entry.status === statusValue)?._count._all || 0;
    const summary = {
      total: statusCounts.reduce((sum, entry) => sum + entry._count._all, 0),
      pending: summaryCount('PENDING_APPROVAL'),
      approved: summaryCount('APPROVED'),
      sent: summaryCount('SENT'),
      accepted: summaryCount('ACCEPTED'),
      withdrawn: summaryCount('WITHDRAWN'),
      totalValue: preferredMoneyValue(
        acceptedAggregate._sum.totalPriceDecimal,
        acceptedAggregate._sum.totalPrice,
      ) ?? 0,
    };

    res.json({
      success: true,
      data: quotations.map((q) => {
        const money = projectQuotationMoney(q);
        const showCost = canViewQuotationCost(actor, q);
        const latestContract = q.generatedDocuments.find((doc) => doc.documentType === ORDER_CONTRACT_DOCUMENT_TYPE);
        const latestEmail = q.outboundEmails.find((email) => email.purpose === 'QUOTATION_SEND');
        const latestOrder = q.orders[0];

        return {
          id: q.id,
          quoteNumber: q.quoteNumber,
          rfqId: q.rfqId,
          customerId: q.customerId,
          customerName: q.customer.name,
          customerEmail: q.customer.email,
          customerContactName: q.customer.contactName,
          partNumber: q.partNumber,
          quantity: q.quantity,
          unitPrice: money.unitPrice,
          totalPrice: money.totalPrice,
          ...(showCost ? { costPrice: money.costPrice, margin: q.margin } : {}),
          certificateFiles: q.certificateFiles?.split(',').filter(Boolean) || [],
          template: q.template.toLowerCase(),
          status: quotationStatus(q).toLowerCase(),
          version: q.version,
          validityDays: q.validityDays,
          saleType: q.saleType,
          incoterm: q.incoterm,
          incotermLocation: q.incotermLocation,
          leadTimeDays: q.leadTimeDays,
          leadTimeBasis: q.leadTimeBasis,
          moq: q.moq,
          mpq: q.mpq,
          priceBasis: q.priceBasis,
          taxIncluded: q.taxIncluded,
          taxRate: q.taxRate,
          warrantyDays: q.warrantyDays,
          warrantyTerms: q.warrantyTerms,
          packagingRequirement: q.packagingRequirement,
          shippingMethod: q.shippingMethod,
          countryOfOrigin: q.countryOfOrigin,
          hsCode: q.hsCode,
          eccn: q.eccn,
          dualUse: q.dualUse,
          ccRecipients: q.ccRecipients ? JSON.parse(q.ccRecipients) : [],
          commonNote: q.commonNote,
          eSignatureStatus: q.eSignatureStatus,
          createdAt: q.createdAt.toISOString(),
          createdBy: q.creator.name,
          approvedBy: q.approver?.name || q.approvedBy,
          approvedAt: q.approvedAt?.toISOString(),
          sentAt: q.sentAt?.toISOString(),
          acceptedAt: q.acceptedAt?.toISOString(),
          withdrawnAt: q.withdrawnAt?.toISOString(),
          withdrawalReason: q.withdrawalReason,
          customerConfirmationNote: q.customerConfirmationNote,
          expiryDate: q.expiryDate.toISOString().split('T')[0],
          orderId: latestOrder?.id,
          orderNumber: latestOrder?.orderNumber,
          contractDocumentId: latestContract?.id,
          contractDocumentTitle: latestContract?.title,
          lastEmailStatus: latestEmail?.status.toLowerCase(),
          lastEmailSentAt: latestEmail?.sentAt?.toISOString(),
          rfqUrgency: q.rfq?.urgency?.toLowerCase(),
        };
      }),
      summary,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        sort,
        direction,
      },
    });
  })
);

router.get(
  '/export.csv',
  requireCapability('quotation', 'export'),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const window = parseControlledExportWindow(query);
    const { sort, direction } = parseListQuery<QuotationListSort>(query, {
      allowedSorts: ['createdAt', 'expiryDate', 'validityDeadline', 'totalPrice', 'quoteNumber'],
      defaultSort: 'createdAt',
      defaultDirection: 'desc',
    });
    const quotations = await prisma.quotation.findMany({
      where: buildQuotationListWhere(query, (req as AuthRequest).user!),
      select: {
        quoteNumber: true,
        partNumber: true,
        quantity: true,
        unitPrice: true,
        totalPrice: true,
        status: true,
        expiryDate: true,
        validityDeadline: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
      orderBy: quotationListOrderBy(sort, direction),
      skip: window.skip,
      take: window.take,
    });

    await createAuditLog({
      req,
      action: 'EXPORT',
      resourceType: 'QUOTATION',
      details: `Quotation CSV export (${window.scope}, ${quotations.length}/${window.rowLimit} rows)`,
    });
    sendCsv(
      res,
      `quotations-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        { header: '报价编号', value: (quotation) => quotation.quoteNumber },
        { header: '客户', value: (quotation) => quotation.customer.name },
        { header: '件号', value: (quotation) => quotation.partNumber },
        { header: '数量', value: (quotation) => quotation.quantity },
        { header: '单价', value: (quotation) => quotation.unitPrice },
        { header: '总价', value: (quotation) => quotation.totalPrice },
        { header: '状态', value: (quotation) => quotation.status },
        { header: '到期日期', value: (quotation) => quotation.expiryDate },
        { header: '有效期截止', value: (quotation) => quotation.validityDeadline },
        { header: '创建时间', value: (quotation) => quotation.createdAt },
      ],
      quotations,
      window,
    );
  }),
);

router.get(
  '/:id/status-history',
  requireCapability('quotation', 'read'),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        createdBy: true,
        creator: { select: { department: true } },
      },
    });

    if (!quotation) {
      throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
    }
    assertQuotationAccess((req as AuthRequest).user!, 'read', quotation);

    const history = await prisma.transactionStatusHistory.findMany({
      where: { entityType: 'QUOTATION', entityId: quotation.id },
      include: {
        actor: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      success: true,
      data: history.map(mapQuotationStatusHistoryEntry),
    });
  })
);

router.get(
  '/:id',
  requireCapability('quotation', 'read'),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        creator: { select: { id: true, name: true, department: true } },
        approver: { select: { id: true, name: true } },
        rfq: true,
        approvals: { include: { approver: true } },
        orders: { include: { customer: true } },
        generatedDocuments: {
          orderBy: { generatedAt: 'desc' },
          include: { template: true },
        },
        outboundEmails: {
          orderBy: { createdAt: 'desc' },
          include: {
            account: {
              select: {
                id: true,
                email: true,
                displayName: true,
              },
            },
          },
        },
      },
    });

    if (!quotation) {
      throw new AppError('报价单不存在', 404);
    }

    const actor = (req as AuthRequest).user!;
    assertQuotationAccess(actor, 'read', quotation);
    const projectedQuotation = {
      ...projectQuotationMoney(quotation),
      orders: quotation.orders.map(projectRelatedOrderMoney),
    };
    const { costPrice: _costPrice, margin: _margin, ...quotationWithoutCost } = projectedQuotation;
    const quotationForActor = canViewQuotationCost(actor, quotation)
      ? projectedQuotation
      : quotationWithoutCost;
    res.json({
      success: true,
      data: {
        ...quotationForActor,
        rfq: projectRfqStatus(quotation.rfq),
        status: quotationStatus(quotation).toLowerCase(),
        template: quotation.template.toLowerCase(),
        acceptedAt: quotation.acceptedAt?.toISOString(),
        withdrawnAt: quotation.withdrawnAt?.toISOString(),
        sentAt: quotation.sentAt?.toISOString(),
        approvedAt: quotation.approvedAt?.toISOString(),
        createdAt: quotation.createdAt.toISOString(),
        expiryDate: quotation.expiryDate.toISOString().split('T')[0],
        certificateFiles: quotation.certificateFiles?.split(',').filter(Boolean) || [],
        ccRecipients: quotation.ccRecipients ? JSON.parse(quotation.ccRecipients) : [],
        customerEmail: quotation.customer.email,
        customerContactName: quotation.customer.contactName,
        rfqUrgency: quotation.rfq?.urgency?.toLowerCase(),
        contractDocumentId: quotation.generatedDocuments.find((doc) => doc.documentType === ORDER_CONTRACT_DOCUMENT_TYPE)?.id,
        contractDocumentTitle: quotation.generatedDocuments.find((doc) => doc.documentType === ORDER_CONTRACT_DOCUMENT_TYPE)?.title,
        outboundEmails: quotation.outboundEmails.map((email) => ({
          id: email.id,
          purpose: email.purpose.toLowerCase(),
          toEmail: email.toEmail,
          subject: email.subject,
          status: email.status.toLowerCase(),
          sentAt: email.sentAt?.toISOString(),
          withdrawnAt: email.withdrawnAt?.toISOString(),
          withdrawalReason: email.withdrawalReason,
          createdAt: email.createdAt.toISOString(),
          updatedAt: email.updatedAt.toISOString(),
          account: email.account,
        })),
      },
    });
  })
);

router.post(
  '/',
  requireCapability('quotation', 'create'),
  validateBody(quotationCreateSchema),
  asyncHandler(async (req, res) => {
    const { rfqId, customerId, partNumber, quantity, unitPrice, costPrice, certificateFiles, template, validityDays,
      saleType, shipToId, shipForId, incoterm, incotermLocation, leadTimeDays, leadTimeBasis,
      moq, mpq, priceBasis, taxIncluded, taxRate, warrantyDays, warrantyTerms,
      packagingRequirement, shippingMethod, ccRecipients, commonNote,
      eSignature, eSignatureStatus, countryOfOrigin, hsCode, eccn, dualUse,
    } = req.body;
    const actor = (req as AuthRequest).user!;
    const actorId = actor.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/quotations'),
      async (tx) => {
        const relatedRfq = rfqId
          ? await tx.rFQ.findUnique({
            where: { id: rfqId },
            include: { creator: { select: { department: true } } },
          })
          : null;
        if (relatedRfq) {
          assertCapability(actor, 'rfq', 'read', {
            ownerId: relatedRfq.createdBy,
            department: relatedRfq.creator?.department,
          });
        }
        const isAog = relatedRfq?.urgency.toUpperCase() === 'AOG';
        const finalValidityDays = isAog ? 1 : (validityDays || 7);
        const unitPriceDecimal = normalizeMoney(unitPrice);
        const costPriceDecimal = normalizeMoney(costPrice);
        const totalPriceDecimal = calculateMoneyTotal(unitPriceDecimal, quantity);
        const margin = calculateMarginPercent(totalPriceDecimal, costPriceDecimal, quantity);
        const quoteNumber = `QT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + finalValidityDays);

        const initialStatus = isAog ? 'PENDING_APPROVAL' : 'DRAFT';
        const initialStatusEnum = toQuotationStatusEnum(initialStatus)!;
        const quotation = await tx.quotation.create({
          data: {
            quoteNumber,
            rfqId,
            customerId,
            partNumber,
            quantity,
            unitPrice: unitPriceDecimal.toNumber(),
            unitPriceDecimal,
            totalPrice: totalPriceDecimal.toNumber(),
            totalPriceDecimal,
            costPrice: costPriceDecimal.toNumber(),
            costPriceDecimal,
            margin,
            certificateFiles: Array.isArray(certificateFiles) ? certificateFiles.join(',') : certificateFiles,
            template: template?.toUpperCase() || 'STANDARD',
            status: initialStatus,
            statusEnum: initialStatusEnum,
            validityDays: finalValidityDays,
            saleType: saleType || 'Sale',
            shipToId: shipToId || null,
            shipForId: shipForId || null,
            incoterm: incoterm || null,
            incotermLocation: incotermLocation || null,
            leadTimeDays: leadTimeDays || null,
            leadTimeBasis: leadTimeBasis || null,
            moq: moq || null,
            mpq: mpq || null,
            priceBasis: priceBasis || null,
            taxIncluded: taxIncluded !== undefined ? taxIncluded : true,
            taxRate: taxRate || null,
            warrantyDays: warrantyDays || 90,
            warrantyTerms: warrantyTerms || null,
            packagingRequirement: packagingRequirement || null,
            shippingMethod: shippingMethod || null,
            ccRecipients: Array.isArray(ccRecipients) ? JSON.stringify(ccRecipients) : ccRecipients || null,
            commonNote: commonNote || null,
            eSignature: eSignature || null,
            eSignatureStatus: eSignatureStatus || 'Unsigned',
            countryOfOrigin: countryOfOrigin || null,
            hsCode: hsCode || null,
            eccn: eccn || null,
            dualUse: dualUse !== undefined ? dualUse : false,
            expiryDate,
            createdBy: actorId,
          },
          include: { customer: true },
        });

        await createInitialStatusHistory(tx, {
          entityType: 'QUOTATION',
          entityId: quotation.id,
          toStatus: quotationStatus(quotation),
          reasonCode: isAog ? 'AOG_QUOTATION_CREATED' : 'QUOTATION_CREATED',
          actorId,
          version: quotation.version,
        });

        const relatedRfqStatus = relatedRfq ? rfqStatus(relatedRfq) : null;
        if (isAog && relatedRfq && relatedRfqStatus !== 'QUOTING') {
          if (!normalizeRfqStatus(relatedRfqStatus) || !isRfqStatusTransitionAllowed(relatedRfqStatus, 'QUOTING')) {
            throw new AppError('AOG 报价不能将当前 RFQ 变更为报价中', 409, 'INVALID_STATE_TRANSITION');
          }
          const updatedRfq = await transitionRfqStatus(tx, {
            id: relatedRfq.id,
            currentStatus: relatedRfq.status,
            currentVersion: relatedRfq.version,
            nextStatus: 'QUOTING',
            actorId,
            reasonCode: 'AOG_QUOTATION_CREATED',
            reason: `AOG quotation ${quotation.quoteNumber} created.`,
          });
          await enqueueBusinessEvent(tx, {
            eventType: 'rfq.status.changed',
            aggregateType: 'RFQ',
            aggregateId: updatedRfq.id,
            data: {
              rfqId: updatedRfq.id,
              rfqNumber: updatedRfq.rfqNumber,
              oldStatus: relatedRfqStatus,
              newStatus: rfqStatus(updatedRfq),
              changedBy: actorId,
              changedAt: new Date().toISOString(),
            },
            socket: { room: SocketRooms.RFQS, event: SocketEvents.RFQ_UPDATED },
            createdById: actorId,
          });
        }

        if (isAog) {
          const managers = await tx.user.findMany({
            where: { role: { in: ['MANAGER', 'GM'] }, isActive: true },
            select: { id: true },
          });
          if (managers.length > 0) {
            await tx.notification.createMany({
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

        await enqueueBusinessEvent(tx, {
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
            createdBy: actorId,
          },
          socket: { room: SocketRooms.QUOTATIONS, event: SocketEvents.QUOTATION_CREATED },
          createdById: actorId,
        });

        return {
          payload: {
            id: quotation.id,
            quoteNumber: quotation.quoteNumber,
            customerName: quotation.customer.name,
            status: quotationStatus(quotation).toLowerCase(),
            version: quotation.version,
            totalPrice: quotationTotalPrice(quotation),
            ...(canViewQuotationCost(actor, { createdBy: actorId }) ? { margin: quotation.margin } : {}),
          },
          statusCode: 201,
          resourceType: 'QUOTATION',
          resourceId: quotation.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.post(
  '/:id/submit',
  requireCapability('quotation', 'transition'),
  validateBody(quotationSubmitSchema),
  asyncHandler(async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const actorId = actor.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/quotations/:id/submit'),
      async (tx) => {
        const currentQuotation = await tx.quotation.findUnique({
          where: { id: req.params.id },
          include: { creator: { select: { department: true } } },
        });
        if (!currentQuotation) {
          throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        assertQuotationAccess(actor, 'transition', currentQuotation);
        const currentQuotationStatus = quotationStatus(currentQuotation);
        assertQuotationTransition(currentQuotationStatus, 'PENDING_APPROVAL');

        const isNoop = currentQuotationStatus === 'PENDING_APPROVAL';
        const quotation = isNoop
          ? currentQuotation
          : await transitionQuotationStatus(tx, {
            id: currentQuotation.id,
            currentStatus: currentQuotation.status,
            currentVersion: currentQuotation.version,
            nextStatus: 'PENDING_APPROVAL',
            expectedVersion: req.body.version,
            actorId,
            reasonCode: req.body.reasonCode || 'QUOTATION_SUBMITTED_FOR_APPROVAL',
            reason: req.body.reason,
          });

        if (!isNoop) {
          await enqueueBusinessEvent(tx, {
            eventType: 'quotation.submitted',
            aggregateType: 'QUOTATION',
            aggregateId: quotation.id,
            data: {
              quotationId: quotation.id,
              quoteNumber: quotation.quoteNumber,
              status: quotationStatus(quotation),
              submittedBy: actorId,
              submittedAt: new Date().toISOString(),
            },
            socket: { room: SocketRooms.QUOTATIONS, event: SocketEvents.QUOTATION_SUBMITTED },
            createdById: actorId,
          });
        }

        return {
          payload: { ...projectQuotationMoney(quotation), status: quotationStatus(quotation).toLowerCase() },
          resourceType: 'QUOTATION',
          resourceId: quotation.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.post(
  '/:id/approve',
  requireCapability('quotation', 'approve'),
  validateBody(quotationApproveSchema),
  asyncHandler(async (req, res) => {
    const { action, comment, reasonCode, version } = req.body;
    const actor = (req as AuthRequest).user!;
    const userId = actor.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, userId, 'POST:/quotations/:id/approve'),
      async (tx) => {
        const quotationWithRfq = await tx.quotation.findUnique({
          where: { id: req.params.id },
          include: {
            rfq: true,
            creator: { select: { department: true } },
          },
        });
        if (!quotationWithRfq) {
          throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        assertQuotationAccess(actor, 'approve', quotationWithRfq);

        const isAog = quotationWithRfq.rfq?.urgency?.toUpperCase() === 'AOG';
        const targetStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
        const quotationWithRfqStatus = quotationStatus(quotationWithRfq);
        assertQuotationTransition(quotationWithRfqStatus, targetStatus);
        const isNoop = quotationWithRfqStatus === targetStatus;
        const quotation = isNoop
          ? quotationWithRfq
          : await transitionQuotationStatus(tx, {
            id: quotationWithRfq.id,
            currentStatus: quotationWithRfq.status,
            currentVersion: quotationWithRfq.version,
            nextStatus: targetStatus,
            expectedVersion: version,
            actorId: userId,
            reasonCode: reasonCode || (action === 'approve' ? 'QUOTATION_APPROVED' : 'QUOTATION_REJECTED'),
            reason: comment,
            data: {
              approvedBy: action === 'approve' ? userId : null,
              approvedAt: action === 'approve' ? new Date() : null,
            },
          });

        if (!isNoop) {
          await tx.approval.create({
            data: {
              quotationId: req.params.id,
              level: isAog ? 'AOG' : (quotationTotalPrice(quotation) > 50000 ? 'GM' : quotationTotalPrice(quotation) > 5000 ? 'FINANCE' : 'MANAGER'),
              approverId: userId,
              action: action.toUpperCase(),
              comment,
            },
          });
          await enqueueBusinessEvent(tx, {
            eventType: action === 'approve' ? 'quotation.approved' : 'quotation.rejected',
            aggregateType: 'QUOTATION',
            aggregateId: quotation.id,
            data: {
              quotationId: quotation.id,
              quoteNumber: quotation.quoteNumber,
              status: quotationStatus(quotation),
              totalPrice: quotationTotalPrice(quotation),
              comment,
              approvedBy: action === 'approve' ? userId : null,
              reviewedBy: userId,
              reviewedAt: new Date().toISOString(),
            },
            socket: {
              room: SocketRooms.QUOTATIONS,
              event: action === 'approve' ? SocketEvents.QUOTATION_APPROVED : SocketEvents.QUOTATION_UPDATED,
            },
            createdById: userId,
          });
        }

        return {
          payload: { ...projectQuotationMoney(quotation), status: quotationStatus(quotation).toLowerCase() },
          resourceType: 'QUOTATION',
          resourceId: quotation.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.post(
  '/:id/send',
  requireCapability('quotation', 'send'),
  validateBody(quotationSendSchema),
  asyncHandler(async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const actorId = actor.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/quotations/:id/send'),
      async (tx) => {
        const quotation = await tx.quotation.findUnique({
          where: { id: req.params.id },
          include: {
            customer: true,
            creator: { select: { department: true } },
          },
        });
        if (!quotation) {
          throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        assertQuotationAccess(actor, 'send', quotation);
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

        const account = await getDefaultOutboundAccount(tx);
        const subject = req.body.subject || `Quotation ${quotation.quoteNumber} - ${quotation.partNumber}`;
        const plainBody = req.body.message || [
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
        const pendingEmail = await tx.outboundEmail.create({
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
        await enqueueOutboundEmail(tx, {
          eventType: 'quotation.email.send',
          aggregateType: 'QUOTATION',
          aggregateId: quotation.id,
          outboundEmailId: pendingEmail.id,
          includeQuotationPdf: true,
          createdById: actorId,
        });

        return {
          payload: {
            id: quotation.id,
            quoteNumber: quotation.quoteNumber,
            status: currentQuotationStatus.toLowerCase(),
            version: quotation.version,
            sentAt: quotation.sentAt?.toISOString(),
            outboundEmailId: pendingEmail.id,
            customerEmail: quotation.customer.email,
            emailDeliveryStatus: 'queued',
          },
          statusCode: 202,
          resourceType: 'QUOTATION',
          resourceId: quotation.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({ success: true, data: execution.payload });
  })
);

router.post(
  '/:id/withdraw',
  requireCapability('quotation', 'withdraw'),
  validateBody(quotationWithdrawSchema),
  asyncHandler(async (req, res) => {
    const reason = req.body.reason;
    const sendWithdrawalNotice = req.body.sendWithdrawalNotice ?? true;
    const actor = (req as AuthRequest).user!;
    const actorId = actor.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/quotations/:id/withdraw'),
      async (tx) => {
        const quotation = await tx.quotation.findUnique({
          where: { id: req.params.id },
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
        if (!quotation) {
          throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        assertQuotationAccess(actor, 'withdraw', quotation);
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
        if (sendWithdrawalNotice && !quotation.customer.email) {
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
          const detail = await tx.inventoryDetail.findUnique({
            where: { id: quotation.inventoryDetailId },
            include: { inventoryItem: true },
          });
          if (!detail || detail.status !== 'RESERVED') {
            throw new AppError('报价预留库存状态异常，无法完成撤回', 409, 'STATE_CONFLICT');
          }
          if (detail.inventoryItem.partNumber !== quotation.partNumber) {
            throw new AppError('报价预留库存件号不一致，无法完成撤回', 409, 'RESOURCE_CONFLICT');
          }

          const released = await tx.inventoryDetail.updateMany({
            where: { id: detail.id, status: 'RESERVED' },
            data: { status: 'AVAILABLE' },
          });
          if (released.count !== 1) {
            throw new AppError('报价预留库存已被其他操作更新，请刷新后重试', 409, 'STATE_CONFLICT');
          }

          const releaseTransaction = await tx.inventoryTransaction.create({
            data: {
              inventoryDetailId: detail.id,
              type: 'RESERVATION_RELEASE',
              quantity: 0,
              beforeQuantity: detail.quantity,
              afterQuantity: detail.quantity,
              quotationId: quotation.id,
              referenceNo: quotation.quoteNumber,
              referenceType: 'QUOTATION',
              notes: `Quotation withdrawn: ${reason}`,
              createdBy: actorId,
            },
          });
          releasedReservation = {
            inventoryDetailId: detail.id,
            partNumber: detail.inventoryItem.partNumber,
            quantity: detail.quantity,
            reservedQuantity: quotation.reservedQuantity,
            transactionId: releaseTransaction.id,
          };
        }

        const withdrawnAt = new Date();
        const updatedQuotation = await transitionQuotationStatus(tx, {
          id: quotation.id,
          currentStatus: quotation.status,
          currentVersion: quotation.version,
          nextStatus: 'WITHDRAWN',
          expectedVersion: req.body.version,
          actorId,
          reasonCode: req.body.reasonCode || 'QUOTATION_WITHDRAWN',
          reason,
          data: {
            withdrawnAt,
            withdrawalReason: reason,
            ...(releasedReservation ? { reservedQuantity: 0 } : {}),
          },
        });
        await tx.outboundEmail.update({
          where: { id: latestSentEmail.id },
          data: {
            status: 'WITHDRAWN',
            withdrawnAt,
            withdrawalReason: reason,
          },
        });

        let noticeId: string | undefined;
        if (sendWithdrawalNotice) {
          const account = await getDefaultOutboundAccount(tx);
          const subject = `Withdrawal Notice: ${quotation.quoteNumber}`;
          const plainBody = [
            `${quotation.customer.contactName || quotation.customer.name} 您好，`,
            '',
            `此前发送的报价单 ${quotation.quoteNumber} 已撤回，请忽略旧版报价。`,
            `撤回原因：${reason}`,
            '',
            '如需新版报价，我们会尽快补发。',
            '',
            'AeroLink 销售团队',
          ].join('\n');
          const notice = await tx.outboundEmail.create({
            data: {
              purpose: 'QUOTATION_WITHDRAWAL',
              quotationId: quotation.id,
              customerId: quotation.customerId,
              accountId: account.id,
              toEmail: quotation.customer.email,
              subject,
              textBody: plainBody,
              htmlBody: textToHtml(plainBody),
              status: 'PENDING',
              withdrawalReason: reason,
            },
          });
          await enqueueOutboundEmail(tx, {
            eventType: 'quotation.withdrawal.email',
            aggregateType: 'QUOTATION',
            aggregateId: quotation.id,
            outboundEmailId: notice.id,
            createdById: actorId,
          });
          noticeId = notice.id;
        }

        if (releasedReservation) {
          await enqueueBusinessEvent(tx, {
            eventType: 'inventory.reservation.released',
            aggregateType: 'INVENTORY_DETAIL',
            aggregateId: releasedReservation.inventoryDetailId,
            data: {
              inventoryDetailId: releasedReservation.inventoryDetailId,
              partNumber: releasedReservation.partNumber,
              status: 'AVAILABLE',
              quantity: releasedReservation.quantity,
              releasedQuantity: releasedReservation.reservedQuantity,
              quotationId: quotation.id,
              quoteNumber: quotation.quoteNumber,
              transactionId: releasedReservation.transactionId,
              releasedBy: actorId,
              reason,
            },
            socket: { room: SocketRooms.INVENTORY, event: SocketEvents.INVENTORY_UPDATED },
            createdById: actorId,
          });
        }

        await enqueueBusinessEvent(tx, {
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
          createdById: actorId,
        });

        return {
          payload: {
            id: updatedQuotation.id,
            quoteNumber: updatedQuotation.quoteNumber,
            status: quotationStatus(updatedQuotation).toLowerCase(),
            version: updatedQuotation.version,
            withdrawnAt: updatedQuotation.withdrawnAt?.toISOString(),
            withdrawalReason: updatedQuotation.withdrawalReason,
            withdrawalNoticeId: noticeId,
            withdrawalNoticeDeliveryStatus: noticeId ? 'queued' : undefined,
            reservationReleased: Boolean(releasedReservation),
            releasedInventoryDetailId: releasedReservation?.inventoryDetailId,
          },
          resourceType: 'QUOTATION',
          resourceId: updatedQuotation.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.post(
  '/:id/accept',
  requireCapability('quotation', 'accept'),
  validateBody(quotationAcceptSchema),
  asyncHandler(async (req, res) => {
    const { poNumber, deliveryDate, templateId, confirmationNote, reasonCode, reason, version } = req.body;
    const actor = (req as AuthRequest).user!;
    const actorId = actor.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/quotations/:id/accept'),
      async (tx) => {
        const quotation = await tx.quotation.findUnique({
          where: { id: req.params.id },
          include: {
            customer: true,
            creator: { select: { department: true } },
          },
        });
        if (!quotation) {
          throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        assertQuotationAccess(actor, 'accept', quotation);
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
          : await transitionQuotationStatus(tx, {
            id: quotation.id,
            currentStatus: quotation.status,
            currentVersion: quotation.version,
            nextStatus: 'ACCEPTED',
            expectedVersion: version,
            actorId,
            reasonCode: reasonCode || 'CUSTOMER_ACCEPTED_QUOTATION',
            reason: confirmationNote ?? reason,
            data: {
              acceptedAt: quotation.acceptedAt || new Date(),
              customerConfirmationNote: confirmationNote ?? quotation.customerConfirmationNote,
            },
          });

        const existingOrder = await tx.order.findFirst({
          where: { quotationId: quotation.id },
          include: { customer: true },
        });
        const order = existingOrder || await createOrderFromQuotation({
          tx,
          quotation: updatedQuotation,
          customer: quotation.customer,
          poNumber,
          deliveryDate,
          actorId,
          reasonCode: 'ORDER_CREATED_FROM_ACCEPTED_QUOTATION',
          reason: confirmationNote ?? reason,
        });
        const isNewOrder = !existingOrder;
        const generatedDocument = await ensureOrderContractDocument({
          quotation: updatedQuotation,
          customer: quotation.customer,
          order,
          templateId,
          generatedById: actorId,
          tx,
        });

        if (isNewOrder || !wasAlreadyAccepted) {
          await enqueueBusinessEvent(tx, {
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
            createdById: actorId,
          });
        }
        if (isNewOrder) {
          await enqueueBusinessEvent(tx, {
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
            createdById: actorId,
          });
        }

        return {
          payload: {
            id: updatedQuotation.id,
            quoteNumber: updatedQuotation.quoteNumber,
            status: quotationStatus(updatedQuotation).toLowerCase(),
            version: updatedQuotation.version,
            acceptedAt: updatedQuotation.acceptedAt?.toISOString(),
            customerConfirmationNote: updatedQuotation.customerConfirmationNote,
            order: mapOrderResponse(order),
            contractDocumentId: generatedDocument.id,
            contractDocumentTitle: generatedDocument.title,
          },
          resourceType: 'QUOTATION',
          resourceId: updatedQuotation.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.get(
  '/:id/pdf',
  requireCapability('quotation', 'read'),
  asyncHandler(async (req, res) => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        creator: { select: { department: true } },
      },
    });

    if (!quotation) {
      throw new AppError('报价单不存在', 404);
    }
    const actor = (req as AuthRequest).user!;
    assertQuotationAccess(actor, 'read', quotation);

    const pdfBuffer = await generateQuotationPDF({
      quoteNumber: quotation.quoteNumber,
      customerName: quotation.customer.name,
      partNumber: quotation.partNumber,
      quantity: quotation.quantity,
      unitPrice: preferredMoneyValue(quotation.unitPriceDecimal, quotation.unitPrice) ?? 0,
      totalPrice: quotationTotalPrice(quotation),
      costPrice: preferredMoneyValue(quotation.costPriceDecimal, quotation.costPrice) ?? 0,
      margin: quotation.margin,
      validityDays: quotation.validityDays,
      saleType: quotation.saleType,
      incoterm: quotation.incoterm || '',
      incotermLocation: quotation.incotermLocation || '',
      leadTimeDays: quotation.leadTimeDays || undefined,
      leadTimeBasis: quotation.leadTimeBasis || '',
      moq: quotation.moq || undefined,
      mpq: quotation.mpq || undefined,
      priceBasis: quotation.priceBasis || '',
      taxIncluded: quotation.taxIncluded,
      taxRate: quotation.taxRate || undefined,
      warrantyDays: quotation.warrantyDays,
      warrantyTerms: quotation.warrantyTerms || '',
      packagingRequirement: quotation.packagingRequirement || '',
      shippingMethod: quotation.shippingMethod || '',
      commonNote: quotation.commonNote || '',
      certificateFiles: quotation.certificateFiles?.split(',').filter(Boolean),
      createdAt: quotation.createdAt.toISOString(),
      expiryDate: quotation.expiryDate.toISOString().split('T')[0],
      createdBy: quotation.createdBy,
      includeInternalInfo: canViewQuotationCost(actor, quotation),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', buildContentDisposition(`${quotation.quoteNumber}.pdf`));
    res.send(pdfBuffer);
  })
);

export default router;
