import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

function standaloneDocument() {
  return {
    id: 'doc-1',
    templateId: null,
    template: null,
    quotationId: null,
    quotation: null,
    orderId: null,
    order: null,
    customerId: null,
    documentType: 'ORDER_CONTRACT',
    title: 'Standalone document',
    status: 'GENERATED',
    contentHtml: '<p>safe</p>',
    generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    generatedById: 'creator-1',
  };
}

describe('generated document route authorization', () => {
  let prismaMock: {
    generatedDocument: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  let generateDocumentPdfMock: ReturnType<typeof vi.fn>;
  let quotationDocumentPdfMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      generatedDocument: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
      },
    };
    generateDocumentPdfMock = vi.fn().mockResolvedValue(Buffer.from('contract-pdf'));
    quotationDocumentPdfMock = vi.fn();
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/documentTemplateService.js', () => ({
      ORDER_CONTRACT_DOCUMENT_TYPE: 'ORDER_CONTRACT',
      generateDocumentPdf: generateDocumentPdfMock,
    }));
    vi.doMock('../lib/quotationDocumentService.js', () => ({
      QUOTATION_PDF_DOCUMENT_TYPE: 'QUOTATION_PDF',
      quotationDocumentPdf: quotationDocumentPdfMock,
    }));
  });

  async function buildApp(actor: { id: string; role: string; department?: string }) {
    const router = (await import('./documents.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { user: actor });
      next();
    });
    app.use('/api/documents', router);
    app.use(errorHandler);
    return app;
  }

  it('allows a standalone creator and disables caching on the read response', async () => {
    prismaMock.generatedDocument.findUnique.mockResolvedValue(standaloneDocument());
    const app = await buildApp({ id: 'creator-1', role: 'sales', department: 'Sales' });

    const response = await request(app).get('/api/documents/doc-1');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data).toMatchObject({ id: 'doc-1', generatedById: 'creator-1', contentHtml: '<p>safe</p>' });
  });

  it('denies a non-owner linked document even when the generator was the requester', async () => {
    prismaMock.generatedDocument.findUnique.mockResolvedValue({
      ...standaloneDocument(),
      quotationId: 'quote-1',
      quotation: { createdBy: 'sales-2', creator: { id: 'sales-2', department: 'Sales' } },
    });
    const app = await buildApp({ id: 'creator-1', role: 'sales', department: 'Sales' });

    const response = await request(app).get('/api/documents/doc-1');

    expect(response.status).toBe(403);
    expect(response.body.error?.code ?? response.body.code).toBe('AUTH_FORBIDDEN');
  });

  it('returns 404 for a missing detail and filters unauthorized list entries', async () => {
    prismaMock.generatedDocument.findUnique.mockResolvedValue(null);
    const app = await buildApp({ id: 'viewer-1', role: 'viewer' });
    const missing = await request(app).get('/api/documents/missing');
    expect(missing.status).toBe(404);

    prismaMock.generatedDocument.findMany.mockResolvedValue([
      standaloneDocument(),
      {
        ...standaloneDocument(),
        id: 'doc-linked',
        quotationId: 'quote-1',
        quotation: { createdBy: 'sales-2', creator: { id: 'sales-2', department: 'Sales' } },
      },
    ]);
    const list = await request(app).get('/api/documents');
    expect(list.status).toBe(200);
    expect(list.body.data.map((item: { id: string }) => item.id)).toEqual([]);
  });

  it('selects no PDF bytes for JSON list/detail responses', async () => {
    const document = {
      ...standaloneDocument(),
      pdfBytes: Buffer.from('large-frozen-pdf'),
      pdfSha256: crypto.createHash('sha256').update('large-frozen-pdf').digest('hex'),
      snapshotHash: 'snapshot-1',
    };
    prismaMock.generatedDocument.findUnique.mockResolvedValue(document);
    const app = await buildApp({ id: 'creator-1', role: 'viewer' });

    const detail = await request(app).get('/api/documents/doc-1');
    expect(detail.status).toBe(200);
    expect(detail.body.data).not.toHaveProperty('pdfBytes');
    const detailSelect = prismaMock.generatedDocument.findUnique.mock.calls.at(-1)?.[0]?.select as Record<string, unknown>;
    expect(detailSelect.pdfBytes).toBeUndefined();

    prismaMock.generatedDocument.findMany.mockResolvedValue([document]);
    const list = await request(app).get('/api/documents');
    expect(list.status).toBe(200);
    expect(list.body.data[0]).not.toHaveProperty('pdfBytes');
    const listSelect = prismaMock.generatedDocument.findMany.mock.calls.at(-1)?.[0]?.select as Record<string, unknown>;
    expect(listSelect.pdfBytes).toBeUndefined();
  });

  it('serves frozen quotation PDF bytes without regenerating from mutable HTML', async () => {
    const bytes = Buffer.from('frozen-quotation-pdf');
    prismaMock.generatedDocument.findUnique.mockResolvedValue({
      ...standaloneDocument(),
      documentType: 'QUOTATION_PDF',
      quotationId: 'quote-1',
      quotation: { createdBy: 'creator-1', creator: { id: 'creator-1', department: 'Sales' } },
      contentHtml: '<p>Old frozen HTML</p>',
      pdfBytes: bytes,
      pdfSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      snapshotHash: 'snapshot-quotation-1',
    });
    quotationDocumentPdfMock.mockResolvedValue({
      document: { id: 'doc-1' },
      content: bytes,
    });
    const app = await buildApp({ id: 'creator-1', role: 'sales', department: 'Sales' });

    const response = await request(app).get('/api/documents/doc-1/pdf');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/pdf/);
    expect(response.body).toEqual(bytes);
    expect(quotationDocumentPdfMock).toHaveBeenCalledWith(prismaMock, 'quote-1');
    const pdfSelect = prismaMock.generatedDocument.findUnique.mock.calls.at(-1)?.[0]?.select as Record<string, unknown>;
    expect(pdfSelect.pdfBytes).toBeUndefined();
  });

  it('keeps existing order contract downloads backed by immutable contentHtml', async () => {
    prismaMock.generatedDocument.findUnique.mockResolvedValue(standaloneDocument());
    const app = await buildApp({ id: 'creator-1', role: 'viewer' });

    const response = await request(app).get('/api/documents/doc-1/pdf');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.from('contract-pdf'));
    expect(generateDocumentPdfMock).toHaveBeenCalledWith({
      title: 'Standalone document',
      contentHtml: '<p>safe</p>',
      renderedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });
});
