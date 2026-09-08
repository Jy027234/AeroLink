import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ actor: { id: 'manager', role: 'ADMIN', department: 'Sales' },
  access: vi.fn(), create: vi.fn(), receive: vi.fn(), returned: vi.fn(), release: vi.fn(), view: vi.fn(), releaseView: vi.fn(), run: vi.fn(),
  shipment: { findUnique: vi.fn() }, shipmentLine: { findUnique: vi.fn() }, returnHold: { findUnique: vi.fn() }, $transaction: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ default: mocks }));
vi.mock('../modules/inventoryQuality/index.js', () => ({ assertShipmentOrderAccess: mocks.access,
  getOrderShipments: mocks.view, createShipment: mocks.create, receiveShipment: mocks.receive,
  receiveShipmentReturn: mocks.returned, getReturnReleaseContext: mocks.releaseView, releaseShipmentReturn: mocks.release }));
vi.mock('../lib/idempotencyService.js', async original => ({ ...await original<typeof import('../lib/idempotencyService.js')>(), runIdempotentOperation: mocks.run }));
import router from './shipments.js';
import { AppError, errorHandler } from '../middleware/errorHandler.js';
const app = express();
app.use(express.json(), (req, _res, next) => { Object.assign(req, { user: mocks.actor }); next(); });
app.use('/shipments', router);
app.use(errorHandler);
const body = { orderId: 'order', carrier: 'Carrier', trackingNumber: 'T1', origin: 'A', destination: 'B',
  lines: [{ outboundTransactionId: 'outbound', quantity: 2 }], evidenceIds: [] };
describe('shipment API boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.actor.role = 'ADMIN'; mocks.access.mockResolvedValue({ id: 'order' });
    mocks.create.mockResolvedValue({ id: 'shipment' });
    mocks.run.mockImplementation(async (_context, operation) => ({ ...await operation(mocks), statusCode: 201, replayed: false }));
    mocks.$transaction.mockImplementation(async operation => operation(mocks));
    mocks.shipment.findUnique.mockResolvedValue({ orderId: 'order' });
    mocks.returnHold.findUnique.mockResolvedValue({ shipmentLine: { shipment: { orderId: 'order' } } });
  });
  it('requires an idempotency key before creating a shipment', async () => {
    await request(app).post('/shipments').send(body).expect(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 2147483648])('rejects quantity %s at the HTTP boundary', async quantity => {
    await request(app).post('/shipments').set('Idempotency-Key', 'key').send({ ...body, lines: [{ outboundTransactionId: 'outbound', quantity }] }).expect(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('rejects unknown nested fields that could replace server-owned source identity', async () => {
    await request(app).post('/shipments').set('Idempotency-Key', 'key').send({ ...body, lines: [{ ...body.lines[0], assignmentId: 'other' }] }).expect(400);
  });
  it('uses stable command identity and validates deferred constraints inside serializable transactions', async () => {
    await request(app).post('/shipments').set('Idempotency-Key', 'key').send(body).expect(201);
    const commandId = mocks.create.mock.calls[0][0].commandId;
    await request(app).post('/shipments').set('Idempotency-Key', 'key').send(body).expect(201);
    expect(mocks.create.mock.calls[1][0].commandId).toBe(commandId);
    expect(commandId).toMatch(/^[a-f\d]{64}$/);
    expect(mocks.run.mock.calls[0][2]).toEqual({ isolationLevel: 'Serializable', validateDeferredConstraints: true });
  });
  it('does not return a cached success after current object permission is revoked', async () => {
    mocks.access.mockResolvedValueOnce({ id: 'order' }).mockRejectedValueOnce(new AppError('Denied', 403, 'AUTH_FORBIDDEN'));
    mocks.run.mockResolvedValueOnce({ payload: { id: 'private' }, statusCode: 201, replayed: true });
    const response = await request(app).post('/shipments').set('Idempotency-Key', 'key').send(body).expect(403);
    expect(response.body.data).toBeUndefined();
  });
  it('allows quality readers without quotation permissions but denies shipment mutation', async () => {
    mocks.actor.role = 'QUALITY_MANAGER';
    mocks.view.mockResolvedValue({ order: { id: 'order' }, shipments: [] });
    await request(app).get('/shipments/orders/order').expect(200);
    await request(app).post('/shipments').set('Idempotency-Key', 'key').send(body).expect(403);
  });
  it('requires independent quality approval capability for a return release', async () => {
    mocks.actor.role = 'MANAGER';
    await request(app).post('/shipments/returns/hold/release').set('Idempotency-Key', 'key').send({}).expect(403);
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('requires proof and reason for receipts', async () => {
    await request(app).post('/shipments/dispatches/shipment/receipts').set('Idempotency-Key', 'key').send({
      lines: [{ shipmentLineId: 'line', quantity: 1 }], evidenceIds: [], reason: 'Received',
    }).expect(400);
    expect(mocks.receive).not.toHaveBeenCalled();
  });
});
