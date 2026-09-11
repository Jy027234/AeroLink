import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: { id: 'inventory-operator', role: 'MANAGER', department: 'Sales' },
  scope: vi.fn(), receive: vi.fn(), view: vi.fn(), list: vi.fn(), reviewContext: vi.fn(), review: vi.fn(), run: vi.fn(),
  purchaseCommitment: { findUnique: vi.fn() },
  stockReceipt: { findUnique: vi.fn() },
  stockReceiptLine: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ default: mocks }));
vi.mock('../modules/procurementSettlement/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../modules/procurementSettlement/index.js')>();
  return {
    ...actual,
    assertStockReceiptOrderScope: mocks.scope,
    getStockReceipt: mocks.view,
    getOrderStockReceipts: mocks.list,
    receivePurchaseStock: mocks.receive,
    getStockReceiptReviewContext: mocks.reviewContext,
    reviewPurchaseStock: mocks.review,
  };
});
vi.mock('../lib/idempotencyService.js', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/idempotencyService.js')>(),
  runIdempotentOperation: mocks.run,
}));

import router from './stockReceipts.js';
import { AppError, errorHandler } from '../middleware/errorHandler.js';

const app = express();
app.use(express.json(), (req, _res, next) => { Object.assign(req, { user: mocks.actor }); next(); });
app.use('/stock-receipts', router);
app.use(errorHandler);

const physical = {
  partNumber: 'PN-1', uom: 'EA', trackingType: 'BATCH', quantity: 2,
  serialNumber: null, batchNumber: 'B1', conditionCode: 'NE', certificateReferences: [],
  certificateType: null, certificateNumber: null, lifeLimited: false,
  remainingHours: null, remainingCycles: null, shelfLifeDate: null, shelfLifeDays: null,
  nextOverhaulDue: null, storageCondition: null,
};
const arrivalBody = {
  purchaseCommitmentId: 'purchase-1', purchaseVersion: 1, supplierDeliveryReference: 'SUP-1',
  reason: '到货单与实物已核对', evidenceIds: ['evidence-1'],
  lines: [{ purchaseCommitmentLineId: 'purchase-line-1', physical,
    storage: { location: 'A-1', warehouse: 'WH-1', shelf: 'S-1' } }],
};
const reviewBody = {
  version: 1, snapshotHash: 'a'.repeat(64), decision: 'ACCEPTED', reason: '四项质量事实已核验',
  checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
};

