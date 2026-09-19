import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN || `http://127.0.0.1:${process.env.PLAYWRIGHT_BACKEND_PORT || '3000'}`;
const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('E2E_PASSWORD is required for inventory allocation UI E2E.');

const salesUser = 'sales-test@aerolink.com';
const managerUser = 'zhang@aerolink.com';

type Rfq = { id: string; customerId: string; lines: Array<{ id: string; partNumber: string; quantity: number }> };
type Quotation = { id: string; quoteNumber: string; version: number; status: string; lines: Array<{ id: string; partNumber: string }> };

async function login(request: APIRequestContext, email: string) {
  const response = await request.post(`${apiOrigin}/api/auth/login`, { data: { email, password } });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data.token as string;
}

function headers(token: string, key?: string) {
  return { Authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) };
}

async function post(request: APIRequestContext, path: string, data: unknown, token: string, key: string) {
  return request.post(`${apiOrigin}/api/${path}`, { headers: headers(token, key), data });
}

async function createApprovedFixture(request: APIRequestContext) {
  const sales = await login(request, salesUser);
  const manager = await login(request, managerUser);
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const partNumber = `ALLOC-UI-${tag}`;
  const batchNumber = `UI-BATCH-${tag}`;
  const inventoryResponse = await post(request, 'inventory', {
    partNumber,
    description: 'Synthetic browser allocation stock',
    quantity: 5,
    batchNumber,
    unitCost: 50,
    type: 'OWN',
    trackingType: 'BATCH',
    conditionCode: 'NE',
    location: 'UI-TEST',
  }, manager, `ui-${tag}-inventory`);
  expect(inventoryResponse.status(), await inventoryResponse.text()).toBe(201);
  await inventoryResponse.json();

  const rfqResponse = await post(request, 'rfqs', {
    customerId: 'c001',
    lines: [{ partNumber, quantity: 5, requiredDate: '2027-02-15' }],
  }, sales, `ui-${tag}-rfq`);
  expect(rfqResponse.status(), await rfqResponse.text()).toBe(201);
  const rfq = (await rfqResponse.json()).data as Rfq;

  const quotationResponse = await post(request, 'quotations', {
    rfqId: rfq.id,
    customerId: rfq.customerId,
    currency: 'USD',
    validityDays: 7,
    lines: [{ rfqLineId: rfq.lines[0].id, partNumber, quantity: 5, unitPrice: 100, costPrice: 50,
      costSourceType: 'MANUAL', costSourceReason: 'Synthetic browser allocation cost source' }],
  }, sales, `ui-${tag}-quotation`);
  expect(quotationResponse.status(), await quotationResponse.text()).toBe(201);
  const quotation = (await quotationResponse.json()).data as Quotation;
  const submitResponse = await post(request, `quotations/${quotation.id}/submit`, { version: quotation.version }, sales, `ui-${tag}-submit`);
  expect(submitResponse.status(), await submitResponse.text()).toBe(200);
  const submitted = (await submitResponse.json()).data as { version: number };
  const approveResponse = await post(request, `quotations/${quotation.id}/approve`, { version: submitted.version, action: 'approve' }, manager, `ui-${tag}-approve`);
  expect(approveResponse.status(), await approveResponse.text()).toBe(200);
  return { quotation, partNumber, batchNumber };
}

async function loginByUi(page: Page, email = managerUser) {
  await page.goto('/');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password!);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
}

async function navigateToQuotations(page: Page) {
  const quotationItem = page.getByRole('button', { name: /报价管理/ });
  if (!(await quotationItem.isVisible())) await page.getByRole('button', { name: '寻源报价', exact: true }).click();
  await quotationItem.click();
  await expect(page.getByPlaceholder('搜索报价单号、件号或客户...')).toBeVisible();
}

