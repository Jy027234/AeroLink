import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptQuotationAggregate,
  assertQuotationTransition,
  createQuotationAggregate,
  createOrderAggregate,
  sendQuotationAggregate,
  toUiQuotationStatus,
  submitQuotationAggregate,
  approveQuotationAggregate,
  transitionOrderAggregate,
  updateOrderAggregate,
  withdrawQuotationAggregate,
} from './service.js';
import { buildQuotationApprovalSnapshot } from '../../lib/quotationApprovalPolicy.js';

vi.mock('../../lib/outboxService.js', () => ({
  enqueueBusinessEvent: vi.fn().mockResolvedValue(undefined),
  enqueueOutboundEmail: vi.fn().mockResolvedValue(undefined),
}));

function addLineDelegates<T extends Record<string, unknown>>(tx: T) {
  if (!(tx as Record<string, unknown>).order) {
    Object.assign(tx, { order: { findUnique: vi.fn().mockResolvedValue(null) } });
  }
  Object.assign(tx, {
    rfqLine: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data })),
    },
    supplierQuote: { findUnique: vi.fn().mockResolvedValue(null) },
    quotationLine: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data })),
    },
    orderLine: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data })),
    },
  });
  return tx;
}

function makeSnapshotQuotation(overrides: Record<string, unknown> = {}) {
  const customer = { id: 'customer-snapshot', name: 'Air China', contactName: 'Buyer', email: 'buyer@example.com' };
  const quotation = {
    id: 'quotation-snapshot',
    quoteNumber: 'QT-SNAPSHOT',
    partNumber: 'PN-SNAPSHOT',
    quantity: 1,
    unitPrice: 100,
    unitPriceDecimal: null,
    totalPrice: 100,
    totalPriceDecimal: null,
     costPrice: 50,
     costPriceDecimal: null,
     costSourceType: 'MANUAL',
     costSourceId: null,
     costSourceReason: '测试成本依据',
     costSourceSnapshotJson: JSON.stringify({ type: 'MANUAL', id: null, currency: 'USD', costPrice: 50, partNumber: 'PN-SNAPSHOT', quantity: 1, status: null, supplierId: null, capturedAt: '2027-05-12T09:00:00.000Z', reason: '测试成本依据' }),
    margin: 50,
    currency: 'USD',
    status: 'APPROVED',
    statusEnum: 'APPROVED',
    version: 3,
    createdBy: 'seller-1',
    creator: { department: 'sales' },
    customerId: customer.id,
    customer,
    expiryDate: new Date('2027-05-26T00:00:00.000Z'),
    validityDeadline: new Date('2027-05-26T00:00:00.000Z'),
    rfq: { id: 'rfq-snapshot', urgency: 'AOG' },
    approvals: [] as Array<Record<string, unknown>>,
    ...overrides,
  };
  quotation.approvals = [{
    id: 'approval-snapshot',
    action: 'APPROVE',
    level: 'MANAGER',
    requiredLevel: 'MANAGER',
    policyVersion: '2026-09-08-usd-tier-v1',
    reviewedVersion: quotation.version,
    snapshotJson: JSON.stringify(buildQuotationApprovalSnapshot(quotation)),
    createdAt: new Date('2027-05-12T09:00:00.000Z'),
  }];
  return quotation;
}

