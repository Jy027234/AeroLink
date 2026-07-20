import { expect, test } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

const managerUser = {
  email: 'zhang@aerolink.com',
  password: E2E_PASSWORD,
};

const backendBaseUrl = `${process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000'}/api`;

async function loginToApi(apiBaseUrl: string) {
  const loginResponse = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(managerUser),
  });

  expect(loginResponse.ok).toBeTruthy();
  const loginPayload = await loginResponse.json() as {
    data: { token: string };
  };

  return loginPayload.data.token;
}

async function createApprovedQuotation(apiBaseUrl: string, existingToken?: string) {
  const token = existingToken ?? await loginToApi(apiBaseUrl);
  const uniqueSuffix = Date.now();
  const createResponse = await fetch(`${apiBaseUrl}/quotations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      rfqId: 'rfq001',
      customerId: 'c001',
      partNumber: `E2E-CONTRACT-${uniqueSuffix}`,
      quantity: 2,
      unitPrice: 2100,
      costPrice: 1800,
      certificateFiles: ['FAA8130'],
      validityDays: 14,
      paymentTerms: 'Net 30',
      deliveryTerms: 'EXW',
    }),
  });

  expect(createResponse.ok).toBeTruthy();
  const createPayload = await createResponse.json() as {
    data: { id: string; quoteNumber: string };
  };

  const quotationId = createPayload.data.id;
  const quoteNumber = createPayload.data.quoteNumber;

  const submitResponse = await fetch(`${apiBaseUrl}/quotations/${quotationId}/submit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  expect(submitResponse.ok).toBeTruthy();

  const approveResponse = await fetch(`${apiBaseUrl}/quotations/${quotationId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: 'approve',
      comment: 'Playwright E2E approval',
    }),
  });
  expect(approveResponse.ok).toBeTruthy();

  return {
    quotationId,
    quoteNumber,
    token,
  };
}

async function acceptApprovedQuotation(apiBaseUrl: string, token: string, quotationId: string) {
  const acceptResponse = await fetch(`${apiBaseUrl}/quotations/${quotationId}/accept`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      poNumber: `PO-${Date.now()}`,
      deliveryDate: '2026-06-15',
      confirmationNote: 'Playwright API confirmation for failure-path E2E',
    }),
  });

  expect(acceptResponse.ok).toBeTruthy();
  const acceptPayload = await acceptResponse.json() as {
    data: {
      order: { id: string; orderNumber: string };
      contractDocumentId: string;
    };
  };

  return {
    orderId: acceptPayload.data.order.id,
    orderNumber: acceptPayload.data.order.orderNumber,
    contractDocumentId: acceptPayload.data.contractDocumentId,
  };
}

async function loginByUi(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.fill('input[type="email"]', managerUser.email);
  await page.fill('input[type="password"]', managerUser.password);
  await page.click('button[type="submit"]');
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
}

async function navigateFromSidebar(
  page: import('@playwright/test').Page,
  groupLabel: string,
  itemLabel: RegExp,
) {
  const item = page.getByRole('button', { name: itemLabel });
  if (!(await item.isVisible())) {
    await page.getByRole('button', { name: groupLabel, exact: true }).click();
  }
  await item.click();
}

function quoteDetailTitle(quoteNumber: string) {
  return new RegExp(`(?:报价详情|Quote Details)\\s*-\\s*${quoteNumber}`);
}

function orderDetailTitle(orderNumber: string) {
  return new RegExp(`(?:订单详情|Order Details)\\s*-\\s*${orderNumber}`);
}

async function expectToast(page: import('@playwright/test').Page, message: string | RegExp) {
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: message }).last();
  await expect(toast).toBeVisible();
}

test('should confirm an approved quotation and download the generated contract from Orders', async ({ page }) => {
  const { quotationId, quoteNumber } = await createApprovedQuotation(backendBaseUrl);

  await loginByUi(page);

  await test.step('在报价页定位新报价并执行客户确认', async () => {
    await navigateFromSidebar(page, '寻源报价', /报价管理/);
    await expect(page.getByRole('banner').getByRole('heading', { name: '报价管理' })).toBeVisible();

    await page.getByPlaceholder('搜索报价单号、件号或客户...').fill(quoteNumber);
    const quoteRow = page.locator('table tbody tr').filter({ hasText: quoteNumber }).first();
    await expect(quoteRow).toBeVisible();

    await quoteRow.getByRole('button').first().click();
    const quoteDialog = page.getByRole('dialog');
    await expect(quoteDialog.getByText(quoteDetailTitle(quoteNumber))).toBeVisible();

    await quoteDialog.getByRole('button', { name: /确认客户并生成合同|Confirm Customer & Generate Contract/ }).click();

    const confirmationDialog = page.getByRole('dialog');
    await expect(confirmationDialog.getByText(/客户确认并生成合同|Customer Confirmation & Contract Generation/)).toBeVisible();
    await confirmationDialog.getByPlaceholder(/可选采购单号|Optional PO number/).fill(`PO-${Date.now()}`);
    await confirmationDialog.getByPlaceholder(/记录客户确认报价的方式|Record how the customer confirmed the quotation/).fill('客户电话确认，允许系统自动生成合同并创建订单。');

    const acceptResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/quotations/${quotationId}/accept`) &&
      response.status() === 200
    );
    const initialContractDownloadPromise = page.waitForResponse((response) =>
      response.request().method() === 'GET' &&
      /\/api\/documents\/[^/]+\/pdf$/.test(response.url()) &&
      response.status() === 200
    );

    await confirmationDialog.getByRole('button', { name: /确认并生成合同|Confirm & Generate Contract/ }).click();

    const acceptResponse = await acceptResponsePromise;
    const acceptPayload = await acceptResponse.json() as {
      data: {
        status: string;
        order: { orderNumber: string };
        contractDocumentId: string;
      };
    };
    const initialContractDownload = await initialContractDownloadPromise;

    expect(acceptPayload.data.status).toBe('accepted');
    expect(initialContractDownload.status()).toBe(200);
    await expectToast(page, new RegExp(`客户确认已记录，合同已生成：${quoteNumber}。|Customer confirmation recorded\\. Contract generated for ${quoteNumber}\\.`));

    await expect(quoteRow).toContainText('已接受');

    const { contractDocumentId, order } = acceptPayload.data;
    const { orderNumber } = order;

    await test.step('在订单页打开新订单并再次下载合同', async () => {
      await navigateFromSidebar(page, '订单与库存', /订单管理/);
      await expect(page.getByRole('banner').getByRole('heading', { name: '订单管理' })).toBeVisible();

      await page.getByPlaceholder('搜索订单号、件号或客户...').fill(orderNumber);
      const orderRow = page.locator('table tbody tr').filter({ hasText: orderNumber }).first();
      await expect(orderRow).toBeVisible();

      await orderRow.getByRole('button').first().click();
      const orderDialog = page.getByRole('dialog');
      await expect(orderDialog.getByText(orderDetailTitle(orderNumber))).toBeVisible();

      const orderDownloadResponsePromise = page.waitForResponse((response) =>
        response.request().method() === 'GET' &&
        response.url().includes(`/api/documents/${contractDocumentId}/pdf`) &&
        response.status() === 200
      );

      await orderDialog.getByRole('button', { name: /下载合同|Download Contract/ }).click();
      const orderDownloadResponse = await orderDownloadResponsePromise;

      expect(orderDownloadResponse.status()).toBe(200);
      expect(orderDownloadResponse.headers()['content-type']).toContain('application/pdf');
      await orderDialog.getByRole('button', { name: /关闭|Close/ }).first().click();
    });
  });
});

