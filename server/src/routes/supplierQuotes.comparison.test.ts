import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

function buildLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rfq-line-1',
    rfqId: 'rfq-1',
    lineNo: 1,
    partNumber: '3214-567-100',
    quantity: 10,
    uom: 'EA',
    alternatePartNumbers: null,
    ...overrides,
  };
}

function buildQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'supplier-quote-1',
    rfqId: 'rfq-1',
    rfqLineId: 'rfq-line-1',
    inquiryId: null,
    inquiryItemId: null,
    supplierId: 'supplier-1',
    partNumber: '3214-567-100',
    quantity: 1,
    quantityUnit: 'EA',
    unitPrice: 100,
    unitPriceDecimal: null,
    totalPrice: 100,
    totalPriceDecimal: null,
    currency: 'USD',
    currencyReviewStatus: 'VERIFIED',
    leadTimeDays: 7,
    validUntil: null,
    status: 'pending',
    statusEnum: null,
    isWinner: false,
    updatedAt: new Date('2026-09-24T08:00:00.000Z'),
    supersededAt: null,
    revisionOfId: null,
    revisionRootId: 'supplier-quote-1',
    revisionNumber: 1,
    inquiry: null,
    inquiryItem: null,
    supplier: {
      id: 'supplier-1',
      name: 'Aviation Parts Inc.',
      level: 'A',
      performanceScore: 90,
    },
    ...overrides,
  };
}

