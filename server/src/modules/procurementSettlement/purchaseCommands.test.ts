import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
vi.mock('../../lib/outboxService.js', () => ({ enqueueBusinessEvent: vi.fn() }));
vi.mock('../../lib/socketEvents.js', () => ({ SocketEvents: { ORDER_STATUS_CHANGED: 'order:status_changed' }, SocketRooms: { ORDERS: 'orders' } }));
vi.mock('./purchaseSources.js', () => ({ resolvePurchaseLines: vi.fn(), assertPurchaseSourcesCurrent: vi.fn(), bindPurchaseEvidence: vi.fn() }));
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { resolvePurchaseLines, assertPurchaseSourcesCurrent, bindPurchaseEvidence } from './purchaseSources.js';
import { createPurchaseCommitment, transitionPurchaseCommitment } from './purchaseCommands.js';
import { buildPurchaseApprovalSnapshot } from './purchasePolicy.js';

const actor = { id: 'buyer', role: 'MANAGER', department: 'Sales' };
function fixture() {
  const line = { id: 'line', lineNo: 1, orderLineId: 'order-line', sourceSupplierQuoteId: 'source', partNumber: 'PN', uom: 'EA',
    quantity: 2, unitCost: new Prisma.Decimal(2500), lineTotal: new Prisma.Decimal(5000), currency: 'USD',
    promisedDate: new Date('2027-01-01'), fulfillmentMode: 'STOCK_RECEIPT' as const, version: 1,
    cancelledQuantity: 0, receivedQuantity: 0, directShippedQuantity: 0,
    identitySnapshot: { schemaVersion: 1, orderLineId: 'order-line', quotationLineId: 'quotation-line', rfqLineId: 'rfq-line',
      partNumber: 'PN', uom: 'EA', conditionCode: 'NE', serialNumber: null, batchNumber: null, certificateRequired: false, certificateType: null },
    sourceSnapshot: { schemaVersion: 1, type: 'SUPPLIER_QUOTE', id: 'source', supplierId: 'supplier', rfqLineId: 'rfq-line', partNumber: 'PN',
      quantity: 2, unitCost: '2500.0000', currency: 'USD', validUntil: '2027-01-01T00:00:00.000Z' } };
  const purchase = { id: 'purchase', orderId: 'order', supplierId: 'supplier', status: 'DRAFT', version: 1, createdById: 'buyer',
    submittedById: null as string | null, submittedAt: null as Date | null, approvedById: null as string | null, approvedAt: null as Date | null,
    approvalSnapshot: null as unknown, approvalLevel: null as string | null, approvalPolicyVersion: null as string | null,
    currency: 'USD', totalCost: new Prisma.Decimal(5000), paymentTerms: 'Net 30', lines: [line] };
  const order = { id: 'order', status: 'SO_CREATED', version: 1, lineItemsMode: true,
    quotation: { createdBy: 'sales', creator: { department: 'Sales' } } };
  const orderLine = { quantity: 2, allocationAssignments: [] as Array<{ id: string; assignedQuantity: number; releasedQuantity: number; consumedQuantity: number;
    allocation: { stockReceiptLine: null | { purchaseCommitmentLineId: string } } }>,
    purchaseCommitmentLines: [] as typeof line[] };
  const mocks = { $queryRaw: vi.fn().mockResolvedValue([]), order: { findUnique: vi.fn().mockResolvedValue(order), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    stockReceiptLine: { count: vi.fn().mockResolvedValue(0) },
    supplierDirectShipment: { count: vi.fn().mockResolvedValue(0) },
    supplier: { findUnique: vi.fn().mockResolvedValue({ id: 'supplier', status: 'active' }) },
    purchaseCommitment: { findUnique: vi.fn().mockResolvedValue(purchase), create: vi.fn().mockResolvedValue(purchase), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    purchaseCommitmentEvent: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    purchaseCommitmentLine: { update: vi.fn().mockResolvedValue({}) }, orderLine: { findUnique: vi.fn().mockResolvedValue(orderLine) } };
  vi.mocked(resolvePurchaseLines).mockResolvedValue({ lines: [line] } as never);
  vi.mocked(bindPurchaseEvidence).mockResolvedValue([{ id: 'proof', version: 2, sha256: 'a'.repeat(64), status: 'AVAILABLE' }]);
  const tx = mocks as unknown as Prisma.TransactionClient;
  const command = (action: Parameters<typeof transitionPurchaseCommitment>[0]['action'], overrides = {}) => transitionPurchaseCommitment({
    tx, actor, purchaseCommitmentId: purchase.id, version: 1, action, reason: 'Verified business basis', commandId: 'command', ...overrides });
  const pending = () => {
    purchase.status = 'PENDING_APPROVAL'; purchase.submittedById = 'buyer'; purchase.submittedAt = new Date();
    purchase.approvalSnapshot = buildPurchaseApprovalSnapshot(purchase); purchase.approvalLevel = 'MANAGER';
    purchase.approvalPolicyVersion = (purchase.approvalSnapshot as { policyVersion: string }).policyVersion;
  };
  return { tx, mocks, purchase, order, line, orderLine, command, pending };
}
beforeEach(() => vi.resetAllMocks());

describe('purchase command state and authority', () => {
  it('creates server-calculated cost and keeps refresh events free of commercial fields', async () => {
    const f = fixture();
    expect(await createPurchaseCommitment({ tx: f.tx, actor, orderId: 'order', supplierId: 'supplier', lines: [], commandId: 'create' })).toEqual({ id: 'purchase' });
    expect(f.mocks.purchaseCommitment.create.mock.calls[0][0].data.totalCost.toFixed(4)).toBe('5000.0000');
    expect(JSON.stringify(vi.mocked(enqueueBusinessEvent).mock.calls[0][1].data)).not.toMatch(/cost|price|paymentTerms|sourceSnapshot|reason/i);
  });
  it('captures approval snapshot while submitting from draft', async () => {
    const f = fixture(); await f.command('SUBMIT');
    expect(assertPurchaseSourcesCurrent).toHaveBeenCalled();
    expect(f.mocks.purchaseCommitment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'PENDING_APPROVAL', submittedById: actor.id, approvalLevel: 'MANAGER',
      approvalSnapshot: expect.objectContaining({ totalCost: '5000.0000' }),
    }) }));
  });
  it('blocks inactive suppliers while still allowing cancellation of an existing commitment', async () => {
    const f = fixture(); f.mocks.supplier.findUnique.mockResolvedValue({ id: 'supplier', status: 'inactive' });
    await expect(f.command('SUBMIT')).rejects.toThrow(/供应商已停用/);
    expect(f.mocks.purchaseCommitment.updateMany).not.toHaveBeenCalled();
    await f.command('CANCEL');
  });
  it('rejects purchase coverage already occupied by inventory, including consumed stock', async () => {
    const f = fixture();
    f.orderLine.allocationAssignments.push({ id: 'assignment', assignedQuantity: 1, releasedQuantity: 0, consumedQuantity: 1, allocation: { stockReceiptLine: null } });
    await expect(f.command('SUBMIT')).rejects.toMatchObject({ code: 'ALLOCATION_INCONSISTENT' });
    expect(f.mocks.purchaseCommitment.updateMany).not.toHaveBeenCalled();
  });
  it('requires pending physical arrivals to be reviewed before cancelling a purchase', async () => {
    const f = fixture(); f.purchase.status = 'CONFIRMED'; f.mocks.stockReceiptLine.count.mockResolvedValue(1);
    await expect(f.command('CANCEL')).rejects.toThrow(/待检到货/);
    expect(f.mocks.purchaseCommitment.updateMany).not.toHaveBeenCalled();
  });
  it('requires a prepared direct plan to be cancelled before its purchase', async () => {
    const f = fixture(); f.purchase.status = 'CONFIRMED'; f.mocks.supplierDirectShipment.count.mockResolvedValue(1);
    await expect(f.command('CANCEL')).rejects.toThrow(/先取消直发计划/);
    expect(f.mocks.purchaseCommitment.updateMany).not.toHaveBeenCalled();
    expect(f.mocks.purchaseCommitmentLine.update).not.toHaveBeenCalled();
  });
  it('allows independent manager approval at 5000 without rewriting the frozen snapshot', async () => {
    const f = fixture(); f.pending();
    await f.command('APPROVE', { actor: { ...actor, id: 'independent' } });
    const data = f.mocks.purchaseCommitment.updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'APPROVED', approvedById: 'independent' });
    expect(data).not.toHaveProperty('approvalSnapshot');
  });
  it.each([{ ...actor }, { id: 'admin', role: 'ADMIN' }, { id: 'sales', role: 'SALES' }])
  ('does not let $role bypass procurement approval authority', async approver => {
    const f = fixture(); f.pending();
    await expect(f.command('APPROVE', { actor: approver })).rejects.toMatchObject({ statusCode: 403 });
    expect(f.mocks.purchaseCommitment.updateMany).not.toHaveBeenCalled();
  });
  it('rejects stale source and altered approval snapshot before approval', async () => {
    const f = fixture(); f.pending();
    f.purchase.approvalSnapshot = { forged: true };
    await expect(f.command('APPROVE', { actor: { ...actor, id: 'other' } })).rejects.toThrow(/快照/);
    f.pending(); vi.mocked(assertPurchaseSourcesCurrent).mockRejectedValueOnce(new Error('source stale'));
    await expect(f.command('APPROVE', { actor: { ...actor, id: 'other' } })).rejects.toThrow(/source stale/);
    expect(f.mocks.purchaseCommitment.updateMany).not.toHaveBeenCalled();
  });
  it('requires a real prior approval and bound evidence when recording supplier confirmation', async () => {
    const f = fixture(); f.pending(); f.purchase.status = 'APPROVED';
    await expect(f.command('CONFIRM', { supplierReferenceNo: 'SUP-1', evidenceIds: ['proof'] })).rejects.toThrow(/审批事实/);
    f.purchase.approvedById = 'independent'; f.purchase.approvedAt = new Date();
    await f.command('CONFIRM', { supplierReferenceNo: 'SUP-1', evidenceIds: ['proof'] });
    expect(bindPurchaseEvidence).toHaveBeenCalledWith(f.tx, actor, ['proof'], 'purchase');
    expect(f.mocks.purchaseCommitment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CONFIRMED', supplierReferenceNo: 'SUP-1' }) }));
  });
  it('rejects stale CAS and does not append successful events', async () => {
    const f = fixture(); f.mocks.purchaseCommitment.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.command('SUBMIT')).rejects.toThrow(/其他操作/);
    expect(f.mocks.purchaseCommitmentEvent.create).not.toHaveBeenCalled();
    expect(enqueueBusinessEvent).not.toHaveBeenCalled();
  });
  it('cancels only unreceived commitments and preserves their initial commercial quantities', async () => {
    const f = fixture(); f.purchase.status = 'CONFIRMED'; f.line.receivedQuantity = 1;
    await expect(f.command('CANCEL')).rejects.toThrow(/已有收货/);
    f.line.receivedQuantity = 0; await f.command('CANCEL');
    expect(f.mocks.purchaseCommitmentLine.update).toHaveBeenCalledWith({ where: { id: 'line' }, data: { cancelledQuantity: 2, version: { increment: 1 } } });
  });
  it('replays a permanent command once and rechecks current authorization', async () => {
    const f = fixture(); await f.command('SUBMIT');
    const recorded = f.mocks.purchaseCommitmentEvent.create.mock.calls[0][0].data;
    f.mocks.purchaseCommitmentEvent.findUnique.mockResolvedValue(recorded);
    f.purchase.status = 'CONFIRMED'; f.purchase.version = 4;
    expect(await f.command('SUBMIT')).toEqual({ id: 'purchase' });
    expect(f.mocks.purchaseCommitment.updateMany).toHaveBeenCalledTimes(1);
    await expect(f.command('SUBMIT', { reason: 'different reason' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    f.order.quotation.creator.department = 'Other';
    await expect(f.command('SUBMIT')).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });
});
