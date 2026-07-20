import React, { type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '@/api/client';
import { queryKeys } from '@/lib/queryClient';
import { useCreateRfqMutation } from './rfqs';
import { useCreateQuotationMutation } from './quotations';
import { useCreateOrderMutation } from './orders';
import { useCreateInventoryMutation } from './inventory';
import { useCreateCustomerMutation } from './customers';
import { useCreateSupplierMutation } from './suppliers';
import { useUpdateInventoryMutation } from './inventory';

function okResponse(id = 'resource-1') {
  return new Response(JSON.stringify({ success: true, data: { id } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('six-domain Query mutations', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 60_000 },
        mutations: { retry: 0 },
      },
    });
    setAccessToken('mutation-test-token');
  });

  afterEach(() => {
    client.clear();
    setAccessToken(null);
    vi.restoreAllMocks();
  });

  it('invalidates the corresponding list cache for all six core create mutations', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = wrapperFor(client);

    const rfqListKey = queryKeys.rfqs.list({});
    const quotationListKey = queryKeys.quotations.list({});
    const orderListKey = queryKeys.orders.list({});
    const inventoryListKey = queryKeys.inventory.list({});
    const customerListKey = queryKeys.customers.list({});
    const supplierListKey = queryKeys.suppliers.list({});
    for (const key of [rfqListKey, quotationListKey, orderListKey, inventoryListKey, customerListKey, supplierListKey]) {
      client.setQueryData(key, { success: true, data: [] });
    }

    const rfq = renderHook(() => useCreateRfqMutation(), { wrapper });
    const quotation = renderHook(() => useCreateQuotationMutation(), { wrapper });
    const order = renderHook(() => useCreateOrderMutation(), { wrapper });
    const inventory = renderHook(() => useCreateInventoryMutation(), { wrapper });
    const customer = renderHook(() => useCreateCustomerMutation(), { wrapper });
    const supplier = renderHook(() => useCreateSupplierMutation(), { wrapper });

    await act(async () => {
      await Promise.all([
        rfq.result.current.mutateAsync({} as never),
        quotation.result.current.mutateAsync({} as never),
        order.result.current.mutateAsync({} as never),
        inventory.result.current.mutateAsync({} as never),
        customer.result.current.mutateAsync({} as never),
        supplier.result.current.mutateAsync({} as never),
      ]);
    });

    for (const key of [rfqListKey, quotationListKey, orderListKey, inventoryListKey, customerListKey, supplierListKey]) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('keeps the previous detail cache and exposes mutation failures instead of returning null', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: false, message: 'invalid inventory' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const detailKey = queryKeys.inventory.detail('inv-1');
    client.setQueryData(detailKey, { success: true, data: { id: 'inv-1', quantity: 9 } });
    const wrapper = wrapperFor(client);
    const { result } = renderHook(() => useUpdateInventoryMutation(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ id: 'inv-1', body: {} as never })).rejects.toThrow();
    });
    expect(client.getQueryData(detailKey)).toEqual({ success: true, data: { id: 'inv-1', quantity: 9 } });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('allows concurrent mutations to settle independently and invalidates once both complete', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const listKey = queryKeys.suppliers.list({});
    client.setQueryData(listKey, { success: true, data: [] });
    const wrapper = wrapperFor(client);
    const { result } = renderHook(() => useCreateSupplierMutation(), { wrapper });

    let first: Promise<unknown>;
    let second: Promise<unknown>;
    await act(async () => {
      first = result.current.mutateAsync({} as never);
      second = result.current.mutateAsync({} as never);
      await waitFor(() => expect(resolvers).toHaveLength(2));
    });
    await act(async () => {
      resolvers[1]?.(okResponse('supplier-2'));
      resolvers[0]?.(okResponse('supplier-1'));
      await expect(Promise.all([first!, second!])).resolves.toHaveLength(2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
  });
});
