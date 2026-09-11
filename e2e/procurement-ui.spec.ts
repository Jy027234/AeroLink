import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { evidencePdf } from './helpers/evidencePdf';
import { completeStockDelivery } from './helpers/completeStockDelivery';
import { runSettlementWorkflow } from './helpers/settlementWorkflow';

const requireServer = createRequire(path.resolve('server/package.json'));
const { PrismaClient } = requireServer('@prisma/client');
const bcrypt = requireServer('bcryptjs');
const password = 'Synthetic-Procurement-UI-Only!2026';
const completeTransaction = process.env.AEROLINK_COMPLETE_TRANSACTION_UI_INTEGRATION === 'true';
const apiOrigin = completeTransaction ? 'http://127.0.0.1:3190' : 'http://127.0.0.1:3189';
test.skip(process.env.AEROLINK_PROCUREMENT_UI_INTEGRATION !== 'true', 'Run with the isolated procurement config and explicit integration opt-in');
type Fixture = { tag: string; orderId: string; supplierId: string; orderLineIds: string[]; sourceQuoteIds: string[];
  users: { buyerId: string; approverId: string; qualityId: string; salesId: string } };

async function fixture(): Promise<Fixture> {
  if (process.env.AEROLINK_PROCUREMENT_UI_INTEGRATION !== 'true') throw new Error('Explicit local UI opt-in required');
  const url = new URL(process.env.DATABASE_URL!);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55970'
    || url.pathname !== (completeTransaction ? '/aerolink_settlement_test_20260910'
      : '/aerolink_procurement_test_direct_20260909')) throw new Error('Refusing other database');
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'src/scripts/checkDirectShipmentCommands.ts'], {
      cwd: path.resolve('server'), env: { ...process.env, AEROLINK_DIRECT_SHIPMENT_INTEGRATION: 'true',
        AEROLINK_DIRECT_SHIPMENT_SALES_FIXTURE_ONLY: 'true' }, maxBuffer: 4_000_000,
    });
  const result = JSON.parse(stdout) as Fixture;
  const db = new PrismaClient();
  try {
    const ids = [result.users.buyerId, result.users.approverId, result.users.qualityId, result.users.salesId];
    const rows = await db.user.findMany({ where: { id: { in: ids } } });
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.email).toContain(`${result.tag}@example.invalid`);
      expect(row.name).toContain('synthetic');
      await db.user.update({ where: { id: row.id }, data: { password: await bcrypt.hash(password, 10) } });
    }
  } finally { await db.$disconnect(); }
  return result;
}

