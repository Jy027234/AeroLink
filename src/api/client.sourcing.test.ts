import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailApi, fileApi, setAccessToken, sourcingAiTaskApi, supplierQuoteDraftApi } from './client';

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => body,
});

afterEach(() => {
  setAccessToken(null);
  vi.unstubAllGlobals();
});

describe('sourcing reply API contracts', () => {
  it('loads only the selected inquiry replies and supports manual inquiry links with a reason', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 }, summary: { total: 0, aog: 0, standard: 0, inquiry: 0, unread: 0, spam: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 'link-1' } }));
    vi.stubGlobal('fetch', fetchMock);

    await emailApi.getAll({ inquiryId: 'inquiry/1', needsInquiryMatch: true, page: 1, limit: 100 });
    await emailApi.linkToInquiry('email/1', { inquiryId: 'inquiry/1', manualReason: 'Supplier reply references the inquiry number.' });

    expect(String(fetchMock.mock.calls[0][0])).toContain('/emails?');
    expect(String(fetchMock.mock.calls[0][0])).toContain('inquiryId=inquiry%2F1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('needsInquiryMatch=true');
    expect(fetchMock.mock.calls[1][0]).toContain('/emails/email%2F1/inquiry-links');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      inquiryId: 'inquiry/1',
      manualReason: 'Supplier reply references the inquiry number.',
    });
  });

  it('uses the versioned quote-draft endpoints and preserves their request bodies', async () => {
    const record = {
      id: 'draft-1', emailId: 'email-1', inquiryId: 'inquiry-1', supplierId: 'supplier-1',
      status: 'DRAFT', version: 2, payload: { items: [{ itemKey: 'item-1', currency: 'USD' }] },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: record }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: record }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: record }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: record }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: record }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { draftId: 'draft-1', status: 'CONFIRMED', version: 3, reused: false, supplierQuoteIds: ['quote-1'], createdSupplierQuoteIds: ['quote-1'], reusedSupplierQuoteIds: [], supplierQuotes: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const payload = { items: [{ itemKey: 'item-1', inquiryItemId: 'inq-item-1', currency: 'USD' }] };

    await supplierQuoteDraftApi.create({ emailId: 'email-1', inquiryId: 'inquiry-1', payload });
    await supplierQuoteDraftApi.extract({ emailId: 'email-1', inquiryId: 'inquiry-1' });
    await supplierQuoteDraftApi.getById('draft/1');
    await supplierQuoteDraftApi.getLatest('email/1', 'inquiry/1');
    await supplierQuoteDraftApi.update('draft-1', { expectedVersion: 2, payload });
    await supplierQuoteDraftApi.confirm('draft-1', { expectedVersion: 3 });

    expect(fetchMock.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method ?? 'GET'])).toEqual([
      ['/api/supplier-quote-drafts', 'POST'],
      ['/api/supplier-quote-drafts/extract', 'POST'],
      ['/api/supplier-quote-drafts/draft%2F1', 'GET'],
      ['/api/supplier-quote-drafts', 'GET'],
      ['/api/supplier-quote-drafts/draft-1', 'PATCH'],
      ['/api/supplier-quote-drafts/draft-1/confirm', 'POST'],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ emailId: 'email-1', inquiryId: 'inquiry-1', payload });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ emailId: 'email-1', inquiryId: 'inquiry-1' });
    expect(String(fetchMock.mock.calls[3][0])).toContain('emailId=email%2F1');
    expect(String(fetchMock.mock.calls[3][0])).toContain('inquiryId=inquiry%2F1');
    expect(JSON.parse(String(fetchMock.mock.calls[4][1].body))).toEqual({ expectedVersion: 2, payload });
    expect(JSON.parse(String(fetchMock.mock.calls[5][1].body))).toEqual({ expectedVersion: 3 });
  });

  it('surfaces model failures as errors instead of a successful extraction result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: false, message: 'AI model is unavailable' }, 503)));

    await expect(supplierQuoteDraftApi.extract({ emailId: 'email-1', inquiryId: 'inquiry-1' }))
      .rejects.toThrow('AI model is unavailable');
  });

  it('creates, reads, retries and cancels server-owned sourcing AI tasks', async () => {
    const task = { id: 'task-1', status: 'FAILED' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: task }));
    vi.stubGlobal('fetch', fetchMock);

    await sourcingAiTaskApi.create({
      type: 'supplier_quote_extraction', emailId: 'email/1', inquiryId: 'inquiry/1', idempotencyKey: 'request-1',
    });
    await sourcingAiTaskApi.list({ limit: 25, emailId: 'email-1', inquiryId: 'inquiry-1' });
    await sourcingAiTaskApi.getById('task/1');
    await sourcingAiTaskApi.retry('task/1');
    await sourcingAiTaskApi.cancel('task/1');

    expect(fetchMock.mock.calls.map(([url, init]) => [new URL(String(url)).pathname + new URL(String(url)).search, init?.method ?? 'GET'])).toEqual([
      ['/api/sourcing-ai-tasks', 'POST'],
      ['/api/sourcing-ai-tasks?limit=25&emailId=email-1&inquiryId=inquiry-1', 'GET'],
      ['/api/sourcing-ai-tasks/task%2F1', 'GET'],
      ['/api/sourcing-ai-tasks/task%2F1/retry', 'POST'],
      ['/api/sourcing-ai-tasks/task%2F1/cancel', 'POST'],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      type: 'supplier_quote_extraction', emailId: 'email/1', inquiryId: 'inquiry/1', idempotencyKey: 'request-1',
    });
  });

  it('downloads attachments through the authenticated API client', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      blob: async () => new Blob(['quote'], { type: 'application/pdf' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setAccessToken('access-token');

    await fileApi.download('stored/1');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/files/stored%2F1');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer access-token');
  });
});
