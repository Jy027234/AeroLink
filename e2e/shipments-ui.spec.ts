import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN || `http://127.0.0.1:${process.env.PLAYWRIGHT_BACKEND_PORT || '3000'}`;
const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('E2E_PASSWORD is required for shipment UI E2E.');

const salesUser = 'sales-test@aerolink.com';
const managerUser = 'zhang@aerolink.com';
const qualityUser = 'quality-test@aerolink.com';

type Envelope<T> = { success: boolean; data: T };
type Rfq = { id: string; customerId: string; lines: Array<{ id: string; partNumber: string; quantity: number }> };
type Quotation = { id: string; quoteNumber: string; version: number; lines: Array<{ id: string; partNumber: string }> };
type ShipmentOrderView = {
  order: { id: string; status: string; version: number };
  outboundTransactions: Array<{ id: string; availableQuantity: number; requiresHistoricalReview: boolean }>;
  shipments: Array<{ id: string; lines: Array<{ id: string; returnedQuantity: number; returns: Array<{ id: string; status: string }> }> }>;
  delivery: { requiredQuantity: number; receivedQuantity: number; remainingQuantity: number; complete: boolean };
};

async function login(request: APIRequestContext, email: string) {
  const response = await request.post(`${apiOrigin}/api/auth/login`, { data: { email, password } });
  const payload = await response.json() as Envelope<{ token: string }>;
  expect(response.status(), JSON.stringify(payload)).toBe(200);
  return payload.data.token;
}

function headers(token: string, key?: string) {
  return {
    Authorization: `Bearer ${token}`,
    ...(key ? { 'Idempotency-Key': key } : {}),
  };
}

async function post<T>(request: APIRequestContext, path: string, body: unknown, token: string, key: string, status: number) {
  const response = await request.post(`${apiOrigin}/api/${path}`, {
    data: body,
    headers: headers(token, key),
  });
  const payload = await response.json() as Envelope<T> & { error?: unknown };
  expect(response.status(), JSON.stringify(payload)).toBe(status);
  return payload.data;
}

async function get<T>(request: APIRequestContext, path: string, token: string, status = 200) {
  const response = await request.get(`${apiOrigin}/api/${path}`, { headers: headers(token) });
  const payload = await response.json() as Envelope<T> & { error?: unknown };
  expect(response.status(), JSON.stringify(payload)).toBe(status);
  return payload.data;
}

