import { useMutation, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryClient';
import { dispatchNotification, listDocumentTemplates, type NotificationDispatchRequest } from './api';

export function useDocumentTemplates(documentType = 'ORDER_CONTRACT') {
  const query = useQuery({
    queryKey: queryKeys.integrations.documentTemplates(documentType),
    queryFn: ({ signal }) => listDocumentTemplates(documentType, signal),
  });
  return {
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
    data: query.data?.data?.map((template) => ({
      ...template,
      description: template.description ?? undefined,
      headerTemplate: template.headerTemplate ?? undefined,
      footerTemplate: template.footerTemplate ?? undefined,
      createdById: template.createdById ?? undefined,
    })) ?? null,
  };
}

export function useDispatchNotificationMutation() {
  return useMutation({
    mutationFn: (body: NotificationDispatchRequest) => dispatchNotification(body),
  });
}

export function useDispatchNotification() {
  const mutation = useDispatchNotificationMutation();
  return {
    mutate: (body: NotificationDispatchRequest) => mutation.mutateAsync(body).then((result) => result.data),
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
  };
}
