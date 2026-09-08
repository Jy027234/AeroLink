import { describe, expect, it } from 'vitest';
import type { Supplier } from '@/types';
import {
  AGENT_RUNTIME_EXECUTION_ENABLED,
  getTaskExecutionState,
  resolveUniqueSupplierIdentity,
} from './agentOrchestrator';

function supplier(overrides: Partial<Supplier>): Supplier {
  return {
    id: 'supplier-1',
    name: 'Acme Aviation',
    supplierType: 'Distributor',
    level: 'A',
    ...overrides,
  } as Supplier;
}

describe('agent runtime execution state', () => {
  it('does not treat manual hand-offs as executed work', () => {
    expect(getTaskExecutionState({ executionState: 'manual_workflow_required' })).toBe('manual_workflow_required');
    expect(getTaskExecutionState({ approvalStatus: 'manual_workflow_required' })).toBe('manual_workflow_required');
    expect(getTaskExecutionState({ orderStatus: 'manual_workflow_required' })).toBe('manual_workflow_required');
    expect(getTaskExecutionState({ notificationStatus: 'not_dispatched' })).toBe('not_dispatched');
    expect(getTaskExecutionState({ dispatchStatus: 'not_dispatched' })).toBe('not_dispatched');
  });

  it('ignores unrelated response values', () => {
    expect(getTaskExecutionState({ approvalStatus: 'approved' })).toBeUndefined();
    expect(getTaskExecutionState({ message: 'manual_workflow_required' })).toBeUndefined();
    expect(getTaskExecutionState(undefined)).toBeUndefined();
  });

  it('keeps the client runtime execution gate closed', () => {
    expect(AGENT_RUNTIME_EXECUTION_ENABLED).toBe(false);
  });

  it('requires a unique exact supplier identity after an ID becomes stale', () => {
    expect(resolveUniqueSupplierIdentity(
      { name: 'Acme' },
      [supplier({ name: 'Acme Aviation' })]
    )).toBeUndefined();

    expect(resolveUniqueSupplierIdentity(
      { name: 'Acme Aviation' },
      [supplier({ id: 'supplier-1' }), supplier({ id: 'supplier-2' })]
    )).toBeUndefined();

    expect(resolveUniqueSupplierIdentity(
      { phone: '+86-21-5678-9012' },
      [supplier({ phone: '+86-10-5678-9012' })]
    )).toBeUndefined();

    const matched = resolveUniqueSupplierIdentity(
      { email: 'ops@acme.example' },
      [supplier({ email: 'ops@acme.example' })]
    );
    expect(matched?.id).toBe('supplier-1');
  });
});
