import { expect, test } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

const backendBaseUrl = `${process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000'}/api`;
const partNumber = 'E2E-CANONICAL-CUTOVER-001';

type ApiEnvelope<T> = {
  success: boolean;
  code?: string;
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

test('writes receipts and adjustments only to canonical inventory details', async () => {
  const managerToken = await login();
  const receiptKey = 'e2e-canonical-inventory-receipt-001';
  const receiptBody = {
    partNumber,
    description: 'Canonical cutover regression stock',
    partCategory: 'ROTABLE',
    trackingType: 'BATCH',
    quantity: 4,
    location: 'E2E-CANONICAL-A1',
    warehouse: 'E2E',
    unitCost: 1250,
    notes: 'Canonical inventory receipt regression.',
  };

  const createResponse = await fetch(`${backendBaseUrl}/inventory`, {
    method: 'POST',
    headers: mutationHeaders(managerToken, receiptKey),
    body: JSON.stringify(receiptBody),
  });
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as ApiEnvelope<{
    id: string;
    inventoryItemId: string;
    partNumber: string;
    quantity: number;
    status: string;
  }>;
  expect(created.data).toMatchObject({
    partNumber,
    quantity: 4,
    status: 'AVAILABLE',
  });

  const replayResponse = await fetch(`${backendBaseUrl}/inventory`, {
    method: 'POST',
    headers: mutationHeaders(managerToken, receiptKey),
    body: JSON.stringify(receiptBody),
  });
  expect(replayResponse.status).toBe(201);
  expect(replayResponse.headers.get('Idempotency-Replayed')).toBe('true');
  const replayed = await replayResponse.json() as ApiEnvelope<{ id: string; inventoryItemId: string }>;
  expect(replayed.data).toEqual(expect.objectContaining({
    id: created.data.id,
    inventoryItemId: created.data.inventoryItemId,
  }));

  const listResponse = await fetch(`${backendBaseUrl}/inventory?search=${encodeURIComponent(partNumber)}`, {
    headers: { Authorization: `Bearer ${managerToken}` },
  });
  expect(listResponse.ok).toBeTruthy();
  const listed = await listResponse.json() as ApiEnvelope<Array<{ id: string; inventoryItemId: string; partNumber: string }>>;
  expect(listed.data).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: created.data.id,
      inventoryItemId: created.data.inventoryItemId,
      partNumber,
    }),
  ]));

  const adjustResponse = await fetch(`${backendBaseUrl}/inventory/${created.data.id}`, {
    method: 'PATCH',
    headers: mutationHeaders(managerToken, 'e2e-canonical-inventory-adjustment-001'),
    body: JSON.stringify({ quantity: 7, notes: 'Canonical inventory adjustment regression.' }),
  });
  expect(adjustResponse.status).toBe(200);
  const adjusted = await adjustResponse.json() as ApiEnvelope<{ id: string; quantity: number }>;
  expect(adjusted.data).toEqual(expect.objectContaining({ id: created.data.id, quantity: 7 }));

  const transactionsResponse = await fetch(`${backendBaseUrl}/inventory-transactions/detail/${created.data.id}`, {
    headers: { Authorization: `Bearer ${managerToken}` },
  });
  expect(transactionsResponse.ok).toBeTruthy();
  const transactions = await transactionsResponse.json() as ApiEnvelope<Array<{
    type: string;
    quantity: number;
    beforeQuantity: number;
    afterQuantity: number;
  }>>;
  expect(transactions.data).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'INBOUND', quantity: 4, beforeQuantity: 0, afterQuantity: 4 }),
    expect.objectContaining({ type: 'ADJUSTMENT', quantity: 3, beforeQuantity: 4, afterQuantity: 7 }),
  ]));

  const reconciliationResponse = await fetch(`${backendBaseUrl}/inventory/reconciliation`, {
    headers: { Authorization: `Bearer ${managerToken}` },
  });
  expect(reconciliationResponse.ok).toBeTruthy();
  const reconciliation = await reconciliationResponse.json() as ApiEnvelope<{
    status: string;
    canonicalOnlyDetails: number;
    canonicalOnlyQuantity: number;
  }>;
  expect(reconciliation.data).toMatchObject({ status: 'PASS' });
  expect(reconciliation.data.canonicalOnlyDetails).toBeGreaterThanOrEqual(1);
  expect(reconciliation.data.canonicalOnlyQuantity).toBeGreaterThanOrEqual(7);
});
