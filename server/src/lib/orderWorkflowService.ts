import type { Customer, Order, Prisma, Quotation } from '@prisma/client';
import { normalizeMoney, normalizeOptionalMoney, preferredMoneyValue } from './money.js';
import { createInitialStatusHistory } from './transactionStateService.js';

export function buildSalesOrderNumber() {
  return `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

export async function createOrderFromQuotation(args: {
  tx: Prisma.TransactionClient;
  quotation: Quotation;
  customer: Customer;
  poNumber?: string;
  deliveryDate?: string;
  // P2 新增字段
  saleType?: string;
  incoterm?: string;
  incotermLocation?: string;
  shipToId?: string;
  shipForId?: string;
  warrantyDays?: number;
  warrantyStartDate?: string;
  certificateRequired?: boolean;
  certificateType?: string;
  certificateDelivered?: boolean;
  packagingStandard?: string;
  shippingMethod?: string;
  carrierAccount?: string;
  inspectionRequired?: boolean;
  inspectionPassed?: boolean;
  inspectionDate?: string;
  customsClearanceRequired?: boolean;
  customsDeclarationNo?: string;
  importDuty?: number;
  vatAmount?: number;
  totalLandCost?: number;
  exchangeCoreCharge?: number;
  exchangeCoreDueDate?: string;
  eSignatureCustomer?: string;
  eSignatureSupplier?: string;
  actorId?: string | null;
  reasonCode?: string;
  reason?: string | null;
}) {
  const orderNumber = buildSalesOrderNumber();
  const totalAmountDecimal = normalizeMoney(
    preferredMoneyValue(args.quotation.totalPriceDecimal, args.quotation.totalPrice) ?? args.quotation.totalPrice,
  );
  const importDutyDecimal = normalizeOptionalMoney(args.importDuty);
  const vatAmountDecimal = normalizeOptionalMoney(args.vatAmount);
  const totalLandCostDecimal = normalizeOptionalMoney(args.totalLandCost);
  const exchangeCoreChargeDecimal = normalizeOptionalMoney(args.exchangeCoreCharge);

  const order = await args.tx.order.create({
    data: {
      orderNumber,
      soNumber: orderNumber,
      quotationId: args.quotation.id,
      customerId: args.customer.id,
      partNumber: args.quotation.partNumber,
      quantity: args.quotation.quantity,
      totalAmount: totalAmountDecimal.toNumber(),
      totalAmountDecimal,
      inventoryDetailId: args.quotation.inventoryDetailId,
      serialNumber: args.quotation.serialNumber,
      batchNumber: args.quotation.batchNumber,
      status: 'SO_CREATED',
      poNumber: args.poNumber,
      deliveryDate: args.deliveryDate ? new Date(args.deliveryDate) : null,
      // P2 新增字段
      saleType: args.saleType || 'Sale',
      incoterm: args.incoterm,
      incotermLocation: args.incotermLocation,
      shipToId: args.shipToId,
      shipForId: args.shipForId,
      warrantyDays: args.warrantyDays,
      warrantyStartDate: args.warrantyStartDate ? new Date(args.warrantyStartDate) : null,
      certificateRequired: args.certificateRequired ?? true,
      certificateType: args.certificateType,
      certificateDelivered: args.certificateDelivered ?? false,
      packagingStandard: args.packagingStandard,
      shippingMethod: args.shippingMethod,
      carrierAccount: args.carrierAccount,
      inspectionRequired: args.inspectionRequired ?? false,
      inspectionPassed: args.inspectionPassed,
      inspectionDate: args.inspectionDate ? new Date(args.inspectionDate) : null,
      customsClearanceRequired: args.customsClearanceRequired ?? false,
      customsDeclarationNo: args.customsDeclarationNo,
      importDuty: importDutyDecimal?.toNumber() ?? null,
      importDutyDecimal,
      vatAmount: vatAmountDecimal?.toNumber() ?? null,
      vatAmountDecimal,
      totalLandCost: totalLandCostDecimal?.toNumber() ?? null,
      totalLandCostDecimal,
      exchangeCoreCharge: exchangeCoreChargeDecimal?.toNumber() ?? null,
      exchangeCoreChargeDecimal,
      exchangeCoreDueDate: args.exchangeCoreDueDate ? new Date(args.exchangeCoreDueDate) : null,
      eSignatureCustomer: args.eSignatureCustomer,
      eSignatureSupplier: args.eSignatureSupplier,
    },
    include: {
      customer: true,
    },
  });

  await createInitialStatusHistory(args.tx, {
    entityType: 'ORDER',
    entityId: order.id,
    toStatus: order.status,
    reasonCode: args.reasonCode || 'ORDER_CREATED_FROM_QUOTATION',
    reason: args.reason,
    actorId: args.actorId,
    version: order.version,
  });

  return order;
}

export function mapOrderResponse(order: Order & { customer: Customer }) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    soNumber: order.soNumber,
    poNumber: order.poNumber,
    quotationId: order.quotationId,
    customerId: order.customerId,
    customerName: order.customer.name,
    partNumber: order.partNumber,
    quantity: order.quantity,
    totalAmount: preferredMoneyValue(order.totalAmountDecimal, order.totalAmount) ?? 0,
    status: order.status.toLowerCase(),
    version: order.version,
    createdAt: order.createdAt.toISOString(),
    deliveryDate: order.deliveryDate?.toISOString(),
    trackingNumber: order.trackingNumber,
    carrier: order.carrier,
    // P2 新增字段
    saleType: order.saleType,
    incoterm: order.incoterm,
    incotermLocation: order.incotermLocation,
    shipToId: order.shipToId,
    shipForId: order.shipForId,
    warrantyDays: order.warrantyDays,
    warrantyStartDate: order.warrantyStartDate?.toISOString(),
    certificateRequired: order.certificateRequired,
    certificateType: order.certificateType,
    certificateDelivered: order.certificateDelivered,
    packagingStandard: order.packagingStandard,
    shippingMethod: order.shippingMethod,
    carrierAccount: order.carrierAccount,
    inspectionRequired: order.inspectionRequired,
    inspectionPassed: order.inspectionPassed,
    inspectionDate: order.inspectionDate?.toISOString(),
    customsClearanceRequired: order.customsClearanceRequired,
    customsDeclarationNo: order.customsDeclarationNo,
    importDuty: preferredMoneyValue(order.importDutyDecimal, order.importDuty),
    vatAmount: preferredMoneyValue(order.vatAmountDecimal, order.vatAmount),
    totalLandCost: preferredMoneyValue(order.totalLandCostDecimal, order.totalLandCost),
    exchangeCoreCharge: preferredMoneyValue(order.exchangeCoreChargeDecimal, order.exchangeCoreCharge),
    exchangeCoreDueDate: order.exchangeCoreDueDate?.toISOString(),
    eSignatureCustomer: order.eSignatureCustomer,
    eSignatureSupplier: order.eSignatureSupplier,
    inventoryDetailId: order.inventoryDetailId || undefined,
    serialNumber: order.serialNumber || undefined,
    batchNumber: order.batchNumber || undefined,
    outboundQuantity: order.outboundQuantity,
    outboundStatus: order.outboundStatus,
  };
}
