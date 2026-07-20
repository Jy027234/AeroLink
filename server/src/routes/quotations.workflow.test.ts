import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

function createCustomer() {
  return {
    id: 'c001',
    name: '中国国航',
    contactName: '王采购',
    email: 'procurement@airchina.com',
  };
}

function createQuotation(status: 'APPROVED' | 'SENT' | 'ACCEPTED' | 'WITHDRAWN' = 'APPROVED') {
  const customer = createCustomer();
  return {
    id: 'q001',
    quoteNumber: 'QT-20260512-001',
    rfqId: 'r001',
    customerId: customer.id,
    partNumber: 'BAC31GK0020',
    quantity: 2,
    unitPrice: 2100,
    totalPrice: 4200,
    costPrice: 1800,
    margin: 16.7,
    certificateFiles: 'FAA8130,EASAForm1',
    status,
    version: 1,
    validityDays: 14,
    saleType: 'Sale',
    incoterm: 'EXW',
    incotermLocation: null,
    leadTimeDays: 14,
    leadTimeBasis: null,
    moq: null,
    mpq: null,
    priceBasis: null,
    taxIncluded: true,
    taxRate: null,
    warrantyDays: 90,
    warrantyTerms: null,
    packagingRequirement: null,
    shippingMethod: null,
    commonNote: null,
    createdAt: new Date('2026-05-12T08:00:00.000Z'),
    createdBy: 'u001',
    approvedBy: 'u001',
    approvedAt: new Date('2026-05-12T09:00:00.000Z'),
    sentAt: status === 'SENT' ? new Date('2026-05-12T10:00:00.000Z') : null,
    acceptedAt: status === 'ACCEPTED' ? new Date('2026-05-12T11:00:00.000Z') : null,
    withdrawnAt: null,
    withdrawalReason: null,
    inventoryDetailId: null,
    reservedQuantity: 0,
    customerConfirmationNote: status === 'ACCEPTED' ? '客户口头确认' : null,
    expiryDate: new Date('2026-05-26T00:00:00.000Z'),
    customer,
  };
}

function createEmailAccount() {
  return {
    id: 'acct-001',
    email: 'sales@aerolink.com',
    displayName: 'AeroLink Sales',
    imapServer: 'imap.example.com',
    imapPort: '993',
    smtpServer: 'smtp.example.com',
    smtpPort: '465',
    authCode: 'encrypted-auth-code',
    accountType: 'IMAP_SMTP',
    isActive: true,
    isDefault: true,
    updatedAt: new Date('2026-05-12T08:00:00.000Z'),
  };
}

function createOrder() {
  const customer = createCustomer();
  return {
    id: 'o001',
    orderNumber: 'SO-20260512-001',
    soNumber: 'SO-20260512-001',
    poNumber: 'PO-001',
    quotationId: 'q001',
    customerId: customer.id,
    partNumber: 'BAC31GK0020',
    quantity: 2,
    totalAmount: 4200,
    status: 'SO_CREATED',
    version: 1,
    createdAt: new Date('2026-05-12T11:00:00.000Z'),
    deliveryDate: new Date('2026-06-01T00:00:00.000Z'),
    customer,
  };
}

function createPrismaMock() {
  const tx = {
    quotation: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn(), findUnique: vi.fn() },
    emailAccount: { findFirst: vi.fn() },
    outboundEmail: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    approval: { create: vi.fn() },
    rFQ: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    notification: { createMany: vi.fn() },
    documentTemplate: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    generatedDocument: { findFirst: vi.fn(), create: vi.fn() },
    inventoryDetail: { findUnique: vi.fn(), updateMany: vi.fn() },
    inventoryTransaction: { create: vi.fn() },
  };

  return {
    quotation: { findUnique: vi.fn() },
    emailAccount: { findFirst: vi.fn() },
    outboundEmail: { create: vi.fn(), update: vi.fn() },
    $transaction: vi.fn((input: unknown) => {
      if (typeof input === 'function') {
        return input(tx);
      }
      return Promise.resolve(input);
    }),
    __tx: tx,
  };
}

