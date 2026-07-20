import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './openapi.js';

export type AeroLinkOpenApiClient = Client<paths>;

function resolveApiOrigin() {
  const configured = String(import.meta.env.VITE_API_URL || '/api');
  if (configured === '/api') return '';
  return configured.replace(/\/api\/?$/, '');
}

export interface CreateOpenApiClientOptions {
  accessToken?: string | null;
  idempotencyKey?: string;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Contract-generated client factory.
 *
 * The existing hand-written client remains the compatibility boundary until
 * P2-02 migrates a feature. New code can use this client without duplicating
 * URL, auth-cookie, or bearer-header setup.
 */
export function createAeroLinkOpenApiClient({
  accessToken,
  idempotencyKey,
  fetchImpl = globalThis.fetch,
}: CreateOpenApiClientOptions = {}): AeroLinkOpenApiClient {
  return createClient<paths>({
    baseUrl: resolveApiOrigin(),
    credentials: 'include',
    fetch: async (request) => {
      const headers = new Headers(request.headers);
      if (accessToken && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${accessToken}`);
      }
      if (idempotencyKey && !headers.has('Idempotency-Key')) {
        headers.set('Idempotency-Key', idempotencyKey);
      }
      return fetchImpl(new Request(request, { headers }));
    },
  });
}

export const openApiClient = createAeroLinkOpenApiClient();
