import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const originalUpdatedAt = new Date('2026-09-25T08:00:00.000Z');

function buildQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'supplier-quote-1',
    revisionOfId: null,
    revisionRootId: 'supplier-quote-1',
    revisionNumber: 1,
    supersededAt: null,
    revisionReason: null,
    sourceDraftId: 'draft-1',
    sourceDraftItemKey: 'item-1',
    rfqId: null,
    rfqLineId: null,
    inquiryId: null,
    inquiryItemId: null,
    supplierId: 'supplier-1',
    partNumber: 'PN-1',
    description: 'Original description',
    quantity: 2,
    quantityUnit: 'EA',
    unitPrice: 10,
    unitPriceDecimal: null,
    totalPrice: 20,
    totalPriceDecimal: null,
    currency: 'USD',
    currencyReviewStatus: 'VERIFIED',
    leadTimeDays: 5,
    validUntil: null,
    notes: 'Original terms',
    status: 'pending',
    statusEnum: 'pending',
    isWinner: false,
    createdAt: originalUpdatedAt,
    updatedAt: originalUpdatedAt,
    supplier: {
      id: 'supplier-1',
      name: 'Supplier One',
      level: 'A',
      performanceScore: 90,
      contactName: 'Contact',
      email: 'contact@example.test',
    },
    ...overrides,
  };
}

const revisionRequest = {
  expectedUpdatedAt: originalUpdatedAt.toISOString(),
  revisionReason: 'Supplier updated price and lead time',
  description: 'Revised description',
  quantity: 3,
  quantityUnit: 'EA',
  unitPrice: 12.5,
  currency: 'USD',
  leadTimeDays: 8,
  validUntil: null,
  notes: 'Revised terms',
};

