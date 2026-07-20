import React, { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '@/api/client';
import { useOrder } from './queries';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('order detail query adapter', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 60_000 },
      },
    });
    setAccessToken('order-query-test-token');
  });

  afterEach(() => {
    client.clear();
    setAccessToken(null);
    vi.restoreAllMocks();
  });

  it('does not fetch while the detail dialog is closed, then uses the generated detail endpoint when enabled', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.method).toBe('GET');
      expect(request.url).toContain('/api/orders/order-1');
      expect(request.headers.get('Authorization')).toBe('Bearer order-query-test-token');
      return new Response(JSON.stringify({ success: true, data: { id: 'order-1', orderNumber: 'SO-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = wrapperFor(client);

    const closed = renderHook(() => useOrder('order-closed', false), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    closed.unmount();

    const open = renderHook(() => useOrder('order-1', true), { wrapper });
    await waitFor(() => expect(open.result.current.data?.id).toBe('order-1'));
    expect(open.result.current.fetching).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
