import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
vi.mock('./directShipmentQuality.js', () => ({ loadDirectShipmentFacts: vi.fn() }));
vi.mock('./directShipmentEvidence.js', () => ({ bindDirectShipmentEvidence: vi.fn(), validateDirectShipmentEvidence: vi.fn() }));
vi.mock('../../lib/outboxService.js', () => ({ enqueueBusinessEvent: vi.fn() }));
vi.mock('../../lib/transactionStateService.js', () => ({ transitionOrderStatus: vi.fn() }));
import { loadDirectShipmentFacts } from './directShipmentQuality.js';
import { bindDirectShipmentEvidence, validateDirectShipmentEvidence } from './directShipmentEvidence.js';
import { transitionOrderStatus } from '../../lib/transactionStateService.js';
import { createDirectShipment, getDirectShipmentReviewContext, reviewDirectShipment,
  dispatchDirectShipment, cancelDirectShipment, receiveDirectShipment } from './directShipmentCommands.js';

const operator = { id: 'operator', role: 'MANAGER', department: 'Ops' };
const reviewer = { id: 'quality', role: 'QUALITY_MANAGER' };
const evidence = [{ id: 'file', version: 2, sha256: 'a'.repeat(64), status: 'AVAILABLE' }];
const checks = { identity: true, documents: true, conditionAndLife: true, customerRequirements: true };
const physical = { partNumber: 'PN', uom: 'EA', trackingType: 'BATCH', quantity: 2, serialNumber: null, batchNumber: 'B',
  conditionCode: 'NE', certificateType: null, certificateNumber: null, certificateReferences: [], lifeLimited: false,
  remainingHours: null, remainingCycles: null, shelfLifeDate: null, shelfLifeDays: null, nextOverhaulDue: null, storageCondition: null };

function fixture() {
  const purchaseLine = { id: 'purchase-line', purchaseCommitmentId: 'purchase', orderLineId: 'order-line', quantity: 2,
    receivedQuantity: 0, cancelledQuantity: 0, directShippedQuantity: 0, version: 1, fulfillmentMode: 'SUPPLIER_DIRECT' };
  const purchase = { id: 'purchase', orderId: 'order', status: 'CONFIRMED', version: 1,
    createdById: 'buyer', submittedById: 'buyer', confirmedById: 'buyer', lines: [purchaseLine] };
  const line = { id: 'line', shipmentId: 'shipment', purchaseCommitmentLineId: purchaseLine.id, quantity: 2,
    reviewStatus: 'PENDING_REVIEW', version: 1, receivedQuantity: 0, physicalSnapshot: physical,
    reviewedById: null as string | null, reviewSnapshot: null as unknown, reviewSnapshotHash: null as string | null,
    reviewEvidence: [] as unknown[], serialClaimKey: null as string | null };
  const head = { id: 'shipment', orderId: 'order', purchaseCommitmentId: purchase.id, purchaseCommitment: purchase,
    status: 'PREPARED', version: 1, createdById: operator.id, lines: [line], evidence };
  const orderLine = { id: 'order-line', quantity: 2, outboundQuantity: 0, directShippedQuantity: 0 };
  const order = { id: 'order', version: 1, status: 'SO_CREATED', lineItemsMode: true, lines: [orderLine],
    quotation: { createdBy: 'sales', creator: { department: 'Ops' } } };
  // Mutable fakes model statement ordering; database constraints/concurrency need separate PostgreSQL checks.
  const apply = (target: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) target[key] = value && typeof value === 'object' && 'increment' in value
      ? Number(target[key]) + Number(value.increment) : value;
    return { count: 1 };
  };
  const mocks = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    order: { findUnique: vi.fn().mockImplementation(async () => ({ ...order })),
      findUniqueOrThrow: vi.fn().mockImplementation(async () => ({ ...order })),
      updateMany: vi.fn().mockImplementation(async ({ data }) => apply(order, data)) },
    orderLine: { updateMany: vi.fn().mockImplementation(async ({ data }) => apply(orderLine, data)) },
    purchaseCommitment: { findUnique: vi.fn().mockResolvedValue(purchase), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    purchaseCommitmentLine: { findMany: vi.fn().mockResolvedValue([purchaseLine]),
      update: vi.fn().mockImplementation(async ({ data }) => apply(purchaseLine, data)) },
    supplierDirectShipment: { findUnique: vi.fn().mockImplementation(async () => ({ ...head, lines: head.lines.map(row => ({ ...row })) })),
      findMany: vi.fn().mockResolvedValue([head]), create: vi.fn(),
      updateMany: vi.fn().mockImplementation(async ({ data }) => apply(head, data)) },
    supplierDirectShipmentLine: { findUnique: vi.fn().mockImplementation(async () => ({ ...line })),
      findMany: vi.fn().mockImplementation(async () => ['DISPATCHED', 'PARTIALLY_RECEIVED', 'DELIVERED'].includes(head.status)
        ? [{ ...line, purchaseCommitmentLine: { orderLineId: orderLine.id }, shipment: { status: head.status } }] : []),
      updateMany: vi.fn().mockImplementation(async ({ data }) => apply(line, data)) },
    supplierDirectShipmentEvent: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    storedObject: { findMany: vi.fn().mockResolvedValue([{ ...evidence[0], version: 1 }]) },
    shipmentLine: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const facts = { line: purchaseLine, physical, review: { approvalSnapshot: { identity: 'trusted source' }, issues: [], canAccept: true } };
  vi.mocked(loadDirectShipmentFacts).mockResolvedValue(facts as never);
  vi.mocked(bindDirectShipmentEvidence).mockResolvedValue(evidence as never);
  vi.mocked(validateDirectShipmentEvidence).mockResolvedValue(evidence as never);
  const tx = mocks as unknown as Prisma.TransactionClient;
  async function approve() {
    const context = await getDirectShipmentReviewContext({ tx, actor: reviewer, shipmentLineId: line.id });
    await reviewDirectShipment({ tx, actor: reviewer, commandId: 'review', shipmentLineId: line.id,
      version: line.version, snapshotHash: context.snapshotHash, decision: 'APPROVED', reason: 'Quality accepted', checks });
  }
  const arrival = { purchaseCommitmentId: purchase.id, purchaseVersion: 1, carrier: 'Carrier', trackingNumber: 'WAYBILL',
    origin: 'Supplier', destination: 'Customer', reason: 'Supplier delivery plan', evidenceIds: ['file'],
    lines: [{ purchaseCommitmentLineId: purchaseLine.id, physical }] };
  return { tx, mocks, head, line, purchase, purchaseLine, order, orderLine, facts, approve, arrival };
}
beforeEach(() => vi.resetAllMocks());