test('should show a retryable error banner when quotation details fail to load', async ({ page }) => {
  const { quotationId, quoteNumber } = await createApprovedQuotation(backendBaseUrl);
  let remainingFailures = 1;

  await loginByUi(page);
  await navigateFromSidebar(page, '寻源报价', /报价管理/);
  await expect(page.getByRole('banner').getByRole('heading', { name: '报价管理' })).toBeVisible();

  await page.route(`**/api/quotations/${quotationId}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    if (remainingFailures > 0) {
      remainingFailures -= 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          message: 'forced quotation detail load failure',
        }),
      });
      return;
    }

    await route.continue();
  });

  await page.getByPlaceholder('搜索报价单号、件号或客户...').fill(quoteNumber);
  const quoteRow = page.locator('table tbody tr').filter({ hasText: quoteNumber }).first();
  await expect(quoteRow).toBeVisible();

  await quoteRow.getByRole('button').first().click();
  const quoteDialog = page.getByRole('dialog');
  await expect(quoteDialog.getByText(quoteDetailTitle(quoteNumber))).toBeVisible();

  const errorBanner = quoteDialog.getByRole('alert').filter({ hasText: '报价详情加载失败' });
  await expect(errorBanner).toBeVisible();
  await expect(errorBanner).toContainText('当前展示的报价详情可能不是最新，请重试。');

  const retryResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'GET' &&
    response.url().includes(`/api/quotations/${quotationId}`) &&
    response.status() === 200
  );
  await errorBanner.getByRole('button', { name: '重试加载' }).click();
  await retryResponsePromise;

  await expect(errorBanner).toHaveCount(0);
  await quoteDialog.getByRole('button', { name: /关闭|Close/ }).first().click();
});

test('should show an alert and keep the quotation approved when confirmation request fails', async ({ page }) => {
  const { quotationId, quoteNumber } = await createApprovedQuotation(backendBaseUrl);

  await loginByUi(page);
  await navigateFromSidebar(page, '寻源报价', /报价管理/);
  await expect(page.getByRole('banner').getByRole('heading', { name: '报价管理' })).toBeVisible();

  await page.getByPlaceholder('搜索报价单号、件号或客户...').fill(quoteNumber);
  const quoteRow = page.locator('table tbody tr').filter({ hasText: quoteNumber }).first();
  await expect(quoteRow).toBeVisible();

  await quoteRow.getByRole('button').first().click();
  const quoteDialog = page.getByRole('dialog');
  await expect(quoteDialog.getByText(quoteDetailTitle(quoteNumber))).toBeVisible();
  await quoteDialog.getByRole('button', { name: /确认客户并生成合同|Confirm Customer & Generate Contract/ }).click();

  const confirmationDialog = page.getByRole('dialog');
  await expect(confirmationDialog.getByText(/客户确认并生成合同|Customer Confirmation & Contract Generation/)).toBeVisible();
  await confirmationDialog.getByPlaceholder(/可选采购单号|Optional PO number/).fill(`PO-${Date.now()}`);
  await confirmationDialog.getByPlaceholder(/记录客户确认报价的方式|Record how the customer confirmed the quotation/).fill('模拟接口失败，验证前端错误提示。');

  await page.route(`**/api/quotations/${quotationId}/accept`, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        message: 'forced accept failure',
      }),
    });
  });

  await confirmationDialog.getByRole('button', { name: /确认并生成合同|Confirm & Generate Contract/ }).click();
  await expectToast(page, /确认报价失败，请重试。|Failed to confirm quote\. Please try again\./);

  await expect(confirmationDialog.getByText(/客户确认并生成合同|Customer Confirmation & Contract Generation/)).toBeVisible();
  await confirmationDialog.getByRole('button', { name: /取消|Cancel/ }).click();
  await expect(quoteRow).toContainText('已审批');
});

test('should show a localized alert when contract download fails in Orders page', async ({ page }) => {
  const token = await loginToApi(backendBaseUrl);
  const { quotationId } = await createApprovedQuotation(backendBaseUrl, token);
  const { orderNumber, contractDocumentId } = await acceptApprovedQuotation(backendBaseUrl, token, quotationId);

  await loginByUi(page);
  await navigateFromSidebar(page, '订单与库存', /订单管理/);
  await expect(page.getByRole('banner').getByRole('heading', { name: '订单管理' })).toBeVisible();

  await page.getByPlaceholder('搜索订单号、件号或客户...').fill(orderNumber);
  const orderRow = page.locator('table tbody tr').filter({ hasText: orderNumber }).first();
  await expect(orderRow).toBeVisible();

  await orderRow.getByRole('button').first().click();
  const orderDialog = page.getByRole('dialog');
  await expect(orderDialog.getByText(orderDetailTitle(orderNumber))).toBeVisible();

  await page.route(`**/api/documents/${contractDocumentId}/pdf`, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        message: 'forced pdf download failure',
      }),
    });
  });

  await orderDialog.getByRole('button', { name: /下载合同|Download Contract/ }).click();
  await expectToast(page, /下载合同失败。|Failed to download contract\./);

  await expect(orderDialog.getByText(orderDetailTitle(orderNumber))).toBeVisible();
  await orderDialog.getByRole('button', { name: /关闭|Close/ }).first().click();
});

test('should show a retryable error banner when order details fail to load', async ({ page }) => {
  const token = await loginToApi(backendBaseUrl);
  const { quotationId } = await createApprovedQuotation(backendBaseUrl, token);
  const { orderId, orderNumber } = await acceptApprovedQuotation(backendBaseUrl, token, quotationId);
  let remainingFailures = 1;

  await loginByUi(page);
  await navigateFromSidebar(page, '订单与库存', /订单管理/);
  await expect(page.getByRole('banner').getByRole('heading', { name: '订单管理' })).toBeVisible();

  await page.route(`**/api/orders/${orderId}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    if (remainingFailures > 0) {
      remainingFailures -= 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          message: 'forced order detail load failure',
        }),
      });
      return;
    }

    await route.continue();
  });

  await page.getByPlaceholder('搜索订单号、件号或客户...').fill(orderNumber);
  const orderRow = page.locator('table tbody tr').filter({ hasText: orderNumber }).first();
  await expect(orderRow).toBeVisible();

  await orderRow.getByRole('button').first().click();
  const orderDialog = page.getByRole('dialog');
  await expect(orderDialog.getByText(orderDetailTitle(orderNumber))).toBeVisible();

  const errorBanner = orderDialog.getByRole('alert').filter({ hasText: '订单详情加载失败' });
  await expect(errorBanner).toBeVisible();
  await expect(errorBanner).toContainText('当前展示的订单详情可能不是最新，请重试。');

  const retryResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'GET' &&
    response.url().includes(`/api/orders/${orderId}`) &&
    response.status() === 200
  );
  await errorBanner.getByRole('button', { name: '重试加载' }).click();
  await retryResponsePromise;

  await expect(errorBanner).toHaveCount(0);
  await orderDialog.getByRole('button', { name: /关闭|Close/ }).first().click();
});

