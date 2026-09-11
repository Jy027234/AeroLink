import {
  hasCapability,
  type CapabilityActor,
} from './capabilityPolicy.js';

/**
 * Cost visibility is deliberately separate from ordinary inventory/report
 * reads.  Callers can therefore keep returning quantities and operational
 * counts when a user is not allowed to see financial values.
 */
export function canViewInventoryCost(actor: CapabilityActor): boolean {
  return hasCapability(actor, 'inventory', 'view_cost');
}

export function canViewReportCost(actor: CapabilityActor): boolean {
  return hasCapability(actor, 'report', 'view_cost');
}

export function visibleCost(value: number | null | undefined, allowed: boolean): number | null {
  return allowed && value !== null && value !== undefined ? value : null;
}
