import { Prisma } from '@prisma/client';
import { allocationQuantities } from './allocationQuantities.js';

/**
 * Read-only reconciliation for the D12 allocation ledger.
 *
 * The query deliberately selects identifiers, counters and statuses only. In
 * particular, it never reads or returns inventory cost or commercial price
 * fields. The caller must run this function in a RepeatableRead, read-only
 * transaction so all projections are compared against one database snapshot.
 */

export type AllocationReconciliationIssue = {
  code: string;
  allocationId?: string;
  assignmentId?: string;
  inventoryDetailId?: string;
  quotationLineId?: string;
  quotationId?: string;
  orderLineId?: string;
  orderId?: string;
  transactionId?: string;
  eventId?: string;
  expected?: number;
  actual?: number;
  count?: number;
  ids?: string[];
};

export type AllocationReconciliationResult = {
  status: 'PASS' | 'BLOCKED';
  checked: {
    inventoryDetails: number;
    allocations: number;
    assignments: number;
    quotationLines: number;
    quotations: number;
    orderLines: number;
    orders: number;
    events: number;
    outboundTransactions: number;
  };
  legacyReserved: {
    count: number;
    detailIds: string[];
  };
  issues: AllocationReconciliationIssue[];
};

type DetailRow = {
  id: string;
  quantity: number;
  allocatedQuantity: number;
  status: string;
};

type AllocationRow = {
  id: string;
  quotationLineId: string;
  inventoryDetailId: string;
  allocatedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
};

type AssignmentRow = {
  id: string;
  allocationId: string;
  orderLineId: string;
  assignedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
};

type QuotationLineRow = {
  id: string;
  quotationId: string;
  reservedQuantity: number;
};

type QuotationRow = {
  id: string;
  reservedQuantity: number;
};

type OrderLineRow = {
  id: string;
  orderId: string;
  outboundQuantity: number;
};

type OrderRow = {
  id: string;
  outboundQuantity: number;
};

type EventRow = {
  id: string;
  allocationId: string;
  assignmentId: string | null;
  kind: string;
  quantity: number;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
};

type OutboundTransactionRow = {
  id: string;
  inventoryDetailId: string;
  allocationId: string | null;
  assignmentId: string | null;
  quantity: number;
};

