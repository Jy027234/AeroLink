import type { components } from '@/api/generated/openapi';
import { generatedQuery } from '@/api/generated/queryAdapter';

export type OrderFilters = {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  sort?: string;
  direction?: 'asc' | 'desc';
};

type OrderListEnvelope = components['schemas']['OrderListEnvelope'];
type OrderEnvelope = components['schemas']['OrderEnvelope'];
type OrderCreateRequest = components['schemas']['OrderCreateRequest'];
type OrderUpdateRequest = components['schemas']['OrderUpdateRequest'];

function toQuery(filters: OrderFilters = {}) {
  return {
    page: filters.page ?? 1,
    limit: filters.limit ?? 20,
    ...(filters.search?.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
  };
}

export function listOrders(filters: OrderFilters = {}, signal?: AbortSignal) {
  return generatedQuery<OrderListEnvelope>((client, requestSignal) => client.GET('/api/orders', {
    params: { query: toQuery(filters) },
    signal: requestSignal,
  }), signal);
}

export function getOrder(id: string, signal?: AbortSignal) {
  return generatedQuery<OrderEnvelope>((client, requestSignal) => client.GET('/api/orders/{id}', {
    params: { path: { id } },
    signal: requestSignal,
  }), signal);
}

export function createOrder(body: OrderCreateRequest, signal?: AbortSignal) {
  return generatedQuery<OrderEnvelope>((client, requestSignal) => client.POST('/api/orders', {
    body,
    signal: requestSignal,
  }), signal);
}

export function updateOrder(id: string, body: OrderUpdateRequest, signal?: AbortSignal) {
  return generatedQuery<OrderEnvelope>((client, requestSignal) => client.PATCH('/api/orders/{id}', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}
