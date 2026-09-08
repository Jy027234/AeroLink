import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import prisma from '../../lib/prisma.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { allocationQuantities } from './allocationQuantities.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const CANDIDATE_PAGE_SIZE = 100;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10;

type ExpiryInput = {
  now?: Date;
  limit?: number;
};

export type AllocationExpiryResult = {
  scanned: number;
  releasedAllocations: number;
  releasedQuantity: number;
};

type ExpiredAllocation = {
  id: string;
  quotationLineId: string;
  inventoryDetailId: string;
  allocatedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
  version: number;
  expiresAt: Date | null;
  assignments: Array<{
    assignedQuantity: number;
    releasedQuantity: number;
    consumedQuantity: number;
  }>;
  inventoryDetail: {
    id: string;
    quantity: number;
    allocatedQuantity: number;
  };
  quotationLine: {
    id: string;
    quotationId: string;
  };
};

type QuotationState = {
  id: string;
  version: number;
  reservedQuantity: number;
};

type QuotationLineState = {
  id: string;
  quotationId: string;
  reservedQuantity: number;
};

function validateOptions(input: ExpiryInput) {
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new AppError('过期分配清理时间无效', 400, 'VALIDATION_ERROR');
  }

  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new AppError(`过期分配清理 limit 必须是 1 到 ${MAX_LIMIT} 的整数`, 400, 'VALIDATION_ERROR');
  }

  return { now, limit };
}

function retryableTransactionError(error: unknown) {
  if (error && typeof error === 'object') {
    const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code === 'P2034' || code === '40P01' || code === '40001') return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /deadlock|serialization failure|could not serialize|write conflict/i.test(message);
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!retryableTransactionError(error) || attempt === MAX_RETRIES - 1) throw error;
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

function allocationFacts(allocation: ExpiredAllocation) {
  const summary = allocationQuantities({
    allocatedQuantity: allocation.allocatedQuantity,
    releasedQuantity: allocation.releasedQuantity,
    consumedQuantity: allocation.consumedQuantity,
    assignments: allocation.assignments,
  });
  return {
    allocatedQuantity: allocation.allocatedQuantity,
    releasedQuantity: allocation.releasedQuantity,
    consumedQuantity: allocation.consumedQuantity,
    activeQuantity: summary.activeQuantity,
    unassignedQuantity: summary.unassignedQuantity,
    assignedActiveQuantity: summary.assignedActiveQuantity,
  };
}

