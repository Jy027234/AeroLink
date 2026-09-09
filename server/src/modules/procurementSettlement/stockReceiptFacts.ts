import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { normalizeReceiptPhysical, validateReceiptQuality, type ReceiptQualityInput } from './receiptQuality.js';

/** Load identities from the actual relational chain. Supplier quotes and
 * commercial costs deliberately do not enter the quality projection. */
export async function loadStockReceiptFacts(tx: Prisma.TransactionClient, purchaseLineId: string, physicalInput: unknown,
  phase: 'ARRIVAL' | 'ACCEPT', now = new Date()) {
  const physical = normalizeReceiptPhysical(physicalInput);
  const line = await tx.purchaseCommitmentLine.findUnique({ where: { id: purchaseLineId }, include: {
    purchaseCommitment: true,
    orderLine: { include: { order: { include: { quotation: { include: { rfq: true } } } },
      quotationLine: { include: { rfqLine: true } } } },
  } });
  if (!line) throw new AppError('采购来源行不存在', 404, 'RESOURCE_NOT_FOUND');
  const orderLine = line.orderLine; const order = orderLine.order;
  const quotation = order.quotation; const quotationLine = orderLine.quotationLine; const rfqLine = quotationLine.rfqLine;
  if (!rfqLine) throw new AppError('采购缺少真实询价行来源', 409, 'RESOURCE_CONFLICT');
  const certificates = await tx.certificate.findMany({ where: { id: { in: physical.certificateReferences.map(row => row.id) } }, select: {
    id: true, certificateNumber: true, partNumber: true, serialNumber: true, batchNumber: true, certificateType: true,
    status: true, expiryDate: true, fileHash: true, supplierId: true, orderId: true, inventoryDetailId: true, updatedAt: true,
  } });
  const input: ReceiptQualityInput = { physical, now, certificates,
    chain: {
      order: { id: order.id, quotationId: order.quotationId, lineItemsMode: order.lineItemsMode, currency: quotation.currency,
        saleType: order.saleType, certificateRequired: order.certificateRequired, certificateType: order.certificateType,
        inspectionRequired: order.inspectionRequired },
      orderLine: { id: orderLine.id, orderId: orderLine.orderId, quotationLineId: orderLine.quotationLineId,
        partNumber: orderLine.partNumber, uom: orderLine.uom, quantity: orderLine.quantity,
        serialNumber: orderLine.serialNumber, batchNumber: orderLine.batchNumber, currency: orderLine.currency },
      quotation: { id: quotation.id, rfqId: quotation.rfqId, currency: quotation.currency },
      quotationLine: { id: quotationLine.id, quotationId: quotationLine.quotationId, rfqLineId: quotationLine.rfqLineId,
        partNumber: quotationLine.partNumber, uom: quotationLine.uom, quantity: quotationLine.quantity,
        acceptedQuantity: quotationLine.acceptedQuantity, serialNumber: quotationLine.serialNumber,
        batchNumber: quotationLine.batchNumber, currency: quotationLine.currency },
      rfqLine: { id: rfqLine.id, rfqId: rfqLine.rfqId, partNumber: rfqLine.partNumber, uom: rfqLine.uom,
        quantity: rfqLine.quantity, conditionCode: rfqLine.conditionCode, serialNumber: rfqLine.serialNumber,
        batchNumber: rfqLine.batchNumber, certificateRequired: rfqLine.certificateRequired,
        certificateType: rfqLine.certificateType, alternatePartNumbers: rfqLine.alternatePartNumbers },
      rfq: { id: quotation.rfq.id, lineItemsMode: quotation.rfq.lineItemsMode },
    },
    purchase: { purchaseCommitmentId: line.purchaseCommitmentId, purchaseCommitmentLineId: line.id,
      orderId: line.purchaseCommitment.orderId, supplierId: line.purchaseCommitment.supplierId,
      orderLineId: line.orderLineId, partNumber: line.partNumber, uom: line.uom, quantity: line.quantity,
      cancelledQuantity: line.cancelledQuantity, receivedQuantity: line.receivedQuantity, directShippedQuantity: line.directShippedQuantity,
      fulfillmentMode: line.fulfillmentMode, identitySnapshot: line.identitySnapshot },
  };
  const review = validateReceiptQuality(input, { phase });
  return { line, review, physical };
}
