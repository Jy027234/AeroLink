import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@/api/generated/openapi';
import type { PaginatedRFQs, RFQSummary } from '@/api/client';
import type { RFQ } from '@/types';
import { queryKeys } from '@/lib/queryClient';
import { createRfq, getRfq, listRfqs, updateRfq, updateRfqStatus } from './api';
import type { RfqFilters } from './api';

export function useRfqsQuery(filters: RfqFilters = {}) {
  return useQuery({
    queryKey: queryKeys.rfqs.list(filters),
    queryFn: ({ signal }) => listRfqs(filters, signal),
  });
}

export function useRfqQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.rfqs.detail(id),
    queryFn: ({ signal }) => getRfq(id, signal),
    enabled: Boolean(id),
  });
}

export function useCreateRfqMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: components['schemas']['RfqCreateRequest']) => createRfq(body),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: queryKeys.rfqs.all() });
      if (result.data?.id) client.setQueryData(queryKeys.rfqs.detail(result.data.id), result);
    },
  });
}

export function useUpdateRfqMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: components['schemas']['RfqUpdateRequest'] }) => updateRfq(id, body),
    onSuccess: (result, variables) => {
      client.setQueryData(queryKeys.rfqs.detail(variables.id), result);
      client.invalidateQueries({ queryKey: queryKeys.rfqs.all() });
    },
  });
}

export function useUpdateRfqStatusMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: components['schemas']['RfqStatusUpdateRequest'] }) => updateRfqStatus(id, body),
    onSuccess: (result, variables) => {
      client.setQueryData(queryKeys.rfqs.detail(variables.id), result);
      client.invalidateQueries({ queryKey: queryKeys.rfqs.all() });
    },
  });
}

/** Thin page adapter kept inside the RFQ feature while legacy sections migrate. */
export function useRFQs(filters: RfqFilters = {}) {
  const query = useRfqsQuery(filters);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as PaginatedRFQs['data'] | null,
    pagination: query.data?.pagination as PaginatedRFQs['pagination'] | undefined,
    summary: query.data?.summary as RFQSummary | undefined,
  };
}

export function useRFQ(id: string) {
  const query = useRfqQuery(id);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as RFQ | undefined,
  };
}

export function useCreateRFQ() {
  const mutation = useCreateRfqMutation();
  return {
    mutate: async (data: Record<string, unknown>) => (await mutation.mutateAsync(data as never)).data as unknown as RFQ,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

export function useUpdateRFQ() {
  const mutation = useUpdateRfqMutation();
  return {
    mutate: async ({ id, data }: { id: string; data: Record<string, unknown> }) => (await mutation.mutateAsync({ id, body: data as never })).data as unknown as RFQ,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

export function useUpdateRFQStatus() {
  const mutation = useUpdateRfqStatusMutation();
  return {
    updateStatus: async (id: string, status: RFQ['status'], version?: number) => (await mutation.mutateAsync({ id, body: { status, version } as never })).data as unknown as RFQ,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}