describe('quotation/order module service boundary', () => {
  it('owns transition policy and UI status projection without changing state-machine semantics', () => {
    expect(() => assertQuotationTransition('DRAFT', 'PENDING_APPROVAL')).not.toThrow();
    expect(() => assertQuotationTransition('DRAFT', 'ACCEPTED')).toThrowError(/不能从/);
    expect(toUiQuotationStatus('PENDING_APPROVAL')).toBe('pending_approval');
  });

  it('owns order transition policy, optimistic state change and outbox emission', async () => {
    const existing = {
      id: 'order-1',
      orderNumber: 'SO-1',
      status: 'SO_CREATED',
      statusEnum: 'SO_CREATED',
      version: 2,
      quotation: { createdBy: 'owner-1', creator: { department: 'sales' } },
    };
    const updated = { ...existing, status: 'PO_CREATED', statusEnum: 'PO_CREATED', version: 3 };
    const authorize = vi.fn();
    const tx = addLineDelegates({
      order: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(existing)
          .mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-1' }) },
    }) as unknown as Prisma.TransactionClient;

    const result = await transitionOrderAggregate(tx, {
      id: 'order-1',
      nextStatus: 'PO_CREATED',
      expectedVersion: 2,
      actorId: 'manager-1',
      reasonCode: 'MANUAL_STATUS_UPDATE',
      authorize,
    });

    expect(authorize).toHaveBeenCalledWith(existing);
    expect(result.currentStatus).toBe('SO_CREATED');
    expect(result.order.status).toBe('PO_CREATED');
    expect(tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'order-1', status: 'SO_CREATED', version: 2 }),
    }));
  });

  it('keeps mutable order writes behind the module service boundary', async () => {
    const existing = { id: 'order-1', quotation: { createdBy: 'owner-1', creator: null } };
    const updated = { ...existing, status: 'SO_CREATED' };
    const tx = addLineDelegates({
      order: {
        findUnique: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      },
    }) as unknown as Prisma.TransactionClient;
    const authorize = vi.fn();

    const result = await updateOrderAggregate(tx, {
      id: 'order-1',
      data: { carrier: 'Carrier-1' },
      include: {},
      authorize,
    });

    expect(authorize).toHaveBeenCalledWith(existing);
    expect(result).toEqual(updated);
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { carrier: 'Carrier-1' },
      include: {},
    });
  });

  it('owns quotation creation, money shadows and transactional creation event', async () => {
    const rfq = {
      id: 'rfq-1',
      rfqNumber: 'RFQ-1',
      urgency: 'NORMAL',
      status: 'PENDING',
      statusEnum: 'PENDING',
      version: 1,
      createdBy: 'owner-1',
      creator: { department: 'sales' },
      partNumber: 'BAC31GK0020',
      quantity: 3,
      uom: 'EA',
      conditionCode: 'NE',
      description: null,
      serialNumber: null,
      batchNumber: null,
      alternatePartNumbers: null,
      certificateRequired: true,
      certificateType: null,
      requiredDate: new Date('2026-10-01T00:00:00.000Z'),
      leadTimeDays: null,
      targetPrice: null,
      targetPriceCurrency: 'USD',
    };
    const customer = { id: 'customer-1', name: 'Air China' };
    const tx = addLineDelegates({
      rFQ: { findUnique: vi.fn().mockResolvedValue(rfq) },
      quotation: {
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          id: 'quotation-1',
          version: 1,
          customer,
        })),
      },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-1' }) },
    }) as unknown as Prisma.TransactionClient;
    const authorizeRfq = vi.fn();

    const result = await createQuotationAggregate({
      tx,
      actorId: 'seller-1',
      rfqId: 'rfq-1',
      customerId: customer.id,
      partNumber: 'BAC31GK0020',
      quantity: 3,
      unitPrice: 12.34565,
       costPrice: 8.10005,
       costSourceType: 'MANUAL',
       costSourceReason: '测试成本依据',
      certificateFiles: ['FAA8130'],
      ccRecipients: ['buyer@example.com'],
      authorizeRfq,
    });

    expect(authorizeRfq).toHaveBeenCalledWith(rfq);
    expect(result.quotation.status).toBe('DRAFT');
    expect(result.quotation.validityDays).toBe(7);
    expect(result.quotation.currency).toBe('USD');
    expect(result.quotation.validityDeadline).toEqual(result.quotation.expiryDate);
    expect(result.quotation.unitPrice).toBeCloseTo(12.3457, 10);
    expect(result.quotation.totalPrice).toBeCloseTo(37.0371, 10);
    expect(tx.quotation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        unitPriceDecimal: expect.anything(),
        totalPriceDecimal: expect.anything(),
        certificateFiles: 'FAA8130',
        ccRecipients: '["buyer@example.com"]',
      }),
      include: { customer: true },
    }));
  });

  it('moves an AOG RFQ to quoting and queues manager approval notifications', async () => {
    const aogRfq = {
      id: 'rfq-aog',
      rfqNumber: 'RFQ-AOG',
      urgency: 'AOG',
      status: 'PENDING',
      statusEnum: 'PENDING',
      version: 4,
      createdBy: 'owner-1',
      creator: { department: 'sales' },
      partNumber: 'AOG-PART-1',
      quantity: 1,
      uom: 'EA',
      conditionCode: 'NE',
      description: null,
      serialNumber: null,
      batchNumber: null,
      alternatePartNumbers: null,
      certificateRequired: true,
      certificateType: null,
      requiredDate: new Date('2026-10-01T00:00:00.000Z'),
      leadTimeDays: null,
      targetPrice: null,
      targetPriceCurrency: 'USD',
    };
    const updatedRfq = { ...aogRfq, status: 'QUOTING', statusEnum: 'QUOTING', version: 5 };
    const customer = { id: 'customer-1', name: 'Air China' };
    const tx = addLineDelegates({
      rFQ: {
        findUnique: vi.fn().mockResolvedValueOnce(aogRfq).mockResolvedValueOnce(updatedRfq),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      quotation: {
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          id: 'quotation-aog',
          version: 1,
          customer,
        })),
      },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-1' }) },
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'manager-1' }]) },
      notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }) as unknown as Prisma.TransactionClient;

    const result = await createQuotationAggregate({
      tx,
      actorId: 'seller-1',
      rfqId: aogRfq.id,
      customerId: customer.id,
      partNumber: 'AOG-PART-1',
      quantity: 1,
      unitPrice: 100,
       costPrice: 50,
       costSourceType: 'MANUAL',
       costSourceReason: 'AOG成本依据',
    });

    expect(result.quotation.status).toBe('PENDING_APPROVAL');
    expect(result.quotation.validityDays).toBe(1);
    expect(tx.rFQ.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: aogRfq.id, status: 'PENDING', version: 4 }),
    }));
    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ userId: 'manager-1', link: '/quotations/quotation-aog' })],
    });
  });

  it('reuses an accepted order while keeping contract generation injectable', async () => {
    const quotation = {
      id: 'quotation-accepted',
      quoteNumber: 'QT-1',
      status: 'ACCEPTED',
      statusEnum: 'ACCEPTED',
      version: 2,
      acceptedAt: new Date('2026-07-19T10:00:00.000Z'),
      customerConfirmationNote: 'confirmed',
      partNumber: 'PN-ACCEPTED',
      quantity: 1,
      costPrice: 40,
      costPriceDecimal: null,
      currency: 'USD',
      costSourceType: 'MANUAL',
      costSourceId: null,
      costSourceReason: '已确认成本依据',
      costSourceSnapshotJson: JSON.stringify({ type: 'MANUAL', id: null, currency: 'USD', costPrice: 40, partNumber: 'PN-ACCEPTED', quantity: 1, status: null, supplierId: null, capturedAt: '2027-05-12T09:00:00.000Z', reason: '已确认成本依据' }),
      createdBy: 'owner-1',
      creator: { department: 'sales' },
      customer: { id: 'customer-1', name: 'Air China' },
    };
    const order = {
      id: 'order-1',
      orderNumber: 'SO-1',
      soNumber: 'SO-1',
      quotationId: quotation.id,
      customerId: quotation.customer.id,
      status: 'SO_CREATED',
      statusEnum: 'SO_CREATED',
      customer: quotation.customer,
    };
    const tx = addLineDelegates({
      quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
      order: { findFirst: vi.fn().mockResolvedValue(order) },
    }) as unknown as Prisma.TransactionClient;
    const authorize = vi.fn();
    const ensureContractDocument = vi.fn().mockResolvedValue({ id: 'doc-1', title: 'Contract' });

    const result = await acceptQuotationAggregate({
      tx,
      quotationId: quotation.id,
      actorId: 'seller-1',
      authorize,
      ensureContractDocument,
    });

    expect(authorize).toHaveBeenCalledWith(quotation);
    expect(result.wasAlreadyAccepted).toBe(true);
    expect(result.isNewOrder).toBe(false);
    expect(result.order).toBe(order);
    expect(ensureContractDocument).toHaveBeenCalledWith(expect.objectContaining({
      quotation,
      order,
      templateId: undefined,
      generatedById: 'seller-1',
      tx,
    }));
  });

  it('revalidates an approval snapshot with the current RFQ urgency before acceptance', async () => {
    const quotation = makeSnapshotQuotation();
    const updatedQuotation = {
      ...quotation,
      status: 'ACCEPTED',
      statusEnum: 'ACCEPTED',
      version: 4,
      acceptedAt: new Date('2027-05-13T09:00:00.000Z'),
    };
    const order = {
      id: 'order-snapshot',
      orderNumber: 'SO-SNAPSHOT',
      soNumber: 'SO-SNAPSHOT',
      quotationId: quotation.id,
      customerId: quotation.customerId,
      status: 'SO_CREATED',
      statusEnum: 'SO_CREATED',
      customer: quotation.customer,
    };
    const tx = addLineDelegates({
      quotation: {
        findUnique: vi.fn().mockResolvedValueOnce(quotation).mockResolvedValueOnce(updatedQuotation),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      order: { findFirst: vi.fn().mockResolvedValue(order) },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-snapshot' }) },
    }) as unknown as Prisma.TransactionClient;
    const ensureContractDocument = vi.fn().mockResolvedValue({ id: 'doc-snapshot', title: 'Contract' });

    const result = await acceptQuotationAggregate({
      tx,
      quotationId: quotation.id,
      actorId: 'seller-1',
      ensureContractDocument,
    });

    expect(result.quotation.status).toBe('ACCEPTED');
    expect(result.isNewOrder).toBe(false);
    expect(tx.quotation.findUnique).toHaveBeenNthCalledWith(1, expect.objectContaining({
      include: expect.objectContaining({ rfq: true }),
    }));
  });

  it('withdraws a sent quotation transactionally when no inventory release is needed', async () => {
    const quotation = {
      id: 'quotation-sent',
      quoteNumber: 'QT-SENT',
      status: 'SENT',
      statusEnum: 'SENT',
      version: 1,
      createdBy: 'owner-1',
      creator: { department: 'sales' },
      customerId: 'customer-1',
      customer: { id: 'customer-1', name: 'Air China', contactName: 'Buyer', email: 'buyer@example.com' },
      inventoryDetailId: null,
      reservedQuantity: 0,
      outboundEmails: [{ id: 'mail-1', purpose: 'QUOTATION_SEND', status: 'SENT' }],
    };
    const updatedQuotation = { ...quotation, status: 'WITHDRAWN', statusEnum: 'WITHDRAWN', version: 2 };
    const tx = addLineDelegates({
      quotation: {
        findUnique: vi.fn().mockResolvedValueOnce(quotation).mockResolvedValueOnce(updatedQuotation),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      outboundEmail: { update: vi.fn().mockResolvedValue({ id: 'mail-1' }) },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-1' }) },
    }) as unknown as Prisma.TransactionClient;

    const result = await withdrawQuotationAggregate({
      tx,
      quotationId: quotation.id,
      actorId: 'seller-1',
      reason: '价格调整',
      sendWithdrawalNotice: false,
      getDefaultOutboundAccount: vi.fn(),
    });

    expect(result.quotation.status).toBe('WITHDRAWN');
    expect(result.noticeId).toBeUndefined();
    expect(result.releasedReservation).toBeUndefined();
    expect(tx.outboundEmail.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'mail-1' },
      data: expect.objectContaining({ status: 'WITHDRAWN', withdrawalReason: '价格调整' }),
    }));
  });

  it('owns quotation send validation, pending email creation and outbox enqueue', async () => {
    const quotation = {
      id: 'quotation-approved',
      quoteNumber: 'QT-APPROVED',
      partNumber: 'PN-1',
      quantity: 2,
      unitPrice: 12,
      unitPriceDecimal: null,
      totalPrice: 24,
      totalPriceDecimal: null,
      costPrice: 18,
      costPriceDecimal: null,
      margin: 25,
      currency: 'USD',
      status: 'APPROVED',
      statusEnum: 'APPROVED',
      version: 3,
      createdBy: 'owner-1',
      creator: { department: 'sales' },
      customerId: 'customer-1',
      customer: { id: 'customer-1', name: 'Air China', contactName: 'Buyer', email: 'buyer@example.com' },
      rfq: { id: 'rfq-approved', urgency: 'AOG' },
      costSourceType: 'MANUAL',
      costSourceId: null,
      costSourceReason: '发送测试成本依据',
      costSourceSnapshotJson: JSON.stringify({ type: 'MANUAL', id: null, currency: 'USD', costPrice: 18, partNumber: 'PN-1', quantity: 2, status: null, supplierId: null, capturedAt: '2027-05-12T09:00:00.000Z', reason: '发送测试成本依据' }),
      saleType: 'Sale',
      incoterm: null,
      incotermLocation: null,
      leadTimeDays: 7,
      taxIncluded: false,
      taxRate: null,
      warrantyDays: 90,
      sentAt: null,
      expiryDate: new Date('2027-05-26T00:00:00.000Z'),
      validityDeadline: new Date('2027-05-26T00:00:00.000Z'),
      approvals: [] as Array<Record<string, unknown>>,
    };
    quotation.approvals = [{
      id: 'approval-1',
      action: 'APPROVE',
      level: 'MANAGER',
      requiredLevel: 'MANAGER',
      policyVersion: '2026-09-08-usd-tier-v1',
      reviewedVersion: quotation.version,
      snapshotJson: JSON.stringify(buildQuotationApprovalSnapshot(quotation)),
      createdAt: new Date('2027-05-12T09:00:00.000Z'),
    }];
    const pendingEmail = { id: 'mail-pending-1' };
    const tx = addLineDelegates({
      quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
      outboundEmail: { create: vi.fn().mockResolvedValue(pendingEmail) },
    }) as unknown as Prisma.TransactionClient;
    const authorize = vi.fn();
    const getDefaultOutboundAccount = vi.fn().mockResolvedValue({ id: 'account-1' });

    const result = await sendQuotationAggregate({
      tx,
      quotationId: quotation.id,
      actorId: 'seller-1',
      subject: 'Review quote',
      message: 'Please review.',
      authorize,
      getDefaultOutboundAccount,
    });

    expect(authorize).toHaveBeenCalledWith(quotation);
    expect(tx.quotation.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ rfq: true }),
    }));
    expect(getDefaultOutboundAccount).toHaveBeenCalledWith(tx);
    expect(result.pendingEmail).toBe(pendingEmail);
    expect(tx.outboundEmail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purpose: 'QUOTATION_SEND',
        accountId: 'account-1',
        subject: 'Review quote',
        textBody: 'Please review.',
        status: 'PENDING',
      }),
    });
  });

  it('keeps direct order creation behind the quotationOrder aggregate boundary', async () => {
    const quotation = {
      id: 'quotation-accepted',
      customerId: 'customer-1',
      status: 'ACCEPTED',
      statusEnum: 'ACCEPTED',
      version: 2,
      createdBy: 'owner-1',
      creator: { department: 'sales' },
      customer: { id: 'customer-1', name: 'Air China' },
      partNumber: 'PN-ACCEPTED',
      quantity: 1,
      costPrice: 40,
      costPriceDecimal: null,
      currency: 'USD',
      costSourceType: 'MANUAL',
      costSourceId: null,
      costSourceReason: '订单测试成本依据',
      costSourceSnapshotJson: JSON.stringify({ type: 'MANUAL', id: null, currency: 'USD', costPrice: 40, partNumber: 'PN-ACCEPTED', quantity: 1, status: null, supplierId: null, capturedAt: '2027-05-12T09:00:00.000Z', reason: '订单测试成本依据' }),
    };
    const order = {
      id: 'order-existing',
      quotationId: quotation.id,
      orderNumber: 'SO-1',
      soNumber: 'SO-1',
      customerId: quotation.customerId,
      status: 'SO_CREATED',
      statusEnum: 'SO_CREATED',
      customer: quotation.customer,
    };
    const tx = addLineDelegates({
      quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
      order: { findUnique: vi.fn().mockResolvedValue(order) },
    }) as unknown as Prisma.TransactionClient;
    const authorize = vi.fn();
    const ensureContractDocument = vi.fn().mockResolvedValue({ id: 'doc-1', title: 'Contract' });
    const createOrder = vi.fn();

    const result = await createOrderAggregate({
      tx,
      quotationId: quotation.id,
      customerId: quotation.customerId,
      actorId: 'seller-1',
      authorize,
      createOrder,
      ensureContractDocument,
    });

    expect(authorize).toHaveBeenCalledWith(quotation);
    expect(result.order).toBe(order);
    expect(result.isNewOrder).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
    expect(ensureContractDocument).toHaveBeenCalledWith(expect.objectContaining({ quotation, order, tx }));
  });

  it('revalidates the RFQ-backed approval snapshot before creating a direct order', async () => {
    const quotation = makeSnapshotQuotation({
      status: 'ACCEPTED',
      statusEnum: 'ACCEPTED',
    });
    const order = {
      id: 'order-direct-snapshot',
      orderNumber: 'SO-DIRECT-SNAPSHOT',
      soNumber: 'SO-DIRECT-SNAPSHOT',
      quotationId: quotation.id,
      customerId: quotation.customerId,
      status: 'SO_CREATED',
      statusEnum: 'SO_CREATED',
      version: 1,
      createdAt: new Date('2027-05-13T09:00:00.000Z'),
      totalAmount: 100,
      totalAmountDecimal: null,
      customer: quotation.customer,
    };
    const tx = addLineDelegates({
      quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
      order: { findUnique: vi.fn().mockResolvedValue(null) },
    }) as unknown as Prisma.TransactionClient;
    const createOrder = vi.fn().mockResolvedValue(order);
    const ensureContractDocument = vi.fn().mockResolvedValue({ id: 'doc-direct-snapshot', title: 'Contract' });

    const result = await createOrderAggregate({
      tx,
      quotationId: quotation.id,
      customerId: quotation.customerId,
      actorId: 'seller-1',
      createOrder,
      ensureContractDocument,
    });

    expect(result.order).toBe(order);
    expect(result.isNewOrder).toBe(true);
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ quotation, customer: quotation.customer }));
    expect(tx.quotation.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ rfq: true }),
    }));
  });

  it('owns quotation submission transition and event emission', async () => {
    const current = {
      id: 'quotation-draft',
      quoteNumber: 'QT-DRAFT',
      status: 'DRAFT',
      statusEnum: 'DRAFT',
      version: 1,
      createdBy: 'owner-1',
      creator: { department: 'sales' },
    };
    const updated = { ...current, status: 'PENDING_APPROVAL', statusEnum: 'PENDING_APPROVAL', version: 2 };
    const tx = addLineDelegates({
      quotation: {
        findUnique: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-1' }) },
    }) as unknown as Prisma.TransactionClient;

    const result = await submitQuotationAggregate({
      tx,
      quotationId: current.id,
      actorId: 'seller-1',
      expectedVersion: 1,
      authorize: vi.fn(),
    });

    expect(result.quotation.status).toBe('PENDING_APPROVAL');
    expect(tx.quotation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: current.id, status: 'DRAFT', version: 1 }),
    }));
  });

  it('owns AOG approval decision, approval record and event emission', async () => {
    const current = {
      id: 'quotation-aog-approval',
      quoteNumber: 'QT-AOG',
      status: 'PENDING_APPROVAL',
      statusEnum: 'PENDING_APPROVAL',
      version: 1,
      totalPrice: 100,
      totalPriceDecimal: null,
      currency: 'USD',
      createdBy: 'owner-1',
      creator: { department: 'sales' },
      rfq: { urgency: 'AOG' },
      partNumber: 'PN-1',
      quantity: 1,
      costPrice: 50,
      costPriceDecimal: null,
      costSourceType: 'MANUAL',
      costSourceId: null,
      costSourceReason: 'AOG成本依据',
      costSourceSnapshotJson: JSON.stringify({ type: 'MANUAL', id: null, currency: 'USD', costPrice: 50, partNumber: 'PN-1', quantity: 1, status: null, supplierId: null, capturedAt: '2027-05-12T09:00:00.000Z', reason: 'AOG成本依据' }),
    };
    const updated = { ...current, status: 'APPROVED', statusEnum: 'APPROVED', version: 2 };
    const tx = addLineDelegates({
      quotation: {
        findUnique: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      approval: { create: vi.fn().mockResolvedValue({ id: 'approval-1' }) },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-1' }) },
    }) as unknown as Prisma.TransactionClient;

    const result = await approveQuotationAggregate({
      tx,
      quotationId: current.id,
      actorId: 'manager-1',
      actorRole: 'manager',
      action: 'approve',
      comment: 'AOG approved',
    });

    expect(result.quotation.status).toBe('APPROVED');
    expect(tx.approval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ quotationId: current.id, level: 'MANAGER', requiredLevel: 'MANAGER', action: 'APPROVE' }),
    });
  });

  it('re-approves an old APPROVED quotation in place when its legacy approval cannot be verified', async () => {
    const current = {
      id: 'quotation-legacy-approved',
      quoteNumber: 'QT-LEGACY',
      status: 'APPROVED',
      statusEnum: 'APPROVED',
      version: 7,
      totalPrice: 100,
      totalPriceDecimal: null,
      currency: 'USD',
      partNumber: 'PN-1',
      quantity: 1,
      costPrice: 50,
      costPriceDecimal: null,
      createdBy: 'seller-1',
      creator: { department: 'sales' },
      rfqId: 'rfq-legacy',
      rfq: { id: 'rfq-legacy', partNumber: 'PN-1', quantity: 1, alternatePartNumbers: null, urgency: 'NORMAL' },
      approvals: [],
    };
    const updated = {
      ...current,
      statusEnum: 'APPROVED',
      version: 8,
      approvedBy: 'manager-1',
      approvedAt: new Date('2027-05-12T10:00:00.000Z'),
      costSourceType: 'MANUAL',
      costSourceId: null,
      costSourceReason: '历史成本依据',
      costSourceSnapshotJson: JSON.stringify({ type: 'MANUAL', id: null, currency: 'USD', costPrice: 50, partNumber: 'PN-1', quantity: 1, status: null, supplierId: null, capturedAt: '2027-05-12T09:00:00.000Z', reason: '历史成本依据' }),
    };
    const tx = addLineDelegates({
      quotation: {
        findUnique: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      approval: { create: vi.fn().mockResolvedValue({ id: 'approval-repaired' }) },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-repaired' }) },
    }) as unknown as Prisma.TransactionClient;

    const result = await approveQuotationAggregate({
      tx,
      quotationId: current.id,
      actorId: 'manager-1',
      actorRole: 'manager',
      action: 'approve',
      expectedVersion: current.version,
      comment: '按新策略重新审核',
      costSourceType: 'MANUAL',
      costSourceReason: '历史成本依据',
    });

    expect(result.quotation.status).toBe('APPROVED');
    expect(result.quotation.version).toBe(8);
    expect(result.isNoop).toBe(false);
    expect(tx.quotation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: current.id, status: 'APPROVED', version: current.version }),
      data: expect.objectContaining({ status: 'APPROVED', statusEnum: 'APPROVED', version: { increment: 1 }, approvedBy: 'manager-1', approvedAt: expect.any(Date) }),
    }));
    expect(tx.approval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        policyVersion: '2026-09-08-usd-tier-v1',
        requiredLevel: 'MANAGER',
        reviewedVersion: 8,
        snapshotJson: expect.any(String),
      }),
    });
  });

  it('fails a concurrent legacy re-approval when the quotation version CAS loses', async () => {
    const current = {
      id: 'quotation-legacy-race',
      quoteNumber: 'QT-LEGACY-RACE',
      status: 'APPROVED',
      statusEnum: 'APPROVED',
      version: 7,
      totalPrice: 100,
      totalPriceDecimal: null,
      currency: 'USD',
      partNumber: 'PN-1',
      quantity: 1,
      costPrice: 50,
      costPriceDecimal: null,
      costSourceType: 'MANUAL',
      costSourceId: null,
      costSourceReason: '并发测试成本依据',
      costSourceSnapshotJson: JSON.stringify({ type: 'MANUAL', id: null, currency: 'USD', costPrice: 50, partNumber: 'PN-1', quantity: 1, status: null, supplierId: null, capturedAt: '2027-05-12T09:00:00.000Z', reason: '并发测试成本依据' }),
      createdBy: 'seller-1',
      creator: { department: 'sales' },
      rfqId: 'rfq-legacy-race',
      rfq: { id: 'rfq-legacy-race', partNumber: 'PN-1', quantity: 1, alternatePartNumbers: null, urgency: 'NORMAL' },
      approvals: [],
    };
    const tx = addLineDelegates({
      quotation: {
        findUnique: vi.fn().mockResolvedValue(current),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      approval: { create: vi.fn() },
      transactionStatusHistory: { create: vi.fn() },
    }) as unknown as Prisma.TransactionClient;

    await expect(approveQuotationAggregate({
      tx,
      quotationId: current.id,
      actorId: 'manager-1',
      actorRole: 'manager',
      action: 'approve',
      expectedVersion: current.version,
      comment: '并发重审',
    })).rejects.toMatchObject({ code: 'STATE_CONFLICT', statusCode: 409 });
    expect(tx.approval.create).not.toHaveBeenCalled();
    expect(tx.transactionStatusHistory.create).not.toHaveBeenCalled();
  });

  it('fails closed when a legacy approval has no cost-source evidence', async () => {
    const current = {
      id: 'quotation-legacy-no-source',
      quoteNumber: 'QT-LEGACY-NO-SOURCE',
      status: 'PENDING_APPROVAL',
      statusEnum: 'PENDING_APPROVAL',
      version: 1,
      totalPrice: 100,
      totalPriceDecimal: null,
      costPrice: 50,
      costPriceDecimal: null,
      currency: 'USD',
      partNumber: 'PN-1',
      quantity: 1,
      createdBy: 'seller-1',
      creator: { department: 'sales' },
      approvals: [],
    };
    const tx = addLineDelegates({
      quotation: { findUnique: vi.fn().mockResolvedValue(current) },
    }) as unknown as Prisma.TransactionClient;

    await expect(approveQuotationAggregate({
      tx,
      quotationId: current.id,
      actorId: 'manager-1',
      actorRole: 'manager',
      action: 'approve',
    })).rejects.toThrow(/成本来源/);
  });

  it('blocks sending an expired quotation even when its approval snapshot is current', async () => {
    const quotation = {
      id: 'quotation-expired',
      quoteNumber: 'QT-EXPIRED',
      partNumber: 'PN-1',
      quantity: 1,
      unitPrice: 100,
      totalPrice: 100,
      costPrice: 50,
      margin: 50,
      currency: 'USD',
      costSourceType: 'MANUAL',
      costSourceId: null,
      costSourceReason: '过期测试成本依据',
      costSourceSnapshotJson: JSON.stringify({ type: 'MANUAL', id: null, currency: 'USD', costPrice: 50, partNumber: 'PN-1', quantity: 1, status: null, supplierId: null, capturedAt: '2027-05-12T09:00:00.000Z', reason: '过期测试成本依据' }),
      status: 'APPROVED',
      statusEnum: 'APPROVED',
      version: 1,
      createdBy: 'owner-1',
      creator: { department: 'sales' },
      customerId: 'customer-1',
      customer: { id: 'customer-1', name: 'Air China', contactName: 'Buyer', email: 'buyer@example.com' },
      expiryDate: new Date('2020-01-01T00:00:00.000Z'),
      validityDeadline: new Date('2020-01-01T00:00:00.000Z'),
      approvals: [],
    };
    const tx = addLineDelegates({
      quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
      outboundEmail: { create: vi.fn() },
    }) as unknown as Prisma.TransactionClient;

    await expect(sendQuotationAggregate({
      tx,
      quotationId: quotation.id,
      actorId: 'seller-1',
      getDefaultOutboundAccount: vi.fn(),
    })).rejects.toThrow(/过期/);
  });
});
