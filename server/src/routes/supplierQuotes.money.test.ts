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
    expect(createData.unitPrice).toBeCloseTo(12.3457, 10);
    expect(String(createData.unitPriceDecimal)).toBe('12.3457');
    expect(createData.totalPrice).toBeCloseTo(37.0371, 10);
    expect(String(createData.totalPriceDecimal)).toBe('37.0371');
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
      .send({ unitPrice: 10.11115, status: 'accepted' });

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
    prismaMock.supplierQuote.findUnique.mockResolvedValue(createSupplierQuote());
    prismaMock.supplierQuote.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.supplierQuote.update.mockResolvedValue(createSupplierQuote({
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
