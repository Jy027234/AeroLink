import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createFulfillmentReview, consumeFulfillmentReview, getFulfillmentReviewContext, type FulfillmentReviewInput } from './fulfillmentReview.js';

function fixture() {
  const order = {
    id: 'order-1', version: 1, inventoryDetailId: 'detail-1', partNumber: 'PN-1', quantity: 10, outboundQuantity: 0,
    status: 'SO_CREATED', serialNumber: null, batchNumber: 'B1', certificateRequired: true, inspectionRequired: false,
    quotation: { createdBy: 'sales-1', inventoryDetailId: 'detail-1', version: 1, rfq: { version: 1, conditionCode: 'NE', certificateRequired: true } },
  };
  const detail = {
    id: 'detail-1', quantity: 10, status: 'RESERVED', conditionCode: 'NE', serialNumber: null, batchNumber: 'B1',
    updatedAt: new Date('2026-09-08T01:00:00Z'), shelfLifeDate: new Date('2099-01-01'), shelfLifeDays: 365,
    nextOverhaulDue: null, lifeLimited: false, remainingHours: null, remainingCycles: null,
    inventoryItem: { partNumber: 'PN-1', trackingType: 'BATCH' },
  };
  const file = { id: 'file-1', version: 1, sha256: 'hash1', status: 'AVAILABLE', ownerId: 'quality-1' };
  const mocks = {
    order: { findUnique: vi.fn().mockImplementation(async () => order) },
    inventoryDetail: { findUnique: vi.fn().mockImplementation(async () => detail) },
    certificate: { findMany: vi.fn().mockResolvedValue([]) },
    storedObject: { findMany: vi.fn().mockImplementation(async () => [file]) },
    fulfillmentReview: { create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'review-1', ...data })), findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return { tx: mocks as unknown as Prisma.TransactionClient, mocks, order, detail, file };
}

async function inputFor(tx: Prisma.TransactionClient): Promise<FulfillmentReviewInput> {
  const context = await getFulfillmentReviewContext(tx, 'order-1', 4);
  return { orderId: 'order-1', quantity: 4, snapshotHash: context.snapshotHash, approved: true, evidenceIds: ['file-1'], verifiedSerialNumber: '', verifiedBatchNumber: 'B1', reason: '核对原始交付文件，寿命项不适用', checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true } };
}

const quality = { id: 'quality-1', role: 'quality_manager' };

describe('trusted fulfillment review', () => {
  it('requires independent quality authority rather than inventory manager permission', async () => {
    const f = fixture(); const input = await inputFor(f.tx);
    await expect(createFulfillmentReview(f.tx, input, { id: 'manager-1', role: 'manager' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(createFulfillmentReview(f.tx, input, { id: 'sales-1', role: 'admin' })).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    expect(f.mocks.fulfillmentReview.create).not.toHaveBeenCalled();
  });

  it('records server-derived reviewer and evidence version and consumes a review once', async () => {
    const f = fixture(); const input = await inputFor(f.tx);
    const review = await createFulfillmentReview(f.tx, input, quality);
    expect(review).toMatchObject({ reviewedById: 'quality-1', quantity: 4, evidence: [{ id: 'file-1', version: 1, sha256: 'hash1', status: 'AVAILABLE' }] });
    f.mocks.fulfillmentReview.findFirst.mockResolvedValue(review);
    await expect(consumeFulfillmentReview(f.tx, 'order-1', 4)).resolves.toBe('review-1');
    f.mocks.fulfillmentReview.updateMany.mockResolvedValue({ count: 0 });
    await expect(consumeFulfillmentReview(f.tx, 'order-1', 4)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });

  it('blocks outbound with no review, a rejected review, or a different approved quantity', async () => {
    const f = fixture();
    for (const review of [null, { approved: false }, { approved: true, quantity: 5 }]) {
      f.mocks.fulfillmentReview.findFirst.mockResolvedValue(review);
      await expect(consumeFulfillmentReview(f.tx, 'order-1', 4)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_REQUIRED' });
    }
    expect(f.mocks.fulfillmentReview.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a document batch mismatch and incomplete checks', async () => {
    const f = fixture(); const input = await inputFor(f.tx);
    await expect(createFulfillmentReview(f.tx, { ...input, verifiedBatchNumber: 'other' }, quality)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_BLOCKED' });
    await expect(createFulfillmentReview(f.tx, { ...input, checks: { ...input.checks, documents: false } }, quality)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_BLOCKED' });
  });

  it('requires evidence when customer documents are mandatory and rejects another owner’s files', async () => {
    const f = fixture(); const input = await inputFor(f.tx);
    f.mocks.storedObject.findMany.mockResolvedValue([]);
    await expect(createFulfillmentReview(f.tx, { ...input, evidenceIds: [] }, quality)).rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_REQUIRED' });
    f.file.ownerId = 'other'; f.mocks.storedObject.findMany.mockResolvedValue([f.file]);
    await expect(createFulfillmentReview(f.tx, input, quality)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('invalidates review when the order changes or a document is replaced', async () => {
    const f = fixture(); const input = await inputFor(f.tx);
    const review = await createFulfillmentReview(f.tx, input, quality);
    f.mocks.fulfillmentReview.findFirst.mockResolvedValue(review);
    f.order.version++;
    await expect(consumeFulfillmentReview(f.tx, 'order-1', 4)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
    f.order.version--; f.file.version++;
    await expect(consumeFulfillmentReview(f.tx, 'order-1', 4)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
    expect(f.mocks.fulfillmentReview.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks shelf life at outbound even if approval happened before expiry', async () => {
    const f = fixture(); const input = await inputFor(f.tx);
    f.detail.shelfLifeDate = new Date('2000-01-01');
    const fresh = await inputFor(f.tx);
    await expect(createFulfillmentReview(f.tx, fresh, quality)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_BLOCKED' });
    await expect(createFulfillmentReview(f.tx, input, quality)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
  });

  it('blocks a serial-tracked quantity greater than one', async () => {
    const f = fixture(); f.detail.inventoryItem.trackingType = 'SERIAL';
    await expect(createFulfillmentReview(f.tx, await inputFor(f.tx), quality)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_BLOCKED' });
  });
});
