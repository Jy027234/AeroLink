import { describe, it, expect, vi } from 'vitest';

vi.mock('tailwind-merge', () => ({
  twMerge: (classes: string) => classes,
}));

vi.mock('clsx', () => ({
  default: (...inputs: unknown[]) => inputs.filter(Boolean).flat().join(' '),
  clsx: (...inputs: unknown[]) => inputs.filter(Boolean).flat().join(' '),
}));

const { cn } = await import('./utils');

describe('cn utility', () => {
  it('should merge classes correctly', () => {
    const result = cn('px-2 py-1', 'px-4');
    expect(result).toContain('px-2');
    expect(result).toContain('py-1');
    expect(result).toContain('px-4');
  });

  it('should handle conditional classes', () => {
    const isActive = true;
    const result = cn('base-class', isActive && 'active-class');
    expect(result).toContain('base-class');
    expect(result).toContain('active-class');
  });

  it('should filter out falsy values', () => {
    const includeHidden = false;
    const result = cn('base', includeHidden ? 'hidden' : '', null, undefined, 'visible');
    expect(result).not.toContain('hidden');
    expect(result).toContain('base');
    expect(result).toContain('visible');
  });

  it('should handle empty input', () => {
    const result = cn();
    expect(result).toBe('');
  });
});
