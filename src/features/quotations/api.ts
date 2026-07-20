import type { components } from '@/api/generated/openapi';
import { generatedQuery } from '@/api/generated/queryAdapter';

export type QuotationFilters = {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  sort?: string;
  direction?: 'asc' | 'desc';
};

type QuotationListEnvelope = components['schemas']['QuotationListEnvelope'];
type QuotationEnvelope = components['schemas']['QuotationEnvelope'];
type QuotationCreateRequest = components['schemas']['QuotationCreateRequest'];
type ActionEnvelope = components['schemas']['Action'];

function toQuery(filters: QuotationFilters = {}) {
  return {
    page: filters.page ?? 1,
    limit: filters.limit ?? 20,
    ...(filters.search?.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
  };
}

export function listQuotations(filters: QuotationFilters = {}, signal?: AbortSignal) {
  return generatedQuery<QuotationListEnvelope>((client, requestSignal) => client.GET('/api/quotations', {
    params: { query: toQuery(filters) },
    signal: requestSignal,
  }), signal);
}

export function getQuotation(id: string, signal?: AbortSignal) {
  return generatedQuery<QuotationEnvelope>((client, requestSignal) => client.GET('/api/quotations/{id}', {
    params: { path: { id } },
    signal: requestSignal,
  }), signal);
}

export function createQuotation(body: QuotationCreateRequest, signal?: AbortSignal) {
  return generatedQuery<QuotationEnvelope>((client, requestSignal) => client.POST('/api/quotations', {
    body,
    signal: requestSignal,
  }), signal);
}

export function submitQuotation(id: string, body: components['schemas']['QuotationTransitionRequest'] = {}, signal?: AbortSignal) {
  return generatedQuery<ActionEnvelope>((client, requestSignal) => client.POST('/api/quotations/{id}/submit', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}

export function approveQuotation(id: string, body: components['schemas']['QuotationApproveRequest'], signal?: AbortSignal) {
  return generatedQuery<ActionEnvelope>((client, requestSignal) => client.POST('/api/quotations/{id}/approve', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}

export function sendQuotation(id: string, body: components['schemas']['QuotationSendRequest'] = {}, signal?: AbortSignal) {
  return generatedQuery<ActionEnvelope>((client, requestSignal) => client.POST('/api/quotations/{id}/send', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}

export function withdrawQuotation(id: string, body: components['schemas']['QuotationWithdrawRequest'], signal?: AbortSignal) {
  return generatedQuery<ActionEnvelope>((client, requestSignal) => client.POST('/api/quotations/{id}/withdraw', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}

export function acceptQuotation(id: string, body: components['schemas']['QuotationAcceptRequest'] = {}, signal?: AbortSignal) {
  return generatedQuery<ActionEnvelope>((client, requestSignal) => client.POST('/api/quotations/{id}/accept', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}
