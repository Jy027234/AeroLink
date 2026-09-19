import type { components } from '@/api/generated/openapi';
import { generatedMutation, generatedQuery } from '@/api/generated/queryAdapter';
import { newCommandKey } from '@/lib/commandKey';

type Schema = components['schemas'];
export type PurchaseCommitment = Schema['PurchaseCommitment'];
export type ReceiptPhysical = Schema['StockReceiptPhysical'];
export type StockReceipt = Schema['StockReceipt'];
export type DirectShipment = Schema['DirectShipment'];

export const procurementApi = {
  list: async (orderId: string) => (await generatedQuery(client => client.GET('/api/purchase-commitments', { params: { query: { orderId } } }))).data,
  create: async (body: Schema['PurchaseCommitmentCreateRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/purchase-commitments', { params: { header: { 'Idempotency-Key': key } }, body }), key)).data,
  submit: async (id: string, body: Schema['PurchaseCommitmentTransitionRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/purchase-commitments/{id}/submit', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body }), key)).data,
  approve: async (id: string, body: Schema['PurchaseCommitmentTransitionRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/purchase-commitments/{id}/approve', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body }), key)).data,
  reject: async (id: string, body: Schema['PurchaseCommitmentTransitionRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/purchase-commitments/{id}/reject', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body }), key)).data,
  cancel: async (id: string, body: Schema['PurchaseCommitmentTransitionRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/purchase-commitments/{id}/cancel', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body }), key)).data,
  confirm: async (id: string, body: Schema['PurchaseCommitmentConfirmRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/purchase-commitments/{id}/confirm', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body }), key)).data,
};

export const stockReceiptApi = {
  list: async (orderId: string) => (await generatedQuery(client => client.GET('/api/stock-receipts', { params: { query: { orderId } } }))).data,
  create: async (body: Schema['StockReceiptArrival'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/stock-receipts', { params: { header: { 'Idempotency-Key': key } }, body }), key)).data,
  context: async (id: string) => (await generatedQuery(client => client.GET('/api/stock-receipts/lines/{id}/review-context', { params: { path: { id } } }))).data,
  review: async (id: string, body: Schema['StockReceiptReview'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/stock-receipts/lines/{id}/review', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body }), key)).data,
};

export const directShipmentApi = {
  list: async (orderId: string) => (await generatedQuery(client => client.GET('/api/direct-shipments', { params: { query: { orderId } } }))).data,
  create: async (body: Schema['DirectShipmentCreateRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/direct-shipments', { params: { header: { 'Idempotency-Key': key } }, body }), key)).data,
  context: async (id: string) => (await generatedQuery(client => client.GET('/api/direct-shipments/lines/{id}/review-context', { params: { path: { id } } }))).data,
  review: async (id: string, body: Schema['DirectShipmentReviewRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/direct-shipments/lines/{id}/review', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body }), key)).data,
  dispatch: async (id: string, body: Schema['DirectShipmentActionRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/direct-shipments/{id}/dispatch', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body }), key)).data,
  cancel: async (id: string, body: Schema['DirectShipmentActionRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/direct-shipments/{id}/cancel', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body }), key)).data,
  receive: async (id: string, body: Schema['DirectShipmentReceiptRequest'], key = newCommandKey()) => (await generatedMutation(client => client.POST('/api/direct-shipments/lines/{id}/receipt', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body }), key)).data,
};
