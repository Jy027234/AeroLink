import type { NextFunction, Request, Response } from 'express';
import { evaluateMetricAlerts } from './alerting.js';

type HttpMetrics = {
  requests: number;
  errors: number;
  byStatus: Record<string, number>;
  durationsMs: number[];
};

type DatabaseMetrics = {
  queries: number;
  errors: number;
  durationsMs: number[];
};

const metrics: HttpMetrics = {
  requests: 0,
  errors: 0,
  byStatus: {},
  durationsMs: [],
};

const databaseMetrics: DatabaseMetrics = {
  queries: 0,
  errors: 0,
  durationsMs: [],
};

export function recordHttpRequest(statusCode: number, durationMs: number) {
  metrics.requests += 1;
  if (statusCode >= 500) metrics.errors += 1;
  const status = String(statusCode);
  metrics.byStatus[status] = (metrics.byStatus[status] || 0) + 1;
  metrics.durationsMs.push(Math.max(0, Math.round(durationMs)));
  if (metrics.durationsMs.length > 1000) metrics.durationsMs.shift();
}

export function recordDatabaseQuery(durationMs: number, status: 'ok' | 'error' = 'ok') {
  databaseMetrics.queries += 1;
  if (status === 'error') databaseMetrics.errors += 1;
  databaseMetrics.durationsMs.push(Math.max(0, Math.round(durationMs)));
  if (databaseMetrics.durationsMs.length > 1000) databaseMetrics.durationsMs.shift();
}

function latencySummary(values: number[]) {
  const durations = [...values].sort((a, b) => a - b);
  const percentile = (value: number) => durations.length === 0
    ? 0
    : durations[Math.min(durations.length - 1, Math.floor(durations.length * value))];
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    samples: durations.length,
  };
}

export function getMetricsSnapshot() {
  return {
    requests: metrics.requests,
    errors: metrics.errors,
    byStatus: { ...metrics.byStatus },
    latencyMs: latencySummary(metrics.durationsMs),
    database: {
      queries: databaseMetrics.queries,
      errors: databaseMetrics.errors,
      latencyMs: latencySummary(databaseMetrics.durationsMs),
      slowQueries: databaseMetrics.durationsMs.filter((duration) => duration >= 1000).length,
    },
  };
}

export function getMetricsWithAlerts() {
  const snapshot = getMetricsSnapshot();
  return { ...snapshot, alerts: evaluateMetricAlerts(snapshot) };
}

export function resetMetrics() {
  metrics.requests = 0;
  metrics.errors = 0;
  metrics.byStatus = {};
  metrics.durationsMs = [];
  databaseMetrics.queries = 0;
  databaseMetrics.errors = 0;
  databaseMetrics.durationsMs = [];
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => recordHttpRequest(res.statusCode, Date.now() - start));
  next();
}
