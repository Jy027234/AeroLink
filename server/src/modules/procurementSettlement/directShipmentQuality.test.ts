import { describe, expect, it } from 'vitest';
import {
  assertDirectShipmentApprovalSnapshot,
  buildDirectShipmentApprovalSnapshot,
  hashDirectShipmentApprovalSnapshot,
  validateDirectShipmentQuality,
  type DirectShipmentApprovalSnapshot,
} from './directShipmentQuality.js';
import type { ReceiptCertificateRow, ReceiptModernChain, ReceiptQualityInput } from './receiptQuality.js';

const NOW = '2026-09-09T00:00:00.000Z';

function chain(overrides: Partial<ReceiptModernChain> = {}): ReceiptModernChain {
  const base: ReceiptModernChain = {
    order: {
      id: 'order-1', quotationId: 'quotation-1', lineItemsMode: true, currency: 'USD', saleType: 'Sale',
      certificateRequired: false, certificateType: null, inspectionRequired: false,
    },
    orderLine: {
      id: 'order-line-1', orderId: 'order-1', quotationLineId: 'quotation-line-1', partNumber: 'PN-1',
      uom: 'EA', quantity: 5, serialNumber: null, batchNumber: null, currency: 'USD',
    },
    quotation: { id: 'quotation-1', rfqId: 'rfq-1', currency: 'USD' },
    quotationLine: {
      id: 'quotation-line-1', quotationId: 'quotation-1', rfqLineId: 'rfq-line-1', partNumber: 'PN-1',
      uom: 'EA', quantity: 5, acceptedQuantity: 5, serialNumber: null, batchNumber: null, currency: 'USD',
    },
    rfqLine: {
      id: 'rfq-line-1', rfqId: 'rfq-1', partNumber: 'PN-1', uom: 'EA', quantity: 5,
      conditionCode: 'NE', serialNumber: null, batchNumber: null, certificateRequired: false,
      certificateType: null, alternatePartNumbers: null,
    },
    rfq: { id: 'rfq-1', lineItemsMode: true },
  };
  return {
    ...base,
    ...overrides,
    order: { ...base.order, ...overrides.order },
    orderLine: { ...base.orderLine, ...overrides.orderLine },
    quotation: { ...base.quotation, ...overrides.quotation },
    quotationLine: { ...base.quotationLine, ...overrides.quotationLine },
    rfqLine: { ...base.rfqLine, ...overrides.rfqLine },
    rfq: overrides.rfq === undefined ? base.rfq : overrides.rfq,
  };
}

function purchase(overrides: Record<string, unknown> = {}) {
  return {
    purchaseCommitmentId: 'purchase-1',
    purchaseCommitmentLineId: 'purchase-line-1',
    orderId: 'order-1',
    supplierId: 'supplier-1',
    orderLineId: 'order-line-1',
    partNumber: 'PN-1',
    uom: 'EA',
    quantity: 5,
    cancelledQuantity: 0,
    receivedQuantity: 0,
    directShippedQuantity: 0,
    fulfillmentMode: 'SUPPLIER_DIRECT',
    identitySnapshot: {
      schemaVersion: 1,
      orderLineId: 'order-line-1',
      quotationLineId: 'quotation-line-1',
      rfqLineId: 'rfq-line-1',
      partNumber: 'PN-1',
      uom: 'EA',
      conditionCode: 'NE',
      serialNumber: null,
      batchNumber: null,
      certificateRequired: false,
      certificateType: null,
    },
    ...overrides,
  };
}

function physical(overrides: Record<string, unknown> = {}) {
  return {
    partNumber: 'PN-1', uom: 'EA', trackingType: 'BATCH', quantity: 2,
    batchNumber: 'B-1', conditionCode: 'NE', ...overrides,
  };
}

function certificate(overrides: Partial<ReceiptCertificateRow> = {}): ReceiptCertificateRow {
  return {
    id: 'certificate-1', certificateNumber: 'CERT-1', partNumber: 'PN-1', serialNumber: null,
    batchNumber: 'B-1', certificateType: 'FAA-8130-3', status: 'ISSUED',
    expiryDate: '2099-01-01T00:00:00.000Z', fileHash: 'certificate-hash-1',
    supplierId: 'supplier-1', orderId: 'order-1', inventoryDetailId: null,
    updatedAt: '2026-09-08T00:00:00.000Z', ...overrides,
  };
}

function input(overrides: Partial<ReceiptQualityInput> = {}): ReceiptQualityInput {
  return {
    physical: physical(),
    chain: chain(),
    purchase: purchase(),
    certificates: [],
    now: NOW,
    ...overrides,
  };
}