describe('supplier quote revisions', () => {
  let app: express.Application;
  let prismaMock: {
    $transaction: ReturnType<typeof vi.fn>;
    rFQ: { findUnique: ReturnType<typeof vi.fn> };
    rfqLine: { findUnique: ReturnType<typeof vi.fn> };
    inquiryItem: { findUnique: ReturnType<typeof vi.fn> };
    quotation: { findFirst: ReturnType<typeof vi.fn> };
    quotationLine: { findFirst: ReturnType<typeof vi.fn> };
    purchaseCommitmentLine: { findFirst: ReturnType<typeof vi.fn> };
    supplierQuote: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.resetModules();
    prismaMock = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
      rFQ: { findUnique: vi.fn() },
      rfqLine: { findUnique: vi.fn() },
      inquiryItem: { findUnique: vi.fn() },
      quotation: { findFirst: vi.fn().mockResolvedValue(null) },
      quotationLine: { findFirst: vi.fn().mockResolvedValue(null) },
      purchaseCommitmentLine: { findFirst: vi.fn().mockResolvedValue(null) },
      supplierQuote: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        delete: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    const router = (await import('./supplierQuotes.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin' } });
      next();
    });
    app.use('/api/supplier-quotes', router);
    app.use(errorHandler);
  });

  it('creates a complete new version and preserves the previous quote as a superseded record', async () => {
    const original = buildQuote();
    const revision = buildQuote({
      id: 'supplier-quote-2',
      revisionOfId: original.id,
      revisionRootId: original.id,
      revisionNumber: 2,
      revisionReason: revisionRequest.revisionReason,
      description: revisionRequest.description,
      quantity: revisionRequest.quantity,
      quantityUnit: revisionRequest.quantityUnit,
      unitPrice: revisionRequest.unitPrice,
      currency: revisionRequest.currency,
      leadTimeDays: revisionRequest.leadTimeDays,
      validUntil: null,
      notes: revisionRequest.notes,
      totalPrice: 37.5,
      updatedAt: new Date('2026-09-25T08:05:00.000Z'),
      createdAt: new Date('2026-09-25T08:05:00.000Z'),
      status: 'pending',
      statusEnum: 'pending',
      isWinner: false,
      sourceDraftId: null,
      sourceDraftItemKey: null,
    });
    prismaMock.supplierQuote.findUnique.mockResolvedValue(original);
    prismaMock.supplierQuote.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.supplierQuote.create.mockResolvedValue(revision);

    const response = await request(app)
      .post(`/api/supplier-quotes/${original.id}/revise`)
      .send(revisionRequest);

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: 'supplier-quote-2',
      revisionOfId: original.id,
      revisionRootId: original.id,
      revisionNumber: 2,
      revisionReason: revisionRequest.revisionReason,
      quantity: 3,
      unitPrice: 12.5,
      totalPrice: 37.5,
      status: 'pending',
      isWinner: false,
    });
    expect(response.body.data.updatedAt).toBe('2026-09-25T08:05:00.000Z');
    expect(prismaMock.supplierQuote.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: original.id, updatedAt: originalUpdatedAt, supersededAt: null },
      data: expect.objectContaining({ isWinner: false, revisionRootId: original.id }),
    }));
    expect(prismaMock.supplierQuote.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        revisionOfId: original.id,
        revisionRootId: original.id,
        revisionNumber: 2,
        supplierId: original.supplierId,
        partNumber: original.partNumber,
        rfqId: original.rfqId,
        status: 'pending',
        isWinner: false,
      }),
    }));
    expect(prismaMock.supplierQuote.create.mock.calls[0]?.[0].data).not.toHaveProperty('sourceDraftId');
    expect(prismaMock.$transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'Serializable' });
  });

  it('keeps old and current versions queryable with timestamps and revision fields', async () => {
    const oldVersion = buildQuote({ supersededAt: new Date('2026-09-25T08:05:00.000Z') });
    const currentVersion = buildQuote({
      id: 'supplier-quote-2',
      revisionOfId: 'supplier-quote-1',
      revisionNumber: 2,
      revisionReason: 'Price changed',
      updatedAt: new Date('2026-09-25T08:05:00.000Z'),
    });
    prismaMock.supplierQuote.findMany.mockResolvedValue([currentVersion, oldVersion]);
    prismaMock.supplierQuote.count.mockResolvedValue(2);

    const response = await request(app).get('/api/supplier-quotes');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'supplier-quote-1',
        quantityUnit: 'EA',
        supersededAt: '2026-09-25T08:05:00.000Z',
        updatedAt: originalUpdatedAt.toISOString(),
      }),
      expect.objectContaining({
        id: 'supplier-quote-2',
        revisionOfId: 'supplier-quote-1',
        revisionRootId: 'supplier-quote-1',
        revisionNumber: 2,
        revisionReason: 'Price changed',
        updatedAt: '2026-09-25T08:05:00.000Z',
      }),
    ]));
  });

  it('rejects stale timestamps, already superseded records, and failed compare-and-set updates', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValueOnce(buildQuote());
    const stale = await request(app)
      .post('/api/supplier-quotes/supplier-quote-1/revise')
      .send({ ...revisionRequest, expectedUpdatedAt: '2026-09-24T08:00:00.000Z' });
    expect(stale.status).toBe(409);
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();

    prismaMock.supplierQuote.findUnique.mockResolvedValueOnce(buildQuote({ supersededAt: new Date() }));
    const superseded = await request(app)
      .post('/api/supplier-quotes/supplier-quote-1/revise')
      .send(revisionRequest);
    expect(superseded.status).toBe(409);

    prismaMock.supplierQuote.findUnique.mockResolvedValueOnce(buildQuote());
    prismaMock.supplierQuote.updateMany.mockResolvedValueOnce({ count: 0 });
    const raced = await request(app)
      .post('/api/supplier-quotes/supplier-quote-1/revise')
      .send(revisionRequest);
    expect(raced.status).toBe(409);
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('requires every nullable commercial field to be present in a revision snapshot', async () => {
    const response = await request(app)
      .post('/api/supplier-quotes/supplier-quote-1/revise')
      .send({
        expectedUpdatedAt: originalUpdatedAt.toISOString(),
        revisionReason: 'Price changed',
        quantity: 2,
        quantityUnit: null,
        unitPrice: 10,
        currency: 'USD',
        leadTimeDays: 5,
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(prismaMock.supplierQuote.findUnique).not.toHaveBeenCalled();
  });

  it('blocks PUT and DELETE when any supported downstream record references the quote', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote());
    prismaMock.purchaseCommitmentLine.findFirst.mockResolvedValue({ id: 'commitment-line-1' });

    const updateResponse = await request(app)
      .put('/api/supplier-quotes/supplier-quote-1')
      .send({ unitPrice: 11 });
    expect(updateResponse.status).toBe(409);
    expect(prismaMock.supplierQuote.update).not.toHaveBeenCalled();

    const deleteResponse = await request(app).delete('/api/supplier-quotes/supplier-quote-1');
    expect(deleteResponse.status).toBe(409);
    expect(prismaMock.supplierQuote.delete).not.toHaveBeenCalled();
  });

  it('does not allow deleting a quote that already has a successor revision', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote());
    prismaMock.supplierQuote.findFirst.mockResolvedValue({ id: 'supplier-quote-2' });

    const response = await request(app).delete('/api/supplier-quotes/supplier-quote-1');

    expect(response.status).toBe(409);
    expect(prismaMock.supplierQuote.delete).not.toHaveBeenCalled();
  });
});