async function navigateToOrders(page: Page) {
  const ordersItem = page.getByRole('button', { name: /订单管理/ });
  if (!(await ordersItem.isVisible())) await page.getByRole('button', { name: '订单与库存', exact: true }).click();
  await ordersItem.click();
  await expect(page.getByRole('heading', { name: '订单管理' })).toBeVisible();
}

async function createModernOrderFixture(request: APIRequestContext) {
  const sales = await login(request, salesUser);
  const manager = await login(request, managerUser);
  const quality = await login(request, 'quality-test@aerolink.com');
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const partNumber = `ALLOC-UI-ORDER-${tag}`;
  const batchNumber = `UI-ORDER-BATCH-${tag}`;
  const inventoryResponse = await post(request, 'inventory', {
    partNumber,
    description: 'Synthetic browser modern order stock',
    quantity: 3,
    batchNumber,
    unitCost: 50,
    type: 'OWN',
    trackingType: 'BATCH',
    conditionCode: 'NE',
    location: 'UI-ORDER-TEST',
  }, manager, `ui-order-${tag}-inventory`);
  expect(inventoryResponse.status(), await inventoryResponse.text()).toBe(201);
  const inventoryDetail = (await inventoryResponse.json()).data as { id: string };

  const rfqResponse = await post(request, 'rfqs', {
    customerId: 'c001',
    lines: [{ partNumber, quantity: 3, requiredDate: '2027-02-15', certificateRequired: true, certificateType: 'FAA-8130-3' }],
  }, sales, `ui-order-${tag}-rfq`);
  expect(rfqResponse.status(), await rfqResponse.text()).toBe(201);
  const rfq = (await rfqResponse.json()).data as Rfq;
  const quotationResponse = await post(request, 'quotations', {
    rfqId: rfq.id,
    customerId: rfq.customerId,
    currency: 'USD',
    validityDays: 7,
    lines: [{ rfqLineId: rfq.lines[0].id, partNumber, quantity: 3, unitPrice: 100, costPrice: 50,
      costSourceType: 'MANUAL', costSourceReason: 'Synthetic modern order quality cost source' }],
  }, sales, `ui-order-${tag}-quotation`);
  expect(quotationResponse.status(), await quotationResponse.text()).toBe(201);
  const quotation = (await quotationResponse.json()).data as Quotation;
  const submitResponse = await post(request, `quotations/${quotation.id}/submit`, { version: quotation.version }, sales, `ui-order-${tag}-submit`);
  expect(submitResponse.status(), await submitResponse.text()).toBe(200);
  const submitted = (await submitResponse.json()).data as { version: number };
  const approveResponse = await post(request, `quotations/${quotation.id}/approve`, { version: submitted.version, action: 'approve' }, manager, `ui-order-${tag}-approve`);
  expect(approveResponse.status(), await approveResponse.text()).toBe(200);
  await approveResponse.json();
  const reserveResponse = await post(request, 'inventory-allocations/reserve', {
    quotationLineId: quotation.lines[0].id,
    allocations: [{ inventoryDetailId: inventoryDetail.id, quantity: 3 }],
  }, manager, `ui-order-${tag}-reserve`);
  expect(reserveResponse.status(), await reserveResponse.text()).toBe(201);
  const reservation = (await reserveResponse.json()).data as { allocations: Array<{ id: string }> };
  const refreshedQuotationResponse = await request.get(`${apiOrigin}/api/quotations/${quotation.id}`, { headers: headers(manager) });
  expect(refreshedQuotationResponse.status(), await refreshedQuotationResponse.text()).toBe(200);
  const refreshedQuotation = (await refreshedQuotationResponse.json()).data as { version: number };
  const acceptResponse = await post(request, `quotations/${quotation.id}/accept`, {
    version: refreshedQuotation.version,
    lines: [{ quotationLineId: quotation.lines[0].id, quantity: 3, allocations: [{ allocationId: reservation.allocations[0].id, quantity: 3 }] }],
  }, manager, `ui-order-${tag}-accept`);
  expect(acceptResponse.status(), await acceptResponse.text()).toBe(200);
  const accepted = (await acceptResponse.json()).data as { order: { id: string; orderNumber: string; lines: Array<{ id: string }> } };
  const certificateResponse = await post(request, 'certificates/issue', {
    inventoryDetailId: inventoryDetail.id,
    orderId: accepted.order.id,
    partNumber,
    batchNumber,
    quantity: 3,
    conditionCode: 'NE',
    certificateType: 'FAA-8130-3',
    description: 'Synthetic modern order quality certificate',
  }, quality, `ui-order-${tag}-certificate`);
  expect(certificateResponse.status(), await certificateResponse.text()).toBe(201);
  return { manager, quality, order: accepted.order, partNumber, batchNumber };
}