describe('directShipmentQuality', () => {
  it('requires the server-enforced SUPPLIER_DIRECT mode and rejects local receipt facts', () => {
    expect(() => validateDirectShipmentQuality(input({
      purchase: purchase({ receivedQuantity: 1 }),
    }), { phase: 'PENDING' })).toThrow(/已有库存收货/);

    expect(() => validateDirectShipmentQuality(input({
      purchase: purchase({ fulfillmentMode: 'STOCK_RECEIPT' }),
    }), { phase: 'PENDING' })).toThrow(/SUPPLIER_DIRECT/);
  });

  it('returns quality issues while pending and fails closed for approval', () => {
    const bad = input({ physical: physical({ conditionCode: 'AR' }) });
    const pending = validateDirectShipmentQuality(bad, { phase: 'PENDING' });
    expect(pending.canAccept).toBe(false);
    expect(pending.issues.map((issue) => issue.code)).toContain('CONDITION_MISMATCH');
    expect(() => validateDirectShipmentQuality(bad, { phase: 'APPROVE' })).toThrow(/收货质量校验失败/);
  });

  it('requires exact current supplier/order certificate ownership for direct approval', () => {
    const certInput = input({
      physical: physical({
        certificateReferences: [{ id: 'certificate-1', fileHash: 'certificate-hash-1' }],
        certificateType: 'FAA-8130-3', certificateNumber: 'CERT-1',
      }),
      chain: chain({ order: { ...chain().order, inspectionRequired: true } }),
      certificates: [certificate()],
    });
    expect(validateDirectShipmentQuality(certInput, { phase: 'APPROVE' }).canAccept).toBe(true);
    for (const changed of [
      { orderId: null },
      { orderId: 'other-order' },
      { supplierId: 'other-supplier' },
      { fileHash: 'other-hash' },
      { status: 'REVOKED' },
      { expiryDate: '2020-01-01T00:00:00.000Z' },
      { inventoryDetailId: 'local-detail-1' },
    ]) {
      expect(() => validateDirectShipmentQuality({ ...certInput, certificates: [certificate(changed)] }, { phase: 'APPROVE' }))
        .toThrow();
    }
  });

  it('keeps approval hash stable across fulfilment counters but changes on quality facts', () => {
    const certInput = input({
      physical: physical({
        certificateReferences: [{ id: 'certificate-1', fileHash: 'certificate-hash-1' }],
        certificateType: 'FAA-8130-3', certificateNumber: 'CERT-1',
      }),
      chain: chain({ order: { ...chain().order, inspectionRequired: true } }),
      certificates: [certificate()],
    });
    const first = validateDirectShipmentQuality(certInput, { phase: 'APPROVE' });
    const afterOtherBatch = validateDirectShipmentQuality({
      ...certInput,
      purchase: purchase({ cancelledQuantity: 1, directShippedQuantity: 2 }),
    }, { phase: 'APPROVE' });
    expect(afterOtherBatch.approvalSnapshotHash).toBe(first.approvalSnapshotHash);

    const changedCertificate = validateDirectShipmentQuality({
      ...certInput,
      certificates: [certificate({ updatedAt: '2026-09-09T00:00:00.000Z' })],
    }, { phase: 'APPROVE' });
    expect(changedCertificate.approvalSnapshotHash).not.toBe(first.approvalSnapshotHash);

    const changedQuantity = validateDirectShipmentQuality({
      ...certInput,
      physical: physical({
        quantity: 1,
        certificateReferences: [{ id: 'certificate-1', fileHash: 'certificate-hash-1' }],
        certificateType: 'FAA-8130-3', certificateNumber: 'CERT-1',
      }),
    }, { phase: 'APPROVE' });
    expect(changedQuantity.approvalSnapshotHash).not.toBe(first.approvalSnapshotHash);
  });

  it('rebuilds and compares immutable approval facts before dispatch', () => {
    const result = validateDirectShipmentQuality(input(), { phase: 'APPROVE' });
    const copy = buildDirectShipmentApprovalSnapshot(result.snapshot);
    expect(hashDirectShipmentApprovalSnapshot(copy)).toBe(result.approvalSnapshotHash);
    expect(() => assertDirectShipmentApprovalSnapshot(copy, result.approvalSnapshot)).not.toThrow();

    const changed = {
      ...copy,
      physical: { ...copy.physical, conditionCode: 'AR' },
    } satisfies DirectShipmentApprovalSnapshot;
    expect(() => assertDirectShipmentApprovalSnapshot(changed, result.approvalSnapshot)).toThrow(/重新审核/);
  });
});
