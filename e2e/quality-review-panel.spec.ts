import { expect, test, type Page } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');
const e2ePassword = E2E_PASSWORD;

const backendBaseUrl = `${process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000'}/api`;
const frontendBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173';

type ApiEnvelope<T> = {
  success: boolean;
  code?: string;
  message?: string;
  data: T;
};

function mutationHeaders(token: string, idempotencyKey: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  };
}

async function login(email: string) {
  const response = await fetch(`${backendBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: e2ePassword }),
  });
  expect(response.ok).toBeTruthy();
  const payload = await response.json() as ApiEnvelope<{ token: string }>;
  return payload.data.token;
}

async function createReservedOrder(salesToken: string, managerToken: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partNumber = '1234-567-890';
  const inventoryDetailId = 'inv005';

  const rfqResponse = await fetch(`${backendBaseUrl}/rfqs`, {
    method: 'POST',
    headers: mutationHeaders(salesToken, `e2e-quality-panel-rfq-${suffix}`),
    body: JSON.stringify({
      customerId: 'c001',
      partNumber,
      quantity: 1,
      conditionCode: 'NE',
      certificateRequired: true,
      certificateType: 'FAA-8130-3',
      requiredDate: '2026-08-01',
      urgency: 'STANDARD',
    }),
  });
  expect(rfqResponse.status).toBe(201);
  const rfq = await rfqResponse.json() as ApiEnvelope<{ id: string }>;

  const quoteResponse = await fetch(`${backendBaseUrl}/quotations`, {
    method: 'POST',
    headers: mutationHeaders(salesToken, `e2e-quality-panel-quote-${suffix}`),
    body: JSON.stringify({
      rfqId: rfq.data.id,
      customerId: 'c001',
      partNumber,
      quantity: 1,
      unitPrice: 2400,
      costPrice: 1800,
      currency: 'USD',
      costSourceType: 'MANUAL',
      costSourceReason: 'E2E synthetic cost basis for quality review flow',
      certificateFiles: ['FAA-8130-3'],
      validityDays: 14,
    }),
  });
  expect(quoteResponse.status).toBe(201);
  const quote = await quoteResponse.json() as ApiEnvelope<{ id: string; version: number }>;

  const submitResponse = await fetch(`${backendBaseUrl}/quotations/${quote.data.id}/submit`, {
    method: 'POST',
    headers: mutationHeaders(salesToken, `e2e-quality-panel-submit-${suffix}`),
    body: JSON.stringify({ version: quote.data.version, reasonCode: 'E2E_QUALITY_PANEL_SUBMIT' }),
  });
  expect(submitResponse.ok).toBeTruthy();
  const submitted = await submitResponse.json() as ApiEnvelope<{ version: number }>;

  const approveResponse = await fetch(`${backendBaseUrl}/quotations/${quote.data.id}/approve`, {
    method: 'POST',
    headers: mutationHeaders(managerToken, `e2e-quality-panel-approve-${suffix}`),
    body: JSON.stringify({ action: 'approve', version: submitted.data.version, reasonCode: 'E2E_QUALITY_PANEL_APPROVE' }),
  });
  expect(approveResponse.ok).toBeTruthy();
  const approved = await approveResponse.json() as ApiEnvelope<{ version: number }>;

  const acceptResponse = await fetch(`${backendBaseUrl}/quotations/${quote.data.id}/accept`, {
    method: 'POST',
    headers: mutationHeaders(salesToken, `e2e-quality-panel-accept-${suffix}`),
    body: JSON.stringify({
      version: approved.data.version,
      poNumber: `PO-QUALITY-PANEL-${suffix}`,
      confirmationNote: 'QualityReviewPanel E2E customer confirmation.',
      reasonCode: 'E2E_QUALITY_PANEL_ACCEPT',
    }),
  });
  expect(acceptResponse.ok).toBeTruthy();
  const accepted = await acceptResponse.json() as ApiEnvelope<{
    order: { id: string; orderNumber: string };
  }>;

  const reserveResponse = await fetch(`${backendBaseUrl}/inventory-transactions/reserve`, {
    method: 'POST',
    headers: mutationHeaders(managerToken, `e2e-quality-panel-reserve-${suffix}`),
    body: JSON.stringify({ inventoryDetailId, quotationId: quote.data.id, quantity: 1 }),
  });
  expect(reserveResponse.status).toBe(201);

  return { orderId: accepted.data.order.id, orderNumber: accepted.data.order.orderNumber, inventoryDetailId };
}

async function loginByUi(page: Page, email: string) {
  await page.goto('/');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', e2ePassword);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
}

async function openOrders(page: Page) {
  const ordersItem = page.getByRole('button', { name: /订单管理/ });
  if (!(await ordersItem.isVisible())) {
    await page.getByRole('button', { name: '订单与库存', exact: true }).click();
  }
  await ordersItem.click();
  await expect(page.getByRole('heading', { name: '订单管理' })).toBeVisible();
}

async function openOrder(page: Page, orderNumber: string) {
  await page.getByPlaceholder('搜索订单号、件号或客户...').fill(orderNumber);
  const orderRow = page.locator('table tbody tr').filter({ hasText: orderNumber }).first();
  await expect(orderRow).toBeVisible();
  await orderRow.getByRole('button').first().click();
  const orderDialog = page.getByRole('dialog').filter({ hasText: orderNumber }).first();
  await expect(orderDialog).toBeVisible();
  return orderDialog;
}

test('quality reviewer approves the delivery panel before a manager can outbound', async ({ page, browser }) => {
  const salesToken = await login('sales-test@aerolink.com');
  const managerToken = await login('zhang@aerolink.com');
  const qualityToken = await login('quality-test@aerolink.com');
  const { orderId, orderNumber, inventoryDetailId } = await createReservedOrder(salesToken, managerToken);

  const missingReviewOutbound = await fetch(`${backendBaseUrl}/inventory-transactions/outbound`, {
    method: 'POST',
    headers: mutationHeaders(managerToken, `e2e-quality-panel-missing-review-${orderId}`),
    body: JSON.stringify({ inventoryDetailId, orderId, quantity: 1 }),
  });
  expect(missingReviewOutbound.status).toBe(409);
  expect((await missingReviewOutbound.json() as ApiEnvelope<never>).code).toBe('QUALITY_REVIEW_REQUIRED');

  await loginByUi(page, 'quality-test@aerolink.com');
  await openOrders(page);
  const qualityOrderDialog = await openOrder(page, orderNumber);
  const reviewPanel = page.getByRole('region', { name: '交付质量审核' });
  await expect(reviewPanel).toBeVisible();
  await expect(reviewPanel.getByText(/1234-567-890 · NE/)).toBeVisible();
  await expect(reviewPanel.getByText(/批次.*BN-005-2026/)).toBeVisible();
  const plannedQuantity = reviewPanel.getByLabel('本次计划出库数量');
  await plannedQuantity.fill('1');
  await expect(plannedQuantity).toHaveValue('1');

  const fileUploadResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && response.url().includes('/api/upload')
      && response.status() === 200,
  );
  await reviewPanel.locator('input[type="file"]').setInputFiles({
    name: 'quality-panel-evidence.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% QualityReviewPanel E2E evidence\n'),
  });
  await fileUploadResponse;
  await expect(reviewPanel.getByText('quality-panel-evidence.pdf')).toBeVisible();

  await reviewPanel.getByLabel('文件上的序号（无则留空）').fill('');
  await reviewPanel.getByLabel('文件上的批次（无则留空）').fill('BN-005-2026');
  const checks = reviewPanel.locator('input[type="checkbox"]');
  await expect(checks).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) await checks.nth(index).check();
  await reviewPanel.getByLabel('审核依据及不适用项说明').fill('已核对件号、NE 状态、批次和 FAA 8130-3 证据，适用寿命项已确认。');

  const reviewResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && response.url().includes('/api/inventory-transactions/quality-reviews')
      && response.status() === 201,
  );
  await reviewPanel.getByRole('button', { name: '确认审核通过' }).click();
  await reviewResponse;
  await expect(reviewPanel.getByText('本次数量已审核')).toBeVisible();

  const qualityContextResponse = await fetch(`${backendBaseUrl}/inventory-transactions/quality-review/${orderId}?quantity=1`, {
    headers: { Authorization: `Bearer ${qualityToken}` },
  });
  expect(qualityContextResponse.ok).toBeTruthy();
  const qualityContext = await qualityContextResponse.json() as ApiEnvelope<{
    review: { approved: boolean; quantity: number; consumedAt: string | null } | null;
  }>;
  expect(qualityContext.data.review).toMatchObject({ approved: true, quantity: 1, consumedAt: null });

  await qualityOrderDialog.getByRole('button', { name: /关闭|Close/ }).first().click();

  const managerContext = await browser.newContext({ baseURL: frontendBaseUrl });
  const managerPage = await managerContext.newPage();
  try {
    await loginByUi(managerPage, 'zhang@aerolink.com');
    await openOrders(managerPage);
    const managerOrderDialog = await openOrder(managerPage, orderNumber);
    await managerOrderDialog.getByRole('button', { name: /执行出库|Execute Outbound/ }).click();
    const outboundDialog = managerPage.getByRole('dialog').filter({ hasText: /执行出库|Execute Outbound/ }).last();
    await expect(outboundDialog).toBeVisible();
    await outboundDialog.locator('input[type="number"]').fill('1');

    const outboundResponse = managerPage.waitForResponse((response) =>
      response.request().method() === 'POST'
        && response.url().includes('/api/inventory-transactions/outbound')
        && response.status() === 201,
    );
    await outboundDialog.getByRole('button', { name: '确认出库' }).click();
    await outboundResponse;
    await expect(managerPage.locator('[data-sonner-toast]').filter({ hasText: /出库成功|Outbound completed/ }).last()).toBeVisible();
  } finally {
    await managerContext.close();
  }

  const orderResponse = await fetch(`${backendBaseUrl}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${managerToken}` },
  });
  expect(orderResponse.ok).toBeTruthy();
  const order = await orderResponse.json() as ApiEnvelope<{
    status: string;
    outboundQuantity: number;
    outboundStatus: string;
  }>;
  expect(order.data).toMatchObject({ status: 'shipped', outboundQuantity: 1, outboundStatus: 'COMPLETED' });
});
