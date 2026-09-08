import { expect, test } from '@playwright/test';

const origin = process.env.PLAYWRIGHT_API_ORIGIN || `http://127.0.0.1:${process.env.PLAYWRIGHT_BACKEND_PORT || '3000'}`;
const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('E2E_PASSWORD is required');

test('partial sale → immutable commercial revision → independent reapproval', async ({ request }) => {
  const login = async (email: string) => {
    const response = await request.post(`${origin}/api/auth/login`, { data: { email, password } });
    expect(response.status()).toBe(200);
    return (await response.json()).data.token as string;
  };
  const sales = await login('sales-test@aerolink.com');
  const manager = await login('zhang@aerolink.com');
  const peer = await login('test-sales-peer@aerolink.com');
  const suffix = `${Date.now()}`;
  const post = (path: string, data: unknown, token = sales, key?: string) => request.post(`${origin}/api/${path}`, {
    data, headers: { Authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) },
  });
  const get = async (path: string) => {
    const response = await request.get(`${origin}/api/${path}`, { headers: { Authorization: `Bearer ${sales}` } });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).data;
  };
  const rfqResponse = await post('rfqs', { customerId: 'c001', lines: [4, 3].map((quantity, i) => ({
    partNumber: `REV-HTTP-${suffix}-${i}`, quantity, requiredDate: '2027-01-15',
  })) });
  expect(rfqResponse.status()).toBe(201);
  const rfq = (await rfqResponse.json()).data;
  const input = { rfqId: rfq.id, customerId: 'c001', currency: 'USD', validityDays: 7,
    lines: rfq.lines.map((line: { id: string; partNumber: string; quantity: number }) => ({
      rfqLineId: line.id, partNumber: line.partNumber, quantity: line.quantity, unitPrice: 100, costPrice: 50,
      costSourceType: 'MANUAL', costSourceReason: 'Synthetic original commercial cost',
    })) };
  const created = await post('quotations', input);
  expect(created.status()).toBe(201);
  const quote = (await created.json()).data;
  expect(quote.commercialRevision).toBe(1);
  const submit = await post(`quotations/${quote.id}/submit`, { version: quote.version });
  expect(submit.status()).toBe(200);
  const approve = await post(`quotations/${quote.id}/approve`, { action: 'approve', version: (await submit.json()).data.version }, manager);
  expect(approve.status()).toBe(200);
  const frozenDocuments = await get(`documents?quotationId=${quote.id}&documentType=QUOTATION_PDF`);
  expect(frozenDocuments).toHaveLength(1);
  const publicDocument = await get(`documents/${frozenDocuments[0].id}`);
  expect(publicDocument.pdfBytes).toBeUndefined();
  const originalPdfResponse = await request.get(`${origin}/api/documents/${publicDocument.id}/pdf`, {
    headers: { Authorization: `Bearer ${sales}` },
  });
  expect(originalPdfResponse.status()).toBe(200);
  const originalPdf = await originalPdfResponse.body();
  expect(originalPdf.subarray(0, 4).toString()).toBe('%PDF');
  const accepted = await post(`quotations/${quote.id}/accept`, { version: (await approve.json()).data.version,
    lines: [{ quotationLineId: quote.lines[0].id, quantity: 2 }] });
  expect(accepted.status(), await accepted.text()).toBe(200);
  const partial = (await accepted.json()).data;
  const before = await get(`quotations/${quote.id}`);
  const revisionBody = { version: partial.version, reason: 'Buyer requested revised remaining prices and warranty',
    quotation: { ...input, warrantyDays: 180, lines: input.lines.map((line: { quantity: number }, i: number) => ({
      ...line, quantity: i ? 3 : 2, unitPrice: 125,
    })) } };
  const revision = await post(`quotations/${quote.id}/revise`, revisionBody, sales, `revision-${suffix}`);
  expect(revision.status(), await revision.text()).toBe(201);
  const revised = (await revision.json()).data;
  expect(revised.status).toBe('draft');
  expect(revised.commercialRevision).toBe(2);
  expect(revised.revisionOfId).toBe(quote.id);
  expect(revised.totalPrice).toBe(625);
  expect(revised.lines[0].costPrice).toBeUndefined();
  const replay = await post(`quotations/${quote.id}/revise`, revisionBody, sales, `revision-${suffix}`);
  expect(replay.status()).toBe(201);
  expect((await replay.json()).data.id).toBe(revised.id);
  expect((await get(`quotations/${quote.id}`)).approvals).toEqual(before.approvals);
  const old = await get(`quotations/${quote.id}`);
  expect(old.supersededById).toBe(revised.id);
  expect(old.lines.map((line: { acceptedQuantity: number }) => line.acceptedQuantity)).toEqual([2, 0]);
  expect(old.orders[0].id).toBe(partial.order.id);
  const historicalPdf = await request.get(`${origin}/api/quotations/${quote.id}/pdf`, {
    headers: { Authorization: `Bearer ${sales}` },
  });
  expect(historicalPdf.status()).toBe(200);
  expect(await historicalPdf.body()).toEqual(originalPdf);
  expect((await post(`quotations/${quote.id}/send`, {})).status()).toBe(409);
  expect((await post(`quotations/${quote.id}/withdraw`, { version: old.version, reason: 'Superseded quote cannot change', sendWithdrawalNotice: false })).status()).toBe(409);
  expect((await post(`quotations/${quote.id}/approve`, { action: 'approve', version: old.version }, manager)).status()).toBe(409);
  expect((await post(`quotations/${quote.id}/accept`, { version: old.version, lines: [{ quotationLineId: quote.lines[0].id, quantity: 1 }] })).status()).toBe(409);
  expect((await post(`quotations/${revised.id}/accept`, { version: revised.version,
    lines: [{ quotationLineId: revised.lines[0].id, quantity: 1 }] })).status()).toBe(409);
  const history = await get(`quotations/${revised.id}/revisions`);
  expect(history.map((item: { commercialRevision: number }) => item.commercialRevision)).toEqual([1, 2]);
  expect(history[1].revisionReason).toBe(revisionBody.reason);
  expect((await post(`quotations/${revised.id}/revise`, { ...revisionBody, version: revised.version }, peer)).status()).toBe(403);
  const resubmit = await post(`quotations/${revised.id}/submit`, { version: revised.version });
  expect(resubmit.status()).toBe(200);
  const reapprove = await post(`quotations/${revised.id}/approve`, { action: 'approve', version: (await resubmit.json()).data.version }, manager);
  expect(reapprove.status(), await reapprove.text()).toBe(200);
  expect((await get(`quotations/${revised.id}`)).requiresReapproval).toBe(false);
});
