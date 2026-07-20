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

vi.mock('../../lib/outboxService.js', () => ({
  enqueueBusinessEvent: vi.fn().mockResolvedValue(undefined),
  enqueueOutboundEmail: vi.fn().mockResolvedValue(undefined),
}));

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
    const tx = {
      order: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(existing)
          .mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-1' }) },
    } as unknown as Prisma.TransactionClient;

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
    const tx = {
      order: {
        findUnique: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      },
    } as unknown as Prisma.TransactionClient;
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
    };
    const customer = { id: 'customer-1', name: 'Air China' };
    const tx = {
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
    } as unknown as Prisma.TransactionClient;
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
      certificateFiles: ['FAA8130'],
      ccRecipients: ['buyer@example.com'],
      authorizeRfq,
    });

    expect(authorizeRfq).toHaveBeenCalledWith(rfq);
    expect(result.quotation.status).toBe('DRAFT');
    expect(result.quotation.validityDays).toBe(7);
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
    };
    const updatedRfq = { ...aogRfq, status: 'QUOTING', statusEnum: 'QUOTING', version: 5 };
    const customer = { id: 'customer-1', name: 'Air China' };
    const tx = {
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
    } as unknown as Prisma.TransactionClient;

    const result = await createQuotationAggregate({
      tx,
      actorId: 'seller-1',
      rfqId: aogRfq.id,
      customerId: customer.id,
      partNumber: 'AOG-PART-1',
      quantity: 1,
      unitPrice: 100,
      costPrice: 50,
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
    const tx = {
      quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
      order: { findFirst: vi.fn().mockResolvedValue(order) },
    } as unknown as Prisma.TransactionClient;
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
    const tx = {
      quotation: {
        findUnique: vi.fn().mockResolvedValueOnce(quotation).mockResolvedValueOnce(updatedQuotation),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      outboundEmail: { update: vi.fn().mockResolvedValue({ id: 'mail-1' }) },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-1' }) },
    } as unknown as Prisma.TransactionClient;

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
      status: 'APPROVED',
      statusEnum: 'APPROVED',
      version: 3,
      createdBy: 'owner-1',
      creator: { department: 'sales' },
      customerId: 'customer-1',
      customer: { id: 'customer-1', name: 'Air China', contactName: 'Buyer', email: 'buyer@example.com' },
      saleType: 'Sale',
      incoterm: null,
      incotermLocation: null,
      leadTimeDays: 7,
      taxIncluded: false,
      taxRate: null,
      warrantyDays: 90,
      sentAt: null,
    };
    const pendingEmail = { id: 'mail-pending-1' };
    const tx = {
      quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
      outboundEmail: { create: vi.fn().mockResolvedValue(pendingEmail) },
    } as unknown as Prisma.TransactionClient;
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
    const tx = {
      quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
      order: { findUnique: vi.fn().mockResolvedValue(order) },
    } as unknown as Prisma.TransactionClient;
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
    const tx = {
      quotation: {
        findUnique: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-1' }) },
    } as unknown as Prisma.TransactionClient;

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
      createdBy: 'owner-1',
      creator: { department: 'sales' },
      rfq: { urgency: 'AOG' },
    };
    const updated = { ...current, status: 'APPROVED', statusEnum: 'APPROVED', version: 2 };
    const tx = {
      quotation: {
        findUnique: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      approval: { create: vi.fn().mockResolvedValue({ id: 'approval-1' }) },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue({ id: 'history-1' }) },
    } as unknown as Prisma.TransactionClient;

    const result = await approveQuotationAggregate({
      tx,
      quotationId: current.id,
      actorId: 'manager-1',
      action: 'approve',
      comment: 'AOG approved',
    });

    expect(result.quotation.status).toBe('APPROVED');
    expect(tx.approval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ quotationId: current.id, level: 'AOG', action: 'APPROVE' }),
    });
  });
});
