import { Router } from 'express';
import { Prisma, type Quotation } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { buildContentDisposition } from '../lib/downloadHeaders.js';
import { validateBody } from '../middleware/validate.js';
import { orderCreateSchema, orderStatusUpdateSchema, orderUpdateSchema } from '../lib/validation.js';
import { createOrderFromQuotation, mapOrderResponse } from '../lib/orderWorkflowService.js';
import { ensureOrderContractDocument, ORDER_CONTRACT_DOCUMENT_TYPE } from '../lib/documentTemplateService.js';
import { AuthRequest } from '../middleware/auth.js';
import { generateOrderPDF } from '../lib/pdfService.js';
import { emitWebhookEvent } from '../lib/webhookService.js';
import { isOrderStatusTransitionAllowed, normalizeOrderStatus, toUiOrderStatus } from '../lib/orderStateMachine.js';
import { isUniqueConstraintError } from '../lib/prismaErrors.js';
import prisma from '../lib/prisma.js';

const router = Router();

type OrderWithCustomer = Prisma.OrderGetPayload<{ include: { customer: true } }>;
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
        _sum: { totalAmount: true },
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
      totalValue: amountAggregate._sum.totalAmount || 0,
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
        totalAmount: o.totalAmount,
        status: o.status.toLowerCase(),
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
        importDuty: o.importDuty,
        vatAmount: o.vatAmount,
        totalLandCost: o.totalLandCost,
        exchangeCoreCharge: o.exchangeCoreCharge,
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

    res.json({
      success: true,
      data: {
        ...order,
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
      quotationId, customerId, poNumber, deliveryDate, templateId,
      saleType, incoterm, incotermLocation, shipToId, shipForId,
      warrantyDays, warrantyStartDate,
      certificateRequired, certificateType, certificateDelivered,
      packagingStandard, shippingMethod, carrierAccount,
      inspectionRequired, inspectionPassed, inspectionDate,
      customsClearanceRequired, customsDeclarationNo, importDuty, vatAmount, totalLandCost,
      exchangeCoreCharge, exchangeCoreDueDate,
      eSignatureCustomer, eSignatureSupplier,
    } = req.body;

    const quotation = await prisma.quotation.findUnique({
      where: { id: quotationId },
      include: {
        customer: true,
      },
    });

    if (!quotation) {
      throw new AppError('报价单不存在', 404);
    }

    if (quotation.customerId !== customerId) {
      throw new AppError('订单客户与报价客户不一致', 400, 'BAD_REQUEST');
    }

    const existingOrder = await prisma.order.findUnique({
      where: { quotationId },
      include: { customer: true },
    });

    let order: OrderWithCustomer;
    let updatedQuotation: Quotation;
    let isNewOrder = false;
    const now = new Date();

    if (existingOrder) {
      order = existingOrder;
      updatedQuotation = quotation;
    } else {
      try {
        const transactionResult = await prisma.$transaction(async (tx) => {
          const updated = await tx.quotation.update({
            where: { id: quotationId },
            data: {
              status: 'ACCEPTED',
              acceptedAt: quotation.acceptedAt || now,
            },
          });

          const createdOrder = await createOrderFromQuotation({
            tx,
            quotation: updated,
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
          });

          return { order: createdOrder, updatedQuotation: updated };
        });
        order = transactionResult.order;
        updatedQuotation = transactionResult.updatedQuotation;
        isNewOrder = true;
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }

        const [concurrentOrder, currentQuotation] = await Promise.all([
          prisma.order.findUnique({
            where: { quotationId },
            include: { customer: true },
          }),
          prisma.quotation.findUnique({ where: { id: quotationId } }),
        ]);

        if (!concurrentOrder || !currentQuotation) {
          throw error;
        }

        order = concurrentOrder;
        updatedQuotation = currentQuotation;
      }
    }

    /*
     * quotationId is the natural idempotency key for order creation. The
     * unique database constraint handles concurrent requests; retries return
     * the existing order instead of emitting duplicate business events.
     */
    const generatedDocument = await ensureOrderContractDocument({
      quotation: updatedQuotation,
      customer: quotation.customer,
      order,
      templateId,
      generatedById: (req as AuthRequest).user?.id,
    });

    if (isNewOrder) {
      await emitWebhookEvent('order.created', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        soNumber: order.soNumber,
        quotationId: order.quotationId,
        customerId: order.customerId,
        customerName: order.customer.name,
        status: order.status,
        totalAmount: order.totalAmount,
        createdAt: order.createdAt.toISOString(),
      });

      await emitWebhookEvent('quotation.accepted', {
        quotationId: updatedQuotation.id,
        quoteNumber: updatedQuotation.quoteNumber,
        acceptedAt: updatedQuotation.acceptedAt?.toISOString(),
        orderId: order.id,
        contractDocumentId: generatedDocument.id,
      });
    }

    res.status(isNewOrder ? 201 : 200).json({
      success: true,
      data: {
        ...mapOrderResponse(order),
        contractDocumentId: generatedDocument.id,
        contractDocumentTitle: generatedDocument.title,
      },
    });
  })
);

router.patch(
  '/:id/status',
  validateBody(orderStatusUpdateSchema),
  asyncHandler(async (req, res) => {
    const nextStatus = String(req.body.status);

    const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('订单不存在', 404);
    }

    const currentStatus = normalizeOrderStatus(existing.status);
    if (!isOrderStatusTransitionAllowed(currentStatus, nextStatus)) {
      throw new AppError(`订单不允许从 ${toUiOrderStatus(currentStatus)} 变更为 ${toUiOrderStatus(nextStatus)}`, 409, 'INVALID_STATE_TRANSITION');
    }

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { status: nextStatus },
    });

    if (existing.status !== order.status) {
      await emitWebhookEvent('order.status.changed', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        oldStatus: existing.status,
        newStatus: order.status,
        changedAt: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      data: {
        ...order,
        status: order.status.toLowerCase(),
      },
    });
  })
);

router.patch(
  '/:id',
  validateBody(orderUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('订单不存在', 404);
    }

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
      importDuty: importDuty ?? undefined,
      vatAmount: vatAmount ?? undefined,
      totalLandCost: totalLandCost ?? undefined,
      exchangeCoreCharge: exchangeCoreCharge ?? undefined,
      exchangeCoreDueDate: exchangeCoreDueDate ? new Date(exchangeCoreDueDate) : exchangeCoreDueDate === null ? null : undefined,
      eSignatureCustomer: eSignatureCustomer ?? undefined,
      eSignatureSupplier: eSignatureSupplier ?? undefined,
      trackingNumber: trackingNumber ?? undefined,
      carrier: carrier ?? undefined,
    };

    const order = await prisma.order.update({
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

    res.json({
      success: true,
      data: {
        ...order,
        status: order.status.toLowerCase(),
        contractDocumentId: order.generatedDocuments[0]?.id,
        contractDocumentTitle: order.generatedDocuments[0]?.title,
      },
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
      totalAmount: order.totalAmount,
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
