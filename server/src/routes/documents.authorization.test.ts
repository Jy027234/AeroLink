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

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      generatedDocument: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/documentTemplateService.js', () => ({
      ORDER_CONTRACT_DOCUMENT_TYPE: 'ORDER_CONTRACT',
      generateDocumentPdf: vi.fn().mockResolvedValue(Buffer.from('pdf')),
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
    const app = await buildApp({ id: 'creator-1', role: 'viewer' });

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
});
