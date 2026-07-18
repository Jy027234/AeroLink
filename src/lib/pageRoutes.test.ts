import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE,
  getPathnameForPage,
  isKnownPagePath,
  resolvePageFromPathname,
} from './pageRoutes';

describe('pageRoutes', () => {
  it('uses dashboard as the default page', () => {
    expect(resolvePageFromPathname('/')).toBe(DEFAULT_PAGE);
    expect(resolvePageFromPathname('/unknown-page')).toBe(DEFAULT_PAGE);
  });

  it('maps known pages to their canonical pathnames', () => {
    expect(getPathnameForPage('orders')).toBe('/orders');
    expect(getPathnameForPage('dashboard')).toBe('/dashboard');
    expect(getPathnameForPage('supplier-portal')).toBe('/supplier-information');
  });

  it('recognizes known paths with or without a trailing slash', () => {
    expect(resolvePageFromPathname('/supplier-quotes/')).toBe('supplier-quotes');
    expect(isKnownPagePath('/supplier-quotes/')).toBe(true);
    expect(resolvePageFromPathname('/supplier-portal/')).toBe('supplier-portal');
    expect(isKnownPagePath('/supplier-portal/')).toBe(true);
  });
});