describe('supplier quote rule comparison and line winner selection', () => {
  let prismaMock: {
    $transaction: ReturnType<typeof vi.fn>;
    rFQ: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    rfqLine: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    inquiry: { findUnique: ReturnType<typeof vi.fn> };
    inquiryItem: { findUnique: ReturnType<typeof vi.fn> };
    quotation: { findFirst: ReturnType<typeof vi.fn> };
    quotationLine: { findFirst: ReturnType<typeof vi.fn> };
    purchaseCommitmentLine: { findFirst: ReturnType<typeof vi.fn> };
    auditLog: { create: ReturnType<typeof vi.fn> };
    supplierQuote: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
      rFQ: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue({ id: 'rfq-1', createdBy: 'test-user', creator: { department: 'Sales' } }) },
      rfqLine: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      inquiry: { findUnique: vi.fn() },
      inquiryItem: { findUnique: vi.fn() },
      quotation: { findFirst: vi.fn().mockResolvedValue(null) },
      quotationLine: { findFirst: vi.fn().mockResolvedValue(null) },
      purchaseCommitmentLine: { findFirst: vi.fn().mockResolvedValue(null) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
      supplierQuote: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp(user: { id: string; role: string; name?: string } = { id: 'admin-1', role: 'admin' }) {
    const router = (await import('./supplierQuotes.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user });
      next();
    });
    app.use('/api/supplier-quotes', router);
    app.use(errorHandler);
    return app;
  }

  it('requires a line-scoped key or an unambiguous legacy scope', async () => {
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(prismaMock.supplierQuote.findMany).not.toHaveBeenCalled();
  });

  it('does not expose a multi-line RFQ outside the caller read scope', async () => {
    prismaMock.rFQ.findFirst.mockResolvedValue(null);
    const response = await request(await buildApp()).post('/api/supplier-quotes/compare').send({ rfqId: 'rfq-1' });
    expect(response.status).toBe(404);
    expect(prismaMock.rfqLine.findMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.findMany).not.toHaveBeenCalled();
  });

  it('persists an explicitly supplied unit on a manual quote and keeps an omitted unit unknown', async () => {
    prismaMock.supplierQuote.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'manual-quote',
      ...data,
      unitPriceDecimal: null,
      totalPriceDecimal: null,
    }));
    const app = await buildApp();
    const base = {
      supplierId: 'supplier-1', partNumber: 'PN-MANUAL', quantity: 2, unitPrice: 10, leadTimeDays: 3,
    };

    const explicit = await request(app).post('/api/supplier-quotes').send({ ...base, quantityUnit: 'EA' });
    const unknown = await request(app).post('/api/supplier-quotes').send(base);

    expect(explicit.status).toBe(201);
    expect(explicit.body.data.quantityUnit).toBe('EA');
    expect(unknown.status).toBe(201);
    expect(unknown.body.data.quantityUnit).toBeNull();
    expect(prismaMock.supplierQuote.create.mock.calls.map(([args]) => args.data.quantityUnit)).toEqual(['EA', null]);
  });

  it('returns independent line groups for a multi-line legacy RFQ comparison, including repeated part numbers and empty rows', async () => {
    const lineOne = buildLine({ lineNo: 1, partNumber: 'SAME-PN', quantity: 10 });
    const lineTwo = buildLine({ id: 'rfq-line-2', lineNo: 2, partNumber: 'SAME-PN', quantity: 20 });
    const emptyLine = buildLine({ id: 'rfq-line-3', lineNo: 3, partNumber: 'NO-QUOTES', quantity: 5 });
    prismaMock.rfqLine.findMany.mockResolvedValue([
      lineOne, lineTwo, emptyLine,
    ]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote({ id: 'line-1-supplier-a', rfqLineId: lineOne.id, partNumber: lineOne.partNumber, quantity: 10, unitPrice: 80, totalPrice: 800 }),
      buildQuote({
        id: 'line-1-supplier-b', rfqLineId: lineOne.id, partNumber: lineOne.partNumber, quantity: 10,
        supplierId: 'supplier-2', supplier: { id: 'supplier-2', name: 'Supplier B', level: 'B', performanceScore: 80 },
        unitPrice: 100, totalPrice: 1000,
      }),
      buildQuote({ id: 'line-2-supplier-a', rfqLineId: lineTwo.id, partNumber: lineTwo.partNumber, quantity: 20, unitPrice: 20, totalPrice: 400 }),
      buildQuote({
        id: 'line-2-supplier-b', rfqLineId: lineTwo.id, partNumber: lineTwo.partNumber, quantity: 20,
        supplierId: 'supplier-2', supplier: { id: 'supplier-2', name: 'Supplier B', level: 'B', performanceScore: 80 },
        unitPrice: 30, totalPrice: 600,
      }),
    ]);
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqId: 'rfq-1' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      rfqId: 'rfq-1',
      lineGroups: [
        { rfqLineId: 'rfq-line-1', lineNo: 1, partNumber: 'SAME-PN' },
        { rfqLineId: 'rfq-line-2', lineNo: 2, partNumber: 'SAME-PN' },
        { rfqLineId: 'rfq-line-3', lineNo: 3, partNumber: 'NO-QUOTES' },
      ],
    });
    const [firstLine, secondLine, noQuoteLine] = response.body.data.lineGroups;
    expect(firstLine.comparison.quotes.map((quote: { id: string }) => quote.id).sort()).toEqual([
      'line-1-supplier-a', 'line-1-supplier-b',
    ]);
    expect(secondLine.comparison.quotes.map((quote: { id: string }) => quote.id).sort()).toEqual([
      'line-2-supplier-a', 'line-2-supplier-b',
    ]);
    expect(firstLine.comparison.summary.lowestPrice).toBe(80);
    expect(secondLine.comparison.summary.lowestPrice).toBe(20);
    expect(firstLine.comparison.topRanked).not.toBeNull();
    expect(secondLine.comparison.topRanked).not.toBeNull();
    expect(noQuoteLine.comparison).toMatchObject({
      rfqLineId: 'rfq-line-3', quotes: [], topRanked: null, metadata: { status: 'unavailable' },
    });
    expect(response.body.data).not.toHaveProperty('topRanked');
    expect(response.body.data).not.toHaveProperty('summary');
    expect(response.body.data).not.toHaveProperty('quotes');
    expect(prismaMock.rfqLine.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { rfqId: 'rfq-1' }, orderBy: { lineNo: 'asc' },
    }));
    expect(prismaMock.supplierQuote.findMany).toHaveBeenCalledTimes(3);
    expect(prismaMock.supplierQuote.findMany.mock.calls.map(([args]) => args.where)).toEqual([
      { rfqId: 'rfq-1', OR: [{ rfqLineId: 'rfq-line-1' }], supersededAt: null },
      { rfqId: 'rfq-1', OR: [{ rfqLineId: 'rfq-line-2' }], supersededAt: null },
      { rfqId: 'rfq-1', OR: [{ rfqLineId: 'rfq-line-3' }], supersededAt: null },
    ]);
  });

  it('rejects an RFQ line that does not belong to the requested RFQ', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({
      rfqId: 'rfq-other', rfqLineId: 'rfq-line-1',
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_RFQ_LINE');
    expect(prismaMock.supplierQuote.findMany).not.toHaveBeenCalled();
  });

  it('rejects an inquiry item whose RFQ line differs from the requested line', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    prismaMock.inquiryItem.findUnique.mockResolvedValue({
      id: 'item-b', inquiryId: 'inquiry-1', rfqLineId: 'rfq-line-2', partNumber: 'PN-2', quantity: 1,
      inquiry: { id: 'inquiry-1', rfqId: 'rfq-1', supplierId: 'supplier-1' },
    });
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({
      rfqLineId: 'rfq-line-1', inquiryItemId: 'item-b',
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_RFQ_LINE');
    expect(prismaMock.supplierQuote.findMany).not.toHaveBeenCalled();
  });

  it('resolves a unique RFQ line from the legacy rfqId request', async () => {
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine()]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([buildQuote()]);
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqId: 'rfq-1' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ rfqId: 'rfq-1', rfqLineId: 'rfq-line-1' });
    expect(prismaMock.supplierQuote.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { rfqId: 'rfq-1', OR: [{ rfqLineId: 'rfq-line-1' }, { rfqLineId: null }], supersededAt: null },
    }));
  });

  it('omits cancelled demand rows from the read-only AI comparison while preserving the active line scope', async () => {
    prismaMock.rfqLine.findMany.mockResolvedValue([
      buildLine({ id: 'cancelled-line', lineNo: 1, status: 'CANCELLED' }),
      buildLine({ id: 'active-line', lineNo: 2, status: 'OPEN' }),
    ]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([]);

    const { compareRfqSupplierQuotesDeterministically } = await import('./supplierQuotes.js');
    const result = await compareRfqSupplierQuotesDeterministically('rfq-1', { activeLinesOnly: true });

    expect(result.data).toMatchObject({ rfqLineId: 'active-line' });
    expect(prismaMock.supplierQuote.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.supplierQuote.findMany.mock.calls[0][0].where).toEqual({
      rfqId: 'rfq-1', OR: [{ rfqLineId: 'active-line' }], supersededAt: null,
    });
  });

  it('excludes superseded quote revisions from the comparison results and ranking', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine()]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote({ id: 'old-version', unitPrice: 1, totalPrice: 1, supersededAt: new Date() }),
      buildQuote({ id: 'current-version', unitPrice: 100, totalPrice: 100 }),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqLineId: 'rfq-line-1' });

    expect(response.status).toBe(200);
    expect(response.body.data.quotes.map((quote: { id: string }) => quote.id)).toEqual(['current-version']);
    expect(response.body.data.topRanked).toBeNull();
    expect(prismaMock.supplierQuote.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ supersededAt: null }),
    }));
  });

  it('resolves an inquiry item to its RFQ line and compares the row', async () => {
    prismaMock.inquiryItem.findUnique.mockResolvedValue({
      id: 'item-a', inquiryId: 'inquiry-1', rfqLineId: 'rfq-line-1', partNumber: '3214-567-100', quantity: 1,
      inquiry: { id: 'inquiry-1', rfqId: 'rfq-1', supplierId: 'supplier-1' },
    });
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    prismaMock.supplierQuote.findMany.mockResolvedValue([buildQuote()]);
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ inquiryItemId: 'item-a' });

    expect(response.status).toBe(200);
    expect(response.body.data.rfqLineId).toBe('rfq-line-1');
    expect(prismaMock.supplierQuote.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { rfqId: 'rfq-1', OR: [{ rfqLineId: 'rfq-line-1' }], supersededAt: null },
    }));
  });

  it('returns an explicit unavailable state when no scoped quotes exist', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine()]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqLineId: 'rfq-line-1' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        rfqLineId: 'rfq-line-1',
        quotes: [],
        partNumberGroups: [],
        topRanked: null,
        summary: { totalQuotes: 0, lowestPrice: null, averagePrice: null },
        metadata: { status: 'unavailable', sampleSize: 0 },
      },
    });
    expect(prismaMock.supplierQuote.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { rfqId: 'rfq-1', OR: [{ rfqLineId: 'rfq-line-1' }, { rfqLineId: null }], supersededAt: null },
    }));
  });

  it('ranks only complete, recorded price, lead-time and performance fields for one line and part number', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine()]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote(),
      buildQuote({
        id: 'supplier-quote-2',
        supplierId: 'supplier-2',
        unitPrice: 120,
        totalPrice: 120,
        leadTimeDays: 10,
        supplier: {
          id: 'supplier-2', name: 'Global Aero Supply', level: 'B', performanceScore: 80,
        },
      }),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqLineId: 'rfq-line-1' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        rfqId: 'rfq-1',
        rfqLineId: 'rfq-line-1',
        topRanked: { id: 'supplier-quote-1', ruleScore: 98 },
        metadata: {
          status: 'available',
          source: 'AeroLink supplier quote and supplier master records',
          algorithmVersion: 'supplier-quote-rule-v4',
          sampleSize: 2,
        },
      },
    });
    expect(response.body.data.quotes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'supplier-quote-1',
        rfqLineId: 'rfq-line-1',
        updatedAt: '2026-09-24T08:00:00.000Z',
        partNumber: '3214-567-100',
        unitPrice: 100,
        totalPrice: 100,
        leadTimeDays: 7,
        ruleScore: 98,
        scoreComponents: { price: 100, leadTime: 100, supplierPerformance: 90 },
      }),
      expect.objectContaining({
        id: 'supplier-quote-2',
        ruleScore: 41.5,
        scoreComponents: { price: 0, leadTime: 85, supplierPerformance: 80 },
      }),
    ]));
  });

  it('compares quantity and price only when quote and demand units match after normalization', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine({ uom: 'EA' }));
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine({ uom: 'EA' })]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote({ id: 'unit-match-a', quantity: 10, quantityUnit: ' eA  ', unitPrice: 100, totalPrice: 1000 }),
      buildQuote({
        id: 'unit-match-b', quantity: 8, quantityUnit: 'EA', unitPrice: 120, totalPrice: 960,
        supplierId: 'supplier-2',
        supplier: { id: 'supplier-2', name: 'Supplier 2', level: 'B', performanceScore: 80 },
      }),
      buildQuote({ id: 'unit-mismatch', quantity: 5, quantityUnit: 'BOX', unitPrice: 1, totalPrice: 5 }),
      buildQuote({ id: 'unit-unknown', quantity: 10, quantityUnit: null, unitPrice: 0.5, totalPrice: 5 }),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqLineId: 'rfq-line-1' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      requiredQuantityUnit: 'EA',
      topRanked: { id: 'unit-match-a' },
      summary: { comparableQuoteCount: 2, bestAvailableQuantity: 10, lowestPrice: 100 },
      metadata: { exclusionCounts: { quantityUnitUnknown: 1, quantityUnitMismatch: 1 } },
    });
    expect(response.body.data.quotes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'unit-match-a', quantityUnit: ' eA  ', requiredQuantityUnit: 'EA',
        quantityUnitComparison: { compatible: true, status: 'compatible', reason: 'MATCH', quoteUnit: ' eA  ', demandUnit: 'EA' },
        coversRequiredQuantity: true, isLowestPrice: true,
      }),
      expect.objectContaining({
        id: 'unit-mismatch', eligibleForComparison: false,
        eligibilityReasons: expect.arrayContaining(['QUANTITY_UNIT_MISMATCH']),
        quantityUnitComparison: { compatible: false, status: 'incompatible', reason: 'UNIT_MISMATCH', quoteUnit: 'BOX', demandUnit: 'EA' },
        coversRequiredQuantity: null, quantityShortfall: null, priceDiff: null, isLowestPrice: false, ruleScore: null,
      }),
      expect.objectContaining({
        id: 'unit-unknown', eligibleForComparison: false,
        eligibilityReasons: expect.arrayContaining(['QUANTITY_UNIT_UNKNOWN']),
        quantityUnitComparison: { compatible: false, status: 'unknown', reason: 'QUOTE_UNIT_UNKNOWN', quoteUnit: null, demandUnit: 'EA' },
        coversRequiredQuantity: null, quantityShortfall: null, priceDiff: null, isLowestPrice: false, ruleScore: null,
      }),
    ]));
  });

  it('returns all quotes but excludes expired, unverified-currency and rejected offers from comparison', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine()]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote({
        id: 'pending-full',
        quantity: 10,
        unitPrice: 100,
        totalPrice: 1000,
        validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }),
      buildQuote({
        id: 'accepted-partial',
        quantity: 4,
        unitPrice: 80,
        totalPrice: 320,
        status: 'accepted',
        validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }),
      buildQuote({
        id: 'expired-cheapest',
        unitPrice: 1,
        totalPrice: 1,
        validUntil: new Date(Date.now() - 60_000),
      }),
      buildQuote({
        id: 'expired-status',
        unitPrice: 0.5,
        totalPrice: 0.5,
        status: 'expired',
        validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }),
      buildQuote({ id: 'non-usd', unitPrice: 2, totalPrice: 2, currency: 'EUR' }),
      buildQuote({ id: 'unverified-usd', unitPrice: 3, totalPrice: 3, currencyReviewStatus: null }),
      buildQuote({ id: 'rejected', unitPrice: 4, totalPrice: 4, status: 'rejected' }),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqLineId: 'rfq-line-1' });

    expect(response.status).toBe(200);
    expect(response.body.data.quotes).toHaveLength(7);
    expect(response.body.data.summary).toMatchObject({
      totalQuotes: 7,
      comparableQuoteCount: 2,
      expiredQuoteCount: 2,
      requiredQuantity: 10,
      bestAvailableQuantity: 10,
      remainingQuantityGap: 0,
      lowestPrice: 80,
      highestPrice: 100,
      averagePrice: 90,
    });
    expect(response.body.data.topRanked.id).not.toBe('expired-cheapest');
    expect(response.body.data.metadata).toMatchObject({
      sampleSize: 2,
      excludedQuoteCount: 5,
      expiredQuoteCount: 2,
      exclusionCounts: { expired: 2, unverifiedCurrency: 2, unavailableStatus: 1 },
    });
    expect(response.body.data.metadata.reason).toContain('排除 5 份');
    expect(response.body.data.quotes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'expired-cheapest', isExpired: true, eligibleForComparison: false,
        comparisonEligibility: {
          eligible: false,
          reasons: expect.arrayContaining(['EXPIRED']),
          warnings: expect.any(Array),
        },
        eligibilityReasons: expect.arrayContaining(['EXPIRED']),
        isLowestPrice: false, ruleScore: null,
      }),
      expect.objectContaining({
        id: 'accepted-partial', eligibleForComparison: true,
        comparisonEligibility: {
          eligible: true,
          reasons: [],
          warnings: expect.arrayContaining(['PARTIAL_QUANTITY']),
        },
        coversRequiredQuantity: false, quantityShortfall: 6,
        warnings: expect.arrayContaining(['PARTIAL_QUANTITY']),
      }),
      expect.objectContaining({ id: 'rejected', eligibilityReasons: ['STATUS_NOT_AVAILABLE'] }),
    ]));
  });

  it('returns exact source draft terms by item key and warns when required-certificate data is missing or unknown', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine({ certificateRequired: true }));
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine({ certificateRequired: true })]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote({
        id: 'terms-known',
        quantity: 10,
        sourceDraftItemKey: 'offer-known',
        sourceDraft: { payloadJson: JSON.stringify({ items: [
          { itemKey: 'other', condition: 'NE', certificate: false },
          { itemKey: 'offer-known', condition: 'OH', certificate: ['FAA 8130-3'] },
        ] }) },
      }),
      buildQuote({
        id: 'terms-unknown',
        quantity: 4,
        sourceDraftItemKey: 'offer-missing',
        sourceDraft: { payloadJson: JSON.stringify({ items: [
          { itemKey: 'other', condition: 'NE', certificate: false },
        ] }) },
      }),
      buildQuote({
        id: 'terms-explicitly-missing',
        quantity: 3,
        sourceDraftItemKey: 'offer-no-cert',
        sourceDraft: { payloadJson: JSON.stringify({ items: [
          { itemKey: 'offer-no-cert', condition: 'NE', certificate: false },
        ] }) },
      }),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqLineId: 'rfq-line-1' });

    expect(response.status).toBe(200);
    expect(response.body.data.quotes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'terms-known',
        condition: 'OH', conditionStatus: 'known',
        certificate: ['FAA 8130-3'], certificateStatus: 'provided',
        commercialTerms: {
          condition: 'OH', certificate: ['FAA 8130-3'],
          taxIncluded: null, freightIncluded: null, incoterm: null,
        },
        certificateRequired: true, certificateRequirementStatus: 'provided',
        validUntil: null,
        warnings: expect.arrayContaining(['VALID_UNTIL_UNKNOWN']),
      }),
      expect.objectContaining({
        id: 'terms-unknown',
        condition: null, conditionStatus: 'unknown',
        certificate: null, certificateStatus: 'unknown',
        commercialTerms: {
          condition: null, certificate: null,
          taxIncluded: null, freightIncluded: null, incoterm: null,
        },
        certificateRequirementStatus: 'unknown',
        warnings: expect.arrayContaining(['CONDITION_UNKNOWN', 'CERTIFICATE_UNKNOWN', 'CERTIFICATE_REQUIREMENT_UNKNOWN']),
      }),
      expect.objectContaining({
        id: 'terms-explicitly-missing',
        certificate: false, certificateStatus: 'missing',
        warnings: expect.arrayContaining(['CERTIFICATE_REQUIRED_MISSING', 'CERTIFICATE_REQUIREMENT_CONFLICT']),
      }),
    ]));
  });

  it('compares offers only inside matching commercial basis groups', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine()]);
    const quoteWithDraft = (
      id: string,
      itemKey: string,
      draftTerms: Record<string, unknown>,
      unitPrice: number,
      supplierId = 'supplier-1',
      performanceScore: number | null = 90,
      leadTimeDays = 7,
    ) => buildQuote({
      id,
      supplierId,
      unitPrice,
      totalPrice: unitPrice,
      leadTimeDays,
      sourceDraftItemKey: itemKey,
      sourceDraft: { payloadJson: JSON.stringify({ items: [{ itemKey, ...draftTerms }] }) },
      supplier: {
        id: supplierId,
        name: supplierId,
        level: supplierId === 'supplier-1' ? 'A' : 'B',
        performanceScore,
      },
    });
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      quoteWithDraft('dap-taxed-a', 'dap-taxed-a', {
        condition: 'OH', certificate: ['FAA 8130-3'], taxIncluded: true, freightIncluded: true, incoterm: 'DAP',
      }, 100),
      quoteWithDraft('dap-taxed-b', 'dap-taxed-b', {
        condition: 'OH', certificate: ['FAA 8130-3'], taxIncluded: true, freightIncluded: true, incoterm: 'DAP',
      }, 120, 'supplier-2', 80, 10),
      quoteWithDraft('dap-untaxed', 'dap-untaxed', {
        condition: 'OH', certificate: ['FAA 8130-3'], taxIncluded: false, freightIncluded: true, incoterm: 'DAP',
      }, 1),
      quoteWithDraft('exw-taxed', 'exw-taxed', {
        condition: 'OH', certificate: ['FAA 8130-3'], taxIncluded: true, freightIncluded: true, incoterm: 'EXW',
      }, 2),
      quoteWithDraft('missing-basis', 'missing-basis', {
        condition: 'OH', certificate: ['FAA 8130-3'],
      }, 3),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqLineId: 'rfq-line-1' });

    expect(response.status).toBe(200);
    const partGroup = response.body.data.partNumberGroups[0];
    expect(partGroup.commercialBasisGroups).toHaveLength(4);
    const sameBasisGroup = partGroup.commercialBasisGroups.find((group: { quotes: Array<{ id: string }> }) =>
      group.quotes.some((quote) => quote.id === 'dap-taxed-a'));
    expect(sameBasisGroup).toMatchObject({
      terms: { condition: 'OH', certificate: ['FAA 8130-3'], taxIncluded: true, freightIncluded: true, incoterm: 'DAP' },
      summary: { comparableQuoteCount: 2, lowestPrice: 100, highestPrice: 120 },
      metadata: { status: 'available' },
      topRanked: { id: 'dap-taxed-a' },
    });
    expect(sameBasisGroup.quotes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dap-taxed-a', priceDiff: 0, isLowestPrice: true, ruleScore: 98 }),
      expect.objectContaining({ id: 'dap-taxed-b', priceDiff: 20, isLowestPrice: false, ruleScore: 41.5 }),
    ]));
    expect(partGroup.commercialBasisGroups.find((group: { terms: { taxIncluded: boolean | null } }) =>
      group.terms.taxIncluded === false)?.summary.lowestPrice).toBe(1);
    expect(partGroup.commercialBasisGroups.find((group: { terms: { incoterm: string | null } }) =>
      group.terms.incoterm === 'EXW')?.summary.lowestPrice).toBe(2);
    expect(partGroup.commercialBasisGroups.find((group: { terms: { taxIncluded: boolean | null } }) =>
      group.terms.taxIncluded === null)?.quotes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'missing-basis',
        commercialTerms: { condition: 'OH', certificate: ['FAA 8130-3'], taxIncluded: null, freightIncluded: null, incoterm: null },
        warnings: expect.arrayContaining(['TAX_BASIS_UNKNOWN', 'FREIGHT_BASIS_UNKNOWN', 'INCOTERM_UNKNOWN']),
      }),
    ]));
    expect(partGroup).toMatchObject({
      topRanked: null,
      summary: { lowestPrice: null, highestPrice: null, averagePrice: null, comparableQuoteCount: 5 },
      metadata: { differentCommercialBasisGroups: true, eligibleCommercialBasisGroupCount: 4 },
    });
    expect(response.body.data).toMatchObject({
      topRanked: null,
      summary: { lowestPrice: null, highestPrice: null, averagePrice: null },
    });
    expect(response.body.data.quotes).toHaveLength(5);
  });

  it('does not mix another RFQ line into the quote list or the same-part min/max', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    prismaMock.rfqLine.findMany.mockResolvedValue([
      buildLine(), buildLine({ id: 'rfq-line-2', partNumber: 'PN-2' }),
    ]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote(),
      buildQuote({ id: 'quote-line-b', rfqLineId: 'rfq-line-2', partNumber: 'PN-2', unitPrice: 1, totalPrice: 1 }),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqLineId: 'rfq-line-1' });

    expect(response.status).toBe(200);
    expect(prismaMock.supplierQuote.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { rfqId: 'rfq-1', OR: [{ rfqLineId: 'rfq-line-1' }], supersededAt: null },
    }));
    expect(response.body.data.quotes.map((quote: { id: string }) => quote.id)).toEqual(['supplier-quote-1']);
    expect(response.body.data.summary).toMatchObject({ lowestPrice: 100, highestPrice: 100 });
  });

  it('keeps alternate part numbers in separate price groups', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine({ alternatePartNumbers: '["ALT-PN"]' }));
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine({ alternatePartNumbers: '["ALT-PN"]' })]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote(),
      buildQuote({
        id: 'quote-alt',
        partNumber: 'ALT-PN',
        unitPrice: 1,
        totalPrice: 1,
        supplierId: 'supplier-2',
        supplier: { id: 'supplier-2', name: 'Alt Supplier', level: 'B', performanceScore: 80 },
      }),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqLineId: 'rfq-line-1' });

    expect(response.status).toBe(200);
    expect(response.body.data.partNumberGroups).toHaveLength(2);
    expect(response.body.data.partNumberGroups.map((group: { partNumber: string }) => group.partNumber).sort()).toEqual([
      '3214-567-100', 'ALT-PN',
    ]);
    expect(response.body.data.topRanked).toBeNull();
    expect(response.body.data.summary).toMatchObject({ lowestPrice: null, highestPrice: null, averagePrice: null });
  });

  it('does not infer missing supplier performance or emit a ranking', async () => {
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine()]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      buildQuote({ supplier: { id: 'supplier-1', name: 'Aviation Parts Inc.', level: 'A', performanceScore: null } }),
      buildQuote({
        id: 'supplier-quote-2',
        supplierId: 'supplier-2',
        supplier: { id: 'supplier-2', name: 'Global Aero Supply', level: 'B', performanceScore: 80 },
      }),
    ]);

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/compare').send({ rfqLineId: 'rfq-line-1' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        topRanked: null,
        metadata: { status: 'insufficient_data', sampleSize: 2 },
      },
    });
    expect(response.body.data.quotes).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleScore: null }),
    ]));
  });

  it('selects winners inside a serializable transaction scoped to the selected RFQ line', async () => {
    const lineA = buildLine();
    const lineB = buildLine({ id: 'rfq-line-2', partNumber: 'PN-2' });
    const winners: Record<string, ReturnType<typeof buildQuote>> = {
      'quote-a': buildQuote({ id: 'quote-a' }),
      'quote-b': buildQuote({ id: 'quote-b', rfqLineId: 'rfq-line-2', partNumber: 'PN-2' }),
    };
    prismaMock.supplierQuote.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => winners[where.id]);
    prismaMock.rfqLine.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'rfq-line-1' ? lineA : lineB);
    prismaMock.supplierQuote.update.mockImplementation(async ({ where, data }: {
      where: { id: string }; data: Record<string, unknown>;
    }) => ({ ...winners[where.id], ...data }));

    const app = await buildApp();
    const responseA = await request(app).post('/api/supplier-quotes/quote-a/select-winner');
    const responseB = await request(app).post('/api/supplier-quotes/quote-b/select-winner');

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(prismaMock.supplierQuote.updateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { rfqLineId: 'rfq-line-1' },
      { rfqLineId: 'rfq-line-2' },
    ]);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(prismaMock.$transaction.mock.calls.map(([, options]) => options)).toEqual([
      { isolationLevel: 'Serializable' },
      { isolationLevel: 'Serializable' },
    ]);
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'APPROVE', resourceType: 'SUPPLIER_QUOTE', resourceId: 'quote-a', userId: 'admin-1' }),
    }));
  });

  it('does not duplicate a winner-selection audit event on a repeated click', async () => {
    const selected = buildQuote({ isWinner: true, status: 'accepted' });
    prismaMock.supplierQuote.findUnique.mockResolvedValue(selected);
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    const response = await request(await buildApp()).post('/api/supplier-quotes/supplier-quote-1/select-winner');
    expect(response.status).toBe(200);
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not select a winner for an RFQ outside the caller read scope', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote());
    prismaMock.rFQ.findFirst.mockResolvedValue(null);
    const response = await request(await buildApp()).post('/api/supplier-quotes/supplier-quote-1/select-winner');
    expect(response.status).toBe(404);
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('blocks winner selection when a quote unit is incompatible or missing', async () => {
    const line = buildLine({ uom: 'EA' });
    prismaMock.rfqLine.findUnique.mockResolvedValue(line);
    prismaMock.supplierQuote.findUnique
      .mockResolvedValueOnce(buildQuote({ id: 'mismatch-winner', quantityUnit: 'BOX' }))
      .mockResolvedValueOnce(buildQuote({ id: 'unknown-winner', quantityUnit: null }));

    const app = await buildApp();
    const mismatch = await request(app).post('/api/supplier-quotes/mismatch-winner/select-winner');
    const unknown = await request(app).post('/api/supplier-quotes/unknown-winner/select-winner');

    expect(mismatch.status).toBe(409);
    expect(mismatch.body.message).toContain('单位');
    expect(unknown.status).toBe(409);
    expect(unknown.body.message).toContain('单位');
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.update).not.toHaveBeenCalled();
  });

  it('blocks winner selection for a superseded quote version', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote({ supersededAt: new Date() }));

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/supplier-quote-1/select-winner');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
  });

  it.each([true, false])('rejects generic quote updates that attempt to set isWinner=%s', async (isWinner) => {
    const app = await buildApp();
    const response = await request(app).put('/api/supplier-quotes/supplier-quote-1').send({ isWinner });

    expect(response.status).toBe(400);
    expect(response.body.details.isWinner).toContain('请使用专用中选接口修改中选状态');
    expect(prismaMock.supplierQuote.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.update).not.toHaveBeenCalled();
  });

  it('requires supplier quote update permission to clear a winner', async () => {
    const app = await buildApp({ id: 'viewer-1', role: 'viewer' });
    const response = await request(app)
      .post('/api/supplier-quotes/supplier-quote-1/clear-winner')
      .send({ expectedUpdatedAt: '2026-09-24T08:00:00.000Z' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('AUTH_FORBIDDEN');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('requires RFQ read access before clearing an associated winner', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote({ isWinner: true }));
    prismaMock.rFQ.findFirst.mockResolvedValue(null);

    const app = await buildApp({ id: 'sales-1', role: 'sales' });
    const response = await request(app)
      .post('/api/supplier-quotes/supplier-quote-1/clear-winner')
      .send({ expectedUpdatedAt: '2026-09-24T08:00:00.000Z' });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('clears only the target winner in a serializable transaction and is idempotent on repeat', async () => {
    const originalUpdatedAt = new Date('2026-09-24T08:00:00.000Z');
    const clearedUpdatedAt = new Date('2026-09-24T08:05:00.000Z');
    let quoteState = buildQuote({ id: 'target-quote', isWinner: true, updatedAt: originalUpdatedAt });
    const otherWinner = buildQuote({ id: 'other-quote', isWinner: true });
    prismaMock.supplierQuote.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === otherWinner.id ? otherWinner : quoteState);
    prismaMock.supplierQuote.updateMany.mockImplementation(async ({ where, data }: {
      where: { id: string; isWinner: boolean; updatedAt: Date };
      data: { isWinner: boolean };
    }) => {
      expect(where).toEqual({
        id: 'target-quote', isWinner: true, supersededAt: null, updatedAt: originalUpdatedAt,
      });
      quoteState = { ...quoteState, ...data, updatedAt: clearedUpdatedAt };
      return { count: 1 };
    });

    const app = await buildApp();
    const body = { expectedUpdatedAt: originalUpdatedAt.toISOString() };
    const first = await request(app).post('/api/supplier-quotes/target-quote/clear-winner').send(body);
    const second = await request(app).post('/api/supplier-quotes/target-quote/clear-winner').send(body);

    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ id: 'target-quote', isWinner: false, updatedAt: clearedUpdatedAt.toISOString() });
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ id: 'target-quote', isWinner: false });
    expect(quoteState.isWinner).toBe(false);
    expect(otherWinner.isWinner).toBe(true);
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(prismaMock.supplierQuote.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('allows clearing the current revised quote and derives read scope from its RFQ line', async () => {
    const updatedAt = new Date('2026-09-24T08:00:00.000Z');
    prismaMock.supplierQuote.findUnique
      .mockResolvedValueOnce(buildQuote({
        id: 'current-revision', rfqId: null, rfqLineId: 'rfq-line-1', revisionNumber: 2,
        revisionRootId: 'root-quote', isWinner: true, updatedAt,
      }))
      .mockResolvedValueOnce(buildQuote({
        id: 'current-revision', rfqId: null, rfqLineId: 'rfq-line-1', revisionNumber: 2,
        revisionRootId: 'root-quote', isWinner: false, updatedAt: new Date('2026-09-24T08:01:00.000Z'),
      }));
    prismaMock.rfqLine.findUnique.mockResolvedValue({ rfqId: 'rfq-1' });
    prismaMock.supplierQuote.updateMany.mockResolvedValue({ count: 1 });

    const app = await buildApp();
    const response = await request(app)
      .post('/api/supplier-quotes/current-revision/clear-winner')
      .send({ expectedUpdatedAt: updatedAt.toISOString() });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: 'current-revision', isWinner: false });
    expect(prismaMock.rFQ.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AND: expect.arrayContaining([{ id: 'rfq-1' }]) }),
    }));
    expect(prismaMock.supplierQuote.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'current-revision', isWinner: true, supersededAt: null, updatedAt,
      },
      data: { isWinner: false },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale quote version before mutation or audit', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote({
      isWinner: true,
      updatedAt: new Date('2026-09-24T08:01:00.000Z'),
    }));

    const app = await buildApp();
    const response = await request(app)
      .post('/api/supplier-quotes/supplier-quote-1/clear-winner')
      .send({ expectedUpdatedAt: '2026-09-24T08:00:00.000Z' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('treats a concurrent clear that already removed winner status as an idempotent success', async () => {
    const requestedVersion = new Date('2026-09-24T08:00:00.000Z');
    const clearedQuote = buildQuote({ isWinner: false, updatedAt: new Date('2026-09-24T08:01:00.000Z') });
    prismaMock.supplierQuote.findUnique
      .mockResolvedValueOnce(buildQuote({ isWinner: true, updatedAt: requestedVersion }))
      .mockResolvedValueOnce(clearedQuote);
    prismaMock.supplierQuote.updateMany.mockResolvedValue({ count: 0 });

    const app = await buildApp();
    const response = await request(app)
      .post('/api/supplier-quotes/supplier-quote-1/clear-winner')
      .send({ expectedUpdatedAt: requestedVersion.toISOString() });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ isWinner: false });
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('returns a conflict when another quote mutation wins the conditional update race', async () => {
    const requestedVersion = new Date('2026-09-24T08:00:00.000Z');
    prismaMock.supplierQuote.findUnique
      .mockResolvedValueOnce(buildQuote({ isWinner: true, updatedAt: requestedVersion }))
      .mockResolvedValueOnce(buildQuote({ isWinner: true, updatedAt: new Date('2026-09-24T08:01:00.000Z') }));
    prismaMock.supplierQuote.updateMany.mockResolvedValue({ count: 0 });

    const app = await buildApp();
    const response = await request(app)
      .post('/api/supplier-quotes/supplier-quote-1/clear-winner')
      .send({ expectedUpdatedAt: requestedVersion.toISOString() });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(prismaMock.supplierQuote.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'supplier-quote-1', isWinner: true, supersededAt: null, updatedAt: requestedVersion,
      },
      data: { isWinner: false },
    });
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('clears bound and historical unbound winners together for a one-line RFQ', async () => {
    const line = buildLine();
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote({ id: 'quote-bound' }));
    prismaMock.rfqLine.findUnique.mockResolvedValue(line);
    prismaMock.rfqLine.findMany.mockResolvedValue([line]);
    prismaMock.supplierQuote.update.mockResolvedValue(buildQuote({ id: 'quote-bound', isWinner: true }));

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/quote-bound/select-winner');

    expect(response.status).toBe(200);
    expect(prismaMock.supplierQuote.updateMany).toHaveBeenCalledWith({
      where: { rfqId: 'rfq-1', OR: [{ rfqLineId: 'rfq-line-1' }, { rfqLineId: null }] },
      data: { isWinner: false },
    });
  });

  it('requires the staged quote version when selecting through a shared transaction', async () => {
    const { selectSupplierQuoteWinnerInTransaction } = await import('../lib/supplierQuoteSelectWinnerCommand.js');
    const tx = prismaMock as unknown as Parameters<typeof selectSupplierQuoteWinnerInTransaction>[0];
    const actor = { id: 'admin-1', email: 'admin@example.test', name: 'Admin', role: 'admin' };
    const stagedVersion = new Date('2026-09-24T08:00:00.000Z');
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote({ updatedAt: new Date('2026-09-24T08:01:00.000Z') }));

    await expect(selectSupplierQuoteWinnerInTransaction(tx, 'supplier-quote-1', actor, stagedVersion))
      .rejects.toMatchObject({ statusCode: 409, code: 'STATE_CONFLICT' });
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();

    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote({ updatedAt: stagedVersion }));
    prismaMock.rfqLine.findUnique.mockResolvedValue(buildLine());
    prismaMock.rfqLine.findMany.mockResolvedValue([buildLine()]);
    prismaMock.supplierQuote.update.mockResolvedValue(buildQuote({ isWinner: true, status: 'accepted' }));
    const selected = await selectSupplierQuoteWinnerInTransaction(tx, 'supplier-quote-1', actor, stagedVersion);
    expect(selected.isWinner).toBe(true);
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('does not block selection solely because a quote covers only part of the demand', async () => {
    const partialQuote = buildQuote({
      id: 'partial-winner',
      quantity: 3,
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const line = buildLine({ quantity: 10 });
    prismaMock.supplierQuote.findUnique.mockResolvedValue(partialQuote);
    prismaMock.rfqLine.findUnique.mockResolvedValue(line);
    prismaMock.rfqLine.findMany.mockResolvedValue([line]);
    prismaMock.supplierQuote.update.mockResolvedValue({ ...partialQuote, isWinner: true, status: 'accepted' });

    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/partial-winner/select-winner');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: 'partial-winner', quantity: 3, isWinner: true });
  });

  it('blocks a legacy unbound quote from winning on a multi-line RFQ', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote({ rfqLineId: null }));
    prismaMock.rFQ.findUnique.mockResolvedValue({
      id: 'rfq-1', partNumber: '3214-567-100', quantity: 10, alternatePartNumbers: null,
    });
    prismaMock.rfqLine.findMany.mockResolvedValue([
      buildLine(), buildLine({ id: 'rfq-line-2', partNumber: 'PN-2' }),
    ]);
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/supplier-quote-1/select-winner');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('LINE_ID_REQUIRED');
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.update).not.toHaveBeenCalled();
  });

  it('blocks expired quotes from winning', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote({ validUntil: new Date(Date.now() - 60_000) }));
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/supplier-quote-1/select-winner');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
  });

  it('blocks quotes explicitly marked expired even when their validity date is in the future', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote({
      status: 'expired',
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }));
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/supplier-quote-1/select-winner');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
  });

  it('blocks quotes with unverified currency from winning', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(buildQuote({ currencyReviewStatus: 'HISTORICAL_UNVERIFIED' }));
    const app = await buildApp();
    const response = await request(app).post('/api/supplier-quotes/supplier-quote-1/select-winner');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(prismaMock.supplierQuote.updateMany).not.toHaveBeenCalled();
  });
});
