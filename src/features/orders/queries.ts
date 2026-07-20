import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@/api/generated/openapi';
import type { OrderSummary, PaginatedOrders } from '@/api/client';
import type { Order } from '@/types';
import { queryKeys } from '@/lib/queryClient';
import { createOrder, getOrder, listOrders, updateOrder } from './api';
import type { OrderFilters } from './api';

export function useOrdersQuery(filters: OrderFilters = {}) {
  return useQuery({
    queryKey: queryKeys.orders.list(filters),
    queryFn: ({ signal }) => listOrders(filters, signal),
  });
}

export function useOrderQuery(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.orders.detail(id),
    queryFn: ({ signal }) => getOrder(id, signal),
    enabled: Boolean(id) && enabled,
    // Detail dialogs expose an explicit retry action and should surface the
    // first failed request immediately instead of hiding it behind retries.
    retry: 0,
  });
}

export function useUpdateOrderMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: components['schemas']['OrderUpdateRequest'] }) => updateOrder(id, body),
    onSuccess: (result, variables) => {
      client.setQueryData(queryKeys.orders.detail(variables.id), result);
      client.invalidateQueries({ queryKey: queryKeys.orders.all() });
    },
  });
}

export function useCreateOrderMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: components['schemas']['OrderCreateRequest']) => createOrder(body),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: queryKeys.orders.all() });
      if (result.data?.id) client.setQueryData(queryKeys.orders.detail(result.data.id), result);
    },
  });
}

/** Thin page adapters kept inside the Order feature during migration. */
export function useOrders(filters: OrderFilters = {}) {
  const query = useOrdersQuery(filters);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as PaginatedOrders['data'] | null,
    pagination: query.data?.pagination as PaginatedOrders['pagination'] | undefined,
    summary: query.data?.summary as OrderSummary | undefined,
  };
}

export function useOrder(id: string, enabled = true) {
  const query = useOrderQuery(id, enabled);
  return {
    loading: query.isLoading,
    fetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as Order | undefined,
  };
}

export function useCreateOrder() {
  const mutation = useCreateOrderMutation();
  return {
    mutate: async (data: Record<string, unknown>) => (await mutation.mutateAsync(data as never)).data as unknown as Order,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

export function useUpdateOrder() {
  const mutation = useUpdateOrderMutation();
  return {
    mutate: async ({ id, data }: { id: string; data: Record<string, unknown> }) => (await mutation.mutateAsync({ id, body: data as never })).data as unknown as Order,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}
