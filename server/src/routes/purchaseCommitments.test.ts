import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ actor: { id: 'manager', role: 'MANAGER', department: 'Sales' },
  access: vi.fn(), create: vi.fn(), transition: vi.fn(), view: vi.fn(), list: vi.fn(), run: vi.fn(),
  purchaseCommitment: { findUnique: vi.fn() }, $transaction: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ default: mocks }));
vi.mock('../modules/procurementSettlement/index.js', () => ({ assertPurchaseOrderScope: mocks.access,
  getOrderPurchaseCommitments: mocks.list, getPurchaseCommitment: mocks.view,
  createPurchaseCommitment: mocks.create, transitionPurchaseCommitment: mocks.transition }));
vi.mock('../lib/idempotencyService.js', async original => ({ ...await original<typeof import('../lib/idempotencyService.js')>(), runIdempotentOperation: mocks.run }));
import router from './purchaseCommitments.js';
import { AppError, errorHandler } from '../middleware/errorHandler.js';
const app = express();
app.use(express.json(), (req, _res, next) => { Object.assign(req, { user: mocks.actor }); next(); });
app.use('/purchase-commitments', router); app.use(errorHandler);
const body = { orderId: 'order', supplierId: 'supplier', lines: [{ orderLineId: 'line',
  source: { type: 'SUPPLIER_QUOTE', supplierQuoteId: 'quote' }, quantity: 2,
  promisedDate: '2027-01-01T00:00:00.000Z', fulfillmentMode: 'STOCK_RECEIPT' }] };
describe('procurement HTTP boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.actor.role = 'MANAGER';
    mocks.access.mockResolvedValue({ canViewCost: true });
    mocks.create.mockResolvedValue({ id: 'purchase' }); mocks.transition.mockResolvedValue({ id: 'purchase' });
    mocks.view.mockResolvedValue({ id: 'purchase', version: 1, status: 'DRAFT' });
    mocks.purchaseCommitment.findUnique.mockResolvedValue({ orderId: 'order' });
    mocks.run.mockImplementation(async (_context, operation) => ({ statusCode: 200, ...await operation(mocks), replayed: false }));
    mocks.$transaction.mockImplementation(async operation => operation(mocks));
  });
  it('requires idempotency before any procurement write', async () => {
    await request(app).post('/purchase-commitments').send(body).expect(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('requires one explicit order for scoped collection reads', async () => {
    await request(app).get('/purchase-commitments').expect(400);
    await request(app).get('/purchase-commitments?orderId=order&ownerId=forged').expect(400);
    mocks.list.mockResolvedValue({ orderId: 'order', purchases: [] });
    const response = await request(app).get('/purchase-commitments?orderId=order').expect(200);
    expect(response.body.data).toEqual({ orderId: 'order', purchases: [] });
  });
  it.each([0, -1, 1.5, 2147483648])('rejects invalid quantity %s', async quantity => {
    await request(app).post('/purchase-commitments').set('Idempotency-Key', 'k').send({ ...body, lines: [{ ...body.lines[0], quantity }] }).expect(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('rejects forged server-owned cost or identity and non-USD manual sources', async () => {
    const variants = [ { ...body, totalCost: '5' }, { ...body, lines: [{ ...body.lines[0], partNumber: 'FORGED' }] },
      { ...body, lines: [{ ...body.lines[0], source: { type: 'MANUAL', currency: 'EUR', unitCost: '5', reason: 'basis', evidenceFileIds: ['proof'] } }] } ];
    for (const payload of variants) await request(app).post('/purchase-commitments').set('Idempotency-Key', 'k').send(payload).expect(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('uses a stable permanent command identity and deferred Serializable validation', async () => {
    await request(app).post('/purchase-commitments').set('Idempotency-Key', 'key').send(body).expect(201);
    await request(app).post('/purchase-commitments').set('Idempotency-Key', 'key').send(body).expect(201);
    expect(mocks.create.mock.calls[0][0].commandId).toMatch(/^[a-f\d]{64}$/);
    expect(mocks.create.mock.calls[1][0].commandId).toBe(mocks.create.mock.calls[0][0].commandId);
    expect(mocks.run.mock.calls[0][2]).toEqual({ isolationLevel: 'Serializable', validateDeferredConstraints: true });
  });
  it('caches only a resource reference and reprojects live cost privileges after replay', async () => {
    mocks.run.mockResolvedValue({ payload: { id: 'purchase', secretCachedCost: 'old-cost' }, statusCode: 201, replayed: true });
    mocks.view.mockResolvedValue({ id: 'purchase', status: 'CONFIRMED', version: 4 });
    const response = await request(app).post('/purchase-commitments').set('Idempotency-Key', 'key').send(body).expect(201);
    expect(response.body.data).toEqual({ id: 'purchase', status: 'CONFIRMED', version: 4 });
    expect(JSON.stringify(response.body)).not.toContain('old-cost');
    mocks.access.mockRejectedValueOnce(new AppError('revoked', 403, 'AUTH_FORBIDDEN'));
    await request(app).post('/purchase-commitments').set('Idempotency-Key', 'key').send(body).expect(403);
  });
  it('checks current cost permission again after mutation or cached execution', async () => {
    mocks.access.mockResolvedValueOnce({ canViewCost: true }).mockResolvedValueOnce({ canViewCost: false });
    await request(app).post('/purchase-commitments').set('Idempotency-Key', 'key').send(body).expect(403);
    expect(mocks.view).not.toHaveBeenCalled();
  });
  it('allows quality safe reads but denies creating or confirming procurement', async () => {
    mocks.actor.role = 'QUALITY_MANAGER';
    await request(app).get('/purchase-commitments/purchase').expect(200);
    await request(app).post('/purchase-commitments').set('Idempotency-Key', 'key').send(body).expect(403);
    await request(app).post('/purchase-commitments/purchase/confirm').set('Idempotency-Key', 'key')
      .send({ version: 1, reason: 'confirmed', supplierReferenceNo: 'SUP1', evidenceIds: ['proof'] }).expect(403);
  });
  it('requires version and independent supplier confirmation evidence', async () => {
    for (const payload of [{ reason: 'basis' }, { version: 0, reason: 'basis' }, { version: 1, reason: 'basis', evidenceIds: [] }]) {
      await request(app).post('/purchase-commitments/purchase/confirm').set('Idempotency-Key', 'key').send(payload).expect(400);
    }
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});