async function releaseQuotationGroup(
  quotationId: string,
  allocationIds: string[],
  now: Date,
): Promise<{ releasedAllocations: number; releasedQuantity: number }> {
  return withSerializableRetry(() => prisma.$transaction(async (tx) => {
    const allocations = await tx.inventoryAllocation.findMany({
      where: {
        id: { in: allocationIds },
        expiresAt: { lte: now },
      },
      orderBy: [{ quotationLineId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        quotationLineId: true,
        inventoryDetailId: true,
        allocatedQuantity: true,
        releasedQuantity: true,
        consumedQuantity: true,
        version: true,
        expiresAt: true,
        assignments: {
          orderBy: { id: 'asc' },
          select: { assignedQuantity: true, releasedQuantity: true, consumedQuantity: true },
        },
        inventoryDetail: { select: { id: true, quantity: true, allocatedQuantity: true } },
        quotationLine: { select: { id: true, quotationId: true } },
      },
    });

    const eligible = allocations.filter((allocation) => allocation.quotationLine.quotationId === quotationId
      && allocation.expiresAt !== null
      && allocation.expiresAt.getTime() <= now.getTime());
    const lineIds = [...new Set(eligible.map((allocation) => allocation.quotationLineId))];
    const quotation = await tx.quotation.findUnique({
      where: { id: quotationId },
      select: { id: true, version: true, reservedQuantity: true },
    }) as QuotationState | null;
    if (!quotation) {
      throw new AppError('过期分配所属报价不存在', 409, 'ALLOCATION_INCONSISTENT');
    }

    const lines = await tx.quotationLine.findMany({
      where: { id: { in: lineIds }, quotationId },
      select: { id: true, quotationId: true, reservedQuantity: true },
    }) as QuotationLineState[];
    const linesById = new Map(lines.map((line) => [line.id, line]));
    const lineReleaseTotals = new Map<string, number>();
    const detailExpectedAllocated = new Map<string, number>();
    let releasedAllocations = 0;
    let releasedQuantity = 0;

    for (const allocation of eligible) {
      const summary = allocationQuantities({
        allocatedQuantity: allocation.allocatedQuantity,
        releasedQuantity: allocation.releasedQuantity,
        consumedQuantity: allocation.consumedQuantity,
        assignments: allocation.assignments,
      });
      if (summary.unassignedQuantity <= 0) continue;

      const line = linesById.get(allocation.quotationLineId);
      if (!line) {
        throw new AppError('过期分配引用的报价行不存在', 409, 'ALLOCATION_INCONSISTENT');
      }
      const nextLineTotal = (lineReleaseTotals.get(line.id) ?? 0) + summary.unassignedQuantity;
      if (nextLineTotal > line.reservedQuantity) {
        throw new AppError('过期分配释放量超过报价行预留投影', 409, 'ALLOCATION_INCONSISTENT');
      }

      const before = allocationFacts(allocation);
      const after = allocationFacts({
        ...allocation,
        releasedQuantity: allocation.releasedQuantity + summary.unassignedQuantity,
      });
      const commandId = `allocation-expiry:${allocation.id}`;
      const parentUpdate = await tx.inventoryAllocation.updateMany({
        where: {
          id: allocation.id,
          version: allocation.version,
          releasedQuantity: allocation.releasedQuantity,
          consumedQuantity: allocation.consumedQuantity,
        },
        data: {
          releasedQuantity: { increment: summary.unassignedQuantity },
          version: { increment: 1 },
        },
      });
      if (parentUpdate.count !== 1) {
        throw new AppError('过期库存分配被并发修改，请重试', 409, 'STATE_CONFLICT');
      }

      const expectedAllocated = detailExpectedAllocated.get(
        allocation.inventoryDetailId,
      ) ?? allocation.inventoryDetail.allocatedQuantity;
      if (expectedAllocated < summary.unassignedQuantity) {
        throw new AppError('库存分配投影不足，不能自动释放', 409, 'ALLOCATION_INCONSISTENT');
      }
      const detailUpdate = await tx.inventoryDetail.updateMany({
        where: { id: allocation.inventoryDetailId, allocatedQuantity: expectedAllocated },
        data: { allocatedQuantity: { decrement: summary.unassignedQuantity } },
      });
      if (detailUpdate.count !== 1) {
        throw new AppError('过期库存明细被并发修改，请重试', 409, 'STATE_CONFLICT');
      }
      detailExpectedAllocated.set(
        allocation.inventoryDetailId,
        expectedAllocated - summary.unassignedQuantity,
      );

      await tx.inventoryAllocationEvent.create({
        data: {
          allocationId: allocation.id,
          assignmentId: null,
          kind: 'RELEASE',
          quantity: summary.unassignedQuantity,
          before,
          after: { ...after, reason: 'EXPIRED_UNASSIGNED_RESERVATION' },
          commandId,
          eventNo: 1,
          actorId: null,
        },
      });
      await enqueueBusinessEvent(tx, {
        eventType: 'inventory.allocation.release',
        aggregateType: 'INVENTORY_ALLOCATION',
        aggregateId: allocation.id,
        data: {
          allocationId: allocation.id,
          kind: 'RELEASE',
          allocationVersion: allocation.version + 1,
          refresh: true,
        },
        socket: {
          room: SocketRooms.INVENTORY,
          event: SocketEvents.INVENTORY_UPDATED,
          scope: { capability: 'inventory.read' },
        },
        createdById: null,
      });

      lineReleaseTotals.set(line.id, nextLineTotal);
      releasedAllocations += 1;
      releasedQuantity += summary.unassignedQuantity;
    }

    for (const [lineId, quantity] of lineReleaseTotals) {
      const line = linesById.get(lineId)!;
      const lineUpdate = await tx.quotationLine.updateMany({
        where: { id: line.id, quotationId, reservedQuantity: line.reservedQuantity },
        data: { reservedQuantity: { decrement: quantity } },
      });
      if (lineUpdate.count !== 1) {
        throw new AppError('报价行预留投影被并发修改，请重试', 409, 'STATE_CONFLICT');
      }
    }

    if (releasedQuantity > quotation.reservedQuantity) {
      throw new AppError('过期分配释放量超过报价预留投影', 409, 'ALLOCATION_INCONSISTENT');
    }
    if (releasedQuantity > 0) {
      const quotationUpdate = await tx.quotation.updateMany({
        where: { id: quotation.id, version: quotation.version, reservedQuantity: quotation.reservedQuantity },
        data: {
          reservedQuantity: { decrement: releasedQuantity },
          version: { increment: 1 },
        },
      });
      if (quotationUpdate.count !== 1) {
        throw new AppError('报价预留投影被并发修改，请重试', 409, 'STATE_CONFLICT');
      }
    }

    // Surface the deferred allocation/detail conservation trigger before the
    // interactive transaction callback returns.
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return { releasedAllocations, releasedQuantity };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 }));
}

export async function expireUnassignedAllocations(input: ExpiryInput = {}): Promise<AllocationExpiryResult> {
  const { now, limit } = validateOptions(input);
  const eligible: ExpiredAllocation[] = [];
  let cursorId: string | undefined;
  const pageSize = Math.min(CANDIDATE_PAGE_SIZE, limit);
  // A page is intentionally larger than the remaining result count. We keep
  // scanning after exhausted/fully-assigned expired rows so a stale prefix
  // cannot starve a later unassigned allocation. The ID cursor is stable and
  // avoids offset drift while the worker runs.
  while (eligible.length < limit) {
    const page = await prisma.inventoryAllocation.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: {
        id: true,
        quotationLineId: true,
        inventoryDetailId: true,
        allocatedQuantity: true,
        releasedQuantity: true,
        consumedQuantity: true,
        version: true,
        expiresAt: true,
        assignments: {
          orderBy: { id: 'asc' },
          select: { assignedQuantity: true, releasedQuantity: true, consumedQuantity: true },
        },
        inventoryDetail: { select: { id: true, quantity: true, allocatedQuantity: true } },
        quotationLine: { select: { id: true, quotationId: true } },
      },
    });
    const rows = page as unknown as ExpiredAllocation[];
    if (rows.length === 0) break;
    for (const allocation of rows) {
      if (!allocation.expiresAt || allocation.expiresAt.getTime() > now.getTime()) continue;
      const summary = allocationQuantities({
        allocatedQuantity: allocation.allocatedQuantity,
        releasedQuantity: allocation.releasedQuantity,
        consumedQuantity: allocation.consumedQuantity,
        assignments: allocation.assignments,
      });
      if (summary.unassignedQuantity > 0) eligible.push(allocation);
      if (eligible.length >= limit) break;
    }
    const nextCursorId = rows[rows.length - 1]?.id;
    if (!nextCursorId || nextCursorId === cursorId || rows.length < pageSize) break;
    cursorId = nextCursorId;
  }

  const groups = new Map<string, string[]>();
  for (const allocation of eligible) {
    const quotationId = allocation.quotationLine.quotationId;
    const ids = groups.get(quotationId) ?? [];
    ids.push(allocation.id);
    groups.set(quotationId, ids);
  }

  let releasedAllocations = 0;
  let releasedQuantity = 0;
  for (const quotationId of [...groups.keys()].sort()) {
    const result = await releaseQuotationGroup(quotationId, groups.get(quotationId)!, now);
    releasedAllocations += result.releasedAllocations;
    releasedQuantity += result.releasedQuantity;
  }

  return { scanned: eligible.length, releasedAllocations, releasedQuantity };
}
