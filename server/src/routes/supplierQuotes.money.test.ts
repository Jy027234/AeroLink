import { Prisma } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function createSupplierQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'supplier-quote-001',
    supplierId: 'supplier-001',
    partNumber: 'BAC31GK0020',
    description: null,
    quantity: 3,
    unitPrice: 12.3457,
    unitPriceDecimal: new Prisma.Decimal('12.3457'),
    totalPrice: 37.0371,
    totalPriceDecimal: new Prisma.Decimal('37.0371'),
    currency: 'USD',
    currencyReviewStatus: 'VERIFIED',
    leadTimeDays: 7,
    validUntil: null,
    notes: null,
    status: 'pending',
    isWinner: false,
    ...overrides,
  };
}

describe('supplier quote monetary shadows', () => {
  let app: express.Application;
  let prismaMock: {
    $transaction: ReturnType<typeof vi.fn>;
    rFQ: { findUnique: ReturnType<typeof vi.fn> };
    rfqLine: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    inquiry: { findUnique: ReturnType<typeof vi.fn> };
    inquiryItem: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    quotation: { findFirst: ReturnType<typeof vi.fn> };
    quotationLine: { findFirst: ReturnType<typeof vi.fn> };
    supplierQuote: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.resetModules();
    prismaMock = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
      rFQ: { findUnique: vi.fn() },
      rfqLine: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      inquiry: { findUnique: vi.fn() },
      inquiryItem: { findUnique: vi.fn(), findMany: vi.fn() },
      quotation: { findFirst: vi.fn() },
      quotationLine: { findFirst: vi.fn() },
      supplierQuote: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));

    const supplierQuotesRouter = (await import('./supplierQuotes.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'admin-1', role: 'admin' } });
      next();
    });
    app.use('/api/supplier-quotes', supplierQuotesRouter);
    app.use(errorHandler);
  });

  it('dual-writes a rounded Decimal total on create and keeps the API response compatible', async () => {
    prismaMock.supplierQuote.create.mockResolvedValue(createSupplierQuote());

    const response = await request(app)
      .post('/api/supplier-quotes')
      .send({
        supplierId: 'supplier-001',
        partNumber: 'BAC31GK0020',
        quantity: 3,
        unitPrice: 12.34565,
        currency: 'USD',
        leadTimeDays: 7,
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      unitPrice: 12.3457,
      totalPrice: 37.0371,
    });
    expect(response.body.data).not.toHaveProperty('unitPriceDecimal');
    expect(response.body.data).not.toHaveProperty('totalPriceDecimal');

    const createData = prismaMock.supplierQuote.create.mock.calls[0][0].data;
    expect(createData.status).toBe('pending');
    expect(createData.statusEnum).toBe('pending');
    expect(createData.currency).toBe('USD');
    expect(createData.currencyReviewStatus).toBe('VERIFIED');
    expect(createData.unitPrice).toBeCloseTo(12.3457, 10);
    expect(String(createData.unitPriceDecimal)).toBe('12.3457');
    expect(createData.totalPrice).toBeCloseTo(37.0371, 10);
    expect(String(createData.totalPriceDecimal)).toBe('37.0371');
  });

  it('rejects supplier quote part or quantity outside the linked RFQ scope', async () => {
    prismaMock.rFQ.findUnique.mockResolvedValue({
      id: 'rfq-001', partNumber: 'PN-RFQ', quantity: 2, alternatePartNumbers: JSON.stringify(['PN-ALT']),
    });

    const response = await request(app)
      .post('/api/supplier-quotes')
      .send({
        rfqId: 'rfq-001',
        supplierId: 'supplier-001',
        partNumber: 'PN-OTHER',
        quantity: 1,
        unitPrice: 10,
        currency: 'USD',
        leadTimeDays: 7,
      });

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/件号/);
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('binds a unique RFQ line and its unique inquiry item by immutable IDs', async () => {
    prismaMock.rFQ.findUnique.mockResolvedValue({
      id: 'rfq-001', partNumber: 'PN-RFQ', quantity: 4, alternatePartNumbers: null,
    });
    prismaMock.rfqLine.findMany.mockResolvedValue([{
      id: 'rfq-line-001', rfqId: 'rfq-001', partNumber: 'PN-RFQ', quantity: 4, alternatePartNumbers: null,
    }]);
    prismaMock.inquiry.findUnique.mockResolvedValue({
      id: 'inquiry-001', rfqId: 'rfq-001', supplierId: 'supplier-001',
    });
    prismaMock.inquiryItem.findMany.mockResolvedValue([{
      id: 'inquiry-item-001', inquiryId: 'inquiry-001', rfqLineId: 'rfq-line-001', partNumber: 'PN-RFQ', quantity: 4,
    }]);
    prismaMock.supplierQuote.create.mockResolvedValue(createSupplierQuote({
      rfqId: 'rfq-001', rfqLineId: 'rfq-line-001', inquiryId: 'inquiry-001', inquiryItemId: 'inquiry-item-001',
    }));

    const response = await request(app)
      .post('/api/supplier-quotes')
      .send({
        rfqId: 'rfq-001',
        inquiryId: 'inquiry-001',
        supplierId: 'supplier-001',
        partNumber: 'PN-RFQ',
        quantity: 3,
        unitPrice: 10,
        currency: 'USD',
        leadTimeDays: 7,
      });

    expect(response.status).toBe(201);
    expect(prismaMock.supplierQuote.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        rfqId: 'rfq-001',
        rfqLineId: 'rfq-line-001',
        inquiryId: 'inquiry-001',
        inquiryItemId: 'inquiry-item-001',
      }),
    }));
  });

  it('rejects an RFQ with multiple lines when no line identity is supplied', async () => {
    prismaMock.rFQ.findUnique.mockResolvedValue({
      id: 'rfq-001', partNumber: 'PN-RFQ', quantity: 4, alternatePartNumbers: null,
    });
    prismaMock.rfqLine.findMany.mockResolvedValue([
      { id: 'rfq-line-001', rfqId: 'rfq-001', partNumber: 'PN-RFQ', quantity: 2, alternatePartNumbers: null },
      { id: 'rfq-line-002', rfqId: 'rfq-001', partNumber: 'PN-OTHER', quantity: 2, alternatePartNumbers: null },
    ]);

    const response = await request(app)
      .post('/api/supplier-quotes')
      .send({
        rfqId: 'rfq-001',
        supplierId: 'supplier-001',
        partNumber: 'PN-RFQ',
        quantity: 1,
        unitPrice: 10,
        currency: 'USD',
        leadTimeDays: 7,
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('LINE_ID_REQUIRED');
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('keeps referenced supplier quote source identity immutable on update', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(createSupplierQuote({
      rfqId: 'rfq-001', rfqLineId: 'rfq-line-001', inquiryId: 'inquiry-001', inquiryItemId: 'inquiry-item-001',
    }));
    prismaMock.quotation.findFirst.mockResolvedValue({ id: 'quotation-001' });
    prismaMock.quotationLine.findFirst.mockResolvedValue(null);

    const response = await request(app)
      .put('/api/supplier-quotes/supplier-quote-001')
      .send({ partNumber: 'PN-CHANGED' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(prismaMock.supplierQuote.update).not.toHaveBeenCalled();
  });

  it('recalculates both monetary representations when the unit price changes', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(createSupplierQuote());
    prismaMock.supplierQuote.update.mockResolvedValue(createSupplierQuote({
      unitPrice: 10.1112,
      unitPriceDecimal: new Prisma.Decimal('10.1112'),
      totalPrice: 30.3336,
      totalPriceDecimal: new Prisma.Decimal('30.3336'),
      status: 'accepted',
      statusEnum: 'accepted',
    }));

    const response = await request(app)
      .put('/api/supplier-quotes/supplier-quote-001')
      .send({ unitPrice: 10.11115, currency: 'USD', status: 'accepted' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      unitPrice: 10.1112,
      totalPrice: 30.3336,
      status: 'accepted',
    });

    const updateData = prismaMock.supplierQuote.update.mock.calls[0][0].data;
    expect(updateData.status).toBe('accepted');
    expect(updateData.statusEnum).toBe('accepted');
    expect(updateData.unitPrice).toBeCloseTo(10.1112, 10);
    expect(String(updateData.unitPriceDecimal)).toBe('10.1112');
    expect(updateData.totalPrice).toBeCloseTo(30.3336, 10);
    expect(String(updateData.totalPriceDecimal)).toBe('30.3336');
  });

  it('dual-writes the accepted enum when selecting a winner', async () => {
    prismaMock.supplierQuote.findUnique.mockResolvedValue(createSupplierQuote({
      rfqId: 'rfq-001', rfqLineId: null, inquiryId: null, inquiryItemId: null,
    }));
    prismaMock.rFQ.findUnique.mockResolvedValue({
      id: 'rfq-001', partNumber: 'BAC31GK0020', quantity: 3, alternatePartNumbers: null,
    });
    prismaMock.supplierQuote.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.supplierQuote.update.mockResolvedValue(createSupplierQuote({
      rfqId: 'rfq-001', rfqLineId: null, inquiryId: null, inquiryItemId: null,
      status: 'accepted',
      statusEnum: 'accepted',
      isWinner: true,
    }));

    const response = await request(app)
      .post('/api/supplier-quotes/supplier-quote-001/select-winner');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: 'accepted', isWinner: true });
    expect(response.body.data).not.toHaveProperty('statusEnum');
    expect(prismaMock.supplierQuote.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { isWinner: true, status: 'accepted', statusEnum: 'accepted' },
    }));
  });
});
