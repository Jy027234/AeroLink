import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import db from '../lib/prisma.js';
import { runIdempotentOperation } from '../lib/idempotencyService.js';
import { receivePurchaseStock, getStockReceiptReviewContext, reviewPurchaseStock } from '../modules/procurementSettlement/stockReceiptCommands.js';
import { loadAcceptedReceiptCertificates } from '../modules/procurementSettlement/receiptCertificateSources.js';
import { reserveLineInventory, getAllocationFulfillmentContext } from '../modules/inventoryQuality/index.js';

const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_RECEIPT_CERTIFICATES !== 'true' || !['localhost', '127.0.0.1'].includes(url.hostname)
  || url.port !== '55970' || url.pathname !== '/aerolink_procurement_test_receipts_20260909') {
  throw new Error('Explicit opt-in and dedicated local receipt clone on port 55970 required');
}
const tag = randomUUID().slice(0, 8);
const tx = async <T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) => (await runIdempotentOperation({
  actorId: 'synthetic-receipt-certificates', scope: 'synthetic', requestHash: 'synthetic',
}, async transaction => ({ payload: await operation(transaction) }),
{ isolationLevel: 'Serializable', timeout: 20_000, validateDeferredConstraints: true })).payload;

try {
  const source = await db.purchaseCommitmentLine.findFirstOrThrow({ where: { quantity: 2, receivedQuantity: 1,
    cancelledQuantity: 0, purchaseCommitment: { status: 'CONFIRMED', order: { orderNumber: { startsWith: 'D14-CMD-ORDER-' } } } },
    include: { purchaseCommitment: { include: { createdBy: true } }, orderLine: { include: { quotationLine: { include: { rfqLine: true } } } } } });
  const buyer = source.purchaseCommitment.createdBy;
  const quality = await db.user.create({ data: { name: 'Synthetic receipt certificate reviewer', role: 'QUALITY_MANAGER',
    email: `receipt-cert-qc-${tag}@example.invalid`, password: 'unusable', department: buyer.department } });
  const batchNumber = `CERT-BATCH-${tag}`;
  const fileHash = 'd'.repeat(64);
  const certificate = await db.certificate.create({ data: { certificateNumber: `SYNTHETIC-CERT-${tag}`, partNumber: source.partNumber,
    batchNumber, certificateType: 'FAA-8130-3', status: 'DRAFT', fileHash, supplierId: source.purchaseCommitment.supplierId,
    issuedBy: 'Synthetic metadata issuer', issuedById: quality.id } });
  const proof = await db.storedObject.create({ data: { objectKey: `synthetic-receipt-cert/${randomUUID()}`,
    ownerId: buyer.id, sha256: 'e'.repeat(64), sizeBytes: 20, mimeType: 'application/pdf', originalName: 'synthetic-certificate-arrival.pdf' } });
  const arrival = await tx(transaction => receivePurchaseStock({ tx: transaction, actor: buyer, commandId: randomUUID(),
    purchaseCommitmentId: source.purchaseCommitmentId, purchaseVersion: source.purchaseCommitment.version,
    supplierDeliveryReference: `CERT-DELIVERY-${tag}`, reason: 'Synthetic certificate-bearing arrival', evidenceIds: [proof.id],
    lines: [{ purchaseCommitmentLineId: source.id, storage: { location: 'CERT-QC', warehouse: 'SYNTHETIC', shelf: null },
      physical: { partNumber: source.partNumber, uom: source.uom, trackingType: 'BATCH', quantity: 1, serialNumber: null, batchNumber,
        conditionCode: source.orderLine.quotationLine.rfqLine!.conditionCode, certificateReferences: [{ id: certificate.id, fileHash }],
        certificateType: certificate.certificateType, certificateNumber: certificate.certificateNumber, lifeLimited: false,
        remainingHours: null, remainingCycles: null, shelfLifeDate: null, shelfLifeDays: null, nextOverhaulDue: null, storageCondition: null } }] }));
  const line = await db.stockReceiptLine.findFirstOrThrow({ where: { receiptId: arrival.id } });
  const context = await getStockReceiptReviewContext({ tx: db, actor: quality, receiptLineId: line.id });
  assert.equal(context.canAccept, false);
  const input = { receiptLineId: line.id, version: context.version, snapshotHash: context.snapshotHash, decision: 'ACCEPTED' as const,
    reason: 'Synthetic certificate quality acceptance', checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true } };
  await assert.rejects(tx(transaction => reviewPurchaseStock({ tx: transaction, actor: quality, commandId: randomUUID(), ...input })), /证书/);
  await db.certificate.update({ where: { id: certificate.id }, data: { status: 'ISSUED' } });
  await assert.rejects(tx(transaction => reviewPurchaseStock({ tx: transaction, actor: quality, commandId: randomUUID(), ...input })), { code: 'QUALITY_REVIEW_STALE' });
  const currentContext = await getStockReceiptReviewContext({ tx: db, actor: quality, receiptLineId: line.id });
  await tx(transaction => reviewPurchaseStock({ tx: transaction, actor: quality, commandId: randomUUID(), ...input, snapshotHash: currentContext.snapshotHash }));
  const accepted = await db.stockReceiptLine.findUniqueOrThrow({ where: { id: line.id } });
  assert.ok(accepted.inventoryDetailId);
  const reservation = await tx(transaction => reserveLineInventory({ tx: transaction, actor: buyer,
    quotationLineId: source.orderLine.quotationLineId, orderLineId: source.orderLineId,
    allocations: [{ inventoryDetailId: accepted.inventoryDetailId!, quantity: 1, stockReceiptLineId: line.id }], commandId: randomUUID() }));
  const assignment = await db.allocationAssignment.findFirstOrThrow({ where: { allocationId: reservation.allocations[0].id } });
  const outboundContext = await getAllocationFulfillmentContext(db, assignment.id, 1);
  assert.ok(outboundContext.certificates.some(row => row.id === certificate.id && row.fileHash === fileHash));
  const otherSupplier = await db.supplier.findFirstOrThrow({ where: { id: { not: source.purchaseCommitment.supplierId } } });
  const otherOrder = await db.order.findFirstOrThrow({ where: { id: { not: source.purchaseCommitment.orderId } } });
  const otherDetail = await db.inventoryDetail.findFirstOrThrow({ where: { id: { not: accepted.inventoryDetailId } } });
  const changes: Prisma.CertificateUpdateInput[] = [{ fileHash: 'f'.repeat(64) }, { status: 'REVOKED' },
    { expiryDate: new Date('2020-01-01') }, { supplier: { connect: { id: otherSupplier.id } } },
    { order: { connect: { id: otherOrder.id } } }, { inventoryDetail: { connect: { id: otherDetail.id } } }];
  for (const change of changes) {
    await assert.rejects(tx(async transaction => {
      await transaction.certificate.update({ where: { id: certificate.id }, data: change });
      await getAllocationFulfillmentContext(transaction, assignment.id, 1);
    }), { code: 'QUALITY_REVIEW_STALE' });
  }
  assert.equal((await loadAcceptedReceiptCertificates(db, accepted.inventoryDetailId))[0]!.id, certificate.id);
  const final = await db.certificate.findUniqueOrThrow({ where: { id: certificate.id } });
  assert.equal(final.status, 'ISSUED'); assert.equal(final.fileHash, fileHash);
  assert.equal(final.supplierId, source.purchaseCommitment.supplierId); assert.equal(final.orderId, null); assert.equal(final.inventoryDetailId, null);
  console.log(JSON.stringify({ result: 'PASS', tag, receiptId: arrival.id, receiptLineId: line.id, certificateId: certificate.id,
    assignmentId: assignment.id, checks: ['draft certificate blocks receipt acceptance', 'issuance invalidates prior quality context',
      'issued supplier certificate supports independent receipt acceptance', 'D12 resolves exact receipt certificate without reassignment',
      'changed hash, revocation, expiry, supplier, order and inventory ownership each block D12',
      'all negative certificate mutations rolled back'] }, null, 2));
} finally { await db.$disconnect(); }
