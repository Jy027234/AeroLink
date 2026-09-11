import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
vi.mock('./stockReceiptFacts.js', () => ({ loadStockReceiptFacts: vi.fn() }));
vi.mock('./receiptEvidenceAccess.js', () => ({ bindReceiptEvidence: vi.fn(), readReceiptEvidence: vi.fn() }));
vi.mock('../inventoryQuality/service.js', () => ({ createInventoryAggregate: vi.fn() }));
vi.mock('../../lib/outboxService.js', () => ({ enqueueBusinessEvent: vi.fn() }));
vi.mock('../../lib/socketEvents.js', () => ({ SocketEvents: { ORDER_STATUS_CHANGED: 'order:status_changed' }, SocketRooms: { ORDERS: 'orders' } }));
import { loadStockReceiptFacts } from './stockReceiptFacts.js';
import { bindReceiptEvidence, readReceiptEvidence } from './receiptEvidenceAccess.js';
import { createInventoryAggregate } from '../inventoryQuality/service.js';
import { getStockReceiptReviewContext, receivePurchaseStock, reviewPurchaseStock } from './stockReceiptCommands.js';

const receiver = { id: 'receiver', role: 'MANAGER', department: 'Ops' };
const reviewer = { id: 'quality', role: 'QUALITY_MANAGER' };
const evidence = [{ id: 'file', version: 2, sha256: 'a'.repeat(64), status: 'AVAILABLE' as const }];
const checks = { identity: true, documents: true, conditionAndLife: true, customerRequirements: true };
const physical = { partNumber: 'PN', uom: 'EA', trackingType: 'BATCH', quantity: 2, serialNumber: null, batchNumber: 'B',
  conditionCode: 'NE', certificateType: null, certificateNumber: null, certificateReferences: [], lifeLimited: false,
  remainingHours: null, remainingCycles: null, shelfLifeDate: null, shelfLifeDays: null, nextOverhaulDue: null, storageCondition: null };
