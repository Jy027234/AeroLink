import fs from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';

type InquiryFixture = {
  alice: { email: string };
  bob: { email: string };
  customer: { id: string };
  suppliers: Array<{ id: string; name: string }>;
};

type RfqLine = { id: string };
type RfqResponse = { id: string; partNumber: string; lines?: RfqLine[] };
type InquiryResponse = {
  id: string;
  rfqId: string | null;
  notes: string | null;
  status: string;
  items: Array<{ rfqLineId: string | null }>;
};

const fixturePath = process.env.AEROLINK_INQUIRY_FIXTURE;
const e2ePassword = process.env.E2E_PASSWORD;
const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN || `http://127.0.0.1:${process.env.PLAYWRIGHT_BACKEND_PORT || '3000'}`;
const apiBase = `${apiOrigin}/api`;
const webBase = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PLAYWRIGHT_FRONTEND_PORT || '5173'}`;

if (!e2ePassword) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

// The ordinary E2E batch runs against server/seed.ts. A disposable fixture may
// override these IDs and users, but credentials always come from E2E_PASSWORD.
const describeInquiryAcceptance = test.describe;

function readFixture(): InquiryFixture {
  if (fixturePath) return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as InquiryFixture;
  return {
    alice: { email: 'sales-test@aerolink.com' },
    bob: { email: 'test-sales-peer@aerolink.com' },
    customer: { id: 'c001' },
    suppliers: [
      { id: 's001', name: 'Aviation Parts Inc.' },
      { id: 's002', name: 'Global Aero Supply' },
    ],
  };
}

function fixturePassword() {
  return e2ePassword;
}

async function jsonRequest<T>(
  request: APIRequestContext,
  path: string,
  options: Parameters<APIRequestContext['fetch']>[1] = {},
) {
  const response = await request.fetch(path.replace(/^\//, ''), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json() as T;
  return { response, body };
}

describeInquiryAcceptance('RFQ lines and inquiry provenance', () => {
  test.describe.configure({ mode: 'serial' });

  let fixture: InquiryFixture;
  let api: APIRequestContext;
  let ownerToken: string;
  let nonOwnerToken: string;
  let primaryRfq: RfqResponse;
  let secondaryRfq: RfqResponse;
  let inquiryDrafts: InquiryResponse[];
  let inquiryBody: { rfqId: string; supplierIds: string[]; lineIds: string[]; notes: string };
  let idempotencyKey: string;

  async function login(email: string) {
    const { response, body } = await jsonRequest<{ data: { token: string } }>(api, '/auth/login', {
      method: 'POST',
        data: { email, password: fixturePassword() },
    });
    expect(response.status()).toBe(200);
    return body.data.token;
  }

  function auth(token: string, headers: Record<string, string> = {}) {
    return { Authorization: `Bearer ${token}`, ...headers };
  }

  test.beforeAll(async ({ playwright }) => {
    fixture = readFixture();
    api = await playwright.request.newContext({ baseURL: `${apiBase}/` });
    ownerToken = await login(fixture.alice.email);
    nonOwnerToken = await login(fixture.bob.email);

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createRfq = async (partNumber: string, key: string) => {
      const { response, body } = await jsonRequest<{ data: RfqResponse }>(api, '/rfqs', {
        method: 'POST',
        headers: auth(ownerToken, { 'Idempotency-Key': key }),
        data: {
          customerId: fixture.customer.id,
          partNumber,
          quantity: 4,
          requiredDate: '2027-01-15',
          urgency: 'STANDARD',
          notes: 'synthetic inquiry source-lines acceptance',
        },
      });
      expect(response.status()).toBe(201);
      expect(body.data.lines).toHaveLength(1);
      return body.data;
    };

    primaryRfq = await createRfq(`E2E-SOURCE-LINE-PRIMARY-${suffix}`, `e2e-source-rfq-primary-${suffix}`);
    secondaryRfq = await createRfq(`E2E-SOURCE-LINE-SECONDARY-${suffix}`, `e2e-source-rfq-secondary-${suffix}`);
    const primaryLineId = primaryRfq.lines?.[0]?.id;
    const secondaryLineId = secondaryRfq.lines?.[0]?.id;
    expect(primaryLineId).toBeTruthy();
    expect(secondaryLineId).toBeTruthy();

    inquiryBody = {
      rfqId: primaryRfq.id,
      supplierIds: fixture.suppliers.map((supplier) => supplier.id),
      lineIds: [primaryLineId as string],
      notes: 'synthetic persisted source line note',
    };
    idempotencyKey = `e2e-source-inquiry-${suffix}`;
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('creates drafts with RFQ and line provenance', async () => {
    const { response, body } = await jsonRequest<{ data: InquiryResponse[] }>(api, '/inquiries', {
      method: 'POST',
      headers: auth(ownerToken, { 'Idempotency-Key': idempotencyKey }),
      data: inquiryBody,
    });

    expect(response.status()).toBe(201);
    inquiryDrafts = body.data;
    expect(inquiryDrafts).toHaveLength(inquiryBody.supplierIds.length);
    expect(inquiryDrafts.every((inquiry) =>
      inquiry.rfqId === inquiryBody.rfqId
      && inquiry.notes === inquiryBody.notes
      && inquiry.status === 'draft'
      && inquiry.items.length === 1
      && inquiry.items[0]?.rfqLineId === inquiryBody.lineIds[0]
    )).toBe(true);
  });

  test('replays the same Idempotency-Key without creating another draft', async () => {
    const replay = await jsonRequest<{ data: InquiryResponse[] }>(api, '/inquiries', {
      method: 'POST',
      headers: auth(ownerToken, { 'Idempotency-Key': idempotencyKey }),
      data: inquiryBody,
    });
    expect(replay.response.status()).toBe(201);
    expect(replay.response.headers()['idempotency-replayed']).toBe('true');
    expect(replay.body.data.map((inquiry) => inquiry.id)).toEqual(inquiryDrafts.map((inquiry) => inquiry.id));

    const list = await jsonRequest<{ data: InquiryResponse[] }>(api, '/inquiries', {
      headers: auth(ownerToken),
    });
    expect(list.body.data.filter((inquiry) => inquiry.rfqId === primaryRfq.id)).toHaveLength(inquiryDrafts.length);
  });

  test('rejects a line belonging to another RFQ before creating a draft', async () => {
    const secondaryLineId = secondaryRfq.lines?.[0]?.id;
    const result = await jsonRequest<{ code?: string }>(api, '/inquiries', {
      method: 'POST',
      headers: auth(ownerToken, { 'Idempotency-Key': `${idempotencyKey}-cross-rfq` }),
      data: { ...inquiryBody, supplierIds: [inquiryBody.supplierIds[0]], lineIds: [secondaryLineId] },
    });
    expect(result.response.status()).toBe(400);
    expect(result.body.code).toBe('INVALID_RFQ_LINE');
  });

  test('blocks a non-owner from reading or creating against the RFQ', async () => {
    const rfqRead = await api.get(`rfqs/${primaryRfq.id}`, { headers: auth(nonOwnerToken) });
    expect([403, 404]).toContain(rfqRead.status());

    const create = await jsonRequest<{ code?: string }>(api, '/inquiries', {
      method: 'POST',
      headers: auth(nonOwnerToken, { 'Idempotency-Key': `${idempotencyKey}-non-owner` }),
      data: inquiryBody,
    });
    expect([403, 404]).toContain(create.response.status());

    const inquiryRead = await api.get(`inquiries/${inquiryDrafts[0]?.id}`, { headers: auth(nonOwnerToken) });
    expect([403, 404]).toContain(inquiryRead.status());
  });

  test('keeps DRAFT after the manual-send 409', async () => {
    const draftId = inquiryDrafts[0]?.id;
    const send = await api.post(`inquiries/${draftId}/send`, {
      headers: auth(ownerToken),
      data: {},
    });
    expect(send.status()).toBe(409);
    const sendBody = await send.json() as { code?: string };
    expect(sendBody.code).toBe('MANUAL_WORKFLOW_REQUIRED');

    const afterSend = await api.get(`inquiries/${draftId}`, { headers: auth(ownerToken) });
    expect(afterSend.status()).toBe(200);
    const afterSendBody = await afterSend.json() as { data: InquiryResponse };
    expect(afterSendBody.data.status).toBe('draft');
  });

  test('creates a Sourcing draft in the browser and states that it has not been sent', async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    await page.goto(webBase);
    await page.locator('#email').fill(fixture.alice.email);
    await page.locator('#password').fill(fixturePassword());
    await page.locator('form button[type="submit"]').click();
    await page.waitForTimeout(1200);
    await page.goto(`${webBase}/sourcing`);
    await page.getByPlaceholder('搜索需求单号、件号或客户...').fill(primaryRfq.partNumber);
    await expect(page.getByText(primaryRfq.partNumber, { exact: true })).toBeVisible();

    await page.locator('tr').filter({ hasText: primaryRfq.partNumber }).first().click();
    await page.locator('[class*="cursor-pointer"]').filter({ hasText: fixture.suppliers[0].name }).first().click();
    await page.getByRole('button', { name: /建立询价草稿/ }).click();

    const notSentDescription = page.getByText('保存已选供应商的询价草稿。请核对后人工联系供应商，草稿尚未发送。', { exact: true });
    await expect(notSentDescription).toBeVisible();
    await page.screenshot({ path: process.env.AEROLINK_INQUIRY_SCREENSHOT || testInfo.outputPath('sourcing-draft-dialog.png'), fullPage: true });
    await page.getByPlaceholder('填写询价备注...').fill('browser synthetic source-lines draft');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByText('加载失败')).toHaveCount(0);
    await expect(page.getByText('Failed to load')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
