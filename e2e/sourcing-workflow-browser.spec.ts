import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN || `http://127.0.0.1:${process.env.PLAYWRIGHT_BACKEND_PORT || '3000'}`;
const webBase = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PLAYWRIGHT_FRONTEND_PORT || '5173'}`;
const rfqId = process.env.SOURCING_WORKFLOW_RFQ_ID;
const password = process.env.E2E_PASSWORD;

test.skip(process.env.SOURCING_WORKFLOW_BROWSER !== '1', 'Run only against the disposable sourcing workflow fixture.');

test('persisted mail-to-quote workflow is visible per line and hands a confirmed winner to customer quotation', async ({ request, page }) => {
  expect(['127.0.0.1', 'localhost', '::1']).toContain(new URL(apiOrigin).hostname);
  expect(['127.0.0.1', 'localhost', '::1']).toContain(new URL(webBase).hostname);
  expect(rfqId, 'SOURCING_WORKFLOW_RFQ_ID must name the disposable fixture RFQ').toBeTruthy();
  expect(password, 'E2E_PASSWORD must match only the disposable fixture seed').toBeTruthy();

  const login = await request.post(`${apiOrigin}/api/auth/login`, {
    data: { email: 'sales-test@aerolink.com', password },
  });
  expect(login.status(), await login.text()).toBe(200);
  const token = (await login.json()).data.token as string;
  const authorization = { Authorization: `Bearer ${token}` };

  const comparison = await request.post(`${apiOrigin}/api/supplier-quotes/compare`, {
    headers: authorization,
    data: { rfqId },
  });
  expect(comparison.status(), await comparison.text()).toBe(200);
  const groups = (await comparison.json()).data.lineGroups as Array<{
    rfqLineId: string;
    lineNo: number;
    partNumber: string;
    comparison: { quotes: Array<{ id: string; isWinner: boolean; coversRequiredQuantity: boolean }> };
  }>;
  expect(groups).toHaveLength(3);
  expect(new Set(groups.map((group) => group.rfqLineId)).size).toBe(3);
  expect(groups.every((group) => group.comparison.quotes.length > 0)).toBe(true);
  expect(groups.every((group) => group.comparison.quotes.filter((quote) => quote.isWinner).length === 1)).toBe(true);
  const handoffGroup = groups.find((group) => group.comparison.quotes.some((quote) => quote.isWinner && quote.coversRequiredQuantity));
  expect(handoffGroup, 'fixture must include a full-quantity current winner').toBeTruthy();
  const winner = handoffGroup!.comparison.quotes.find((quote) => quote.isWinner)!;

  const timeline = await request.get(`${apiOrigin}/api/rfqs/${rfqId}/sourcing-timeline`, { headers: authorization });
  expect(timeline.status(), await timeline.text()).toBe(200);
  const timelineData = (await timeline.json()).data as {
    events: Array<{ type: string; originalAiCandidates?: { available: boolean; items: unknown[] } }>;
    lineWorkflowStates: Array<{ rfqLineId: string; status: string; quoteCoverage: {
      activeInquiryItemCount: number; quotedInquiryItemCount: number;
      quantitySufficiencyAssessed: boolean; purchasingCommitted: boolean;
    } }>;
  };
  const events = timelineData.events;
  for (const eventType of ['OUTBOUND_EMAIL', 'INBOUND_EMAIL', 'AI_TASK', 'QUOTE_DRAFT', 'SUPPLIER_QUOTE', 'WINNER_SELECTED']) {
    expect(events.some((event) => event.type === eventType), `missing persisted ${eventType} event`).toBe(true);
  }
  expect(events.some((event) => event.originalAiCandidates?.available && event.originalAiCandidates.items.length > 0)).toBe(true);
  expect(timelineData.lineWorkflowStates).toHaveLength(3);
  expect(timelineData.lineWorkflowStates.every((state) => state.status === 'COMPLETED'
    && state.quoteCoverage.activeInquiryItemCount > 0
    && state.quoteCoverage.activeInquiryItemCount === state.quoteCoverage.quotedInquiryItemCount
    && !state.quoteCoverage.quantitySufficiencyAssessed
    && !state.quoteCoverage.purchasingCommitted)).toBe(true);

  await page.goto(webBase);
  await page.locator('#email').fill('sales-test@aerolink.com');
  await page.locator('#password').fill(password!);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('#email')).toHaveCount(0);

  await page.goto(`${webBase}/sourcing?rfqId=${encodeURIComponent(rfqId!)}&rfqLineId=${encodeURIComponent(handoffGroup!.rfqLineId)}&supplierQuoteId=${encodeURIComponent(winner.id)}`);
  await expect(page.getByRole('region', { name: '寻源业务时间线' })).toBeVisible();
  const line = page.getByRole('region', { name: `需求行 ${handoffGroup!.lineNo} · ${handoffGroup!.partNumber}` });
  await expect(line).toBeVisible();
  await expect(line.getByLabel('需求行寻源阶段')).toContainText('需求项均有正式报价');
  await expect(page.getByRole('region', { name: '寻源业务时间线' }).getByLabel('AI 原始候选建议').first()).toBeVisible();
  await page.reload();
  await expect(line.getByLabel('需求行寻源阶段')).toContainText('需求项均有正式报价');
  await expect(page.getByRole('region', { name: '寻源业务时间线' }).getByLabel('AI 原始候选建议').first()).toBeVisible();
  const quoteRow = page.locator(`[id="sourcing-quote-${winner.id}"]`);
  await expect(quoteRow).toBeVisible();
  await expect(quoteRow.getByText('当前中选', { exact: true })).toBeVisible();
  const handoffLink = quoteRow.getByRole('link', { name: '带入客户报价' });
  await expect(handoffLink).toHaveAttribute('href', `/quotations?rfqId=${encodeURIComponent(rfqId!)}&rfqLineId=${encodeURIComponent(handoffGroup!.rfqLineId)}&supplierQuoteId=${encodeURIComponent(winner.id)}`);
  await handoffLink.click();
  await expect(page).toHaveURL(/\/quotations\?/);
  await expect(page.getByText('已将中选报价带入目标需求行的成本来源；客户售价仍需人工填写并确认。')).toBeVisible();
});

test('controlled inquiry send is restored after a page refresh and only queues a verified outbound record', async ({ request, page }) => {
  expect(['127.0.0.1', 'localhost', '::1']).toContain(new URL(apiOrigin).hostname);
  expect(['127.0.0.1', 'localhost', '::1']).toContain(new URL(webBase).hostname);
  expect(password, 'E2E_PASSWORD must match only the disposable fixture seed').toBeTruthy();
  const login = await request.post(`${apiOrigin}/api/auth/login`, {
    data: { email: 'sales-test@aerolink.com', password },
  });
  expect(login.status(), await login.text()).toBe(200);
  const token = (await login.json()).data.token as string;
  const authorization = { Authorization: `Bearer ${token}` };
  const requiredDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const createdRfq = await request.post(`${apiOrigin}/api/rfqs`, {
    headers: { ...authorization, 'Idempotency-Key': randomUUID() },
    data: {
      customerId: 'c001', urgency: 'STANDARD', notes: 'Disposable controlled-send browser acceptance',
      lines: [{ partNumber: `SWF-SEND-${randomUUID().slice(0, 8)}`, quantity: 1, uom: 'EA',
        conditionCode: 'NE', certificateRequired: false, requiredDate }],
    },
  });
  expect(createdRfq.status(), await createdRfq.text()).toBe(201);
  const rfq = (await createdRfq.json()).data as { id: string; lines: Array<{ id: string; partNumber: string }> };
  expect(rfq.lines).toHaveLength(1);
  const createdInquiry = await request.post(`${apiOrigin}/api/inquiries`, {
    headers: { ...authorization, 'Idempotency-Key': randomUUID() },
    data: { rfqId: rfq.id, supplierIds: ['s001'], lineIds: [rfq.lines[0].id] },
  });
  expect(createdInquiry.status(), await createdInquiry.text()).toBe(201);
  const [inquiry] = (await createdInquiry.json()).data as Array<{ id: string }>;

  await page.goto(webBase);
  await page.locator('#email').fill('sales-test@aerolink.com');
  await page.locator('#password').fill(password!);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('#email')).toHaveCount(0);
  await page.goto(`${webBase}/sourcing?rfqId=${encodeURIComponent(rfq.id)}`);
  await page.getByRole('button', { name: /预览 .* 的询价邮件/ }).click();
  await page.getByRole('button', { name: '保存待确认邮件版本' }).click();
  const pendingTask = page.getByLabel('受控发送任务');
  await expect(pendingTask).toContainText('WAITING_HUMAN');
  const staged = await request.get(`${apiOrigin}/api/sourcing-action-tasks?targetId=${encodeURIComponent(inquiry.id)}`, { headers: authorization });
  expect(staged.status(), await staged.text()).toBe(200);
  const stagedTasks = (await staged.json()).data as Array<{ id: string; status: string }>;
  expect(stagedTasks.filter((task) => task.status === 'WAITING_HUMAN')).toHaveLength(1);

  await page.reload();
  await page.getByRole('button', { name: /预览 .* 的询价邮件/ }).click();
  await expect(page.getByLabel('受控发送任务')).toContainText(stagedTasks[0].id);
  await page.getByRole('button', { name: '确认此版本并入队' }).click();
  await expect(page.getByRole('region', { name: `需求行 1 · ${rfq.lines[0].partNumber}` })).toBeVisible();
  const completed = await request.get(`${apiOrigin}/api/sourcing-action-tasks/${stagedTasks[0].id}`, { headers: authorization });
  expect(completed.status(), await completed.text()).toBe(200);
  const task = (await completed.json()).data as { status: string; outboundEmailId: string; result: { outboundEmailId: string } };
  expect(task.status).toBe('COMPLETED');
  expect(task.outboundEmailId).toBe(task.result.outboundEmailId);
  const inquiryResponse = await request.get(`${apiOrigin}/api/inquiries/${inquiry.id}`, { headers: authorization });
  expect(inquiryResponse.status(), await inquiryResponse.text()).toBe(200);
  const persistedInquiry = (await inquiryResponse.json()).data as { deliveryStatus: string };
  expect(persistedInquiry.deliveryStatus).toBe('queued');
});

test('controlled winner selection resumes after refresh and records one current winner', async ({ request, page }) => {
  expect(rfqId, 'SOURCING_WORKFLOW_RFQ_ID must name the disposable fixture RFQ').toBeTruthy();
  expect(password, 'E2E_PASSWORD must match only the disposable fixture seed').toBeTruthy();
  const login = await request.post(`${apiOrigin}/api/auth/login`, {
    data: { email: 'sales-test@aerolink.com', password },
  });
  expect(login.status(), await login.text()).toBe(200);
  const authorization = { Authorization: `Bearer ${(await login.json()).data.token as string}` };
  const compare = () => request.post(`${apiOrigin}/api/supplier-quotes/compare`, {
    headers: authorization, data: { rfqId },
  });
  const before = await compare();
  expect(before.status(), await before.text()).toBe(200);
  const groups = (await before.json()).data.lineGroups as Array<{
    rfqLineId: string; lineNo: number; partNumber: string;
    comparison: { quotes: Array<{ id: string; isWinner: boolean; comparisonEligibility?: { eligible: boolean } }> };
  }>;
  const group = groups.find((candidate) => candidate.comparison.quotes.some((quote) => !quote.isWinner && quote.comparisonEligibility?.eligible !== false));
  expect(group).toBeTruthy();
  const candidate = group!.comparison.quotes.find((quote) => !quote.isWinner && quote.comparisonEligibility?.eligible !== false)!;

  await page.goto(webBase);
  await page.locator('#email').fill('sales-test@aerolink.com');
  await page.locator('#password').fill(password!);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('#email')).toHaveCount(0);
  const targetUrl = `${webBase}/sourcing?rfqId=${encodeURIComponent(rfqId!)}&rfqLineId=${encodeURIComponent(group!.rfqLineId)}&supplierQuoteId=${encodeURIComponent(candidate.id)}`;
  await page.goto(targetUrl);
  const quoteRow = page.locator(`[id="sourcing-quote-${candidate.id}"]`);
  await quoteRow.getByRole('button', { name: '选为中选供应商' }).click();
  const stageButton = page.getByRole('button', { name: '保存待确认中选任务' });
  if (await stageButton.isVisible()) await stageButton.click();
  const stagedPanel = page.getByText('创建任务不会改变中选；再次确认后服务端将复核报价与需求行版本。');
  await expect(stagedPanel).toBeVisible();
  const taskList = await request.get(`${apiOrigin}/api/sourcing-action-tasks?targetId=${encodeURIComponent(candidate.id)}`, { headers: authorization });
  expect(taskList.status(), await taskList.text()).toBe(200);
  const tasks = (await taskList.json()).data as Array<{ id: string; status: string }>;
  expect(tasks.filter((task) => task.status === 'WAITING_HUMAN')).toHaveLength(1);

  await page.reload();
  await quoteRow.getByRole('button', { name: '选为中选供应商' }).click();
  await expect(page.getByLabel('受控中选任务').getByText(tasks[0].id)).toBeVisible();
  await page.getByRole('button', { name: '确认中选' }).click();
  await expect(page.getByRole('button', { name: '确认中选' })).toHaveCount(0);
  const completed = await request.get(`${apiOrigin}/api/sourcing-action-tasks/${tasks[0].id}`, { headers: authorization });
  expect(completed.status(), await completed.text()).toBe(200);
  const task = (await completed.json()).data as { status: string; result: { supplierQuoteId: string; isWinner: boolean } };
  expect(task.status).toBe('COMPLETED');
  expect(task.result).toMatchObject({ supplierQuoteId: candidate.id, isWinner: true });
  const after = await compare();
  expect(after.status(), await after.text()).toBe(200);
  const afterGroup = ((await after.json()).data.lineGroups as typeof groups).find((entry) => entry.rfqLineId === group!.rfqLineId)!;
  expect(afterGroup.comparison.quotes.filter((quote) => quote.isWinner).map((quote) => quote.id)).toEqual([candidate.id]);
});
