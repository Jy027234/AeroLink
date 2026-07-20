import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

export type RequestContext = {
  requestId: string;
  traceId: string;
  spanId?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(requestId: string, callback: () => T, traceId: string = crypto.randomUUID()): T {
  return storage.run({ requestId, traceId }, callback);
}

export function getRequestId() {
  return storage.getStore()?.requestId;
}

export function getTraceId() {
  return storage.getStore()?.traceId;
}

export function getRequestContext() {
  return storage.getStore();
}

export function runWithContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}
