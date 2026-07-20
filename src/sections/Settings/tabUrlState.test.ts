import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSettingsTabFromUrl, setSettingsTabInUrl, subscribeToSettingsTabUrlChange } from './tabUrlState';

describe('Settings tab URL state', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/settings');
    vi.restoreAllMocks();
  });

  it('uses pushState for tab navigation and emits popstate-compatible updates', () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const listener = vi.fn();
    const unsubscribe = subscribeToSettingsTabUrlChange(listener);

    setSettingsTabInUrl('webhooks', 'push');

    expect(pushState).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?tab=webhooks');
    expect(getSettingsTabFromUrl()).toBe('webhooks');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
