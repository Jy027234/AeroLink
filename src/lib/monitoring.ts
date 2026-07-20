export type FrontendMetric = {
  name: string;
  value: number;
  timestamp: string;
  page?: string;
};

const metricBuffer: FrontendMetric[] = [];
let installed = false;

function sanitize(value: string) {
  return value.replace(/(token|password|secret|cookie|signature)=([^&\s]+)/gi, '$1=[REDACTED]');
}

function emit(event: string, detail: unknown) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

export function recordFrontendMetric(name: string, value: number, page = window.location.pathname): FrontendMetric {
  const metric = { name, value: Math.max(0, Math.round(value * 100) / 100), timestamp: new Date().toISOString(), page };
  metricBuffer.push(metric);
  if (metricBuffer.length > 200) metricBuffer.shift();
  emit('aerolink:frontend-metric', metric);
  return metric;
}

export function reportFrontendError(error: unknown, context: Record<string, unknown> = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const payload = {
    message: sanitize(message),
    ...(stack ? { stack: sanitize(stack) } : {}),
    context: Object.fromEntries(Object.entries(context).filter(([key]) => !/body|payload|password|token|secret/i.test(key))),
    timestamp: new Date().toISOString(),
    page: typeof window === 'undefined' ? undefined : window.location.pathname,
  };
  emit('aerolink:frontend-error', payload);
  return payload;
}

export function getFrontendMetrics() {
  return [...metricBuffer];
}

export function installFrontendMonitoring() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    reportFrontendError(event.error || event.message, { source: 'window.error' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportFrontendError(event.reason, { source: 'unhandledrejection' });
  });

  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'largest-contentful-paint') recordFrontendMetric('web_vital_lcp', entry.startTime);
        if (entry.entryType === 'layout-shift' && !(entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput) {
          recordFrontendMetric('web_vital_cls', (entry as PerformanceEntry & { value?: number }).value || 0);
        }
      }
    });
    observer.observe({ type: 'largest-contentful-paint', buffered: true });
    observer.observe({ type: 'layout-shift', buffered: true });
  } catch {
    // Unsupported browsers simply keep error and navigation metrics.
  }
}
