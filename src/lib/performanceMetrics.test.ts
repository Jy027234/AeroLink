import { describe, expect, it, vi } from 'vitest';
import { beginPageNavigation, completePageNavigation, getPerfMetrics, markFirstScreenReady } from './performanceMetrics';

describe('frontend navigation performance instrumentation', () => {
  it('emits bounded first-screen and page-ready measurements without payloads', () => {
    const event = vi.fn();
    window.addEventListener('aerolink:perf', event);

    beginPageNavigation('rfq-management', 'programmatic');
    completePageNavigation('rfq-management');
    markFirstScreenReady('rfq-management');

    const metrics = getPerfMetrics();
    expect(metrics.some((metric) => metric.name === 'page_navigation_ready' && metric.pageId === 'rfq-management')).toBe(true);
    expect(metrics.some((metric) => metric.name === 'first_screen_ready' && metric.pageId === 'rfq-management')).toBe(true);
    expect(event).toHaveBeenCalled();
    expect(JSON.stringify(metrics)).not.toContain('password');
    window.removeEventListener('aerolink:perf', event);
  });
});
