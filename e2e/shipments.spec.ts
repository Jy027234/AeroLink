import { expect, test } from '@playwright/test';

const origin = process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000';
const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('E2E_PASSWORD is required');

test('two shipment tracking numbers preserve batch sources, partial receipt and quarantined return quantities', async ({ request }) => {
  const login = async (email: string) => {
    const response = await request.post(`${origin}/api/auth/login`, { data: { email, password } });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).data.token as string;
  };
  const sales = await login('sales-test@aerolink.com');
  const manager = await login('zhang@aerolink.com');
  const quality = await login('quality-test@aerolink.com');
  const peer = await login('test-sales-peer@aerolink.com');
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
  const upload = async (token: string, name: string) => ok(await request.post(`${origin}/api/upload`, { headers: headers(token), multipart: {
    file: { name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% Synthetic D13 evidence ${tag}\n`) },
  } }));
  const partNumber = `SHIP-${tag}`;
  const details = [];
  for (const suffix of ['A', 'B']) details.push(await ok(await post('inventory', { partNumber, description: 'Synthetic shipment source',
    quantity: 3, batchNumber: `${tag}-${suffix}`, unitCost: 50, type: 'OWN', trackingType: 'BATCH', conditionCode: 'NE', location: 'TEST' }), 201));
  const rfq = await ok(await post('rfqs', { customerId: 'c001', lines: [{ partNumber, quantity: 4,
    requiredDate: '2027-01-15', certificateRequired: true, certificateType: 'FAA-8130-3' }] }, sales), 201);
  const quote = await ok(await post('quotations', { rfqId: rfq.id, customerId: 'c001', currency: 'USD', validityDays: 7,
    lines: [{ rfqLineId: rfq.lines[0].id, partNumber, quantity: 4, unitPrice: 100, costPrice: 50,
      costSourceType: 'MANUAL', costSourceReason: 'Synthetic D13 cost evidence' }] }, sales), 201);
  const submitted = await ok(await post(`quotations/${quote.id}/submit`, { version: quote.version }, sales));
  await ok(await post(`quotations/${quote.id}/approve`, { version: submitted.version, action: 'approve' }));
  const reserved = await ok(await post('inventory-allocations/reserve', { quotationLineId: quote.lines[0].id,
    allocations: details.map(detail => ({ inventoryDetailId: detail.id, quantity: 2 })) }), 201);
  const current = await ok(await get(`quotations/${quote.id}`));
  const accepted = await ok(await post(`quotations/${quote.id}/accept`, { version: current.version,
    lines: [{ quotationLineId: quote.lines[0].id, quantity: 4, allocations: reserved.allocations.map((allocation: { id: string }) => ({ allocationId: allocation.id, quantity: 2 })) }] }));
  const orderId = accepted.order.id;
  const orderLineId = accepted.order.lines[0].id;
  // Issue both certificates before either immutable quality snapshot is consumed.
  for (const detail of details) await ok(await post('certificates/issue', { inventoryDetailId: detail.id, orderId, partNumber,
    batchNumber: detail.batchNumber, quantity: 2, conditionCode: 'NE', certificateType: 'FAA-8130-3', description: 'Synthetic batch certificate' }, quality), 201);
  const qualityEvidence = await upload(quality, 'shipment-quality.pdf');
  const operatorEvidence = await upload(manager, 'shipment-receipt.pdf');
  const checks = { identity: true, documents: true, conditionAndLife: true, customerRequirements: true };
  const assignments = (await ok(await get(`inventory-allocations/order-lines/${orderLineId}`, quality))).assignments;
  const consume = async (index: number) => {
    const assignment = assignments.find((item: { inventoryDetailId: string }) => item.inventoryDetailId === details[index].id);
    const preview = await ok(await get(`inventory-allocations/quality-review/${assignment.id}?quantity=2`, quality));
    const review = await ok(await post('inventory-allocations/quality-reviews', { assignmentId: assignment.id, quantity: 2,
      snapshotHash: preview.snapshotHash, approved: true, evidenceIds: [qualityEvidence.id], verifiedSerialNumber: '',
      verifiedBatchNumber: details[index].batchNumber, checks, reason: 'Synthetic independent shipment batch review' }, quality), 201);
    return ok(await post('inventory-allocations/consume', { assignmentId: assignment.id, quantity: 2, reviewId: review.id }));
  };
  await consume(0);
  expect((await ok(await get(`orders/${orderId}`, sales))).status.toUpperCase()).toBe('SO_CREATED');
  let view = await ok(await get(`shipments/orders/${orderId}`, quality));
  const firstSource = view.outboundTransactions[0];
  const firstInput = { orderId, carrier: 'Synthetic Carrier', trackingNumber: `${tag}-T1`, origin: 'Test origin', destination: 'Test destination',
    lines: [{ outboundTransactionId: firstSource.id, quantity: 1 }], evidenceIds: [] };
  await ok(await post('shipments', firstInput, sales), 403);
  const first = await ok(await post('shipments', firstInput, manager, `${tag}-shipment1`), 201);
  const replay = await post('shipments', firstInput, manager, `${tag}-shipment1`);
  expect(replay.headers()['idempotency-replayed']).toBe('true');
  await ok(replay, 201);
  await consume(1);
  view = await ok(await get(`shipments/orders/${orderId}`, quality));
  const secondInput = { ...firstInput, trackingNumber: `${tag}-T2`,
    lines: view.outboundTransactions.filter((row: { availableQuantity: number }) => row.availableQuantity > 0)
      .map((row: { id: string; availableQuantity: number }) => ({ outboundTransactionId: row.id, quantity: row.availableQuantity })) };
  const competingShipments = await Promise.all([post('shipments', secondInput), post('shipments', { ...secondInput, trackingNumber: `${tag}-COMPETING` })]);
  expect(competingShipments.map(response => response.status()).sort()).toEqual([201, 409]);
  const second = await ok(competingShipments.find(response => response.status() === 201)!, 201);
  expect(second.lines).toHaveLength(2);
  expect(new Set(second.lines.map((line: { identitySnapshot: { batchNumber: string } }) => line.identitySnapshot.batchNumber)).size).toBe(2);
  await ok(await post('shipments', { ...firstInput, trackingNumber: `${tag}-EXCESS` }), 409);
  await ok(await get(`shipments/orders/${orderId}`, peer), 403);
  view = await ok(await get(`shipments/orders/${orderId}`, sales));
  expect(view.shipments).toHaveLength(2);
  expect(view.delivery.complete).toBe(false);
  expect(JSON.stringify(view)).not.toMatch(/unitCost|costPrice|totalAmount|margin/);
  await ok(await post(`shipments/dispatches/${first.id}/receipts`, { lines: [{ shipmentLineId: first.lines[0].id, quantity: 1 }],
    evidenceIds: [operatorEvidence.id], reason: 'Synthetic signed first delivery' }));
  const secondLargeLine = second.lines.find((line: { quantity: number }) => line.quantity === 2);
  const secondSmallLine = second.lines.find((line: { quantity: number }) => line.quantity === 1);
  await ok(await post(`shipments/dispatches/${second.id}/receipts`, { lines: [{ shipmentLineId: secondLargeLine.id, quantity: 2 }],
    evidenceIds: [operatorEvidence.id], reason: 'Synthetic partial second receipt' }));
  expect((await ok(await get(`shipments/orders/${orderId}`))).delivery).toMatchObject({ receivedQuantity: 3, complete: false });
  expect((await ok(await get(`orders/${orderId}`))).status.toUpperCase()).toBe('SHIPPED');
  const beforeManual = await ok(await get(`orders/${orderId}`));
  await ok(await request.patch(`${origin}/api/orders/${orderId}/status`, { headers: { ...headers(manager), 'Idempotency-Key': `${tag}-manual-delivery` },
    data: { status: 'DELIVERED', version: beforeManual.version, reason: 'Synthetic manual delivery bypass attempt' } }), 409);
  await ok(await post(`shipments/dispatches/${second.id}/receipts`, { lines: [{ shipmentLineId: secondSmallLine.id, quantity: 1 }],
    evidenceIds: [operatorEvidence.id], reason: 'Synthetic final second receipt' }));
  expect((await ok(await get(`orders/${orderId}`))).status.toUpperCase()).toBe('DELIVERED');

  const beforeReturn = await ok(await get(`inventory/${details[0].id}`));
  await ok(await get(`files/${operatorEvidence.id}`, quality), 403);
  const returned = await ok(await post('shipments/returns', { shipmentLineId: first.lines[0].id, quantity: 1,
    evidenceIds: [operatorEvidence.id], verifiedSerialNumber: '', verifiedBatchNumber: details[0].batchNumber,
    reason: 'Synthetic customer return received for quarantine' }), 201);
  expect(returned.status).toBe('QUARANTINED');
  const receivedProof = await get(`files/${operatorEvidence.id}`, quality);
  expect(receivedProof.status()).toBe(200);
  expect((await receivedProof.body()).toString()).toContain(`Synthetic D13 evidence ${tag}`);
  await ok(await get(`files/${operatorEvidence.id}`, peer), 403);
  expect((await ok(await get(`inventory/${details[0].id}`))).quantity).toBe(beforeReturn.quantity);
  await ok(await post('shipments/returns', { shipmentLineId: first.lines[0].id, quantity: 1,
    evidenceIds: [operatorEvidence.id], verifiedSerialNumber: '', verifiedBatchNumber: details[0].batchNumber,
    reason: 'Synthetic duplicate quantity rejected' }), 409);
  const releaseContext = await ok(await get(`shipments/returns/${returned.id}/release-context`, quality));
  const releaseBody = { snapshotHash: releaseContext.snapshotHash, evidenceIds: [qualityEvidence.id], verifiedSerialNumber: '',
    verifiedBatchNumber: details[0].batchNumber, checks, reason: 'Synthetic returned identity and condition independently inspected' };
  await ok(await post(`shipments/returns/${returned.id}/release`, releaseBody), 403);
  await ok(await post(`shipments/returns/${returned.id}/release`, { ...releaseBody, snapshotHash: '0'.repeat(64) }, quality), 409);
  await ok(await post(`shipments/returns/${returned.id}/release`, releaseBody, quality, `${tag}-return-release`));
  await ok(await post(`shipments/returns/${returned.id}/release`, releaseBody, quality, `${tag}-return-release`));
  expect((await ok(await get(`inventory/${details[0].id}`))).quantity).toBe(beforeReturn.quantity + 1);
  expect((await ok(await get(`orders/${orderId}`))).outboundQuantity).toBe(4);
  expect((await ok(await get(`orders/${orderId}`))).status.toUpperCase()).toBe('DELIVERED');
});
