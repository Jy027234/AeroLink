import { Router } from 'express';
import { Prisma, type OrderStatusEnum, type QuotationStatusEnum } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import { createAuditLog } from '../middleware/auditLogger.js';
import { buildContentDisposition } from '../lib/downloadHeaders.js';
import { validateBody } from '../middleware/validate.js';
import { orderCreateSchema, orderStatusUpdateSchema, orderUpdateSchema } from '../lib/validation.js';
import { ensureOrderContractDocument, ORDER_CONTRACT_DOCUMENT_TYPE } from '../lib/documentTemplateService.js';
import { AuthRequest } from '../middleware/auth.js';
import { normalizeMoney, preferredMoneyValue } from '../lib/money.js';
import { generateOrderPDF } from '../lib/pdfService.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, type IdempotentExecution, runIdempotentOperation } from '../lib/idempotencyService.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { toUiOrderStatus } from '../lib/orderStateMachine.js';
import { preferredOrderStatus, preferredQuotationStatus } from '../lib/transactionStatusShadows.js';
import { getCapabilityScope, hasCapability } from '../lib/capabilityPolicy.js';
import { parseControlledExportWindow, parseListQuery, sendCsv, type SortDirection } from '../lib/listQuery.js';
import {
  createOrderFromQuotation,
  createOrderAggregate,
  mapOrderResponse,
  orderRepository,
  quotationRepository,
  transitionOrderAggregate,
  updateOrderAggregate,
} from '../modules/quotationOrder/index.js';
import prisma from '../lib/prisma.js';

const router = Router();

type ScopedOrder = {
  quotation?: {
    createdBy: string;
    creator?: { department?: string | null } | null;
  } | null;
};

function buildOrderReadScope(actor: NonNullable<AuthRequest['user']>): Prisma.OrderWhereInput {
  const scope = getCapabilityScope(actor, 'order.read');
  if (scope === 'all') return {};

  const own: Prisma.OrderWhereInput = { quotation: { is: { createdBy: actor.id } } };
  const department = actor.department
    ? { quotation: { is: { creator: { is: { department: actor.department } } } } } satisfies Prisma.OrderWhereInput
    : undefined;

  if (scope === 'department') return department ?? own;
  if (scope === 'department_or_own') {
    return department ? { OR: [own, department] } : own;
  }
  return own;
}

type OrderListSort = 'createdAt' | 'deliveryDate' | 'totalAmount' | 'orderNumber';

function orderListOrderBy(sort: OrderListSort, direction: SortDirection): Prisma.OrderOrderByWithRelationInput[] {
  switch (sort) {
    case 'deliveryDate':
      return [{ deliveryDate: direction }, { id: 'asc' }];
    case 'totalAmount':
      return [{ totalAmount: direction }, { id: 'asc' }];
    case 'orderNumber':
      return [{ orderNumber: direction }, { id: 'asc' }];
    default:
      return [{ createdAt: direction }, { id: 'asc' }];
  }
}

function buildOrderListWhere(
  query: Record<string, unknown>,
  actor: NonNullable<AuthRequest['user']>,
): Prisma.OrderWhereInput {
  const status = typeof query.status === 'string' ? query.status : '';
  const search = typeof query.search === 'string' ? query.search : '';
  const filters: Prisma.OrderWhereInput[] = [buildOrderReadScope(actor)];
  const statusValue = status.toLowerCase();
  if (statusValue === 'in_progress') {
    filters.push({ status: { notIn: ['COMPLETED', 'DELIVERED'] } });
  } else if (statusValue === 'completed') {
    filters.push({ status: { in: ['COMPLETED', 'DELIVERED'] } });
  } else if (statusValue) {
    filters.push({ status: statusValue.toUpperCase().replace('-', '_') });
  }
  const searchValue = search.trim();
  if (searchValue) {
    filters.push({
      OR: [
        { orderNumber: { contains: searchValue, mode: 'insensitive' } },
        { partNumber: { contains: searchValue, mode: 'insensitive' } },
        { customer: { is: { name: { contains: searchValue, mode: 'insensitive' } } } },
      ],
    });
  }
  return filters.length === 1 ? filters[0] : { AND: filters };
}

