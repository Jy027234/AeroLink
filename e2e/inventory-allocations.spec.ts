import { expect, test } from '@playwright/test';

const origin = process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000';
const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('E2E_PASSWORD is required');

test('modern allocation → explicit acceptance → independent batch review → partial and final outbound', async ({ request }) => {
  const login = async (email: string) => {
    const response = await request.post(`${origin}/api/auth/login`, { data: { email, password } });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).data.token as string;
  };
  const sales = await login('sales-test@aerolink.com');
  const manager = await login('zhang@aerolink.com');
  const quality = await login('quality-test@aerolink.com');
  const peer = await login('test-sales-peer@aerolink.com');
  const tag = `${Date.now()}`;
  let counter = 0;
  const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
  const post = (path: string, data: unknown, token = manager, key = `${tag}-${++counter}`) => request.post(`${origin}/api/${path}`, {
    data, headers: { ...headers(token), 'Idempotency-Key': key },
  });
  const ok = async (response: Awaited<ReturnType<typeof post>>, status = 200) => {
    expect(response.status(), await response.text()).toBe(status);
    return (await response.json()).data;
  };
  const get = (path: string, token = manager) => request.get(`${origin}/api/${path}`, { headers: headers(token) });
  const partNumber = `ALLOC-HTTP-${tag}`;
  const batch = `B-${tag}`;
  const detail = await ok(await post('inventory', { partNumber, description: 'Synthetic allocation HTTP stock', quantity: 6,
    batchNumber: batch, unitCost: 50, type: 'OWN', trackingType: 'BATCH', conditionCode: 'NE', location: 'TEST' }), 201);
  const rfq = await ok(await post('rfqs', { customerId: 'c001', lines: [{ partNumber, quantity: 6,
    requiredDate: '2027-01-15', certificateRequired: true, certificateType: 'FAA-8130-3' }] }, sales), 201);
  const quote = await ok(await post('quotations', { rfqId: rfq.id, customerId: 'c001', currency: 'USD', validityDays: 7,
    lines: [{ rfqLineId: rfq.lines[0].id, partNumber, quantity: 6, unitPrice: 100, costPrice: 50,
      costSourceType: 'MANUAL', costSourceReason: 'Synthetic allocation HTTP cost source' }] }, sales), 201);
  const submitted = await ok(await post(`quotations/${quote.id}/submit`, { version: quote.version }, sales));
  await ok(await post(`quotations/${quote.id}/approve`, { version: submitted.version, action: 'approve' }));
  const reserveBody = { quotationLineId: quote.lines[0].id, allocations: [{ inventoryDetailId: detail.id, quantity: 6 }] };
  await ok(await post('inventory-allocations/reserve', reserveBody, sales), 403);
  const reservation = await ok(await post('inventory-allocations/reserve', reserveBody, manager, `${tag}-reserve`), 201);
  const replay = await post('inventory-allocations/reserve', reserveBody, manager, `${tag}-reserve`);
  expect(replay.headers()['idempotency-replayed']).toBe('true');
  await ok(replay, 201);
  const allocationId = reservation.allocations[0].id;
  const deniedRead = await get(`inventory-allocations/quotation-lines/${quote.lines[0].id}`, peer);
  expect(deniedRead.status()).toBe(403);
  const salesView = await ok(await get(`inventory-allocations/quotation-lines/${quote.lines[0].id}`, sales));
  expect(salesView.unassignedQuantity).toBe(6);
  expect(JSON.stringify(salesView)).not.toMatch(/unitCost|costPrice|margin/);
  const current = await ok(await get(`quotations/${quote.id}`));
  await ok(await post(`quotations/${quote.id}/accept`, { version: current.version, lines: [{ quotationLineId: quote.lines[0].id, quantity: 3 }] }, sales), 409);
  const accepted = await ok(await post(`quotations/${quote.id}/accept`, { version: current.version,
    lines: [{ quotationLineId: quote.lines[0].id, quantity: 3, allocations: [{ allocationId, quantity: 3 }] }] }));
  const orderLineId = accepted.order.lines[0].id;
  const orderView = await ok(await get(`inventory-allocations/order-lines/${orderLineId}`, quality));
  const assignmentId = orderView.assignments[0].id;
  expect(orderView.assignments[0].activeQuantity).toBe(3);
  await ok(await post('certificates/issue', { inventoryDetailId: detail.id, orderId: accepted.order.id, partNumber,
    batchNumber: `OTHER-${batch}`, quantity: 3, conditionCode: 'NE', certificateType: 'FAA-8130-3', description: 'Synthetic wrong-batch certificate' }, quality), 201);
  const uploaded = await request.post(`${origin}/api/upload`, { headers: headers(quality), multipart: {
    file: { name: 'allocation-evidence.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% Synthetic allocation evidence\n') },
  } });
  const upload = await ok(uploaded);
  const evidenceId = upload.id;
  const review = async (quantity: number, expectedStatus = 201) => {
    const preview = await ok(await get(`inventory-allocations/quality-review/${assignmentId}?quantity=${quantity}`, quality));
    expect(preview.snapshot.inventory.batchNumber).toBe(batch);
    const body = { assignmentId, quantity, snapshotHash: preview.snapshotHash, approved: true, evidenceIds: [evidenceId],
      verifiedSerialNumber: '', verifiedBatchNumber: batch,
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      reason: 'Synthetic assignment batch and certificate verified independently' };
    return ok(await post('inventory-allocations/quality-reviews', body, quality), expectedStatus);
  };
  await review(1, 409);
  await ok(await post('certificates/issue', { inventoryDetailId: detail.id, orderId: accepted.order.id, partNumber,
    batchNumber: batch, quantity: 3, conditionCode: 'NE', certificateType: 'FAA-8130-3', description: 'Synthetic matching certificate' }, quality), 201);
  const firstReview = await review(1);
  const firstOutbound = await ok(await post('inventory-allocations/consume', { assignmentId, quantity: 1, reviewId: firstReview.id }));
  expect(firstOutbound.afterQuantity).toBe(5);
  expect(firstOutbound.orderStatus).toBe('SO_CREATED');
  expect(JSON.stringify(firstOutbound)).not.toMatch(/costPrice|unitCost|totalAmount/);
  await ok(await post('inventory-allocations/consume', { assignmentId, quantity: 1, reviewId: firstReview.id }), 409);
  const finalReview = await review(2);
  const finalOutbound = await ok(await post('inventory-allocations/consume', { assignmentId, quantity: 2, reviewId: finalReview.id }));
  expect(finalOutbound.orderStatus).toBe('SHIPPED');
  const finalOrder = await ok(await get(`orders/${accepted.order.id}`, sales));
  expect(finalOrder.outboundQuantity).toBe(3);
  const remaining = await ok(await get(`inventory-allocations/quotation-lines/${quote.lines[0].id}`, sales));
  expect(remaining.unassignedQuantity).toBe(3);
  await ok(await post('inventory-allocations/release', { allocationId, quantity: 3, reason: 'Synthetic remaining demand cancelled' }));
});
