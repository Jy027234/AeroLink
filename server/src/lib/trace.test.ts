import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from './requestContext.js';
import { getTraceSpans, resetTraceSpans, setTraceExporter, traceSpan } from './trace.js';

describe('trace correlation', () => {
  afterEach(() => {
    resetTraceSpans();
    setTraceExporter(null);
  });

  it('records bounded spans with request correlation and redacted attributes', async () => {
    const exporter = vi.fn();
    setTraceExporter(exporter);

    await runWithRequestContext('request-123', () => traceSpan('quotation.service', {
      aggregateId: 'quote-1',
      token: 'do-not-export',
      body: 'do-not-export',
    }, async () => undefined));

    const [span] = getTraceSpans();
    expect(span).toMatchObject({ name: 'quotation.service', status: 'ok', attributes: { aggregateId: 'quote-1' } });
    expect(span?.attributes).not.toHaveProperty('token');
    expect(span?.attributes).not.toHaveProperty('body');
    expect(exporter).toHaveBeenCalledWith(span);
  });

  it('marks failed spans without leaking the error message', () => {
    expect(() => runWithRequestContext('request-456', () => traceSpan('worker.job', {}, () => {
      throw new Error('secret=must-not-be-exported');
    }))).toThrow('secret=must-not-be-exported');

    expect(getTraceSpans()[0]).toMatchObject({ name: 'worker.job', status: 'error' });
    expect(JSON.stringify(getTraceSpans())).not.toContain('must-not-be-exported');
  });
});
