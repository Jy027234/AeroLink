import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  assignLineInventory,
  getLineInventoryAvailability,
  releaseLineInventory,
  reserveLineInventory,
} from './allocationService.js';
import {
  buildCommercialApprovalSnapshot,
} from '../../lib/lineQuotationPolicy.js';
import {
  buildQuotationApprovalSnapshot,
  QUOTATION_APPROVAL_POLICY_VERSION,
} from '../../lib/quotationApprovalPolicy.js';

const manager = { id: 'manager-1', role: 'MANAGER', department: 'Operations' };
const sales = { id: 'sales-1', role: 'SALES', department: 'Sales' };

function noReturnHold() {
  return {
    returnHold: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

function lineFixture(overrides: Record<string, unknown> = {}) {
  const line = {
    id: 'line-1',
    quantity: 5,
    acceptedQuantity: 0,
    reservedQuantity: 2,
    currency: 'USD',
    partNumber: 'PN-1',
    serialNumber: null,
    batchNumber: null,
    rfqLine: {
      id: 'rfq-line-1',
      rfqId: 'rfq-1',
      partNumber: 'PN-1',
      quantity: 5,
      conditionCode: 'NE',
      serialNumber: null,
      batchNumber: null,
      alternatePartNumbers: null,
    },
    quotation: {
      id: 'quote-1',
      lineItemsMode: true,
      createdBy: 'sales-1',
      currency: 'USD',
      creator: { id: 'sales-1', department: 'Operations' },
      lines: [],
      approvals: [],
    },
    ...overrides,
  };
  (line.quotation as { lines: unknown[] }).lines = [line];
  return line;
}

function withdrawnExpiredOrderFixture() {
  const line = lineFixture({
    quantity: 2,
    acceptedQuantity: 2,
    reservedQuantity: 0,
    costPrice: 50,
    costSourceType: 'MANUAL',
    costSourceId: null,
    costSourceReason: '历史成本依据',
    costSourceSnapshotJson: JSON.stringify({
      type: 'MANUAL', id: null, currency: 'USD', costPrice: 50,
      partNumber: 'PN-1', quantity: 2, status: null, supplierId: null,
      capturedAt: '2026-01-01T00:00:00.000Z', reason: '历史成本依据',
    }),
    quotation: {
      ...lineFixture().quotation,
      status: 'WITHDRAWN',
      saleType: 'Sale',
      currency: 'USD',
      customerId: 'customer-1',
      rfqId: 'rfq-1',
      totalPrice: 100,
      reservedQuantity: 0,
      version: 1,
      expiryDate: new Date('2026-01-01T00:00:00.000Z'),
      validityDeadline: new Date('2026-01-01T00:00:00.000Z'),
      supersededAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  });
  const quotation = line.quotation as Record<string, any>;
  // Prisma's nested quotation.lines include does not include a back-reference
  // to quotation.  Keep the fixture's relation shape the same so the
  // canonical approval snapshot does not recurse through line.quotation.
  const snapshotLine = { ...line } as Record<string, any>;
  delete snapshotLine.quotation;
  quotation.lines = [snapshotLine];
  quotation.approvals = [{
    action: 'APPROVE',
    policyVersion: `${QUOTATION_APPROVAL_POLICY_VERSION}-lines-v1`,
    snapshotJson: JSON.stringify(buildCommercialApprovalSnapshot({
      headerTerms: buildQuotationApprovalSnapshot(quotation),
      lines: quotation.lines,
    })),
  }];
  const orderLine = {
    id: 'order-line-1',
    quotationLineId: line.id,
    partNumber: line.partNumber,
    quantity: 1,
    outboundQuantity: 0,
    serialNumber: null,
    batchNumber: null,
    order: {
      id: 'order-1', quotationId: quotation.id, customerId: 'customer-1',
      lineItemsMode: true, status: 'SO_CREATED',
    },
  };
  return { line, orderLine };
}

function releaseReplayFixture(reason: string | null = '释放过期未分配库存') {
  const line = lineFixture({
    acceptedQuantity: 0,
    reservedQuantity: 1,
    quotation: {
      ...lineFixture().quotation,
      status: 'APPROVED',
      saleType: 'Sale',
    },
  });
  const allocation = {
    id: 'allocation-release-1',
    quotationLineId: line.id,
    inventoryDetailId: 'detail-1',
    allocatedQuantity: 2,
    releasedQuantity: 1,
    consumedQuantity: 0,
    expiresAt: null,
    assignments: [],
  };
  const tx = {
    inventoryAllocationEvent: {
      findMany: vi.fn().mockResolvedValue([{
        allocationId: allocation.id,
        assignmentId: null,
        kind: 'RELEASE',
        quantity: 1,
        eventNo: 1,
        after: reason === null
          ? { allocatedQuantity: 2, releasedQuantity: 1, consumedQuantity: 0 }
          : { allocatedQuantity: 2, releasedQuantity: 1, consumedQuantity: 0, reason },
      }]),
    },
    inventoryAllocation: {
      findUnique: vi.fn().mockResolvedValue({ quotationLineId: line.id }),
      findMany: vi.fn().mockResolvedValue([allocation]),
    },
    quotationLine: { findUnique: vi.fn().mockResolvedValue(line) },
  } as unknown as Prisma.TransactionClient;
  return { tx, allocation };
}

describe('modern inventory allocation service', () => {
  it('returns only quantity facts and never exposes cost/source fields', async () => {
    const line = lineFixture();
    const tx = {
      ...noReturnHold(),
      quotationLine: { findUnique: vi.fn().mockResolvedValue(line) },
      inventoryAllocation: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'allocation-1',
          quotationLineId: 'line-1',
          inventoryDetailId: 'detail-1',
          allocatedQuantity: 2,
          releasedQuantity: 0,
          consumedQuantity: 0,
          expiresAt: null,
          assignments: [],
          costPrice: 99,
          costSourceSnapshotJson: '{"costPrice":99}',
        }]),
      },
    } as unknown as Prisma.TransactionClient;

    const result = await getLineInventoryAvailability({ tx, actor: manager, quotationLineId: 'line-1' });

    expect(result.unassignedQuantity).toBe(2);
    expect(result.allocations[0]).toMatchObject({ id: 'allocation-1', activeQuantity: 2 });
    expect(JSON.stringify(result)).not.toContain('costPrice');
    expect(JSON.stringify(result)).not.toContain('costSource');
  });

  it('replays an unassigned reserve after a later assignment without changing the original command facts', async () => {
    const line = lineFixture();
    const originalParent = {
      id: 'allocation-1',
      quotationLineId: 'line-1',
      inventoryDetailId: 'detail-1',
      allocatedQuantity: 2,
      releasedQuantity: 0,
      consumedQuantity: 0,
      expiresAt: null,
      commandId: 'reserve-command',
      commandLineNo: 1,
      assignments: [{
        id: 'assignment-later',
        orderLineId: 'order-line-1',
        assignedQuantity: 1,
        releasedQuantity: 0,
        consumedQuantity: 0,
        commandId: 'later-assign-command',
      }],
    };
    const tx = {
      ...noReturnHold(),
      quotationLine: { findUnique: vi.fn().mockResolvedValue(line) },
      inventoryAllocation: {
        findMany: vi.fn()
          .mockResolvedValueOnce([originalParent])
          .mockResolvedValueOnce([{ ...originalParent, assignments: originalParent.assignments }]),
      },
    } as unknown as Prisma.TransactionClient;

    const result = await reserveLineInventory({
      tx,
      actor: manager,
      quotationLineId: 'line-1',
      allocations: [{ inventoryDetailId: 'detail-1', quantity: 2 }],
      commandId: 'reserve-command',
    });

    expect(result.replayed).toBe(true);
    expect(result.allocations[0]).toMatchObject({
      id: 'allocation-1',
      allocatedQuantity: 2,
      assignedActiveQuantity: 1,
      unassignedQuantity: 1,
    });
  });

  it('replays a release after the idempotency cache is gone when the normalized reason matches', async () => {
    const { tx, allocation } = releaseReplayFixture();

    const result = await releaseLineInventory({
      tx,
      actor: manager,
      allocationId: allocation.id,
      quantity: 1,
      reason: '  释放过期未分配库存  ',
      commandId: 'release-command',
    });

    expect(result).toMatchObject({
      replayed: true,
      commandId: 'release-command',
      reason: '释放过期未分配库存',
    });
    expect(tx.inventoryAllocationEvent.findMany).toHaveBeenCalledOnce();
    expect((tx.inventoryAllocation as any).findUnique).toHaveBeenCalledOnce();
  });

  it('rejects a replay with a different release reason after the idempotency cache is gone', async () => {
    const { tx, allocation } = releaseReplayFixture();

    await expect(releaseLineInventory({
      tx,
      actor: manager,
      allocationId: allocation.id,
      quantity: 1,
      reason: '改写为其他原因',
      commandId: 'release-command',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((tx.inventoryAllocation as any).findUnique).not.toHaveBeenCalled();
  });

  it('rejects replay of legacy release events that have no durable reason', async () => {
    const { tx, allocation } = releaseReplayFixture(null);

    await expect(releaseLineInventory({
      tx,
      actor: manager,
      allocationId: allocation.id,
      quantity: 1,
      reason: '释放过期未分配库存',
      commandId: 'release-command',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((tx.inventoryAllocation as any).findUnique).not.toHaveBeenCalled();
  });

  it('allows an existing order to bind stock after its offer expired or was superseded', async () => {
    const { line, orderLine } = withdrawnExpiredOrderFixture();
    const detail = {
      id: 'detail-1', quantity: 1, allocatedQuantity: 0, status: 'AVAILABLE',
      type: 'OWN', conditionCode: 'NE', serialNumber: null, batchNumber: null,
      shelfLifeDate: null, shelfLifeDays: null, nextOverhaulDue: null,
      lifeLimited: false, remainingHours: null, remainingCycles: null,
      inventoryItem: { partNumber: 'PN-1', trackingType: 'BATCH' },
    };
    const allocationRows: any[] = [];
    const tx = {
      ...noReturnHold(),
      quotationLine: { findUnique: vi.fn().mockResolvedValue(line) },
      orderLine: { findUnique: vi.fn().mockResolvedValue(orderLine) },
      inventoryAllocation: {
        findMany: vi.fn().mockImplementation(async () => allocationRows),
        create: vi.fn().mockImplementation(async ({ data }: any) => {
          const parent = { ...data, id: 'allocation-1', version: 1, releasedQuantity: 0,
            consumedQuantity: 0, expiresAt: (line.quotation as Record<string, any>).expiryDate, assignments: [] };
          allocationRows.push(parent);
          return parent;
        }),
      },
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue(detail),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      allocationAssignment: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockImplementation(async ({ data }: any) => ({
          ...data, id: 'assignment-1', version: 1, releasedQuantity: 0, consumedQuantity: 0,
        })),
      },
      inventoryAllocationEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      outboxEvent: { create: vi.fn().mockResolvedValue({ id: 'outbox-1' }) },
    } as unknown as Prisma.TransactionClient;

    const result = await reserveLineInventory({
      tx,
      actor: manager,
      quotationLineId: line.id,
      orderLineId: orderLine.id,
      allocations: [{ inventoryDetailId: detail.id, quantity: 1 }],
      commandId: 'order-reserve-after-expiry',
    });

    expect(result.replayed).toBe(false);
    expect('createdAllocationIds' in result && result.createdAllocationIds).toEqual(['allocation-1']);
    expect(tx.inventoryDetail.updateMany).toHaveBeenCalled();
  });

  it('keeps sales actors out of physical allocation writes', async () => {
    const tx = {} as Prisma.TransactionClient;

    await expect(reserveLineInventory({
      tx,
      actor: sales,
      quotationLineId: 'line-1',
      allocations: [{ inventoryDetailId: 'detail-1', quantity: 1 }],
      commandId: 'command-1',
    })).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });

    await expect(assignLineInventory({
      tx,
      actor: sales,
      orderLineId: 'order-line-1',
      allocations: [{ allocationId: 'allocation-1', quantity: 1 }],
      commandId: 'command-2',
    })).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
  });

  it('blocks reuse of an outbound serial after its physical quantity was manually restored', async () => {
    const { line, orderLine } = withdrawnExpiredOrderFixture();
    const tx = {
      ...noReturnHold(),
      quotationLine: { findUnique: vi.fn().mockResolvedValue(line) },
      orderLine: { findUnique: vi.fn().mockResolvedValue(orderLine) },
      inventoryAllocation: { findMany: vi.fn().mockResolvedValue([]) },
      allocationAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      inventoryDetail: { findUnique: vi.fn().mockResolvedValue({ id: 'detail-1', quantity: 1, allocatedQuantity: 0,
        status: 'AVAILABLE', type: 'OWN', conditionCode: 'NE', serialNumber: 'SN-1', batchNumber: null,
        shelfLifeDate: null, shelfLifeDays: null, nextOverhaulDue: null, lifeLimited: false,
        remainingHours: null, remainingCycles: null,
        inventoryItem: { partNumber: 'PN-1', trackingType: 'SERIAL' } }), updateMany: vi.fn() },
      inventoryTransaction: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([{ id: 'old-outbound', quantity: -1 }]),
      },
    } as unknown as Prisma.TransactionClient;
    await expect(reserveLineInventory({ tx, actor: manager, quotationLineId: line.id, orderLineId: orderLine.id,
      allocations: [{ inventoryDetailId: 'detail-1', quantity: 1 }], commandId: 'illegal-serial-reuse' })).rejects.toThrow('序号件已有未被唯一受控退货覆盖的出库事实');
    expect(tx.inventoryDetail.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a legacy quotation before looking at inventory rows', async () => {
    const actor = { id: 'manager-1', role: 'MANAGER', department: 'Operations' };

    // Inventory managers may still read a department-owned legacy quote, but
    // legacy reservations must stay on the isolated service path.
    const legacyTx = {
      quotationLine: {
        findUnique: vi.fn().mockResolvedValue(lineFixture({
          quotation: {
            ...lineFixture().quotation,
            lineItemsMode: false,
          },
        })),
      },
      inventoryAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as Prisma.TransactionClient;

    await expect(reserveLineInventory({
      tx: legacyTx,
      actor,
      quotationLineId: 'line-1',
      allocations: [{ inventoryDetailId: 'detail-1', quantity: 1 }],
      commandId: 'command-3',
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect((legacyTx as unknown as { inventoryDetail?: unknown }).inventoryDetail).toBeUndefined();
  });

  it('rechecks quotation ownership scope even for an inventory manager', async () => {
    const crossDepartment = { id: 'manager-2', role: 'MANAGER', department: 'Finance' };
    const tx = {
      inventoryAllocation: { findMany: vi.fn().mockResolvedValue([]) },
      quotationLine: { findUnique: vi.fn().mockResolvedValue(lineFixture()) },
    } as unknown as Prisma.TransactionClient;

    await expect(reserveLineInventory({
      tx,
      actor: crossDepartment,
      quotationLineId: 'line-1',
      allocations: [{ inventoryDetailId: 'detail-1', quantity: 1 }],
      commandId: 'command-cross-department',
    })).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
  });
});
