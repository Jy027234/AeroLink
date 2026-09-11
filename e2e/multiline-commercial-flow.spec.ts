import { expect, test } from '@playwright/test';

const origin = process.env.PLAYWRIGHT_API_ORIGIN || `http://127.0.0.1:${process.env.PLAYWRIGHT_BACKEND_PORT || '3000'}`;
const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('E2E_PASSWORD is required');

test('three demand lines → two quote lines → approval → partial orders and exact contract', async ({ request }) => {
  const login = async (email: string) => {
    const response = await request.post(`${origin}/api/auth/login`, { data: { email, password } });
    expect(response.status()).toBe(200);
    return (await response.json()).data.token as string;
  };
  const sales = await login('sales-test@aerolink.com');
  const finance = await login('li@aerolink.com');
  const manager = await login('zhang@aerolink.com');
  const suffix = `${Date.now()}`;
  const headers = (token: string, key?: string) => ({ Authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) });
  const post = (path: string, data: unknown, token = sales, key?: string) => request.post(`${origin}/api/${path}`, { headers: headers(token, key), data });
  const get = (path: string, token = sales) => request.get(`${origin}/api/${path}`, { headers: headers(token) });
  const rfqResponse = await post('rfqs', { customerId: 'c001', lines: [4, 3, 5].map((quantity, i) => ({
    partNumber: `HTTP-MULTI-${suffix}-${i + 1}`, quantity, requiredDate: '2027-01-15',
  })) });
  expect(rfqResponse.status(), await rfqResponse.text()).toBe(201);
  const rfq = (await rfqResponse.json()).data;
  expect(rfq.lineItemsMode).toBe(true);
  expect(rfq.lines).toHaveLength(3);
  const inquiryResponse = await post('inquiries', { rfqId: rfq.id, supplierIds: ['s001'], lineIds: [rfq.lines[0].id, rfq.lines[2].id] });
  expect(inquiryResponse.status(), await inquiryResponse.text()).toBe(201);
  const quoteBody = { rfqId: rfq.id, customerId: 'c001', currency: 'USD', lines: rfq.lines.slice(0, 2).map((line: { id: string; partNumber: string; quantity: number }, i: number) => ({
    rfqLineId: line.id, partNumber: line.partNumber, quantity: line.quantity, unitPrice: i ? 2000.1234 : 1000.0001,
    costPrice: 600.0001, costSourceType: 'MANUAL', costSourceReason: 'Synthetic HTTP acceptance cost basis',
  })) };
  const mixed = await post('quotations', { ...quoteBody, partNumber: rfq.lines[0].partNumber });
  expect(mixed.status()).toBe(400);
  const created = await post('quotations', quoteBody);
  expect(created.status(), await created.text()).toBe(201);
  const quote = (await created.json()).data;
  expect(quote.totalPrice).toBe(10000.3706);
  expect(quote.lines).toHaveLength(2);
  expect(quote.lines[0].costPrice).toBeUndefined();
  const quoteList = (await (await get(`quotations?search=${encodeURIComponent(rfq.lines[1].partNumber)}`)).json()).data;
  const listedQuote = quoteList.find((item: { id: string }) => item.id === quote.id);
  expect(listedQuote.lineItemsMode).toBe(true);
  expect(listedQuote.lines).toHaveLength(2);
  expect(listedQuote.lines[1].costPrice).toBeUndefined();
  const submitted = await post(`quotations/${quote.id}/submit`, { version: quote.version });
  expect(submitted.status(), await submitted.text()).toBe(200);
  const submitData = (await submitted.json()).data;
  const lowerApproval = await post(`quotations/${quote.id}/approve`, { action: 'approve', version: submitData.version }, manager);
  expect(lowerApproval.status()).toBe(403);
  const approved = await post(`quotations/${quote.id}/approve`, { action: 'approve', version: submitData.version }, finance);
  expect(approved.status(), await approved.text()).toBe(200);
  const approvedData = (await approved.json()).data;
  const detail = await get(`quotations/${quote.id}`);
  expect((await detail.json()).data.requiresReapproval).toBe(false);
  expect((await detail.json()).data.lines[1].costSourceReason).toBeUndefined();
  const acceptance = { version: approvedData.version, lines: [{ quotationLineId: quote.lines[0].id, quantity: 1 }] };
  const key = `multiline-partial-${suffix}`;
  const first = await post(`quotations/${quote.id}/accept`, acceptance, sales, key);
  expect(first.status(), await first.text()).toBe(200);
  const firstData = (await first.json()).data;
  expect(firstData.order.totalAmount).toBe(1000.0001);
  expect(firstData.order.lines).toHaveLength(1);
  const replay = await post(`quotations/${quote.id}/accept`, acceptance, sales, key);
  expect(replay.status(), await replay.text()).toBe(200);
  expect((await replay.json()).data.order.id).toBe(firstData.order.id);
  const stale = await post(`quotations/${quote.id}/accept`, acceptance);
  expect(stale.status()).toBe(409);
  const second = await post(`quotations/${quote.id}/accept`, { version: firstData.version, lines: [
    { quotationLineId: quote.lines[0].id, quantity: 3 }, { quotationLineId: quote.lines[1].id, quantity: 3 },
  ] });
  expect(second.status(), await second.text()).toBe(200);
  const secondData = (await second.json()).data;
  expect(secondData.order.id).not.toBe(firstData.order.id);
  expect(secondData.order.lines).toHaveLength(2);
  expect(secondData.order.totalAmount).toBe(9000.3705);
  expect(secondData.status).toBe('accepted');
  expect(secondData.contractDocumentId).not.toBe(firstData.contractDocumentId);
  const orderList = (await (await get(`orders?search=${encodeURIComponent(rfq.lines[1].partNumber)}`)).json()).data;
  const listedOrder = orderList.find((item: { id: string }) => item.id === secondData.order.id);
  expect(listedOrder.lineItemsMode).toBe(true);
  expect(listedOrder.lines).toHaveLength(2);
  const final = (await (await get(`quotations/${quote.id}`)).json()).data;
  expect(final.orders).toHaveLength(2);
  expect(final.lines.map((line: { acceptedQuantity: number }) => line.acceptedQuantity)).toEqual([4, 3]);
  const pdf = await get(`quotations/${quote.id}/pdf`);
  expect(pdf.status(), await pdf.text()).toBe(200);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');
});
