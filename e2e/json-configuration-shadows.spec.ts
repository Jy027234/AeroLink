import { expect, test } from '@playwright/test';

const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!E2E_PASSWORD) throw new Error('E2E_PASSWORD is required for seeded E2E tests.');

const backendBaseUrl = `${process.env.PLAYWRIGHT_API_ORIGIN || 'http://127.0.0.1:3000'}/api`;

type ApiEnvelope<T> = {
  success: boolean;
  data: T;
};

function requestHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function login(email: string) {
  const response = await fetch(`${backendBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: E2E_PASSWORD }),
  });
  expect(response.ok).toBeTruthy();
  const payload = await response.json() as ApiEnvelope<{ token: string }>;
  return payload.data.token;
}

function expectNoJsonShadow(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectNoJsonShadow);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  for (const field of [
    'customHeadersJson',
    'eventTypesJson',
    'filtersJson',
    'requestHeadersJson',
    'filterQueryJson',
    'deliveryIdsJson',
    'contextJson',
    'payloadJson',
    'scopesJson',
  ]) {
    expect(record).not.toHaveProperty(field);
  }
  Object.values(record).forEach(expectNoJsonShadow);
}

test('dual-writes JSON configuration shadows while preserving legacy API contracts', async () => {
  const [managerToken, gmToken] = await Promise.all([
    login('zhang@aerolink.com'),
    login('wang@aerolink.com'),
  ]);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const endpointResponse = await fetch(`${backendBaseUrl}/webhooks/endpoints`, {
    method: 'POST',
    headers: requestHeaders(managerToken),
    body: JSON.stringify({
      name: `JSON shadow ${suffix}`,
      url: 'http://127.0.0.1:9/json-shadow',
      maxRetries: 0,
      customHeaders: { 'X-JSON-Shadow': suffix },
    }),
  });
  expect(endpointResponse.status).toBe(201);
  const endpoint = await endpointResponse.json() as ApiEnvelope<{
    id: string;
    customHeaders: Record<string, string>;
  }>;
  expect(endpoint.data.customHeaders).toEqual({ 'X-JSON-Shadow': suffix });
  expectNoJsonShadow(endpoint.data);

  const subscriptionsResponse = await fetch(`${backendBaseUrl}/webhooks/endpoints/${endpoint.data.id}/subscriptions`, {
    method: 'PUT',
    headers: requestHeaders(managerToken),
    body: JSON.stringify({ eventTypes: ['rfq.created'] }),
  });
  expect(subscriptionsResponse.ok).toBeTruthy();
  const subscriptions = await subscriptionsResponse.json() as ApiEnvelope<unknown>;
  expectNoJsonShadow(subscriptions.data);

  const endpointDetailResponse = await fetch(`${backendBaseUrl}/webhooks/endpoints/${endpoint.data.id}`, {
    headers: requestHeaders(managerToken),
  });
  expect(endpointDetailResponse.ok).toBeTruthy();
  const endpointDetail = await endpointDetailResponse.json() as ApiEnvelope<unknown>;
  expectNoJsonShadow(endpointDetail.data);

  const pingResponse = await fetch(`${backendBaseUrl}/webhooks/endpoints/${endpoint.data.id}/test`, {
    method: 'POST',
    headers: requestHeaders(managerToken),
  });
  expect(pingResponse.ok).toBeTruthy();
  const ping = await pingResponse.json() as ApiEnvelope<{ id: string }>;
  expectNoJsonShadow(ping.data);

  const replayResponse = await fetch(`${backendBaseUrl}/webhooks/phase2/replay/execute`, {
    method: 'POST',
    headers: requestHeaders(managerToken),
    body: JSON.stringify({ deliveryIds: [ping.data.id], concurrency: 1 }),
  });
  expect(replayResponse.ok).toBeTruthy();

  const definitionResponse = await fetch(`${backendBaseUrl}/workflows/definitions`, {
    method: 'POST',
    headers: requestHeaders(managerToken),
    body: JSON.stringify({
      name: `JSON workflow ${suffix}`,
      code: `JSON-WF-${suffix}`,
      entityType: 'RFQ',
      steps: [{ name: 'Manager approval', stepOrder: 1, approverRole: 'MANAGER' }],
    }),
  });
  expect(definitionResponse.status).toBe(201);
  const definition = await definitionResponse.json() as ApiEnvelope<{ id: string }>;

  const instanceResponse = await fetch(`${backendBaseUrl}/workflows/instances`, {
    method: 'POST',
    headers: requestHeaders(managerToken),
    body: JSON.stringify({
      definitionId: definition.data.id,
      entityType: 'RFQ',
      entityId: `json-rfq-${suffix}`,
      context: { source: 'json-shadow-e2e', nested: { suffix } },
    }),
  });
  expect(instanceResponse.status).toBe(201);
  const instance = await instanceResponse.json() as ApiEnvelope<{ id: string }>;
  expectNoJsonShadow(instance.data);

  const approveResponse = await fetch(`${backendBaseUrl}/workflows/instances/${instance.data.id}/approve`, {
    method: 'POST',
    headers: requestHeaders(managerToken),
    body: JSON.stringify({ comment: 'Approved in JSON shadow E2E.', payload: { source: 'json-shadow-e2e' } }),
  });
  expect(approveResponse.ok).toBeTruthy();
  const approved = await approveResponse.json() as ApiEnvelope<unknown>;
  expectNoJsonShadow(approved.data);

  const apiKeyResponse = await fetch(`${backendBaseUrl}/api-keys`, {
    method: 'POST',
    headers: requestHeaders(gmToken),
    body: JSON.stringify({ name: `JSON API key ${suffix}`, scopes: ['read', 'write'] }),
  });
  expect(apiKeyResponse.ok).toBeTruthy();
  const apiKey = await apiKeyResponse.json() as ApiEnvelope<{ id: string; scopes: string[] }>;
  expect(apiKey.data.scopes).toEqual(['read', 'write']);
  expectNoJsonShadow(apiKey.data);

  const apiKeyUpdateResponse = await fetch(`${backendBaseUrl}/api-keys/${apiKey.data.id}`, {
    method: 'PUT',
    headers: requestHeaders(gmToken),
    body: JSON.stringify({ scopes: ['read', 'admin'] }),
  });
  expect(apiKeyUpdateResponse.ok).toBeTruthy();
  const updatedApiKey = await apiKeyUpdateResponse.json() as ApiEnvelope<{ scopes: string[] }>;
  expect(updatedApiKey.data.scopes).toEqual(['read', 'admin']);
  expectNoJsonShadow(updatedApiKey.data);

  const apiKeyListResponse = await fetch(`${backendBaseUrl}/api-keys`, {
    headers: requestHeaders(gmToken),
  });
  expect(apiKeyListResponse.ok).toBeTruthy();
  const apiKeys = await apiKeyListResponse.json() as ApiEnvelope<Array<{ id: string; scopes: string[] }>>;
  const listedApiKey = apiKeys.data.find((key) => key.id === apiKey.data.id);
  expect(listedApiKey?.scopes).toEqual(['read', 'admin']);
  expectNoJsonShadow(listedApiKey);
});