test('should show an alert and keep the quotation approved when send quote request fails', async ({ page }) => {
  const { quotationId, quoteNumber } = await createApprovedQuotation(backendBaseUrl);

  await loginByUi(page);
  await navigateFromSidebar(page, '寻源报价', /报价管理/);
  await expect(page.getByRole('banner').getByRole('heading', { name: '报价管理' })).toBeVisible();

  await page.getByPlaceholder('搜索报价单号、件号或客户...').fill(quoteNumber);
  const quoteRow = page.locator('table tbody tr').filter({ hasText: quoteNumber }).first();
  await expect(quoteRow).toBeVisible();

  await page.route(`**/api/quotations/${quotationId}/send`, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        message: 'forced send failure',
      }),
    });
  });

  await quoteRow.getByRole('button').nth(1).click();
  const sendDialog = page.getByRole('dialog');
  await expect(sendDialog.getByRole('heading', { name: /发送报价邮件|Send Quote Email/ })).toBeVisible();

  await sendDialog.getByRole('button', { name: /发送并附 PDF|Send with PDF/ }).click();
  await expectToast(page, 'Failed to send quote. Please verify the default outbound email account.');

  await expect(sendDialog.getByRole('heading', { name: /发送报价邮件|Send Quote Email/ })).toBeVisible();
  await sendDialog.getByRole('button', { name: /取消|Cancel/ }).click();
  await expect(quoteRow).toContainText('已审批');
});

