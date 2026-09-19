import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN || `http://127.0.0.1:${process.env.PLAYWRIGHT_BACKEND_PORT || '3000'}`;
const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('E2E_PASSWORD is required for quotation revision UI E2E.');

const salesUser = 'sales-test@aerolink.com';
const managerUser = 'zhang@aerolink.com';

type RfqLine = {
  id: string;
  lineNo: number;
  partNumber: string;
  quantity: number;
  status: string;
};

type Rfq = {
  id: string;
  rfqNumber: string;
  lineItemsMode: boolean;
  customerId: string;
  lines: RfqLine[];
};

type Quotation = {
  id: string;
  rfqId: string;
  customerId: string;
  validityDays: number;
  quoteNumber: string;
  version: number;
  status: string;
  totalPrice: number;
  commercialRevision: number;
  revisionOfId?: string | null;
  supersededById?: string | null;
  lines: Array<{
    id: string;
    rfqLineId: string;
    partNumber: string;
    quantity: number;
    unitPrice: number;
    acceptedQuantity: number;
  }>;
};

async function login(request: APIRequestContext, email: string) {
  const response = await request.post(`${apiOrigin}/api/auth/login`, {
    data: { email, password },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data.token as string;
}

function headers(token: string, idempotencyKey?: string) {
  return {
    Authorization: `Bearer ${token}`,
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

async function post(request: APIRequestContext, path: string, data: unknown, token: string, idempotencyKey?: string) {
  return request.post(`${apiOrigin}/api/${path}`, {
    headers: headers(token, idempotencyKey),
    data,
  });
}

async function get<T>(request: APIRequestContext, path: string, token: string): Promise<T> {
  const response = await request.get(`${apiOrigin}/api/${path}`, { headers: headers(token) });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data as T;
}

async function createApprovedPartiallyAcceptedQuotation(request: APIRequestContext, salesToken: string, managerToken: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rfqResponse = await post(request, 'rfqs', {
    customerId: 'c001',
    lines: [4, 3].map((quantity, index) => ({
      partNumber: `UI-REV-${suffix}-${index + 1}`,
      quantity,
      requiredDate: '2027-02-01',
    })),
  }, salesToken);
  expect(rfqResponse.status(), await rfqResponse.text()).toBe(201);
  const rfq = (await rfqResponse.json()).data as Rfq;
  expect(rfq.lineItemsMode).toBe(true);
  expect(rfq.lines).toHaveLength(2);

  const quotationResponse = await post(request, 'quotations', {
    rfqId: rfq.id,
    customerId: rfq.customerId,
    currency: 'USD',
    validityDays: 10,
    lines: rfq.lines.map((line, index) => ({
      rfqLineId: line.id,
      partNumber: line.partNumber,
      quantity: line.quantity,
      unitPrice: index === 0 ? 100 : 200,
      costPrice: index === 0 ? 50 : 120,
      costSourceType: 'MANUAL',
      costSourceReason: `UI revision fixture cost ${index + 1}`,
    })),
  }, salesToken);
  expect(quotationResponse.status(), await quotationResponse.text()).toBe(201);
  const quotation = (await quotationResponse.json()).data as Quotation;
  expect(quotation.status).toBe('draft');

  const submitResponse = await post(request, `quotations/${quotation.id}/submit`, { version: quotation.version }, salesToken);
  expect(submitResponse.status(), await submitResponse.text()).toBe(200);
  const submitted = (await submitResponse.json()).data as { version: number };

  const approveResponse = await post(request, `quotations/${quotation.id}/approve`, {
    action: 'approve',
    version: submitted.version,
  }, managerToken);
  expect(approveResponse.status(), await approveResponse.text()).toBe(200);
  const approved = (await approveResponse.json()).data as { version: number };

  const acceptResponse = await post(request, `quotations/${quotation.id}/accept`, {
    version: approved.version,
    lines: [{ quotationLineId: quotation.lines[0].id, quantity: 1 }],
  }, salesToken, `ui-revision-partial-${suffix}`);
  expect(acceptResponse.status(), await acceptResponse.text()).toBe(200);

  const current = await get<Quotation>(request, `quotations/${quotation.id}`, salesToken);
  expect(current.lines.map((line) => line.acceptedQuantity)).toEqual([1, 0]);
  return { rfq, original: current };
}

async function loginByUi(page: Page) {
  await page.goto('/');
  await page.fill('input[type="email"]', salesUser);
  await page.fill('input[type="password"]', password!);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
}

async function navigateToQuotations(page: Page) {
  const quotationItem = page.getByRole('button', { name: /报价管理/ });
  if (!(await quotationItem.isVisible())) {
    await page.getByRole('button', { name: '寻源报价', exact: true }).click();
  }
  await quotationItem.click();
  await expect(page.getByPlaceholder('搜索报价单号、件号或客户...')).toBeVisible();
}

test('sales revises a partially accepted quote through the browser and creates a new draft', async ({ page, request }) => {
  const salesToken = await login(request, salesUser);
  const managerToken = await login(request, managerUser);
  const { rfq, original } = await createApprovedPartiallyAcceptedQuotation(request, salesToken, managerToken);

  await loginByUi(page);
  await navigateToQuotations(page);

  const search = page.getByPlaceholder('搜索报价单号、件号或客户...');
  await search.fill(original.quoteNumber);
  const quoteRow = page.locator('table tbody tr').filter({ hasText: original.quoteNumber }).first();
  await expect(quoteRow).toBeVisible();
  await quoteRow.getByRole('button', { name: '查看报价详情' }).click();

  const detailDialog = page.getByRole('dialog');
  await expect(detailDialog).toBeVisible();
  await expect(detailDialog).toContainText(`v${original.commercialRevision}`);
  await detailDialog.getByRole('button', { name: '修订报价' }).click();

  const revisionDialog = page.getByRole('dialog', { name: '修订报价单', exact: true });
  await expect(revisionDialog).toBeVisible();
  await expect(revisionDialog).toContainText('修订报价单');
  await expect(revisionDialog.getByRole('combobox').first()).toBeDisabled();
  await expect(revisionDialog.getByPlaceholder('输入客户名称')).toHaveValue('中国国航');

  await revisionDialog.getByLabel('修订原因 *').fill('UI buyer requested a new remaining quantity price');
  await revisionDialog.getByLabel('新版有效期（天） *').fill('14');

  const firstLine = revisionDialog.getByRole('region', { name: `报价行 ${rfq.lines[0].lineNo} ${rfq.lines[0].partNumber}` });
  const secondLine = revisionDialog.getByRole('region', { name: `报价行 ${rfq.lines[1].lineNo} ${rfq.lines[1].partNumber}` });
  await expect(firstLine.getByLabel(`${rfq.lines[0].partNumber} 报价数量`)).toHaveValue('3');
  await expect(firstLine.getByLabel(`${rfq.lines[0].partNumber} 销售单价`)).toHaveValue('100');
  await expect(secondLine.getByLabel(`${rfq.lines[1].partNumber} 销售单价`)).toHaveValue('200');
  await firstLine.getByLabel(`${rfq.lines[0].partNumber} 销售单价`).fill('110');
  await firstLine.getByLabel(`${rfq.lines[0].partNumber} 成本单价`).fill('55');
  await firstLine.getByLabel('人工成本依据').fill('UI re-verified cost line one');
  await secondLine.getByLabel(`${rfq.lines[1].partNumber} 销售单价`).fill('220');
  await secondLine.getByLabel(`${rfq.lines[1].partNumber} 成本单价`).fill('120');
  await secondLine.getByLabel('人工成本依据').fill('UI re-verified cost line two');

  const reviseResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().endsWith(`/api/quotations/${original.id}/revise`),
  );
  await revisionDialog.getByRole('button', { name: '创建新版报价草稿' }).click();
  const reviseResponse = await reviseResponsePromise;
  expect(reviseResponse.status(), await reviseResponse.text()).toBe(201);
  const revisePayload = JSON.parse(reviseResponse.request().postData() || '{}') as {
    version: number;
    reason: string;
    quotation: {
      rfqId: string;
      customerId: string;
      validityDays: number;
      lines: Array<{ rfqLineId: string; quantity: number; unitPrice: number; costPrice: number; costSourceReason: string }>;
      partNumber?: string;
      unitPrice?: number;
      eSignature?: string;
      eSignatureStatus?: string;
    };
  };
  const revised = (await reviseResponse.json()).data as Quotation;
  expect(revisePayload.version).toBe(original.version);
  expect(revisePayload.reason).toBe('UI buyer requested a new remaining quantity price');
  expect(revisePayload.quotation).toMatchObject({
    rfqId: original.rfqId,
    customerId: original.customerId,
    validityDays: 14,
    eSignatureStatus: 'Unsigned',
  });
  expect(revisePayload.quotation.lines.map((line) => line.quantity)).toEqual([3, 3]);
  expect(revisePayload.quotation.lines.map((line) => line.unitPrice)).toEqual([110, 220]);
  expect(revisePayload.quotation.lines.map((line) => line.costPrice)).toEqual([55, 120]);
  expect(revisePayload.quotation.lines.every((line) => line.costSourceReason.length > 0)).toBe(true);
  expect(revisePayload.quotation.partNumber).toBeUndefined();
  expect(revisePayload.quotation.unitPrice).toBeUndefined();
  expect(revisePayload.quotation.eSignature).toBeUndefined();
  expect(revised.status).toBe('draft');
  expect(revised.commercialRevision).toBe(2);
  expect(revised.revisionOfId).toBe(original.id);

  await expect(revisionDialog).not.toBeVisible();
  const newDetailDialog = page.getByRole('dialog');
  await expect(newDetailDialog).toBeVisible();
  await expect(newDetailDialog).toContainText(revised.quoteNumber);
  await expect(newDetailDialog).toContainText('草稿');
  await expect(newDetailDialog).toContainText('UI buyer requested a new remaining quantity price');

  const oldAfter = await get<Quotation>(request, `quotations/${original.id}`, salesToken);
  const revisedAfter = await get<Quotation>(request, `quotations/${revised.id}`, salesToken);
  expect(oldAfter.supersededById).toBe(revised.id);
  expect(oldAfter.lines.map((line) => line.acceptedQuantity)).toEqual([1, 0]);
  expect(oldAfter.totalPrice).toBe(1000);
  expect(revisedAfter.status).toBe('draft');
  expect(revisedAfter.commercialRevision).toBe(2);
  expect(revisedAfter.revisionOfId).toBe(original.id);
  expect(revisedAfter.validityDays).toBe(14);
  expect(revisedAfter.lines.map((line) => line.quantity)).toEqual([3, 3]);
  expect(revisedAfter.lines.map((line) => Number(line.unitPrice))).toEqual([110, 220]);
  expect(revisedAfter.totalPrice).toBe(990);
});
