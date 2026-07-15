import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Order idempotency and concurrent creation recovery', () => {
  let prismaMock: {
    order: { findUnique: ReturnType<typeof vi.fn> };
    quotation: { findUnique: ReturnType<typeof vi.fn> };
  };
  let runIdempotentOperationMock: ReturnType<typeof vi.fn>;
  let ensureOrderContractDocumentMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      order: { findUnique: vi.fn() },
      quotation: { findUnique: vi.fn() },
    };
    runIdempotentOperationMock = vi.fn().mockRejectedValue({ code: 'P2002' });
    ensureOrderContractDocumentMock = vi.fn();

    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/idempotencyService.js', () => ({
      buildIdempotencyContext: vi.fn(() => ({ key: 'order-retry-key' })),
      runIdempotentOperation: runIdempotentOperationMock,
      applyIdempotencyHeaders: vi.fn(),
    }));
    vi.doMock('../lib/orderWorkflowService.js', () => ({
      createOrderFromQuotation: vi.fn(),
      mapOrderResponse: vi.fn((order: { id: string; orderNumber: string }) => ({
        id: order.id,
        orderNumber: order.orderNumber,
      })),
    }));
    vi.doMock('../lib/documentTemplateService.js', () => ({
      ensureOrderContractDocument: ensureOrderContractDocumentMock,
      ORDER_CONTRACT_DOCUMENT_TYPE: 'ORDER_CONTRACT',
    }));
    vi.doMock('../lib/outboxService.js', () => ({ enqueueBusinessEvent: vi.fn() }));
  });

  it('returns the committed concurrent order when its quotation unique constraint wins elsewhere', async () => {
    const customer = { id: 'c001', name: '中国国航' };
    const concurrentOrder = { id: 'o001', orderNumber: 'SO-20260716-001', customer };
    const quotation = { id: 'q001', customerId: customer.id, customer };
    prismaMock.order.findUnique.mockResolvedValue(concurrentOrder);
    prismaMock.quotation.findUnique.mockResolvedValue(quotation);
    ensureOrderContractDocumentMock.mockResolvedValue({ id: 'doc-001', title: '销售合同 - SO-20260716-001' });

    const ordersRouter = (await import('./orders.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'u001', role: 'manager' } });
      next();
    });
    app.use('/api/orders', ordersRouter);
    app.use(errorHandler);

    const response = await request(app)
      .post('/api/orders')
      .send({ quotationId: quotation.id, customerId: customer.id });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      id: concurrentOrder.id,
      orderNumber: concurrentOrder.orderNumber,
      contractDocumentId: 'doc-001',
      contractDocumentTitle: '销售合同 - SO-20260716-001',
    });
    expect(runIdempotentOperationMock).toHaveBeenCalledTimes(1);
    expect(ensureOrderContractDocumentMock).toHaveBeenCalledWith(expect.objectContaining({
      quotation,
      order: concurrentOrder,
      customer,
    }));
  });
});