test('should show a retryable error banner when quotation list refresh fails after sending a quote', async ({ page }) => {
  const { quotationId, quoteNumber } = await createApprovedQuotation(backendBaseUrl);
  let shouldProjectSentState = false;
  let failNextProjectedRefresh = false;

  await loginByUi(page);
  await navigateFromSidebar(page, '寻源报价', /报价管理/);
  await expect(page.getByRole('banner').getByRole('heading', { name: '报价管理' })).toBeVisible();

  await page.route(`**/api/quotations/${quotationId}/send`, async (route) => {
    shouldProjectSentState = true;
    failNextProjectedRefresh = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: quotationId,
          status: 'sent',
        },
      }),
    });
  });

  await page.route('**/api/quotations*', async (route) => {
    const requestUrl = new URL(route.request().url());
    const isActiveQuotationList = requestUrl.searchParams.get('search') === quoteNumber;
    if (!shouldProjectSentState || route.request().method() !== 'GET' || !isActiveQuotationList) {
      // This broad matcher is registered after the send-specific matcher.
      // Fall back so Playwright can run that earlier handler instead of
      // bypassing the controlled response with a real network request.
      await route.fallback();
      return;
    }

    if (failNextProjectedRefresh) {
      failNextProjectedRefresh = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          message: 'forced quotation refresh failure',
        }),
      });
      return;
    }

    const response = await route.fetch();
    const payload = await response.json() as {
      success: boolean;
      data: Array<Record<string, unknown>>;
      pagination?: Record<string, unknown>;
    };

    await route.fulfill({
      response,
      json: {
        ...payload,
        data: payload.data.map((item) => item.id === quotationId
          ? {
            ...item,
            status: 'sent',
            sentAt: new Date().toISOString(),
          }
          : item),
      },
    });
  });

  await page.route(`**/api/quotations/${quotationId}`, async (route) => {
    if (!shouldProjectSentState || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    const response = await route.fetch();
    const payload = await response.json() as {
      success: boolean;
      data: Record<string, unknown>;
    };

    await route.fulfill({
      response,
      json: {
        ...payload,
        data: {
          ...payload.data,
          status: 'sent',
          sentAt: new Date().toISOString(),
        },
      },
    });
  });

  await page.getByPlaceholder('搜索报价单号、件号或客户...').fill(quoteNumber);
  const quoteRow = page.locator('table tbody tr').filter({ hasText: quoteNumber }).first();
  await expect(quoteRow).toBeVisible();

  await quoteRow.getByRole('button').nth(1).click();
  const sendDialog = page.getByRole('dialog');
  await expect(sendDialog.getByRole('heading', { name: /发送报价邮件|Send Quote Email/ })).toBeVisible();

  await sendDialog.getByRole('button', { name: /发送并附 PDF|Send with PDF/ }).click();
  await expectToast(page, new RegExp(`Quote ${quoteNumber} sent to`));

  const errorBanner = page.getByRole('alert').filter({ hasText: '报价列表刷新失败' });
  await expect(errorBanner).toBeVisible();
  await expect(errorBanner).toContainText('当前显示的数据可能不是最新，请重试。');
  await expect(quoteRow).toContainText('已审批');

  await errorBanner.getByRole('button', { name: '重试刷新' }).click();

  await expect(errorBanner).toHaveCount(0);
  await expect(quoteRow).toContainText('已发送');
});

