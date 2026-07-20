import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryClient';
import { createCustomer, getCustomer, listCustomers, updateCustomer } from './api';
import type { components } from '@/api/generated/openapi';
import type { CustomerSummary, PaginatedCustomers } from '@/api/client';
import type { Customer } from '@/types';
import type { CustomerFilters } from './api';

export function useCustomersQuery(filters: CustomerFilters = {}) {
  return useQuery({
    queryKey: queryKeys.customers.list(filters),
    queryFn: ({ signal }) => listCustomers(filters, signal),
  });
}

export function useCustomerQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.customers.detail(id),
    queryFn: ({ signal }) => getCustomer(id, signal),
    enabled: Boolean(id),
  });
}

export function useCreateCustomerMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: components['schemas']['CustomerCreateRequest']) => createCustomer(body),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: queryKeys.customers.all() });
      if (result.data?.id) client.setQueryData(queryKeys.customers.detail(result.data.id), result);
    },
  });
}

export function useUpdateCustomerMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: components['schemas']['CustomerUpdateRequest'] }) => updateCustomer(id, body),
    onSuccess: (result, variables) => {
      client.setQueryData(queryKeys.customers.detail(variables.id), result);
      client.invalidateQueries({ queryKey: queryKeys.customers.all() });
    },
  });
}

/** Thin page adapters kept inside the Customer feature during migration. */
export function useCustomers(filters: CustomerFilters = {}) {
  const query = useCustomersQuery(filters);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as PaginatedCustomers['data'] | null,
    pagination: query.data?.pagination as PaginatedCustomers['pagination'] | undefined,
    summary: query.data?.summary as CustomerSummary | undefined,
  };
}

export function useCustomer(id: string) {
  const query = useCustomerQuery(id);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as Customer | undefined,
  };
}

export function useCreateCustomer() {
  const mutation = useCreateCustomerMutation();
  return {
    mutate: async (data: Record<string, unknown>) => (await mutation.mutateAsync(data as never)).data as unknown as Customer,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

export function useUpdateCustomer() {
  const mutation = useUpdateCustomerMutation();
  return {
    mutate: async ({ id, data }: { id: string; data: Record<string, unknown> }) => (await mutation.mutateAsync({ id, body: data as never })).data as unknown as Customer,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}
