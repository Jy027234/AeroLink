import type { Prisma } from '@prisma/client';
import { AppError } from '../middleware/errorHandler.js';
import { generateQuotationHTML } from './pdfService.js';
import { generateDocumentPdf } from './documentTemplateService.js';
import { buildQuotationRenderSnapshot, serializeQuotationRenderSnapshot, parseQuotationRenderSnapshot,
  quotationRenderData, assertImmutableDocumentArtifact, sha256 } from './documentRenderSnapshot.js';

export const QUOTATION_PDF_DOCUMENT_TYPE = 'QUOTATION_PDF';
type Tx = Prisma.TransactionClient;

function assertFrozenQuotationDocument(document: { payloadJson: string | null; snapshotHash: string | null;
  contentHtml: string; contentSha256: string | null } | null, quotationId: string) {
  if (!document?.payloadJson || !document.snapshotHash) {
    throw new AppError('该报价没有冻结的历史文件，请审批新修订版以生成正式文件', 409, 'RESOURCE_CONFLICT');
  }
  const snapshot = parseQuotationRenderSnapshot(document.payloadJson);
  if (!document.contentSha256 || sha256(document.contentHtml) !== document.contentSha256) {
    throw new AppError('报价文件内容校验失败', 409, 'RESOURCE_CONFLICT');
  }
  if (snapshot.source.quotationId !== quotationId || snapshot.snapshotHash !== document.snapshotHash) {
    throw new AppError('报价文件快照与当前记录不一致', 409, 'RESOURCE_CONFLICT');
  }
}

/** Freeze public render inputs and the HTML while approval holds the quote lock. */
export async function freezeQuotationDocument(tx: Tx, quotationId: string, actorId: string) {
  const existing = await tx.generatedDocument.findFirst({ where: { quotationId, documentType: QUOTATION_PDF_DOCUMENT_TYPE } });
  if (existing) {
    assertFrozenQuotationDocument(existing, quotationId);
    return existing;
  }
  const quotation = await tx.quotation.findUniqueOrThrow({ where: { id: quotationId },
    include: { customer: true, lines: { orderBy: { lineNo: 'asc' } } } });
  const capturedAt = new Date();
  const snapshot = buildQuotationRenderSnapshot({ quotation, customer: quotation.customer, lines: quotation.lines, capturedAt });
  const contentHtml = generateQuotationHTML(quotationRenderData(snapshot));
  return tx.generatedDocument.create({ data: {
    quotationId, customerId: quotation.customerId, documentType: QUOTATION_PDF_DOCUMENT_TYPE,
    title: quotation.quoteNumber, status: 'GENERATED', generatedById: actorId, generatedAt: capturedAt,
    payloadJson: serializeQuotationRenderSnapshot(snapshot), snapshotHash: snapshot.snapshotHash,
    contentHtml, contentSha256: sha256(contentHtml),
  } });
}

/** Materialize once; racing readers always receive the bytes that won the CAS. */
export async function quotationDocumentPdf(tx: Tx, quotationId: string) {
  let document = await tx.generatedDocument.findFirst({ where: { quotationId, documentType: QUOTATION_PDF_DOCUMENT_TYPE } });
  assertFrozenQuotationDocument(document, quotationId);
  if (!document) throw new Error('Quotation document missing');
  if (!document.pdfBytes) {
    const bytes = await generateDocumentPdf({ title: document.title, contentHtml: document.contentHtml, renderedAt: document.generatedAt });
    await tx.generatedDocument.updateMany({ where: { id: document.id, pdfBytes: null, snapshotHash: document.snapshotHash },
      data: { pdfBytes: bytes, pdfSha256: sha256(bytes) } });
    document = await tx.generatedDocument.findUniqueOrThrow({ where: { id: document.id } });
  }
  if (!document.pdfBytes || !document.pdfSha256 || !document.snapshotHash) throw new Error('Quotation PDF persistence failed');
  const content = Buffer.from(document.pdfBytes);
  assertImmutableDocumentArtifact({ content, sha256: document.pdfSha256, snapshotHash: document.snapshotHash });
  return { document, content };
}
