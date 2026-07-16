import { Router } from 'express';
import { Prisma, type Quotation } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { buildContentDisposition } from '../lib/downloadHeaders.js';
import { validateBody } from '../middleware/validate.js';
import { orderCreateSchema, orderStatusUpdateSchema, orderUpdateSchema } from '../lib/validation.js';
import { createOrderFromQuotation, mapOrderResponse } from '../lib/orderWorkflowService.js';
import { ensureOrderContractDocument, ORDER_CONTRACT_DOCUMENT_TYPE } from '../lib/documentTemplateService.js';
import { AuthRequest } from '../middleware/auth.js';
import { normalizeMoney, preferredMoneyValue } from '../lib/money.js';
import { generateOrderPDF } from '../lib/pdfService.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, type IdempotentExecution, runIdempotentOperation } from '../lib/idempotencyService.js';
import { enqueueBusinessEvent } from '../lib/outboxService.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import { SocketEvents, SocketRooms } from '../lib/socketEvents.js';
import { isOrderStatusTransitionAllowed, normalizeOrderStatus, toUiOrderStatus } from '../lib/orderStateMachine.js';
import { isQuotationTransitionAllowed, normalizeQuotationStatus } from '../lib/quotationStateMachine.js';
import { transitionOrderStatus, transitionQuotationStatus } from '../lib/transactionStateService.js';
import prisma from '../lib/prisma.js';

const router = Router();

type OrderWithCustomer = Prisma.OrderGetPayload<{ include: { customer: true } }>;
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
};

