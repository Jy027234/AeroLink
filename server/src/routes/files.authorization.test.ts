import { describe, expect, it } from 'vitest';
import { canReadStoredObject } from './files.js';

describe('stored object authorization', () => {
  it('allows the owner and privileged operators only', () => {
    expect(canReadStoredObject({ ownerId: 'user-1' }, { id: 'user-1', role: 'sales' })).toBe(true);
    expect(canReadStoredObject({ ownerId: 'user-1' }, { id: 'user-2', role: 'sales' })).toBe(false);
    expect(canReadStoredObject({ ownerId: null }, { id: 'user-2', role: 'sales' })).toBe(false);
    expect(canReadStoredObject({ ownerId: null }, { id: 'user-2', role: 'manager' })).toBe(true);
    expect(canReadStoredObject({ ownerId: null }, { id: 'user-2', role: 'ADMIN' })).toBe(true);
  });
});
