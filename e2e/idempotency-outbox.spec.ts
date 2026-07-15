import { expect, test } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

const backendBaseUrl = `${process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000'}/api`;

async function login() {
  const response = await fetch(`${backendBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'zhang@aerolink.com', password: E2E_PASSWORD }),
  });
  expect(response.ok).toBeTruthy();
  const payload = await response.json() as { data: { token: string } };
  return payload.data.token;
}

test('replays a core RFQ creation exactly once for the same Idempotency-Key', async () => {
  const token = await login();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const idempotencyKey = `e2e-rfq-${suffix}`;
  const body = {
    customerId: 'c001',
    partNumber: `E2E-IDEMPOTENCY-${suffix}`,
    quantity: 1,
    requiredDate: '2026-08-01',
    urgency: 'STANDARD',
    notes: 'P1-02 Idempotency-Key replay verification.',
  };
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  };

  const first = await fetch(`${backendBaseUrl}/rfqs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  expect(first.status).toBe(201);
  const firstPayload = await first.json() as { data: { id: string; partNumber: string } };

  const replay = await fetch(`${backendBaseUrl}/rfqs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  expect(replay.status).toBe(201);
  expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
  const replayPayload = await replay.json() as { data: { id: string; partNumber: string } };
  expect(replayPayload.data).toEqual(firstPayload.data);

  const conflict = await fetch(`${backendBaseUrl}/rfqs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, quantity: 2 }),
  });
  expect(conflict.status).toBe(409);
  const conflictPayload = await conflict.json() as { code: string };
  expect(conflictPayload.code).toBe('IDEMPOTENCY_KEY_REUSED');

  const list = await fetch(`${backendBaseUrl}/rfqs?search=${encodeURIComponent(body.partNumber)}&page=1&limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(list.ok).toBeTruthy();
  const listPayload = await list.json() as { data: Array<{ id: string; partNumber: string }> };
  expect(listPayload.data.filter((rfq) => rfq.id === firstPayload.data.id)).toHaveLength(1);
});
