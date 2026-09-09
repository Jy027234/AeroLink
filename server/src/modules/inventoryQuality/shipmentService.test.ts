import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
vi.mock('../../lib/outboxService.js', () => ({ enqueueBusinessEvent: vi.fn() }));
import { createShipment, getOrderShipments, receiveShipment } from './shipmentService.js';

const actor = { id: 'manager', role: 'MANAGER', department: 'Sales' };
function fixture() {
  const order = { id: 'order', status: 'SHIPPED', version: 1, lineItemsMode: true, quantity: 4, outboundQuantity: 4, directShippedQuantity: 0,
    quotation: { createdBy: 'sales', creator: { department: 'Sales' } },
    lines: [{ id: 'oline', quantity: 4, outboundQuantity: 4, directShippedQuantity: 0 }] };
  const detail = { id: 'detail', inventoryItemId: 'item', serialNumber: null, batchNumber: 'B1', conditionCode: 'NE',
    warehouse: null, location: 'A1', certificateType: 'NONE', certificateNumber: null, certificateFileUrl: null,
    lifeLimited: false, remainingHours: null, remainingCycles: null, shelfLifeDate: null, shelfLifeDays: null,
    nextOverhaulDue: null, storageCondition: null, type: 'OWN', inventoryItem: { partNumber: 'PN1', trackingType: 'BATCH' } };
  const review = { id: 'review', approved: true, consumedAt: new Date(), assignmentId: 'assignment', orderId: 'order',
    inventoryDetailId: 'detail', quantity: 4, snapshotHash: 'a'.repeat(64), evidence: [],
    snapshot: { inventory: { ...detail, partNumber: 'PN1', trackingType: 'BATCH' }, certificates: [],
      order: { certificateRequired: false }, rfqLine: { certificateRequired: false } } };
  const source = { id: 'outbound', type: 'OUTBOUND', quantity: -4, orderId: 'order', inventoryDetailId: 'detail',
    allocationId: 'allocation', assignmentId: 'assignment', fulfillmentReviewId: 'review', inventoryDetail: detail,
    assignment: { id: 'assignment', allocationId: 'allocation', orderLineId: 'oline', orderLine: { orderId: 'order' } }, fulfillmentReview: review };
  const created = { id: 'shipment', shipmentNumber: 'SHP1', orderId: 'order', carrier: 'Carrier', trackingNumber: 'T1',
    origin: 'A', destination: 'B', status: 'DISPATCHED', version: 1, shippedAt: new Date(), evidence: {},
    lines: [{ id: 'sline', shipmentId: 'shipment', lineNo: 1, orderLineId: 'oline', assignmentId: 'assignment',
      outboundTransactionId: 'outbound', quantity: 2, receivedQuantity: 0, returnedQuantity: 0, version: 1, identitySnapshot: {}, returnHolds: [] }] };
  const mocks = {
    order: { findUnique: vi.fn().mockResolvedValue(order), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    inventoryTransaction: { findMany: vi.fn().mockResolvedValue([source]), create: vi.fn() },
    inventoryDetail: { update: vi.fn(), updateMany: vi.fn() },
    shipment: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(created), findUniqueOrThrow: vi.fn().mockResolvedValue(created), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    shipmentLine: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    shipmentEvent: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'event' }) },
    storedObject: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    certificate: { findMany: vi.fn().mockResolvedValue([]) },
    supplierDirectShipmentLine: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const tx = mocks as unknown as Prisma.TransactionClient;
  const input = { tx, actor, orderId: 'order', carrier: 'Carrier', trackingNumber: 'T1', origin: 'A', destination: 'B',
    lines: [{ outboundTransactionId: 'outbound', quantity: 2 }], evidenceIds: [] as string[], commandId: 'command' };
  return { order, source, detail, review, created, mocks, tx, input };
}