test('should show a localized alert and keep the quotation approved when quotation pdf download fails', async ({ page }) => {
  const { quotationId, quoteNumber } = await createApprovedQuotation(backendBaseUrl);

  await loginByUi(page);
  await navigateFromSidebar(page, '寻源报价', /报价管理/);
  await expect(page.getByRole('banner').getByRole('heading', { name: '报价管理' })).toBeVisible();

  await page.getByPlaceholder('搜索报价单号、件号或客户...').fill(quoteNumber);
  const quoteRow = page.locator('table tbody tr').filter({ hasText: quoteNumber }).first();
  await expect(quoteRow).toBeVisible();

  await page.route(`**/api/quotations/${quotationId}/pdf`, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        message: 'forced quotation pdf failure',
      }),
    });
  });

  await quoteRow.getByRole('button').last().click();
  await expectToast(page, /下载报价 PDF 失败。|Failed to download quotation PDF\./);

  await expect(quoteRow).toContainText('已审批');
});

test('should show an alert and keep the quotation sent when withdraw request fails', async ({ page }) => {
  const { quotationId, quoteNumber } = await createApprovedQuotation(backendBaseUrl);
  let shouldMockSentState = false;

  await loginByUi(page);
  await navigateFromSidebar(page, '寻源报价', /报价管理/);
  await expect(page.getByRole('banner').getByRole('heading', { name: '报价管理' })).toBeVisible();

  await page.route(`**/api/quotations/${quotationId}/send`, async (route) => {
    shouldMockSentState = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: quotationId,
          status: 'sent',
        },
      }),
    });
  });

  await page.route('**/api/quotations*', async (route) => {
    if (!shouldMockSentState || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    const response = await route.fetch();
    const payload = await response.json() as {
      success: boolean;
      data: Array<Record<string, unknown>>;
      pagination?: Record<string, unknown>;
    };

    await route.fulfill({
      response,
      json: {
        ...payload,
        data: payload.data.map((item) => item.id === quotationId
          ? {
            ...item,
            status: 'sent',
            sentAt: new Date().toISOString(),
          }
          : item),
      },
    });
  });

  await page.route(`**/api/quotations/${quotationId}`, async (route) => {
    if (!shouldMockSentState || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    const response = await route.fetch();
    const payload = await response.json() as {
      success: boolean;
      data: Record<string, unknown>;
    };

    await route.fulfill({
      response,
      json: {
        ...payload,
        data: {
          ...payload.data,
          status: 'sent',
          sentAt: new Date().toISOString(),
        },
      },
    });
  });

  await page.getByPlaceholder('搜索报价单号、件号或客户...').fill(quoteNumber);
  const quoteRow = page.locator('table tbody tr').filter({ hasText: quoteNumber }).first();
  await expect(quoteRow).toBeVisible();

  await quoteRow.getByRole('button').nth(1).click();
  const sendDialog = page.getByRole('dialog');
  await expect(sendDialog.getByRole('heading', { name: /发送报价邮件|Send Quote Email/ })).toBeVisible();

  await sendDialog.getByRole('button', { name: /发送并附 PDF|Send with PDF/ }).click();
  await expectToast(page, new RegExp(`Quote ${quoteNumber} sent to`));

  await expect(quoteRow).toContainText('已发送');

  await quoteRow.getByRole('button').first().click();
  const quoteDialog = page.getByRole('dialog');
  await expect(quoteDialog.getByText(quoteDetailTitle(quoteNumber))).toBeVisible();
  await quoteDialog.getByRole('button', { name: /撤回报价|Withdraw Quote/ }).click();

  const withdrawDialog = page.getByRole('dialog');
  await expect(withdrawDialog.getByRole('heading', { name: /撤回报价|Withdraw Quote/ })).toBeVisible();
  await withdrawDialog.locator('textarea').fill('模拟撤回接口失败，验证前端错误提示。');

  await page.route(`**/api/quotations/${quotationId}/withdraw`, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        message: 'forced withdraw failure',
      }),
    });
  });

  await withdrawDialog.getByRole('button', { name: /撤回报价|Withdraw Quote/ }).click();
  await expectToast(page, 'Failed to withdraw quote.');

  await expect(withdrawDialog.getByText(/发送撤回通知|Send withdrawal notice/)).toBeVisible();
  await withdrawDialog.getByRole('button', { name: /取消|Cancel/ }).click();
  await expect(quoteRow).toContainText('已发送');
});
