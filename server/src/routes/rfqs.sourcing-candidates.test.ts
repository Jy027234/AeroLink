import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('RFQ sourcing candidates', () => {
  let prismaMock: {
    rFQ: { findFirst: ReturnType<typeof vi.fn> };
    supplierQuote: { findMany: ReturnType<typeof vi.fn> };
    inventoryDetail: { findMany: ReturnType<typeof vi.fn> };
    supplier: { findMany: ReturnType<typeof vi.fn> };
  };
  let actorRole: string;

  beforeEach(() => {
    vi.resetModules();
    actorRole = 'sales';
    prismaMock = {
      rFQ: { findFirst: vi.fn() },
      supplierQuote: { findMany: vi.fn().mockResolvedValue([]) },
      inventoryDetail: { findMany: vi.fn().mockResolvedValue([]) },
      supplier: { findMany: vi.fn().mockResolvedValue([]) },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp() {
    const rfqsRouter = (await import('./rfqs.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'sales-1', role: actorRole, department: 'Sales' } });
      next();
    });
    app.use('/api/rfqs', rfqsRouter);
    app.use(errorHandler);
    return app;
  }

  it('returns separately keyed rows with only matching historical and profile evidence', async () => {
    const recordedAt = new Date('2026-09-01T12:00:00.000Z');
    prismaMock.rFQ.findFirst.mockResolvedValue({
      id: 'rfq-1',
      rfqNumber: 'RFQ-1001',
      createdBy: 'sales-1',
      lineItemsMode: true,
      partNumber: 'legacy-header-part',
      quantity: 1,
      uom: 'EA',
      conditionCode: 'NE',
      description: null,
      ataChapter: null,
      status: 'SOURCING',
      statusEnum: 'SOURCING',
      creator: { department: 'Sales' },
      lines: [
        { id: 'line-1', lineNo: 1, partNumber: 'PN-100', quantity: 2, uom: 'EA', conditionCode: 'NE', description: 'First line', ataChapter: 'ATA21', status: 'OPEN' },
        { id: 'line-2', lineNo: 2, partNumber: 'pn-100', quantity: 5, uom: 'EA', conditionCode: 'OH', description: 'Duplicate part, distinct demand', ataChapter: 'ATA34', status: 'OPEN' },
        { id: 'line-cancelled', lineNo: 3, partNumber: 'PN-100', quantity: 1, uom: 'EA', conditionCode: 'NE', description: null, ataChapter: 'ATA21', status: 'CANCELLED' },
        { id: 'line-3', lineNo: 4, partNumber: 'PN-404', quantity: 1, uom: 'EA', conditionCode: 'NE', description: null, ataChapter: null, status: 'OPEN' },
      ],
    });
    prismaMock.supplierQuote.findMany.mockResolvedValue([{
      id: 'quote-1',
      supplierId: 'supplier-quote',
      partNumber: 'PN-100',
      quantity: 2,
      status: 'accepted',
      statusEnum: 'accepted',
      createdAt: recordedAt,
    }]);
    prismaMock.inventoryDetail.findMany.mockResolvedValue([{
      id: 'inventory-detail-1',
      supplierId: 'supplier-inventory',
      createdAt: recordedAt,
      inventoryItem: { partNumber: 'PN-100' },
    }]);
    prismaMock.supplier.findMany
      .mockResolvedValueOnce([
        { id: 'supplier-quote', name: 'Quote Supplier', status: 'active', level: 'A', approvedPartCategories: null, updatedAt: recordedAt },
        { id: 'supplier-inventory', name: 'Inventory Supplier', status: 'active', level: 'B', approvedPartCategories: null, updatedAt: recordedAt },
      ])
      .mockResolvedValueOnce([
        { id: 'supplier-quote', name: 'Quote Supplier', status: 'active', level: 'A', approvedPartCategories: '["ATA21"]', updatedAt: recordedAt },
        { id: 'supplier-category', name: 'Category Supplier', status: 'active', level: 'A', approvedPartCategories: '["ATA34"]', updatedAt: recordedAt },
      ]);

    const app = await buildApp();
    const response = await request(app).get('/api/rfqs/rfq-1/sourcing-candidates');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        rfqId: 'rfq-1',
        evidenceSemantics: {
          historicalQuotesAreNotCurrentOffers: true,
          inventoryAttributionIsNotCurrentAvailability: true,
          currentPricingVerified: false,
          supplyCommitmentCreated: false,
        },
        lines: [
          {
            id: 'line-1', rfqLineId: 'line-1', lineNo: 1, partNumber: 'PN-100', sourcingStatus: 'EVIDENCE_FOUND',
            candidates: expect.arrayContaining([
              { supplier: { id: 'supplier-quote', name: 'Quote Supplier', status: 'active', level: 'A' }, currentSupplyPromiseVerified: false,
                evidence: expect.arrayContaining([
                  expect.objectContaining({ type: 'HISTORICAL_SUPPLIER_QUOTE', recordId: 'quote-1', currentOfferVerified: false }),
                  expect.objectContaining({ type: 'SUPPLIER_PROFILE_CATEGORY', matchedCategory: 'ATA21' }),
                ]) },
              { supplier: { id: 'supplier-inventory', name: 'Inventory Supplier', status: 'active', level: 'B' }, currentSupplyPromiseVerified: false,
                evidence: [expect.objectContaining({ type: 'INVENTORY_SUPPLIER_ATTRIBUTION', sourceField: 'InventoryDetail.supplierId', currentAvailabilityVerified: false })] },
            ]),
          },
          {
            id: 'line-2', rfqLineId: 'line-2', lineNo: 2, partNumber: 'pn-100', sourcingStatus: 'EVIDENCE_FOUND',
            candidates: expect.arrayContaining([
              expect.objectContaining({ supplier: expect.objectContaining({ id: 'supplier-category' }) }),
              expect.objectContaining({ supplier: expect.objectContaining({ id: 'supplier-inventory' }) }),
            ]),
          },
          { id: 'line-3', rfqLineId: 'line-3', lineNo: 4, partNumber: 'PN-404', sourcingStatus: 'INQUIRY_REQUIRED', candidates: [] },
        ],
      },
    });
    expect(response.body.data.lines.map((line: { id: string }) => line.id)).toEqual(['line-1', 'line-2', 'line-3']);
    expect(response.body.data.lines[0].candidates.map((candidate: { supplier: { id: string } }) => candidate.supplier.id))
      .not.toContain('supplier-category');
    expect(response.body.data.lines[1].candidates.find((candidate: { supplier: { id: string } }) => candidate.supplier.id === 'supplier-category').evidence)
      .toEqual([expect.objectContaining({ type: 'SUPPLIER_PROFILE_CATEGORY', matchedCategory: 'ATA34' })]);
    expect(response.body.data.lines[1].candidates.find((candidate: { supplier: { id: string } }) => candidate.supplier.id === 'supplier-quote').evidence)
      .not.toContainEqual(expect.objectContaining({ type: 'SUPPLIER_PROFILE_CATEGORY', matchedCategory: 'ATA21' }));
    expect(JSON.stringify(response.body)).not.toContain('unitPrice');

    const scopedRfqQuery = prismaMock.rFQ.findFirst.mock.calls[0]?.[0];
    expect(scopedRfqQuery.where).toEqual({ AND: [{ id: 'rfq-1' }, { createdBy: 'sales-1' }] });
    expect(prismaMock.supplierQuote.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.inventoryDetail.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.supplier.findMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.supplierQuote.findMany.mock.calls[0]?.[0].take).toBe(251);
    expect(prismaMock.inventoryDetail.findMany.mock.calls[0]?.[0].take).toBe(251);
  });

  it('returns inquiry-required rows when no supplier evidence exists', async () => {
    prismaMock.rFQ.findFirst.mockResolvedValue({
      id: 'rfq-empty', rfqNumber: 'RFQ-EMPTY', createdBy: 'sales-1', lineItemsMode: false,
      partNumber: 'PN-NONE', quantity: 1, uom: 'EA', conditionCode: 'NE', description: null, ataChapter: null,
      status: 'PENDING', statusEnum: 'PENDING', creator: { department: 'Sales' }, lines: [],
    });

    const app = await buildApp();
    const response = await request(app).get('/api/rfqs/rfq-empty/sourcing-candidates');

    expect(response.status).toBe(200);
    expect(response.body.data.lines).toEqual([
      expect.objectContaining({
        id: 'rfq-header:rfq-empty',
        rfqLineId: null,
        identitySource: 'RFQ_HEADER',
        partNumber: 'PN-NONE',
        sourcingStatus: 'INQUIRY_REQUIRED',
        candidates: [],
      }),
    ]);
    expect(prismaMock.supplierQuote.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.inventoryDetail.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.supplier.findMany).not.toHaveBeenCalled();
  });

  it('enforces read capability before reading supplier evidence', async () => {
    actorRole = 'viewer';
    const app = await buildApp();
    const response = await request(app).get('/api/rfqs/rfq-1/sourcing-candidates');

    expect(response.status).toBe(403);
    expect(prismaMock.rFQ.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.findMany).not.toHaveBeenCalled();
    expect(prismaMock.inventoryDetail.findMany).not.toHaveBeenCalled();
    expect(prismaMock.supplier.findMany).not.toHaveBeenCalled();
  });
});