type RelatedQuotationMoneySource = {
  unitPrice: number;
  unitPriceDecimal: Prisma.Decimal | null;
  totalPrice: number;
  totalPriceDecimal: Prisma.Decimal | null;
  costPrice: number;
  costPriceDecimal: Prisma.Decimal | null;
};

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
    ...rest
  } = order;

  return {
    ...rest,
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
    ...rest
  } = quotation;

  return {
    ...rest,
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
  asyncHandler(async (req, res) => {
    const { status, search, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.OrderWhereInput = {};
    const statusValue = typeof status === 'string' ? status.toLowerCase() : '';
    if (statusValue === 'in_progress') {
      where.status = { notIn: ['COMPLETED', 'DELIVERED'] };
    } else if (statusValue === 'completed') {
      where.status = { in: ['COMPLETED', 'DELIVERED'] };
    } else if (statusValue) {
      where.status = statusValue.toUpperCase().replace('-', '_');
    }
    const searchValue = typeof search === 'string' ? search.trim() : '';
    if (searchValue) {
      where.OR = [
        { orderNumber: { contains: searchValue, mode: 'insensitive' } },
        { partNumber: { contains: searchValue, mode: 'insensitive' } },
        { customer: { is: { name: { contains: searchValue, mode: 'insensitive' } } } },
      ];
    }

    const [orders, total, statusCounts, amountAggregate] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          customer: true,
          quotation: { select: { quoteNumber: true } },
          tracking: true,
          generatedDocuments: {
            where: { documentType: ORDER_CONTRACT_DOCUMENT_TYPE },
            orderBy: { generatedAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.order.count({ where }),
      prisma.order.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.order.aggregate({
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
      data: orders.map((o) => ({
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
        status: o.status.toLowerCase(),
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
        importDuty: preferredMoneyValue(o.importDutyDecimal, o.importDuty),
        vatAmount: preferredMoneyValue(o.vatAmountDecimal, o.vatAmount),
        totalLandCost: preferredMoneyValue(o.totalLandCostDecimal, o.totalLandCost),
        exchangeCoreCharge: preferredMoneyValue(o.exchangeCoreChargeDecimal, o.exchangeCoreCharge),
        exchangeCoreDueDate: o.exchangeCoreDueDate?.toISOString(),
        eSignatureCustomer: o.eSignatureCustomer,
        eSignatureSupplier: o.eSignatureSupplier,
      })),
      summary,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  })
);

router.get(
  '/:id/status-history',
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });

    if (!order) {
      throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
    }

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
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        quotation: true,
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

    const projectedOrder = projectOrderWithQuotation(order);
    res.json({
      success: true,
      data: {
        ...projectedOrder,
        status: order.status.toLowerCase(),
        contractDocumentId: order.generatedDocuments[0]?.id,
        contractDocumentTitle: order.generatedDocuments[0]?.title,
      },
    });
  })
);

router.post(
  '/',
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

    const actorId = (req as AuthRequest).user!.id;
    const idempotencyContext = buildIdempotencyContext(req, actorId, 'POST:/orders');
    let execution: IdempotentExecution<OrderCreateResponse>;

    try {
      execution = await runIdempotentOperation(
        idempotencyContext,
        async (tx) => {
          const quotation = await tx.quotation.findUnique({
            where: { id: quotationId },
            include: { customer: true },
          });
          if (!quotation) {
            throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
          }
          if (quotation.customerId !== customerId) {
            throw new AppError('订单客户与报价客户不一致', 400, 'BAD_REQUEST');
          }

          const existingOrder = await tx.order.findUnique({
            where: { quotationId },
            include: { customer: true },
          });

          let order: OrderWithCustomer;
          let updatedQuotation: Quotation;
          let isNewOrder = false;

          if (existingOrder) {
            order = existingOrder;
            updatedQuotation = quotation;
          } else {
            const quotationStatus = normalizeQuotationStatus(quotation.status);
            if (!quotationStatus || !['APPROVED', 'SENT', 'ACCEPTED'].includes(quotationStatus)) {
              throw new AppError('当前报价状态不能创建订单', 409, 'INVALID_STATE_TRANSITION');
            }
            if (quotationStatus !== 'ACCEPTED' && !isQuotationTransitionAllowed(quotation.status, 'ACCEPTED')) {
              throw new AppError('当前报价状态不能创建订单', 409, 'INVALID_STATE_TRANSITION');
            }

            updatedQuotation = quotationStatus === 'ACCEPTED'
              ? quotation
              : await transitionQuotationStatus(tx, {
                id: quotation.id,
                currentStatus: quotation.status,
                currentVersion: quotation.version,
                nextStatus: 'ACCEPTED',
                expectedVersion: quotationVersion,
                actorId,
                reasonCode: 'ORDER_CREATED_FROM_QUOTATION',
                data: { acceptedAt: quotation.acceptedAt || new Date() },
              });

            order = await createOrderFromQuotation({
              tx,
              quotation: updatedQuotation,
              customer: quotation.customer,
              poNumber,
              deliveryDate,
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
              actorId,
              reasonCode: 'ORDER_CREATED_FROM_QUOTATION',
            });
            isNewOrder = true;
          }

          const generatedDocument = await ensureOrderContractDocument({
            quotation: updatedQuotation,
            customer: quotation.customer,
            order,
            templateId,
            generatedById: actorId,
            tx,
          });

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
                status: order.status,
                totalAmount: orderTotalAmount(order),
                createdAt: order.createdAt.toISOString(),
              },
              socket: {
                room: SocketRooms.ORDERS,
                event: SocketEvents.ORDER_CREATED,
              },
              createdById: actorId,
            });
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
              },
              socket: {
                room: SocketRooms.QUOTATIONS,
                event: SocketEvents.QUOTATION_UPDATED,
              },
              createdById: actorId,
            });
          }

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
        prisma.order.findUnique({ where: { quotationId }, include: { customer: true } }),
        prisma.quotation.findUnique({ where: { id: quotationId }, include: { customer: true } }),
      ]);
      if (!concurrentOrder || !currentQuotation || currentQuotation.customerId !== customerId) {
        throw error;
      }

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
  validateBody(orderStatusUpdateSchema),
  asyncHandler(async (req, res) => {
    const nextStatus = String(req.body.status);
    const actorId = (req as AuthRequest).user!.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'PATCH:/orders/:id/status'),
      async (tx) => {
        const existing = await tx.order.findUnique({ where: { id: req.params.id } });
        if (!existing) {
          throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
        }

        const currentStatus = normalizeOrderStatus(existing.status);
        if (!isOrderStatusTransitionAllowed(currentStatus, nextStatus)) {
          throw new AppError(`订单不允许从 ${toUiOrderStatus(currentStatus)} 变更为 ${toUiOrderStatus(nextStatus)}`, 409, 'INVALID_STATE_TRANSITION');
        }

        const order = existing.status === nextStatus
          ? existing
          : await transitionOrderStatus(tx, {
            id: existing.id,
            currentStatus: existing.status,
            currentVersion: existing.version,
            nextStatus,
            expectedVersion: req.body.version,
            actorId,
            reasonCode: req.body.reasonCode || 'MANUAL_STATUS_UPDATE',
            reason: req.body.reason,
          });

        if (existing.status !== order.status) {
          await enqueueBusinessEvent(tx, {
            eventType: 'order.status.changed',
            aggregateType: 'ORDER',
            aggregateId: order.id,
            data: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              oldStatus: existing.status,
              newStatus: order.status,
              changedAt: new Date().toISOString(),
            },
            socket: {
              room: SocketRooms.ORDERS,
              event: SocketEvents.ORDER_STATUS_CHANGED,
            },
            createdById: actorId,
          });
        }

        return {
          payload: {
            ...projectOrderMoney(order),
            status: order.status.toLowerCase(),
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

    const actorId = (req as AuthRequest).user!.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'PATCH:/orders/:id'),
      async (tx) => {
        const existing = await tx.order.findUnique({ where: { id: req.params.id } });
        if (!existing) {
          throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
        }

        const order = await tx.order.update({
          where: { id: req.params.id },
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
        });

        return {
          payload: {
            ...projectOrderWithQuotation(order),
            status: order.status.toLowerCase(),
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
  asyncHandler(async (req, res) => {
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
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { customer: true },
    });

    if (!order) {
      throw new AppError('订单不存在', 404);
    }

    const pdfBuffer = await generateOrderPDF({
      orderNumber: order.orderNumber,
      customerName: order.customer.name,
      partNumber: order.partNumber,
      quantity: order.quantity,
      totalAmount: orderTotalAmount(order),
      status: order.status,
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