const storage = { location: 'A', warehouse: 'W', shelf: null };
function fixture() {
  const purchaseLine = { id: 'purchase-line', purchaseCommitmentId: 'purchase', orderLineId: 'order-line', quantity: 2,
    receivedQuantity: 0, cancelledQuantity: 0, directShippedQuantity: 0, unitCost: new Prisma.Decimal('1.2500'),
    orderLine: { quotationLine: { id: 'quotation-line', rfqLineId: 'rfq-line', rfqLine: { description: 'Part' } } } };
  const purchase = { id: 'purchase', status: 'CONFIRMED', version: 1, orderId: 'order', supplierId: 'supplier',
    createdById: 'buyer', submittedById: 'buyer', confirmedById: 'buyer', lines: [purchaseLine] };
  const receipt = { id: 'receipt', version: 1, purchaseCommitment: purchase, receivedById: receiver.id, receiptNumber: 'SR-1' };
  const line = { id: 'receipt-line', version: 1, receiptId: receipt.id, purchaseCommitmentLineId: purchaseLine.id,
    status: 'PENDING_REVIEW', quantity: 2, evidence, identitySnapshot: { partNumber: 'PN' }, qualitySnapshot: { physical, storage }, receipt };
  const rows: typeof line[] = [];
  const mocks = { $queryRaw: vi.fn().mockResolvedValue([]),
    order: { findUnique: vi.fn().mockResolvedValue({ id: 'order', lineItemsMode: true, version: 1, status: 'SO_CREATED',
      quotation: { createdBy: 'sales', creator: { department: 'Ops' } } }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    purchaseCommitment: { findUnique: vi.fn().mockResolvedValue(purchase), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    purchaseCommitmentLine: { findMany: vi.fn().mockResolvedValue([purchaseLine]), findUniqueOrThrow: vi.fn().mockResolvedValue(purchaseLine),
      update: vi.fn().mockImplementation(async () => { purchaseLine.receivedQuantity += 2; return purchaseLine; }) },
    stockReceiptLine: { findUnique: vi.fn().mockResolvedValue(line), findMany: vi.fn().mockImplementation(async () => rows),
      updateMany: vi.fn().mockImplementation(async ({ data }: { data: { status: string } }) => { line.status = data.status; return { count: 1 }; }) },
    stockReceipt: { create: vi.fn().mockImplementation(async () => { rows.push(line); return receipt; }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    stockReceiptEvent: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    storedObject: { findMany: vi.fn().mockResolvedValue([{ ...evidence[0], version: 1 }]) },
    inventoryItem: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  vi.mocked(loadStockReceiptFacts).mockResolvedValue({ line: purchaseLine, physical,
    review: { snapshot: { partNumber: 'PN' }, issues: [], canAccept: true } } as never);
  vi.mocked(bindReceiptEvidence).mockResolvedValue(evidence); vi.mocked(readReceiptEvidence).mockResolvedValue(evidence);
  vi.mocked(createInventoryAggregate).mockResolvedValue({ id: 'detail' } as never);
  return { mocks, tx: mocks as unknown as Prisma.TransactionClient, rows, line, purchaseLine, purchase,
    arrival: { purchaseCommitmentId: purchase.id, purchaseVersion: 1, supplierDeliveryReference: 'DELIVERY-1', reason: 'Arrived and segregated',
      evidenceIds: ['file'], lines: [{ purchaseCommitmentLineId: purchaseLine.id, physical, storage }] } };
}
beforeEach(() => vi.resetAllMocks());
describe('stock receipt custody and independent decisions', () => {
  it('records arrival with frozen evidence without creating usable inventory or increasing accepted quantity', async () => {
    const f = fixture(); await receivePurchaseStock({ tx: f.tx, actor: receiver, commandId: 'arrival', ...f.arrival });
    expect(f.mocks.stockReceipt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ evidence }) }));
    expect(createInventoryAggregate).not.toHaveBeenCalled(); expect(f.mocks.purchaseCommitmentLine.update).not.toHaveBeenCalled();
    expect(f.mocks.stockReceiptEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'RECEIVE', quantity: 2 }) }));
  });
  it('accepts through the trusted inventory adapter and increments only the exact procurement line', async () => {
    const f = fixture(); f.rows.push(f.line);
    const context = await getStockReceiptReviewContext({ tx: f.tx, actor: reviewer, receiptLineId: f.line.id });
    await reviewPurchaseStock({ tx: f.tx, actor: reviewer, commandId: 'accept', receiptLineId: f.line.id, version: 1,
      snapshotHash: context.snapshotHash, decision: 'ACCEPTED', reason: 'Four checks passed', checks });
    expect(createInventoryAggregate).toHaveBeenCalledWith(f.tx, expect.objectContaining({
      receipt: { stockReceiptLineId: f.line.id, receiptNumber: 'SR-1' },
      detail: expect.objectContaining({ quantity: 2, status: 'AVAILABLE', type: 'OWN', unitCost: 1.25 }) }));
    expect(f.purchaseLine.receivedQuantity).toBe(2); expect(f.line.status).toBe('ACCEPTED');
  });
  it('rejects a physical batch without generating stock, credit or a supplier-return fact', async () => {
    const f = fixture(); f.rows.push(f.line);
    const context = await getStockReceiptReviewContext({ tx: f.tx, actor: reviewer, receiptLineId: f.line.id });
    await reviewPurchaseStock({ tx: f.tx, actor: reviewer, commandId: 'reject', receiptLineId: f.line.id, version: 1,
      snapshotHash: context.snapshotHash, decision: 'REJECTED', reason: 'Condition mismatch', checks: { ...checks, identity: false } });
    expect(createInventoryAggregate).not.toHaveBeenCalled(); expect(f.purchaseLine.receivedQuantity).toBe(0);
    expect(f.line.status).toBe('REJECTED');
  });
  it.each(['receiver', 'buyer'])('prevents %s from reviewing their own arrival or purchase', async id => {
    const f = fixture();
    await expect(reviewPurchaseStock({ tx: f.tx, actor: { ...reviewer, id }, commandId: 'self', receiptLineId: f.line.id,
      version: 1, snapshotHash: 'a'.repeat(64), decision: 'ACCEPTED', reason: 'Checked', checks })).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });
    expect(createInventoryAggregate).not.toHaveBeenCalled();
  });
  it('blocks stale review facts before any inventory write', async () => {
    const f = fixture();
    await expect(reviewPurchaseStock({ tx: f.tx, actor: reviewer, commandId: 'stale', receiptLineId: f.line.id, version: 1,
      snapshotHash: 'a'.repeat(64), decision: 'ACCEPTED', reason: 'Checked', checks })).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
    expect(createInventoryAggregate).not.toHaveBeenCalled();
  });
});
