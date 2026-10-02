import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AuthRequest } from '../middleware/auth.js';
const mocks = vi.hoisted(() => ({
  email: vi.fn(), rfq: vi.fn(), quotes: vi.fn(), quotation: vi.fn(), comparison: vi.fn(), execute: vi.fn(),
}));
vi.mock('../lib/prisma.js', () => ({ default: {
  email: { findUnique: mocks.email }, rFQ: { findFirst: mocks.rfq }, supplierQuote: { findMany: mocks.quotes },
  quotation: { findUnique: mocks.quotation },
} }));
vi.mock('../lib/aiAgentExecution.js', () => ({ executeBuiltinAgent: mocks.execute }));
vi.mock('./supplierQuotes.js', () => ({ compareRfqSupplierQuotesDeterministically: mocks.comparison }));
import router from './ai.js';
import { getBuiltinAgent } from '../lib/aiAgentRegistry.js';
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
    expect(mocks.quotes).not.toHaveBeenCalled(); expect(mocks.comparison).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('explains independent deterministic line comparisons without cross-line price ranking', async () => {
    const quote = (id: string, rfqLineId: string, inquiryId: string) => ({
      id, rfqId: 'rfq-1', rfqLineId, inquiryId, inquiryItemId: `${inquiryId}-item`, supplierId: `${id}-supplier`,
      partNumber: 'DUPLICATE-PN', quantity: 2, quantityUnit: 'EA', unitPrice: 100, totalPrice: 200,
      currency: 'USD', currencyStatus: 'verified', leadTimeDays: 4, validUntil: null, status: 'ACCEPTED',
      eligibleForComparison: true, eligibilityReasons: [], warnings: [], commercialTerms: { taxIncluded: true, incoterm: 'FCA' },
      commercialBasisKey: 'basis-tax-fca', commercialBasisLabel: '含税 / FCA', priceDiff: 0,
      scoreComponents: { price: 100, leadTime: 100, supplierPerformance: 90 }, ruleScore: 98,
      supplier: { name: `Supplier ${id}` },
    });
    const firstQuote = quote('quote-line-1', 'line-1', 'inquiry-1');
    const secondQuote = quote('quote-line-2', 'line-2', 'inquiry-2');
    const comparison = (rfqLineId: string, quantity: number, quoteRow: ReturnType<typeof quote> | null) => ({
      rfqId: 'rfq-1', rfqLineId, requiredQuantityUnit: 'EA',
      quotes: quoteRow ? [quoteRow] : [],
      summary: { requiredQuantity: quantity, totalQuotes: quoteRow ? 1 : 0 },
      metadata: { status: quoteRow ? 'available' : 'unavailable', reason: quoteRow ? '规则结果可用' : '该行尚无报价' },
      partNumberGroups: quoteRow ? [{
        partNumber: 'DUPLICATE-PN',
        metadata: { status: 'available', reason: '仅同商务口径比较' },
        commercialBasisGroups: [{
          key: 'basis-tax-fca', label: '含税 / FCA', terms: { taxIncluded: true, incoterm: 'FCA' },
          summary: { totalQuotes: 1, comparableQuoteCount: 1, lowestPrice: 100, highestPrice: 100, averagePrice: 100 },
          metadata: { status: 'available', reason: '同口径规则排序' }, quotes: [quoteRow],
        }],
      }] : [],
    });
    mocks.rfq.mockResolvedValue({
      rfqNumber: 'RFQ-1', partNumber: 'DUPLICATE-PN', quantity: 2, requiredDate: null, urgency: 'STANDARD',
      lines: [
        { id: 'line-1', lineNo: 1, partNumber: 'DUPLICATE-PN', quantity: 2 },
        { id: 'line-2', lineNo: 2, partNumber: 'DUPLICATE-PN', quantity: 9 },
      ],
    });
    mocks.comparison.mockResolvedValue({ success: true, data: { rfqId: 'rfq-1', lineGroups: [
      { rfqLineId: 'line-1', lineNo: 1, partNumber: 'DUPLICATE-PN', comparison: comparison('line-1', 2, firstQuote) },
      { rfqLineId: 'line-2', lineNo: 2, partNumber: 'DUPLICATE-PN', comparison: comparison('line-2', 9, null) },
    ] } });

    const response = await request(app).post('/ai/analyze-quotes').send({ rfqId: 'rfq-1' });

    expect(response.status).toBe(200);
    expect(mocks.rfq.mock.invocationCallOrder[0]).toBeLessThan(mocks.comparison.mock.invocationCallOrder[0]);
    expect(mocks.comparison).toHaveBeenCalledWith('rfq-1', { activeLinesOnly: true });
    expect(mocks.quotes).not.toHaveBeenCalled();
    const [agentKey, aiInput] = mocks.execute.mock.calls[0];
    expect(agentKey).toBe('quote_analysis');
    const rfqInput = JSON.parse(aiInput.rfqDetails);
    const supplierInput = JSON.parse(aiInput.supplierQuotes);
    expect(rfqInput.demandLines.map((line: { rfqLineId: string }) => line.rfqLineId)).toEqual(['line-1', 'line-2']);
    expect(supplierInput.lineGroups.map((line: { rfqLineId: string }) => line.rfqLineId)).toEqual(['line-1', 'line-2']);
    expect(supplierInput.lineGroups[0]).toMatchObject({
      rfqLineId: 'line-1',
      partNumberGroups: [{ commercialBasisGroups: [{ quotes: [{
        supplierQuoteId: 'quote-line-1',
        source: { rfqLineId: 'line-1', inquiryId: 'inquiry-1', inquiryItemId: 'inquiry-1-item' },
        eligibleForComparison: true,
        commercialBasisLabel: '含税 / FCA',
        unitPrice: 100,
        leadTimeDays: 4,
        deterministicRuleOrderWithinBasis: 1,
      }] }] }],
    });
    expect(supplierInput.lineGroups[1]).toMatchObject({ rfqLineId: 'line-2', partNumberGroups: [] });
    expect(supplierInput).not.toHaveProperty('topRanked');
    expect(supplierInput).not.toHaveProperty('summary.lowestPrice');
    expect(JSON.stringify(supplierInput)).not.toContain('topRanked');
    expect(JSON.stringify(supplierInput)).not.toContain('isWinner');
    const prompt = getBuiltinAgent('quote_analysis')!.prompts.map((item) => item.content).join('\n');
    expect(prompt).toContain('严禁跨 rfqLineId');
    expect(prompt).toContain('绝不建议、推断或自动决定中选');
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
