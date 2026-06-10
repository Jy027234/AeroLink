import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIsMobile } from './use-mobile';
import { Window } from 'happy-dom';

const win = new Window({ width: 1024, height: 768 });
const testGlobal = globalThis as typeof globalThis & { window: Window; document: Document };
testGlobal.window = win;
testGlobal.document = win.document;

describe('useIsMobile', () => {
  let originalMatchMedia: typeof win.matchMedia;

  beforeEach(() => {
    originalMatchMedia = testGlobal.window.matchMedia;
  });

  afterEach(() => {
    testGlobal.window.matchMedia = originalMatchMedia;
  });

  it('should return true when screen width is below 768px', () => {
    testGlobal.window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    Object.defineProperty(testGlobal.window, 'innerWidth', { value: 500, writable: true });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('should return false when screen width is above 768px', () => {
    testGlobal.window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    Object.defineProperty(testGlobal.window, 'innerWidth', { value: 1024, writable: true });

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });
});
