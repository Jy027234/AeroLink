import { describe, expect, it } from 'vitest';
import {
  buildReceiptQualitySnapshot,
  buildReceiptQualitySnapshotHash,
  hashReceiptQualitySnapshot,
  normalizeReceiptPhysical,
  receiptPhysicalSchema,
  validateReceiptQuality,
  type ReceiptCertificateRow,
  type ReceiptModernChain,
  type ReceiptQualityInput,
} from './receiptQuality.js';

const NOW = '2026-09-09T00:00:00.000Z';

function physical(overrides: Record<string, unknown> = {}) {
  return {
    partNumber: 'PN-1',
    uom: 'EA',
    trackingType: 'BATCH',
    quantity: 2,
    batchNumber: 'B-1',
    conditionCode: 'NE',
    ...overrides,
  };
}

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
    fulfillmentMode: 'STOCK_RECEIPT',
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

describe('receiptPhysicalSchema', () => {
  it('is strict and normalizes safe code fields while enforcing tracking identity', () => {
    const parsed = normalizeReceiptPhysical(physical({ trackingType: 'batch', uom: ' ea ', conditionCode: ' ne ' }));
    expect(parsed.trackingType).toBe('BATCH');
    expect(parsed.uom).toBe('EA');
    expect(parsed.conditionCode).toBe('NE');
    expect(receiptPhysicalSchema.safeParse({ ...physical(), unexpectedCost: 12 }).success).toBe(false);
    expect(receiptPhysicalSchema.safeParse(physical({ trackingType: 'SERIAL', quantity: 2, serialNumber: 'S-1' })).success).toBe(false);
    expect(receiptPhysicalSchema.safeParse(physical({ trackingType: 'SERIAL', quantity: 1 })).success).toBe(false);
    expect(receiptPhysicalSchema.safeParse(physical({ batchNumber: null })).success).toBe(false);
  });

  it('requires a valid quantity and does not accept fractional or unsafe values', () => {
    expect(receiptPhysicalSchema.safeParse(physical({ quantity: 1.5 })).success).toBe(false);
    expect(receiptPhysicalSchema.safeParse(physical({ quantity: Number.MAX_SAFE_INTEGER })).success).toBe(false);
    expect(receiptPhysicalSchema.safeParse(physical({ quantity: 0 })).success).toBe(false);
  });
});