describe('supplier direct shipment controlled commands', () => {
  it('records a prepared plan with frozen evidence without receiving stock or dispatching purchase quantity', async () => {
    const f = fixture();
    await createDirectShipment({ tx: f.tx, actor: operator, commandId: 'create', ...f.arrival });
    expect(f.mocks.supplierDirectShipment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ evidence }) }));
    expect(f.mocks.purchaseCommitmentLine.update).not.toHaveBeenCalled();
    expect(f.mocks.supplierDirectShipmentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'CREATE', quantity: 0,
      data: expect.objectContaining({ plannedQuantity: 2 }) }) }));
  });
  it.each(['operator', 'buyer'])('prevents %s from approving their own delivery', async id => {
    const f = fixture();
    await expect(reviewDirectShipment({ tx: f.tx, actor: { ...reviewer, id }, commandId: 'self', shipmentLineId: f.line.id,
      version: 1, snapshotHash: 'a'.repeat(64), decision: 'APPROVED', reason: 'Checked', checks })).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    expect(f.mocks.supplierDirectShipmentLine.updateMany).not.toHaveBeenCalled();
  });
  it('requires the current quality snapshot and all four checks', async () => {
    const f = fixture();
    const input = { tx: f.tx, actor: reviewer, commandId: 'stale', shipmentLineId: f.line.id, version: 1,
      snapshotHash: 'a'.repeat(64), decision: 'APPROVED' as const, reason: 'Checked', checks };
    await expect(reviewDirectShipment(input)).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
    const c = await getDirectShipmentReviewContext({ tx: f.tx, actor: reviewer, shipmentLineId: f.line.id });
    await expect(reviewDirectShipment({ ...input, snapshotHash: c.snapshotHash, checks: { ...checks, documents: false } }))
      .rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.mocks.supplierDirectShipmentLine.updateMany).not.toHaveBeenCalled();
  });
  it('allows a reasoned rejection even when all checklist boxes were checked', async () => {
    const f = fixture(); f.line.serialClaimKey = 'claim';
    const c = await getDirectShipmentReviewContext({ tx: f.tx, actor: reviewer, shipmentLineId: f.line.id });
    await reviewDirectShipment({ tx: f.tx, actor: reviewer, commandId: 'reject', shipmentLineId: f.line.id, version: 1,
      snapshotHash: c.snapshotHash, decision: 'REJECTED', reason: 'Additional documented concern', checks });
    expect(f.line.reviewStatus).toBe('REJECTED'); expect(f.line.serialClaimKey).toBeNull();
    expect(f.purchaseLine.directShippedQuantity).toBe(0);
  });
  it('blocks dispatch by the quality reviewer and blocks changed evidence', async () => {
    const f = fixture(); await f.approve();
    const command = { tx: f.tx, actor: { ...operator, id: reviewer.id }, commandId: 'dispatch', shipmentId: f.head.id,
      version: f.head.version, reason: 'Supplier dispatched' };
    await expect(dispatchDirectShipment(command)).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    vi.mocked(validateDirectShipmentEvidence).mockResolvedValue([{ ...evidence[0], version: 3 }] as never);
    await expect(dispatchDirectShipment({ ...command, actor: operator })).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
    expect(f.purchaseLine.directShippedQuantity).toBe(0);
  });
  it('dispatches approved goods and derives order delivery without local stock', async () => {
    const f = fixture(); await f.approve();
    await dispatchDirectShipment({ tx: f.tx, actor: operator, commandId: 'dispatch', shipmentId: f.head.id,
      version: f.head.version, reason: 'Supplier dispatched' });
    expect(f.head.status).toBe('DISPATCHED'); expect(f.purchaseLine.directShippedQuantity).toBe(2);
    expect(f.purchaseLine.receivedQuantity).toBe(0); expect(f.orderLine.outboundQuantity).toBe(0);
    expect(f.orderLine.directShippedQuantity).toBe(2);
    expect(transitionOrderStatus).toHaveBeenCalledWith(f.tx, expect.objectContaining({ nextStatus: 'SHIPPED' }));
  });
  it('records partial and final customer receipts with evidence and no purchase stock receipt', async () => {
    const f = fixture(); await f.approve(); f.head.status = 'DISPATCHED'; f.purchaseLine.directShippedQuantity = 2;
    f.order.status = 'SHIPPED'; f.orderLine.directShippedQuantity = 2;
    const input = { tx: f.tx, actor: operator, commandId: 'receipt-1', shipmentLineId: f.line.id, version: f.line.version,
      quantity: 1, signedBy: 'Customer receiver', signedAt: '2026-01-01T10:00:00+08:00', reason: 'POD received', evidenceIds: ['file'] };
    await receiveDirectShipment(input);
    expect(f.head.status).toBe('PARTIALLY_RECEIVED'); expect(f.line.receivedQuantity).toBe(1);
    expect(transitionOrderStatus).not.toHaveBeenCalled();
    await receiveDirectShipment({ ...input, commandId: 'receipt-2', version: f.line.version });
    expect(f.head.status).toBe('DELIVERED'); expect(f.line.receivedQuantity).toBe(2);
    expect(f.purchaseLine.receivedQuantity).toBe(0);
    expect(transitionOrderStatus).toHaveBeenCalledWith(f.tx, expect.objectContaining({ nextStatus: 'DELIVERED' }));
  });
  it('rejects excess receipt quantity and future signed times before writes', async () => {
    const f = fixture(); f.head.status = 'DISPATCHED';
    const input = { tx: f.tx, actor: operator, commandId: 'receipt', shipmentLineId: f.line.id, version: 1,
      quantity: 3, signedBy: 'Customer', signedAt: '2026-01-01T00:00:00Z', reason: 'POD received', evidenceIds: ['file'] };
    await expect(receiveDirectShipment(input)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    await expect(receiveDirectShipment({ ...input, quantity: 1, signedAt: '2999-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.mocks.supplierDirectShipmentLine.updateMany).not.toHaveBeenCalled();
  });
  it('cancels prepared serial claims and rejects cancellation after dispatch', async () => {
    const f = fixture(); f.line.serialClaimKey = 'claim';
    const input = { tx: f.tx, actor: operator, commandId: 'cancel', shipmentId: f.head.id, version: f.head.version, reason: 'Plan cancelled' };
    await cancelDirectShipment(input); expect(f.head.status).toBe('CANCELLED'); expect(f.line.serialClaimKey).toBeNull();
    f.head.status = 'DISPATCHED';
    await expect(cancelDirectShipment({ ...input, commandId: 'later', version: f.head.version })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });
  it('replays a permanent event without duplicate writes but still rechecks current access', async () => {
    const f = fixture();
    const input = { tx: f.tx, actor: operator, commandId: 'cancel', shipmentId: f.head.id, version: 1, reason: 'Plan cancelled' };
    await cancelDirectShipment(input);
    const event = f.mocks.supplierDirectShipmentEvent.create.mock.calls[0][0].data;
    f.mocks.supplierDirectShipmentEvent.findUnique.mockResolvedValue(event);
    f.mocks.supplierDirectShipment.updateMany.mockClear();
    await expect(cancelDirectShipment(input)).resolves.toEqual({ id: f.head.id });
    expect(f.mocks.supplierDirectShipment.updateMany).not.toHaveBeenCalled();
    await expect(cancelDirectShipment({ ...input, actor: { id: operator.id, role: 'VIEWER' } })).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    await expect(cancelDirectShipment({ ...input, reason: 'Changed reason' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('can close an unused rejected plan after another delivery completed the order', async () => {
    const f = fixture(); f.order.status = 'DELIVERED'; f.line.reviewStatus = 'REJECTED';
    await cancelDirectShipment({ tx: f.tx, actor: operator, commandId: 'cancel-replaced', shipmentId: f.head.id,
      version: f.head.version, reason: 'Replaced plan cleanup' });
    expect(f.head.status).toBe('CANCELLED'); expect(f.order.status).toBe('DELIVERED');
    expect(transitionOrderStatus).not.toHaveBeenCalled();
  });
});
