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
import { ensureOrderContractDocument, ORDER_CONTRACT_DOCUMENT_TYPE } from '../lib/documentTemplateService.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { preferredMoneyValue } from '../lib/money.js';
import {
  submitQuotationAggregate,
  approveQuotationAggregate,
  toUiQuotationStatus,
  createOrderFromQuotation,
  acceptQuotationAggregate,
  createQuotationAggregate,
  sendQuotationAggregate,
  withdrawQuotationAggregate,
  mapOrderResponse,
  quotationRepository,
} from '../modules/quotationOrder/index.js';
import {
  preferredOrderStatus,
  preferredQuotationStatus,
  preferredRfqStatus,
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
      quotationRepository.findMany({
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
      quotationRepository.count({ where }),
      quotationRepository.groupBy({
        where,
        by: ['status'],
        _count: { _all: true },
      }),
      quotationRepository.aggregate({
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
    const quotations = await quotationRepository.findMany({
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
    const quotation = await quotationRepository.findUnique({
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
    const quotation = await quotationRepository.findUnique({
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
    const actor = (req as AuthRequest).user!;
    const actorId = actor.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/quotations'),
      async (tx) => {
        const { quotation } = await createQuotationAggregate({
          tx,
          ...req.body,
          actorId,
          authorizeRfq: (relatedRfq) => {
            assertCapability(actor, 'rfq', 'read', {
              ownerId: relatedRfq.createdBy,
              department: relatedRfq.creator?.department,
            });
          },
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
        const { quotation } = await submitQuotationAggregate({
          tx,
          quotationId: req.params.id,
          actorId,
          expectedVersion: req.body.version,
          reasonCode: req.body.reasonCode,
          reason: req.body.reason,
          authorize: (quotation) => assertQuotationAccess(actor, 'transition', quotation),
        });

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
        const { quotation } = await approveQuotationAggregate({
          tx,
          quotationId: req.params.id,
          actorId: userId,
          action,
          comment,
          expectedVersion: version,
          reasonCode,
          authorize: (quotation) => assertQuotationAccess(actor, 'approve', quotation),
        });

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
        const { quotation, pendingEmail } = await sendQuotationAggregate({
          tx,
          quotationId: req.params.id,
          actorId,
          subject: req.body.subject,
          message: req.body.message,
          authorize: (candidate) => assertQuotationAccess(actor, 'send', candidate),
          getDefaultOutboundAccount,
        });
        const currentQuotationStatus = quotationStatus(quotation);

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
        const { quotation: updatedQuotation, noticeId, releasedReservation } = await withdrawQuotationAggregate({
          tx,
          quotationId: req.params.id,
          actorId,
          reason,
          sendWithdrawalNotice,
          expectedVersion: req.body.version,
          reasonCode: req.body.reasonCode,
          authorize: (quotation) => assertQuotationAccess(actor, 'withdraw', quotation),
          getDefaultOutboundAccount: (transaction) => getDefaultOutboundAccount(transaction),
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
    const actor = (req as AuthRequest).user!;
    const actorId = actor.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/quotations/:id/accept'),
      async (tx) => {
        const { quotation: updatedQuotation, order, generatedDocument } = await acceptQuotationAggregate({
          tx,
          quotationId: req.params.id,
          actorId,
          poNumber: req.body.poNumber,
          deliveryDate: req.body.deliveryDate,
          templateId: req.body.templateId,
          confirmationNote: req.body.confirmationNote,
          reasonCode: req.body.reasonCode,
          reason: req.body.reason,
          expectedVersion: req.body.version,
          authorize: (quotation) => assertQuotationAccess(actor, 'accept', quotation),
          createOrder: createOrderFromQuotation,
          ensureContractDocument: ({ quotation, customer, order, templateId, generatedById, tx: transaction }) => ensureOrderContractDocument({
            quotation,
            customer,
            order,
            templateId,
            generatedById,
            tx: transaction,
          }),
        });

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
    const quotation = await quotationRepository.findUnique({
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
