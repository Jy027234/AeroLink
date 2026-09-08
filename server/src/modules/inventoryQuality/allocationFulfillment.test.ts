import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  consumeAllocatedInventory,
  createAllocationFulfillmentReview,
  getAllocationFulfillmentContext,
  type AllocationFulfillmentReviewInput,
} from './allocationFulfillment.js';

function fixture() {
  const rfqLine = {
    id: 'rfq-line-1', rfqId: 'rfq-1', lineNo: 1, partNumber: 'PN-1', quantity: 4,
    uom: 'EA', conditionCode: 'NE', alternatePartNumbers: null, certificateRequired: false,
    certificateType: null, requiredDate: new Date('2099-01-01T00:00:00Z'), status: 'OPEN',
    updatedAt: new Date('2026-09-09T00:00:00Z'),
  };
  const rfq = {
    id: 'rfq-1', version: 3, lineItemsMode: true, conditionCode: 'NE',
    certificateRequired: false, certificateType: null,
  };
  const quotation = {
    id: 'quotation-1', rfqId: 'rfq-1', currency: 'USD', saleType: 'Sale',
    createdBy: 'sales-1', rfq, creator: { id: 'sales-1', department: 'sales' },
  };
  const quotationLine = {
    id: 'quotation-line-1', quotationId: 'quotation-1', lineNo: 1, rfqLineId: 'rfq-line-1',
    partNumber: 'PN-1', uom: 'EA', quantity: 4, acceptedQuantity: 4, reservedQuantity: 4,
    status: 'ACCEPTED', currency: 'USD', rfqLine, quotation,
  };
  const order = {
    id: 'order-1', orderNumber: 'SO-1', quotationId: 'quotation-1', customerId: 'customer-1',
    quantity: 4, outboundQuantity: 0, outboundStatus: 'PENDING', status: 'SO_CREATED',
    statusEnum: 'SO_CREATED', version: 1, lineItemsMode: true, saleType: 'Sale',
    certificateRequired: false, certificateType: null, inspectionRequired: false, quotation,
  };
  const orderLine = {
    id: 'order-line-1', orderId: 'order-1', lineNo: 1, quotationLineId: 'quotation-line-1',
    partNumber: 'PN-1', uom: 'EA', quantity: 4, outboundQuantity: 0, outboundStatus: 'PENDING',
    inventoryDetailId: null, serialNumber: null, batchNumber: 'B1', currency: 'USD', order, quotationLine,
  };
  const detail = {
    id: 'detail-1', inventoryItemId: 'item-1', quantity: 10, allocatedQuantity: 4,
    status: 'RESERVED', conditionCode: 'NE', serialNumber: null, batchNumber: 'B1', type: 'OWN',
    certificateType: 'NONE', certificateNumber: null, certificateFileUrl: null,
    lifeLimited: false, remainingHours: null, remainingCycles: null, shelfLifeDate: null,
    shelfLifeDays: null, nextOverhaulDue: null, storageCondition: null,
    updatedAt: new Date('2026-09-09T00:00:00Z'),
    inventoryItem: { id: 'item-1', partNumber: 'PN-1', trackingType: 'BATCH', updatedAt: new Date('2026-09-09T00:00:00Z') },
    allocations: [] as any[],
  };
  const allocation = {
    id: 'allocation-1', quotationLineId: 'quotation-line-1', inventoryDetailId: 'detail-1',
    allocatedQuantity: 4, releasedQuantity: 0, consumedQuantity: 0, version: 1,
    createdById: 'inventory-manager-1', commandId: 'reserve-1', commandLineNo: 1,
    inventoryDetail: detail, quotationLine, assignments: [] as any[],
  };
  const assignment = {
    id: 'assignment-1', allocationId: 'allocation-1', orderLineId: 'order-line-1',
    assignedQuantity: 4, releasedQuantity: 0, consumedQuantity: 0, version: 1,
    commandId: 'assign-1', commandLineNo: 1, createdById: 'inventory-manager-1',
    allocation, orderLine,
  };
  allocation.assignments = [assignment];
  detail.allocations = [allocation];

  const file = { id: 'file-1', objectKey: 'quality/file-1', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE', ownerId: 'quality-1' };
  const txState: any = {
    assignment,
    allocation,
    detail,
    order,
    orderLine,
    file,
  };
  const mocks = {
    allocationAssignment: {
      findUnique: vi.fn().mockImplementation(async () => txState.assignment),
      findMany: vi.fn().mockImplementation(async () => [txState.assignment]),
      updateMany: vi.fn().mockImplementation(async ({ data }: any) => {
        txState.assignment.consumedQuantity = data.consumedQuantity?.increment !== undefined
          ? txState.assignment.consumedQuantity + data.consumedQuantity.increment
          : data.consumedQuantity;
        txState.assignment.version += data.version?.increment ?? 0;
        return { count: 1 };
      }),
    },
    inventoryAllocation: {
      updateMany: vi.fn().mockImplementation(async ({ data }: any) => {
        txState.allocation.consumedQuantity = data.consumedQuantity?.increment !== undefined
          ? txState.allocation.consumedQuantity + data.consumedQuantity.increment
          : data.consumedQuantity;
        txState.allocation.version += data.version?.increment ?? 0;
        return { count: 1 };
      }),
    },
    inventoryDetail: {
      updateMany: vi.fn().mockImplementation(async ({ data }: any) => {
        txState.detail.quantity -= data.quantity.decrement;
        txState.detail.allocatedQuantity -= data.allocatedQuantity.decrement;
        return { count: 1 };
      }),
    },
    certificate: { findMany: vi.fn().mockResolvedValue([]) },
    storedObject: { findMany: vi.fn().mockResolvedValue([file]) },
    fulfillmentReview: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'review-1', ...data })),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inventoryTransaction: { create: vi.fn().mockResolvedValue({ id: 'transaction-1', type: 'OUTBOUND' }) },
    inventoryAllocationEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1', kind: 'CONSUME' }) },
    orderLine: {
      findMany: vi.fn().mockImplementation(async () => [txState.orderLine]),
      updateMany: vi.fn().mockImplementation(async ({ data }: any) => {
        txState.orderLine.outboundQuantity = data.outboundQuantity;
        txState.orderLine.outboundStatus = data.outboundStatus;
        return { count: 1 };
      }),
    },
    order: {
      updateMany: vi.fn().mockImplementation(async ({ data }: any) => {
        txState.order.outboundQuantity = data.outboundQuantity;
        txState.order.outboundStatus = data.outboundStatus;
        txState.order.version += data.version?.increment ?? 0;
        return { count: 1 };
      }),
      findUnique: vi.fn().mockImplementation(async () => txState.order),
    },
    transactionStatusHistory: { create: vi.fn() },
    outboxEvent: { create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: `outbox-${data.channel}`, ...data })) },
  };
  const tx = mocks as unknown as Prisma.TransactionClient;
  return { tx, mocks, txState, file };
}

