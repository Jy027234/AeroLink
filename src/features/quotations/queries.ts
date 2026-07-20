import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@/api/generated/openapi';
import type { PaginatedQuotations, QuotationSummary } from '@/api/client';
import type { Quotation } from '@/types';
import { queryKeys } from '@/lib/queryClient';
import { acceptQuotation, approveQuotation, createQuotation, getQuotation, listQuotations, sendQuotation, submitQuotation, withdrawQuotation } from './api';
import type { QuotationFilters } from './api';

export function useQuotationsQuery(filters: QuotationFilters = {}) {
  return useQuery({
    queryKey: queryKeys.quotations.list(filters),
    queryFn: ({ signal }) => listQuotations(filters, signal),
    // Keep the list's stale-data banner actionable. A failed refresh should
    // surface immediately so the user can choose when to retry rather than
    // silently hiding the failure behind automatic retries.
    retry: 0,
  });
}

export function useQuotationQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.quotations.detail(id),
    queryFn: ({ signal }) => getQuotation(id, signal),
    enabled: Boolean(id),
    // Detail dialogs expose an explicit retry action and must show a
    // deterministic failure state when the first request fails.
    retry: 0,
  });
}

export function useCreateQuotationMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: components['schemas']['QuotationCreateRequest']) => createQuotation(body),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: queryKeys.quotations.all() });
      if (result.data?.id) client.setQueryData(queryKeys.quotations.detail(result.data.id), result);
    },
  });
}

function useQuotationActionMutation<T extends Record<string, unknown>>(
  action: (id: string, body: T) => Promise<components['schemas']['Action']>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: T }) => action(id, body),
    onSuccess: (_result, variables) => {
      client.invalidateQueries({ queryKey: queryKeys.quotations.all() });
      client.invalidateQueries({ queryKey: queryKeys.quotations.detail(variables.id) });
    },
  });
}

export function useSubmitQuotationMutation() {
  return useQuotationActionMutation((id, body) => submitQuotation(id, body));
}

export function useApproveQuotationMutation() {
  return useQuotationActionMutation((id, body) => approveQuotation(id, body as never));
}

export function useSendQuotationMutation() {
  return useQuotationActionMutation((id, body) => sendQuotation(id, body));
}

export function useWithdrawQuotationMutation() {
  return useQuotationActionMutation((id, body) => withdrawQuotation(id, body as never));
}

export function useAcceptQuotationMutation() {
  return useQuotationActionMutation((id, body) => acceptQuotation(id, body));
}

/** Thin page adapters kept inside the Quotation feature during migration. */
export function useQuotations(filters: QuotationFilters = {}) {
  const query = useQuotationsQuery(filters);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as PaginatedQuotations['data'] | null,
    pagination: query.data?.pagination as PaginatedQuotations['pagination'] | undefined,
    summary: query.data?.summary as QuotationSummary | undefined,
  };
}

export function useQuotation(id: string) {
  const query = useQuotationQuery(id);
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data as unknown as Quotation | undefined,
  };
}

export function useCreateQuotation() {
  const mutation = useCreateQuotationMutation();
  return {
    mutate: async (data: Record<string, unknown>) => (await mutation.mutateAsync(data as never)).data as unknown as Quotation,
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

function quotationActionAdapter(mutation: ReturnType<typeof useQuotationActionMutation>) {
  return {
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}

export function useSubmitQuotation() {
  const mutation = useSubmitQuotationMutation();
  return { submit: async (id: string, version?: number) => (await mutation.mutateAsync({ id, body: { version } })).data, ...quotationActionAdapter(mutation) };
}

export function useApproveQuotation() {
  const mutation = useApproveQuotationMutation();
  return { approve: async (id: string, action: 'approve' | 'reject', version?: number, comment?: string) => (await mutation.mutateAsync({ id, body: { action, version, comment } })).data, ...quotationActionAdapter(mutation) };
}

export function useSendQuotation() {
  const mutation = useSendQuotationMutation();
  return { send: async (id: string, body: Record<string, unknown>) => (await mutation.mutateAsync({ id, body: body as never })).data, ...quotationActionAdapter(mutation) };
}

export function useWithdrawQuotation() {
  const mutation = useWithdrawQuotationMutation();
  return { withdraw: async (id: string, body: Record<string, unknown>) => (await mutation.mutateAsync({ id, body: body as never })).data, ...quotationActionAdapter(mutation) };
}

export function useAcceptQuotation() {
  const mutation = useAcceptQuotationMutation();
  return { accept: async (id: string, body: Record<string, unknown>) => (await mutation.mutateAsync({ id, body: body as never })).data, ...quotationActionAdapter(mutation) };
}
