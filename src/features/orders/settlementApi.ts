import type { components } from '@/api/generated/openapi';
import { generatedMutation, generatedQuery } from '@/api/generated/queryAdapter';
import { newCommandKey } from '@/lib/commandKey';

type Schema = components['schemas'];

export type SettlementCreateRequest = Schema['SettlementCreateRequest'];
export type SettlementRecordRequest = Schema['SettlementRecordRequest'];

export const settlementApi = {
  list: async (orderId: string) => (await generatedQuery(client => client.GET('/api/settlements', {
    params: { query: { orderId } },
  }))).data,
  get: async (id: string) => (await generatedQuery(client => client.GET('/api/settlements/{id}', {
    params: { path: { id } },
  }))).data,
  create: async (body: SettlementCreateRequest, key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/settlements', {
    params: { header: { 'Idempotency-Key': key } }, body,
  }), key)).data,
  appendRecord: async (id: string, body: SettlementRecordRequest, key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/settlements/{id}/records', {
    params: { path: { id }, header: { 'Idempotency-Key': key } }, body,
  }), key)).data,
};

// Use the generated client's readable response types. Its Readable transform
// omits null-only properties; the wire contract still preserves AR's null purchase ID.
export type SettlementAccount = Awaited<ReturnType<typeof settlementApi.get>>;
export type SettlementRecord = SettlementAccount['records'][number];
export type SettlementOrderList = Awaited<ReturnType<typeof settlementApi.list>>;
