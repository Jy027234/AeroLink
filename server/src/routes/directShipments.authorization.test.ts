import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: { id: 'inventory-operator', role: 'MANAGER', department: 'Sales' },
  tx: { name: 'transaction-client' },
  scope: vi.fn(),
  view: vi.fn(),
  list: vi.fn(),
  reviewContext: vi.fn(),
  create: vi.fn(),
  review: vi.fn(),
  dispatch: vi.fn(),
  cancel: vi.fn(),
  receive: vi.fn(),
  run: vi.fn(),
  buildContext: vi.fn(),
  purchaseCommitment: { findUnique: vi.fn() },
  supplierDirectShipment: { findUnique: vi.fn() },
  supplierDirectShipmentLine: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ default: mocks }));
vi.mock('../modules/procurementSettlement/directShipmentAccess.js', () => ({
  assertDirectShipmentOrderScope: mocks.scope,
  getDirectShipment: mocks.view,
  getOrderDirectShipments: mocks.list,
}));
vi.mock('../modules/procurementSettlement/directShipmentCommands.js', () => ({
  createDirectShipment: mocks.create,
  getDirectShipmentReviewContext: mocks.reviewContext,
  reviewDirectShipment: mocks.review,
  dispatchDirectShipment: mocks.dispatch,
  cancelDirectShipment: mocks.cancel,
  receiveDirectShipment: mocks.receive,
}));
vi.mock('../lib/idempotencyService.js', () => ({
  buildIdempotencyContext: mocks.buildContext,
  applyIdempotencyHeaders: (res: { setHeader: (name: string, value: string) => void }, execution: { key?: string; replayed?: boolean }) => {
    if (execution.key) res.setHeader('Idempotency-Key', execution.key);
    if (execution.replayed) res.setHeader('Idempotency-Replayed', 'true');
  },
  runIdempotentOperation: mocks.run,
}));

import router from './directShipments.js';
import { AppError, errorHandler } from '../middleware/errorHandler.js';

const app = express();
app.use(express.json(), (req, _res, next) => {
  Object.assign(req, { user: mocks.actor });
  next();
});
app.use('/direct-shipments', router);
app.use(errorHandler);

const physical = {
  partNumber: 'PN-1', uom: 'EA', trackingType: 'BATCH', quantity: 2,
  serialNumber: null, batchNumber: 'B-1', conditionCode: 'NE', certificateReferences: [],
  certificateType: null, certificateNumber: null, lifeLimited: false,
  remainingHours: null, remainingCycles: null, shelfLifeDate: null, shelfLifeDays: null,
  nextOverhaulDue: null, storageCondition: null,
};
const createBody = {
  purchaseCommitmentId: 'purchase-1', purchaseVersion: 2, carrier: 'Carrier', trackingNumber: 'TRACK-1',
  origin: 'Supplier warehouse', destination: 'Customer airport', reason: 'supplier direct fulfilment',
  evidenceIds: ['evidence-1'], lines: [{ purchaseCommitmentLineId: 'purchase-line-1', physical }],
};
const reviewBody = {
  version: 1, snapshotHash: 'a'.repeat(64), decision: 'APPROVED', reason: 'all direct shipment checks passed',
  checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
};
const actionBody = { version: 1, reason: 'dispatch authorization recorded' };
const receiptBody = {
  version: 1, quantity: 1, signedBy: 'Customer receiving desk', signedAt: '2026-09-09T10:30:00+08:00',
  reason: 'customer signed delivery receipt', evidenceIds: ['proof-1'],
};
const safeShipment = {
  id: 'shipment-1', shipmentNumber: 'DS-1', orderId: 'order-1', purchaseCommitmentId: 'purchase-1',
  status: 'PREPARED', version: 2, lines: [],
};

