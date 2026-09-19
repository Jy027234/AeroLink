import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Quotation response policy on idempotent replay', () => {
  let quotationFindUniqueMock: ReturnType<typeof vi.fn>;
  let runIdempotentOperationMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    quotationFindUniqueMock = vi.fn().mockResolvedValue({
      createdBy: 'sales-1',
      creator: { department: 'Sales' },
    });
    runIdempotentOperationMock = vi.fn().mockResolvedValue({
      payload: {
        id: 'quotation-1',
        quoteNumber: 'QT-1',
        status: 'pending_approval',
        costPrice: 80,
        costPriceDecimal: '80.0000',
        margin: 20,
      },
      statusCode: 200,
      replayed: true,
      key: 'retry-key',
    });

    vi.doMock('../lib/prisma.js', () => ({
      default: { quotation: { findUnique: quotationFindUniqueMock } },
    }));
    vi.doMock('../lib/idempotencyService.js', () => ({
      buildIdempotencyContext: vi.fn(() => ({ key: 'retry-key' })),
      runIdempotentOperation: runIdempotentOperationMock,
      applyIdempotencyHeaders: vi.fn(),
    }));
    vi.doMock('../modules/quotationOrder/index.js', async () => {
      const actual = await vi.importActual<typeof import('../modules/quotationOrder/index.js')>('../modules/quotationOrder/index.js');
      return {
        ...actual,
        quotationRepository: { findUnique: quotationFindUniqueMock },
        submitQuotationAggregate: vi.fn(),
      };
    });
    vi.doMock('../lib/documentTemplateService.js', () => ({
      ensureOrderContractDocument: vi.fn(),
      ORDER_CONTRACT_DOCUMENT_TYPE: 'ORDER_CONTRACT',
    }));
    vi.doMock('../lib/pdfService.js', () => ({ generateQuotationPDF: vi.fn() }));
  });

  it('rechecks the current sales scope and removes cached cost fields after a downgrade', async () => {
    const quotationsRouter = (await import('./quotations.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, {
        user: { id: 'sales-1', role: 'sales', department: 'Sales' },
      });
      next();
    });
    app.use('/api/quotations', quotationsRouter);
    app.use(errorHandler);

    const response = await request(app).post('/api/quotations/quotation-1/submit').send({});

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      id: 'quotation-1',
      quoteNumber: 'QT-1',
      status: 'pending_approval',
    });
    expect(response.body.data).not.toHaveProperty('costPrice');
    expect(response.body.data).not.toHaveProperty('margin');
    expect(quotationFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 'quotation-1' },
      select: {
        createdBy: true,
        creator: { select: { department: true } },
      },
    });
    expect(runIdempotentOperationMock).toHaveBeenCalledTimes(1);
  });
});
