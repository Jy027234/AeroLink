import type { components } from '@/api/generated/openapi';
import { generatedQuery } from '@/api/generated/queryAdapter';

export type CustomerFilters = {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  sort?: string;
  direction?: 'asc' | 'desc';
};

type CustomerListEnvelope = components['schemas']['CustomerListEnvelope'];
type CustomerEnvelope = components['schemas']['CustomerEnvelope'];
type CustomerCreateRequest = components['schemas']['CustomerCreateRequest'];
type CustomerUpdateRequest = components['schemas']['CustomerUpdateRequest'];

function toQuery(filters: CustomerFilters = {}) {
  return {
    page: filters.page ?? 1,
    limit: filters.limit ?? 20,
    ...(filters.search?.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.status ? { status: filters.status.toLowerCase() as 'active' | 'inactive' | 'at_risk' } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
  };
}

export function listCustomers(filters: CustomerFilters = {}, signal?: AbortSignal) {
  return generatedQuery<CustomerListEnvelope>((client, requestSignal) => client.GET('/api/customers', {
    params: { query: toQuery(filters) },
    signal: requestSignal,
  }), signal);
}

export function getCustomer(id: string, signal?: AbortSignal) {
  return generatedQuery<CustomerEnvelope>((client, requestSignal) => client.GET('/api/customers/{id}', {
    params: { path: { id } },
    signal: requestSignal,
  }), signal);
}

export function createCustomer(body: CustomerCreateRequest, signal?: AbortSignal) {
  return generatedQuery<CustomerEnvelope>((client, requestSignal) => client.POST('/api/customers', {
    body,
    signal: requestSignal,
  }), signal);
}

export function updateCustomer(id: string, body: CustomerUpdateRequest, signal?: AbortSignal) {
  return generatedQuery<CustomerEnvelope>((client, requestSignal) => client.PATCH('/api/customers/{id}', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}
