import crypto from 'node:crypto';
import { getRequestContext, runWithContext, type RequestContext } from './requestContext.js';

export type TraceSpanStatus = 'ok' | 'error';

export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: string;
  durationMs: number;
  status: TraceSpanStatus;
  attributes: Record<string, string | number | boolean>;
};

export type TraceExporter = (span: TraceSpan) => void | Promise<void>;

const spans: TraceSpan[] = [];
let exporter: TraceExporter | null = null;

function safeAttributeKey(key: string) {
  return !/authorization|cookie|password|token|secret|signature|payload|body|content/i.test(key);
}

function sanitizeAttributes(attributes: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(attributes)
    .filter(([key, value]) => safeAttributeKey(key) && ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => [key, value as string | number | boolean]));
}

function emit(span: TraceSpan) {
  spans.push(span);
  if (spans.length > 500) spans.shift();
  if (exporter) void Promise.resolve(exporter(span)).catch(() => undefined);
}

export function setTraceExporter(next: TraceExporter | null) {
  exporter = next;
}

export function getTraceSpans() {
  return spans.map((span) => ({ ...span, attributes: { ...span.attributes } }));
}

export function resetTraceSpans() {
  spans.length = 0;
}

export function getTraceId() {
  return getRequestContext()?.traceId;
}

export function beginTraceSpan(name: string, attributes: Record<string, unknown> = {}) {
  const parent = getRequestContext();
  const traceId = parent?.traceId ?? crypto.randomUUID();
  const spanId = crypto.randomUUID();
  const startedAt = Date.now();
  let ended = false;

  const end = (status: TraceSpanStatus = 'ok', extraAttributes: Record<string, unknown> = {}) => {
    if (ended) return;
    ended = true;
    emit({
      traceId,
      spanId,
      ...(parent?.spanId ? { parentSpanId: parent.spanId } : {}),
      name,
      startTime: new Date(startedAt).toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      status,
      attributes: sanitizeAttributes({ ...attributes, ...extraAttributes }),
    });
  };

  return { traceId, spanId, end };
}

export function traceSpan<T>(name: string, attributes: Record<string, unknown>, callback: () => T): T {
  const span = beginTraceSpan(name, attributes);
  const current = getRequestContext();
  const childContext: RequestContext = {
    requestId: current?.requestId ?? 'internal',
    traceId: span.traceId,
    spanId: span.spanId,
  };
  try {
    const result = runWithContext(childContext, callback);
    const promiseCandidate = result as unknown as { then?: unknown };
    if (result && typeof promiseCandidate.then === 'function') {
      return (result as unknown as Promise<unknown>)
        .then((value) => {
          span.end('ok');
          return value;
        })
        .catch((error) => {
          span.end('error', { error: error instanceof Error ? error.name : 'unknown' });
          throw error;
        }) as T;
    }
    span.end('ok');
    return result;
  } catch (error) {
    span.end('error', { error: error instanceof Error ? error.name : 'unknown' });
    throw error;
  }
}

/** Optional HTTP exporter; disabled unless an endpoint is explicitly configured. */
export function configureTraceExporterFromEnvironment() {
  const endpoint = process.env.TRACE_EXPORTER_URL?.trim();
  if (!endpoint) return;
  try {
    new URL(endpoint);
  } catch {
    return;
  }
  setTraceExporter((span) => fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resource: { service: 'aerolink-api' }, span }),
    signal: AbortSignal.timeout(1000),
  }).then(() => undefined).catch(() => undefined));
}
