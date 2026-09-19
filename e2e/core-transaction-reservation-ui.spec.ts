import { expect, test, type Page } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');
const e2ePassword = E2E_PASSWORD;

const apiBaseUrl = `${process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000'}/api`;

async function loginToApi(email = 'zhang@aerolink.com') {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: e2ePassword }),
  });
  expect(response.ok).toBeTruthy();
  const payload = await response.json() as { data: { token: string } };
  return payload.data.token;
}

function headers(token: string, key: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': key,
  };
}

async function createUnboundAcceptedOrder(creatorToken: string, approverToken: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partNumber = '2341-123-050';
  const rfqResponse = await fetch(`${apiBaseUrl}/rfqs`, {
    method: 'POST',
    headers: headers(creatorToken, `e2e-ui-rfq-${suffix}`),
    body: JSON.stringify({
      customerId: 'c001',
      partNumber,
      quantity: 1,
      requiredDate: '2026-08-01',
      urgency: 'STANDARD',
    }),
  });
  expect(rfqResponse.status).toBe(201);
  const rfq = await rfqResponse.json() as { data: { id: string } };

  const quoteResponse = await fetch(`${apiBaseUrl}/quotations`, {
    method: 'POST',
    headers: headers(creatorToken, `e2e-ui-quote-${suffix}`),
    body: JSON.stringify({
      rfqId: rfq.data.id,
      customerId: 'c001',
      partNumber,
      quantity: 1,
      unitPrice: 3600,
      costPrice: 2800,
      currency: 'USD',
      costSourceType: 'MANUAL',
      costSourceReason: 'E2E synthetic cost basis for reservation flow',
      validityDays: 14,
    }),
  });
  expect(quoteResponse.status).toBe(201);
  const quote = await quoteResponse.json() as { data: { id: string; version: number } };

  const submitResponse = await fetch(`${apiBaseUrl}/quotations/${quote.data.id}/submit`, {
    method: 'POST',
    headers: headers(creatorToken, `e2e-ui-submit-${suffix}`),
    body: JSON.stringify({ version: quote.data.version, reasonCode: 'E2E_UI_SUBMIT' }),
  });
  expect(submitResponse.ok).toBeTruthy();
  const submitted = await submitResponse.json() as { data: { version: number } };

  const approveResponse = await fetch(`${apiBaseUrl}/quotations/${quote.data.id}/approve`, {
    method: 'POST',
    headers: headers(approverToken, `e2e-ui-approve-${suffix}`),
    body: JSON.stringify({ action: 'approve', version: submitted.data.version, reasonCode: 'E2E_UI_APPROVE' }),
  });
  expect(approveResponse.ok).toBeTruthy();
  const approved = await approveResponse.json() as { data: { version: number } };

  const acceptResponse = await fetch(`${apiBaseUrl}/quotations/${quote.data.id}/accept`, {
    method: 'POST',
    headers: headers(creatorToken, `e2e-ui-accept-${suffix}`),
    body: JSON.stringify({
      version: approved.data.version,
      poNumber: `PO-UI-${suffix}`,
      confirmationNote: 'Create an unbound order for reservation UI verification.',
      reasonCode: 'E2E_UI_ACCEPT',
    }),
  });
  expect(acceptResponse.ok).toBeTruthy();
  const accepted = await acceptResponse.json() as {
    data: { order: { id: string; orderNumber: string; inventoryDetailId?: string } };
  };
  expect(accepted.data.order.inventoryDetailId).toBeUndefined();

  return accepted.data.order;
}

async function loginByUi(page: Page) {
  await page.goto('/');
  await page.fill('input[type="email"]', 'zhang@aerolink.com');
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

test('reserves a matching inventory detail from the order detail dialog', async ({ page }) => {
  const creatorToken = await loginToApi('sales-test@aerolink.com');
  const approverToken = await loginToApi('zhang@aerolink.com');
  const order = await createUnboundAcceptedOrder(creatorToken, approverToken);

  await loginByUi(page);
  await openOrders(page);

  await page.getByPlaceholder('搜索订单号、件号或客户...').fill(order.orderNumber);
  const orderRow = page.locator('table tbody tr').filter({ hasText: order.orderNumber }).first();
  await expect(orderRow).toBeVisible();
  await orderRow.getByRole('button').first().click();

  const orderDialog = page.getByRole('dialog').filter({ hasText: order.orderNumber }).first();
  await expect(orderDialog.getByRole('button', { name: /预留库存|Reserve Inventory/ })).toBeVisible();
  await orderDialog.getByRole('button', { name: /预留库存|Reserve Inventory/ }).click();

  const reservationDialog = page.getByRole('dialog').filter({ hasText: /选择与订单件号匹配|Select an available inventory detail/ }).last();
  await expect(reservationDialog).toBeVisible();
  await reservationDialog.getByRole('combobox').click();
  const availableInventoryOption = page.getByRole('option').first();
  await expect(availableInventoryOption).toBeVisible();
  await availableInventoryOption.click();

  const reserveResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && response.url().includes('/api/inventory-transactions/reserve')
      && response.status() === 201,
  );
  await reservationDialog.getByRole('button', { name: /确认预留|Confirm Reservation/ }).click();
  const response = await reserveResponse;
  expect(response.request().headers()['idempotency-key']).toBeTruthy();

  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /库存预留成功|Inventory reserved/ }).last()).toBeVisible();
  await expect(orderDialog.getByText(/库存与出库|Inventory & Outbound/)).toBeVisible();
  await expect(orderDialog.getByText(/inv00[12]/)).toBeVisible();
});
