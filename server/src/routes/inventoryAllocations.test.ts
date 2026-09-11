import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  actor: { id: 'operator', role: 'ADMIN', department: 'A' },
  quotationLine: { findUnique: vi.fn() }, orderLine: { findUnique: vi.fn() },
  inventoryAllocation: { findUnique: vi.fn() }, allocationAssignment: { findUnique: vi.fn() },
  fulfillmentReview: { findFirst: vi.fn() },
  reserve: vi.fn(), release: vi.fn(), consume: vi.fn(), run: vi.fn(), preview: vi.fn(),
}));
vi.mock('../lib/prisma.js', () => ({ default: mocks }));
vi.mock('../modules/inventoryQuality/index.js', () => ({ reserveLineInventory: mocks.reserve, assignLineInventory: vi.fn(),
  releaseLineInventory: mocks.release, consumeAllocatedInventory: mocks.consume, getLineInventoryAvailability: vi.fn(),
  getAllocationFulfillmentContext: mocks.preview, createAllocationFulfillmentReview: vi.fn() }));
vi.mock('../lib/idempotencyService.js', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/idempotencyService.js')>(), runIdempotentOperation: mocks.run,
}));
import router from './inventoryAllocations.js';
import { errorHandler } from '../middleware/errorHandler.js';

const app = express();
app.use(express.json(), (req, _res, next) => { Object.assign(req, { user: mocks.actor }); next(); });
app.use('/allocations', router);
app.use(errorHandler);
const scope = { createdBy: 'owner', creator: { department: 'A' } };
const reserveBody = { quotationLineId: 'qline', allocations: [{ inventoryDetailId: 'detail', quantity: 2 }] };
describe('allocation HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor.role = 'ADMIN';
    mocks.quotationLine.findUnique.mockResolvedValue({ quotation: scope });
    mocks.orderLine.findUnique.mockResolvedValue({ quotationLineId: 'qline', order: { quotation: scope } });
    mocks.inventoryAllocation.findUnique.mockResolvedValue({ quotationLineId: 'qline' });
    mocks.allocationAssignment.findUnique.mockResolvedValue({ allocationId: 'allocation', orderLineId: 'oline' });
    mocks.reserve.mockResolvedValue({ commandId: 'command', allocations: [] });
    mocks.run.mockImplementation(async (_context, operation) => ({ ...await operation(mocks), statusCode: 201, replayed: false }));
  });
  it('requires an idempotency key before invoking a quantity mutation', async () => {
    const result = await request(app).post('/allocations/reserve').send(reserveBody);
    expect(result.status).toBe(400);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('uses serializable constraints and a stable persistent command identity', async () => {
    await request(app).post('/allocations/reserve').set('Idempotency-Key', 'same-key').send(reserveBody).expect(201);
    const command = mocks.reserve.mock.calls[0][0].commandId;
    await request(app).post('/allocations/reserve').set('Idempotency-Key', 'same-key').send(reserveBody).expect(201);
    expect(mocks.reserve.mock.calls[1][0].commandId).toBe(command);
    expect(command).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.run.mock.calls[0][2]).toEqual({ isolationLevel: 'Serializable', validateDeferredConstraints: true });
  });
  it.each([0, -1, 1.5, 2147483648])('rejects an invalid quantity %s', async quantity => {
    const result = await request(app).post('/allocations/reserve').set('Idempotency-Key', 'quantity').send({
      ...reserveBody, allocations: [{ inventoryDetailId: 'detail', quantity }],
    });
    expect(result.status).toBe(400);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('rejects a mismatched assignment parent before attempting release', async () => {
    await request(app).post('/allocations/release').set('Idempotency-Key', 'release').send({
      allocationId: 'different', assignmentId: 'assignment', quantity: 1, reason: 'Release unused stock',
    }).expect(409);
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('requires inventory manage even when quotation metadata is readable', async () => {
    mocks.actor.role = 'VIEWER';
    await request(app).post('/allocations/reserve').set('Idempotency-Key', 'forbidden').send(reserveBody).expect(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('lets an independent quality manager inspect delivery evidence through order access', async () => {
    mocks.actor.role = 'QUALITY_MANAGER';
    mocks.preview.mockResolvedValue({ snapshot: { plannedQuantity: 1 }, snapshotHash: 'a'.repeat(64), internalCost: 999 });
    mocks.fulfillmentReview.findFirst.mockResolvedValue(null);
    const result = await request(app).get('/allocations/quality-review/assignment?quantity=1').expect(200);
    expect(result.body.data.snapshot.plannedQuantity).toBe(1);
    expect(result.body.data.internalCost).toBeUndefined();
  });
  it('rechecks object access after replay instead of returning an inaccessible cached result', async () => {
    mocks.quotationLine.findUnique.mockResolvedValueOnce({ quotation: scope }).mockResolvedValueOnce(null);
    mocks.run.mockResolvedValueOnce({ payload: { allocations: [] }, statusCode: 201, replayed: true });
    await request(app).post('/allocations/reserve').set('Idempotency-Key', 'replay').send(reserveBody).expect(404);
  });
  it('projects the consume response without the service internal order and ledger fields', async () => {
    mocks.consume.mockResolvedValue({ assignmentId: 'assignment', allocationId: 'allocation', inventoryDetailId: 'detail', quantity: 1,
      beforeQuantity: 2, afterQuantity: 1, transaction: { id: 'transaction', unitCost: 987 },
      order: { id: 'order', status: 'SO_CREATED', totalAmount: 876 }, allocationVersion: 2, assignmentVersion: 2 });
    const result = await request(app).post('/allocations/consume').set('Idempotency-Key', 'consume').send({ assignmentId: 'assignment', quantity: 1, reviewId: 'review' }).expect(201);
    expect(result.body.data.transactionId).toBe('transaction');
    expect(JSON.stringify(result.body)).not.toMatch(/unitCost|totalAmount|987|876/);
  });
});
