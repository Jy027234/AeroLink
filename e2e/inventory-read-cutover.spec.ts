import { expect, test } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

const backendBaseUrl = `${process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000'}/api`;
const partNumber = 'E2E-INVENTORY-READ-CUTOVER-001';

type ApiEnvelope<T> = {
  success: boolean;
  data: T;
};

async function login() {
  const response = await fetch(`${backendBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'zhang@aerolink.com', password: E2E_PASSWORD }),
  });
  expect(response.ok).toBeTruthy();
  const payload = await response.json() as ApiEnvelope<{ token: string }>;
  return payload.data.token;
}

function mutationHeaders(token: string, idempotencyKey: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  };
}

test('serves protected inventory-dependent reads from canonical item/detail data', async () => {
  const unauthenticatedReads = await Promise.all([
    fetch(`${backendBaseUrl}/reports/summary`),
    fetch(`${backendBaseUrl}/pricing-bi/market-intelligence`),
    fetch(`${backendBaseUrl}/fmv/${encodeURIComponent(partNumber)}?conditionCode=SV`),
    fetch(`${backendBaseUrl}/shipment-tracking/customs-risks`),
    fetch(`${backendBaseUrl}/exchange-vmi/restock-suggestions`),
  ]);
  for (const response of unauthenticatedReads) {
    expect(response.status).toBe(401);
  }

  const managerToken = await login();
  const receiptResponse = await fetch(`${backendBaseUrl}/inventory`, {
    method: 'POST',
    headers: mutationHeaders(managerToken, `e2e-inventory-read-receipt-${Date.now()}`),
    body: JSON.stringify({
      partNumber,
      description: 'Canonical inventory reader regression item',
      partCategory: 'ROTABLE',
      trackingType: 'BATCH',
      quantity: 3,
      location: 'E2E-READ-A1',
      warehouse: 'E2E',
      conditionCode: 'SV',
      manufacturer: 'E2E Manufacturer',
      ataChapter: '29',
      hsCode: '8803.30.0010',
      unitCost: 1200,
      notes: 'P1-03 canonical reader regression receipt.',
    }),
  });
  expect(receiptResponse.status).toBe(201);

  const authorization = { Authorization: `Bearer ${managerToken}` };
  const [reportResponse, pricingResponse, fmvResponse, shipmentResponse] = await Promise.all([
    fetch(`${backendBaseUrl}/reports/summary`, { headers: authorization }),
    fetch(`${backendBaseUrl}/pricing-bi/market-intelligence`, { headers: authorization }),
    fetch(`${backendBaseUrl}/fmv/${encodeURIComponent(partNumber)}?conditionCode=SV`, { headers: authorization }),
    fetch(`${backendBaseUrl}/shipment-tracking/customs-risks`, { headers: authorization }),
  ]);

  expect(reportResponse.ok).toBeTruthy();
  const report = await reportResponse.json() as { totalInventoryValue: number };
  expect(report.totalInventoryValue).toBeGreaterThanOrEqual(3600);

  expect(pricingResponse.ok).toBeTruthy();
  const pricing = await pricingResponse.json() as ApiEnvelope<Array<{
    partNumber: string;
    ourPrice: number;
  }>>;
  expect(pricing.data).toEqual(expect.arrayContaining([
    expect.objectContaining({ partNumber, ourPrice: 1200 }),
  ]));

  expect(fmvResponse.ok).toBeTruthy();
  const fmv = await fmvResponse.json() as ApiEnvelope<{ manufacturer?: string }>;
  expect(fmv.data.manufacturer).toBe('E2E Manufacturer');

  expect(shipmentResponse.ok).toBeTruthy();
  const shipmentRisks = await shipmentResponse.json() as ApiEnvelope<Array<{
    partNumber: string;
    hsCode: string;
  }>>;
  expect(shipmentRisks.data).toEqual(expect.arrayContaining([
    expect.objectContaining({ partNumber: '5678-901-234', hsCode: '9026.20.80' }),
  ]));
});
