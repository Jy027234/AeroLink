import { describe, expect, it } from 'vitest';
import {
  getCapabilitiesForActor,
  hasCapability,
  normalizeRole,
} from './capabilityPolicy.js';

describe('capability policy', () => {
  it('allows administrators every declared capability', () => {
    const actor = { id: 'admin-1', role: 'ADMIN' };

    expect(hasCapability(actor, 'webhook', 'delete')).toBe(true);
    expect(hasCapability(actor, 'session', 'manage')).toBe(true);
    expect(getCapabilitiesForActor(actor)).toHaveLength(27 * 15);
  });

  it('limits sales transaction access to resources they own', () => {
    const actor = { id: 'sales-1', role: 'sales', department: 'Sales' };

    expect(hasCapability(actor, 'rfq', 'read', { ownerId: 'sales-1' })).toBe(true);
    expect(hasCapability(actor, 'rfq', 'export', { ownerId: 'sales-1' })).toBe(true);
    expect(hasCapability(actor, 'rfq', 'export', { ownerId: 'sales-2' })).toBe(false);
    expect(hasCapability(actor, 'quotation', 'send', { ownerId: 'sales-1' })).toBe(true);
    expect(hasCapability(actor, 'quotation', 'read', { ownerId: 'sales-2', department: 'Sales' })).toBe(false);
    expect(hasCapability(actor, 'quotation', 'view_cost', { ownerId: 'sales-1' })).toBe(false);
    expect(hasCapability(actor, 'session', 'manage', { ownerId: 'sales-1' })).toBe(true);
    expect(hasCapability(actor, 'session', 'manage', { ownerId: 'sales-2' })).toBe(false);
  });

  it('allows managers to operate their department transactions but blocks cross-department access', () => {
    const actor = { id: 'manager-1', role: 'manager', department: 'Sales' };

    expect(hasCapability(actor, 'quotation', 'approve', { ownerId: 'sales-1', department: 'sales' })).toBe(true);
    expect(hasCapability(actor, 'order', 'export', { ownerId: 'sales-1', department: 'sales' })).toBe(true);
    expect(hasCapability(actor, 'order', 'update', { ownerId: 'ops-1', department: 'Operations' })).toBe(false);
    expect(hasCapability(actor, 'order', 'update', { ownerId: 'manager-1', department: 'Operations' })).toBe(true);
  });

  it('gives finance cost visibility without administrative configuration powers', () => {
    const actor = { id: 'finance-1', role: 'FINANCE' };

    expect(hasCapability(actor, 'quotation', 'view_cost')).toBe(true);
    expect(hasCapability(actor, 'quotation', 'export')).toBe(true);
    expect(hasCapability(actor, 'order', 'view_cost')).toBe(true);
    expect(hasCapability(actor, 'order', 'export')).toBe(true);
    expect(hasCapability(actor, 'customer', 'export')).toBe(false);
    expect(hasCapability(actor, 'report', 'export')).toBe(true);
    expect(hasCapability(actor, 'email_account', 'manage')).toBe(false);
  });

  it('normalizes legacy role spellings to the policy roles', () => {
    expect(normalizeRole('GENERAL_MANAGER')).toBe('gm');
    expect(normalizeRole('quality-manager')).toBe('quality_manager');
    expect(normalizeRole('unknown-role')).toBe('viewer');
  });
});
