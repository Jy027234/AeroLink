import { describe, expect, it } from 'vitest';
import { allocationQuantities, type AllocationQuantitiesInput } from './allocationQuantities.js';

const validBase: AllocationQuantitiesInput = {
  allocatedQuantity: 10,
  releasedQuantity: 1,
  consumedQuantity: 5,
  assignments: [
    { assignedQuantity: 6, releasedQuantity: 1, consumedQuantity: 2 },
    { assignedQuantity: 4, releasedQuantity: 0, consumedQuantity: 3 },
  ],
};

const expectInconsistent = (input: AllocationQuantitiesInput) => {
  expect(() => allocationQuantities(input)).toThrowError(
    expect.objectContaining({
      statusCode: 409,
      code: 'ALLOCATION_INCONSISTENT',
    }),
  );
};

describe('allocationQuantities', () => {
  it('summarizes a normal split across two orders', () => {
    expect(allocationQuantities(validBase)).toEqual({
      activeQuantity: 4,
      unassignedQuantity: 0,
      assignedActiveQuantity: 4,
    });
  });

  it('keeps unassigned quantity after a parent-level release', () => {
    expect(
      allocationQuantities({
        allocatedQuantity: 10,
        releasedQuantity: 3,
        consumedQuantity: 0,
        assignments: [],
      }),
    ).toEqual({
      activeQuantity: 7,
      unassignedQuantity: 7,
      assignedActiveQuantity: 0,
    });
  });

  it('accounts for child release and consumption', () => {
    expect(
      allocationQuantities({
        allocatedQuantity: 10,
        releasedQuantity: 2,
        consumedQuantity: 3,
        assignments: [{ assignedQuantity: 6, releasedQuantity: 2, consumedQuantity: 3 }],
      }),
    ).toEqual({
      activeQuantity: 5,
      unassignedQuantity: 4,
      assignedActiveQuantity: 1,
    });
  });

  it('rejects negative, non-integer, and zero quantities', () => {
    expectInconsistent({ ...validBase, releasedQuantity: -1 });
    expectInconsistent({ ...validBase, allocatedQuantity: 1.5 });
    expectInconsistent({
      ...validBase,
      assignments: [{ ...validBase.assignments[0], assignedQuantity: 0 }],
    });
  });

  it('rejects child release or consumption beyond its assignment', () => {
    expectInconsistent({
      ...validBase,
      consumedQuantity: 6,
      assignments: [
        { assignedQuantity: 5, releasedQuantity: 2, consumedQuantity: 4 },
      ],
    });
  });

  it('rejects child assignments beyond the parent allocation', () => {
    expectInconsistent({
      ...validBase,
      assignments: [
        { assignedQuantity: 6, releasedQuantity: 0, consumedQuantity: 2 },
        { assignedQuantity: 5, releasedQuantity: 1, consumedQuantity: 3 },
      ],
      releasedQuantity: 1,
      consumedQuantity: 5,
    });
  });

  it('rejects parent and child totals that disagree', () => {
    expectInconsistent({ ...validBase, consumedQuantity: 4 });
    expectInconsistent({
      ...validBase,
      releasedQuantity: 0,
    });
  });

  it('rejects parent quantities that exceed the allocation', () => {
    expectInconsistent({
      allocatedQuantity: 5,
      releasedQuantity: 3,
      consumedQuantity: 3,
      assignments: [{ assignedQuantity: 3, releasedQuantity: 0, consumedQuantity: 3 }],
    });
  });
});