export type AllocationReconciliationSnapshot = {
  details: DetailRow[];
  allocations: AllocationRow[];
  assignments: AssignmentRow[];
  quotationLines: QuotationLineRow[];
  quotations: QuotationRow[];
  orderLines: OrderLineRow[];
  orders: OrderRow[];
  events: EventRow[];
  outboundTransactions: OutboundTransactionRow[];
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNumber(value: unknown, key: string): boolean {
  return isRecord(value) && typeof value[key] === 'number';
}

function isParentEvent(event: EventRow): boolean {
  // Reserve/release events created by allocationService contain the parent
  // counters at the top level. Fulfillment consume events keep the same
  // counters under `quantity` and are the sole event for both parent and
  // assignment consumption.
  return hasNumber(event.before, 'allocatedQuantity')
    || hasNumber(event.after, 'allocatedQuantity')
    || (isRecord(event.before) && isRecord(event.before.quantity)
      && hasNumber(event.before.quantity, 'allocated'))
    || (isRecord(event.after) && isRecord(event.after.quantity)
      && hasNumber(event.after.quantity, 'allocated'));
}

function isAssignmentFactsEvent(event: EventRow): boolean {
  return hasNumber(event.before, 'assignedQuantity') || hasNumber(event.after, 'assignedQuantity');
}

function pushDifference(
  issues: AllocationReconciliationIssue[],
  issue: AllocationReconciliationIssue,
): void {
  if (issue.expected !== issue.actual) issues.push(issue);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function eventQuantityByAllocation(
  events: EventRow[],
  allocationId: string,
  kind: string,
  predicate: (event: EventRow) => boolean,
): number {
  return sum(events
    .filter(event => event.allocationId === allocationId && event.kind === kind && predicate(event))
    .map(event => event.quantity));
}

function eventQuantityByAssignment(
  events: EventRow[],
  assignmentId: string,
  kind: string,
  predicate: (event: EventRow) => boolean,
): number {
  return sum(events
    .filter(event => event.assignmentId === assignmentId && event.kind === kind && predicate(event))
    .map(event => event.quantity));
}

function reconcileSnapshot(snapshot: AllocationReconciliationSnapshot): AllocationReconciliationResult {
  const issues: AllocationReconciliationIssue[] = [];
  const allocationsByDetail = new Map<string, AllocationRow[]>();
  const assignmentsByAllocation = new Map<string, AssignmentRow[]>();
  const allocationsByLine = new Map<string, AllocationRow[]>();
  const linesByQuotation = new Map<string, QuotationLineRow[]>();
  const assignmentsByOrderLine = new Map<string, AssignmentRow[]>();
  const transactionsByAllocation = new Map<string, OutboundTransactionRow[]>();
  const transactionsByAssignment = new Map<string, OutboundTransactionRow[]>();

  for (const allocation of snapshot.allocations) {
    allocationsByDetail.set(allocation.inventoryDetailId, [
      ...(allocationsByDetail.get(allocation.inventoryDetailId) ?? []),
      allocation,
    ]);
    allocationsByLine.set(allocation.quotationLineId, [
      ...(allocationsByLine.get(allocation.quotationLineId) ?? []),
      allocation,
    ]);
  }
  for (const assignment of snapshot.assignments) {
    assignmentsByAllocation.set(assignment.allocationId, [
      ...(assignmentsByAllocation.get(assignment.allocationId) ?? []),
      assignment,
    ]);
    assignmentsByOrderLine.set(assignment.orderLineId, [
      ...(assignmentsByOrderLine.get(assignment.orderLineId) ?? []),
      assignment,
    ]);
  }
  for (const line of snapshot.quotationLines) {
    linesByQuotation.set(line.quotationId, [
      ...(linesByQuotation.get(line.quotationId) ?? []),
      line,
    ]);
  }
  for (const transaction of snapshot.outboundTransactions) {
    if (transaction.allocationId) {
      transactionsByAllocation.set(transaction.allocationId, [
        ...(transactionsByAllocation.get(transaction.allocationId) ?? []),
        transaction,
      ]);
    }
    if (transaction.assignmentId) {
      transactionsByAssignment.set(transaction.assignmentId, [
        ...(transactionsByAssignment.get(transaction.assignmentId) ?? []),
        transaction,
      ]);
    }
  }

  // 1. Detail allocatedQuantity is the active parent allocation projection.
  for (const detail of snapshot.details) {
    const activeParentQuantity = sum((allocationsByDetail.get(detail.id) ?? []).map(allocation => {
      const assignments = assignmentsByAllocation.get(allocation.id) ?? [];
      try {
        return allocationQuantities({ ...allocation, assignments }).activeQuantity;
      } catch {
        // The per-parent check below emits the detailed conservation issue.
        return 0;
      }
    }));
    pushDifference(issues, {
      code: 'DETAIL_ALLOCATED_PROJECTION_MISMATCH',
      inventoryDetailId: detail.id,
      expected: activeParentQuantity,
      actual: detail.allocatedQuantity,
    });
    if (activeParentQuantity > detail.quantity) {
      issues.push({
        code: 'DETAIL_ACTIVE_ALLOCATION_EXCEEDS_QUANTITY',
        inventoryDetailId: detail.id,
        expected: detail.quantity,
        actual: activeParentQuantity,
      });
    }
  }

  // 2. Parent/child conservation and event ledger checks.
  for (const allocation of snapshot.allocations) {
    const assignments = assignmentsByAllocation.get(allocation.id) ?? [];
    try {
      allocationQuantities({ ...allocation, assignments });
    } catch {
      issues.push({
        code: 'ALLOCATION_PARENT_CHILD_INCONSISTENT',
        allocationId: allocation.id,
        expected: allocation.allocatedQuantity,
        actual: allocation.allocatedQuantity - allocation.releasedQuantity - allocation.consumedQuantity,
      });
    }

    const reserveEvents = eventQuantityByAllocation(snapshot.events, allocation.id, 'RESERVE', isParentEvent);
    const releaseEvents = eventQuantityByAllocation(snapshot.events, allocation.id, 'RELEASE', isParentEvent);
    const consumeEvents = eventQuantityByAllocation(snapshot.events, allocation.id, 'CONSUME', isParentEvent);
    pushDifference(issues, {
      code: 'ALLOCATION_EVENT_RESERVE_MISMATCH',
      allocationId: allocation.id,
      expected: allocation.allocatedQuantity,
      actual: reserveEvents,
    });
    pushDifference(issues, {
      code: 'ALLOCATION_EVENT_RELEASE_MISMATCH',
      allocationId: allocation.id,
      expected: allocation.releasedQuantity,
      actual: releaseEvents,
    });
    pushDifference(issues, {
      code: 'ALLOCATION_EVENT_CONSUME_MISMATCH',
      allocationId: allocation.id,
      expected: allocation.consumedQuantity,
      actual: consumeEvents,
    });

    const outboundQuantity = sum((transactionsByAllocation.get(allocation.id) ?? []).map(transaction => -transaction.quantity));
    pushDifference(issues, {
      code: 'ALLOCATION_OUTBOUND_LEDGER_MISMATCH',
      allocationId: allocation.id,
      expected: allocation.consumedQuantity,
      actual: outboundQuantity,
    });
  }

  for (const assignment of snapshot.assignments) {
    const validAssigned = Number.isSafeInteger(assignment.assignedQuantity) && assignment.assignedQuantity > 0;
    const validReleased = Number.isSafeInteger(assignment.releasedQuantity) && assignment.releasedQuantity >= 0;
    const validConsumed = Number.isSafeInteger(assignment.consumedQuantity) && assignment.consumedQuantity >= 0;
    const usedQuantity = assignment.releasedQuantity + assignment.consumedQuantity;
    if (!validAssigned || !validReleased || !validConsumed || usedQuantity > assignment.assignedQuantity) {
      issues.push({
        code: 'ASSIGNMENT_COUNTERS_INCONSISTENT',
        assignmentId: assignment.id,
        allocationId: assignment.allocationId,
        expected: assignment.assignedQuantity,
        actual: usedQuantity,
      });
    }

    // ASSIGN events are emitted with the parent allocation snapshot in their
    // before/after JSON, so their assignment facts are not at the top level.
    // The event identity and quantity are the authoritative child assignment
    // evidence for this transition.
    const assignEvents = eventQuantityByAssignment(snapshot.events, assignment.id, 'ASSIGN', () => true);
    const releaseEvents = eventQuantityByAssignment(snapshot.events, assignment.id, 'RELEASE', isAssignmentFactsEvent);
    const consumeEvents = eventQuantityByAssignment(snapshot.events, assignment.id, 'CONSUME', event => isParentEvent(event) && !isAssignmentFactsEvent(event));
    pushDifference(issues, {
      code: 'ASSIGNMENT_EVENT_ASSIGN_MISMATCH',
      assignmentId: assignment.id,
      allocationId: assignment.allocationId,
      expected: assignment.assignedQuantity,
      actual: assignEvents,
    });
    pushDifference(issues, {
      code: 'ASSIGNMENT_EVENT_RELEASE_MISMATCH',
      assignmentId: assignment.id,
      allocationId: assignment.allocationId,
      expected: assignment.releasedQuantity,
      actual: releaseEvents,
    });
    pushDifference(issues, {
      code: 'ASSIGNMENT_EVENT_CONSUME_MISMATCH',
      assignmentId: assignment.id,
      allocationId: assignment.allocationId,
      expected: assignment.consumedQuantity,
      actual: consumeEvents,
    });

    const outboundQuantity = sum((transactionsByAssignment.get(assignment.id) ?? []).map(transaction => -transaction.quantity));
    pushDifference(issues, {
      code: 'ASSIGNMENT_OUTBOUND_LEDGER_MISMATCH',
      assignmentId: assignment.id,
      allocationId: assignment.allocationId,
      expected: assignment.consumedQuantity,
      actual: outboundQuantity,
    });
  }

  // 3. Quotation line and quotation reserved projections.
  for (const line of snapshot.quotationLines) {
    const unassignedQuantity = sum((allocationsByLine.get(line.id) ?? []).map(allocation => {
      const assignments = assignmentsByAllocation.get(allocation.id) ?? [];
      try {
        return allocationQuantities({ ...allocation, assignments }).unassignedQuantity;
      } catch {
        return 0;
      }
    }));
    pushDifference(issues, {
      code: 'QUOTATION_LINE_RESERVED_MISMATCH',
      quotationLineId: line.id,
      quotationId: line.quotationId,
      expected: unassignedQuantity,
      actual: line.reservedQuantity,
    });
  }
  for (const quotation of snapshot.quotations) {
    const lineReservedQuantity = sum((linesByQuotation.get(quotation.id) ?? []).map(line => line.reservedQuantity));
    pushDifference(issues, {
      code: 'QUOTATION_RESERVED_MISMATCH',
      quotationId: quotation.id,
      expected: lineReservedQuantity,
      actual: quotation.reservedQuantity,
    });
  }

  // 4. Order line and order outbound projections.
  const linesByOrder = new Map<string, OrderLineRow[]>();
  for (const line of snapshot.orderLines) {
    linesByOrder.set(line.orderId, [...(linesByOrder.get(line.orderId) ?? []), line]);
    const consumedQuantity = sum((assignmentsByOrderLine.get(line.id) ?? []).map(assignment => assignment.consumedQuantity));
    pushDifference(issues, {
      code: 'ORDER_LINE_OUTBOUND_MISMATCH',
      orderLineId: line.id,
      orderId: line.orderId,
      expected: consumedQuantity,
      actual: line.outboundQuantity,
    });
  }
  for (const order of snapshot.orders) {
    const lineOutboundQuantity = sum((linesByOrder.get(order.id) ?? []).map(line => line.outboundQuantity));
    pushDifference(issues, {
      code: 'ORDER_OUTBOUND_MISMATCH',
      orderId: order.id,
      expected: lineOutboundQuantity,
      actual: order.outboundQuantity,
    });
  }

  // 5. An OUTBOUND row without modern allocation identity is historical data
  // that cannot be attributed to an allocation. It is surfaced for manual
  // review and is never backfilled by this read-only check.
  const unlinkedOutbound = snapshot.outboundTransactions.filter(row => !row.allocationId && !row.assignmentId);
  if (unlinkedOutbound.length > 0) {
    issues.push({
      code: 'LEGACY_OUTBOUND_MANUAL_REVIEW',
      count: unlinkedOutbound.length,
      ids: unlinkedOutbound.map(row => row.id),
    });
  }
  const malformedOutbound = snapshot.outboundTransactions.filter(row => row.quantity >= 0);
  for (const transaction of malformedOutbound) {
    issues.push({
      code: 'OUTBOUND_QUANTITY_SIGN_INVALID',
      transactionId: transaction.id,
      actual: transaction.quantity,
    });
  }

  // 6. Legacy RESERVED status is intentionally a manual block. This check
  // does not convert it into an allocation or alter any inventory row.
  const legacyReservedDetails = snapshot.details.filter(detail => detail.status === 'RESERVED').map(detail => detail.id);
  if (legacyReservedDetails.length > 0) {
    issues.push({
      code: 'LEGACY_RESERVED_MANUAL_REVIEW',
      count: legacyReservedDetails.length,
      ids: legacyReservedDetails,
    });
  }

  return {
    status: issues.length === 0 ? 'PASS' : 'BLOCKED',
    checked: {
      inventoryDetails: snapshot.details.length,
      allocations: snapshot.allocations.length,
      assignments: snapshot.assignments.length,
      quotationLines: snapshot.quotationLines.length,
      quotations: snapshot.quotations.length,
      orderLines: snapshot.orderLines.length,
      orders: snapshot.orders.length,
      events: snapshot.events.length,
      outboundTransactions: snapshot.outboundTransactions.length,
    },
    legacyReserved: {
      count: legacyReservedDetails.length,
      detailIds: legacyReservedDetails,
    },
    issues,
  };
}

export async function loadAllocationReconciliation(
  tx: Prisma.TransactionClient,
): Promise<AllocationReconciliationResult> {
  const [details, allocations, assignments, quotationLines, quotations, orderLines, orders, events, outboundTransactions] = await Promise.all([
    tx.inventoryDetail.findMany({
      select: { id: true, quantity: true, allocatedQuantity: true, status: true },
    }),
    tx.inventoryAllocation.findMany({
      select: {
        id: true,
        quotationLineId: true,
        inventoryDetailId: true,
        allocatedQuantity: true,
        releasedQuantity: true,
        consumedQuantity: true,
      },
    }),
    tx.allocationAssignment.findMany({
      select: {
        id: true,
        allocationId: true,
        orderLineId: true,
        assignedQuantity: true,
        releasedQuantity: true,
        consumedQuantity: true,
      },
    }),
    tx.quotationLine.findMany({
      select: { id: true, quotationId: true, reservedQuantity: true },
    }),
    tx.quotation.findMany({
      select: { id: true, reservedQuantity: true },
    }),
    tx.orderLine.findMany({
      select: { id: true, orderId: true, outboundQuantity: true },
    }),
    tx.order.findMany({
      select: { id: true, outboundQuantity: true },
    }),
    tx.inventoryAllocationEvent.findMany({
      select: { id: true, allocationId: true, assignmentId: true, kind: true, quantity: true, before: true, after: true },
    }),
    tx.inventoryTransaction.findMany({
      where: { type: 'OUTBOUND' },
      select: { id: true, inventoryDetailId: true, allocationId: true, assignmentId: true, quantity: true },
    }),
  ]);

  return reconcileSnapshot({
    details,
    allocations,
    assignments,
    quotationLines,
    quotations,
    orderLines,
    orders,
    events,
    outboundTransactions,
  });
}

export { reconcileSnapshot as reconcileAllocationSnapshot };
