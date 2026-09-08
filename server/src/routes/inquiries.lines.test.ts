import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('inquiry source lines and current access', () => {
  const date = new Date('2026-10-01');
  let tx: any;
  let actor: { id: string; role: string; department: string };
  let replay: unknown;
  let currentRead: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    replay = undefined;
    actor = { id: 'sales-1', role: 'sales', department: 'Sales' };
    currentRead = vi.fn().mockResolvedValue({ id: 'r1' });
    tx = {
      rFQ: { findUnique: vi.fn().mockResolvedValue({
        id: 'r1', createdBy: actor.id, creator: { department: 'Sales' }, status: 'PENDING', urgency: 'STANDARD',
        lines: [{ id: 'l1', lineNo: 1, partNumber: 'P1', quantity: 3, requiredDate: date, certificateRequired: true, status: 'OPEN' }],
      }) },
      supplier: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
      inquiry: { create: vi.fn().mockImplementation(async ({ data }) => ({
        ...data, id: 'i1', supplier: { name: 'Supplier' }, createdAt: date, sentAt: null,
        items: data.items.create.map((item: object, index: number) => ({ ...item, id: `ii-${index}` })),
      })) },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: { rFQ: { findFirst: currentRead } } }));
    vi.doMock('../lib/idempotencyService.js', () => ({
      buildIdempotencyContext: vi.fn(), applyIdempotencyHeaders: vi.fn(),
      runIdempotentOperation: vi.fn(async (_context, operation) => replay ?? operation(tx)),
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
