import { Prisma, type Customer, type Order, type Quotation } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('order workflow monetary shadows', () => {
  let createInitialStatusHistoryMock: ReturnType<typeof vi.fn>;
  let createOrderFromQuotation: typeof import('./orderWorkflowService.js').createOrderFromQuotation;
  let mapOrderResponse: typeof import('./orderWorkflowService.js').mapOrderResponse;

  beforeEach(async () => {
    vi.resetModules();
    createInitialStatusHistoryMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./transactionStateService.js', () => ({
      createInitialStatusHistory: createInitialStatusHistoryMock,
    }));

    ({ createOrderFromQuotation, mapOrderResponse } = await import('./orderWorkflowService.js'));
  });

  it('copies the quotation Decimal total and dual-writes optional order charges', async () => {
    const customer = {
      id: 'customer-001',
      name: '中国国航',
    } as Customer;
    const quotation = {
      id: 'quotation-001',
      partNumber: 'BAC31GK0020',
      quantity: 3,
      totalPrice: 37.0371,
      totalPriceDecimal: new Prisma.Decimal('37.0371'),
    } as Quotation;
    const createdOrder = {
      id: 'order-001',
      status: 'SO_CREATED',
      version: 1,
      customer,
    };
    const orderCreate = vi.fn().mockResolvedValue(createdOrder);
    const tx = { order: { create: orderCreate } } as unknown as Prisma.TransactionClient;

    await createOrderFromQuotation({
      tx,
      quotation,
      customer,
      importDuty: 12.34565,
      vatAmount: 1.2,
      totalLandCost: 50.00005,
      exchangeCoreCharge: 0.00005,
      actorId: 'user-001',
    });

    const createData = orderCreate.mock.calls[0][0].data;
    expect(createData.totalAmount).toBeCloseTo(37.0371, 10);
    expect(String(createData.totalAmountDecimal)).toBe('37.0371');
    expect(createData.importDuty).toBeCloseTo(12.3457, 10);
    expect(String(createData.importDutyDecimal)).toBe('12.3457');
    expect(createData.vatAmount).toBeCloseTo(1.2, 10);
    expect(String(createData.vatAmountDecimal)).toBe('1.2');
    expect(createData.totalLandCost).toBeCloseTo(50.0001, 10);
    expect(String(createData.totalLandCostDecimal)).toBe('50.0001');
    expect(createData.exchangeCoreCharge).toBeCloseTo(0.0001, 10);
    expect(String(createData.exchangeCoreChargeDecimal)).toBe('0.0001');
    expect(createInitialStatusHistoryMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ entityType: 'ORDER', entityId: 'order-001' }),
    );
  });

  it('keeps the response shape numeric while preferring its Decimal shadows', () => {
    const order = {
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
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
      deliveryDate: null,
      trackingNumber: null,
      carrier: null,
      saleType: 'Sale',
      incoterm: null,
      incotermLocation: null,
      shipToId: null,
      shipForId: null,
      warrantyDays: 90,
      warrantyStartDate: null,
      certificateRequired: true,
      certificateType: null,
      certificateDelivered: false,
      packagingStandard: null,
      shippingMethod: null,
      carrierAccount: null,
      inspectionRequired: false,
      inspectionPassed: null,
      inspectionDate: null,
      customsClearanceRequired: false,
      customsDeclarationNo: null,
      importDuty: 12.3456,
      importDutyDecimal: new Prisma.Decimal('12.3457'),
      vatAmount: null,
      vatAmountDecimal: null,
      totalLandCost: null,
      totalLandCostDecimal: null,
      exchangeCoreCharge: null,
      exchangeCoreChargeDecimal: null,
      exchangeCoreDueDate: null,
      eSignatureCustomer: null,
      eSignatureSupplier: null,
      inventoryDetailId: null,
      serialNumber: null,
      batchNumber: null,
      outboundQuantity: null,
      outboundStatus: null,
      customer: { id: 'customer-001', name: '中国国航' },
    } as unknown as Order & { customer: Customer };

    const response = mapOrderResponse(order);

    expect(response.totalAmount).toBe(37.0371);
    expect(response.importDuty).toBe(12.3457);
    expect(response).not.toHaveProperty('totalAmountDecimal');
    expect(response).not.toHaveProperty('importDutyDecimal');
  });
});
