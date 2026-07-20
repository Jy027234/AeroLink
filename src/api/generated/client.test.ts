import { describe, expect, it, vi } from 'vitest';
import { createAeroLinkOpenApiClient } from './client';

describe('generated OpenAPI client', () => {
  it('sends cookies, bearer auth and typed query parameters through one adapter', async () => {
    const fetchImpl = vi.fn(async (request: Request) => {
      expect(request.url).toContain('/api/rfqs?page=2&limit=20');
      expect(request.credentials).toBe('include');
      expect(request.headers.get('Authorization')).toBe('Bearer access-token');
      return new Response(JSON.stringify({ success: true, data: [], pagination: { page: 2, limit: 20 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = createAeroLinkOpenApiClient({ accessToken: 'access-token', fetchImpl });
    const result = await client.GET('/api/rfqs', {
      params: { query: { page: 2, limit: 20 } },
    });

    expect(result.response.ok).toBe(true);
    expect(result.data?.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('attaches the supplied idempotency key to generated mutations', async () => {
    const fetchImpl = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST');
      expect(request.headers.get('Idempotency-Key')).toBe('stable-key');
      return new Response(JSON.stringify({ success: true, data: { id: 'tx-1' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = createAeroLinkOpenApiClient({ accessToken: 'access-token', idempotencyKey: 'stable-key', fetchImpl });
    const result = await client.POST('/api/inventory-transactions/reserve', {
      body: { inventoryDetailId: 'detail-1', quotationId: 'quote-1', quantity: 1 },
    });

    expect(result.response.status).toBe(201);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
