import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryClient';
import { createInventory, createInventoryOutbound, createInventoryReservation, getInventory, getInventoryItemByPartNumber, listInventory, listInventoryTransactionsByOrder, updateInventory } from './api';
import type { InventoryFilters } from './api';
import type { components } from '@/api/generated/openapi';
import type { InventorySummary, PaginatedInventory } from '@/api/client';
import type { Inventory } from '@/types';

export function useInventoryQuery(filters: InventoryFilters = {}) {
  return useQuery({
    queryKey: queryKeys.inventory.list(filters),
    queryFn: ({ signal }) => listInventory(filters, signal),
  });
}

export function useInventoryDetailQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.inventory.detail(id),
    queryFn: ({ signal }) => getInventory(id, signal),
    enabled: Boolean(id),
  });
}

export function useInventoryItemByPartNumberQuery(partNumber: string) {
  return useQuery({
    queryKey: queryKeys.inventory.itemByPartNumber(partNumber),
    queryFn: ({ signal }) => getInventoryItemByPartNumber(partNumber, signal),
    enabled: Boolean(partNumber),
  });
}

export function useInventoryTransactionsByOrderQuery(orderId: string) {
  return useQuery({
    queryKey: queryKeys.inventory.transactionsByOrder(orderId),
    queryFn: ({ signal }) => listInventoryTransactionsByOrder(orderId, signal),
    enabled: Boolean(orderId),
  });
}

export function useCreateInventoryReservationMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: import('./api').InventoryReserveRequest) => createInventoryReservation(body),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.inventory.all() });
      client.invalidateQueries({ queryKey: queryKeys.orders.all() });
    },
  });
}

export function useCreateInventoryOutboundMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: import('./api').InventoryOutboundRequest) => createInventoryOutbound(body),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.inventory.all() });
      client.invalidateQueries({ queryKey: queryKeys.orders.all() });
    },
  });
}

export function useCreateInventoryMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: components['schemas']['InventoryCreateRequest']) => createInventory(body),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: queryKeys.inventory.all() });
      if (result.data?.id) client.setQueryData(queryKeys.inventory.detail(result.data.id), result);
    },
  });
}

export function useUpdateInventoryMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: components['schemas']['InventoryUpdateRequest'] }) => updateInventory(id, body),
    onSuccess: (result, variables) => {
      client.setQueryData(queryKeys.inventory.detail(variables.id), result);
      client.invalidateQueries({ queryKey: queryKeys.inventory.all() });
    },
  });
}

/** Thin page adapters kept inside the Inventory feature during migration. */
export function useInventory(filters: InventoryFilters = {}) {
  const query = useInventoryQuery(filters);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as PaginatedInventory['data'] | null,
    pagination: query.data?.pagination as PaginatedInventory['pagination'] | undefined,
    summary: query.data?.summary as InventorySummary | undefined,
  };
}

export function useInventoryItem(id: string) {
  const query = useInventoryDetailQuery(id);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as Inventory | undefined,
  };
}

/** Cross-domain operational reads exposed by the Inventory feature boundary. */
export function useInventoryItemByPartNumber(partNumber: string) {
  const query = useInventoryItemByPartNumberQuery(partNumber);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data,
  };
}

export function useInventoryTransactionsByOrder(orderId: string) {
  const query = useInventoryTransactionsByOrderQuery(orderId);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data ?? null,
  };
}

export function useCreateInventoryReservation() {
  const mutation = useCreateInventoryReservationMutation();
  return {
    mutate: (body: import('./api').InventoryReserveRequest) => mutation.mutateAsync(body).then((result) => result.data),
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

export function useCreateOutbound() {
  const mutation = useCreateInventoryOutboundMutation();
  return {
    mutate: (body: import('./api').InventoryOutboundRequest) => mutation.mutateAsync(body).then((result) => result.data),
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

export function useCreateInventory() {
  const mutation = useCreateInventoryMutation();
  return {
    mutate: async (data: Record<string, unknown>) => (await mutation.mutateAsync(data as never)).data as unknown as Inventory,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

export function useUpdateInventory() {
  const mutation = useUpdateInventoryMutation();
  return {
    mutate: async ({ id, data }: { id: string; data: Record<string, unknown> }) => (await mutation.mutateAsync({ id, body: data as never })).data as unknown as Inventory,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}
