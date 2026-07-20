import { describe, expect, it } from 'vitest';
import { getLegacyUploadDecision } from './legacyUploads.js';

describe('legacy upload authorization', () => {
  it('keeps unmigrated legacy files restricted to managers and admins', () => {
    expect(getLegacyUploadDecision(null, { id: 'sales-1', role: 'sales' })).toBe('not_found');
    expect(getLegacyUploadDecision(null, { id: 'manager-1', role: 'manager' })).toBe('allow');
    expect(getLegacyUploadDecision(null, { id: 'admin-1', role: 'ADMIN' })).toBe('allow');
  });

  it('uses StoredObject ownership for migrated files', () => {
    const storedObject = { ownerId: 'owner-1', status: 'AVAILABLE' };
    expect(getLegacyUploadDecision(storedObject, { id: 'owner-1', role: 'sales' })).toBe('allow');
    expect(getLegacyUploadDecision(storedObject, { id: 'other-1', role: 'sales' })).toBe('forbidden');
    expect(getLegacyUploadDecision(storedObject, { id: 'other-1', role: 'manager' })).toBe('allow');
  });

  it('does not resurrect deleted or unavailable objects', () => {
    expect(getLegacyUploadDecision({ ownerId: 'owner-1', status: 'DELETED' }, { id: 'owner-1', role: 'sales' })).toBe('not_found');
  });
});
