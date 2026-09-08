import { describe, expect, it, vi } from 'vitest';
import { buildOrderContractPayload, createOrderContractDocument, renderTemplate } from './documentTemplateService.js';

describe('documentTemplateService', () => {
  it('should replace known placeholders and fallback missing values', () => {
    const html = renderTemplate(
      '<p>{{customer.name}}</p><p>{{quotation.partNumber}}</p><p>{{order.poNumber}}</p>',
      {
        customer: { name: '厦门航空' },
        quotation: { partNumber: 'BAC31GK0020' },
        order: { poNumber: null },
      }
    );

    expect(html).toContain('厦门航空');
    expect(html).toContain('BAC31GK0020');
    expect(html).toContain('待补充');
  });

  it('should build a nested payload for order contract generation', () => {
    const payload = buildOrderContractPayload({
      customer: {
        id: 'c1',
        name: '厦门航空',
        contactName: '采购经理',
        email: 'buyer@xiamenair.com',
        phone: '13800000000',
        registeredAddress: 'Xiamen',
        creditLimit: null,
        annualRevenue: null,
        status: 'ACTIVE',
        lastOrderAt: null,
        createdAt: new Date('2026-05-12T00:00:00Z'),
        updatedAt: new Date('2026-05-12T00:00:00Z'),
        buyerType: 'End User',
        businessDescription: null,
        shipToAddress: null,
        shipForAddress: null,
        shippingContactName: null,
        shippingContactPhone: null,
        creditRating: null,
        paymentTerms: null,
        paymentMethod: null,
        vatNumber: null,
        iataCode: null,
        icaoCode: null,
        aocNumber: null,
        preferredIncoterm: null,
        customsBroker: null,
        qualityApprovalStatus: 'Pending',
      } as any,
      quotation: {
        id: 'q1',
        quoteNumber: 'QT-20260512-001',
        rfqId: 'r1',
        customerId: 'c1',
        partNumber: 'BAC31GK0020',
        quantity: 2,
        unitPrice: 1800,
        totalPrice: 3600,
        costPrice: 1500,
        margin: 16.7,
        certificateFiles: null,
        template: 'STANDARD',
        status: 'ACCEPTED',
        validityDays: 14,
        createdAt: new Date('2026-05-12T00:00:00Z'),
        createdBy: 'u1',
        approvedBy: null,
        approvedAt: null,
        sentAt: null,
        acceptedAt: new Date('2026-05-12T08:00:00Z'),
        withdrawnAt: null,
        withdrawalReason: null,
        customerConfirmationNote: '客户采购电话确认',
        expiryDate: new Date('2026-05-26T00:00:00Z'),
        saleType: 'Sale',
        shipToId: null,
        shipForId: null,
        incoterm: null,
        incotermLocation: null,
        leadTimeDays: null,
        leadTimeBasis: null,
        moq: null,
        mpq: null,
        priceBasis: null,
        taxIncluded: true,
        taxRate: null,
        warrantyDays: 90,
        warrantyTerms: null,
        validityDeadline: new Date('2026-05-26T00:00:00Z'),
        packagingRequirement: null,
        shippingMethod: null,
        inspectionStandard: null,
        inspectionReportIncluded: false,
        certificateOfConformance: false,
        countryOfOrigin: null,
        hsCode: null,
        eccn: null,
        dualUse: false,
        ccRecipients: null,
        commonNote: null,
        eSignature: null,
        eSignatureStatus: 'Unsigned',
        orderId: null,
        orderNumber: null,
        contractDocumentId: null,
        contractDocumentTitle: null,
        lastEmailStatus: null,
        lastEmailSentAt: null,
      } as any,
      order: {
        id: 'o1',
        orderNumber: 'SO-20260512-ABCD',
        soNumber: 'SO-20260512-ABCD',
        poNumber: 'PO-123',
        quotationId: 'q1',
        customerId: 'c1',
        partNumber: 'BAC31GK0020',
        quantity: 2,
        totalAmount: 3600,
        totalAmountDecimal: null,
        status: 'SO_CREATED',
        statusEnum: null,
        version: 1,
        createdAt: new Date('2026-05-12T08:00:00Z'),
        deliveryDate: new Date('2026-06-01T00:00:00Z'),
        trackingNumber: null,
        carrier: null,
        // P2 新增字段
        saleType: 'Sale',
        incoterm: null,
        incotermLocation: null,
        shipToId: null,
        shipForId: null,
        warrantyDays: null,
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
        importDuty: null,
        importDutyDecimal: null,
        vatAmount: null,
        vatAmountDecimal: null,
        totalLandCost: null,
        totalLandCostDecimal: null,
        poNumberCustomer: null,
        soNumberInternal: null,
        exchangeCoreCharge: null,
        exchangeCoreChargeDecimal: null,
        exchangeCoreDueDate: null,
        eSignatureCustomer: null,
        eSignatureSupplier: null,
        inventoryDetailId: null,
        serialNumber: null,
        batchNumber: null,
        outboundQuantity: 0,
        outboundStatus: 'PENDING',
      },
    });

    expect(payload.customer).toMatchObject({
      name: '厦门航空',
      contactName: '采购经理',
    });
    expect(payload.quotation).toMatchObject({
      quoteNumber: 'QT-20260512-001',
      customerConfirmationNote: '客户采购电话确认',
    });
    expect(payload.order).toMatchObject({
      soNumber: 'SO-20260512-ABCD',
      poNumber: 'PO-123',
    });
  });

  it('uses the current order lines for a multi-line contract total', () => {
    const payload = buildOrderContractPayload({
      customer: { name: '客户一', contactName: null, email: null, phone: null, registeredAddress: null } as any,
      quotation: {
        id: 'q1', quoteNumber: 'QT-1', partNumber: 'QUOTATION-HEADER', quantity: 999,
        unitPrice: 999, totalPrice: 999, unitPriceDecimal: null, totalPriceDecimal: null,
        saleType: 'Sale', incoterm: null, incotermLocation: null, leadTimeDays: null,
        warrantyDays: 90, taxIncluded: true, taxRate: null, packagingRequirement: null,
        shippingMethod: null, expiryDate: new Date('2026-10-01'), customerConfirmationNote: null,
        currency: 'USD',
        lines: [
          { id: 'ql-1', partNumber: 'PN-100', quantity: 5, unitPrice: '10', lineTotal: '50', currency: 'USD' },
          { id: 'ql-2', partNumber: 'PN-UNACCEPTED', quantity: 7, unitPrice: '20', lineTotal: '140', currency: 'USD' },
        ],
      } as any,
      order: {
        id: 'o1', orderNumber: 'SO-1', soNumber: 'SO-1', poNumber: 'PO-1', quotationId: 'q1',
        customerId: 'c1', partNumber: 'ORDER-HEADER', quantity: 999, totalAmount: 999,
        totalAmountDecimal: null, status: 'SO_CREATED', createdAt: new Date('2026-09-08'),
        lineItemsMode: true,
        lines: [
          { id: 'ol-1', partNumber: 'PN-100', quantity: 2, unitPrice: '10.0000', lineTotal: '20.0000', currency: 'USD' },
          { id: 'ol-2', partNumber: 'PN-200', quantity: 1, unitPrice: '30.0000', lineTotal: '30.0000', currency: 'USD' },
        ],
      } as any,
    });

    expect(payload.order).toMatchObject({ quantity: 3, totalAmount: 50 });
    expect(String((payload.order as any).linesTable)).toContain('PN-100');
    expect(String((payload.order as any).linesTable)).toContain('PN-200');
    expect(String((payload.order as any).linesTable)).not.toContain('ORDER-HEADER');
    expect(String((payload.order as any).linesTable)).not.toContain('PN-UNACCEPTED');
  });

  it('fails closed when a multi-line order has no current order lines', () => {
    expect(() => buildOrderContractPayload({
      customer: { name: '客户一' } as any,
      quotation: { id: 'q1', quoteNumber: 'QT-1', partNumber: 'P1', quantity: 1, unitPrice: 10, totalPrice: 10, currency: 'USD' } as any,
      order: { id: 'o1', orderNumber: 'SO-1', soNumber: 'SO-1', quotationId: 'q1', customerId: 'c1', partNumber: 'P1', quantity: 1, totalAmount: 10, lineItemsMode: true } as any,
    })).toThrow('多行订单缺少当前订单明细');
  });

  it('rejects a modern contract template that still renders legacy quotation scalars', async () => {
    const generatedDocumentCreate = vi.fn();
    const tx = {
      documentTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'template-old',
          isActive: true,
          bodyTemplate: '<p>{{quotation.partNumber}} × {{quotation.quantity}}</p>',
        }),
      },
      generatedDocument: { create: generatedDocumentCreate },
    } as any;

    await expect(createOrderContractDocument({
      templateId: 'template-old',
      tx,
      customer: { id: 'c1', name: '客户一' } as any,
      quotation: { id: 'q1', partNumber: 'HEADER', quantity: 99, unitPrice: 0, totalPrice: 0 } as any,
      order: {
        id: 'o1', orderNumber: 'SO-1', quotationId: 'q1', lineItemsMode: true,
        lines: [{ id: 'ol-1', partNumber: 'PN-100', quantity: 2, unitPrice: '10', lineTotal: '20', currency: 'USD' }],
      } as any,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(generatedDocumentCreate).not.toHaveBeenCalled();
  });

  it('renders only current modern order lines through a compatible template', async () => {
    const generatedDocumentCreate = vi.fn().mockResolvedValue({ id: 'doc-1' });
    const tx = {
      documentTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'template-lines',
          isActive: true,
          bodyTemplate: '<h1>{{order.orderNumber}}</h1><table>{{order.linesTable}}</table>',
        }),
      },
      generatedDocument: { create: generatedDocumentCreate },
    } as any;

    await createOrderContractDocument({
      templateId: 'template-lines',
      tx,
      customer: { id: 'c1', name: '客户一' } as any,
      quotation: { id: 'q1', partNumber: 'HEADER', quantity: 99, unitPrice: 0, totalPrice: 0 } as any,
      order: {
        id: 'o1', orderNumber: 'SO-1', quotationId: 'q1', lineItemsMode: true,
        lines: [{ id: 'ol-1', partNumber: 'PN-100', quantity: 2, unitPrice: '10', lineTotal: '20', currency: 'USD' }],
      } as any,
    });
    const body = generatedDocumentCreate.mock.calls[0][0].data.contentHtml as string;
    expect(body).toContain('PN-100');
    expect(body).not.toContain('HEADER');
  });
});
