import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { SettlementUiFixture } from './settlementFixture';
import { evidencePdf } from './evidencePdf';

type WorkflowOptions = {
  page: Page; browser: Browser; testInfo: TestInfo;
  fixture: Omit<SettlementUiFixture, 'outsiderEmail'>;
  password: string; apiOrigin: string; settleRemainingRefund?: boolean;
};

/** Exercise finance and sales UI against the supplied exact transaction. */
export async function runSettlementWorkflow({ page, browser, testInfo, fixture, password, apiOrigin,
  settleRemainingRefund = false }: WorkflowOptions) {
  const contract = JSON.parse(readFileSync('contracts/openapi/openapi.json', 'utf8')) as {
    components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
  };
  function assertContractFields(value: Record<string, unknown>, schemaName: string) {
    const schema = contract.components.schemas[schemaName];
    expect(schema, schemaName).toBeTruthy();
    expect(Object.keys(value), schemaName).toEqual(expect.arrayContaining(schema.required || []));
    expect(Object.keys(schema.properties || {}), schemaName).toEqual(expect.arrayContaining(Object.keys(value)));
  }

  async function login(page: Page, email: string) {
    await page.goto('/');
    await page.locator('input[type=email]').fill(email);
    await page.locator('input[type=password]').fill(password);
    await page.locator('button[type=submit]').click();
    await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  }

  async function openOrder(page: Page, orderNumber: string) {
    const navigation = page.getByRole('button', { name: '打开导航菜单', exact: true });
    if (await navigation.isVisible()) await navigation.click();
    const menu = page.getByRole('button', { name: /订单管理/ });
    if (!await menu.isVisible()) await page.getByRole('button', { name: '订单与库存', exact: true }).click();
    await menu.click();
    await page.getByPlaceholder('搜索订单号、件号或客户...').fill(orderNumber);
    const row = page.locator('table tbody tr').filter({ hasText: orderNumber });
    await row.getByRole('button', { name: '查看订单详情', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('region', { name: '结算与凭证', exact: true })).toBeVisible();
    return dialog.getByRole('region', { name: '结算与凭证', exact: true });
  }

  async function upload(scope: Locator, name: string) {
    const bytes = evidencePdf(name);
    await scope.getByLabel('结算凭证（至少一份）', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
    await expect(scope.getByText(name, { exact: true })).toBeVisible();
    return bytes;
  }

  async function download(page: Page, button: Locator, expectedBytes: Buffer) {
    const pending = page.waitForEvent('download');
    await button.click();
    const result = await pending;
    expect(await result.failure()).toBeNull();
    const saved = await result.path();
    expect(saved).not.toBeNull();
    expect(await readFile(saved!)).toEqual(expectedBytes);
  }

  async function write(page: Page, path: string, action: () => Promise<unknown>) {
    const pending = page.waitForResponse(response => response.url() === `${apiOrigin}${path}` && response.request().method() === 'POST');
    await action();
    const response = await pending;
    const body = await response.json();
    expect(response.ok(), JSON.stringify(body)).toBeTruthy();
    const account = body.data;
    assertContractFields(account, account.side === 'RECEIVABLE' ? 'SettlementReceivableAccount' : 'SettlementPayableAccount');
    assertContractFields(account.amounts, 'SettlementAmounts');
    for (const record of account.records) assertContractFields(record, 'SettlementRecord');
    expect(account.purchaseCommitmentId === null).toBe(account.side === 'RECEIVABLE');
    return body.data;
  }

  async function fillReference(scope: Locator, voucher: string) {
    await scope.getByLabel('外部系统', { exact: true }).fill('SYNTHETIC-UI-FINANCE');
    await scope.getByLabel('凭证号', { exact: true }).fill(voucher);
    await scope.getByLabel('凭证行号', { exact: true }).fill('1');
    await scope.getByLabel('发生时间', { exact: true }).fill('2026-09-08T09:00');
    await scope.getByLabel('原因', { exact: true }).fill(`Synthetic ${voucher}`);
  }

  console.log('SETTLEMENT_UI_FIXTURE', JSON.stringify(fixture));
  await login(page, fixture.financeEmail);
  const panel = await openOrder(page, fixture.orderNumber);
  await panel.getByRole('button', { name: '新建结算记录', exact: true }).click();
  const opening = panel.getByTestId('settlement-account-form');
  await opening.getByLabel('结算方向', { exact: true }).selectOption('RECEIVABLE');
  await fillReference(opening, `${fixture.tag}-AR`);
  await opening.getByLabel('到期时间', { exact: true }).fill('2026-12-01T09:00');
  const arInvoice = await upload(opening, 'receivable-invoice.pdf');
  let ar = await write(page, '/api/settlements', () => opening.getByRole('button', { name: '保存结算记录', exact: true }).click());
  expect(ar.initialAmount).toBe(fixture.orderAmount);
  const arCard = panel.getByTestId(`settlement-account-${ar.id}`);
  await arCard.getByRole('button', { name: '查看历史', exact: true }).click();
  await download(page, arCard.getByRole('button', { name: '下载凭证', exact: true }).first(), arInvoice);

  async function record(kind: string, label: string, amount?: string, reversalOfId?: string) {
    await arCard.getByRole('button', { name: '登记结算记录', exact: true }).click();
    const form = arCard.getByTestId(`settlement-record-form-${ar.id}`);
    if (label === 'received') await page.setViewportSize({ width: 390, height: 844 });
    await form.getByLabel('记录类型', { exact: true }).selectOption(kind);
    if (amount) await form.getByLabel('金额（USD）', { exact: true }).fill(amount);
    if (reversalOfId) await form.getByLabel('冲销原记录', { exact: true }).selectOption(reversalOfId);
    if (kind === 'TERMS') await form.getByLabel('新截止日期', { exact: true }).fill('2027-01-15T09:00');
    await fillReference(form, `${fixture.tag}-${label}`);
    const bytes = await upload(form, `${label}.pdf`);
    if (label === 'received') {
      await form.scrollIntoViewIfNeeded();
      expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      await page.screenshot({ path: testInfo.outputPath('finance-entry-mobile.png'), fullPage: true });
    }
    ar = await write(page, `/api/settlements/${ar.id}/records`, () => form.getByRole('button', { name: '保存结算记录', exact: true }).click());
    if (label === 'received') await page.setViewportSize({ width: 1280, height: 720 });
    return { value: ar.records[ar.records.length - 1], bytes };
  }
  await record('PAYMENT', 'received', fixture.orderAmount);
  expect(ar.amounts.unpaid).toBe('0.0000');
  await record('CREDIT', 'credit', '1.0000');
  expect(ar.amounts.pendingRefund).toBe('1.0000');
  const refund = await record('REFUND', 'refund', '1.0000');
  expect(ar.amounts.pendingRefund).toBe('0.0000');
  await record('REVERSAL', 'refund-reversal', undefined, refund.value.id);
  expect(ar.amounts.pendingRefund).toBe('1.0000');
  const tinyRefund = await record('REFUND', 'tiny-refund', '0.0001');
  expect(ar.amounts.pendingRefund).toBe('0.9999');
  await arCard.getByRole('button', { name: '查看历史', exact: true }).click();
  await download(page, arCard.getByTestId(`settlement-record-${tinyRefund.value.id}`).getByRole('button', { name: '下载凭证' }), tinyRefund.bytes);
  await record('TERMS', 'extended-terms');
  expect(ar.dueDate).toBe(new Date('2027-01-15T09:00').toISOString());
  if (settleRemainingRefund) {
    await record('REFUND', 'remaining-refund', ar.amounts.pendingRefund);
    expect(ar.amounts.pendingRefund).toBe('0.0000');
    expect(ar.amounts.effectivePaid).toBe(ar.amounts.adjustedDue);
  }

  await panel.getByRole('button', { name: '新建结算记录', exact: true }).click();
  await opening.getByLabel('结算方向', { exact: true }).selectOption('PAYABLE');
  await opening.getByLabel('采购承诺来源', { exact: true }).selectOption(fixture.purchaseId);
  await fillReference(opening, `${fixture.tag}-AP`);
  await opening.getByLabel('到期时间', { exact: true }).fill('2026-12-01T09:00');
  const apInvoice = await upload(opening, 'payable-invoice.pdf');
  const ap = await write(page, '/api/settlements', () => opening.getByRole('button', { name: '保存结算记录', exact: true }).click());
  expect(ap.initialAmount).toBe(fixture.purchaseAmount);
  const apCard = panel.getByTestId(`settlement-account-${ap.id}`);
  await apCard.getByRole('button', { name: '查看历史', exact: true }).click();
  await download(page, apCard.getByRole('button', { name: '下载凭证' }).first(), apInvoice);
  await apCard.getByRole('button', { name: '登记结算记录', exact: true }).click();
  const payableForm = apCard.getByTestId(`settlement-record-form-${ap.id}`);
  await payableForm.getByLabel('记录类型', { exact: true }).selectOption('PAYMENT');
  await payableForm.getByLabel('金额（USD）', { exact: true }).fill(fixture.purchaseAmount);
  await fillReference(payableForm, `${fixture.tag}-supplier-paid`);
  await upload(payableForm, 'supplier-paid.pdf');
  const paidAp = await write(page, `/api/settlements/${ap.id}/records`, () => payableForm.getByRole('button', { name: '保存结算记录', exact: true }).click());
  expect(paidAp.amounts.unpaid).toBe('0.0000');
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('finance-settlement-desktop.png'), fullPage: true });

  const salesContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const sales = await salesContext.newPage();
    await login(sales, fixture.salesEmail);
    const incoming = sales.waitForResponse(response => response.url() === `${apiOrigin}/api/settlements?orderId=${fixture.orderId}`);
    const salesPanel = await openOrder(sales, fixture.orderNumber);
    const salesBody = await (await incoming).json();
    expect(salesBody.data.accounts.map((account: { id: string }) => account.id)).toEqual([ar.id]);
    expect(JSON.stringify(salesBody)).not.toContain(ap.id);
    await expect(salesPanel.getByTestId(`settlement-account-${ap.id}`)).toHaveCount(0);
    await expect(salesPanel.getByRole('button', { name: '登记结算记录', exact: true })).toHaveCount(0);
    await expect(salesPanel.getByRole('button', { name: '新建结算记录', exact: true })).toHaveCount(0);
    await salesPanel.getByRole('button', { name: '查看历史', exact: true }).click();
    await download(sales, salesPanel.getByTestId(`settlement-record-${ar.records[0].id}`).getByRole('button', { name: '下载凭证' }), arInvoice);
    await salesPanel.scrollIntoViewIfNeeded();
    const dialog = sales.getByRole('dialog');
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    await sales.screenshot({ path: testInfo.outputPath('sales-receivable-mobile.png'), fullPage: true });
  } finally { await salesContext.close(); }
  console.log('SETTLEMENT_UI_RESULT', JSON.stringify({ orderId: fixture.orderId, arId: ar.id, apId: ap.id,
    receivable: ar.amounts, payable: paidAp.amounts }));
  return { ar, ap: paidAp };
}
