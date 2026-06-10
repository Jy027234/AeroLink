type NavigationSource = 'sidebar' | 'programmatic' | 'boot';

type PerfMetricName = 'first_screen_ready' | 'page_navigation_ready';

interface PerfMetric {
  name: PerfMetricName;
  pageId: string;
  durationMs: number;
  source: NavigationSource;
  timestamp: string;
}

const appBootTs = performance.now();
const pendingNavigation = new Map<string, { startTs: number; source: NavigationSource }>();
const metricBuffer: PerfMetric[] = [];
let firstScreenCaptured = false;

function emitMetric(metric: PerfMetric): void {
  metricBuffer.push(metric);

  if (metricBuffer.length > 200) {
    metricBuffer.shift();
  }

  if (import.meta.env.DEV) {
    console.info('[perf]', metric.name, metric.pageId, `${metric.durationMs.toFixed(1)}ms`, metric.source);
  }

  window.dispatchEvent(new CustomEvent('aerolink:perf', { detail: metric }));
}

export function beginPageNavigation(pageId: string, source: NavigationSource): void {
  if (!pageId) {
    return;
  }

  pendingNavigation.set(pageId, {
    startTs: performance.now(),
    source,
  });
}

export function completePageNavigation(pageId: string): void {
  const pending = pendingNavigation.get(pageId);
  if (!pending) {
    return;
  }

  pendingNavigation.delete(pageId);

  emitMetric({
    name: 'page_navigation_ready',
    pageId,
    durationMs: performance.now() - pending.startTs,
    source: pending.source,
    timestamp: new Date().toISOString(),
  });
}

export function markFirstScreenReady(pageId: string): void {
  if (firstScreenCaptured) {
    return;
  }

  firstScreenCaptured = true;

  emitMetric({
    name: 'first_screen_ready',
    pageId,
    durationMs: performance.now() - appBootTs,
    source: 'boot',
    timestamp: new Date().toISOString(),
  });
}

export function getPerfMetrics(): PerfMetric[] {
  return [...metricBuffer];
}
