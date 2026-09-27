import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('inquiry source lines and current access', () => {
  const date = new Date('2026-10-01');
  let tx: any;
  let actor: { id: string; role: string; department: string };
  let replay: unknown;
  let currentRead: ReturnType<typeof vi.fn>;
  let idempotencyCache: Map<string, any>;
  beforeEach(() => {
    vi.resetModules();
    replay = undefined;
    idempotencyCache = new Map();
    actor = { id: 'sales-1', role: 'sales', department: 'Sales' };
    currentRead = vi.fn().mockResolvedValue({ id: 'r1' });
    tx = {
      rFQ: { findUnique: vi.fn().mockResolvedValue({
        id: 'r1', createdBy: actor.id, creator: { department: 'Sales' }, status: 'PENDING', urgency: 'STANDARD',
        lines: [{ id: 'l1', lineNo: 1, partNumber: 'P1', quantity: 3, requiredDate: date, certificateRequired: true, status: 'OPEN' }],
      }) },
      supplier: { findMany: vi.fn(async ({ where }) => where.id.in.map((id: string) => ({ id }))) },
      inquiry: { create: vi.fn().mockImplementation(async ({ data }) => ({
        ...data, id: 'i1', supplier: { name: 'Supplier' }, createdAt: date, sentAt: null,
        items: data.items.create.map((item: object, index: number) => ({ ...item, id: `ii-${index}` })),
      })) },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: { rFQ: { findFirst: currentRead } } }));
    vi.doMock('../lib/idempotencyService.js', () => ({
      buildIdempotencyContext: vi.fn((req: express.Request) => ({ key: req.get('Idempotency-Key') })),
      applyIdempotencyHeaders: vi.fn(),
      runIdempotentOperation: vi.fn(async (context: { key?: string }, operation: (transaction: any) => Promise<any>) => {
        if (replay !== undefined) return replay;
        if (context.key && idempotencyCache.has(context.key)) return { ...idempotencyCache.get(context.key), replayed: true, key: context.key };
        const result = await operation(tx);
        const execution = { ...result, replayed: false, key: context.key };
        if (context.key) idempotencyCache.set(context.key, execution);
        return execution;
      }),
    }));
  });
  async function app() {
    const router = (await import('./inquiries.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { Object.assign(req, { user: actor }); next(); });
    instance.use(router);
    instance.use(errorHandler);
    return instance;
  }
  it('persists exact source ids and notes and remains a draft', async () => {
    const response = await request(await app()).post('/').send({ rfqId: 'r1', supplierIds: ['s1'], lineIds: ['l1'], notes: 'Need trace documents' });
    expect(response.status).toBe(201);
    expect(response.body.data[0]).toMatchObject({ rfqId: 'r1', notes: 'Need trace documents', status: 'draft', sourceVerified: true, items: [{ id: 'ii-0', rfqLineId: 'l1', partNumber: 'P1', quantity: 3 }] });
    expect(response.body.data[0]).not.toHaveProperty('sentAt');
  });
  it('rejects cross-RFQ ids without creating inquiries', async () => {
    const response = await request(await app()).post('/').send({ rfqId: 'r1', supplierIds: ['s1'], lineIds: ['another-rfq-line'] });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_RFQ_LINE');
    expect(tx.inquiry.create).not.toHaveBeenCalled();
  });

  it('creates a partial inquiry for exactly the selected line of a multi-line RFQ', async () => {
    tx.rFQ.findUnique.mockResolvedValueOnce({
      id: 'r1', createdBy: actor.id, creator: { department: 'Sales' }, status: 'PENDING', urgency: 'STANDARD',
      lines: [
        { id: 'l1', lineNo: 1, partNumber: 'P1', quantity: 3, requiredDate: date, certificateRequired: true, status: 'OPEN' },
        { id: 'l2', lineNo: 2, partNumber: 'P2', quantity: 5, requiredDate: date, certificateRequired: false, status: 'OPEN' },
      ],
    });
    const response = await request(await app()).post('/').send({ rfqId: 'r1', supplierIds: ['s1'], lineIds: ['l2'] });
    expect(response.status).toBe(201);
    expect(response.body.data[0].items).toHaveLength(1);
    expect(response.body.data[0].items[0]).toMatchObject({ rfqLineId: 'l2', partNumber: 'P2', quantity: 5 });
  });

  it('allows sales to set different line scopes per supplier with separate inquiry submissions', async () => {
    tx.rFQ.findUnique.mockResolvedValue({
      id: 'r1', createdBy: actor.id, creator: { department: 'Sales' }, status: 'PENDING', urgency: 'STANDARD',
      lines: [
        { id: 'l1', lineNo: 1, partNumber: 'P1', quantity: 3, requiredDate: date, certificateRequired: true, status: 'OPEN' },
        { id: 'l2', lineNo: 2, partNumber: 'P2', quantity: 5, requiredDate: date, certificateRequired: false, status: 'OPEN' },
      ],
    });
    const instance = await app();
    const firstSupplier = await request(instance).post('/').send({ rfqId: 'r1', supplierIds: ['s1'], lineIds: ['l1'] });
    const secondSupplier = await request(instance).post('/').send({ rfqId: 'r1', supplierIds: ['s2'], lineIds: ['l2'] });

    expect(firstSupplier.status).toBe(201);
    expect(secondSupplier.status).toBe(201);
    const created = tx.inquiry.create.mock.calls.map(([args]: [{ data: any }]) => args.data);
    expect(created).toHaveLength(2);
    expect(created.map(({ supplierId, items }: any) => ({ supplierId, lineIds: items.create.map((item: any) => item.rfqLineId) })))
      .toEqual([{ supplierId: 's1', lineIds: ['l1'] }, { supplierId: 's2', lineIds: ['l2'] }]);
  });

  it('replays duplicate inquiry creation with the same Idempotency-Key without creating another inquiry', async () => {
    const instance = await app();
    const first = await request(instance).post('/').set('Idempotency-Key', 'create-r1-s1').send({
      rfqId: 'r1', supplierIds: ['s1'], lineIds: ['l1'],
    });
    const duplicate = await request(instance).post('/').set('Idempotency-Key', 'create-r1-s1').send({
      rfqId: 'r1', supplierIds: ['s1'], lineIds: ['l1'],
    });

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.data).toEqual(first.body.data);
    expect(tx.inquiry.create).toHaveBeenCalledTimes(1);
  });

  it.each(['CANCELLED', 'COMPLETED'])('rejects inquiry creation after the RFQ is %s', async (status) => {
    tx.rFQ.findUnique.mockResolvedValueOnce({
      id: 'r1', createdBy: actor.id, creator: { department: 'Sales' }, status, urgency: 'STANDARD',
      lines: [{ id: 'l1', lineNo: 1, partNumber: 'P1', quantity: 3, requiredDate: date, certificateRequired: true, status: 'OPEN' }],
    });
    const response = await request(await app()).post('/').send({ rfqId: 'r1', supplierIds: ['s1'], lineIds: ['l1'] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(response.body.message).toContain('需求已关闭');
    expect(tx.inquiry.create).not.toHaveBeenCalled();
  });

  it('rejects a selected RFQ line that has been closed', async () => {
    tx.rFQ.findUnique.mockResolvedValueOnce({
      id: 'r1', createdBy: actor.id, creator: { department: 'Sales' }, status: 'PENDING', urgency: 'STANDARD',
      lines: [{ id: 'l1', lineNo: 1, partNumber: 'P1', quantity: 3, requiredDate: date, certificateRequired: true, status: 'CLOSED' }],
    });
    const response = await request(await app()).post('/').send({ rfqId: 'r1', supplierIds: ['s1'], lineIds: ['l1'] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(response.body.message).toContain('所选需求行已关闭');
    expect(tx.inquiry.create).not.toHaveBeenCalled();
  });

  it('does not silently select line one for a multi-line RFQ', async () => {
    tx.rFQ.findUnique.mockResolvedValueOnce({
      id: 'r1', createdBy: actor.id, creator: { department: 'Sales' }, status: 'PENDING', urgency: 'STANDARD',
      lines: [
        { id: 'l1', lineNo: 1, partNumber: 'P1', quantity: 3, requiredDate: date, certificateRequired: true, status: 'OPEN' },
        { id: 'l2', lineNo: 2, partNumber: 'P2', quantity: 5, requiredDate: date, certificateRequired: false, status: 'OPEN' },
      ],
    });
    const response = await request(await app()).post('/').send({ rfqId: 'r1', supplierIds: ['s1'] });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('LINE_ID_REQUIRED');
    expect(tx.inquiry.create).not.toHaveBeenCalled();
  });
  it('requires source RFQ access despite global supplier quote capability', async () => {
    actor.id = 'other-sales';
    const response = await request(await app()).post('/').send({ rfqId: 'r1', supplierIds: ['s1'] });
    expect(response.status).toBe(403);
    expect(tx.inquiry.create).not.toHaveBeenCalled();
  });
  it('does not expose a cached draft after access is removed', async () => {
    replay = { payload: [{ id: 'cached-inquiry' }], statusCode: 201 };
    currentRead.mockResolvedValue(null);
    const response = await request(await app()).post('/').send({ rfqId: 'r1', supplierIds: ['s1'] });
    expect(response.status).toBe(404);
    expect(response.body).not.toHaveProperty('data');
  });
});
