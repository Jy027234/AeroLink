import type { components } from '@/api/generated/openapi';
import { generatedQuery } from '@/api/generated/queryAdapter';

export type RfqFilters = {
  status?: string;
  urgency?: string;
  search?: string;
  page?: number;
  limit?: number;
  sort?: string;
  direction?: 'asc' | 'desc';
};

type RfqListEnvelope = components['schemas']['RfqListEnvelope'];
type RfqEnvelope = components['schemas']['RfqEnvelope'];
type RfqCreateRequest = components['schemas']['RfqCreateRequest'];
type RfqUpdateRequest = components['schemas']['RfqUpdateRequest'];
type RfqStatusUpdateRequest = components['schemas']['RfqStatusUpdateRequest'];

function toQuery(filters: RfqFilters = {}) {
  return {
    page: filters.page ?? 1,
    limit: filters.limit ?? 20,
    ...(filters.search?.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.status ? { status: filters.status.toLowerCase() as 'pending' | 'sourcing' | 'quoting' | 'approved' | 'sent' | 'won' | 'lost' } : {}),
    ...(filters.urgency ? { urgency: filters.urgency.toLowerCase() as 'aog' | 'urgent' | 'standard' } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
  };
}

export function listRfqs(filters: RfqFilters = {}, signal?: AbortSignal) {
  return generatedQuery<RfqListEnvelope>((client, requestSignal) => client.GET('/api/rfqs', {
    params: { query: toQuery(filters) },
    signal: requestSignal,
  }), signal);
}

export function getRfq(id: string, signal?: AbortSignal) {
  return generatedQuery<RfqEnvelope>((client, requestSignal) => client.GET('/api/rfqs/{id}', {
    params: { path: { id } },
    signal: requestSignal,
  }), signal);
}

export function createRfq(body: RfqCreateRequest, signal?: AbortSignal) {
  return generatedQuery<RfqEnvelope>((client, requestSignal) => client.POST('/api/rfqs', {
    body,
    signal: requestSignal,
  }), signal);
}

export function updateRfq(id: string, body: RfqUpdateRequest, signal?: AbortSignal) {
  return generatedQuery<RfqEnvelope>((client, requestSignal) => client.PATCH('/api/rfqs/{id}', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}

export function updateRfqStatus(id: string, body: RfqStatusUpdateRequest, signal?: AbortSignal) {
  return generatedQuery<RfqEnvelope>((client, requestSignal) => client.PATCH('/api/rfqs/{id}/status', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}
