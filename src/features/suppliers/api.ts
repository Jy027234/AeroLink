import type { components } from '@/api/generated/openapi';
import { generatedQuery } from '@/api/generated/queryAdapter';

export type SupplierFilters = {
  level?: string;
  search?: string;
  followUpFilter?: string;
  page?: number;
  limit?: number;
  sort?: string;
  direction?: 'asc' | 'desc';
};

type SupplierListEnvelope = components['schemas']['SupplierListEnvelope'];
type SupplierEnvelope = components['schemas']['SupplierEnvelope'];
type SupplierCreateRequest = components['schemas']['SupplierCreateRequest'];
type SupplierUpdateRequest = components['schemas']['SupplierUpdateRequest'];

function toQuery(filters: SupplierFilters = {}) {
  return {
    page: filters.page ?? 1,
    limit: filters.limit ?? 20,
    ...(filters.search?.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.level ? { level: filters.level.toUpperCase() as 'S' | 'A' | 'B' | 'C' } : {}),
    ...(filters.followUpFilter && filters.followUpFilter !== 'all' ? { followUpFilter: filters.followUpFilter as 'with-follow-up' | 'waiting_quote' | 'quote_promised' } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
  };
}

export function listSuppliers(filters: SupplierFilters = {}, signal?: AbortSignal) {
  return generatedQuery<SupplierListEnvelope>((client, requestSignal) => client.GET('/api/suppliers', {
    params: { query: toQuery(filters) },
    signal: requestSignal,
  }), signal);
}

export function getSupplier(id: string, signal?: AbortSignal) {
  return generatedQuery<SupplierEnvelope>((client, requestSignal) => client.GET('/api/suppliers/{id}', {
    params: { path: { id } },
    signal: requestSignal,
  }), signal);
}

export function createSupplier(body: SupplierCreateRequest, signal?: AbortSignal) {
  return generatedQuery<SupplierEnvelope>((client, requestSignal) => client.POST('/api/suppliers', {
    body,
    signal: requestSignal,
  }), signal);
}

export function updateSupplier(id: string, body: SupplierUpdateRequest, signal?: AbortSignal) {
  return generatedQuery<SupplierEnvelope>((client, requestSignal) => client.PATCH('/api/suppliers/{id}', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}
