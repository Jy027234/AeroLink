import { describe, expect, it } from 'vitest';
import {
  getCapabilitiesForActor,
  hasCapability,
  normalizeRole,
  CAPABILITY_RESOURCES,
  CAPABILITY_ACTIONS,
} from './capabilityPolicy.js';

describe('capability policy', () => {
  it('allows administrators every declared capability', () => {
    const actor = { id: 'admin-1', role: 'ADMIN' };

    expect(hasCapability(actor, 'webhook', 'delete')).toBe(true);
    expect(hasCapability(actor, 'session', 'manage')).toBe(true);
    expect(getCapabilitiesForActor(actor)).toHaveLength(CAPABILITY_RESOURCES.length * CAPABILITY_ACTIONS.length);
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
    expect(hasCapability(actor, 'quotation', 'approve')).toBe(true);
    expect(hasCapability(actor, 'quotation', 'export')).toBe(true);
    expect(hasCapability(actor, 'order', 'view_cost')).toBe(true);
    expect(hasCapability(actor, 'order', 'export')).toBe(true);
    expect(hasCapability(actor, 'inventory', 'read')).toBe(true);
    expect(hasCapability(actor, 'inventory', 'view_cost')).toBe(true);
    expect(hasCapability(actor, 'report', 'view_cost')).toBe(true);
    expect(hasCapability(actor, 'customer', 'export')).toBe(false);
    expect(hasCapability(actor, 'report', 'export')).toBe(true);
    expect(hasCapability(actor, 'email_account', 'manage')).toBe(false);
  });

  it('separates ordinary inventory reads from cost visibility', () => {
    const readOnlyRoles = ['sales', 'operator', 'viewer', 'quality_manager'];
    for (const role of readOnlyRoles) {
      const actor = { id: `${role}-1`, role };
      expect(hasCapability(actor, 'inventory', 'read')).toBe(true);
      expect(hasCapability(actor, 'inventory', 'view_cost')).toBe(false);
      expect(hasCapability(actor, 'report', 'view_cost')).toBe(false);
    }

    for (const role of ['manager', 'finance', 'gm', 'admin']) {
      const actor = { id: `${role}-1`, role };
      expect(hasCapability(actor, 'inventory', 'view_cost')).toBe(true);
      expect(hasCapability(actor, 'report', 'view_cost')).toBe(true);
    }
  });

  it('normalizes legacy role spellings to the policy roles', () => {
    expect(normalizeRole('GENERAL_MANAGER')).toBe('gm');
    expect(normalizeRole('quality-manager')).toBe('quality_manager');
    expect(normalizeRole('unknown-role')).toBe('viewer');
  });

  it('separates procurement operations, financial recording and quality reads', () => {
    const manager = { id: 'manager', role: 'MANAGER', department: 'Sales' };
    const finance = { id: 'finance', role: 'FINANCE' };
    const quality = { id: 'quality', role: 'QUALITY_MANAGER' };
    const ownedOrder = { ownerId: 'sales', department: 'Sales' };
    expect(hasCapability(manager, 'purchase_commitment', 'create', ownedOrder)).toBe(true);
    expect(hasCapability(manager, 'purchase_commitment', 'create', { ownerId: 'other', department: 'Other' })).toBe(false);
    expect(hasCapability(manager, 'settlement', 'create', ownedOrder)).toBe(false);
    expect(hasCapability(finance, 'purchase_commitment', 'approve')).toBe(true);
    expect(hasCapability(finance, 'purchase_commitment', 'create')).toBe(false);
    expect(hasCapability(finance, 'settlement', 'create')).toBe(true);
    expect(hasCapability(finance, 'settlement', 'reconcile')).toBe(true);
    expect(hasCapability(quality, 'purchase_commitment', 'read')).toBe(true);
    expect(hasCapability(quality, 'purchase_commitment', 'view_cost')).toBe(false);
    expect(hasCapability(quality, 'settlement', 'read')).toBe(false);
    const sales = { id: 'sales', role: 'SALES' };
    expect(hasCapability(sales, 'settlement', 'read', ownedOrder)).toBe(true);
    expect(hasCapability(sales, 'settlement', 'read', { ownerId: 'other' })).toBe(false);
    expect(hasCapability(sales, 'purchase_commitment', 'view_cost', ownedOrder)).toBe(false);
    expect(hasCapability(sales, 'settlement', 'view_cost', ownedOrder)).toBe(false);
  });
});
