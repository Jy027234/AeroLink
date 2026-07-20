import assert from 'node:assert/strict';
import {
  getOperationalAlerts,
  resetOperationalAlerts,
  recordOperationalAlert,
} from '../lib/alerting.js';
import { getMetricsWithAlerts, resetMetrics, recordDatabaseQuery, recordHttpRequest } from '../lib/metrics.js';
import { getTraceSpans, resetTraceSpans, setTraceExporter, traceSpan } from '../lib/trace.js';
import { runWithRequestContext } from '../lib/requestContext.js';

async function main() {
  resetMetrics();
  resetOperationalAlerts();
  resetTraceSpans();

  const exportedSpans: unknown[] = [];
  setTraceExporter((span) => {
    exportedSpans.push(span);
  });

  await runWithRequestContext('synthetic-request-p2-07', () => traceSpan('synthetic.fault', {
    component: 'observability-check',
    token: 'must-not-be-exported',
  }, async () => undefined));

  for (let index = 0; index < 20; index += 1) {
    recordHttpRequest(index < 2 ? 500 : 200, index < 2 ? 40 : 12);
  }
  for (let index = 0; index < 5; index += 1) recordDatabaseQuery(1500);

  const metricSnapshot = getMetricsWithAlerts();
  const errorRateAlert = metricSnapshot.alerts.find((alert) => alert.key === 'api.error-rate');
  assert.ok(errorRateAlert, '5xx synthetic fault should open an API error-rate alert');
  const databaseLatencyAlert = metricSnapshot.alerts.find((alert) => alert.key === 'database.latency-p95');
  assert.ok(databaseLatencyAlert, 'slow database synthetic fault should open a database latency alert');

  const trace = getTraceSpans()[0];
  assert.ok(trace, 'synthetic request should emit a trace span');
  assert.match(trace?.traceId ?? '', /^[0-9a-f-]{36}$/i);
  assert.equal(exportedSpans.length, 1);
  assert.equal('token' in (trace?.attributes ?? {}), false);

  recordOperationalAlert({
    key: 'synthetic.redaction',
    severity: 'warning',
    title: 'Synthetic redaction check',
    message: 'Synthetic alert for P2-07 acceptance evidence.',
    source: 'observability-check',
    metadata: { objectId: 'safe-id', password: 'must-not-be-exported' },
  });
  const redactionAlert = getOperationalAlerts().find((alert) => alert.key === 'synthetic.redaction');
  assert.ok(redactionAlert);
  assert.equal('password' in (redactionAlert?.metadata ?? {}), false);

  recordOperationalAlert({
    key: 'object-storage.missing-object',
    severity: 'critical',
    title: 'Object storage object missing',
    message: 'Synthetic missing-object fault for P2-07 acceptance evidence.',
    source: 'object-storage',
    metadata: { objectId: 'synthetic-object-1' },
  });
  const objectMissingAlert = getOperationalAlerts().find((alert) => alert.key === 'object-storage.missing-object');
  assert.ok(objectMissingAlert);

  console.log(JSON.stringify({
    status: 'PASS',
    metrics: {
      requests: metricSnapshot.requests,
      errors: metricSnapshot.errors,
      database: metricSnapshot.database,
      activeAlertKeys: metricSnapshot.alerts.map((alert) => alert.key),
    },
    trace: {
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      exportedSpans: exportedSpans.length,
      redacted: !('token' in (trace?.attributes ?? {})),
    },
    alertRedaction: !('password' in (redactionAlert?.metadata ?? {})),
    objectMissingAlert: Boolean(objectMissingAlert),
  }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => setTraceExporter(null));
