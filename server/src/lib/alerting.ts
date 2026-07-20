import crypto from 'node:crypto';

export type OperationalAlertSeverity = 'warning' | 'critical';

export type OperationalAlert = {
  id: string;
  key: string;
  severity: OperationalAlertSeverity;
  title: string;
  message: string;
  source: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  metadata: Record<string, string | number | boolean>;
};

type MetricsLike = {
  requests: number;
  errors: number;
  latencyMs: { p95: number };
  database?: {
    queries: number;
    errors: number;
    latencyMs: { p95: number };
  };
};

const alerts = new Map<string, OperationalAlert>();

function safeMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(metadata)
    .filter(([key]) => !/authorization|cookie|password|token|secret|payload|body/i.test(key))
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => [key, value as string | number | boolean]));
}

export function recordOperationalAlert(input: {
  key: string;
  severity: OperationalAlertSeverity;
  title: string;
  message: string;
  source: string;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  const existing = alerts.get(input.key);
  const alert: OperationalAlert = {
    id: existing?.id ?? crypto.randomUUID(),
    key: input.key,
    severity: input.severity,
    title: input.title,
    message: input.message.slice(0, 500),
    source: input.source,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    ...(existing?.resolvedAt ? {} : {}),
    metadata: safeMetadata(input.metadata ?? {}),
  };
  alerts.set(input.key, alert);
  return alert;
}

export function resolveOperationalAlert(key: string) {
  const existing = alerts.get(key);
  if (!existing || existing.resolvedAt) return existing;
  const resolved = { ...existing, resolvedAt: new Date().toISOString() };
  alerts.set(key, resolved);
  return resolved;
}

export function evaluateMetricAlerts(metrics: MetricsLike) {
  const errorRate = metrics.requests > 0 ? metrics.errors / metrics.requests : 0;
  if (metrics.requests >= 10 && errorRate >= 0.05) {
    recordOperationalAlert({
      key: 'api.error-rate',
      severity: errorRate >= 0.2 ? 'critical' : 'warning',
      title: 'API error rate above threshold',
      message: `HTTP 5xx error rate is ${(errorRate * 100).toFixed(1)}%.`,
      source: 'api.metrics',
      metadata: { requests: metrics.requests, errors: metrics.errors, errorRate: Number(errorRate.toFixed(4)) },
    });
  } else {
    resolveOperationalAlert('api.error-rate');
  }

  if (metrics.latencyMs.p95 >= 1000) {
    recordOperationalAlert({
      key: 'api.latency-p95',
      severity: metrics.latencyMs.p95 >= 3000 ? 'critical' : 'warning',
      title: 'API p95 latency above threshold',
      message: `HTTP p95 latency is ${metrics.latencyMs.p95}ms.`,
      source: 'api.metrics',
      metadata: { p95Ms: metrics.latencyMs.p95 },
    });
  } else {
    resolveOperationalAlert('api.latency-p95');
  }

  const database = metrics.database;
  if (database && database.queries >= 5 && database.latencyMs.p95 >= 1000) {
    recordOperationalAlert({
      key: 'database.latency-p95',
      severity: database.latencyMs.p95 >= 3000 ? 'critical' : 'warning',
      title: 'Database p95 latency above threshold',
      message: `Database p95 latency is ${database.latencyMs.p95}ms.`,
      source: 'database.metrics',
      metadata: { queries: database.queries, p95Ms: database.latencyMs.p95 },
    });
  } else {
    resolveOperationalAlert('database.latency-p95');
  }

  if (database && database.queries >= 10 && database.errors / database.queries >= 0.05) {
    recordOperationalAlert({
      key: 'database.error-rate',
      severity: database.errors / database.queries >= 0.2 ? 'critical' : 'warning',
      title: 'Database error rate above threshold',
      message: `Database error rate is ${((database.errors / database.queries) * 100).toFixed(1)}%.`,
      source: 'database.metrics',
      metadata: { queries: database.queries, errors: database.errors },
    });
  } else {
    resolveOperationalAlert('database.error-rate');
  }

  return getOperationalAlerts();
}

export function getOperationalAlerts() {
  return [...alerts.values()]
    .filter((alert) => !alert.resolvedAt)
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
}

export function resetOperationalAlerts() {
  alerts.clear();
}
