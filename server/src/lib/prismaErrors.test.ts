import { describe, expect, it } from 'vitest';
import { isUniqueConstraintError } from './prismaErrors.js';

describe('Prisma error helpers', () => {
  it('recognizes unique constraint errors from Prisma and test doubles', () => {
    expect(isUniqueConstraintError({ code: 'P2002' })).toBe(true);
    expect(isUniqueConstraintError({ code: 'P2025' })).toBe(false);
    expect(isUniqueConstraintError(new Error('duplicate'))).toBe(false);
  });
});
