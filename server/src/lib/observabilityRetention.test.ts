import { describe, expect, it } from 'vitest';
import { getObservabilityRetentionPolicy } from './observabilityRetention.js';

describe('observability retention contract', () => {
  it('allows the default exporter-off profile without retention settings', () => {
    expect(getObservabilityRetentionPolicy({})).toEqual({
      exporterEnabled: false,
      configured: true,
      issues: [],
    });
  });

  it('requires explicit retention values when an external exporter is enabled', () => {
    const policy = getObservabilityRetentionPolicy({ TRACE_EXPORTER_URL: 'https://collector.invalid/v1/traces' });
    expect(policy.configured).toBe(false);
    expect(policy.issues).toHaveLength(2);
  });

  it('rejects malformed retention values and accepts a complete profile', () => {
    expect(getObservabilityRetentionPolicy({
      TRACE_EXPORTER_URL: 'https://collector.invalid/v1/traces',
      OBSERVABILITY_METRICS_RETENTION_DAYS: 'seven',
      OBSERVABILITY_TRACE_RETENTION_HOURS: '24',
    }).issues).toContain('OBSERVABILITY_METRICS_RETENTION_DAYS must be a positive integer');

    expect(getObservabilityRetentionPolicy({
      TRACE_EXPORTER_URL: 'https://collector.invalid/v1/traces',
      OBSERVABILITY_METRICS_RETENTION_DAYS: '7',
      OBSERVABILITY_TRACE_RETENTION_HOURS: '24',
    })).toEqual({
      exporterEnabled: true,
      configured: true,
      metricsRetentionDays: 7,
      traceRetentionHours: 24,
      issues: [],
    });
  });
});