describe('modern shipment sources', () => {
  it('binds a slice of actual outbound without a second stock deduction', async () => {
    const f = fixture();
    const result = await createShipment(f.input);
    expect(result.id).toBe('shipment');
    expect(f.mocks.inventoryTransaction.create).not.toHaveBeenCalled();
    expect(f.mocks.inventoryDetail.updateMany).not.toHaveBeenCalled();
    const data = f.mocks.shipment.create.mock.calls[0][0].data;
    expect(data.lines.create[0]).toMatchObject({ orderLineId: 'oline', assignmentId: 'assignment', outboundTransactionId: 'outbound', quantity: 2 });
    expect(data.evidence.qualityReviews[0].reviewId).toBe('review');
    expect(JSON.stringify(result)).not.toMatch(/unitCost|costPrice|totalAmount/);
  });
  it('refuses to guess a historical outbound quality-review mapping', async () => {
    const f = fixture();
    Object.assign(f.source, { fulfillmentReviewId: null, fulfillmentReview: null });
    await expect(createShipment(f.input)).rejects.toMatchObject({ code: 'SHIPMENT_BLOCKED' });
    expect(f.mocks.shipment.create).not.toHaveBeenCalled();
  });
  it('rejects a review belonging to another physical source', async () => {
    const f = fixture();
    f.review.inventoryDetailId = 'different-detail';
    await expect(createShipment(f.input)).rejects.toMatchObject({ code: 'SHIPMENT_BLOCKED' });
  });
  it('rejects slices over the remaining quantity of their actual ledger row', async () => {
    const f = fixture();
    f.mocks.shipmentLine.findMany.mockResolvedValue([{ id: 'previous', outboundTransactionId: 'outbound', quantity: 3 }]);
    await expect(createShipment(f.input)).rejects.toMatchObject({ code: 'ALLOCATION_INCONSISTENT' });
  });
  it('rejects stale original quality evidence', async () => {
    const f = fixture();
    Object.assign(f.review, { evidence: [{ id: 'file', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE' }] });
    f.mocks.storedObject.findMany.mockResolvedValue([{ id: 'file', version: 2, sha256: 'b'.repeat(64), status: 'AVAILABLE' }]);
    await expect(createShipment(f.input)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
  });
  it('requires the certificate type explicitly declared on the physical inventory', async () => {
    const f = fixture();
    f.detail.certificateType = 'FAA-8130-3';
    f.review.snapshot.inventory.certificateType = 'FAA-8130-3';
    await expect(createShipment(f.input)).rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_REQUIRED' });
  });
  it('does not let an unrelated attachment become delivery evidence', async () => {
    const f = fixture();
    f.input.evidenceIds.push('unrelated');
    f.mocks.storedObject.findMany.mockResolvedValueOnce([{ id: 'unrelated', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE' }]).mockResolvedValueOnce([]);
    await expect(createShipment(f.input)).rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
  });
  it('replays a permanent command only when the normalized input matches', async () => {
    const f = fixture();
    await createShipment(f.input);
    const data = f.mocks.shipment.create.mock.calls[0][0].data;
    f.mocks.shipment.findUnique.mockResolvedValue({ ...f.created, requestHash: data.requestHash });
    await createShipment({ ...f.input, carrier: ' Carrier ' });
    await expect(createShipment({ ...f.input, trackingNumber: 'different' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(f.mocks.shipment.create).toHaveBeenCalledTimes(1);
  });
  it('returns a safe partial delivery projection to quality staff without quotation access', async () => {
    const f = fixture();
    f.created.lines[0].receivedQuantity = 1;
    f.mocks.shipment.findMany.mockResolvedValue([f.created]);
    const view = await getOrderShipments({ tx: f.tx, actor: { id: 'quality', role: 'QUALITY_MANAGER' }, orderId: 'order' });
    expect(view.delivery).toMatchObject({ complete: false, requiredQuantity: 4, receivedQuantity: 1 });
    expect(view.outboundTransactions[0]).toMatchObject({ boundQuantity: 2, availableQuantity: 2 });
    expect(JSON.stringify(view)).not.toMatch(/unitCost|costPrice|totalAmount|requestHash|commandId/);
  });
  it('marks a mixed local and supplier-direct order complete only after both sources are received', async () => {
    const f = fixture();
    f.order.quantity = 6;
    f.order.outboundQuantity = 4;
    f.order.directShippedQuantity = 2;
    f.order.lines[0].quantity = 6;
    f.order.lines[0].outboundQuantity = 4;
    f.order.lines[0].directShippedQuantity = 2;
    f.created.lines[0].quantity = 4;
    f.created.lines[0].receivedQuantity = 4;
    f.mocks.shipment.findMany.mockResolvedValue([f.created]);
    f.mocks.supplierDirectShipmentLine.findMany.mockResolvedValue([{
      quantity: 2,
      receivedQuantity: 2,
      reviewStatus: 'APPROVED',
      purchaseCommitmentLine: { orderLineId: 'oline' },
    }]);

    const view = await getOrderShipments({ tx: f.tx, actor: { id: 'quality', role: 'QUALITY_MANAGER' }, orderId: 'order' });

    expect(f.mocks.supplierDirectShipmentLine.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ purchaseCommitmentLine: { orderLineId: { in: ['oline'] } } }),
    }));
    expect(view.delivery).toMatchObject({ complete: true, requiredQuantity: 6, receivedQuantity: 6, remainingQuantity: 0 });
    expect(view.outboundTransactions[0]).toMatchObject({ quantity: 4, boundQuantity: 4 });
  });
  it('enforces current order scope for operational users', async () => {
    const f = fixture();
    await expect(getOrderShipments({ tx: f.tx, actor: { id: 'peer', role: 'SALES', department: 'Other' }, orderId: 'order' })).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });
});

describe('shipment receipts', () => {
  it.each(['DELIVERED', 'COMPLETED', 'CANCELLED'])('rejects new receipt commands for a %s order', async status => {
    const f = fixture();
    f.order.status = status;
    f.mocks.shipment.findUnique.mockResolvedValue(f.created);
    await expect(receiveShipment({ tx: f.tx, actor, shipmentId: 'shipment', lines: [{ shipmentLineId: 'sline', quantity: 1 }],
      evidenceIds: ['proof'], reason: 'Signed delivery proof', commandId: 'receipt' })).rejects.toMatchObject({ code: 'SHIPMENT_BLOCKED' });
    expect(f.mocks.shipmentLine.updateMany).not.toHaveBeenCalled();
  });
  it('cannot confirm quantity above this shipment line even when the order has more', async () => {
    const f = fixture();
    f.mocks.shipment.findUnique.mockResolvedValue(f.created);
    f.mocks.storedObject.findMany.mockResolvedValue([{ id: 'proof', version: 1, sha256: 'c'.repeat(64), status: 'AVAILABLE', ownerId: actor.id, domain: 'uploads', resourceId: null }]);
    await expect(receiveShipment({ tx: f.tx, actor, shipmentId: 'shipment', lines: [{ shipmentLineId: 'sline', quantity: 3 }],
      evidenceIds: ['proof'], reason: 'Signed delivery proof', commandId: 'receipt' })).rejects.toMatchObject({ code: 'SHIPMENT_BLOCKED' });
    expect(f.mocks.shipmentLine.updateMany).not.toHaveBeenCalled();
  });
  it('requires the receiver to own the submitted receipt evidence', async () => {
    const f = fixture();
    f.mocks.shipment.findUnique.mockResolvedValue(f.created);
    f.mocks.storedObject.findMany.mockResolvedValue([{ id: 'proof', version: 1, sha256: 'c'.repeat(64), status: 'AVAILABLE', ownerId: 'other', domain: 'uploads', resourceId: null }]);
    await expect(receiveShipment({ tx: f.tx, actor, shipmentId: 'shipment', lines: [{ shipmentLineId: 'sline', quantity: 1 }],
      evidenceIds: ['proof'], reason: 'Signed delivery proof', commandId: 'receipt' })).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });
  it('rejects the receiver\'s own evidence when it belongs to a different order', async () => {
    const f = fixture();
    f.mocks.shipment.findUnique.mockResolvedValue(f.created);
    f.mocks.storedObject.findMany.mockResolvedValue([{ id: 'proof', version: 2, sha256: 'c'.repeat(64),
      status: 'AVAILABLE', ownerId: actor.id, domain: 'order', resourceId: 'another-order' }]);
    await expect(receiveShipment({ tx: f.tx, actor, shipmentId: 'shipment', lines: [{ shipmentLineId: 'sline', quantity: 1 }],
      evidenceIds: ['proof'], reason: 'Signed delivery proof', commandId: 'receipt' })).rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
    expect(f.mocks.storedObject.updateMany).not.toHaveBeenCalled();
    expect(f.mocks.shipmentLine.updateMany).not.toHaveBeenCalled();
  });
});