async function openOrder(page: Page, tag: string, role: 'buyer' | 'approver' | 'quality') {
  await page.goto('/');
  await page.locator('input[type=email]').fill(`d14-direct-${role}-${tag}@example.invalid`);
  await page.locator('input[type=password]').fill(password);
  await page.locator('button[type=submit]').click();
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  const menu = page.getByRole('button', { name: /订单管理/ });
  if (!await menu.isVisible()) await page.getByRole('button', { name: '订单与库存', exact: true }).click();
  await menu.click();
  await page.getByPlaceholder('搜索订单号、件号或客户...').fill(`D14-DIRECT-ORDER-${tag}`);
  const row = page.locator('table tbody tr').filter({ hasText: `D14-DIRECT-ORDER-${tag}` });
  await row.getByRole('button', { name: '查看订单详情', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('region', { name: '采购与收货', exact: true })).toBeVisible();
  return dialog;
}

async function upload(scope: Locator, label: string, name: string) {
  await scope.getByLabel(label, { exact: true }).setInputFiles({ name, mimeType: 'application/pdf',
    buffer: evidencePdf(name) });
  await expect(scope.getByText(name, { exact: true })).toBeVisible();
}

async function write(page: Page, urlSuffix: string, action: () => Promise<unknown>) {
  const response = page.waitForResponse(response => response.url().startsWith(apiOrigin)
    && response.url().endsWith(urlSuffix) && response.request().method() === 'POST');
  await action();
  const result = await response;
  const payload = await result.json();
  expect(result.ok(), JSON.stringify(payload)).toBeTruthy();
  return payload.data;
}

test('purchase approval and supplier confirmation lead to independent direct quality review and receipt', async ({ page, browser }, testInfo) => {
  const data = await fixture();
  console.log('PROCUREMENT_UI_FIXTURE', JSON.stringify(data));
  const dialog = await openOrder(page, data.tag, 'buyer');
  const panel = dialog.getByRole('region', { name: '采购与收货', exact: true });
  await panel.getByRole('button', { name: '新建采购承诺', exact: true }).click();
  await panel.getByLabel('搜索供应商', { exact: true }).fill(data.tag);
  await expect(panel.getByRole('combobox', { name: '采购供应商', exact: true }).locator(`option[value="${data.supplierId}"]`)).toHaveCount(1);
  await panel.getByRole('combobox', { name: '采购供应商', exact: true }).selectOption(data.supplierId);
  for (let index = 0; index < 2; index++) {
    const part = `D14-DIRECT-${index === 0 ? 'BATCH' : 'SERIAL'}-${data.tag}`;
    const line = panel.locator('fieldset').filter({ has: page.getByRole('checkbox', { name: new RegExp(part) }) });
    await line.getByRole('checkbox').check();
    await line.getByLabel('采购数量', { exact: true }).fill(index === 0 ? '2' : '1');
    await line.getByLabel('承诺交期', { exact: true }).fill('2027-02-15T09:00');
    await line.getByRole('combobox', { name: '履约方式', exact: true }).selectOption(index === 0 ? 'SUPPLIER_DIRECT' : 'STOCK_RECEIPT');
    await expect(line.getByRole('combobox', { name: '供应商报价', exact: true }).locator(`option[value="${data.sourceQuoteIds[index]}"]`)).toHaveCount(1);
    await line.getByRole('combobox', { name: '供应商报价', exact: true }).selectOption(data.sourceQuoteIds[index]);
  }
  const purchase = await write(page, '/api/purchase-commitments', () => panel.getByRole('button', { name: '保存采购草稿' }).click());
  const card = panel.locator('article').first();
  await card.getByLabel('操作依据').fill('Synthetic UI purchase submission');
  await write(page, `/api/purchase-commitments/${purchase.id}/submit`, () => card.getByRole('button', { name: '提交审批' }).click());
  await expect(card.getByText('待审批', { exact: true })).toBeVisible();

  const financeContext = await browser.newContext();
  const finance = await financeContext.newPage();
  const financeDialog = await openOrder(finance, data.tag, 'approver');
  const financeCard = financeDialog.getByRole('region', { name: '采购与收货', exact: true }).locator('article').first();
  await financeCard.getByLabel('操作依据').fill('Independent finance approval');
  await write(finance, `/api/purchase-commitments/${purchase.id}/approve`, () => financeCard.getByRole('button', { name: '批准采购' }).click());
  await financeContext.close();
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await card.getByLabel('操作依据').fill('Supplier confirmed the purchase');
  await card.getByLabel('供应商确认编号').fill(`UI-CONFIRM-${data.tag}`);
  await upload(card, '供应商确认凭证', 'supplier-confirmation.pdf');
  await write(page, `/api/purchase-commitments/${purchase.id}/confirm`, () => card.getByRole('button', { name: '登记供应商确认' }).click());
  await expect(card.getByText('供应商已确认', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: '查看附件' }).click();
  expect(await (await download).failure()).toBeNull();

  await panel.getByRole('tab', { name: '供应商直发', exact: true }).click();
  await panel.getByRole('combobox', { name: '选择采购承诺', exact: true }).selectOption(purchase.id);
  await panel.getByRole('checkbox', { name: new RegExp(`D14-DIRECT-BATCH-${data.tag}`) }).check();
  await panel.getByLabel('实物数量', { exact: true }).fill('1');
  await panel.getByLabel('批次号', { exact: true }).fill(`UI-BATCH-A-${data.tag}`);
  await panel.getByRole('button', { name: '添加实际批次/序号', exact: true }).click();
  await panel.getByLabel('批次号', { exact: true }).nth(1).fill(`UI-BATCH-B-${data.tag}`);
  await panel.getByLabel('承运商', { exact: true }).fill('Synthetic carrier');
  await panel.getByLabel('运单号', { exact: true }).fill(`UI-AWB-${data.tag}`);
  await panel.getByLabel('起运地', { exact: true }).fill('Supplier test warehouse');
  await panel.getByLabel('目的地', { exact: true }).fill('Synthetic customer');
  await panel.getByLabel('创建原因', { exact: true }).fill('Two physical batches on one shipment');
  await upload(panel, '运单证据（至少一份）', 'direct-waybill.pdf');
  const shipment = await write(page, '/api/direct-shipments', () => panel.getByRole('button', { name: '创建直发单', exact: true }).click());
  await expect(panel.getByTestId('direct-shipment-line-1')).toBeVisible();
  await panel.getByTestId('direct-shipment-line-1').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('direct-prepared-desktop.png'), fullPage: true });

  const qualityContext = await browser.newContext();
  const quality = await qualityContext.newPage();
  const qualityDialog = await openOrder(quality, data.tag, 'quality');
  const qualityPanel = qualityDialog.getByRole('region', { name: '采购与收货', exact: true });
  await qualityPanel.getByRole('tab', { name: '供应商直发', exact: true }).click();
  for (let number = 1; number <= 2; number++) {
    const line = qualityPanel.getByTestId(`direct-shipment-line-${number}`);
    await line.getByRole('button', { name: '加载质量审核', exact: true }).click();
    await expect(line.getByText('当前没有质量问题。', { exact: true })).toBeVisible();
    await expect(line.getByText('剩余小时', { exact: true })).toBeVisible();
    const proof = quality.waitForEvent('download');
    await line.getByRole('button', { name: '下载运单证据', exact: true }).click();
    expect(await (await proof).failure()).toBeNull();
    for (const name of ['身份一致', '证书/文件', '状态与寿命', '客户要求']) await line.getByRole('checkbox', { name, exact: true }).check();
    await line.getByLabel('审核原因', { exact: true }).fill('Independent quality physical verification');
    await write(quality, '/review', () => line.getByRole('button', { name: '通过', exact: true }).click());
    await expect(line.getByText('已通过', { exact: true })).toBeVisible();
  }
  await qualityContext.close();
  // Remount the direct tab so its independent list fetch obtains quality updates.
  await panel.getByRole('tab', { name: '采购承诺', exact: true }).click();
  await panel.getByRole('tab', { name: '供应商直发', exact: true }).click();
  await panel.getByLabel('发运/取消原因').fill('Supplier dispatched verified physical batches');
  await write(page, `/api/direct-shipments/${shipment.id}/dispatch`, () => panel.getByRole('button', { name: '发运', exact: true }).click());
  for (let number = 1; number <= 2; number++) {
    const line = panel.getByTestId(`direct-shipment-line-${number}`);
    await line.getByLabel('本次数量').fill('1');
    await line.getByLabel('签收人').fill('Synthetic customer receiver');
    await line.getByLabel('签收时间').fill('2026-09-08T10:00');
    await line.getByLabel('签收原因').fill('Customer receipt proof verified');
    await upload(line, '签收证明（至少一份）', `receipt-${number}.pdf`);
    await write(page, '/receipt', () => line.getByRole('button', { name: '保存签收', exact: true }).click());
  }
  await expect(panel.getByText('已签收', { exact: true })).toBeVisible();
  const db = new PrismaClient();
  try {
    const current = await db.order.findUniqueOrThrow({ where: { id: data.orderId } });
    expect(current.directShippedQuantity).toBe(2);
    expect(current.outboundQuantity).toBe(0);
    expect(current.status).toBe('SO_CREATED'); // the stock receipt line is still unfulfilled
    expect(await db.inventoryTransaction.count({ where: { orderId: data.orderId } })).toBe(0);
    const commitment = await db.purchaseCommitment.findUniqueOrThrow({ where: { id: purchase.id }, include: { lines: true } });
    expect(commitment.lines.every((line: { receivedQuantity: number }) => line.receivedQuantity === 0)).toBe(true);
  } finally { await db.$disconnect(); }

  await panel.getByRole('tab', { name: '收货质检', exact: true }).click();
  await panel.getByRole('combobox', { name: '选择采购承诺', exact: true }).selectOption(purchase.id);
  const receiptLineSelect = panel.getByRole('combobox', { name: '选择采购行', exact: true });
  await expect(receiptLineSelect.locator('option')).toHaveCount(2);
  await receiptLineSelect.selectOption({ index: 1 });
  await panel.getByRole('button', { name: '添加到货批次', exact: true }).click();
  await panel.getByRole('combobox', { name: '跟踪方式', exact: true }).selectOption('SERIAL');
  await panel.getByLabel('序号', { exact: true }).fill(`SN-DIRECT-${data.tag}`);
  await panel.getByLabel('仓库', { exact: true }).fill('Synthetic warehouse');
  await panel.getByLabel('库位', { exact: true }).fill('UI-QUARANTINE');
  await panel.getByLabel('供应商送货单号', { exact: true }).fill(`UI-DELIVERY-${data.tag}`);
  await panel.getByLabel('收货说明', { exact: true }).fill('Serial part received pending independent review');
  await upload(panel, '收货附件证据（至少 1 个）', 'stock-arrival.pdf');
  const receipt = await write(page, '/api/stock-receipts', () => panel.getByRole('button', { name: '建立待检收货', exact: true }).click());
  await expect(panel.getByText('待质检', { exact: true })).toBeVisible();
  const stockQualityContext = await browser.newContext();
  const stockQuality = await stockQualityContext.newPage();
  const stockQualityDialog = await openOrder(stockQuality, data.tag, 'quality');
  const stockQualityPanel = stockQualityDialog.getByRole('region', { name: '采购与收货', exact: true });
  await stockQualityPanel.getByRole('tab', { name: '收货质检', exact: true }).click();
  const stockReview = stockQualityPanel.getByRole('region', { name: '采购收货与质检', exact: true });
  await expect(stockReview.getByText('剩余小时', { exact: true })).toBeVisible();
  const arrivalProof = stockQuality.waitForEvent('download');
  await stockReview.getByRole('button', { name: '查看收货凭证', exact: true }).click();
  expect(await (await arrivalProof).failure()).toBeNull();
  for (const name of ['已核对实物身份与件号', '已核对文件与实物一致', '已核对状态与寿命要求', '已满足客户质量要求']) {
    await stockReview.getByRole('checkbox', { name, exact: true }).check();
  }
  await stockReview.getByLabel('审核依据/拒收原因', { exact: true }).fill('Independent received serial part and evidence verified');
  await write(stockQuality, '/review', () => stockReview.getByRole('button', { name: '审核通过', exact: true }).click());
  await expect(stockReview.getByText('已接收', { exact: true })).toBeVisible();
  await stockQualityContext.close();
  await panel.getByRole('button', { name: '刷新收货', exact: true }).click();
  await expect(panel.getByText('已接收', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('tab', { name: '供应商直发', exact: true }).click();
  await panel.getByTestId('direct-shipment-line-1').scrollIntoViewIfNeeded();
  await expect.poll(async () => dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('direct-received-mobile.png'), fullPage: true });
  const verified = new PrismaClient();
  let acceptedStockId = '';
  try {
    const currentReceipt = await verified.stockReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { lines: true } });
    expect(currentReceipt.lines).toHaveLength(1);
    expect(currentReceipt.lines[0].status).toBe('ACCEPTED');
    const stock = await verified.inventoryDetail.findUniqueOrThrow({ where: { id: currentReceipt.lines[0].inventoryDetailId } });
    acceptedStockId = stock.id;
    expect(stock.serialNumber).toBe(`SN-DIRECT-${data.tag}`);
    expect(stock.quantity).toBe(1);
    const currentOrder = await verified.order.findUniqueOrThrow({ where: { id: data.orderId } });
    expect(currentOrder.directShippedQuantity).toBe(2);
    expect(currentOrder.outboundQuantity).toBe(0);
    expect(currentOrder.status).toBe('SO_CREATED');
  } finally { await verified.$disconnect(); }

  if (completeTransaction) {
    const orderNumber = `D14-DIRECT-ORDER-${data.tag}`;
    await page.setViewportSize({ width: 1280, height: 720 });
    await completeStockDelivery({ browser, page, orderId: data.orderId, orderNumber,
      stockId: acceptedStockId, serialNumber: `SN-DIRECT-${data.tag}`, tag: data.tag,
      password, apiOrigin, testInfo });
    const settlementContext = await browser.newContext();
    try {
      const settlementPage = await settlementContext.newPage();
      const settlement = await runSettlementWorkflow({ page: settlementPage, browser, testInfo, password, apiOrigin,
        settleRemainingRefund: true, fixture: { tag: data.tag, orderId: data.orderId, orderNumber,
          orderAmount: '12000.0000', purchaseId: purchase.id, purchaseNumber: purchase.commitmentNumber,
          purchaseAmount: '7500.0000', salesEmail: `d14-direct-sales-${data.tag}@example.invalid`,
          financeEmail: `d14-direct-approver-${data.tag}@example.invalid` } });
      const audit = new PrismaClient();
      try {
        const current = await audit.order.findUniqueOrThrow({ where: { id: data.orderId } });
        expect(current.status).toBe('DELIVERED');
        expect(current.quantity).toBe(3);
        expect(current.outboundQuantity).toBe(1);
        expect(current.directShippedQuantity).toBe(2);
        const accounts = await audit.settlementAccount.findMany({ where: { orderId: data.orderId },
          include: { records: true } });
        expect(accounts).toHaveLength(2);
        for (const account of accounts) {
          expect(account.version).toBe(account.records.length);
          expect(account.createdById).toBe(data.users.approverId);
          await audit.$queryRaw`SELECT validate_settlement_account_state_v1(${account.id})::text`;
        }
        expect(settlement.ar.amounts.unpaid).toBe('0.0000');
        expect(settlement.ar.amounts.pendingRefund).toBe('0.0000');
        expect(settlement.ap.amounts.unpaid).toBe('0.0000');
        console.log('COMPLETE_TRANSACTION_UI_RESULT', JSON.stringify({
          orderId: data.orderId, orderNumber, purchaseId: purchase.id, stockId: acceptedStockId,
          status: current.status, directShipped: current.directShippedQuantity, localOutbound: current.outboundQuantity,
          arId: settlement.ar.id, apId: settlement.ap.id,
          receivable: settlement.ar.amounts, payable: settlement.ap.amounts,
        }));
      } finally { await audit.$disconnect(); }
    } finally { await settlementContext.close(); }
  }
});
