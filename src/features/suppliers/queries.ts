import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryClient';
import { createSupplier, getSupplier, listSuppliers, updateSupplier } from './api';
import type { SupplierFilters } from './api';
import type { components } from '@/api/generated/openapi';
import type { PaginatedSuppliers, SupplierSummary } from '@/api/client';
import type { Supplier } from '@/types';

export function useSuppliersQuery(filters: SupplierFilters = {}) {
  return useQuery({
    queryKey: queryKeys.suppliers.list(filters),
    queryFn: ({ signal }) => listSuppliers(filters, signal),
  });
}

export function useSupplierQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.suppliers.detail(id),
    queryFn: ({ signal }) => getSupplier(id, signal),
    enabled: Boolean(id),
  });
}

export function useCreateSupplierMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: components['schemas']['SupplierCreateRequest']) => createSupplier(body),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: queryKeys.suppliers.all() });
      if (result.data?.id) client.setQueryData(queryKeys.suppliers.detail(result.data.id), result);
    },
  });
}

export function useUpdateSupplierMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: components['schemas']['SupplierUpdateRequest'] }) => updateSupplier(id, body),
    onSuccess: (result, variables) => {
      client.setQueryData(queryKeys.suppliers.detail(variables.id), result);
      client.invalidateQueries({ queryKey: queryKeys.suppliers.all() });
    },
  });
}

/** Thin page adapters kept inside the Supplier feature during migration. */
export function useSuppliers(filters: SupplierFilters = {}) {
  const query = useSuppliersQuery(filters);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as PaginatedSuppliers['data'] | null,
    pagination: query.data?.pagination as PaginatedSuppliers['pagination'] | undefined,
    summary: query.data?.summary as SupplierSummary | undefined,
  };
}

export function useSupplier(id: string) {
  const query = useSupplierQuery(id);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as Supplier | undefined,
  };
}

export function useCreateSupplier() {
  const mutation = useCreateSupplierMutation();
  return {
    mutate: async (data: Record<string, unknown>) => (await mutation.mutateAsync(data as never)).data as unknown as Supplier,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

export function useUpdateSupplier() {
  const mutation = useUpdateSupplierMutation();
  return {
    mutate: async ({ id, data }: { id: string; data: Record<string, unknown> }) => (await mutation.mutateAsync({ id, body: data as never })).data as unknown as Supplier,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}
