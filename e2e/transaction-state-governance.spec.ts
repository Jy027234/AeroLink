import { expect, test } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

const backendBaseUrl = `${process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000'}/api`;

async function login() {
  const response = await fetch(`${backendBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'zhang@aerolink.com',
      password: E2E_PASSWORD,
    }),
  });

  expect(response.ok).toBeTruthy();
  const payload = await response.json() as { data: { token: string } };
  return payload.data.token;
}

test('records RFQ state history and rejects a stale optimistic-lock version', async () => {
  const token = await login();
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const createResponse = await fetch(`${backendBaseUrl}/rfqs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      customerId: 'c001',
      partNumber: `E2E-STATE-${uniqueSuffix}`,
      quantity: 1,
      requiredDate: '2026-08-01',
      urgency: 'STANDARD',
      notes: 'P1-01 status governance E2E record',
    }),
  });
  expect(createResponse.ok).toBeTruthy();
  const created = await createResponse.json() as {
    data: { id: string; status: string; version: number };
  };

  expect(created.data.status).toBe('pending');
  expect(created.data.version).toBe(1);

  const transitionResponse = await fetch(`${backendBaseUrl}/rfqs/${created.data.id}/status`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      status: 'SOURCING',
      version: created.data.version,
      reasonCode: 'E2E_STATE_GOVERNANCE',
      reason: 'Verify auditable optimistic state transition.',
    }),
  });
  expect(transitionResponse.ok).toBeTruthy();
  const transitioned = await transitionResponse.json() as {
    data: { status: string; version: number };
  };

  expect(transitioned.data.status).toBe('sourcing');
  expect(transitioned.data.version).toBe(2);

  const historyResponse = await fetch(`${backendBaseUrl}/rfqs/${created.data.id}/status-history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(historyResponse.ok).toBeTruthy();
  const historyPayload = await historyResponse.json() as {
    data: Array<{
      fromStatus: string | null;
      toStatus: string;
      reasonCode: string;
      actorId: string | null;
      version: number;
      createdAt: string;
    }>;
  };

  expect(historyPayload.data).toEqual(expect.arrayContaining([
    expect.objectContaining({
      fromStatus: null,
      toStatus: 'pending',
      reasonCode: 'RFQ_CREATED',
      version: 1,
    }),
    expect.objectContaining({
      fromStatus: 'pending',
      toStatus: 'sourcing',
      reasonCode: 'E2E_STATE_GOVERNANCE',
      actorId: expect.any(String),
      version: 2,
      createdAt: expect.any(String),
    }),
  ]));

  const staleResponse = await fetch(`${backendBaseUrl}/rfqs/${created.data.id}/status`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      status: 'QUOTING',
      version: created.data.version,
      reasonCode: 'E2E_STALE_RETRY',
    }),
  });
  expect(staleResponse.status).toBe(409);
  const stalePayload = await staleResponse.json() as { code: string };
  expect(stalePayload.code).toBe('STATE_CONFLICT');
});
