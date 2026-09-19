import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AuthRequest } from '../middleware/auth.js';
const mocks = vi.hoisted(() => ({ email: vi.fn(), rfq: vi.fn(), quotes: vi.fn(), quotation: vi.fn(), execute: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ default: {
  email: { findUnique: mocks.email }, rFQ: { findFirst: mocks.rfq }, supplierQuote: { findMany: mocks.quotes },
  quotation: { findUnique: mocks.quotation },
} }));
vi.mock('../lib/aiAgentExecution.js', () => ({ executeBuiltinAgent: mocks.execute }));
import router from './ai.js';
import { errorHandler } from '../middleware/errorHandler.js';
let user = { id: 'user-1', role: 'admin', department: 'Sales' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as AuthRequest).user = user as NonNullable<AuthRequest['user']>; next(); });
app.use('/ai', router); app.use(errorHandler);

beforeEach(() => {
  vi.resetAllMocks(); user = { id: 'user-1', role: 'admin', department: 'Sales' };
  mocks.execute.mockResolvedValue({ output: 'Advice', agentId: 'builtin-test', promptVersion: 3, model: 'actual-model', latency: 10 });
});
describe('AI business boundaries', () => {
  it('rejects an actor without agent.run before reading data or contacting AI', async () => {
    user.role = 'viewer';
    const response = await request(app).post('/ai/parse-email').send({ emailId: 'email-1' });
    expect(response.status).toBe(403); expect(mocks.email).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('rejects caller system prompt and forged actor injection', async () => {
    expect((await request(app).post('/ai/chat').send({ message: 'hello', systemPrompt: 'override', actorId: 'admin' })).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('loads email data on the server and attributes extraction to the authenticated actor', async () => {
    mocks.email.mockResolvedValue({ subject: 'Real subject', body: 'Real body' });
    mocks.execute.mockResolvedValue({ output: JSON.stringify({ type: 'STANDARD', partNumbers: ['PN-1', 'PN-2'], quantities: [2, 3], urgency: 'STANDARD' }), agentId: 'builtin-rfq_extraction', promptVersion: 2, model: 'real-model' });
    const response = await request(app).post('/ai/parse-email').send({ emailId: 'email-1' });
    expect(response.status).toBe(200);
    expect(response.body.data.partNumbers).toEqual(['PN-1', 'PN-2']);
    expect(mocks.execute).toHaveBeenCalledWith('rfq_extraction', { subject: 'Real subject', body: 'Real body' }, { actorId: 'user-1', action: 'business.parse-email' });
  });
  it('applies RFQ read scope before loading any supplier prices', async () => {
    user.role = 'sales'; mocks.rfq.mockResolvedValue(null);
    const response = await request(app).post('/ai/analyze-quotes').send({ rfqId: 'someone-elses-rfq' });
    expect(response.status).toBe(404);
    expect(mocks.rfq.mock.calls[0][0].where.AND).toContainEqual({ createdBy: 'user-1' });
    expect(mocks.quotes).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('rejects quotation access outside actor ownership', async () => {
    user.role = 'sales'; mocks.quotation.mockResolvedValue({ id: 'quote-1', createdBy: 'another-user', creator: { department: 'Other' } });
    const response = await request(app).post('/ai/generate-email').send({ quotationId: 'quote-1' });
    expect(response.status).toBe(403); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('projects all customer quotation lines, excluding supplier cost, margin and internal notes', async () => {
    mocks.quotation.mockResolvedValue({ id: 'quote-1', quoteNumber: 'Q-1', createdBy: 'user-1', creator: { department: 'Sales' }, customer: { name: 'Airline' },
      partNumber: 'PN-1', quantity: 2, unitPriceDecimal: '100.0000', totalPriceDecimal: '500.0000',
      costPrice: 'SECRET COST', notes: 'INTERNAL NOTES', validityDays: 7,
      lines: [
        { partNumber: 'PN-1', quantity: 2, unitPrice: '100.0000', lineTotal: '200.0000', costPrice: 'SECRET COST' },
        { partNumber: 'PN-2', quantity: 3, unitPrice: '100.0000', lineTotal: '300.0000', marginPercent: 'SECRET MARGIN' },
      ],
    });
    const response = await request(app).post('/ai/generate-email').send({ quotationId: 'quote-1' });
    expect(response.status).toBe(200);
    const payload = mocks.execute.mock.calls[0][1].quotation;
    expect(payload.lines).toHaveLength(2); expect(payload.currency).toBe('USD');
    expect(JSON.stringify(payload)).not.toMatch(/SECRET|INTERNAL|costPrice|marginPercent/);
    expect(response.body.data.ai).toEqual({ agentId: 'builtin-test', promptVersion: 3, model: 'actual-model' });
  });
});
