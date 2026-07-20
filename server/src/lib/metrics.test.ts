import { afterEach, describe, expect, it } from 'vitest';
import { getMetricsSnapshot, recordDatabaseQuery, recordHttpRequest, resetMetrics } from './metrics.js';

describe('request metrics', () => {
  afterEach(() => resetMetrics());

  it('keeps bounded status and latency summaries without payload data', () => {
    recordHttpRequest(200, 12);
    recordHttpRequest(500, 80);
    recordHttpRequest(404, 40);

    expect(getMetricsSnapshot()).toEqual({
      requests: 3,
      errors: 1,
      byStatus: { '200': 1, '404': 1, '500': 1 },
      latencyMs: { p50: 40, p95: 80, samples: 3 },
      database: {
        queries: 0,
        errors: 0,
        latencyMs: { p50: 0, p95: 0, samples: 0 },
        slowQueries: 0,
      },
    });
  });

  it('records bounded database latency without storing SQL text', () => {
    for (let index = 0; index < 5; index += 1) recordDatabaseQuery(1500);
    const snapshot = getMetricsSnapshot();
    expect(snapshot.database).toEqual({
      queries: 5,
      errors: 0,
      latencyMs: { p50: 1500, p95: 1500, samples: 5 },
      slowQueries: 5,
    });
    expect(JSON.stringify(snapshot)).not.toContain('SELECT');
  });
});