describe('stock receipt HTTP boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor.id = 'inventory-operator';
    mocks.actor.role = 'MANAGER';
    mocks.actor.department = 'Sales';
    mocks.scope.mockResolvedValue({ order: { id: 'order-1' }, scope: { ownerId: 'sales-1', department: 'Sales' } });
    mocks.purchaseCommitment.findUnique.mockResolvedValue({ orderId: 'order-1' });
    mocks.stockReceipt.findUnique.mockResolvedValue({ purchaseCommitmentId: 'purchase-1' });
    mocks.stockReceiptLine.findUnique.mockResolvedValue({ receiptId: 'receipt-1' });
    mocks.receive.mockResolvedValue({ id: 'receipt-1' });
    mocks.review.mockResolvedValue({ id: 'receipt-1' });
    mocks.view.mockResolvedValue({ id: 'receipt-1', version: 2, lines: [], purchaseCommitment: { orderId: 'order-1' } });
    mocks.list.mockResolvedValue({ orderId: 'order-1', receipts: [] });
    mocks.reviewContext.mockResolvedValue({ receiptLineId: 'line-1', version: 1, status: 'PENDING_REVIEW', snapshot: { physical: { partNumber: 'PN-1' } }, snapshotHash: 'a'.repeat(64), issues: [], canAccept: true });
    mocks.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation(mocks));
    mocks.run.mockReset();
    mocks.run.mockImplementation(async (_context: unknown, operation: (tx: unknown) => Promise<any>) => {
      const result = await operation(mocks);
      return { ...result, statusCode: result.statusCode ?? 200, replayed: false };
    });
  });

  it('requires an idempotency key before any arrival write', async () => {
    await request(app).post('/stock-receipts').send(arrivalBody).expect(400);
    expect(mocks.receive).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('rejects server-owned cost, status, identity, and nested relation fields', async () => {
    const variants = [
      { ...arrivalBody, id: 'forged-receipt' },
      { ...arrivalBody, status: 'ACCEPTED' },
      { ...arrivalBody, costPrice: '99.00' },
      { ...arrivalBody, lines: [{ ...arrivalBody.lines[0], inventoryDetailId: 'forged-detail' }] },
      { ...arrivalBody, lines: [{ ...arrivalBody.lines[0], physical: { ...physical, unitCost: '1.00' } }] },
    ];
    for (const [index, body] of variants.entries()) {
      await request(app).post('/stock-receipts').set('Idempotency-Key', `invalid-${index}`).send(body).expect(400);
    }
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it('uses a stable command identity, strict schema, and deferred Serializable validation', async () => {
    await request(app).post('/stock-receipts').set('Idempotency-Key', 'same-key').send(arrivalBody).expect(201);
    const firstCommandId = mocks.receive.mock.calls[0][0].commandId;
    expect(firstCommandId).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.run.mock.calls[0][2]).toEqual({ isolationLevel: 'Serializable', validateDeferredConstraints: true });

    mocks.run.mockResolvedValueOnce({ payload: { id: 'receipt-1', secretCost: 'should-not-return' }, statusCode: 201, replayed: true });
    await request(app).post('/stock-receipts').set('Idempotency-Key', 'same-key').send(arrivalBody).expect(201);
    expect(mocks.receive).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[1][0]).toMatchObject({ actorId: 'inventory-operator', scope: 'POST:/stock-receipts' });
  });

  it('rechecks current role and order scope after an idempotent replay', async () => {
    await request(app).post('/stock-receipts').set('Idempotency-Key', 'replay-key').send(arrivalBody).expect(201);
    mocks.actor.role = 'VIEWER';
    mocks.run.mockResolvedValueOnce({ payload: { id: 'receipt-1' }, statusCode: 201, replayed: true });
    await request(app).post('/stock-receipts').set('Idempotency-Key', 'replay-key').send(arrivalBody).expect(403);
    expect(mocks.view).toHaveBeenCalledTimes(1);
  });

  it('reprojects a replay through the current receipt view and never returns cached cost fields', async () => {
    mocks.run.mockResolvedValueOnce({
      payload: { id: 'receipt-1', secretCost: 'old-cost', unitCost: 123, supplierQuote: { margin: 50 } },
      statusCode: 201, replayed: true,
    });
    const response = await request(app).post('/stock-receipts').set('Idempotency-Key', 'safe-replay').send(arrivalBody).expect(201);
    expect(response.body.data).toEqual({ id: 'receipt-1', version: 2, lines: [], purchaseCommitment: { orderId: 'order-1' } });
    expect(JSON.stringify(response.body)).not.toMatch(/old-cost|unitCost|supplierQuote|margin/);
  });

  it('requires one explicit orderId for list reads and rejects forged query scope', async () => {
    await request(app).get('/stock-receipts').expect(400);
    await request(app).get('/stock-receipts?orderId=order-1&ownerId=forged').expect(400);
    const response = await request(app).get('/stock-receipts?orderId=order-1').expect(200);
    expect(response.body.data).toEqual({ orderId: 'order-1', receipts: [] });
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-1' }));
  });

  it('denies arrival and review mutations to actors without the matching capability', async () => {
    mocks.actor.role = 'VIEWER';
    await request(app).post('/stock-receipts').set('Idempotency-Key', 'viewer-arrival').send(arrivalBody).expect(403);
    await request(app).post('/stock-receipts/lines/line-1/review').set('Idempotency-Key', 'viewer-review').send(reviewBody).expect(403);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.receive).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it('requires all review facts, a valid decision, version, and snapshot hash', async () => {
    mocks.actor.role = 'QUALITY_MANAGER';
    const variants = [
      { ...reviewBody, version: 0 },
      { ...reviewBody, snapshotHash: 'not-a-hash' },
      { ...reviewBody, decision: 'APPROVED' },
      { ...reviewBody, checks: { ...reviewBody.checks, documents: undefined } },
      { ...reviewBody, costPrice: 'forged' },
    ];
    for (const [index, body] of variants.entries()) {
      await request(app).post('/stock-receipts/lines/line-1/review').set('Idempotency-Key', `bad-review-${index}`).send(body).expect(400);
    }
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('passes the approved or rejected review facts to the service without widening them', async () => {
    mocks.actor.role = 'QUALITY_MANAGER';
    const response = await request(app).post('/stock-receipts/lines/line-1/review')
      .set('Idempotency-Key', 'review-key').send(reviewBody).expect(200);
    expect(response.body.data).toMatchObject({ id: 'receipt-1', version: 2 });
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({
      actor: mocks.actor, receiptLineId: 'line-1', commandId: expect.stringMatching(/^[a-f0-9]{64}$/),
      version: 1, snapshotHash: 'a'.repeat(64), decision: 'ACCEPTED', reason: '四项质量事实已核验',
      checks: reviewBody.checks,
    }));
    expect(mocks.run.mock.calls[0][2]).toEqual({ isolationLevel: 'Serializable', validateDeferredConstraints: true });
  });

  it('lets quality review read the exact review context while keeping the response operational', async () => {
    mocks.actor.role = 'QUALITY_MANAGER';
    const response = await request(app).get('/stock-receipts/lines/line-1/review-context').expect(200);
    expect(response.body.data).toMatchObject({ receiptLineId: 'line-1', status: 'PENDING_REVIEW', canAccept: true });
    expect(JSON.stringify(response.body)).not.toMatch(/unitCost|costPrice|supplierQuote|margin/);
    expect(mocks.reviewContext).toHaveBeenCalledWith(expect.objectContaining({ actor: mocks.actor, receiptLineId: 'line-1' }));
  });
});
