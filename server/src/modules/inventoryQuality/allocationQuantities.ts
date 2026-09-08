import { AppError } from '../../middleware/errorHandler.js';

/** Quantities attached to one allocation child (for example, one order). */
export type AllocationAssignmentQuantities = {
  assignedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
};

/**
 * Quantity facts for an allocation and its assignments.
 *
 * This helper deliberately contains no persistence or inventory assumptions. It
 * only checks the conservation rules shared by the D12 allocation model.
 */
export type AllocationQuantitiesInput = {
  allocatedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
  assignments: readonly AllocationAssignmentQuantities[];
};

export type AllocationQuantitiesResult = {
  activeQuantity: number;
  unassignedQuantity: number;
  assignedActiveQuantity: number;
};

const inconsistent = (message: string): never => {
  throw new AppError(message, 409, 'ALLOCATION_INCONSISTENT');
};

function assertSafeNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    inconsistent(`${label}必须是非负整数`);
  }
}

function assertSafePositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    inconsistent(`${label}必须是正整数`);
  }
}

const safeAdd = (left: number, right: number, label: string): number => {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    inconsistent(`${label}超出安全整数范围`);
  }
  return result;
};

/**
 * Validate and summarize allocation quantities.
 *
 * Parent release may cover quantity that has not been assigned to an order
 * yet. Child release/consumption must still be reflected in the parent facts;
 * therefore unassigned quantity is calculated as:
 *
 *   allocated - sum(assigned) - parentReleased + sum(childReleased)
 */
export const allocationQuantities = (
  input: AllocationQuantitiesInput,
): AllocationQuantitiesResult => {
  if (!input || typeof input !== 'object') {
    inconsistent('分配计数输入无效');
  }

  assertSafePositiveInteger(input.allocatedQuantity, 'allocatedQuantity');
  assertSafeNonNegativeInteger(input.releasedQuantity, 'releasedQuantity');
  assertSafeNonNegativeInteger(input.consumedQuantity, 'consumedQuantity');
  if (!Array.isArray(input.assignments)) {
    inconsistent('assignments必须是数组');
  }

  let assignedQuantity = 0;
  let releasedAssignmentQuantity = 0;
  let consumedAssignmentQuantity = 0;
  let assignedActiveQuantity = 0;

  for (const [index, assignment] of input.assignments.entries()) {
    if (!assignment || typeof assignment !== 'object') {
      inconsistent(`assignments[${index}]无效`);
    }

    assertSafePositiveInteger(assignment.assignedQuantity, `assignments[${index}].assignedQuantity`);
    assertSafeNonNegativeInteger(assignment.releasedQuantity, `assignments[${index}].releasedQuantity`);
    assertSafeNonNegativeInteger(assignment.consumedQuantity, `assignments[${index}].consumedQuantity`);

    const assignmentReleasedAndConsumed = safeAdd(
      assignment.releasedQuantity,
      assignment.consumedQuantity,
      `assignments[${index}]释放与消费总量`,
    );
    if (assignmentReleasedAndConsumed > assignment.assignedQuantity) {
      inconsistent(`assignments[${index}]释放与消费量超过分配量`);
    }

    assignedQuantity = safeAdd(assignedQuantity, assignment.assignedQuantity, 'assignedQuantity');
    releasedAssignmentQuantity = safeAdd(
      releasedAssignmentQuantity,
      assignment.releasedQuantity,
      '子分配释放总量',
    );
    consumedAssignmentQuantity = safeAdd(
      consumedAssignmentQuantity,
      assignment.consumedQuantity,
      '子分配消费总量',
    );
    assignedActiveQuantity = safeAdd(
      assignedActiveQuantity,
      assignment.assignedQuantity - assignmentReleasedAndConsumed,
      'assignedActiveQuantity',
    );
  }

  if (assignedQuantity > input.allocatedQuantity) {
    inconsistent('子分配总量超过父分配量');
  }
  if (input.consumedQuantity !== consumedAssignmentQuantity) {
    inconsistent('父消费总量与子分配消费总量不一致');
  }
  if (input.releasedQuantity < releasedAssignmentQuantity) {
    inconsistent('父释放总量小于子分配释放总量');
  }

  const unassignedQuantity =
    input.allocatedQuantity - assignedQuantity - input.releasedQuantity + releasedAssignmentQuantity;
  if (!Number.isSafeInteger(unassignedQuantity) || unassignedQuantity < 0) {
    inconsistent('未分配数量不能为负数');
  }

  const activeQuantity = input.allocatedQuantity - input.releasedQuantity - input.consumedQuantity;
  if (!Number.isSafeInteger(activeQuantity) || activeQuantity < 0) {
    inconsistent('有效数量不能为负数');
  }

  if (activeQuantity !== unassignedQuantity + assignedActiveQuantity) {
    inconsistent('父子分配有效数量不守恒');
  }

  return {
    activeQuantity,
    unassignedQuantity,
    assignedActiveQuantity,
  };
};
