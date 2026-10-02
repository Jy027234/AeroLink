import { expect, test } from '@playwright/test';

const apiOrigin = process.env.PLAYWRIGHT_API_ORIGIN || `http://127.0.0.1:${process.env.PLAYWRIGHT_BACKEND_PORT || '3000'}`;
const webBase = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PLAYWRIGHT_FRONTEND_PORT || '5173'}`;
const password = process.env.E2E_PASSWORD;
const isolated = process.env.SOURCING_ISOLATED_ACCEPTANCE === '1';

test.skip(!isolated, 'Run only against a disposable seeded PostgreSQL with SOURCING_ISOLATED_ACCEPTANCE=1.');

test('three demand lines, three suppliers, partial quotes and independent winners', async ({ request, page }) => {
  const hostname = new URL(apiOrigin).hostname;
  expect(['127.0.0.1', 'localhost', '::1']).toContain(hostname);
  expect(password, 'E2E_PASSWORD must match only the disposable seed').toBeTruthy();

  const login = await request.post(`${apiOrigin}/api/auth/login`, {
    data: { email: 'sales-test@aerolink.com', password },
  });
  expect(login.status(), await login.text()).toBe(200);
  const token = (await login.json()).data.token as string;
  const auth = (key?: string) => ({
    Authorization: `Bearer ${token}`,
    ...(key ? { 'Idempotency-Key': key } : {}),
  });
  const post = (path: string, data: unknown, key?: string) => request.post(`${apiOrigin}/api/${path}`, {
    headers: auth(key), data,
  });
  const get = (path: string) => request.get(`${apiOrigin}/api/${path}`, { headers: auth() });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const validUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const partA = `SQ-A-${suffix}`;
  const partB = `SQ-B-${suffix}`;
  const demandLines = [
    { partNumber: partA, quantity: 4, requiredDate: '2027-01-15', uom: 'EA' },
    { partNumber: partB, quantity: 2, requiredDate: '2027-01-15', uom: 'EA' },
    { partNumber: partA, quantity: 1, requiredDate: '2027-01-16', uom: 'EA' },
  ];

  const created = await post('rfqs', {
    customerId: 'c001', urgency: 'STANDARD', lines: demandLines,
    notes: 'Disposable sourcing acceptance; duplicate part numbers are distinct demand lines.',
  }, `sourcing-acceptance-rfq-${suffix}`);
  expect(created.status(), await created.text()).toBe(201);
  const rfq = (await created.json()).data as {
    id: string; lines: Array<{ id: string; partNumber: string; quantity: number }>;
  };
  expect(rfq.lines.map((line) => line.partNumber)).toEqual([partA, partB, partA]);
  expect(new Set(rfq.lines.map((line) => line.id)).size).toBe(3);

  const createInquiry = async (supplierId: string, lineIndexes: number[]) => {
    const body = {
      rfqId: rfq.id,
      supplierIds: [supplierId],
      lineIds: lineIndexes.map((index) => rfq.lines[index].id),
    };
    const key = `sourcing-acceptance-inquiry-${supplierId}-${suffix}`;
    const response = await post('inquiries', body, key);
    expect(response.status(), await response.text()).toBe(201);
    const data = (await response.json()).data as Array<{
      id: string; status: string; items: Array<{ id: string; rfqLineId: string }>;
    }>;
    expect(data).toHaveLength(1);
    expect(data[0].items.map((item) => item.rfqLineId)).toEqual(body.lineIds);
    const replay = await post('inquiries', body, key);
    expect(replay.status()).toBe(201);
    expect((await replay.json()).data[0].id).toBe(data[0].id);
    return data[0];
  };
  const supplierA = await createInquiry('s001', [0, 2]);
  const supplierB = await createInquiry('s002', [1]);
  const supplierC = await createInquiry('s003', [0]);

  // The isolated seed has no email account. A send attempt must not claim success.
  const unsent = await post(`inquiries/${supplierA.id}/send`, {});
  expect(unsent.status()).toBe(409);
  const stillDraft = await get(`inquiries/${supplierA.id}`);
  expect((await stillDraft.json()).data.status).toBe('draft');

  const createQuote = async (
    inquiry: typeof supplierA,
    itemIndex: number,
    supplierId: string,
    lineIndex: number,
    quantity: number,
    unitPrice: number,
  ) => {
    const response = await post('supplier-quotes', {
      rfqId: rfq.id,
      rfqLineId: rfq.lines[lineIndex].id,
      inquiryId: inquiry.id,
      inquiryItemId: inquiry.items[itemIndex].id,
      supplierId,
      partNumber: rfq.lines[lineIndex].partNumber,
      quantity,
      quantityUnit: 'EA',
      unitPrice,
      currency: 'USD',
      leadTimeDays: 7,
      validUntil,
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).data as { id: string; rfqLineId: string };
  };
  const quoteA0 = await createQuote(supplierA, 0, 's001', 0, 4, 110);
  const quoteA2 = await createQuote(supplierA, 1, 's001', 2, 1, 95);
  const quoteB1 = await createQuote(supplierB, 0, 's002', 1, 2, 90);
  const quoteC0 = await createQuote(supplierC, 0, 's003', 0, 2, 80);

  const compare = async (lineIndex: number) => {
    const response = await post('supplier-quotes/compare', { rfqLineId: rfq.lines[lineIndex].id });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).data as {
      quotes: Array<{ id: string; rfqLineId: string; quantityShortfall: number | null; isWinner: boolean;
        comparisonEligibility: { eligible: boolean; reasons: string[] } }>;
      summary: { requiredQuantity: number; remainingQuantityGap: number | null };
    };
  };
  const line0 = await compare(0);
  expect(line0.quotes.map((quote) => quote.id).sort()).toEqual([quoteA0.id, quoteC0.id].sort());
  expect(line0.quotes.find((quote) => quote.id === quoteC0.id)?.quantityShortfall).toBe(2);
  expect((await compare(1)).quotes.map((quote) => quote.id)).toEqual([quoteB1.id]);
  expect((await compare(2)).quotes.map((quote) => quote.id)).toEqual([quoteA2.id]);

  for (const quote of [quoteA0, quoteB1, quoteA2]) {
    const selection = await post(`supplier-quotes/${quote.id}/select-winner`, {});
    expect(selection.status(), await selection.text()).toBe(200);
  }
  for (const [index, winnerId] of [[0, quoteA0.id], [1, quoteB1.id], [2, quoteA2.id]] as const) {
    const result = await compare(index);
    const selected = result.quotes.filter((quote) => quote.isWinner);
    expect(selected.map((quote) => quote.id)).toEqual([winnerId]);
  }

  const createUnusableUnitQuote = async (quantityUnit?: string) => {
    const response = await post('supplier-quotes', {
      rfqId: rfq.id, rfqLineId: rfq.lines[0].id,
      inquiryId: supplierC.id, inquiryItemId: supplierC.items[0].id,
      supplierId: 's003', partNumber: partA, quantity: 4,
      ...(quantityUnit ? { quantityUnit } : {}),
      unitPrice: 50, currency: 'USD', leadTimeDays: 5, validUntil,
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).data.id as string;
  };
  const mismatchedUnitId = await createUnusableUnitQuote('BOX');
  const unknownUnitId = await createUnusableUnitQuote();
  const withUnitRisks = await compare(0);
  expect(withUnitRisks.quotes.find((quote) => quote.id === mismatchedUnitId)?.comparisonEligibility.reasons).toContain('QUANTITY_UNIT_MISMATCH');
  expect(withUnitRisks.quotes.find((quote) => quote.id === unknownUnitId)?.comparisonEligibility.reasons).toContain('QUANTITY_UNIT_UNKNOWN');
  expect((await post(`supplier-quotes/${mismatchedUnitId}/select-winner`, {})).status()).toBe(409);
  expect((await post(`supplier-quotes/${unknownUnitId}/select-winner`, {})).status()).toBe(409);

  const candidatesResponse = await get(`rfqs/${rfq.id}/sourcing-candidates`);
  expect(candidatesResponse.status(), await candidatesResponse.text()).toBe(200);
  const candidateLines = (await candidatesResponse.json()).data.lines as Array<{
    rfqLineId: string; partNumber: string; candidates: Array<{ currentSupplyPromiseVerified: boolean; evidence: Array<{ type: string }> }>;
  }>;
  expect(candidateLines.map((line) => line.rfqLineId)).toEqual(rfq.lines.map((line) => line.id));
  expect(candidateLines.every((line) => line.candidates.every((candidate) => candidate.currentSupplyPromiseVerified === false))).toBe(true);
  expect(candidateLines[0].candidates.some((candidate) => candidate.evidence.some((evidence) => evidence.type === 'HISTORICAL_SUPPLIER_QUOTE'))).toBe(true);

  const secondRfqResponse = await post('rfqs', { customerId: 'c001', urgency: 'STANDARD',
    lines: [{ partNumber: partA, quantity: 1, requiredDate: '2027-01-17', uom: 'EA' }],
  }, `sourcing-acceptance-second-rfq-${suffix}`);
  expect(secondRfqResponse.status(), await secondRfqResponse.text()).toBe(201);
  const secondLineId = (await secondRfqResponse.json()).data.lines[0].id as string;
  const secondComparison = await post('supplier-quotes/compare', { rfqLineId: secondLineId });
  expect(secondComparison.status(), await secondComparison.text()).toBe(200);
  expect((await secondComparison.json()).data.quotes).toHaveLength(0);

  const originalResponse = await get(`supplier-quotes/${quoteA0.id}`);
  expect(originalResponse.status(), await originalResponse.text()).toBe(200);
  const original = (await originalResponse.json()).data as {
    id: string; rfqLineId: string; inquiryItemId: string; supplierId: string;
    updatedAt: string; unitPrice: number; revisionNumber: number;
  };
  const revisionPayload = {
    expectedUpdatedAt: original.updatedAt,
    revisionReason: 'Supplier updated the controlled test quotation',
    description: 'Revised isolated acceptance price',
    quantity: 4,
    quantityUnit: 'EA',
    unitPrice: 105,
    currency: 'USD',
    leadTimeDays: 6,
    validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    notes: 'Second version in disposable database',
  };
  const revisedResponse = await post(`supplier-quotes/${quoteA0.id}/revise`, revisionPayload);
  expect(revisedResponse.status(), await revisedResponse.text()).toBe(201);
  const revised = (await revisedResponse.json()).data as {
    id: string; revisionOfId: string; revisionNumber: number; rfqLineId: string;
    inquiryItemId: string; supplierId: string; isWinner: boolean; unitPrice: number;
  };
  expect(revised.id).not.toBe(quoteA0.id);
  expect(revised.revisionOfId).toBe(quoteA0.id);
  expect(revised.revisionNumber).toBe(original.revisionNumber + 1);
  expect(revised.rfqLineId).toBe(original.rfqLineId);
  expect(revised.inquiryItemId).toBe(original.inquiryItemId);
  expect(revised.supplierId).toBe(original.supplierId);
  expect(revised.isWinner).toBe(false);
  expect(revised.unitPrice).toBe(105);

  const retainedOriginal = await get(`supplier-quotes/${quoteA0.id}`);
  expect(retainedOriginal.status()).toBe(200);
  const retained = (await retainedOriginal.json()).data as { unitPrice: number; supersededAt: string; isWinner: boolean };
  expect(retained.unitPrice).toBe(110);
  expect(retained.supersededAt).toBeTruthy();
  expect(retained.isWinner).toBe(false);
  const afterRevision = await compare(0);
  expect(afterRevision.quotes.map((quote) => quote.id)).not.toContain(quoteA0.id);
  expect(afterRevision.quotes.map((quote) => quote.id)).toContain(revised.id);
  expect((await post(`supplier-quotes/${quoteA0.id}/select-winner`, {})).status()).toBe(409);
  expect((await post(`supplier-quotes/${quoteA0.id}/revise`, revisionPayload)).status()).toBe(409);
  expect((await post(`supplier-quotes/${revised.id}/select-winner`, {})).status()).toBe(200);

  await page.goto(webBase);
  await page.locator('#email').fill('sales-test@aerolink.com');
  await page.locator('#password').fill(password!);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('#email')).toHaveCount(0);
  await page.goto(`${webBase}/supplier-quotes`);
  await page.getByPlaceholder('搜索件号或供应商...').fill(partA);
  const currentRow = page.getByRole('row').filter({ hasText: partA }).filter({ hasText: 'v2' });
  await expect(currentRow).toBeVisible();
  await currentRow.getByRole('button', { name: '修订报价' }).click();
  await page.getByLabel('USD 单价').fill('102');
  await page.getByLabel('修订原因').fill('Second controlled revision from the browser');
  await page.getByRole('button', { name: '创建新版本' }).click();
  await expect(page.getByRole('row').filter({ hasText: partA }).filter({ hasText: 'v3' })).toBeVisible();
});
