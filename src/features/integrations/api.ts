import type { components } from '@/api/generated/openapi';
import { generatedMutation, generatedQuery } from '@/api/generated/queryAdapter';

type DocumentTemplateListEnvelope = components['schemas']['DocumentTemplateListEnvelope'];
type NotificationDispatchEnvelope = components['schemas']['NotificationDispatchEnvelope'];
export type NotificationDispatchRequest = components['schemas']['NotificationDispatchRequest'];

export function listDocumentTemplates(documentType = 'ORDER_CONTRACT', signal?: AbortSignal) {
  return generatedQuery<DocumentTemplateListEnvelope>((client, requestSignal) => client.GET('/api/document-templates', {
    params: { query: { documentType } },
    signal: requestSignal,
  }), signal);
}

export function dispatchNotification(body: NotificationDispatchRequest, signal?: AbortSignal, idempotencyKey?: string) {
  return generatedMutation<NotificationDispatchEnvelope>((client, requestSignal) => client.POST('/api/notifications/dispatch', {
    body,
    signal: requestSignal,
  }), idempotencyKey, signal);
}
