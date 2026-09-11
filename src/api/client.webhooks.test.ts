import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken, webhooksPhase2Api } from './client';

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => body,
});

afterEach(() => {
  setAccessToken(null);
  vi.unstubAllGlobals();
});

describe('webhook replay batch response contract', () => {
  it.each([
    { data: [], pagination: { limit: 20, offset: 0, total: 0 } },
    { data: [{ id: 'batch-1', status: 'PENDING' }], pagination: { limit: 20, offset: 20, total: 41 } },
  ])('keeps the batch array and server pagination together: $pagination.total records', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));

    const result = await webhooksPhase2Api.listReplayBatches({ limit: 20, offset: body.pagination.offset });

    expect(result.data.map((batch) => batch.id)).toEqual(body.data.map((batch) => batch.id));
    expect(result.pagination).toEqual(body.pagination);
  });

  it('preserves the envelope after an expired access token is refreshed', async () => {
    const body = { data: [], pagination: { limit: 20, offset: 0, total: 0 } };
    setAccessToken('expired-test-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'Expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { accessToken: 'refreshed-test-token' } }))
      .mockResolvedValueOnce(jsonResponse(body));
    vi.stubGlobal('fetch', fetchMock);

    expect(await webhooksPhase2Api.listReplayBatches()).toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get('Authorization')).toBe('Bearer refreshed-test-token');
  });
});