describe('receipt quality facts', () => {
  it('accepts a valid batch arrival without exposing purchase cost fields', () => {
    const unsafeChain = {
      ...chain(),
      order: { ...chain().order, unitPrice: 123, totalPrice: 246, unitCost: 12.5 },
      quotationLine: { ...chain().quotationLine, unitPrice: 123, costPrice: 12.5 },
    } as ReceiptModernChain;
    const result = validateReceiptQuality(input({
      chain: unsafeChain,
      purchase: purchase({ unitCost: '12.5000', sourceSnapshot: { type: 'SUPPLIER_QUOTE', unitCost: '12.5000' } }),
    }), { phase: 'ACCEPT' });
    expect(result.canAccept).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.snapshot)).not.toContain('unitCost');
    expect(JSON.stringify(result.snapshot)).not.toContain('sourceSnapshot');
    expect(JSON.stringify(result.snapshot)).not.toContain('totalCost');
    expect(hashReceiptQualitySnapshot(result.snapshot)).toBe(result.snapshotHash);
    expect(buildReceiptQualitySnapshotHash(input({
      purchase: purchase({ unitCost: '12.5000' }),
    }))).toBe(result.snapshotHash);
  });

  it('allows nonconforming condition and life facts to be recorded at arrival, but never accepted', () => {
    const bad = input({ physical: physical({
      conditionCode: 'AR', lifeLimited: true, remainingHours: 0,
      shelfLifeDays: 365, shelfLifeDate: '2020-01-01T00:00:00.000Z',
    }) });
    const arrival = validateReceiptQuality(bad, { phase: 'ARRIVAL' });
    expect(arrival.canAccept).toBe(false);
    expect(arrival.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'CONDITION_MISMATCH', 'SHELF_LIFE_EXPIRED', 'LIFE_REMAINING_INVALID',
    ]));
    expect(() => validateReceiptQuality(bad, { phase: 'ACCEPT' })).toThrow(/收货质量校验失败/);
  });

  it('checks the explicit batch requirement and planned receipt headroom', () => {
    const requiredBatch = input({
      chain: chain({
        orderLine: { ...chain().orderLine, batchNumber: 'REQUIRED-BATCH' },
        quotationLine: { ...chain().quotationLine, batchNumber: 'REQUIRED-BATCH' },
        rfqLine: { ...chain().rfqLine, batchNumber: 'REQUIRED-BATCH' },
      }),
      purchase: purchase({ identitySnapshot: { ...purchase().identitySnapshot, batchNumber: 'REQUIRED-BATCH' } }),
    });
    const arrival = validateReceiptQuality(requiredBatch, { phase: 'ARRIVAL' });
    expect(arrival.issues.map((issue) => issue.code)).toContain('BATCH_MISMATCH');
    expect(() => validateReceiptQuality(input({
      purchase: purchase({ quantity: 2 }),
      physical: physical({ quantity: 3 }),
    }), { phase: 'ACCEPT' })).toThrow(/到货数量超过/);
  });

  it('requires an exact current Certificate row when the order requires certificates', () => {
    const certInput = input({
      physical: physical({
        certificateReferences: [{ id: 'certificate-1', fileHash: 'certificate-hash-1' }],
        certificateType: 'FAA-8130-3', certificateNumber: 'CERT-1',
      }),
      chain: chain({
        order: { ...chain().order, certificateRequired: true, certificateType: 'FAA-8130-3' },
        rfqLine: { ...chain().rfqLine, certificateRequired: true, certificateType: 'FAA-8130-3' },
      }),
      purchase: purchase({ identitySnapshot: { ...purchase().identitySnapshot, certificateRequired: true, certificateType: 'FAA-8130-3' } }),
      certificates: [certificate()],
    });
    const accepted = validateReceiptQuality(certInput, { phase: 'ACCEPT' });
    expect(accepted.canAccept).toBe(true);
    expect(validateReceiptQuality({ ...certInput, certificates: [certificate({ orderId: null })] }, { phase: 'ACCEPT' }).canAccept).toBe(true);
    expect(() => validateReceiptQuality({ ...certInput, certificates: [certificate({ orderId: 'other-order' })] }, { phase: 'ACCEPT' })).toThrow(/supplier\/order/);
    expect(accepted.snapshot.certificates[0]).toMatchObject({
      id: 'certificate-1', fileHash: 'certificate-hash-1', inventoryDetailId: null,
    });

    expect(() => validateReceiptQuality({
      ...certInput,
      physical: physical({
        certificateReferences: [{ id: 'certificate-1', fileHash: 'wrong-file-hash' }],
        certificateType: 'FAA-8130-3', certificateNumber: 'CERT-1',
      }),
    }, { phase: 'ACCEPT' })).toThrow(/证书文件指纹/);
    expect(() => validateReceiptQuality({
      ...certInput,
      certificates: [certificate({ supplierId: 'other-supplier' })],
    }, { phase: 'ACCEPT' })).toThrow(/supplier\/order/);
    expect(() => validateReceiptQuality({
      ...certInput,
      certificates: [certificate({ inventoryDetailId: 'already-bound-detail' })],
    }, { phase: 'ACCEPT' })).toThrow(/已经绑定库存/);
  });

  it('allows an unbound certificate but rejects stale, expired, or mismatched certificate facts', () => {
    const certInput = input({
      physical: physical({ certificateReferences: [{ id: 'certificate-1', fileHash: 'certificate-hash-1' }], certificateType: 'FAA-8130-3' }),
      chain: chain({ order: { ...chain().order, inspectionRequired: true } }),
      certificates: [certificate()],
    });
    expect(validateReceiptQuality(certInput, { phase: 'ACCEPT' }).canAccept).toBe(true);
    for (const changed of [
      certificate({ status: 'EXPIRED' }),
      certificate({ status: 'DRAFT' }),
      certificate({ status: 'UNKNOWN' }),
      certificate({ expiryDate: '2020-01-01T00:00:00.000Z' }),
      certificate({ batchNumber: 'OTHER-BATCH' }),
      certificate({ certificateType: 'OTHER' }),
      certificate({ fileHash: null }),
    ]) {
      expect(() => validateReceiptQuality({ ...certInput, certificates: [changed] }, { phase: 'ACCEPT' })).toThrow();
    }
  });

  it('fails closed on broken modern source relations and non-stock receipt modes', () => {
    expect(() => validateReceiptQuality(input({ chain: chain({ order: { ...chain().order, lineItemsMode: false } }) }), { phase: 'ARRIVAL' }))
      .toThrow(/现代多行/);
    expect(() => validateReceiptQuality(input({
      purchase: purchase({ fulfillmentMode: 'SUPPLIER_DIRECT' }),
    }), { phase: 'ARRIVAL' })).toThrow(/STOCK_RECEIPT/);
    expect(() => validateReceiptQuality(input({
      purchase: purchase({ orderId: 'other-order' }),
    }), { phase: 'ARRIVAL' })).toThrow(/来源关系/);
  });

  it('hashes certificate references and current rows in stable order', () => {
    const second = certificate({ id: 'certificate-2', certificateNumber: 'CERT-2', fileHash: 'certificate-hash-2' });
    const firstInput = input({
      physical: physical({ certificateReferences: [
        { id: 'certificate-2', fileHash: 'certificate-hash-2' },
        { id: 'certificate-1', fileHash: 'certificate-hash-1' },
      ] }),
      chain: chain({ order: { ...chain().order, inspectionRequired: true } }),
      certificates: [second, certificate()],
    });
    const secondInput = {
      ...firstInput,
      physical: physical({ certificateReferences: [
        { id: 'certificate-1', fileHash: 'certificate-hash-1' },
        { id: 'certificate-2', fileHash: 'certificate-hash-2' },
      ] }),
      certificates: [certificate(), second],
    };
    expect(buildReceiptQualitySnapshotHash(firstInput)).toBe(buildReceiptQualitySnapshotHash(secondInput));
  });
});
