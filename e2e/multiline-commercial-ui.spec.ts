import { expect, test, type Page, type APIRequestContext } from '@playwright/test';

const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN || `http://127.0.0.1:${process.env.PLAYWRIGHT_BACKEND_PORT || '3000'}`;
const password = process.env.E2E_PASSWORD;
if (!password) throw new Error('E2E_PASSWORD is required for multiline commercial UI E2E.');
const salesUser = 'sales-test@aerolink.com';

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
  customerName: string;
  lines: RfqLine[];
};

async function login(request: APIRequestContext, email = salesUser) {
  const response = await request.post(`${apiOrigin}/api/auth/login`, {
    data: { email, password },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data.token as string;
}

async function createThreeLineRfq(request: APIRequestContext, token: string): Promise<Rfq> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await request.post(`${apiOrigin}/api/rfqs`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      customerId: 'c001',
      lines: [2, 3, 4].map((quantity, index) => ({
        partNumber: `UI-MULTI-${suffix}-${index + 1}`,
        quantity,
        requiredDate: '2027-01-15',
      })),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const rfq = (await response.json()).data as Rfq;
  expect(rfq.lineItemsMode).toBe(true);
  expect(rfq.lines).toHaveLength(3);
  return rfq;
}

async function loginByUi(page: Page) {
  await page.goto('/');
  await page.fill('input[type="email"]', salesUser);
  await page.fill('input[type="password"]', password);
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

test('sales creates a two-line quote from a three-line RFQ and submits the draft', async ({ page, request }) => {
  const salesToken = await login(request);
  const rfq = await createThreeLineRfq(request, salesToken);
  const [firstLine, secondLine, thirdLine] = rfq.lines;

  await loginByUi(page);
  await navigateToQuotations(page);

  await page.getByRole('button', { name: /创建报价/ }).click();
  const createDialog = page.getByRole('dialog');
  await expect(createDialog).toBeVisible();

  const rfqSelect = createDialog.getByRole('combobox').first();
  await rfqSelect.click();
  await page.getByRole('option').filter({ hasText: rfq.rfqNumber }).click();

  await expect(createDialog.getByRole('checkbox', { name: `选择 ${firstLine.partNumber}` })).toBeChecked();
  await expect(createDialog.getByRole('checkbox', { name: `选择 ${secondLine.partNumber}` })).toBeChecked();
  const thirdCheckbox = createDialog.getByRole('checkbox', { name: `选择 ${thirdLine.partNumber}` });
  await expect(thirdCheckbox).toBeChecked();
  await thirdCheckbox.click();
  await expect(thirdCheckbox).not.toBeChecked();

  const firstSection = createDialog.getByRole('region', { name: `报价行 ${firstLine.lineNo} ${firstLine.partNumber}` });
  const secondSection = createDialog.getByRole('region', { name: `报价行 ${secondLine.lineNo} ${secondLine.partNumber}` });
  await firstSection.getByLabel(`${firstLine.partNumber} 报价数量`).fill('2');
  await firstSection.getByLabel(`${firstLine.partNumber} 销售单价`).fill('100');
  await firstSection.getByLabel(`${firstLine.partNumber} 成本单价`).fill('60');
  await firstSection.getByLabel('人工成本依据').fill('UI test line one cost basis');
  await secondSection.getByLabel(`${secondLine.partNumber} 报价数量`).fill('3');
  await secondSection.getByLabel(`${secondLine.partNumber} 销售单价`).fill('200');
  await secondSection.getByLabel(`${secondLine.partNumber} 成本单价`).fill('120');
  await secondSection.getByLabel('人工成本依据').fill('UI test line two cost basis');

  const total = createDialog.getByTestId('quotation-display-total');
  await expect(total).toContainText('$800.00');

  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().endsWith('/api/quotations') &&
    response.status() === 201,
  );
  await createDialog.getByRole('button', { name: /创建报价草稿|创建报价单|Create Quote Draft|Create Quote/ }).click();
  const createResponse = await createResponsePromise;
  const createPayload = JSON.parse(createResponse.request().postData() || '{}') as {
    lines?: Array<{ rfqLineId: string; partNumber: string; quantity: number; unitPrice: number }>;
    partNumber?: string;
    quantity?: number;
  };
  expect(createPayload.lines).toHaveLength(2);
  expect(createPayload.lines?.map((line) => line.rfqLineId)).toEqual([firstLine.id, secondLine.id]);
  expect(createPayload.lines?.map((line) => line.partNumber)).toEqual([firstLine.partNumber, secondLine.partNumber]);
  expect(createPayload.lines?.map((line) => line.quantity)).toEqual([2, 3]);
  expect(createPayload.partNumber).toBeUndefined();
  expect(createPayload.quantity).toBeUndefined();

  const createdQuotation = (await createResponse.json()).data as { id: string; quoteNumber: string; status: string };
  expect(createdQuotation.status).toBe('draft');
  await expect(createDialog).not.toBeVisible();

  const search = page.getByPlaceholder('搜索报价单号、件号或客户...');
  await search.fill(createdQuotation.quoteNumber);
  const quoteRow = page.locator('table tbody tr').filter({ hasText: createdQuotation.quoteNumber }).first();
  await expect(quoteRow).toBeVisible();
  await expect(quoteRow).toContainText('草稿');

  const submitResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().endsWith(`/api/quotations/${createdQuotation.id}/submit`) &&
    response.status() === 200,
  );
  await quoteRow.getByRole('button', { name: '提交审批' }).click();
  const submitResponse = await submitResponsePromise;
  expect((await submitResponse.json()).data.status).toBe('pending_approval');
  await expect(quoteRow).toContainText('待审批');
});
