import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { assertActiveQuotationRevision } from '../../lib/quotationRevisionPolicy.js';
import { StateTransitionConflictError } from '../../lib/transactionStateService.js';
import { enqueueBusinessEvent } from '../../lib/outboxService.js';
import { SocketEvents, SocketRooms } from '../../lib/socketEvents.js';
import { releaseInventoryReservation, releaseUnassignedQuotationInventory } from '../inventoryQuality/index.js';
import { createQuotationAggregate, type CreateQuotationArgs } from './service.js';

type RevisionInput<T = CreateQuotationArgs> = T extends unknown
  ? Omit<T, 'tx' | 'actorId' | 'authorizeRfq' | 'draftOnly'> : never;

/** One new commercial offer, in the same transaction that retires its predecessor. */
export async function reviseQuotationAggregate(args: {
  tx: Prisma.TransactionClient;
  quotationId: string;
  actorId: string;
  version: number;
  reason: string;
  quotation: RevisionInput;
  authorize: (quotation: { createdBy: string; creator?: { department: string | null } | null }) => void;
  authorizeRfq: NonNullable<CreateQuotationArgs['authorizeRfq']>;
}) {
  const { tx, quotation: input } = args;
  const original = await tx.quotation.findUnique({ where: { id: args.quotationId }, include: {
    creator: { select: { department: true } }, lines: true,
    _count: { select: { orders: true } },
  } });
  if (!original) throw new AppError('原报价不存在', 404, 'RESOURCE_NOT_FOUND');
  args.authorize(original);
  assertActiveQuotationRevision(original);
  if (original.version !== args.version) throw new StateTransitionConflictError();
  if (!args.reason.trim() || !input.validityDays) throw new AppError('修订必须明确原因和新的有效天数', 400, 'BAD_REQUEST');
  if (input.rfqId !== original.rfqId || input.customerId !== original.customerId
    || Boolean(input.lines) !== original.lineItemsMode) {
    throw new AppError('商业修订不能更换需求、客户或交易模式', 409, 'RESOURCE_CONFLICT');
  }
  if (original.status === 'ACCEPTED' || (!original.lineItemsMode && original._count.orders > 0)) {
    throw new AppError('已全部成交的报价不能修订，请通过订单变更处理', 409, 'RESOURCE_CONFLICT');
  }
  if (await tx.outboundEmail.count({ where: { quotationId: original.id, status: 'PENDING' } })) {
    throw new AppError('报价邮件仍在投递，请等待投递结果后修订', 409, 'RESOURCE_CONFLICT');
  }

  // Claim both the RFQ and prior offer. Accept and revise therefore cannot
  // concurrently consume the same old commercial offer or demand remainder.
  const rfq = await tx.rFQ.findUnique({ where: { id: original.rfqId }, include: { lines: true } });
  if (!rfq) throw new AppError('需求不存在', 404, 'RESOURCE_NOT_FOUND');
  if (['COMPLETED', 'CANCELLED'].includes(rfq.status)) {
    throw new AppError('需求已关闭，不能创建新的商业修订', 409, 'RESOURCE_CONFLICT');
  }
  const rfqClaim = await tx.rFQ.updateMany({ where: { id: rfq.id, version: rfq.version }, data: { version: { increment: 1 } } });
  if (rfqClaim.count !== 1) throw new StateTransitionConflictError();
  const claim = await tx.quotation.updateMany({ where: { id: original.id, version: args.version, supersededAt: null },
    data: { supersededAt: new Date(), version: { increment: 1 } } });
  if (claim.count !== 1) throw new StateTransitionConflictError();

  if (input.lines) {
    for (const line of input.lines) {
      const demand = rfq.lines.find(item => item.id === line.rfqLineId);
      const sold = await tx.orderLine.aggregate({ where: {
        quotationLine: { rfqLineId: line.rfqLineId }, order: { status: { not: 'CANCELLED' } },
      }, _sum: { quantity: true } });
      if (!demand || line.quantity > demand.quantity - (sold._sum.quantity ?? 0)) {
        throw new AppError('修订报价数量超过需求行未成交数量', 409, 'RESOURCE_CONFLICT');
      }
    }
  }
  if (original.lineItemsMode) {
    await releaseUnassignedQuotationInventory({ tx, quotationId: original.id, actorId: args.actorId,
      reason: `商业修订：${args.reason}`, commandId: `revision:${original.id}:${args.version}` });
  } else if (original.reservedQuantity > 0) {
    await releaseInventoryReservation(tx, { quotationId: original.id, actorId: args.actorId,
      notes: `商业修订释放原报价预留：${args.reason}`, updateQuotation: false });
    await tx.quotation.update({ where: { id: original.id }, data: { reservedQuantity: 0 } });
    await tx.quotationLine.updateMany({ where: { quotationId: original.id }, data: { reservedQuantity: 0 } });
  }
  const created = await createQuotationAggregate({ ...input, eSignature: undefined, eSignatureStatus: 'Unsigned', tx, actorId: args.actorId,
    authorizeRfq: args.authorizeRfq, ...(!input.lines ? { draftOnly: true as const } : {}),
  });
  const rootId = original.revisionRootId ?? original.id;
  const root = original.revisionRootId
    ? await tx.quotation.findUniqueOrThrow({ where: { id: rootId }, select: { quoteNumber: true } }) : original;
  const nextRevision = original.commercialRevision + 1;
  const quotation = await tx.quotation.update({ where: { id: created.quotation.id }, data: {
    quoteNumber: `${root.quoteNumber}-R${nextRevision}`, commercialRevision: nextRevision,
    revisionOfId: original.id, revisionRootId: rootId, revisionReason: args.reason.trim(),
  }, include: { customer: true, creator: { select: { department: true } }, lines: { orderBy: { lineNo: 'asc' } } } });
  await tx.transactionStatusHistory.create({ data: {
    entityType: 'QUOTATION', entityId: original.id, fromStatus: original.status, toStatus: original.status,
    actorId: args.actorId, reasonCode: 'COMMERCIAL_REVISION_CREATED', reason: args.reason.trim(), version: original.version + 1,
  } });
  await enqueueBusinessEvent(tx, { eventType: 'quotation.revised', aggregateType: 'QUOTATION', aggregateId: original.id,
    data: { quotationId: original.id, revisedQuotationId: quotation.id, commercialRevision: nextRevision },
    socket: { event: SocketEvents.QUOTATION_UPDATED, room: SocketRooms.QUOTATIONS }, createdById: args.actorId,
  });
  return { quotation, previousQuotationId: original.id };
}
