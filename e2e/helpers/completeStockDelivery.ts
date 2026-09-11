import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { evidencePdf } from './evidencePdf';

export type CompleteStockDeliveryOptions = {
  /** The browser fixture page. It may still have the procurement order dialog open. */
  page: Page;
  /** Browser fixture used to create a separate independent quality-review session. */
  browser: Browser;
  orderId: string;
  orderNumber: string;
  stockId: string;
  serialNumber: string;
  /** Synthetic fixture tag, used for account names, evidence names, and shipment facts. */
  tag: string;
  password: string;
  apiOrigin: string;
  testInfo: TestInfo;
};

function frontendBaseUrl(page: Page) {
  const currentUrl = page.url();
  try {
    const parsed = new URL(currentUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
  } catch {
    // about:blank is expected when this helper is called from a fresh page.
  }
  return process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173';
}

async function waitForPost(page: Page, apiOrigin: string, suffix: string, action: () => Promise<void>, status: number) {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return response.url().startsWith(apiOrigin.replace(/\/$/, ''))
      && response.url().endsWith(suffix)
      && request.method() === 'POST';
  });
  await action();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(status);
  return response;
}

async function loginByUi(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /登录|Login/ }).click();
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
}

async function navigateToOrders(page: Page) {
  const ordersItem = page.getByRole('button', { name: /订单管理/ });
  if (!(await ordersItem.isVisible())) {
    await page.getByRole('button', { name: '订单与库存', exact: true }).click();
  }
  await ordersItem.click();
  await expect(page.getByRole('heading', { name: '订单管理', exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('搜索订单号、件号或客户...')).toBeVisible();
}

async function openOrder(page: Page, orderNumber: string) {
  await page.getByPlaceholder('搜索订单号、件号或客户...').fill(orderNumber);
  const row = page.locator('table tbody tr').filter({ hasText: orderNumber }).first();
  await expect(row).toBeVisible();
  const detailButton = row.getByRole('button', { name: /查看订单详情|View order details/ });
  await detailButton.click();
  const dialog = page.getByRole('dialog').filter({ hasText: orderNumber }).first();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function selectStockDetail(
  page: Page,
  panels: Locator,
  stockId: string,
  serialNumber: string,
) {
  await expect.poll(async () => {
    const count = await panels.count();
    for (let index = 0; index < count; index += 1) {
      if (await panels.nth(index).getByRole('combobox').count()) return true;
    }
    return false;
  }, { timeout: 20_000 }).toBe(true);
  const count = await panels.count();
  for (let index = 0; index < count; index += 1) {
    const panel = panels.nth(index);
    const combobox = panel.getByRole('combobox').first();
    if (!(await combobox.isVisible())) continue;
    await combobox.click();
    // Radix Select renders these in a portal. Restrict the lookup to its
    // explicit role so native <option> elements in other order tabs cannot
    // accidentally satisfy the serial-number match.
    const options = page.locator('[role="option"]');
    const optionCount = await options.count();
    for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
      const option = options.nth(optionIndex);
      const value = await option.getAttribute('data-value');
      const text = await option.innerText();
      if (value === stockId || text.includes(serialNumber)) {
        await option.click();
        return panel;
      }
    }
    await page.keyboard.press('Escape');
  }
  throw new Error(`Unable to find inventory detail ${stockId} / serial ${serialNumber} in the order allocation panels`);
}

async function selectAssignmentPanel(page: Page, dialog: Locator, serialNumber: string) {
  const panels = dialog.getByRole('region', { name: '现代行库存分配', exact: true });
  await expect.poll(async () => {
    const count = await panels.count();
    for (let index = 0; index < count; index += 1) {
      if ((await panels.nth(index).innerText()).includes(serialNumber)) return true;
    }
    return false;
  }, { timeout: 20_000 }).toBe(true);
  const matching = panels.filter({ hasText: serialNumber }).first();
  await expect(matching).toBeVisible();
  return matching;
}

async function reserveAndAssignStock(options: CompleteStockDeliveryOptions, page: Page) {
  const { apiOrigin, orderNumber, stockId, serialNumber } = options;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await navigateToOrders(page);
  const dialog = await openOrder(page, orderNumber);
  const panels = dialog.getByRole('region', { name: '现代行库存分配', exact: true });
  await expect(panels).toHaveCount(2);

  const panel = await selectStockDetail(page, panels, stockId, serialNumber);
  const reservationQuantity = panel.getByRole('spinbutton').first();
  await reservationQuantity.fill('1');
  await waitForPost(page, apiOrigin, '/api/inventory-allocations/reserve',
    () => panel.getByRole('button', { name: '预留', exact: true }).click(), 201);

  // Reserving from an order line atomically creates its assignment. A second
  // assign action would incorrectly consume the same parent capacity twice.
  await expect(panel).toContainText(/已分配\s*1|Assigned\s*1/);
  await expect(panel).toContainText(/未分配\s*0|Unassigned\s*0/);
  await expect(panel).toContainText(serialNumber);
}

async function reviewStockIndependently(options: CompleteStockDeliveryOptions) {
  const { browser, apiOrigin, orderNumber, serialNumber, password, tag } = options;
  const qualityContext = await browser.newContext({ baseURL: frontendBaseUrl(options.page) });
  const qualityPage = await qualityContext.newPage();
  try {
    await loginByUi(qualityPage, `d14-direct-quality-${tag}@example.invalid`, password);
    await navigateToOrders(qualityPage);
    const dialog = await openOrder(qualityPage, orderNumber);
    const panel = await selectAssignmentPanel(qualityPage, dialog, serialNumber);
    const assignment = panel.locator('input[type="radio"]').last();
    await assignment.check();
    await expect(panel).toContainText(/快照：|Snapshot:/, { timeout: 20_000 });

    const evidenceName = `mixed-${tag}-outbound-quality.pdf`;
    await panel.locator('input[type="file"]').setInputFiles({
      name: evidenceName,
      mimeType: 'application/pdf',
      buffer: evidencePdf(evidenceName),
    });
    await expect(panel).toContainText(evidenceName);
    await panel.getByLabel('核对序号', { exact: true }).fill(serialNumber);
    await panel.getByLabel('核对批次', { exact: true }).fill('');
    const checks = panel.locator('input[type="checkbox"]');
    await expect(checks).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) await checks.nth(index).check();
    await panel.getByLabel('审核依据', { exact: true }).fill('独立质量人员已核对序号件实物、收货来源、文件与客户要求。');
    await waitForPost(qualityPage, apiOrigin, '/api/inventory-allocations/quality-reviews',
      () => panel.getByRole('button', { name: '提交质量复核', exact: true }).click(), 201);
    await expect(panel).toContainText(/快照：|Snapshot:/);
  } finally {
    await qualityContext.close();
  }
}

async function consumeAndShipStock(options: CompleteStockDeliveryOptions, page: Page) {
  const { apiOrigin, orderNumber, serialNumber, tag, testInfo } = options;
  // Refresh this already authenticated session after the independent review,
  // closing its old dialog and obtaining current assignment/review state.
  await page.reload();
  await expect(page.getByPlaceholder('搜索订单号、件号或客户...')).toBeVisible();
  const dialog = await openOrder(page, orderNumber);
  const allocationPanel = await selectAssignmentPanel(page, dialog, serialNumber);
  await allocationPanel.locator('input[type="radio"]').last().check();
  await expect(allocationPanel).toContainText(/已有同数量、同快照的有效质量复核|A valid review exists/, { timeout: 20_000 });
  await waitForPost(page, apiOrigin, '/api/inventory-allocations/consume',
    () => allocationPanel.getByRole('button', { name: '确认出库', exact: true }).click(), 200);

  const shipmentPanel = dialog.getByRole('region', { name: '发运、签收与退货', exact: true });
  await expect(shipmentPanel).toBeVisible();
  await shipmentPanel.getByRole('button', { name: '刷新发运', exact: true }).click();
  const sourceCheckboxes = shipmentPanel.locator('input[type="checkbox"]');
  await expect(sourceCheckboxes.first()).toBeVisible({ timeout: 20_000 });
  let source: Locator | null = null;
  for (let index = 0; index < await sourceCheckboxes.count(); index += 1) {
    const candidate = sourceCheckboxes.nth(index);
    const rowText = await candidate.locator('xpath=..').innerText();
    if (rowText.includes(serialNumber)) {
      source = candidate;
      break;
    }
  }
  if (!source) throw new Error(`Unable to match an OUTBOUND shipment source to serial ${serialNumber}`);
  await source.check();
  await shipmentPanel.getByLabel(/发运数量|Shipment quantity/).first().fill('1');
  await shipmentPanel.getByLabel(/承运人|Carrier/).fill(`Synthetic warehouse carrier ${tag}`);
  await shipmentPanel.getByLabel(/运单号|Tracking number/).fill(`MIXED-STOCK-${tag}`);
  await shipmentPanel.getByLabel(/起运地|Origin/).fill(`Synthetic warehouse ${tag}`);
  await shipmentPanel.getByLabel(/目的地|Destination/).fill('Synthetic customer');
  await waitForPost(page, apiOrigin, '/api/shipments',
    () => shipmentPanel.getByRole('button', { name: /创建发运单|Create shipment/ }).click(), 201);
  await expect(shipmentPanel).toContainText(`MIXED-STOCK-${tag}`);

  const receiptEvidenceName = `mixed-${tag}-customer-receipt.pdf`;
  await shipmentPanel.getByLabel(/本人上传签收证据|Upload receipt evidence/).setInputFiles({
    name: receiptEvidenceName,
    mimeType: 'application/pdf',
    buffer: evidencePdf(receiptEvidenceName),
  });
  await expect(shipmentPanel).toContainText(receiptEvidenceName);
  await shipmentPanel.getByLabel(/签收说明|Receipt reason/).fill('客户已签收库存收货序号件，混合订单交付完成。');
  await shipmentPanel.getByLabel(/签收数量|Receipt quantity/).first().fill('1');
  await waitForPost(page, apiOrigin, '/receipts', async () => {
    await shipmentPanel.getByRole('button', { name: /保存签收|Record receipt/ }).click();
  }, 200);
  await expect(shipmentPanel).toContainText(/全部签收|Complete/);
  await page.screenshot({ path: testInfo.outputPath('mixed-stock-delivery-final.png'), fullPage: true });
}

/**
 * Completes the stock-receipt side of the D14 mixed-delivery order entirely
 * through the browser UI: reserve and assign the accepted serial item, have a
 * separate quality user approve the outbound snapshot, consume it as a
 * warehouse operator, create a shipment, and record the customer receipt.
 */
export async function completeStockDelivery(options: CompleteStockDeliveryOptions): Promise<void> {
  const warehouseContext = await options.browser.newContext({ baseURL: frontendBaseUrl(options.page) });
  const warehousePage = await warehouseContext.newPage();
  try {
    await loginByUi(warehousePage, `d14-direct-buyer-${options.tag}@example.invalid`, options.password);
    await reserveAndAssignStock(options, warehousePage);
    await reviewStockIndependently(options);
    await consumeAndShipStock(options, warehousePage);
  } finally {
    await warehouseContext.close();
  }
}
