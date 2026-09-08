import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { isRfqStatusTransitionAllowed, normalizeRfqStatus, toUiRfqStatus } from '../../lib/rfqStateMachine.js';
import { createInitialStatusHistory, StateTransitionConflictError, transitionRfqStatus } from '../../lib/transactionStateService.js';
import { toRfqStatusEnum } from '../../lib/transactionStatusShadows.js';
import { legacyRfqLineData, rfqLineData, changesLegacyRfqLine, type RfqLineInput } from './legacyLine.js';

export { createInitialStatusHistory, transitionRfqStatus, normalizeRfqStatus, toUiRfqStatus };

function buildRfqNumber() {
  return `RFQ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

type RfqAggregateInput = Omit<Prisma.RFQUncheckedCreateInput, 'rfqNumber' | 'status' | 'statusEnum' | 'version' | 'lines'> & {
  /** Present only for the modern multi-line request. */
  lines?: RfqLineInput[];
};

type RfqUpdateAggregateInput = Prisma.RFQUpdateInput & {
  /** Present only for the modern multi-line request. */
  lines?: RfqLineInput[];
};

type StoredRfqLine = {
  id: string;
  lineNo: number;
  partNumber: string;
  quantity: number;
  uom: string;
  conditionCode: string;
  description: string | null;
  serialNumber: string | null;
  batchNumber: string | null;
  ataChapter?: string | null;
  aircraftType?: string | null;
  aircraftModel?: string | null;
  alternatePartNumbers: string | null;
  certificateRequired: boolean;
  certificateType: string | null;
  requiredDate: Date;
  leadTimeDays: number | null;
  targetPriceDecimal: Prisma.Decimal | null;
  targetPriceCurrency: string;
  status: string;
};

function asLineCreateInput(value: ReturnType<typeof rfqLineData>) {
  // The generated client is refreshed with the nullable aircraft fields by
  // the schema owner. Keeping this cast local lets the compatibility module
  // remain usable while that generated client is being regenerated.
  return value as unknown as Prisma.RfqLineUncheckedCreateWithoutRfqInput;
}

function asLineUpdateInput(value: ReturnType<typeof rfqLineData>) {
  return value as unknown as Prisma.RfqLineUncheckedUpdateWithoutRfqInput;
}

function dateEqual(left: Date | string | null | undefined, right: Date | string | null | undefined) {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  return new Date(left).getTime() === new Date(right).getTime();
}

function decimalEqual(left: Prisma.Decimal | null | undefined, right: Prisma.Decimal | null | undefined) {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  return left.equals(right);
}

function lineFactsChanged(existing: StoredRfqLine, input: RfqLineInput) {
  const next = rfqLineData(input, existing.lineNo);
  return existing.partNumber !== next.partNumber
    || existing.quantity !== next.quantity
    || existing.uom !== next.uom
    || existing.conditionCode !== next.conditionCode
    || existing.description !== next.description
    || existing.serialNumber !== next.serialNumber
    || existing.batchNumber !== next.batchNumber
    || existing.ataChapter !== next.ataChapter
    || existing.aircraftType !== next.aircraftType
    || existing.aircraftModel !== next.aircraftModel
    || existing.alternatePartNumbers !== next.alternatePartNumbers
    || existing.certificateRequired !== next.certificateRequired
    || existing.certificateType !== next.certificateType
    || !dateEqual(existing.requiredDate, next.requiredDate)
    || existing.leadTimeDays !== next.leadTimeDays
    || !decimalEqual(existing.targetPriceDecimal, next.targetPriceDecimal)
    || existing.targetPriceCurrency !== next.targetPriceCurrency;
}

function lineUsage(count: { inquiryItems?: number; supplierQuotes?: number; quotationLines?: number } | undefined) {
  return (count?.inquiryItems ?? 0) + (count?.supplierQuotes ?? 0) + (count?.quotationLines ?? 0);
}

function lineProjection(input: RfqLineInput) {
  return {
    partNumber: input.partNumber,
    quantity: input.quantity,
    uom: input.uom ?? 'EA',
    conditionCode: input.conditionCode ?? 'NE',
    description: input.description,
    serialNumber: input.serialNumber,
    batchNumber: input.batchNumber,
    ataChapter: input.ataChapter,
    aircraftType: input.aircraftType,
    aircraftModel: input.aircraftModel,
    alternatePartNumbers: input.alternatePartNumbers,
    targetPrice: input.targetPrice,
    targetPriceCurrency: input.targetPriceCurrency ?? 'USD',
    certificateRequired: input.certificateRequired ?? true,
    certificateType: input.certificateType,
    requiredDate: new Date(input.requiredDate),
    leadTimeDays: input.leadTimeDays,
  };
}

function headerForLineCreate(data: RfqAggregateInput, lineInputs: RfqLineInput[]) {
  const { lines: _lines, ...header } = data;
  if (!data.lines || data.lines.length === 0) return header;
  // The first line is a compatibility projection only. It is derived on the
  // server, so a stale client header can never replace multi-line facts.
  return { ...header, ...lineProjection(lineInputs[0]) };
}

export async function createRfqAggregate(
  tx: Prisma.TransactionClient,
  data: RfqAggregateInput,
  actorId: string,
) {
  const lineInputs = data.lines && data.lines.length > 0 ? data.lines : [data];
  const lineCreateInputs = lineInputs.map((line, index) => asLineCreateInput(rfqLineData(line, index + 1)));
  const headerData = headerForLineCreate(data, lineInputs);
  const created = await tx.rFQ.create({
    data: {
      ...headerData,
      rfqNumber: buildRfqNumber(),
      status: 'PENDING',
      statusEnum: toRfqStatusEnum('PENDING')!,
      // Presence of `lines` identifies the modern request, even for one row.
      // Keep that mode marker stable so a one-line modern RFQ never falls back
      // to the legacy header projection.
      lineItemsMode: Boolean(data.lines),
      lines: { create: lineCreateInputs },
    },
    include: { customer: true, lines: { orderBy: { lineNo: 'asc' } } },
  });

  await createInitialStatusHistory(tx, {
    entityType: 'RFQ',
    entityId: created.id,
    toStatus: created.status,
    reasonCode: 'RFQ_CREATED',
    actorId,
    version: created.version,
  });

  if (created.emailId) {
    await tx.email.update({
      where: { id: created.emailId },
      data: {
        processingStatus: 'PROCESSED',
        processedAt: new Date(),
        discardedAt: null,
        isRead: true,
      },
    });
  }

  return created;
}

export async function updateRfqAggregate(
  tx: Prisma.TransactionClient,
  id: string,
  data: RfqUpdateAggregateInput,
) {
  const existing = await tx.rFQ.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNo: 'asc' } }, _count: { select: { quotations: true, inquiries: true, supplierQuotes: true } } },
  });
  if (!existing) throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
  const customerChange = ('customerId' in data && (data as Record<string, unknown>).customerId !== existing.customerId)
    || (data.customer !== undefined && data.customer.connect?.id !== existing.customerId);
  const hasSourceReferences = existing._count.quotations > 0
    || existing._count.inquiries > 0
    || existing._count.supplierQuotes > 0;
  // This guard must run before the modern line branch. A multi-line update
  // still carries header fields, and changing the customer after an inquiry
  // or quotation exists would otherwise bypass the legacy protection below.
  if (customerChange && hasSourceReferences) {
    throw new AppError('已有询价或报价引用该需求，请建立新的需求版本以修改客户、件号、数量或交付要求', 409, 'RFQ_SOURCE_ALREADY_USED');
  }
  if (data.lines) {
    if (!existing.lineItemsMode && existing._count.quotations > 0) {
      throw new AppError('已有旧模式报价的需求不能切换交易模式，请新建逐行需求', 409, 'RFQ_SOURCE_ALREADY_USED');
    }
    if (data.lines.length === 0 || data.lines.length > 100) {
      throw new AppError('需求行数量必须在1到100之间', 400, 'VALIDATION_ERROR');
    }
    const lineIds = data.lines.filter((line) => line.id).map((line) => line.id!);
    if (new Set(lineIds).size !== lineIds.length) {
      throw new AppError('需求行ID不能重复', 400, 'INVALID_RFQ_LINE');
    }
    const existingById = new Map(existing.lines.map((line) => [line.id, line as unknown as StoredRfqLine]));
    if (lineIds.some((lineId) => !existingById.has(lineId))) {
      throw new AppError('需求行不属于当前 RFQ', 400, 'INVALID_RFQ_LINE');
    }
    const usageRows = await tx.rfqLine.findMany({
      where: { rfqId: id },
      select: { id: true, _count: { select: { inquiryItems: true, supplierQuotes: true, quotationLines: true } } },
    });
    const usageById = new Map(usageRows.map((row) => [row.id, lineUsage(row._count)]));
    const desiredIds = new Set(lineIds);
    const removed = existing.lines.filter((line) => line.status !== 'CANCELLED' && !desiredIds.has(line.id));
    const changedExisting = data.lines.filter((line) => line.id && lineFactsChanged(existingById.get(line.id!)!, line));
    const reactivatedClosed = data.lines.some((line) => {
      const current = line.id ? existingById.get(line.id) : undefined;
      return current?.status === 'CANCELLED' && (usageById.get(current.id) ?? 0) > 0;
    });
    if (removed.some((line) => (usageById.get(line.id) ?? 0) > 0)
      || changedExisting.some((line) => (usageById.get(line.id!) ?? 0) > 0)
      || reactivatedClosed) {
      throw new AppError('已有询价或报价引用该需求行，不能修改或移除其商业事实', 409, 'RFQ_SOURCE_ALREADY_USED');
    }

    const { lines: _lines, ...rawHeaderData } = data;
    const firstLine = data.lines[0];
    const headerData = {
      ...rawHeaderData,
      ...lineProjection(firstLine),
    } as Prisma.RFQUpdateInput;
    const updated = await tx.rFQ.update({
      where: { id, version: existing.version },
      data: {
        ...headerData,
        version: { increment: 1 },
        lineItemsMode: existing.lineItemsMode || Boolean(data.lines),
      } as Prisma.RFQUpdateInput,
      include: {
        customer: true,
        creator: { select: { id: true, name: true } },
        lines: { orderBy: { lineNo: 'asc' } },
      },
    }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
        throw new StateTransitionConflictError();
      }
      throw error;
    });

    const nextLineNo = Math.max(0, ...existing.lines.map((line) => line.lineNo));
    let allocatedLineNo = nextLineNo;
    for (const line of data.lines) {
      const current = line.id ? existingById.get(line.id) : undefined;
      if (current) {
        if (lineFactsChanged(current, line) || current.status === 'CANCELLED') {
          await tx.rfqLine.update({
            where: { id: current.id },
            data: asLineUpdateInput(rfqLineData(line, current.lineNo)),
          });
        }
      } else {
        allocatedLineNo += 1;
        await tx.rfqLine.create({
          data: { ...asLineCreateInput(rfqLineData(line, allocatedLineNo)), rfqId: id },
        });
      }
    }
    for (const line of removed) {
      await tx.rfqLine.update({ where: { id: line.id }, data: { status: 'CANCELLED' } });
    }
    const lines = await tx.rfqLine.findMany({ where: { rfqId: id }, orderBy: { lineNo: 'asc' } });
    return { ...updated, lines };
  }
  const changesLine = changesLegacyRfqLine(existing, data);
  if (changesLine && existing.lines.length > 1) {
    throw new AppError('多行需求必须按需求行修改，不能使用旧单行编辑入口', 409, 'LINE_ID_REQUIRED');
  }
  if (changesLine && hasSourceReferences) {
    throw new AppError('已有询价或报价引用该需求，请建立新的需求版本以修改客户、件号、数量或交付要求', 409, 'RFQ_SOURCE_ALREADY_USED');
  }
  const updated = await tx.rFQ.update({
    where: { id, version: existing.version },
    data: { ...data, version: { increment: 1 } },
    include: {
      customer: true,
      creator: { select: { id: true, name: true } },
      lines: { orderBy: { lineNo: 'asc' } },
    },
  }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
      throw new StateTransitionConflictError();
    }
    throw error;
  });
  if (changesLine || updated.lines.length === 0) {
    const lineData = legacyRfqLineData(updated);
    const line = await tx.rfqLine.upsert({
      where: { rfqId_lineNo: { rfqId: id, lineNo: 1 } },
      create: { ...lineData, rfqId: id },
      update: lineData,
    });
    return { ...updated, lines: [line] };
  }
  return updated;
}

export function assertRfqTransition(current: string, target: string) {
  const normalizedCurrent = normalizeRfqStatus(current);
  const normalizedTarget = normalizeRfqStatus(target);
  if (!normalizedCurrent || !normalizedTarget || !isRfqStatusTransitionAllowed(current, normalizedTarget)) {
    throw new AppError(`需求单状态不能从 ${normalizedCurrent || current} 转为 ${normalizedTarget || target}`, 409, 'INVALID_STATE_TRANSITION');
  }
  return normalizedTarget;
}
