import { describe, expect, it, vi } from 'vitest';
import { recordFrontendMetric, reportFrontendError } from './monitoring';

describe('frontend monitoring adapter', () => {
  it('redacts credential-like values and emits bounded metrics', () => {
    const errorEvent = vi.fn();
    window.addEventListener('aerolink:frontend-error', errorEvent);
    const payload = reportFrontendError(new Error('password=plain&token=abc'), { payload: 'sensitive' });
    const metric = recordFrontendMetric('web_vital_lcp', 123.456, '/rfq');

    expect(payload.message).toContain('password=[REDACTED]');
    expect(payload.message).toContain('token=[REDACTED]');
    expect(payload.context).toEqual({});
    expect(metric).toMatchObject({ name: 'web_vital_lcp', value: 123.46, page: '/rfq' });
    expect(errorEvent).toHaveBeenCalledTimes(1);
    window.removeEventListener('aerolink:frontend-error', errorEvent);
  });
});
