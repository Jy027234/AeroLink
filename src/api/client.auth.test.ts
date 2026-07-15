import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi, getAccessToken, rfqApi, setAccessToken } from './client';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: () => 'application/json',
    },
    json: async () => body,
  };
}

function requestHeader(request: RequestInit | undefined, name: string) {
  return new Headers(request?.headers).get(name);
}

describe('auth token storage', () => {
  beforeEach(() => {
    setAccessToken(null);
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps the login access token in memory instead of localStorage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      data: {
        token: 'access-login',
        user: { id: 'u1', email: 'user@example.com', name: 'User', role: 'sales' },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await authApi.login('user@example.com', 'password123');

    expect(getAccessToken()).toBe('access-login');
    expect(window.localStorage.getItem('aerolink_token')).toBeNull();
    expect(window.localStorage.getItem('aerolink_refresh_token')).toBeNull();
  });

  it('restores an access token through the HttpOnly refresh cookie', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      data: { accessToken: 'access-refresh' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await authApi.refresh();

    expect(getAccessToken()).toBe('access-refresh');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/refresh'),
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    );
    const refreshRequest = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(refreshRequest?.body).toBeUndefined();
    expect(window.localStorage.getItem('aerolink_token')).toBeNull();
  });

  it('clears the in-memory token after logout', async () => {
    setAccessToken('access-before-logout');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { success: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await authApi.logout();

    expect(getAccessToken()).toBeNull();
    expect(requestHeader(fetchMock.mock.calls[0]?.[1] as RequestInit | undefined, 'Authorization')).toBe('Bearer access-before-logout');
  });

  it('refreshes once and retries a failed business request with the memory token', async () => {
    setAccessToken('access-expired');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: false, message: '登录已过期' }, 401))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { accessToken: 'access-refreshed' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          data: [],
          pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(rfqApi.getAll()).resolves.toMatchObject({
      data: {
        data: [],
        pagination: { total: 0 },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getAccessToken()).toBe('access-refreshed');
    expect(requestHeader(fetchMock.mock.calls[2]?.[1] as RequestInit | undefined, 'Authorization')).toBe('Bearer access-refreshed');
  });

  it('keeps one Idempotency-Key when an unsafe request is retried after refresh', async () => {
    setAccessToken('access-expired');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: false, message: '登录已过期' }, 401))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { accessToken: 'access-refreshed' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { id: 'rfq-1', status: 'pending' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await rfqApi.create({
      customerId: 'c001',
      partNumber: 'IDEMPOTENCY-TEST',
      quantity: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstKey = requestHeader(fetchMock.mock.calls[0]?.[1] as RequestInit | undefined, 'Idempotency-Key');
    const retryKey = requestHeader(fetchMock.mock.calls[2]?.[1] as RequestInit | undefined, 'Idempotency-Key');
    expect(firstKey).toBeTruthy();
    expect(retryKey).toBe(firstKey);
  });
});
