import type { components } from '@/api/generated/openapi';
import { generatedMutation, generatedQuery } from '@/api/generated/queryAdapter';

export type InventoryFilters = {
  search?: string;
  conditionCode?: string;
  certificateType?: string;
  type?: string;
  partCategory?: string;
  location?: string;
  page?: number;
  limit?: number;
  sort?: string;
  direction?: 'asc' | 'desc';
};

type InventoryListEnvelope = components['schemas']['InventoryListEnvelope'];
type InventoryEnvelope = components['schemas']['InventoryEnvelope'];
type InventoryItemRaw = components['schemas']['InventoryItemRaw'];
type InventoryTransactionListEnvelope = components['schemas']['InventoryTransactionListEnvelope'];
type InventoryTransactionActionEnvelope = components['schemas']['InventoryTransactionActionEnvelope'];
type InventoryCreateRequest = components['schemas']['InventoryCreateRequest'];
type InventoryUpdateRequest = components['schemas']['InventoryUpdateRequest'];
export type InventoryReserveRequest = components['schemas']['InventoryReserveRequest'];
export type InventoryOutboundRequest = components['schemas']['InventoryOutboundRequest'];

function toQuery(filters: InventoryFilters = {}) {
  return {
    page: filters.page ?? 1,
    limit: filters.limit ?? 20,
    ...(filters.search?.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.conditionCode ? { conditionCode: filters.conditionCode } : {}),
    ...(filters.certificateType ? { certificateType: filters.certificateType } : {}),
    ...(filters.type ? { type: filters.type.toLowerCase() as 'own' | 'in_transit' | 'virtual' } : {}),
    ...(filters.partCategory ? { partCategory: filters.partCategory } : {}),
    ...(filters.location ? { location: filters.location } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
  };
}

export function listInventory(filters: InventoryFilters = {}, signal?: AbortSignal) {
  return generatedQuery<InventoryListEnvelope>((client, requestSignal) => client.GET('/api/inventory', {
    params: { query: toQuery(filters) },
    signal: requestSignal,
  }), signal);
}

export function getInventory(id: string, signal?: AbortSignal) {
  return generatedQuery<InventoryEnvelope>((client, requestSignal) => client.GET('/api/inventory/{id}', {
    params: { path: { id } },
    signal: requestSignal,
  }), signal);
}

export function getInventoryItemByPartNumber(partNumber: string, signal?: AbortSignal) {
  return generatedQuery<InventoryItemRaw>((client, requestSignal) => client.GET('/api/inventory-items/part/{partNumber}', {
    params: { path: { partNumber } },
    signal: requestSignal,
  }), signal);
}

export function listInventoryTransactionsByOrder(orderId: string, signal?: AbortSignal) {
  return generatedQuery<InventoryTransactionListEnvelope>((client, requestSignal) => client.GET('/api/inventory-transactions/order/{orderId}', {
    params: { path: { orderId } },
    signal: requestSignal,
  }), signal);
}

export function createInventoryReservation(body: InventoryReserveRequest, signal?: AbortSignal, idempotencyKey?: string) {
  return generatedMutation<InventoryTransactionActionEnvelope>((client, requestSignal) => client.POST('/api/inventory-transactions/reserve', {
    body,
    signal: requestSignal,
  }), idempotencyKey, signal);
}

export function createInventoryOutbound(body: InventoryOutboundRequest, signal?: AbortSignal, idempotencyKey?: string) {
  return generatedMutation<InventoryTransactionActionEnvelope>((client, requestSignal) => client.POST('/api/inventory-transactions/outbound', {
    body,
    signal: requestSignal,
  }), idempotencyKey, signal);
}

export function createInventory(body: InventoryCreateRequest, signal?: AbortSignal) {
  return generatedQuery<InventoryEnvelope>((client, requestSignal) => client.POST('/api/inventory', {
    body,
    signal: requestSignal,
  }), signal);
}

export function updateInventory(id: string, body: InventoryUpdateRequest, signal?: AbortSignal) {
  return generatedQuery<InventoryEnvelope>((client, requestSignal) => client.PATCH('/api/inventory/{id}', {
    params: { path: { id } },
    body,
    signal: requestSignal,
  }), signal);
}
