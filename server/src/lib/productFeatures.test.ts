import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProductFeatureStatus, getProductFeatureStatuses } from './productFeatures.js';

describe('product feature flags', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults experimental product areas to disabled', () => {
    vi.stubEnv('FEATURE_PRICING_BI', '');
    vi.stubEnv('FEATURE_AGENT_DEMO', '');

    expect(getProductFeatureStatuses()).toEqual([
      expect.objectContaining({ key: 'pricingBi', enabled: false, environmentVariable: 'FEATURE_PRICING_BI' }),
      expect.objectContaining({ key: 'agentDemo', enabled: false, environmentVariable: 'FEATURE_AGENT_DEMO' }),
    ]);
  });

  it('accepts only an explicit true value to enable a feature', () => {
    vi.stubEnv('FEATURE_PRICING_BI', 'TRUE');
    vi.stubEnv('FEATURE_AGENT_DEMO', '1');

    expect(getProductFeatureStatus('pricingBi').enabled).toBe(true);
    expect(getProductFeatureStatus('agentDemo').enabled).toBe(false);
  });
});
