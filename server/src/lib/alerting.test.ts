import { afterEach, describe, expect, it } from 'vitest';
import { evaluateMetricAlerts, getOperationalAlerts, recordOperationalAlert, resetOperationalAlerts } from './alerting.js';

describe('operational alert thresholds', () => {
  afterEach(() => resetOperationalAlerts());

  it('opens and resolves an API error-rate alert from aggregate metrics', () => {
    expect(evaluateMetricAlerts({ requests: 10, errors: 2, latencyMs: { p95: 20 } })).toEqual([
      expect.objectContaining({ key: 'api.error-rate', severity: 'critical' }),
    ]);
    expect(evaluateMetricAlerts({ requests: 10, errors: 0, latencyMs: { p95: 20 } })).toEqual([]);
  });

  it('redacts sensitive metadata from synthetic worker/object alerts', () => {
    recordOperationalAlert({
      key: 'worker.test',
      severity: 'critical',
      title: 'Synthetic failure',
      message: 'failure',
      source: 'test',
      metadata: { jobId: 'job-1', token: 'secret', payload: 'private' },
    });
    expect(getOperationalAlerts()[0]).toMatchObject({ metadata: { jobId: 'job-1' } });
    expect(JSON.stringify(getOperationalAlerts())).not.toContain('secret');
    expect(JSON.stringify(getOperationalAlerts())).not.toContain('private');
  });

  it('opens a database latency alert from synthetic slow-query metrics', () => {
    const alerts = evaluateMetricAlerts({
      requests: 10,
      errors: 0,
      latencyMs: { p95: 20 },
      database: { queries: 5, errors: 0, latencyMs: { p95: 1500 } },
    });
    expect(alerts).toEqual([
      expect.objectContaining({ key: 'database.latency-p95', severity: 'warning' }),
    ]);
  });
});
