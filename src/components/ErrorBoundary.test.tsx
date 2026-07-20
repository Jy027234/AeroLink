import { render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { ErrorBoundary } from './ErrorBoundary';

function ExplodingView() {
  throw new Error('render-failure');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('captures a render fault, reports it through the monitoring boundary and shows recovery UI', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <I18nProvider>
        <ErrorBoundary>
          <ExplodingView />
        </ErrorBoundary>
      </I18nProvider>,
    );

    expect(screen.getByText('render-failure')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    const captured = JSON.parse(localStorage.getItem('aerolink_errors') || '[]') as Array<{ message: string }>;
    expect(captured).toHaveLength(1);
    expect(captured[0]?.message).toBe('render-failure');
  });
});
