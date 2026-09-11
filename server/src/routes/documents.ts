import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import type { AuthRequest } from '../middleware/auth.js';
import { buildContentDisposition } from '../lib/downloadHeaders.js';
import { canReadGeneratedDocument } from '../lib/documentAccess.js';
import { generateDocumentPdf, ORDER_CONTRACT_DOCUMENT_TYPE } from '../lib/documentTemplateService.js';
import { quotationDocumentPdf, QUOTATION_PDF_DOCUMENT_TYPE } from '../lib/quotationDocumentService.js';
import prisma from '../lib/prisma.js';

const router = Router();

// Keep the JSON/list queries free of pdfBytes.  A PDF can be several MB and
// is only selected by the binary download route below after authorization.
const documentAccessSelect = {
  id: true,
  templateId: true,
  quotationId: true,
  orderId: true,
  customerId: true,
  documentType: true,
  title: true,
  status: true,
  contentHtml: true,
  contentSha256: true,
  payloadJson: true,
  snapshotHash: true,
  generatedAt: true,
  generatedById: true,
  template: { select: { id: true, name: true } },
  quotation: {
    select: {
      createdBy: true,
      creator: { select: { id: true, department: true } },
    },
  },
  order: {
    select: {
      quotation: {
        select: {
          createdBy: true,
          creator: { select: { id: true, department: true } },
        },
      },
    },
  },
} satisfies Prisma.GeneratedDocumentSelect;

type DocumentWithAccess = Prisma.GeneratedDocumentGetPayload<{ select: typeof documentAccessSelect }>;

function setNoStore(res: { setHeader(name: string, value: string): unknown }) {
  res.setHeader('Cache-Control', 'no-store');
}

function assertReadableDocument<T extends DocumentWithAccess>(req: AuthRequest, document: T | null): T {
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
      select: documentAccessSelect,
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
      select: documentAccessSelect,
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
      select: documentAccessSelect,
    });
    const readableDocument = assertReadableDocument(req, document);

    let pdfBuffer: Buffer;
    if (readableDocument.documentType === QUOTATION_PDF_DOCUMENT_TYPE) {
      if (!readableDocument.quotationId) {
        throw new AppError('报价 PDF 缺少报价关联，不能下载', 409, 'RESOURCE_CONFLICT');
      }
      const artifact = await quotationDocumentPdf(prisma, readableDocument.quotationId);
      if (artifact.document.id !== readableDocument.id) {
        throw new AppError('报价 PDF 文档关联不一致，不能下载', 409, 'RESOURCE_CONFLICT');
      }
      pdfBuffer = artifact.content;
    } else {
      // Existing order contracts remain backed by their immutable contentHtml;
      // do not replace them with the quotation PDF byte artifact.
      pdfBuffer = await generateDocumentPdf({
        title: readableDocument.title,
        contentHtml: readableDocument.contentHtml,
        renderedAt: readableDocument.generatedAt,
      });
    }

    setNoStore(res);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', buildContentDisposition(`${readableDocument.title}.pdf`));
    res.send(pdfBuffer);
  }),
);

export default router;