async function approvedReviewInput(tx: Prisma.TransactionClient): Promise<AllocationFulfillmentReviewInput> {
  const context = await getAllocationFulfillmentContext(tx, 'assignment-1', 2);
  return {
    assignmentId: 'assignment-1', quantity: 2, snapshotHash: context.snapshotHash,
    evidenceIds: ['file-1'], verifiedSerialNumber: '', verifiedBatchNumber: 'B1',
    checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
    reason: '已核对订单行、批次和交付文件',
  };
}

const qualityActor = { id: 'quality-1', role: 'quality_manager' };
const inventoryActor = { id: 'operator-1', role: 'manager', department: 'sales' };

describe('D12 allocation fulfillment', () => {
  it('binds the public review snapshot to the real line chain and omits cost facts', async () => {
    const fixtureState = fixture();
    const context = await getAllocationFulfillmentContext(fixtureState.tx, 'assignment-1', 2);
    expect(context.snapshot.assignment).toMatchObject({ id: 'assignment-1', allocationId: 'allocation-1', orderLineId: 'order-line-1', version: 1 });
    expect(context.snapshot.quotationLine).toMatchObject({ id: 'quotation-line-1', rfqLineId: 'rfq-line-1' });
    expect(context.snapshot.rfqLine).toMatchObject({ id: 'rfq-line-1', rfqId: 'rfq-1' });
    expect(context.snapshot.inventory).toMatchObject({ id: 'detail-1', partNumber: 'PN-1', allocatedQuantity: 4 });
    expect(JSON.stringify(context.snapshot)).not.toContain('unitCost');
    expect(JSON.stringify(context.snapshot)).not.toContain('costPrice');
    expect(JSON.stringify(context.snapshot)).not.toContain('unitPrice');
    expect(JSON.stringify(context)).not.toContain('unitCost');
    expect(JSON.stringify(context)).not.toContain('costPrice');
    expect(JSON.stringify(context)).not.toContain('unitPrice');
    expect(context.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    void fixtureState;
  });

  it('requires an independent quality reviewer and records evidence fingerprints', async () => {
    const f = fixture();
    const input = await approvedReviewInput(f.tx);
    await expect(createAllocationFulfillmentReview(f.tx, input, { id: 'inventory-manager-1', role: 'quality_manager' })).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    const review = await createAllocationFulfillmentReview(f.tx, input, qualityActor);
    expect(review).toMatchObject({ assignmentId: 'assignment-1', orderId: 'order-1', quantity: 2, reviewedById: 'quality-1' });
    expect(review.evidence).toEqual([{ id: 'file-1', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE' }]);
    expect(f.mocks.fulfillmentReview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ assignmentId: 'assignment-1', inventoryDetailId: 'detail-1' }) }));
  });

  it('allows a modern open batch line to bind the assignment batch during review', async () => {
    const f = fixture();
    f.txState.orderLine.batchNumber = null;
    const input = await approvedReviewInput(f.tx);
    await expect(createAllocationFulfillmentReview(f.tx, input, qualityActor)).resolves.toMatchObject({ assignmentId: 'assignment-1', quantity: 2 });
  });

  it.each([{ partNumber: 'OTHER' }, { batchNumber: 'OTHER' }, { serialNumber: 'OTHER' }, { certificateType: 'OTHER' }, { status: 'REVOKED' }])(
    'rejects an order-linked certificate that does not prove this assignment: %j', async mismatch => {
      const f = fixture();
      f.txState.order.certificateRequired = true;
      f.txState.order.certificateType = 'FAA-8130-3';
      f.mocks.certificate.findMany.mockResolvedValue([{ id: 'certificate-1', partNumber: 'PN-1', batchNumber: 'B1', serialNumber: null,
        certificateType: 'FAA-8130-3', status: 'ISSUED', expiryDate: null, updatedAt: new Date(), ...mismatch }]);
      const input = await approvedReviewInput(f.tx);
      await expect(createAllocationFulfillmentReview(f.tx, input, qualityActor)).rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_REQUIRED' });
      expect(f.mocks.fulfillmentReview.create).not.toHaveBeenCalled();
    },
  );

  it('accepts a matching current certificate and the reviewer-owned evidence', async () => {
    const f = fixture();
    f.txState.order.certificateRequired = true;
    f.txState.order.certificateType = 'FAA-8130-3';
    f.mocks.certificate.findMany.mockResolvedValue([{ id: 'certificate-1', partNumber: 'PN-1', batchNumber: 'B1', serialNumber: null,
      certificateType: 'FAA-8130-3', status: 'ISSUED', expiryDate: null, updatedAt: new Date() }]);
    await expect(createAllocationFulfillmentReview(f.tx, await approvedReviewInput(f.tx), qualityActor)).resolves.toMatchObject({ approved: true });
  });

  it('rejects a cross-line assignment and a stale review snapshot', async () => {
    const f = fixture();
    const input = await approvedReviewInput(f.tx);
    f.txState.assignment.orderLine.quotationLineId = 'other-quotation-line';
    await expect(createAllocationFulfillmentReview(f.tx, input, qualityActor)).rejects.toMatchObject({ code: 'ALLOCATION_INCONSISTENT' });

    const fresh = fixture();
    const staleInput = await approvedReviewInput(fresh.tx);
    fresh.txState.detail.updatedAt = new Date('2026-09-09T00:01:00Z');
    await expect(createAllocationFulfillmentReview(fresh.tx, staleInput, qualityActor)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
  });

  it('consumes the same reviewed assignment atomically and preserves unassigned quotation reservation', async () => {
    const f = fixture();
    const context = await getAllocationFulfillmentContext(f.tx, 'assignment-1', 2);
    const review = {
      id: 'review-1', assignmentId: 'assignment-1', orderId: 'order-1', inventoryDetailId: 'detail-1',
      quantity: 2, approved: true, consumedAt: null, snapshotHash: context.snapshotHash,
      evidence: [{ id: 'file-1', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE' }],
    };
    f.mocks.fulfillmentReview.findUnique.mockResolvedValue(review);
    const result = await consumeAllocatedInventory({
      tx: f.tx, actor: inventoryActor, assignmentId: 'assignment-1', quantity: 2,
      reviewId: 'review-1', commandId: 'consume-1', notes: '出库测试',
    });
    expect(result).toMatchObject({ assignmentId: 'assignment-1', allocationId: 'allocation-1', beforeQuantity: 10, afterQuantity: 8, assignmentVersion: 2, allocationVersion: 2 });
    expect(f.txState.assignment.consumedQuantity).toBe(2);
    expect(f.txState.allocation.consumedQuantity).toBe(2);
    expect(f.txState.detail).toMatchObject({ quantity: 8, allocatedQuantity: 2 });
    expect(f.txState.orderLine).toMatchObject({ outboundQuantity: 2, outboundStatus: 'PARTIAL' });
    expect(f.txState.order).toMatchObject({ outboundQuantity: 2, outboundStatus: 'PARTIAL' });
    expect(f.txState.allocation.quotationLine.reservedQuantity).toBe(4);
    expect(f.mocks.inventoryTransaction.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ allocationId: 'allocation-1', assignmentId: 'assignment-1', fulfillmentReviewId: 'review-1', quantity: -2, beforeQuantity: 10, afterQuantity: 8 }) }));
    expect(f.mocks.inventoryAllocationEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'CONSUME', allocationId: 'allocation-1', assignmentId: 'assignment-1', quantity: 2 }) }));
    const outboxPayloads = f.mocks.outboxEvent.create.mock.calls.map(([call]) => JSON.stringify(call.data.payload));
    expect(outboxPayloads.every((payload: string) => !payload.includes('unitCost') && !payload.includes('unitPrice') && !payload.includes('costPrice'))).toBe(true);
  });

  it('invalidates consumption when the reviewed evidence version changes', async () => {
    const f = fixture();
    const context = await getAllocationFulfillmentContext(f.tx, 'assignment-1', 2);
    f.mocks.fulfillmentReview.findUnique.mockResolvedValue({
      id: 'review-1', assignmentId: 'assignment-1', orderId: 'order-1', inventoryDetailId: 'detail-1',
      quantity: 2, approved: true, consumedAt: null, snapshotHash: context.snapshotHash,
      evidence: [{ id: 'file-1', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE' }],
    });
    f.file.version = 2;
    await expect(consumeAllocatedInventory({ tx: f.tx, actor: inventoryActor, assignmentId: 'assignment-1', quantity: 2, reviewId: 'review-1', commandId: 'consume-stale' })).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
    expect(f.mocks.inventoryAllocation.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks current order scope before consuming', async () => {
    const f = fixture();
    const context = await getAllocationFulfillmentContext(f.tx, 'assignment-1', 2);
    f.mocks.fulfillmentReview.findUnique.mockResolvedValue({
      id: 'review-1', assignmentId: 'assignment-1', orderId: 'order-1', inventoryDetailId: 'detail-1',
      quantity: 2, approved: true, consumedAt: null, snapshotHash: context.snapshotHash,
      evidence: [{ id: 'file-1', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE' }],
    });
    await expect(consumeAllocatedInventory({
      tx: f.tx, actor: { ...inventoryActor, department: 'finance' }, assignmentId: 'assignment-1', quantity: 2,
      reviewId: 'review-1', commandId: 'consume-wrong-scope',
    })).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(f.mocks.inventoryAllocation.updateMany).not.toHaveBeenCalled();
  });
});
