import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

function createCustomer() {
  return {
    id: 'c001',
    name: '中国国航',
    contactName: '王采购',
    email: 'procurement@airchina.com',
    phone: '+86-10-1234-5678',
    address: '北京市顺义区首都国际机场',
  };
}

function createQuotation(status: 'APPROVED' | 'SENT' | 'ACCEPTED' | 'WITHDRAWN' = 'APPROVED') {
  const customer = createCustomer();
  const sentAt = status === 'SENT' ? new Date('2026-05-12T10:00:00.000Z') : null;
  const acceptedAt = status === 'ACCEPTED' ? new Date('2026-05-12T11:00:00.000Z') : null;

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
    template: 'STANDARD',
    status,
    validityDays: 14,
    saleType: 'Sale',
    incoterm: 'EXW',
    leadTimeDays: 14,
    taxIncluded: true,
    warrantyDays: 90,
    createdAt: new Date('2026-05-12T08:00:00.000Z'),
    createdBy: 'u001',
    approvedBy: 'u001',
    approvedAt: new Date('2026-05-12T09:00:00.000Z'),
    sentAt,
    acceptedAt,
    withdrawnAt: null,
    withdrawalReason: null,
    customerConfirmationNote: acceptedAt ? '客户口头确认' : null,
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

function createSentEmailRecord() {
  return {
    id: 'mail-send-001',
    purpose: 'QUOTATION_SEND',
    quotationId: 'q001',
    customerId: 'c001',
    accountId: 'acct-001',
    toEmail: 'procurement@airchina.com',
    subject: 'Quotation QT-20260512-001',
    textBody: 'quotation body',
    htmlBody: '<p>quotation body</p>',
    status: 'SENT',
    sentAt: new Date('2026-05-12T10:00:00.000Z'),
    createdAt: new Date('2026-05-12T09:59:00.000Z'),
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
    createdAt: new Date('2026-05-12T11:00:00.000Z'),
    deliveryDate: new Date('2026-06-01T00:00:00.000Z'),
    trackingNumber: null,
    carrier: null,
    customer,
  };
}

function createGeneratedDocument() {
  return {
    id: 'doc-001',
    title: '销售合同 - SO-20260512-001',
  };
}

function createPrismaMock() {
  const tx = {
    quotation: {
      update: vi.fn(),
    },
    order: {
      findFirst: vi.fn(),
    },
  };

  return {
    quotation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    order: {
      findUnique: vi.fn(),
    },
    emailAccount: {
      findFirst: vi.fn(),
    },
    outboundEmail: {
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn((input: unknown) => {
      if (typeof input === 'function') {
        return input(tx);
      }

      if (Array.isArray(input)) {
        return Promise.all(input);
      }

      return Promise.resolve(input);
    }),
    __tx: tx,
  };
}

describe('Quotation workflow routes', () => {
  let app: express.Application;
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let sendEmailMock: ReturnType<typeof vi.fn>;
  let generateQuotationPDFMock: ReturnType<typeof vi.fn>;
  let createOrderFromQuotationMock: ReturnType<typeof vi.fn>;
  let mapOrderResponseMock: ReturnType<typeof vi.fn>;
  let ensureOrderContractDocumentMock: ReturnType<typeof vi.fn>;
  let emitWebhookEventMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

    vi.resetModules();

    prismaMock = createPrismaMock();
    sendEmailMock = vi.fn();
    generateQuotationPDFMock = vi.fn();
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
    emitWebhookEventMock = vi.fn();

    vi.doMock('../lib/prisma.js', () => ({
      default: prismaMock,
    }));
    vi.doMock('../lib/crypto.js', () => ({
      decrypt: vi.fn(() => 'decoded-auth-code'),
    }));
    vi.doMock('../lib/emailService.js', () => ({
      sendEmail: sendEmailMock,
    }));
    vi.doMock('../lib/pdfService.js', () => ({
      generateQuotationPDF: generateQuotationPDFMock,
    }));
    vi.doMock('../lib/orderWorkflowService.js', () => ({
      createOrderFromQuotation: createOrderFromQuotationMock,
      mapOrderResponse: mapOrderResponseMock,
    }));
    vi.doMock('../lib/documentTemplateService.js', () => ({
      ensureOrderContractDocument: ensureOrderContractDocumentMock,
      ORDER_CONTRACT_DOCUMENT_TYPE: 'ORDER_CONTRACT',
    }));
    vi.doMock('../lib/webhookService.js', () => ({
      emitWebhookEvent: emitWebhookEventMock,
    }));

    const quotationsRouter = (await import('./quotations.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, {
        user: {
          id: 'u001',
          email: 'zhang@aerolink.com',
          name: '张经理',
          role: 'manager',
        },
      });
      next();
    });
    app.use('/api/quotations', quotationsRouter);
    app.use(errorHandler);
  });

  it('should send an approved quotation with PDF attachment and audit record', async () => {
    const quotation = createQuotation('APPROVED');
    const account = createEmailAccount();
    const pendingEmail = {
      id: 'mail-pending-001',
      toEmail: quotation.customer.email,
    };
    const sentAt = new Date('2026-05-12T10:05:00.000Z');

    prismaMock.quotation.findUnique.mockResolvedValue(quotation);
    prismaMock.emailAccount.findFirst.mockResolvedValue(account);
    prismaMock.outboundEmail.create.mockResolvedValue(pendingEmail);
    prismaMock.quotation.update.mockResolvedValue({
      ...quotation,
      status: 'SENT',
      sentAt,
    });
    prismaMock.outboundEmail.update.mockResolvedValue({
      ...pendingEmail,
      id: 'mail-pending-001',
      status: 'SENT',
      sentAt,
      providerMessageId: 'smtp-001',
      toEmail: quotation.customer.email,
    });
    generateQuotationPDFMock.mockResolvedValue(Buffer.from('quotation-pdf'));
    sendEmailMock.mockResolvedValue({ messageId: 'smtp-001' });

    const response = await request(app)
      .post('/api/quotations/q001/send')
      .send({
        subject: 'Quotation QT-20260512-001',
        message: 'Please review the attached quotation.',
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('sent');
    expect(response.body.data.outboundEmailId).toBe('mail-pending-001');
    expect(generateQuotationPDFMock).toHaveBeenCalledOnce();
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acct-001',
        authCode: 'decoded-auth-code',
      }),
      expect.objectContaining({
        to: quotation.customer.email,
        attachments: [
          expect.objectContaining({
            filename: `${quotation.quoteNumber}.pdf`,
            contentType: 'application/pdf',
          }),
        ],
      })
    );
    expect(emitWebhookEventMock).toHaveBeenCalledWith(
      'quotation.sent',
      expect.objectContaining({
        quotationId: quotation.id,
        outboundEmailId: 'mail-pending-001',
      })
    );
  });

  it('should reject submitting a quotation from a terminal state', async () => {
    const quotation = createQuotation('ACCEPTED');
    prismaMock.quotation.findUnique.mockResolvedValue(quotation);

    const response = await request(app)
      .post('/api/quotations/q001/submit')
      .send();

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(prismaMock.quotation.update).not.toHaveBeenCalled();
    expect(emitWebhookEventMock).not.toHaveBeenCalled();
  });

  it('should reject approving a quotation that is not pending approval', async () => {
    const quotation = {
      ...createQuotation('SENT'),
      rfq: null,
    };
    prismaMock.quotation.findUnique.mockResolvedValue(quotation);

    const response = await request(app)
      .post('/api/quotations/q001/approve')
      .send({ action: 'approve' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(prismaMock.quotation.update).not.toHaveBeenCalled();
    expect(prismaMock.__tx.quotation.update).not.toHaveBeenCalled();
    expect(emitWebhookEventMock).not.toHaveBeenCalled();
  });

  it('should reject sending an accepted quotation', async () => {
    const quotation = createQuotation('ACCEPTED');
    prismaMock.quotation.findUnique.mockResolvedValue(quotation);

    const response = await request(app)
      .post('/api/quotations/q001/send')
      .send({ subject: '重复发送', message: '不应发送' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(prismaMock.emailAccount.findFirst).not.toHaveBeenCalled();
  });

  it('should reject withdrawing a quotation that was not sent', async () => {
    const quotation = createQuotation('APPROVED');
    prismaMock.quotation.findUnique.mockResolvedValue(quotation);

    const response = await request(app)
      .post('/api/quotations/q001/withdraw')
      .send({ reason: '不应撤回' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(prismaMock.outboundEmail.create).not.toHaveBeenCalled();
  });

  it('should reject accepting a draft quotation', async () => {
    const quotation = {
      ...createQuotation('APPROVED'),
      status: 'DRAFT',
    };
    prismaMock.quotation.findUnique.mockResolvedValue(quotation);

    const response = await request(app)
      .post('/api/quotations/q001/accept')
      .send({ confirmationNote: '不应接受' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(prismaMock.__tx.quotation.update).not.toHaveBeenCalled();
    expect(createOrderFromQuotationMock).not.toHaveBeenCalled();
  });

  it('should withdraw a sent quotation and optionally send a withdrawal notice', async () => {
    const quotation = {
      ...createQuotation('SENT'),
      outboundEmails: [createSentEmailRecord()],
    };
    const notice = {
      id: 'mail-notice-001',
      toEmail: quotation.customer.email,
    };
    const withdrawnAt = new Date('2026-05-12T10:15:00.000Z');

    prismaMock.quotation.findUnique.mockResolvedValue(quotation);
    prismaMock.emailAccount.findFirst.mockResolvedValue(createEmailAccount());
    prismaMock.quotation.update.mockResolvedValue({
      ...quotation,
      status: 'WITHDRAWN',
      withdrawnAt,
      withdrawalReason: '价格调整，旧报价作废',
    });
    prismaMock.outboundEmail.update
      .mockResolvedValueOnce({
        ...quotation.outboundEmails[0],
        status: 'WITHDRAWN',
        withdrawnAt,
        withdrawalReason: '价格调整，旧报价作废',
      })
      .mockResolvedValueOnce({
        ...notice,
        status: 'SENT',
        sentAt: withdrawnAt,
        providerMessageId: 'smtp-withdraw-001',
      });
    prismaMock.outboundEmail.create.mockResolvedValue(notice);
    sendEmailMock.mockResolvedValue({ messageId: 'smtp-withdraw-001' });

    const response = await request(app)
      .post('/api/quotations/q001/withdraw')
      .send({
        reason: '价格调整，旧报价作废',
        sendWithdrawalNotice: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('withdrawn');
    expect(response.body.data.withdrawalNoticeId).toBe('mail-notice-001');
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acct-001' }),
      expect.objectContaining({
        to: quotation.customer.email,
        subject: `Withdrawal Notice: ${quotation.quoteNumber}`,
      })
    );
    expect(emitWebhookEventMock).toHaveBeenCalledWith(
      'quotation.withdrawn',
      expect.objectContaining({
        quotationId: quotation.id,
        withdrawalNoticeId: 'mail-notice-001',
      })
    );
  });

  it('should accept a quotation, create an order, and generate a contract document', async () => {
    const quotation = createQuotation('APPROVED');
    const updatedQuotation = {
      ...quotation,
      status: 'ACCEPTED',
      acceptedAt: new Date('2026-05-12T11:00:00.000Z'),
      customerConfirmationNote: '客户电话确认，允许生成合同',
    };
    const order = createOrder();
    const generatedDocument = createGeneratedDocument();

    prismaMock.quotation.findUnique.mockResolvedValue(quotation);
    prismaMock.__tx.quotation.update.mockResolvedValue(updatedQuotation);
    prismaMock.__tx.order.findFirst.mockResolvedValue(null);
    createOrderFromQuotationMock.mockResolvedValue(order);
    ensureOrderContractDocumentMock.mockResolvedValue(generatedDocument);
    emitWebhookEventMock.mockResolvedValue(undefined);

    const response = await request(app)
      .post('/api/quotations/q001/accept')
      .send({
        poNumber: 'PO-001',
        deliveryDate: '2026-06-01',
        templateId: 'tpl-001',
        confirmationNote: '客户电话确认，允许生成合同',
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('accepted');
    expect(response.body.data.contractDocumentId).toBe('doc-001');
    expect(response.body.data.order.orderNumber).toBe('SO-20260512-001');
    expect(createOrderFromQuotationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: prismaMock.__tx,
        quotation: updatedQuotation,
        customer: quotation.customer,
        poNumber: 'PO-001',
        deliveryDate: '2026-06-01',
      })
    );
    expect(ensureOrderContractDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        quotation: updatedQuotation,
        customer: quotation.customer,
        order,
        templateId: 'tpl-001',
        generatedById: 'u001',
      })
    );
    expect(emitWebhookEventMock).toHaveBeenNthCalledWith(
      1,
      'quotation.accepted',
      expect.objectContaining({
        quotationId: quotation.id,
        orderId: order.id,
        contractDocumentId: generatedDocument.id,
        autoCreatedOrder: true,
      })
    );
    expect(emitWebhookEventMock).toHaveBeenNthCalledWith(
      2,
      'order.created',
      expect.objectContaining({
        orderId: order.id,
        orderNumber: order.orderNumber,
      })
    );
  });

  it('should reuse an existing order when an accepted quotation is confirmed again', async () => {
    const quotation = createQuotation('ACCEPTED');
    const existingOrder = createOrder();
    const generatedDocument = createGeneratedDocument();

    prismaMock.quotation.findUnique.mockResolvedValue(quotation);
    prismaMock.__tx.quotation.update.mockResolvedValue(quotation);
    prismaMock.__tx.order.findFirst.mockResolvedValue(existingOrder);
    ensureOrderContractDocumentMock.mockResolvedValue(generatedDocument);

    const response = await request(app)
      .post('/api/quotations/q001/accept')
      .send({
        confirmationNote: '沿用既有确认结果',
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.order.orderNumber).toBe(existingOrder.orderNumber);
    expect(createOrderFromQuotationMock).not.toHaveBeenCalled();
    expect(emitWebhookEventMock).not.toHaveBeenCalled();
  });

  it('recovers a concurrent unique-order conflict without duplicating acceptance events', async () => {
    const quotation = createQuotation('APPROVED');
    const updatedQuotation = {
      ...quotation,
      status: 'ACCEPTED',
      acceptedAt: new Date('2026-05-12T11:00:00.000Z'),
    };
    const existingOrder = createOrder();
    const generatedDocument = createGeneratedDocument();

    prismaMock.quotation.findUnique
      .mockResolvedValueOnce(quotation)
      .mockResolvedValueOnce(updatedQuotation);
    prismaMock.$transaction.mockRejectedValueOnce({ code: 'P2002' });
    prismaMock.order.findUnique.mockResolvedValue(existingOrder);
    ensureOrderContractDocumentMock.mockResolvedValue(generatedDocument);

    const response = await request(app)
      .post('/api/quotations/q001/accept')
      .send({ confirmationNote: '并发重试' });

    expect(response.status).toBe(200);
    expect(response.body.data.order.orderNumber).toBe(existingOrder.orderNumber);
    expect(createOrderFromQuotationMock).not.toHaveBeenCalled();
    expect(emitWebhookEventMock).not.toHaveBeenCalled();
  });
});
