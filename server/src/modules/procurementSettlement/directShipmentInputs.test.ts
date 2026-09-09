import { describe, expect, it } from 'vitest';
import {
  createDirectShipmentSchema,
  directShipmentActionSchema,
  directShipmentReceiptSchema,
  reviewDirectShipmentSchema,
} from './directShipmentInputs.js';

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

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    purchaseCommitmentId: 'purchase-1',
    purchaseVersion: 2,
    carrier: 'Carrier',
    trackingNumber: 'TRACK-1',
    origin: 'Supplier warehouse',
    destination: 'Customer airport',
    reason: 'supplier direct fulfilment',
    evidenceIds: ['file-1'],
    lines: [{ purchaseCommitmentLineId: 'purchase-line-1', physical: physical() }],
    ...overrides,
  };
}

function reviewInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    snapshotHash: 'a'.repeat(64),
    decision: 'APPROVED',
    reason: 'all direct shipment checks passed',
    checks: {
      identity: true,
      documents: true,
      conditionAndLife: true,
      customerRequirements: true,
    },
    ...overrides,
  };
}

function receiptInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    quantity: 2,
    signedBy: 'Customer receiving desk',
    signedAt: '2026-09-09T10:30:00+08:00',
    reason: 'customer signed delivery receipt',
    evidenceIds: ['proof-1'],
    ...overrides,
  };
}

describe('direct shipment input schemas', () => {
  it('accepts a strict create payload and reuses the shared physical facts schema', () => {
    const parsed = createDirectShipmentSchema.parse(createInput({
      purchaseCommitmentId: '  purchase-1  ',
      lines: [{ purchaseCommitmentLineId: '  purchase-line-1 ', physical: physical({ uom: 'ea' }) }],
    }));

    expect(parsed.purchaseCommitmentId).toBe('purchase-1');
    expect(parsed.lines[0].purchaseCommitmentLineId).toBe('purchase-line-1');
    expect(parsed.lines[0].physical.uom).toBe('EA');
  });

  it('rejects unknown fields at every command boundary', () => {
    expect(createDirectShipmentSchema.safeParse({ ...createInput(), unexpected: true }).success).toBe(false);
    expect(createDirectShipmentSchema.safeParse(createInput({
      lines: [{ purchaseCommitmentLineId: 'purchase-line-1', physical: { ...physical(), costPrice: 1 } }],
    })).success).toBe(false);
    expect(reviewDirectShipmentSchema.safeParse({ ...reviewInput(), unexpected: true }).success).toBe(false);
    expect(reviewDirectShipmentSchema.safeParse(reviewInput({ checks: { ...reviewInput().checks, extra: true } })).success).toBe(false);
    expect(directShipmentActionSchema.safeParse({ version: 1, reason: 'valid action', unexpected: true }).success).toBe(false);
    expect(directShipmentReceiptSchema.safeParse({ ...receiptInput(), unexpected: true }).success).toBe(false);
  });

  it('trims identifiers but rejects blank or overlong identifiers', () => {
    expect(createDirectShipmentSchema.safeParse(createInput({ purchaseCommitmentId: '   ' })).success).toBe(false);
    expect(createDirectShipmentSchema.safeParse(createInput({ purchaseCommitmentLineId: '   ' })).success).toBe(false);
    expect(createDirectShipmentSchema.safeParse(createInput({ purchaseCommitmentId: 'x'.repeat(201) })).success).toBe(false);
    expect(createDirectShipmentSchema.parse(createInput()).purchaseCommitmentId).toBe('purchase-1');
  });

  it('requires unique evidence for create and signed receipt, while review defaults evidence to empty', () => {
    expect(createDirectShipmentSchema.safeParse(createInput({ evidenceIds: ['file-1', ' file-1 '] })).success).toBe(false);
    expect(directShipmentReceiptSchema.safeParse(receiptInput({ evidenceIds: ['proof-1', 'proof-1'] })).success).toBe(false);
    expect(directShipmentReceiptSchema.safeParse(receiptInput({ evidenceIds: [] })).success).toBe(false);
    expect(reviewDirectShipmentSchema.parse(reviewInput()).evidenceIds).toEqual([]);
    expect(reviewDirectShipmentSchema.safeParse(reviewInput({ evidenceIds: ['proof-1', ' proof-1 '] })).success).toBe(false);
    expect(reviewDirectShipmentSchema.safeParse(reviewInput({ evidenceIds: Array.from({ length: 21 }, (_, i) => `f-${i}`) })).success).toBe(false);
  });

  it('enforces positive Int32 versions and quantities', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(createDirectShipmentSchema.safeParse(createInput({ purchaseVersion: value })).success).toBe(false);
      expect(reviewDirectShipmentSchema.safeParse(reviewInput({ version: value })).success).toBe(false);
      expect(directShipmentActionSchema.safeParse({ version: value, reason: 'valid action' }).success).toBe(false);
      expect(directShipmentReceiptSchema.safeParse(receiptInput({ version: value })).success).toBe(false);
      expect(directShipmentReceiptSchema.safeParse(receiptInput({ quantity: value })).success).toBe(false);
    }
  });

  it('requires a 64-hex snapshot hash, all four boolean checks, and a valid decision', () => {
    expect(reviewDirectShipmentSchema.safeParse(reviewInput({ snapshotHash: 'a'.repeat(63) })).success).toBe(false);
    expect(reviewDirectShipmentSchema.safeParse(reviewInput({ snapshotHash: 'g'.repeat(64) })).success).toBe(false);
    expect(reviewDirectShipmentSchema.parse(reviewInput({ snapshotHash: 'A'.repeat(64) })).snapshotHash).toBe('a'.repeat(64));
    expect(reviewDirectShipmentSchema.safeParse(reviewInput({ decision: 'PENDING' })).success).toBe(false);
    expect(reviewDirectShipmentSchema.safeParse(reviewInput({ checks: { identity: true, documents: true, conditionAndLife: true } })).success).toBe(false);
    expect(reviewDirectShipmentSchema.safeParse(reviewInput({ checks: { ...reviewInput().checks, identity: 'true' } })).success).toBe(false);
  });

  it('keeps signedAt as an offset-aware ISO string and rejects malformed timestamps', () => {
    const parsed = directShipmentReceiptSchema.parse(receiptInput());
    expect(parsed.signedAt).toBe('2026-09-09T10:30:00+08:00');
    expect(directShipmentReceiptSchema.safeParse(receiptInput({ signedAt: '2026-09-09 10:30:00' })).success).toBe(false);
    expect(directShipmentReceiptSchema.safeParse(receiptInput({ signedAt: '2026-09-09T10:30:00' })).success).toBe(false);
  });

  it('requires meaningful reasons and non-empty shipment facts', () => {
    for (const schemaAndInput of [
      [createDirectShipmentSchema, createInput({ reason: '  x  ' })],
      [reviewDirectShipmentSchema, reviewInput({ reason: '  x  ' })],
      [directShipmentActionSchema, { version: 1, reason: '  x  ' }],
      [directShipmentReceiptSchema, receiptInput({ reason: '  x  ' })],
    ] as const) {
      expect(schemaAndInput[0].safeParse(schemaAndInput[1]).success).toBe(false);
    }
    expect(createDirectShipmentSchema.safeParse(createInput({ carrier: ' ' })).success).toBe(false);
    expect(createDirectShipmentSchema.safeParse(createInput({ trackingNumber: ' ' })).success).toBe(false);
    expect(directShipmentReceiptSchema.safeParse(receiptInput({ signedBy: ' ' })).success).toBe(false);
  });
});
