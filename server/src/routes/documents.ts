import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { buildContentDisposition } from '../lib/downloadHeaders.js';
import { canReadGeneratedDocument } from '../lib/documentAccess.js';
import { generateDocumentPdf, ORDER_CONTRACT_DOCUMENT_TYPE } from '../lib/documentTemplateService.js';
import prisma from '../lib/prisma.js';

const router = Router();

const documentAccessInclude = {
  template: true,
  quotation: {
    include: {
      creator: { select: { id: true, department: true } },
    },
  },
  order: {
    include: {
      quotation: {
        include: {
          creator: { select: { id: true, department: true } },
        },
      },
    },
  },
} satisfies Prisma.GeneratedDocumentInclude;

type DocumentWithAccess = Prisma.GeneratedDocumentGetPayload<{ include: typeof documentAccessInclude }>;

function setNoStore(res: { setHeader(name: string, value: string): unknown }) {
  res.setHeader('Cache-Control', 'no-store');
}

function assertReadableDocument(req: AuthRequest, document: DocumentWithAccess | null): DocumentWithAccess {
  if (!document) {
    throw new AppError('文档不存在', 404, 'RESOURCE_NOT_FOUND');
  }
  if (!canReadGeneratedDocument(req.user!, document)) {
    throw new AppError('无权访问该文档', 403, 'AUTH_FORBIDDEN');
  }
  return document;
}

function toSummary(document: DocumentWithAccess) {
  return {
    id: document.id,
    templateId: document.templateId,
    templateName: document.template?.name,
    quotationId: document.quotationId,
    orderId: document.orderId,
    customerId: document.customerId,
    documentType: document.documentType,
    title: document.title,
    status: document.status.toLowerCase(),
    generatedAt: document.generatedAt.toISOString(),
    generatedById: document.generatedById,
  };
}

function toDetail(document: DocumentWithAccess) {
  return {
    ...toSummary(document),
    contentHtml: document.contentHtml,
  };
}

router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res) => {
    const quotationId = req.query.quotationId?.toString();
    const orderId = req.query.orderId?.toString();
    const documentType = req.query.documentType?.toString() || ORDER_CONTRACT_DOCUMENT_TYPE;

    const documents = await prisma.generatedDocument.findMany({
      where: {
        ...(quotationId ? { quotationId } : {}),
        ...(orderId ? { orderId } : {}),
        ...(documentType ? { documentType } : {}),
      },
      include: documentAccessInclude,
      orderBy: { generatedAt: 'desc' },
    });

    setNoStore(res);
    res.json({
      success: true,
      data: documents.filter((document) => canReadGeneratedDocument(req.user!, document)).map(toSummary),
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req: AuthRequest, res) => {
    const document = await prisma.generatedDocument.findUnique({
      where: { id: req.params.id },
      include: documentAccessInclude,
    });
    const readableDocument = assertReadableDocument(req, document);

    setNoStore(res);
    res.json({ success: true, data: toDetail(readableDocument) });
  }),
);

router.get(
  '/:id/pdf',
  asyncHandler(async (req: AuthRequest, res) => {
    const document = await prisma.generatedDocument.findUnique({
      where: { id: req.params.id },
      include: documentAccessInclude,
    });
    const readableDocument = assertReadableDocument(req, document);

    const pdfBuffer = await generateDocumentPdf({
      title: readableDocument.title,
      contentHtml: readableDocument.contentHtml,
    });

    setNoStore(res);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', buildContentDisposition(`${readableDocument.title}.pdf`));
    res.send(pdfBuffer);
  }),
);

export default router;