async function upload(request: APIRequestContext, token: string, name: string, tag: string) {
  const response = await request.post(`${apiOrigin}/api/upload`, {
    headers: headers(token),
    multipart: {
      file: { name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% Synthetic D13 shipment UI evidence ${tag}\n`) },
    },
  });
  const payload = await response.json() as Envelope<{ id: string }> & { error?: unknown };
  expect(response.status(), JSON.stringify(payload)).toBe(200);
  return payload.data;
}

async function createModernOrderFixture(request: APIRequestContext) {
  const sales = await login(request, salesUser);
  const manager = await login(request, managerUser);
  const quality = await login(request, qualityUser);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const partNumber = `SHIP-UI-${tag}`;
  const batchNumber = `SHIP-UI-BATCH-${tag}`;

  const inventory = await post<{ id: string }>(request, 'inventory', {
    partNumber,
    description: 'Synthetic shipment browser UI stock',
    quantity: 2,
    batchNumber,
    unitCost: 50,
    type: 'OWN',
    trackingType: 'BATCH',
    conditionCode: 'NE',
    location: 'SHIP-UI-TEST',
  }, manager, `shipment-ui-${tag}-inventory`, 201);

  const rfq = await post<Rfq>(request, 'rfqs', {
    customerId: 'c001',
    lines: [{ partNumber, quantity: 2, requiredDate: '2027-02-15', certificateRequired: true, certificateType: 'FAA-8130-3' }],
  }, sales, `shipment-ui-${tag}-rfq`, 201);
  const quotation = await post<Quotation>(request, 'quotations', {
    rfqId: rfq.id,
    customerId: rfq.customerId,
    currency: 'USD',
    validityDays: 7,
    lines: [{ rfqLineId: rfq.lines[0].id, partNumber, quantity: 2, unitPrice: 100, costPrice: 50,
      costSourceType: 'MANUAL', costSourceReason: 'Synthetic shipment browser UI cost source' }],
  }, sales, `shipment-ui-${tag}-quotation`, 201);
  const submitted = await post<{ version: number }>(request, `quotations/${quotation.id}/submit`, { version: quotation.version }, sales, `shipment-ui-${tag}-submit`, 200);
  await post<{ version: number }>(request, `quotations/${quotation.id}/approve`, { version: submitted.version, action: 'approve' }, manager, `shipment-ui-${tag}-approve`, 200);
  const reservation = await post<{ allocations: Array<{ id: string }> }>(request, 'inventory-allocations/reserve', {
    quotationLineId: quotation.lines[0].id,
    allocations: [{ inventoryDetailId: inventory.id, quantity: 2 }],
  }, manager, `shipment-ui-${tag}-reserve`, 201);
  const currentQuotation = await get<{ version: number }>(request, `quotations/${quotation.id}`, manager);
  const accepted = await post<{ order: { id: string; orderNumber: string; lines: Array<{ id: string }> } }>(request, `quotations/${quotation.id}/accept`, {
    version: currentQuotation.version,
    lines: [{ quotationLineId: quotation.lines[0].id, quantity: 2,
      allocations: reservation.allocations.map((allocation) => ({ allocationId: allocation.id, quantity: 2 })) }],
  }, manager, `shipment-ui-${tag}-accept`, 200);

  await post(request, 'certificates/issue', {
    inventoryDetailId: inventory.id,
    orderId: accepted.order.id,
    partNumber,
    batchNumber,
    quantity: 2,
    conditionCode: 'NE',
    certificateType: 'FAA-8130-3',
    description: 'Synthetic shipment browser UI certificate',
  }, quality, `shipment-ui-${tag}-certificate`, 201);

  // Quality review and consumption are fixture setup. The shipment, receipt,
  // return, and independent release commands below are performed in browsers.
  const assignments = await get<{ assignments: Array<{ id: string; inventoryDetailId: string }> }>(request,
    `inventory-allocations/order-lines/${accepted.order.lines[0].id}`, quality);
  const assignment = assignments.assignments.find((row) => row.inventoryDetailId === inventory.id);
  expect(assignment).toBeTruthy();
  const qualityEvidence = await upload(request, quality, 'shipment-ui-quality.pdf', tag);
  const preview = await get<{ snapshotHash: string }>(request,
    `inventory-allocations/quality-review/${assignment!.id}?quantity=2`, quality);
  const review = await post<{ id: string }>(request, 'inventory-allocations/quality-reviews', {
    assignmentId: assignment!.id,
    quantity: 2,
    snapshotHash: preview.snapshotHash,
    approved: true,
    evidenceIds: [qualityEvidence.id],
    verifiedSerialNumber: '',
    verifiedBatchNumber: batchNumber,
    checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
    reason: 'Synthetic shipment browser UI quality review',
  }, quality, `shipment-ui-${tag}-quality-review`, 201);
  await post(request, 'inventory-allocations/consume', {
    assignmentId: assignment!.id,
    quantity: 2,
    reviewId: review.id,
  }, manager, `shipment-ui-${tag}-consume`, 200);

  return { manager, quality, order: accepted.order, inventory, partNumber, batchNumber, tag };
}

async function loginByUi(page: Page, email: string) {
  await page.goto('/');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password!);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
}

async function openOrders(page: Page) {
  const ordersItem = page.getByRole('button', { name: /订单管理/ });
  if (!(await ordersItem.isVisible())) await page.getByRole('button', { name: '订单与库存', exact: true }).click();
  await ordersItem.click();
  await expect(page.getByRole('heading', { name: '订单管理' })).toBeVisible();
}

async function openOrder(page: Page, orderNumber: string) {
  await page.getByPlaceholder('搜索订单号、件号或客户...').fill(orderNumber);
  const row = page.locator('table tbody tr').filter({ hasText: orderNumber }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button').first().click();
  const dialog = page.getByRole('dialog').filter({ hasText: orderNumber }).first();
  await expect(dialog).toBeVisible();
  return dialog;
}

test('manager ships, receives, and quarantines a return, then quality independently releases it', async ({ page, browser, request }) => {
  const fixture = await createModernOrderFixture(request);
  await loginByUi(page, managerUser);
  await openOrders(page);
  const managerDialog = await openOrder(page, fixture.order.orderNumber);
  const shipmentPanel = managerDialog.getByRole('region', { name: '发运、签收与退货' });
  await expect(shipmentPanel).toBeVisible();
  await expect(shipmentPanel).toContainText(fixture.partNumber);

  // The source checkbox is intentionally selected by the test; the panel must
  // not silently choose the first OUTBOUND row.
  const sourceCheckbox = shipmentPanel.getByRole('checkbox', { name: new RegExp(fixture.partNumber) });
  await expect(sourceCheckbox).toBeVisible();
  await sourceCheckbox.check();
  await shipmentPanel.getByLabel(new RegExp('发运数量|Shipment quantity')).fill('2');
  await shipmentPanel.getByLabel(/承运人|Carrier/).fill('Synthetic UI Carrier');
  await shipmentPanel.getByLabel(/运单号|Tracking number/).fill(`UI-TRACK-${fixture.tag}`);
  await shipmentPanel.getByLabel(/起运地|Origin/).fill('Synthetic origin');
  await shipmentPanel.getByLabel(/目的地|Destination/).fill('Synthetic destination');
  const createResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/shipments') && response.status() === 201);
  await shipmentPanel.getByRole('button', { name: /创建发运单|Create shipment/ }).click();
  await createResponse;
  await expect(shipmentPanel).toContainText(`UI-TRACK-${fixture.tag}`);
  await expect(shipmentPanel).not.toContainText(/unitCost|costPrice|margin/);

  const receiptEvidence = shipmentPanel.getByLabel(/本人上传签收证据|Upload receipt evidence/);
  await receiptEvidence.setInputFiles({ name: 'shipment-ui-receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic receipt evidence\n') });
  await expect(shipmentPanel).toContainText('shipment-ui-receipt.pdf');
  await shipmentPanel.getByLabel(/签收说明|Receipt reason/).fill('Synthetic browser receipt for one unit');
  const receiptQuantity = shipmentPanel.getByLabel(new RegExp('签收数量|Receipt quantity')).first();
  await receiptQuantity.fill('1');
  const receiptResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/api/shipments/dispatches/') && response.url().endsWith('/receipts') && response.status() === 200);
  await shipmentPanel.getByRole('button', { name: /保存签收|Record receipt/ }).click();
  await receiptResponse;
  await expect(shipmentPanel).toContainText(/实际签收.*1|Received.*1/);

  const returnSelect = shipmentPanel.getByLabel(/选择退货发运行|Select return shipment line/);
  const returnOption = returnSelect.locator('option').filter({ hasText: fixture.partNumber }).first();
  await expect(returnOption).toHaveCount(1);
  await returnSelect.selectOption((await returnOption.getAttribute('value')) || '');
  await shipmentPanel.getByLabel(/退货数量|Return qty/).fill('1');
  await shipmentPanel.getByLabel(/核对序号|Verified serial/).fill('');
  await shipmentPanel.getByLabel(/核对批次|Verified batch/).fill(fixture.batchNumber);
  await shipmentPanel.getByLabel(/本人上传退货证据|Upload return evidence/).setInputFiles({ name: 'shipment-ui-return.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic return evidence\n') });
  await expect(shipmentPanel).toContainText('shipment-ui-return.pdf');
  await shipmentPanel.getByLabel(/退货原因|Return reason/).fill('Synthetic browser customer refusal return');
  const returnResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/shipments/returns') && response.status() === 201);
  await shipmentPanel.getByRole('button', { name: /登记退货隔离|Record return hold/ }).click();
  await returnResponse;
  await expect(shipmentPanel).toContainText(/隔离退货|Return hold/);

  const managerView = await get<ShipmentOrderView>(request, `shipments/orders/${fixture.order.id}`, fixture.manager);
  expect(managerView.delivery).toMatchObject({ requiredQuantity: 2, receivedQuantity: 1, remainingQuantity: 1, complete: false });
  const managerHold = managerView.shipments.flatMap((shipment) => shipment.lines.flatMap((line) => line.returns))[0];
  expect(managerHold?.status).toBe('QUARANTINED');
  expect(managerView.shipments.flatMap((shipment) => shipment.lines).reduce((sum, line) => sum + line.returnedQuantity, 0)).toBe(1);

  const qualityContext = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5222' });
  const qualityPage = await qualityContext.newPage();
  try {
    await loginByUi(qualityPage, qualityUser);
    await openOrders(qualityPage);
    const qualityDialog = await openOrder(qualityPage, fixture.order.orderNumber);
    const qualityShipmentPanel = qualityDialog.getByRole('region', { name: '发运、签收与退货' });
    await expect(qualityShipmentPanel).toContainText(/隔离退货|Return hold/);
    await qualityShipmentPanel.getByRole('button', { name: /选择复核|Review/ }).click();
    await expect(qualityShipmentPanel).toContainText(/快照|Snapshot/);
    const receiptEvidenceDownload = qualityPage.waitForEvent('download');
    await qualityShipmentPanel.getByRole('button', { name: /查看接收证据|View receipt evidence/ }).first().click();
    const receiptEvidenceFile = await receiptEvidenceDownload;
    expect(receiptEvidenceFile.suggestedFilename()).toMatch(/^shipment-return-receipt-evidence-/);
    expect(await receiptEvidenceFile.path()).toBeTruthy();
    await qualityShipmentPanel.getByLabel(/核对序号|Verified serial/).fill('');
    await qualityShipmentPanel.getByLabel(/核对批次|Verified batch/).fill(fixture.batchNumber);
    const checks = qualityShipmentPanel.locator('input[type="checkbox"]');
    await expect(checks).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) await checks.nth(index).check();
    await qualityShipmentPanel.getByLabel(/本人上传放行证据|Upload release evidence/).setInputFiles({ name: 'shipment-ui-release.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic release evidence\n') });
    await expect(qualityShipmentPanel).toContainText('shipment-ui-release.pdf');
    await qualityShipmentPanel.getByLabel(/放行依据|Release reason/).fill('Synthetic independent quality release after return inspection');
    const releaseResponse = qualityPage.waitForResponse((response) => response.request().method() === 'POST' && response.url().match(/\/api\/shipments\/returns\/[^/]+\/release$/) !== null && response.status() === 200);
    await qualityShipmentPanel.getByRole('button', { name: /质量放行退货|Release return/ }).click();
    await releaseResponse;
    await expect(qualityShipmentPanel).toContainText(/已放行|Released/);
  } finally {
    await qualityContext.close();
  }

  const afterRelease = await get<ShipmentOrderView>(request, `shipments/orders/${fixture.order.id}`, fixture.quality);
  const releasedHold = afterRelease.shipments.flatMap((shipment) => shipment.lines.flatMap((line) => line.returns))[0];
  expect(releasedHold?.status).toBe('RELEASED');
  expect(afterRelease.delivery).toMatchObject({ receivedQuantity: 1, remainingQuantity: 1, complete: false });
  expect(JSON.stringify(afterRelease)).not.toMatch(/unitCost|costPrice|totalAmount|margin/);
});