test('manager explicitly reserves a modern line and assigns the selected parent during acceptance', async ({ page, request }) => {
  const fixture = await createApprovedFixture(request);
  await loginByUi(page);
  await navigateToQuotations(page);

  const search = page.getByPlaceholder('搜索报价单号、件号或客户...');
  await search.fill(fixture.quotation.quoteNumber);
  const quoteRow = page.locator('table tbody tr').filter({ hasText: fixture.quotation.quoteNumber }).first();
  await expect(quoteRow).toBeVisible();
  await quoteRow.getByRole('button', { name: '查看报价详情' }).click();

  const detailDialog = page.getByRole('dialog');
  const panel = detailDialog.getByRole('region', { name: '现代行库存分配' });
  await expect(panel).toBeVisible();
  await panel.getByRole('combobox').click();
  await page.getByRole('option').filter({ hasText: fixture.batchNumber }).click();
  await panel.getByRole('spinbutton').first().fill('3');
  const reserveResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/inventory-allocations/reserve'));
  await panel.getByRole('button', { name: '预留', exact: true }).click();
  expect((await reserveResponse).status()).toBe(201);
  await expect(panel).toContainText('未分配 3');

  await detailDialog.getByRole('button', { name: '确认客户并生成合同' }).click();
  const confirmationDialog = page.getByRole('dialog');
  await expect(confirmationDialog).toBeVisible();
  await confirmationDialog.getByLabel(`${fixture.partNumber} 接受数量`).fill('3');
  const parentAllocation = confirmationDialog.getByLabel(`${fixture.partNumber} 父分配 1`);
  await parentAllocation.fill('3');
  const acceptResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/quotations/${fixture.quotation.id}/accept`));
  await confirmationDialog.getByRole('button', { name: '确认并生成合同' }).click();
  const response = await acceptResponse;
  expect(response.status(), await response.text()).toBe(200);
  const payload = JSON.parse(response.request().postData() || '{}') as { lines?: Array<{ quotationLineId: string; quantity: number; allocations?: Array<{ allocationId: string; quantity: number }> }> };
  expect(payload.lines).toHaveLength(1);
  expect(payload.lines?.[0].quantity).toBe(3);
  expect(payload.lines?.[0].allocations).toHaveLength(1);
  expect(payload.lines?.[0].allocations?.[0].quantity).toBe(3);
});

test('quality reviewer approves a modern assignment and manager consumes it in the browser', async ({ page, browser, request, baseURL }) => {
  const fixture = await createModernOrderFixture(request);
  await loginByUi(page, 'quality-test@aerolink.com');
  await navigateToOrders(page);
  await page.getByPlaceholder('搜索订单号、件号或客户...').fill(fixture.order.orderNumber);
  const orderRow = page.locator('table tbody tr').filter({ hasText: fixture.order.orderNumber }).first();
  await expect(orderRow).toBeVisible();
  await orderRow.getByRole('button').first().click();
  const qualityDialog = page.getByRole('dialog').filter({ hasText: fixture.order.orderNumber }).first();
  await expect(qualityDialog).toBeVisible();
  const qualityPanel = qualityDialog.getByRole('region', { name: '现代行库存分配' });
  await expect(qualityPanel).toBeVisible();
  const assignment = qualityPanel.locator('input[type="radio"]').last();
  await assignment.check();
  await expect(qualityPanel.getByText(fixture.batchNumber)).toBeVisible();
  const plannedQuantity = qualityPanel.locator('input[type="number"]').first();
  await expect(plannedQuantity).toHaveValue('1');
  await plannedQuantity.fill('3');
  await expect(plannedQuantity).toHaveValue('3');
  await expect(qualityPanel.locator('input[type="checkbox"]')).toHaveCount(4);

  const uploadResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/upload') && response.status() === 200);
  await qualityPanel.locator('input[type="file"]').setInputFiles({ name: 'modern-allocation-quality.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% Modern allocation UI evidence\n') });
  await uploadResponse;
  await expect(qualityPanel).toContainText('modern-allocation-quality.pdf');
  await qualityPanel.getByLabel('核对序号').fill('');
  await qualityPanel.getByLabel('核对批次').fill(fixture.batchNumber);
  const checks = qualityPanel.locator('input[type="checkbox"]');
  await expect(checks).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) await checks.nth(index).check();
  await qualityPanel.getByLabel('审核依据').fill('已核对现代订单行件号、NE状态、批次和FAA-8130-3证据。');
  const reviewResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/inventory-allocations/quality-reviews') && response.status() === 201);
  await qualityPanel.getByRole('button', { name: '提交质量复核' }).click();
  await reviewResponse;
  await expect(qualityPanel).toContainText(/快照：|Snapshot:/);
  await expect(qualityPanel.getByRole('button', { name: '确认出库' })).toHaveCount(0);

  await qualityDialog.getByRole('button', { name: /关闭|Close/ }).first().click();
  const managerContext = await browser.newContext({ baseURL });
  const managerPage = await managerContext.newPage();
  try {
    await loginByUi(managerPage);
    await navigateToOrders(managerPage);
    await managerPage.getByPlaceholder('搜索订单号、件号或客户...').fill(fixture.order.orderNumber);
    const managerRow = managerPage.locator('table tbody tr').filter({ hasText: fixture.order.orderNumber }).first();
    await expect(managerRow).toBeVisible();
    await managerRow.getByRole('button').first().click();
    const managerDialog = managerPage.getByRole('dialog').filter({ hasText: fixture.order.orderNumber }).first();
    const managerPanel = managerDialog.getByRole('region', { name: '现代行库存分配' });
    await expect(managerPanel).toBeVisible();
    await managerPanel.locator('input[type="radio"]').last().check();
    const managerPlannedQuantity = managerPanel.locator('input[type="number"]').last();
    await managerPlannedQuantity.fill('3');
    await expect(managerPlannedQuantity).toHaveValue('3');
    await expect(managerPanel).toContainText('已有同数量、同快照的有效质量复核');
    const consumeResponse = managerPage.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/inventory-allocations/consume') && response.status() === 200);
    await managerPanel.getByRole('button', { name: '确认出库' }).click();
    await consumeResponse;
    await expect(managerPage.locator('[data-sonner-toast]').filter({ hasText: /出库成功|Outbound completed/ }).last()).toBeVisible();
    await expect(managerPanel).toContainText('已出库');
    await expect(managerPanel).toContainText('3 EA');
  } finally {
    await managerContext.close();
  }

  const orderResponse = await request.get(`${apiOrigin}/api/orders/${fixture.order.id}`, { headers: headers(fixture.manager) });
  expect(orderResponse.status(), await orderResponse.text()).toBe(200);
  const orderPayload = (await orderResponse.json()).data as { outboundQuantity: number; outboundStatus: string; status: string };
  expect(orderPayload.outboundQuantity).toBe(3);
  expect(orderPayload.outboundStatus).toBe('COMPLETED');
  expect(orderPayload.status.toUpperCase()).toBe('SHIPPED');
});
