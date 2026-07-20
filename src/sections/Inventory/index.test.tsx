import { describe, expect, it } from 'vitest';
import { getCertConfig, getStatusConfig } from './inventoryConfig';

describe('inventory display configuration', () => {
  it('keeps rendering when the API returns an unknown certificate type', () => {
    expect(getCertConfig('IN_TRANSIT')).toEqual({
      label: 'IN_TRANSIT',
      color: 'text-gray-600',
    });
  });

  it('keeps rendering when the API returns an unknown condition code', () => {
    expect(getStatusConfig('FUTURE_CONDITION')).toEqual({
      label: 'FUTURE_CONDITION',
      color: 'text-gray-600',
      bgColor: 'bg-gray-50',
    });
  });

  it('preserves the configured styles for known values', () => {
    expect(getCertConfig('FAA-8130-3')).toEqual({
      label: 'FAA 8130-3',
      color: 'text-green-600',
    });
    expect(getStatusConfig('NE')).toEqual({
      label: 'New',
      color: 'text-green-600',
      bgColor: 'bg-green-50',
    });
  });
});
