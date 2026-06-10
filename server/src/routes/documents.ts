import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { buildContentDisposition } from '../lib/downloadHeaders.js';
import { generateDocumentPdf, ORDER_CONTRACT_DOCUMENT_TYPE } from '../lib/documentTemplateService.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const quotationId = req.query.quotationId?.toString();
    const orderId = req.query.orderId?.toString();
    const documentType = req.query.documentType?.toString() || ORDER_CONTRACT_DOCUMENT_TYPE;

    const documents = await prisma.generatedDocument.findMany({
      where: {
        ...(quotationId ? { quotationId } : {}),
        ...(orderId ? { orderId } : {}),
        ...(documentType ? { documentType } : {}),
      },
      include: {
        template: true,
      },
      orderBy: { generatedAt: 'desc' },
    });

    res.json({
      success: true,
      data: documents.map((doc) => ({
        id: doc.id,
        templateId: doc.templateId,
        templateName: doc.template?.name,
        quotationId: doc.quotationId,
        orderId: doc.orderId,
        customerId: doc.customerId,
        documentType: doc.documentType,
        title: doc.title,
        status: doc.status.toLowerCase(),
        generatedAt: doc.generatedAt.toISOString(),
        generatedById: doc.generatedById,
      })),
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const document = await prisma.generatedDocument.findUnique({
      where: { id: req.params.id },
      include: { template: true },
    });

    if (!document) {
      throw new AppError('文档不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: {
        id: document.id,
        templateId: document.templateId,
        templateName: document.template?.name,
        quotationId: document.quotationId,
        orderId: document.orderId,
        customerId: document.customerId,
        documentType: document.documentType,
        title: document.title,
        status: document.status.toLowerCase(),
        contentHtml: document.contentHtml,
        generatedAt: document.generatedAt.toISOString(),
        generatedById: document.generatedById,
      },
    });
  })
);

router.get(
  '/:id/pdf',
  asyncHandler(async (req, res) => {
    const document = await prisma.generatedDocument.findUnique({
      where: { id: req.params.id },
    });

    if (!document) {
      throw new AppError('文档不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const pdfBuffer = await generateDocumentPdf({
      title: document.title,
      contentHtml: document.contentHtml,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', buildContentDisposition(`${document.title}.pdf`));
    res.send(pdfBuffer);
  })
);

export default router;