describe('Quotation workflow routes', () => {
  let app: express.Application;
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let enqueueBusinessEventMock: ReturnType<typeof vi.fn>;
  let enqueueOutboundEmailMock: ReturnType<typeof vi.fn>;
  let createOrderFromQuotationMock: ReturnType<typeof vi.fn>;
  let mapOrderResponseMock: ReturnType<typeof vi.fn>;
  let ensureOrderContractDocumentMock: ReturnType<typeof vi.fn>;
  let transitionQuotationStatusMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    vi.resetModules();

    prismaMock = createPrismaMock();
    enqueueBusinessEventMock = vi.fn().mockResolvedValue(undefined);
    enqueueOutboundEmailMock = vi.fn().mockResolvedValue(undefined);
    createOrderFromQuotationMock = vi.fn();
    mapOrderResponseMock = vi.fn((order: ReturnType<typeof createOrder>) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      soNumber: order.soNumber,
      customerId: order.customerId,
      status: order.status.toLowerCase(),
      totalAmount: order.totalAmount,
    }));
    ensureOrderContractDocumentMock = vi.fn();
    transitionQuotationStatusMock = vi.fn();

    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/outboxService.js', () => ({
      enqueueBusinessEvent: enqueueBusinessEventMock,
      enqueueOutboundEmail: enqueueOutboundEmailMock,
    }));
    vi.doMock('../modules/quotationOrder/index.js', async () => {
      const actual = await vi.importActual<typeof import('../modules/quotationOrder/index.js')>('../modules/quotationOrder/index.js');
      return {
        ...actual,
        orderRepository: prismaMock.__tx.order,
        quotationRepository: prismaMock.quotation,
        createOrderFromQuotation: createOrderFromQuotationMock,
        mapOrderResponse: mapOrderResponseMock,
      };
    });
    vi.doMock('../lib/documentTemplateService.js', () => ({
      ensureOrderContractDocument: ensureOrderContractDocumentMock,
      ORDER_CONTRACT_DOCUMENT_TYPE: 'ORDER_CONTRACT',
    }));
    vi.doMock('../lib/transactionStateService.js', () => ({
      transitionQuotationStatus: transitionQuotationStatusMock,
      transitionRfqStatus: vi.fn(),
      createInitialStatusHistory: vi.fn(),
    }));
    vi.doMock('../lib/pdfService.js', () => ({ generateQuotationPDF: vi.fn() }));

    const quotationsRouter = (await import('./quotations.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'u001', email: 'zhang@aerolink.com', name: '张经理', role: 'manager' } });
      next();
    });
    app.use('/api/quotations', quotationsRouter);
    app.use(errorHandler);
  });

  it('queues an approved quotation email instead of sending SMTP in the HTTP request', async () => {
    const quotation = createQuotation('APPROVED');
    prismaMock.__tx.quotation.findUnique.mockResolvedValue(quotation);
    prismaMock.__tx.emailAccount.findFirst.mockResolvedValue(createEmailAccount());
    prismaMock.__tx.outboundEmail.create.mockResolvedValue({ id: 'mail-pending-001' });

    const response = await request(app)
      .post('/api/quotations/q001/send')
      .send({ subject: 'Quotation QT-20260512-001', message: 'Please review the attached quotation.' });

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      id: quotation.id,
      status: 'approved',
      outboundEmailId: 'mail-pending-001',
      emailDeliveryStatus: 'queued',
    });
    expect(enqueueOutboundEmailMock).toHaveBeenCalledWith(
      prismaMock.__tx,
      expect.objectContaining({
        eventType: 'quotation.email.send',
        outboundEmailId: 'mail-pending-001',
        includeQuotationPdf: true,
      }),
    );
    expect(transitionQuotationStatusMock).not.toHaveBeenCalled();
  });

  it('keeps validation for sending an accepted quotation', async () => {
    prismaMock.__tx.quotation.findUnique.mockResolvedValue(createQuotation('ACCEPTED'));

    const response = await request(app)
      .post('/api/quotations/q001/send')
      .send({ subject: '重复发送', message: '不应发送' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(prismaMock.__tx.emailAccount.findFirst).not.toHaveBeenCalled();
  });

  it('dual-writes rounded Decimal monetary shadows when creating a quotation', async () => {
    const customer = createCustomer();
    prismaMock.__tx.rFQ.findUnique.mockResolvedValue(null);
    prismaMock.__tx.quotation.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...createQuotation('APPROVED'),
      ...data,
      id: 'q-decimal-001',
      customer,
      version: 1,
    }));

    const response = await request(app)
      .post('/api/quotations')
      .send({
        rfqId: 'r001',
        customerId: customer.id,
        partNumber: 'BAC31GK0020',
        quantity: 3,
        unitPrice: 12.34565,
        costPrice: 8.10005,
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: 'q-decimal-001',
      totalPrice: 37.0371,
      status: 'draft',
    });

    const createData = prismaMock.__tx.quotation.create.mock.calls[0][0].data;
    expect(createData.status).toBe('DRAFT');
    expect(createData.statusEnum).toBe('DRAFT');
    expect(createData.unitPrice).toBeCloseTo(12.3457, 10);
    expect(String(createData.unitPriceDecimal)).toBe('12.3457');
    expect(createData.totalPrice).toBeCloseTo(37.0371, 10);
    expect(String(createData.totalPriceDecimal)).toBe('37.0371');
    expect(createData.costPrice).toBeCloseTo(8.1001, 10);
    expect(String(createData.costPriceDecimal)).toBe('8.1001');
  });

  it('withdraws a sent quotation and queues its withdrawal notice transactionally', async () => {
    const quotation = {
      ...createQuotation('SENT'),
      outboundEmails: [{ id: 'mail-send-001', purpose: 'QUOTATION_SEND', status: 'SENT' }],
    };
    const withdrawnQuotation = {
      ...quotation,
      status: 'WITHDRAWN',
      version: 2,
      withdrawnAt: new Date('2026-05-12T10:15:00.000Z'),
      withdrawalReason: '价格调整，旧报价作废',
    };
    prismaMock.__tx.quotation.findUnique.mockResolvedValue(quotation);
    prismaMock.__tx.emailAccount.findFirst.mockResolvedValue(createEmailAccount());
    prismaMock.__tx.outboundEmail.create.mockResolvedValue({ id: 'mail-notice-001' });
    transitionQuotationStatusMock.mockResolvedValue(withdrawnQuotation);

    const response = await request(app)
      .post('/api/quotations/q001/withdraw')
      .send({ reason: '价格调整，旧报价作废', sendWithdrawalNotice: true });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: 'withdrawn',
      withdrawalNoticeId: 'mail-notice-001',
      withdrawalNoticeDeliveryStatus: 'queued',
    });
    expect(enqueueOutboundEmailMock).toHaveBeenCalledWith(
      prismaMock.__tx,
      expect.objectContaining({
        eventType: 'quotation.withdrawal.email',
        outboundEmailId: 'mail-notice-001',
      }),
    );
    expect(enqueueBusinessEventMock).toHaveBeenCalledWith(
      prismaMock.__tx,
      expect.objectContaining({ eventType: 'quotation.withdrawn', aggregateId: quotation.id }),
    );
  });

  it('releases a sent quotation reservation before withdrawing it', async () => {
    const quotation = {
      ...createQuotation('SENT'),
      inventoryDetailId: 'inv001',
      reservedQuantity: 2,
      outboundEmails: [{ id: 'mail-send-001', purpose: 'QUOTATION_SEND', status: 'SENT' }],
    };
    const withdrawnQuotation = {
      ...quotation,
      status: 'WITHDRAWN',
      version: 2,
      reservedQuantity: 0,
      withdrawnAt: new Date('2026-05-12T10:15:00.000Z'),
      withdrawalReason: '客户要求重新报价',
    };
    prismaMock.__tx.quotation.findUnique.mockResolvedValue(quotation);
    prismaMock.__tx.inventoryDetail.findUnique.mockResolvedValue({
      id: 'inv001',
      quantity: 4,
      status: 'RESERVED',
      inventoryItem: { partNumber: quotation.partNumber },
    });
    prismaMock.__tx.inventoryDetail.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.__tx.inventoryTransaction.create.mockResolvedValue({ id: 'reservation-release-001' });
    transitionQuotationStatusMock.mockResolvedValue(withdrawnQuotation);

    const response = await request(app)
      .post('/api/quotations/q001/withdraw')
      .send({ reason: '客户要求重新报价', sendWithdrawalNotice: false });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: 'withdrawn',
      reservationReleased: true,
      releasedInventoryDetailId: 'inv001',
    });
    expect(prismaMock.__tx.inventoryDetail.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv001', status: 'RESERVED' },
      data: { status: 'AVAILABLE' },
    });
    expect(prismaMock.__tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inventoryDetailId: 'inv001',
        quotationId: quotation.id,
        type: 'RESERVATION_RELEASE',
      }),
    });
    expect(transitionQuotationStatusMock).toHaveBeenCalledWith(
      prismaMock.__tx,
      expect.objectContaining({ data: expect.objectContaining({ reservedQuantity: 0 }) }),
    );
    expect(enqueueBusinessEventMock).toHaveBeenCalledWith(
      prismaMock.__tx,
      expect.objectContaining({
        eventType: 'inventory.reservation.released',
        aggregateId: 'inv001',
        data: expect.objectContaining({ quotationId: quotation.id, releasedQuantity: 2 }),
      }),
    );
    expect(enqueueBusinessEventMock).toHaveBeenCalledWith(
      prismaMock.__tx,
      expect.objectContaining({
        eventType: 'quotation.withdrawn',
        aggregateId: quotation.id,
        data: expect.objectContaining({ reservationReleased: true }),
      }),
    );
  });

  it('accepts a quotation, creates its contract, and writes both business events in one transaction', async () => {
    const quotation = createQuotation('APPROVED');
    const updatedQuotation = {
      ...quotation,
      status: 'ACCEPTED',
      version: 2,
      acceptedAt: new Date('2026-05-12T11:00:00.000Z'),
      customerConfirmationNote: '客户电话确认，允许生成合同',
    };
    const order = createOrder();
    prismaMock.__tx.quotation.findUnique.mockResolvedValue(quotation);
    prismaMock.__tx.order.findFirst.mockResolvedValue(null);
    transitionQuotationStatusMock.mockResolvedValue(updatedQuotation);
    createOrderFromQuotationMock.mockResolvedValue(order);
    ensureOrderContractDocumentMock.mockResolvedValue({ id: 'doc-001', title: '销售合同 - SO-20260512-001' });

    const response = await request(app)
      .post('/api/quotations/q001/accept')
      .send({ poNumber: 'PO-001', deliveryDate: '2026-06-01', templateId: 'tpl-001', confirmationNote: '客户电话确认，允许生成合同' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: 'accepted', contractDocumentId: 'doc-001' });
    expect(createOrderFromQuotationMock).toHaveBeenCalledWith(expect.objectContaining({
      tx: prismaMock.__tx,
      quotation: updatedQuotation,
      customer: quotation.customer,
    }));
    expect(ensureOrderContractDocumentMock).toHaveBeenCalledWith(expect.objectContaining({
      tx: prismaMock.__tx,
      order,
      templateId: 'tpl-001',
    }));
    expect(enqueueBusinessEventMock).toHaveBeenNthCalledWith(
      1,
      prismaMock.__tx,
      expect.objectContaining({ eventType: 'quotation.accepted', aggregateId: quotation.id }),
    );
    expect(enqueueBusinessEventMock).toHaveBeenNthCalledWith(
      2,
      prismaMock.__tx,
      expect.objectContaining({ eventType: 'order.created', aggregateId: order.id }),
    );
  });

  it('reuses an existing order on a repeated accepted quotation confirmation', async () => {
    const quotation = createQuotation('ACCEPTED');
    const existingOrder = createOrder();
    prismaMock.__tx.quotation.findUnique.mockResolvedValue(quotation);
    prismaMock.__tx.order.findFirst.mockResolvedValue(existingOrder);
    ensureOrderContractDocumentMock.mockResolvedValue({ id: 'doc-001', title: '销售合同 - SO-20260512-001' });

    const response = await request(app)
      .post('/api/quotations/q001/accept')
      .send({ confirmationNote: '沿用既有确认结果' });

    expect(response.status).toBe(200);
    expect(response.body.data.order.orderNumber).toBe(existingOrder.orderNumber);
    expect(createOrderFromQuotationMock).not.toHaveBeenCalled();
    expect(enqueueBusinessEventMock).not.toHaveBeenCalled();
  });
});
