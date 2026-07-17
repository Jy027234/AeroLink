import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { enqueueBusinessEvent } from '../lib/outboxService.js';
import prisma from '../lib/prisma.js';
import { storeCertificate } from '../lib/blockchain.js';
import { logger } from '../lib/logger.js';

const router = Router();
const requireCertificateMutationRole = requireCapability('certificate', 'issue');

function generateCertificateNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `CERT-${year}-${random}`;
}

function parseTraceHistory(traceHistory: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(traceHistory);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function serializeTraceHistory(history: Array<Record<string, unknown>>): string {
  return JSON.stringify(history);
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { status, certificateType, partNumber, inventoryId, inventoryDetailId, orderId, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.CertificateWhereInput = {};
    if (status) where.status = status.toString().toUpperCase();
    if (certificateType) where.certificateType = certificateType.toString().toUpperCase();
    if (partNumber) where.partNumber = { contains: partNumber.toString() };
    if (inventoryDetailId) {
      where.inventoryDetailId = inventoryDetailId.toString();
    } else if (inventoryId) {
      // inventoryId remains a read-compatible alias for records created before
      // the detail-layer cutover. New certificates only persist inventoryDetailId.
      where.OR = [
        { inventoryId: inventoryId.toString() },
        { inventoryDetailId: inventoryId.toString() },
      ];
    }
    if (orderId) where.orderId = orderId.toString();

    const [certificates, total] = await Promise.all([
      prisma.certificate.findMany({
        where,
        include: {
          template: { select: { id: true, name: true, code: true } },
          inventory: { select: { id: true, partNumber: true, description: true } },
          inventoryDetail: {
            select: {
              id: true,
              serialNumber: true,
              batchNumber: true,
              inventoryItem: { select: { partNumber: true, description: true } },
            },
          },
          order: { select: { id: true, orderNumber: true } },
          supplier: { select: { id: true, name: true } },
          quotation: { select: { id: true, quoteNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.certificate.count({ where }),
    ]);

    res.json({
      success: true,
      data: certificates.map((c) => ({
        id: c.id,
        certificateNumber: c.certificateNumber,
        templateId: c.templateId,
        templateName: c.template?.name,
        templateCode: c.template?.code,
        inventoryId: c.inventoryId,
        inventoryPartNumber: c.inventoryDetail?.inventoryItem.partNumber ?? c.inventory?.partNumber,
        inventoryDescription: c.inventoryDetail?.inventoryItem.description ?? c.inventory?.description,
        inventoryDetailId: c.inventoryDetailId,
        inventoryDetailPartNumber: c.inventoryDetail?.inventoryItem.partNumber,
        orderId: c.orderId,
        orderNumber: c.order?.orderNumber,
        supplierId: c.supplierId,
        supplierName: c.supplier?.name,
        quotationId: c.quotationId,
        quotationNumber: c.quotation?.quoteNumber,
        partNumber: c.partNumber,
        serialNumber: c.serialNumber,
        description: c.description,
        quantity: c.quantity,
        conditionCode: c.conditionCode,
        certificateType: c.certificateType,
        issueDate: c.issueDate.toISOString(),
        expiryDate: c.expiryDate?.toISOString(),
        issuedBy: c.issuedBy,
        issuedById: c.issuedById,
        issuerCompany: c.issuerCompany,
        issuerAddress: c.issuerAddress,
        issuerCertNo: c.issuerCertNo,
        status: c.status,
        qrCodeData: c.qrCodeData,
        verificationUrl: c.verificationUrl,
        fileUrl: c.fileUrl,
        fileHash: c.fileHash,
        traceHistory: parseTraceHistory(c.traceHistory),
        parentCertificateId: c.parentCertificateId,
        countryOfOrigin: c.countryOfOrigin,
        manufactureDate: c.manufactureDate?.toISOString(),
        batchNumber: c.batchNumber,
        ataChapter: c.ataChapter,
        aircraftModel: c.aircraftModel,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
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
    const certificate = await prisma.certificate.findUnique({
      where: { id: req.params.id },
      include: {
        template: true,
        inventory: true,
        inventoryDetail: {
          include: { inventoryItem: true },
        },
        order: true,
        supplier: true,
        quotation: true,
      },
    });

    if (!certificate) {
      throw new AppError('证书不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: {
        id: certificate.id,
        certificateNumber: certificate.certificateNumber,
        templateId: certificate.templateId,
        template: certificate.template
          ? {
              id: certificate.template.id,
              name: certificate.template.name,
              code: certificate.template.code,
              certificateType: certificate.template.certificateType,
              bodyTemplate: certificate.template.bodyTemplate,
              headerTemplate: certificate.template.headerTemplate,
              footerTemplate: certificate.template.footerTemplate,
            }
          : null,
        inventoryId: certificate.inventoryId,
        inventory: certificate.inventory
          ? {
              id: certificate.inventory.id,
              partNumber: certificate.inventory.partNumber,
              description: certificate.inventory.description,
              quantity: certificate.inventory.quantity,
              conditionCode: certificate.inventory.conditionCode,
              serialNumber: certificate.inventory.serialNumber,
            }
          : null,
        inventoryDetailId: certificate.inventoryDetailId,
        inventoryDetail: certificate.inventoryDetail
          ? {
              id: certificate.inventoryDetail.id,
              partNumber: certificate.inventoryDetail.inventoryItem.partNumber,
              serialNumber: certificate.inventoryDetail.serialNumber,
              batchNumber: certificate.inventoryDetail.batchNumber,
              quantity: certificate.inventoryDetail.quantity,
              conditionCode: certificate.inventoryDetail.conditionCode,
            }
          : null,
        orderId: certificate.orderId,
        order: certificate.order
          ? {
              id: certificate.order.id,
              orderNumber: certificate.order.orderNumber,
              status: certificate.order.status,
              customerId: certificate.order.customerId,
            }
          : null,
        supplierId: certificate.supplierId,
        supplier: certificate.supplier
          ? {
              id: certificate.supplier.id,
              name: certificate.supplier.name,
            }
          : null,
        quotationId: certificate.quotationId,
        quotation: certificate.quotation
          ? {
              id: certificate.quotation.id,
              quoteNumber: certificate.quotation.quoteNumber,
            }
          : null,
        partNumber: certificate.partNumber,
        serialNumber: certificate.serialNumber,
        description: certificate.description,
        quantity: certificate.quantity,
        conditionCode: certificate.conditionCode,
        certificateType: certificate.certificateType,
        issueDate: certificate.issueDate.toISOString(),
        expiryDate: certificate.expiryDate?.toISOString(),
        issuedBy: certificate.issuedBy,
        issuedById: certificate.issuedById,
        issuerCompany: certificate.issuerCompany,
        issuerAddress: certificate.issuerAddress,
        issuerCertNo: certificate.issuerCertNo,
        status: certificate.status,
        qrCodeData: certificate.qrCodeData,
        verificationUrl: certificate.verificationUrl,
        fileUrl: certificate.fileUrl,
        fileHash: certificate.fileHash,
        traceHistory: parseTraceHistory(certificate.traceHistory),
        parentCertificateId: certificate.parentCertificateId,
        countryOfOrigin: certificate.countryOfOrigin,
        manufactureDate: certificate.manufactureDate?.toISOString(),
        batchNumber: certificate.batchNumber,
        ataChapter: certificate.ataChapter,
        aircraftModel: certificate.aircraftModel,
        createdAt: certificate.createdAt.toISOString(),
        updatedAt: certificate.updatedAt.toISOString(),
      },
    });
  })
);

router.post(
  '/issue',
  requireCertificateMutationRole,
  asyncHandler(async (req, res) => {
    const {
      templateId,
      inventoryId,
      inventoryDetailId,
      orderId,
      supplierId,
      quotationId,
      partNumber,
      serialNumber,
      description,
      quantity,
      conditionCode,
      certificateType,
      expiryDate,
      issuedBy,
      issuerCompany,
      issuerAddress,
      issuerCertNo,
      countryOfOrigin,
      manufactureDate,
      batchNumber,
      ataChapter,
      aircraftModel,
    } = req.body;

    if (!partNumber) {
      throw new AppError('件号为必填项', 400, 'VALIDATION_ERROR');
    }

    const user = (req as AuthRequest).user;
    const actorId = user!.id;
    const resolvedInventoryDetailId = inventoryDetailId || inventoryId || null;
    if (inventoryId && inventoryDetailId && inventoryId !== inventoryDetailId) {
      throw new AppError('新证书只接受一个库存明细标识，inventoryId 仅作为兼容别名', 400, 'VALIDATION_ERROR');
    }
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actorId, 'POST:/certificates/issue'),
      async (tx) => {
        const [inventoryDetail, order, quotation] = await Promise.all([
          resolvedInventoryDetailId
            ? tx.inventoryDetail.findUnique({
              where: { id: resolvedInventoryDetailId },
              include: { inventoryItem: true },
            })
            : null,
          orderId ? tx.order.findUnique({ where: { id: orderId } }) : null,
          quotationId ? tx.quotation.findUnique({ where: { id: quotationId } }) : null,
        ]);

        if (resolvedInventoryDetailId && !inventoryDetail) {
          throw new AppError('库存明细不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (orderId && !order) {
          throw new AppError('订单不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (quotationId && !quotation) {
          throw new AppError('报价单不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        if (inventoryDetail && inventoryDetail.inventoryItem.partNumber !== partNumber) {
          throw new AppError('证书件号与库存明细不一致', 409, 'RESOURCE_CONFLICT');
        }
        if (order && order.partNumber !== partNumber) {
          throw new AppError('证书件号与订单不一致', 409, 'RESOURCE_CONFLICT');
        }
        if (quotation && quotation.partNumber !== partNumber) {
          throw new AppError('证书件号与报价不一致', 409, 'RESOURCE_CONFLICT');
        }
        if (order && quotation && order.quotationId !== quotation.id) {
          throw new AppError('证书关联的订单与报价不一致', 409, 'RESOURCE_CONFLICT');
        }
        if (order && inventoryDetail && order.inventoryDetailId && order.inventoryDetailId !== inventoryDetail.id) {
          throw new AppError('证书关联的订单与库存明细不一致', 409, 'RESOURCE_CONFLICT');
        }

        const traceEntry = {
          action: 'ISSUE',
          timestamp: new Date().toISOString(),
          userId: user?.id,
          userName: user?.name,
        };
        const certificate = await tx.certificate.create({
          data: {
            certificateNumber: generateCertificateNumber(),
            templateId: templateId || null,
            // The legacy inventoryId foreign key remains for historic records
            // only. All new certificates bind the canonical detail instead.
            inventoryId: null,
            inventoryDetailId: resolvedInventoryDetailId,
            orderId: orderId || null,
            supplierId: supplierId || null,
            quotationId: quotationId || null,
            partNumber,
            serialNumber: serialNumber || inventoryDetail?.serialNumber || null,
            description: description || inventoryDetail?.inventoryItem.description || null,
            quantity: quantity ?? null,
            conditionCode: conditionCode || inventoryDetail?.conditionCode || null,
            certificateType: certificateType?.toUpperCase() || 'AAC-038',
            expiryDate: expiryDate ? new Date(expiryDate) : null,
            issuedBy: issuedBy || user?.name || 'System',
            issuedById: user?.id || '',
            issuerCompany: issuerCompany || null,
            issuerAddress: issuerAddress || null,
            issuerCertNo: issuerCertNo || null,
            status: 'ISSUED',
            traceHistory: serializeTraceHistory([traceEntry]),
            countryOfOrigin: countryOfOrigin || null,
            manufactureDate: manufactureDate ? new Date(manufactureDate) : null,
            batchNumber: batchNumber || inventoryDetail?.batchNumber || null,
            ataChapter: ataChapter || inventoryDetail?.inventoryItem.ataChapter || null,
            aircraftModel: aircraftModel || null,
          },
          include: {
            template: { select: { id: true, name: true, code: true } },
            inventoryDetail: { select: { id: true } },
            order: { select: { id: true, orderNumber: true } },
            supplier: { select: { id: true, name: true } },
            quotation: { select: { id: true, quoteNumber: true } },
          },
        });

        await enqueueBusinessEvent(tx, {
          eventType: 'certificate.issued',
          aggregateType: 'CERTIFICATE',
          aggregateId: certificate.id,
          data: {
            certificateId: certificate.id,
            certificateNumber: certificate.certificateNumber,
            partNumber: certificate.partNumber,
            inventoryId: certificate.inventoryId,
            inventoryDetailId: certificate.inventoryDetailId,
            orderId: certificate.orderId,
            quotationId: certificate.quotationId,
            certificateType: certificate.certificateType,
            issuedById: certificate.issuedById,
          },
          createdById: actorId,
        });

        return {
          payload: {
            id: certificate.id,
            certificateNumber: certificate.certificateNumber,
            templateId: certificate.templateId,
            templateName: certificate.template?.name,
            inventoryId: certificate.inventoryId,
            inventoryDetailId: certificate.inventoryDetailId,
            orderId: certificate.orderId,
            supplierId: certificate.supplierId,
            quotationId: certificate.quotationId,
            partNumber: certificate.partNumber,
            serialNumber: certificate.serialNumber,
            description: certificate.description,
            quantity: certificate.quantity,
            conditionCode: certificate.conditionCode,
            certificateType: certificate.certificateType,
            issueDate: certificate.issueDate.toISOString(),
            expiryDate: certificate.expiryDate?.toISOString(),
            issuedBy: certificate.issuedBy,
            issuedById: certificate.issuedById,
            status: certificate.status,
            traceHistory: parseTraceHistory(certificate.traceHistory),
            createdAt: certificate.createdAt.toISOString(),
            updatedAt: certificate.updatedAt.toISOString(),
          },
          statusCode: 201,
          resourceType: 'CERTIFICATE',
          resourceId: certificate.id,
        };
      },
    );

    // A replay also retries a prior best-effort blockchain failure. A stored
    // certificate is checked first so normal idempotent replays remain quiet.
    try {
      const [certificate, existingBlock] = await Promise.all([
        prisma.certificate.findUnique({ where: { id: execution.payload.id } }),
        prisma.blockchainRecord.findUnique({ where: { certificateId: execution.payload.id } }),
      ]);
      if (certificate && !existingBlock) {
        await storeCertificate(certificate);
      }
    } catch (blockchainError) {
      logger.warn({ err: blockchainError, certificateId: execution.payload.id }, 'Blockchain certificate storage deferred for retry');
    }

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.post(
  '/:id/verify',
  asyncHandler(async (req, res) => {
    const certificate = await prisma.certificate.findUnique({
      where: { id: req.params.id },
      include: {
        template: { select: { id: true, name: true, code: true } },
        inventory: { select: { id: true, partNumber: true, description: true } },
        inventoryDetail: {
          select: {
            id: true,
            inventoryItem: { select: { partNumber: true } },
          },
        },
        order: { select: { id: true, orderNumber: true } },
        supplier: { select: { id: true, name: true } },
        quotation: { select: { id: true, quoteNumber: true } },
      },
    });

    if (!certificate) {
      throw new AppError('证书不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const now = new Date();
    let isExpired = false;
    let daysUntilExpiry: number | null = null;

    if (certificate.expiryDate) {
      isExpired = certificate.expiryDate < now;
      daysUntilExpiry = Math.ceil(
        (certificate.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );
    }

    const isValid = certificate.status === 'ISSUED' && !isExpired;

    res.json({
      success: true,
      data: {
        id: certificate.id,
        certificateNumber: certificate.certificateNumber,
        status: certificate.status,
        isValid,
        isExpired,
        daysUntilExpiry,
        partNumber: certificate.partNumber,
        serialNumber: certificate.serialNumber,
        certificateType: certificate.certificateType,
        issueDate: certificate.issueDate.toISOString(),
        expiryDate: certificate.expiryDate?.toISOString(),
        issuedBy: certificate.issuedBy,
        issuerCompany: certificate.issuerCompany,
        templateName: certificate.template?.name,
        inventoryPartNumber: certificate.inventoryDetail?.inventoryItem.partNumber ?? certificate.inventory?.partNumber,
        inventoryDetailId: certificate.inventoryDetailId,
        orderNumber: certificate.order?.orderNumber,
        supplierName: certificate.supplier?.name,
        verificationTimestamp: now.toISOString(),
      },
    });
  })
);

router.post(
  '/:id/revoke',
  asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const existing = await prisma.certificate.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('证书不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (existing.status === 'REVOKED') {
      throw new AppError('证书已被撤销', 400, 'BAD_REQUEST');
    }

    const user = (req as AuthRequest).user;
    const history = parseTraceHistory(existing.traceHistory);
    history.push({
      action: 'REVOKE',
      timestamp: new Date().toISOString(),
      userId: user?.id,
      userName: user?.name,
      reason: reason || '无说明',
    });

    const certificate = await prisma.certificate.update({
      where: { id: req.params.id },
      data: {
        status: 'REVOKED',
        traceHistory: serializeTraceHistory(history),
      },
    });

    res.json({
      success: true,
      data: {
        id: certificate.id,
        certificateNumber: certificate.certificateNumber,
        status: certificate.status,
        traceHistory: parseTraceHistory(certificate.traceHistory),
        updatedAt: certificate.updatedAt.toISOString(),
      },
    });
  })
);

router.post(
  '/:id/renew',
  asyncHandler(async (req, res) => {
    const { newExpiryDate, reason } = req.body;
    const existing = await prisma.certificate.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('证书不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (existing.status === 'REVOKED') {
      throw new AppError('已撤销的证书不能续期', 400, 'BAD_REQUEST');
    }

    if (!newExpiryDate) {
      throw new AppError('续期必须提供新的到期日期', 400, 'VALIDATION_ERROR');
    }

    const user = (req as AuthRequest).user;
    const history = parseTraceHistory(existing.traceHistory);
    history.push({
      action: 'RENEW',
      timestamp: new Date().toISOString(),
      userId: user?.id,
      userName: user?.name,
      previousExpiryDate: existing.expiryDate?.toISOString(),
      newExpiryDate,
      reason: reason || '无说明',
    });

    const certificate = await prisma.certificate.update({
      where: { id: req.params.id },
      data: {
        expiryDate: new Date(newExpiryDate),
        status: 'ISSUED',
        traceHistory: serializeTraceHistory(history),
      },
    });

    res.json({
      success: true,
      data: {
        id: certificate.id,
        certificateNumber: certificate.certificateNumber,
        status: certificate.status,
        expiryDate: certificate.expiryDate?.toISOString(),
        traceHistory: parseTraceHistory(certificate.traceHistory),
        updatedAt: certificate.updatedAt.toISOString(),
      },
    });
  })
);

router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const certificate = await prisma.certificate.findUnique({
      where: { id: req.params.id },
      include: {
        template: true,
        inventory: true,
        inventoryDetail: { include: { inventoryItem: true } },
        order: true,
        supplier: true,
        quotation: true,
      },
    });

    if (!certificate) {
      throw new AppError('证书不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: {
        id: certificate.id,
        certificateNumber: certificate.certificateNumber,
        certificateType: certificate.certificateType,
        partNumber: certificate.partNumber,
        serialNumber: certificate.serialNumber,
        description: certificate.description,
        quantity: certificate.quantity,
        conditionCode: certificate.conditionCode,
        issueDate: certificate.issueDate.toISOString(),
        expiryDate: certificate.expiryDate?.toISOString(),
        issuedBy: certificate.issuedBy,
        issuedById: certificate.issuedById,
        issuerCompany: certificate.issuerCompany,
        issuerAddress: certificate.issuerAddress,
        issuerCertNo: certificate.issuerCertNo,
        status: certificate.status,
        countryOfOrigin: certificate.countryOfOrigin,
        manufactureDate: certificate.manufactureDate?.toISOString(),
        batchNumber: certificate.batchNumber,
        ataChapter: certificate.ataChapter,
        aircraftModel: certificate.aircraftModel,
        template: certificate.template
          ? {
              name: certificate.template.name,
              code: certificate.template.code,
              bodyTemplate: certificate.template.bodyTemplate,
              headerTemplate: certificate.template.headerTemplate,
              footerTemplate: certificate.template.footerTemplate,
            }
          : null,
        inventory: certificate.inventory
          ? {
              partNumber: certificate.inventory.partNumber,
              description: certificate.inventory.description,
              serialNumber: certificate.inventory.serialNumber,
              quantity: certificate.inventory.quantity,
              conditionCode: certificate.inventory.conditionCode,
            }
          : certificate.inventoryDetail
            ? {
                partNumber: certificate.inventoryDetail.inventoryItem.partNumber,
                description: certificate.inventoryDetail.inventoryItem.description,
                serialNumber: certificate.inventoryDetail.serialNumber,
                quantity: certificate.inventoryDetail.quantity,
                conditionCode: certificate.inventoryDetail.conditionCode,
              }
            : null,
        inventoryDetail: certificate.inventoryDetail
          ? {
              id: certificate.inventoryDetail.id,
              partNumber: certificate.inventoryDetail.inventoryItem.partNumber,
              serialNumber: certificate.inventoryDetail.serialNumber,
              batchNumber: certificate.inventoryDetail.batchNumber,
              quantity: certificate.inventoryDetail.quantity,
              conditionCode: certificate.inventoryDetail.conditionCode,
            }
          : null,
        order: certificate.order
          ? {
              orderNumber: certificate.order.orderNumber,
              status: certificate.order.status,
            }
          : null,
        supplier: certificate.supplier
          ? {
              id: certificate.supplier.id,
              name: certificate.supplier.name,
            }
          : null,
        quotation: certificate.quotation
          ? {
              quoteNumber: certificate.quotation.quoteNumber,
            }
          : null,
        traceHistory: parseTraceHistory(certificate.traceHistory),
      },
    });
  })
);

router.get(
  '/expiring',
  asyncHandler(async (req, res) => {
    const { days = '30' } = req.query;
    const daysNum = Math.min(365, Math.max(1, parseInt(days as string, 10) || 30));

    const now = new Date();
    const threshold = new Date();
    threshold.setDate(now.getDate() + daysNum);

    const certificates = await prisma.certificate.findMany({
      where: {
        status: 'ISSUED',
        expiryDate: {
          gte: now,
          lte: threshold,
        },
      },
      include: {
        template: { select: { id: true, name: true, code: true } },
        inventory: { select: { id: true, partNumber: true, description: true } },
        inventoryDetail: {
          select: {
            id: true,
            inventoryItem: { select: { partNumber: true } },
          },
        },
        order: { select: { id: true, orderNumber: true } },
        supplier: { select: { id: true, name: true } },
      },
      orderBy: { expiryDate: 'asc' },
    });

    res.json({
      success: true,
      data: certificates.map((c) => ({
        id: c.id,
        certificateNumber: c.certificateNumber,
        partNumber: c.partNumber,
        serialNumber: c.serialNumber,
        description: c.description,
        certificateType: c.certificateType,
        expiryDate: c.expiryDate?.toISOString(),
        daysUntilExpiry: c.expiryDate
          ? Math.ceil((c.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          : null,
        inventoryId: c.inventoryId,
        inventoryDetailId: c.inventoryDetailId,
        inventoryPartNumber: c.inventoryDetail?.inventoryItem.partNumber ?? c.inventory?.partNumber,
        orderId: c.orderId,
        orderNumber: c.order?.orderNumber,
        supplierId: c.supplierId,
        supplierName: c.supplier?.name,
        templateName: c.template?.name,
        status: c.status,
      })),
      meta: {
        daysWindow: daysNum,
        count: certificates.length,
        checkedAt: now.toISOString(),
      },
    });
  })
);

export default router;
