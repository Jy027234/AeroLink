import { Prisma } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function createRelatedQuotation() {
  return {
    id: 'quotation-001',
    unitPrice: 12.3456,
    unitPriceDecimal: new Prisma.Decimal('12.3457'),
    totalPrice: 37.037,
    totalPriceDecimal: new Prisma.Decimal('37.0371'),
    costPrice: 8.1,
    costPriceDecimal: new Prisma.Decimal('8.1001'),
  };
}

function createOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-001',
    orderNumber: 'SO-20260716-001',
    soNumber: 'SO-20260716-001',
    poNumber: null,
    quotationId: 'quotation-001',
    customerId: 'customer-001',
    partNumber: 'BAC31GK0020',
    quantity: 3,
    totalAmount: 37.037,
    totalAmountDecimal: new Prisma.Decimal('37.0371'),
    status: 'SO_CREATED',
    version: 1,
    importDuty: 12.3456,
    importDutyDecimal: new Prisma.Decimal('12.3457'),
    vatAmount: 1.2,
    vatAmountDecimal: new Prisma.Decimal('1.2000'),
    totalLandCost: 50.0000,
    totalLandCostDecimal: new Prisma.Decimal('50.0001'),
    exchangeCoreCharge: 0,
    exchangeCoreChargeDecimal: new Prisma.Decimal('0.0001'),
    customer: { id: 'customer-001', name: '中国国航' },
    quotation: createRelatedQuotation(),
    tracking: null,
    generatedDocuments: [],
    ...overrides,
  };
}

describe('order monetary shadows', () => {
  let app: express.Application;
  let orderUpdateMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    orderUpdateMock = vi.fn().mockResolvedValue(createOrder());
    const tx = {
      order: {
        findUnique: vi.fn().mockResolvedValue({ id: 'order-001' }),
        update: orderUpdateMock,
      },
    };

    vi.doMock('../lib/prisma.js', () => ({ default: { order: { findUnique: vi.fn() } } }));
    vi.doMock('../lib/idempotencyService.js', () => ({
      buildIdempotencyContext: vi.fn(() => ({ key: undefined })),
      applyIdempotencyHeaders: vi.fn(),
      runIdempotentOperation: vi.fn(async (_context: unknown, operation: (client: typeof tx) => Promise<{
        payload: unknown;
        statusCode?: number;
      }>) => {
        const result = await operation(tx);
        return { payload: result.payload, statusCode: result.statusCode ?? 200, replayed: false };
      }),
    }));
    vi.doMock('../lib/orderWorkflowService.js', () => ({
      createOrderFromQuotation: vi.fn(),
      mapOrderResponse: vi.fn(),
    }));
    vi.doMock('../lib/documentTemplateService.js', () => ({
      ensureOrderContractDocument: vi.fn(),
      ORDER_CONTRACT_DOCUMENT_TYPE: 'ORDER_CONTRACT',
    }));
    vi.doMock('../lib/outboxService.js', () => ({ enqueueBusinessEvent: vi.fn() }));
    vi.doMock('../lib/transactionStateService.js', () => ({
      transitionOrderStatus: vi.fn(),
      transitionQuotationStatus: vi.fn(),
    }));
    vi.doMock('../lib/pdfService.js', () => ({ generateOrderPDF: vi.fn() }));

    const ordersRouter = (await import('./orders.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'user-001', role: 'manager' } });
      next();
    });
    app.use('/api/orders', ordersRouter);
    app.use(errorHandler);
  });

  it('dual-writes rounded financial charges and hides all Decimal shadow fields from the detail payload', async () => {
    const response = await request(app)
      .patch('/api/orders/order-001')
      .send({
        importDuty: 12.34565,
        vatAmount: 1.2,
        totalLandCost: 50.00005,
        exchangeCoreCharge: 0.00005,
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      totalAmount: 37.0371,
      importDuty: 12.3457,
      vatAmount: 1.2,
      totalLandCost: 50.0001,
      exchangeCoreCharge: 0.0001,
      quotation: {
        unitPrice: 12.3457,
        totalPrice: 37.0371,
        costPrice: 8.1001,
      },
    });
    expect(response.body.data).not.toHaveProperty('totalAmountDecimal');
    expect(response.body.data).not.toHaveProperty('importDutyDecimal');
    expect(response.body.data.quotation).not.toHaveProperty('unitPriceDecimal');
    expect(response.body.data.quotation).not.toHaveProperty('totalPriceDecimal');

    const updateData = orderUpdateMock.mock.calls[0][0].data;
    expect(updateData.importDuty).toBeCloseTo(12.3457, 10);
    expect(String(updateData.importDutyDecimal)).toBe('12.3457');
    expect(updateData.vatAmount).toBeCloseTo(1.2, 10);
    expect(String(updateData.vatAmountDecimal)).toBe('1.2');
    expect(updateData.totalLandCost).toBeCloseTo(50.0001, 10);
    expect(String(updateData.totalLandCostDecimal)).toBe('50.0001');
    expect(updateData.exchangeCoreCharge).toBeCloseTo(0.0001, 10);
    expect(String(updateData.exchangeCoreChargeDecimal)).toBe('0.0001');
  });
});