function assertOrderAccess(
  actor: NonNullable<AuthRequest['user']>,
  action: 'read' | 'create' | 'update' | 'transition',
  order: ScopedOrder,
) {
  const quotation = order.quotation;
  assertCapability(actor, 'order', action, {
    ownerId: quotation?.createdBy,
    department: quotation?.creator?.department,
  });
}

function canViewOrderCost(actor: NonNullable<AuthRequest['user']>, order: ScopedOrder) {
  const quotation = order.quotation;
  return hasCapability(actor, 'order', 'view_cost', {
    ownerId: quotation?.createdBy,
    department: quotation?.creator?.department,
  });
}

type OrderCreateResponse = ReturnType<typeof mapOrderResponse> & {
  contractDocumentId: string;
  contractDocumentTitle: string;
};

type OrderMoneySource = {
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

type RelatedQuotationMoneySource = {
  unitPrice: number;
  unitPriceDecimal: Prisma.Decimal | null;
  totalPrice: number;
  totalPriceDecimal: Prisma.Decimal | null;
  costPrice: number;
  costPriceDecimal: Prisma.Decimal | null;
  status: string;
  statusEnum?: QuotationStatusEnum | null;
};

function orderStatus(order: Pick<OrderMoneySource, 'status' | 'statusEnum'>) {
  return preferredOrderStatus(order.statusEnum, order.status);
}

function quotationStatus(quotation: Pick<RelatedQuotationMoneySource, 'status' | 'statusEnum'>) {
  return preferredQuotationStatus(quotation.statusEnum, quotation.status);
}

function orderTotalAmount(order: Pick<OrderMoneySource, 'totalAmount' | 'totalAmountDecimal'>) {
  return preferredMoneyValue(order.totalAmountDecimal, order.totalAmount) ?? 0;
}

function projectOrderMoney<T extends OrderMoneySource>(order: T) {
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

function projectRelatedQuotationMoney<T extends RelatedQuotationMoneySource>(quotation: T | null) {
  if (!quotation) {
    return quotation;
  }

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

function projectOrderWithQuotation<T extends OrderMoneySource & { quotation: RelatedQuotationMoneySource | null }>(order: T) {
  return {
    ...projectOrderMoney(order),
    quotation: projectRelatedQuotationMoney(order.quotation),
  };
}

function mapOrderStatusHistoryEntry(history: {
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
    fromStatus: history.fromStatus ? toUiOrderStatus(history.fromStatus) : null,
    toStatus: toUiOrderStatus(history.toStatus),
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
  requireCapability('order', 'read'),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const { page: pageNum, limit: pageSize, skip, sort, direction } = parseListQuery<OrderListSort>(
      query,
      {
        allowedSorts: ['createdAt', 'deliveryDate', 'totalAmount', 'orderNumber'],
        defaultSort: 'createdAt',
        defaultDirection: 'desc',
      },
    );

    const actor = (req as AuthRequest).user!;
    const where = buildOrderListWhere(query, actor);

    const [orders, total, statusCounts, amountAggregate] = await Promise.all([
      orderRepository.findMany({
        where,
        include: {
          customer: true,
          quotation: {
            select: {
              quoteNumber: true,
              createdBy: true,
              creator: { select: { department: true } },
            },
          },
          tracking: true,
          generatedDocuments: {
            where: { documentType: ORDER_CONTRACT_DOCUMENT_TYPE },
            orderBy: { generatedAt: 'desc' },
            take: 1,
          },
        },
        orderBy: orderListOrderBy(sort, direction),
        skip,
        take: pageSize,
      }),
      orderRepository.count({ where }),
      orderRepository.groupBy({
        where,
        by: ['status'],
        _count: { _all: true },
      }),
      orderRepository.aggregate({
        where,
        _sum: { totalAmount: true, totalAmountDecimal: true },
      }),
    ]);

    const summaryCount = (statusValue: string) =>
      statusCounts.find((entry) => entry.status === statusValue)?._count._all || 0;
    const summary = {
      total: statusCounts.reduce((sum, entry) => sum + entry._count._all, 0),
      inProgress: statusCounts.reduce(
        (sum, entry) => sum + (entry.status === 'COMPLETED' || entry.status === 'DELIVERED' ? 0 : entry._count._all),
        0,
      ),
      completed: summaryCount('COMPLETED') + summaryCount('DELIVERED'),
      totalValue: preferredMoneyValue(
        amountAggregate._sum.totalAmountDecimal,
        amountAggregate._sum.totalAmount,
      ) ?? 0,
    };

    res.json({
      success: true,
      data: orders.map((o) => {
        const showCost = canViewOrderCost(actor, o);
        return {
          id: o.id,
          orderNumber: o.orderNumber,
          soNumber: o.soNumber,
          poNumber: o.poNumber,
          quotationId: o.quotationId,
          customerId: o.customerId,
          customerName: o.customer.name,
          partNumber: o.partNumber,
          quantity: o.quantity,
          totalAmount: orderTotalAmount(o),
          status: orderStatus(o).toLowerCase(),
          version: o.version,
          createdAt: o.createdAt.toISOString(),
          deliveryDate: o.deliveryDate?.toISOString(),
          trackingNumber: o.trackingNumber,
          carrier: o.carrier,
          contractDocumentId: o.generatedDocuments[0]?.id,
          contractDocumentTitle: o.generatedDocuments[0]?.title,
          // P2 新增字段
          saleType: o.saleType,
          incoterm: o.incoterm,
          incotermLocation: o.incotermLocation,
          shipToId: o.shipToId,
          shipForId: o.shipForId,
          warrantyDays: o.warrantyDays,
          warrantyStartDate: o.warrantyStartDate?.toISOString(),
          certificateRequired: o.certificateRequired,
          certificateType: o.certificateType,
          certificateDelivered: o.certificateDelivered,
          packagingStandard: o.packagingStandard,
          shippingMethod: o.shippingMethod,
          carrierAccount: o.carrierAccount,
          inspectionRequired: o.inspectionRequired,
          inspectionPassed: o.inspectionPassed,
          inspectionDate: o.inspectionDate?.toISOString(),
          customsClearanceRequired: o.customsClearanceRequired,
          customsDeclarationNo: o.customsDeclarationNo,
          ...(showCost ? {
            importDuty: preferredMoneyValue(o.importDutyDecimal, o.importDuty),
            vatAmount: preferredMoneyValue(o.vatAmountDecimal, o.vatAmount),
            totalLandCost: preferredMoneyValue(o.totalLandCostDecimal, o.totalLandCost),
            exchangeCoreCharge: preferredMoneyValue(o.exchangeCoreChargeDecimal, o.exchangeCoreCharge),
            exchangeCoreDueDate: o.exchangeCoreDueDate?.toISOString(),
          } : {}),
          eSignatureCustomer: o.eSignatureCustomer,
          eSignatureSupplier: o.eSignatureSupplier,
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
  requireCapability('order', 'export'),
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const window = parseControlledExportWindow(query);
    const { sort, direction } = parseListQuery<OrderListSort>(query, {
      allowedSorts: ['createdAt', 'deliveryDate', 'totalAmount', 'orderNumber'],
      defaultSort: 'createdAt',
      defaultDirection: 'desc',
    });
    const orders = await orderRepository.findMany({
      where: buildOrderListWhere(query, (req as AuthRequest).user!),
      select: {
        orderNumber: true,
        soNumber: true,
        poNumber: true,
        partNumber: true,
        quantity: true,
        totalAmount: true,
        status: true,
        deliveryDate: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
      orderBy: orderListOrderBy(sort, direction),
      skip: window.skip,
      take: window.take,
    });

    await createAuditLog({
      req,
      action: 'EXPORT',
      resourceType: 'ORDER',
      details: `Order CSV export (${window.scope}, ${orders.length}/${window.rowLimit} rows)`,
    });
    sendCsv(
      res,
      `orders-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        { header: '订单编号', value: (order) => order.orderNumber },
        { header: '销售订单号', value: (order) => order.soNumber },
        { header: '客户采购单号', value: (order) => order.poNumber },
        { header: '客户', value: (order) => order.customer.name },
        { header: '件号', value: (order) => order.partNumber },
        { header: '数量', value: (order) => order.quantity },
        { header: '金额', value: (order) => order.totalAmount },
        { header: '状态', value: (order) => order.status },
        { header: '交付日期', value: (order) => order.deliveryDate },
        { header: '创建时间', value: (order) => order.createdAt },
      ],
      orders,
      window,
    );
  }),
);

router.get(
  '/:id/status-history',
  requireCapability('order', 'read'),
  asyncHandler(async (req, res) => {
    const order = await orderRepository.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        quotation: {
          select: {
            createdBy: true,
            creator: { select: { department: true } },
          },
        },
      },
    });

    if (!order) {
      throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
    }
    assertOrderAccess((req as AuthRequest).user!, 'read', order);

    const history = await prisma.transactionStatusHistory.findMany({
      where: { entityType: 'ORDER', entityId: order.id },
      include: {
        actor: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      success: true,
      data: history.map(mapOrderStatusHistoryEntry),
    });
  })
);

router.get(
  '/:id',
  requireCapability('order', 'read'),
  asyncHandler(async (req, res) => {
    const order = await orderRepository.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        quotation: { include: { creator: { select: { department: true } } } },
        tracking: { include: { events: true } },
        generatedDocuments: {
          where: { documentType: ORDER_CONTRACT_DOCUMENT_TYPE },
          orderBy: { generatedAt: 'desc' },
        },
      },
    });

    if (!order) {
      throw new AppError('订单不存在', 404);
    }
    const actor = (req as AuthRequest).user!;
    assertOrderAccess(actor, 'read', order);

    const projectedOrder = projectOrderWithQuotation(order);
    const {
      importDuty: _importDuty,
      vatAmount: _vatAmount,
      totalLandCost: _totalLandCost,
      exchangeCoreCharge: _exchangeCoreCharge,
      exchangeCoreDueDate: _exchangeCoreDueDate,
      ...orderWithoutCost
    } = projectedOrder;
    const orderForActor = canViewOrderCost(actor, order) ? projectedOrder : orderWithoutCost;
    res.json({
      success: true,
      data: {
        ...orderForActor,
        status: orderStatus(order).toLowerCase(),
        contractDocumentId: order.generatedDocuments[0]?.id,
        contractDocumentTitle: order.generatedDocuments[0]?.title,
      },
    });
  })
);

router.post(
  '/',
  requireCapability('order', 'create'),
  validateBody(orderCreateSchema),
  asyncHandler(async (req, res) => {
    const {
      quotationId, customerId, quotationVersion, poNumber, deliveryDate, templateId,
      saleType, incoterm, incotermLocation, shipToId, shipForId,
      warrantyDays, warrantyStartDate,
      certificateRequired, certificateType, certificateDelivered,
      packagingStandard, shippingMethod, carrierAccount,
      inspectionRequired, inspectionPassed, inspectionDate,
      customsClearanceRequired, customsDeclarationNo, importDuty, vatAmount, totalLandCost,
      exchangeCoreCharge, exchangeCoreDueDate,
      eSignatureCustomer, eSignatureSupplier,
    } = req.body;

    const actor = (req as AuthRequest).user!;
    const actorId = actor.id;
    const idempotencyContext = buildIdempotencyContext(req, actorId, 'POST:/orders');
    let execution: IdempotentExecution<OrderCreateResponse>;

    try {
      execution = await runIdempotentOperation(
        idempotencyContext,
        async (tx) => {
          const { order, generatedDocument, isNewOrder } = await createOrderAggregate({
            tx,
            quotationId,
            customerId,
            quotationVersion,
            actorId,
            poNumber,
            deliveryDate,
            templateId,
            saleType,
            incoterm,
            incotermLocation,
            shipToId,
            shipForId,
            warrantyDays,
            warrantyStartDate,
            certificateRequired,
            certificateType,
            certificateDelivered,
            packagingStandard,
            shippingMethod,
            carrierAccount,
            inspectionRequired,
            inspectionPassed,
            inspectionDate,
            customsClearanceRequired,
            customsDeclarationNo,
            importDuty,
            vatAmount,
            totalLandCost,
            exchangeCoreCharge,
            exchangeCoreDueDate,
            eSignatureCustomer,
            eSignatureSupplier,
            authorize: (quotation) => {
              const quotationAccessContext = {
                ownerId: quotation.createdBy,
                department: quotation.creator?.department,
              };
              assertCapability(actor, 'order', 'create', quotationAccessContext);
              assertCapability(actor, 'quotation', 'accept', quotationAccessContext);
            },
            createOrder: createOrderFromQuotation,
            ensureContractDocument: ({ quotation, customer, order, templateId: contractTemplateId, generatedById, tx: transaction }) => ensureOrderContractDocument({
              quotation,
              customer,
              order,
              templateId: contractTemplateId,
              generatedById,
              tx: transaction,
            }),
          });

          return {
            payload: {
              ...mapOrderResponse(order),
              contractDocumentId: generatedDocument.id,
              contractDocumentTitle: generatedDocument.title,
            },
            statusCode: isNewOrder ? 201 : 200,
            resourceType: 'ORDER',
            resourceId: order.id,
          };
        },
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      // quotationId remains a natural idempotency boundary. If a concurrent
      // request won the unique constraint, return its committed order instead
      // of reporting a false conflict to a retrying caller.
      const [concurrentOrder, currentQuotation] = await Promise.all([
        orderRepository.findUnique({ where: { quotationId }, include: { customer: true } }),
        quotationRepository.findUnique({
          where: { id: quotationId },
          include: {
            customer: true,
            creator: { select: { department: true } },
          },
        }),
      ]);
      if (!concurrentOrder || !currentQuotation || currentQuotation.customerId !== customerId) {
        throw error;
      }
      const quotationAccessContext = {
        ownerId: currentQuotation.createdBy,
        department: currentQuotation.creator?.department,
      };
      assertCapability(actor, 'order', 'create', quotationAccessContext);
      assertCapability(actor, 'quotation', 'accept', quotationAccessContext);

      const generatedDocument = await ensureOrderContractDocument({
        quotation: currentQuotation,
        customer: currentQuotation.customer,
        order: concurrentOrder,
        templateId,
        generatedById: actorId,
      });
      execution = {
        payload: {
          ...mapOrderResponse(concurrentOrder),
          contractDocumentId: generatedDocument.id,
          contractDocumentTitle: generatedDocument.title,
        },
        statusCode: 200,
        replayed: false,
        key: idempotencyContext.key,
      };
    }

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.patch(
  '/:id/status',
  requireCapability('order', 'transition'),
  validateBody(orderStatusUpdateSchema),
  asyncHandler(async (req, res) => {
    const nextStatus = String(req.body.status);
    const actor = (req as AuthRequest).user!;
    const actorId = actor.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'PATCH:/orders/:id/status'),
      async (tx) => {
        const { order } = await transitionOrderAggregate(tx, {
          id: req.params.id,
          nextStatus,
          expectedVersion: req.body.version,
          actorId,
          reasonCode: req.body.reasonCode || 'MANUAL_STATUS_UPDATE',
          reason: req.body.reason,
          authorize: (candidate) => assertOrderAccess(actor, 'transition', candidate),
        });

        return {
          payload: {
            ...projectOrderMoney(order),
            status: orderStatus(order).toLowerCase(),
          },
          resourceType: 'ORDER',
          resourceId: order.id,
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

router.patch(
  '/:id',
  requireCapability('order', 'update'),
  validateBody(orderUpdateSchema),
  asyncHandler(async (req, res) => {
    const {
      poNumber, deliveryDate, saleType, incoterm, incotermLocation,
      shipToId, shipForId, warrantyDays, warrantyStartDate,
      certificateRequired, certificateType, certificateDelivered,
      packagingStandard, shippingMethod, carrierAccount,
      inspectionRequired, inspectionPassed, inspectionDate,
      customsClearanceRequired, customsDeclarationNo,
      importDuty, vatAmount, totalLandCost,
      exchangeCoreCharge, exchangeCoreDueDate,
      eSignatureCustomer, eSignatureSupplier,
      trackingNumber, carrier,
    } = req.body;

    const importDutyDecimal = importDuty === undefined ? undefined : normalizeMoney(importDuty);
    const vatAmountDecimal = vatAmount === undefined ? undefined : normalizeMoney(vatAmount);
    const totalLandCostDecimal = totalLandCost === undefined ? undefined : normalizeMoney(totalLandCost);
    const exchangeCoreChargeDecimal = exchangeCoreCharge === undefined ? undefined : normalizeMoney(exchangeCoreCharge);
    const data: Prisma.OrderUpdateInput = {
      poNumber: poNumber ?? undefined,
      deliveryDate: deliveryDate ? new Date(deliveryDate) : deliveryDate === null ? null : undefined,
      saleType: saleType ?? undefined,
      incoterm: incoterm ?? undefined,
      incotermLocation: incotermLocation ?? undefined,
      shipToId: shipToId ?? undefined,
      shipForId: shipForId ?? undefined,
      warrantyDays: warrantyDays ?? undefined,
      warrantyStartDate: warrantyStartDate ? new Date(warrantyStartDate) : warrantyStartDate === null ? null : undefined,
      certificateRequired: certificateRequired ?? undefined,
      certificateType: certificateType ?? undefined,
      certificateDelivered: certificateDelivered ?? undefined,
      packagingStandard: packagingStandard ?? undefined,
      shippingMethod: shippingMethod ?? undefined,
      carrierAccount: carrierAccount ?? undefined,
      inspectionRequired: inspectionRequired ?? undefined,
      inspectionPassed: inspectionPassed ?? undefined,
      inspectionDate: inspectionDate ? new Date(inspectionDate) : inspectionDate === null ? null : undefined,
      customsClearanceRequired: customsClearanceRequired ?? undefined,
      customsDeclarationNo: customsDeclarationNo ?? undefined,
      importDuty: importDutyDecimal?.toNumber(),
      importDutyDecimal,
      vatAmount: vatAmountDecimal?.toNumber(),
      vatAmountDecimal,
      totalLandCost: totalLandCostDecimal?.toNumber(),
      totalLandCostDecimal,
      exchangeCoreCharge: exchangeCoreChargeDecimal?.toNumber(),
      exchangeCoreChargeDecimal,
      exchangeCoreDueDate: exchangeCoreDueDate ? new Date(exchangeCoreDueDate) : exchangeCoreDueDate === null ? null : undefined,
      eSignatureCustomer: eSignatureCustomer ?? undefined,
      eSignatureSupplier: eSignatureSupplier ?? undefined,
      trackingNumber: trackingNumber ?? undefined,
      carrier: carrier ?? undefined,
    };

    const actor = (req as AuthRequest).user!;
    const actorId = actor.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'PATCH:/orders/:id'),
      async (tx) => {
        const order = await updateOrderAggregate(tx, {
          id: req.params.id,
          data,
          include: {
            customer: true,
            quotation: true,
            tracking: { include: { events: true } },
            generatedDocuments: {
              where: { documentType: ORDER_CONTRACT_DOCUMENT_TYPE },
              orderBy: { generatedAt: 'desc' },
            },
          },
          authorize: (candidate) => assertOrderAccess(actor, 'update', candidate),
        });

        return {
          payload: {
            ...projectOrderWithQuotation(order),
            status: orderStatus(order).toLowerCase(),
            contractDocumentId: order.generatedDocuments[0]?.id,
            contractDocumentTitle: order.generatedDocuments[0]?.title,
          },
          resourceType: 'ORDER',
          resourceId: order.id,
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
  '/:id/tracking',
  requireCapability('order', 'read'),
  asyncHandler(async (req, res) => {
    const order = await orderRepository.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        quotation: {
          select: {
            createdBy: true,
            creator: { select: { department: true } },
          },
        },
      },
    });
    if (!order) {
      throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
    }
    assertOrderAccess((req as AuthRequest).user!, 'read', order);

    const tracking = await prisma.shipmentTracking.findUnique({
      where: { orderId: req.params.id },
      include: { events: true },
    });

    if (!tracking) {
      throw new AppError('追踪信息不存在', 404);
    }

    res.json({
      success: true,
      data: tracking,
    });
  })
);

router.get(
  '/:id/pdf',
  requireCapability('order', 'read'),
  asyncHandler(async (req, res) => {
    const order = await orderRepository.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        quotation: {
          select: {
            createdBy: true,
            creator: { select: { department: true } },
          },
        },
      },
    });

    if (!order) {
      throw new AppError('订单不存在', 404);
    }
    assertOrderAccess((req as AuthRequest).user!, 'read', order);

    const pdfBuffer = await generateOrderPDF({
      orderNumber: order.orderNumber,
      customerName: order.customer.name,
      partNumber: order.partNumber,
      quantity: order.quantity,
      totalAmount: orderTotalAmount(order),
      status: orderStatus(order),
      poNumber: order.poNumber || undefined,
      deliveryDate: order.deliveryDate?.toISOString().split('T')[0],
      trackingNumber: order.trackingNumber || undefined,
      carrier: order.carrier || undefined,
      createdAt: order.createdAt.toISOString(),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', buildContentDisposition(`${order.orderNumber}.pdf`));
    res.send(pdfBuffer);
  })
);

export default router;
