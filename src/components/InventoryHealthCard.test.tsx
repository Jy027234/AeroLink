import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInventoryHealthSummary } from '@/hooks/useApi';
import { InventoryHealthCard } from './InventoryHealthCard';

vi.mock('@/hooks/useApi', () => ({
  useInventoryHealthSummary: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ locale: 'zh-CN' }),
}));

const mockedUseInventoryHealthSummary = vi.mocked(useInventoryHealthSummary);

describe('InventoryHealthCard', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps quantity health visible and renders a safe placeholder when cost is hidden', () => {
    mockedUseInventoryHealthSummary.mockReturnValue({
      loading: false,
      error: null,
      data: {
        totalItems: 3,
        criticalItems: 1,
        lowItems: 1,
        excessItems: 0,
        adequateItems: 1,
        totalInventoryValue: null,
        recommendations: [],
      },
      refetch: vi.fn(),
    });

    render(<InventoryHealthCard />);

    expect(screen.getByText('3 件号')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('充足')).toBeTruthy();
  });

  it('formats inventory value when the caller is allowed to view cost', () => {
    mockedUseInventoryHealthSummary.mockReturnValue({
      loading: false,
      error: null,
      data: {
        totalItems: 1,
        criticalItems: 0,
        lowItems: 0,
        excessItems: 0,
        adequateItems: 1,
        totalInventoryValue: 1234.5,
        recommendations: [],
      },
      refetch: vi.fn(),
    });

    render(<InventoryHealthCard />);

    expect(screen.getByText('$1,234.5')).toBeTruthy();
  });
});
