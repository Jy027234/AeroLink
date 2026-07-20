import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        const status = (error as { status?: number } | null)?.status;
        if (status === 401 || status === 403 || status === 422) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: 0,
    },
  },
});

export const queryKeys = {
  all: ['aerolink'] as const,
  rfqs: {
    all: () => [...queryKeys.all, 'rfqs'] as const,
    list: (filters: object = {}) => [...queryKeys.rfqs.all(), 'list', filters] as const,
    detail: (id: string) => [...queryKeys.rfqs.all(), 'detail', id] as const,
  },
  quotations: {
    all: () => [...queryKeys.all, 'quotations'] as const,
    list: (filters: object = {}) => [...queryKeys.quotations.all(), 'list', filters] as const,
    detail: (id: string) => [...queryKeys.quotations.all(), 'detail', id] as const,
  },
  orders: {
    all: () => [...queryKeys.all, 'orders'] as const,
    list: (filters: object = {}) => [...queryKeys.orders.all(), 'list', filters] as const,
    detail: (id: string) => [...queryKeys.orders.all(), 'detail', id] as const,
  },
  inventory: {
    all: () => [...queryKeys.all, 'inventory'] as const,
    list: (filters: object = {}) => [...queryKeys.inventory.all(), 'list', filters] as const,
    detail: (id: string) => [...queryKeys.inventory.all(), 'detail', id] as const,
    itemByPartNumber: (partNumber: string) => [...queryKeys.inventory.all(), 'item-by-part-number', partNumber] as const,
    transactionsByOrder: (orderId: string) => [...queryKeys.inventory.all(), 'transactions-by-order', orderId] as const,
  },
  customers: {
    all: () => [...queryKeys.all, 'customers'] as const,
    list: (filters: object = {}) => [...queryKeys.customers.all(), 'list', filters] as const,
    detail: (id: string) => [...queryKeys.customers.all(), 'detail', id] as const,
  },
  suppliers: {
    all: () => [...queryKeys.all, 'suppliers'] as const,
    list: (filters: object = {}) => [...queryKeys.suppliers.all(), 'list', filters] as const,
    detail: (id: string) => [...queryKeys.suppliers.all(), 'detail', id] as const,
  },
  integrations: {
    all: () => [...queryKeys.all, 'integrations'] as const,
    documentTemplates: (documentType: string) => [...queryKeys.integrations.all(), 'document-templates', documentType] as const,
  },
};