describe('supplier direct shipment HTTP authorization boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor.id = 'inventory-operator';
    mocks.actor.role = 'MANAGER';
    mocks.actor.department = 'Sales';
    mocks.buildContext.mockImplementation((req: express.Request, actorId: string, scope: string) => ({
      actorId, scope, key: req.get('Idempotency-Key')?.trim(), requestHash: 'request-hash',
    }));
    mocks.purchaseCommitment.findUnique.mockResolvedValue({ orderId: 'order-1' });
    mocks.supplierDirectShipment.findUnique.mockResolvedValue({ orderId: 'order-1' });
    mocks.supplierDirectShipmentLine.findUnique.mockResolvedValue({ shipment: { orderId: 'order-1' } });
    mocks.scope.mockResolvedValue({ order: { id: 'order-1' }, scope: { ownerId: 'sales-1', department: 'Sales' } });
    mocks.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation(mocks.tx));
    mocks.view.mockResolvedValue(safeShipment);
    mocks.list.mockResolvedValue({ orderId: 'order-1', shipments: [safeShipment] });
    mocks.reviewContext.mockResolvedValue({
      shipmentLineId: 'line-1', shipmentId: 'shipment-1', version: 1, reviewStatus: 'PENDING_REVIEW',
      snapshot: { quality: { partNumber: 'PN-1' }, evidence: [] }, snapshotHash: 'a'.repeat(64), issues: [], canApprove: true,
    });
    mocks.create.mockResolvedValue({ id: 'shipment-1' });
    mocks.review.mockResolvedValue({ id: 'shipment-1' });
    mocks.dispatch.mockResolvedValue({ id: 'shipment-1' });
    mocks.cancel.mockResolvedValue({ id: 'shipment-1' });
    mocks.receive.mockResolvedValue({ id: 'shipment-1' });
    mocks.run.mockImplementation(async (_context: unknown, operation: (tx: unknown) => Promise<{ payload: unknown; statusCode?: number }>) => {
      const result = await operation(mocks.tx);
      return { ...result, statusCode: result.statusCode ?? 200, replayed: false, key: 'same-key' };
    });
  });

  it('requires an explicit order scope for list reads and rejects extra query fields', async () => {
    await request(app).get('/direct-shipments').expect(400);
    await request(app).get('/direct-shipments?orderId=order-1&ownerId=forged').expect(400);
    const response = await request(app).get('/direct-shipments?orderId=order-1').expect(200);
    expect(response.body.data).toEqual({ orderId: 'order-1', shipments: [safeShipment] });
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ tx: mocks.tx, actor: mocks.actor, orderId: 'order-1' }));
  });

  it('returns safe detail and review context through their current scoped readers', async () => {
    await request(app).get('/direct-shipments/shipment-1').expect(200);
    expect(mocks.view).toHaveBeenCalledWith({ tx: mocks.tx, actor: mocks.actor, shipmentId: 'shipment-1' });

    mocks.actor.role = 'QUALITY_MANAGER';
    const response = await request(app).get('/direct-shipments/lines/line-1/review-context').expect(200);
    expect(response.body.data).toMatchObject({ shipmentLineId: 'line-1', canApprove: true });
    expect(mocks.reviewContext).toHaveBeenCalledWith({ tx: mocks.tx, actor: mocks.actor, shipmentLineId: 'line-1' });
    expect(mocks.scope).toHaveBeenCalledWith(expect.anything(), mocks.actor, 'order-1', 'review');
  });

  it('creates with a stable command identity, Serializable deferred validation, and safe reprojection', async () => {
    const response = await request(app).post('/direct-shipments').set('Idempotency-Key', 'create-key').send(createBody).expect(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      tx: mocks.tx, actor: mocks.actor, commandId: expect.stringMatching(/^[a-f0-9]{64}$/),
      purchaseCommitmentId: 'purchase-1', purchaseVersion: 2, lines: createBody.lines,
    }));
    expect(mocks.run.mock.calls[0][2]).toEqual({ isolationLevel: 'Serializable', validateDeferredConstraints: true });
    expect(mocks.view).toHaveBeenCalledWith({ tx: mocks.tx, actor: mocks.actor, shipmentId: 'shipment-1' });
    expect(response.body.data).toEqual(safeShipment);
    expect(response.headers['idempotency-key']).toBe('same-key');
  });

  it('denies write and review capabilities before any command or transaction', async () => {
    mocks.actor.role = 'VIEWER';
    await request(app).post('/direct-shipments').set('Idempotency-Key', 'viewer-create').send(createBody).expect(403);
    await request(app).post('/direct-shipments/shipment-1/dispatch').set('Idempotency-Key', 'viewer-dispatch').send(actionBody).expect(403);

    mocks.actor.role = 'MANAGER';
    await request(app).post('/direct-shipments/lines/line-1/review').set('Idempotency-Key', 'manager-review').send(reviewBody).expect(403);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it('rechecks current write scope after a replay before returning its projection', async () => {
    mocks.run.mockResolvedValueOnce({ payload: { id: 'shipment-1', leakedCost: 'old-cost' }, statusCode: 200, replayed: true, key: 'replay-key' });
    mocks.scope.mockResolvedValueOnce({ order: { id: 'order-1' } }).mockRejectedValueOnce(new AppError('scope revoked', 403, 'AUTH_FORBIDDEN'));

    const response = await request(app).post('/direct-shipments/shipment-1/dispatch')
      .set('Idempotency-Key', 'replay-key').send(actionBody).expect(403);
    expect(response.body.code).toBe('AUTH_FORBIDDEN');
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.view).not.toHaveBeenCalled();
    expect(mocks.scope).toHaveBeenCalledTimes(2);
  });

  it('requires an idempotency key and rejects server-owned or malformed create fields', async () => {
    await request(app).post('/direct-shipments').send(createBody).expect(400);
    expect(mocks.run).not.toHaveBeenCalled();

    const invalidBodies = [
      { ...createBody, id: 'forged' },
      { ...createBody, status: 'DISPATCHED' },
      { ...createBody, costPrice: '99.00' },
      { ...createBody, evidenceIds: ['evidence-1', 'evidence-1'] },
      { ...createBody, lines: [{ ...createBody.lines[0], inventoryDetailId: 'forged-detail' }] },
      { ...createBody, lines: [{ ...createBody.lines[0], physical: { ...physical, unitCost: '1.00' } }] },
    ];
    for (const [index, body] of invalidBodies.entries()) {
      await request(app).post('/direct-shipments').set('Idempotency-Key', `invalid-${index}`).send(body).expect(400);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('passes the exact review snapshot field and review capability to the command', async () => {
    mocks.actor.role = 'QUALITY_MANAGER';
    await request(app).post('/direct-shipments/lines/line-1/review')
      .set('Idempotency-Key', 'review-key').send(reviewBody).expect(200);
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({
      tx: mocks.tx, actor: mocks.actor, shipmentLineId: 'line-1', commandId: expect.stringMatching(/^[a-f0-9]{64}$/),
      snapshotHash: 'a'.repeat(64), decision: 'APPROVED', checks: reviewBody.checks,
    }));
    expect(mocks.view).toHaveBeenCalledWith({ tx: mocks.tx, actor: mocks.actor, shipmentId: 'shipment-1' });
  });

  it('routes dispatch and cancel through the action command with safe projections', async () => {
    await request(app).post('/direct-shipments/shipment-1/dispatch')
      .set('Idempotency-Key', 'dispatch-key').send(actionBody).expect(200);
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: 'shipment-1', version: 1, reason: actionBody.reason }));

    await request(app).post('/direct-shipments/shipment-1/cancel')
      .set('Idempotency-Key', 'cancel-key').send(actionBody).expect(200);
    expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ shipmentId: 'shipment-1', version: 1, reason: actionBody.reason }));
    expect(mocks.view).toHaveBeenCalledTimes(2);
  });

  it('routes signed receipt with strict evidence and current order access', async () => {
    const response = await request(app).post('/direct-shipments/lines/line-1/receipt')
      .set('Idempotency-Key', 'receipt-key').send(receiptBody).expect(200);
    expect(mocks.receive).toHaveBeenCalledWith(expect.objectContaining({
      tx: mocks.tx, actor: mocks.actor, shipmentLineId: 'line-1', version: 1, quantity: 1,
      signedAt: receiptBody.signedAt, evidenceIds: receiptBody.evidenceIds,
    }));
    expect(response.body.data).toEqual(safeShipment);
    expect(mocks.scope).toHaveBeenCalledWith(expect.anything(), mocks.actor, 'order-1', 'manage');
  });
});
