import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import { rfqCreateSchema, rfqStatusUpdateSchema } from '../lib/validation.js';
import { AuthRequest } from '../middleware/auth.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { enqueueBusinessEvent } from '../lib/outboxService.js';
import { isRfqStatusTransitionAllowed, normalizeRfqStatus, toUiRfqStatus } from '../lib/rfqStateMachine.js';
import { SocketEvents, SocketRooms } from '../lib/socketEvents.js';
import { createInitialStatusHistory, transitionRfqStatus } from '../lib/transactionStateService.js';
import {
  preferredQuotationStatus,
  preferredRfqStatus,
  toRfqStatusEnum,
} from '../lib/transactionStatusShadows.js';
import { getCapabilityScope } from '../lib/capabilityPolicy.js';
import prisma from '../lib/prisma.js';

const router = Router();

type ScopedRfq = {
  createdBy: string;
  creator?: { department?: string | null } | null;
};

function buildRfqReadScope(actor: NonNullable<AuthRequest['user']>): Prisma.RFQWhereInput {
  const scope = getCapabilityScope(actor, 'rfq.read');
  if (scope === 'all') return {};

  const own: Prisma.RFQWhereInput = { createdBy: actor.id };
  const department = actor.department
    ? { creator: { is: { department: actor.department } } } satisfies Prisma.RFQWhereInput
    : undefined;

  if (scope === 'department') return department ?? own;
  if (scope === 'department_or_own') {
    return department ? { OR: [own, department] } : own;
  }
  return own;
}

function assertRfqAccess(
  actor: NonNullable<AuthRequest['user']>,
  action: 'read' | 'update' | 'transition',
  rfq: ScopedRfq,
) {
  assertCapability(actor, 'rfq', action, {
    ownerId: rfq.createdBy,
    department: rfq.creator?.department,
  });
}

function parseAlternatePartNumbers(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
}

function toRfqResponse(rfq: Awaited<ReturnType<typeof prisma.rFQ.findUnique>> & { customer?: { name: string }; creator?: { name: string } }) {
  if (!rfq) return null;
  return {
    id: rfq.id,
    rfqNumber: rfq.rfqNumber,
    customerId: rfq.customerId,
    customerName: rfq.customer?.name || '',
    partNumber: rfq.partNumber,
    quantity: rfq.quantity,
    uom: rfq.uom,
    conditionCode: rfq.conditionCode,
    description: rfq.description,
    serialNumber: rfq.serialNumber,
    batchNumber: rfq.batchNumber,
    ataChapter: rfq.ataChapter,
    aircraftType: rfq.aircraftType,
    aircraftModel: rfq.aircraftModel,
    alternatePartNumbers: parseAlternatePartNumbers(rfq.alternatePartNumbers),
    targetPrice: rfq.targetPrice,
    targetPriceCurrency: rfq.targetPriceCurrency,
    certificateRequired: rfq.certificateRequired,
    certificateType: rfq.certificateType,
    requiredDate: rfq.requiredDate.toISOString().split('T')[0],
    responseDeadline: rfq.responseDeadline?.toISOString().split('T')[0],
    leadTimeDays: rfq.leadTimeDays,
    urgency: rfq.urgency.toLowerCase(),
    urgencyJustification: rfq.urgencyJustification,
    status: toUiRfqStatus(preferredRfqStatus(rfq.statusEnum, rfq.status)),
    version: rfq.version,
    notes: rfq.notes,
    createdAt: rfq.createdAt.toISOString(),
    createdBy: rfq.creator?.name || '',
  };
}

function mapStatusHistoryEntry(history: {
  id: string;
  entityType: string;
  entityId: string;
  fromStatus: string | null;
  toStatus: string;
  reasonCode: string;
  reason: string | null;
  actorId: string | null;
  version: number;
  createdAt: Date;
  actor?: { id: string; name: string } | null;
}) {
  return {
    id: history.id,
    entityType: history.entityType,
    entityId: history.entityId,
    fromStatus: history.fromStatus ? toUiRfqStatus(history.fromStatus) : null,
    toStatus: toUiRfqStatus(history.toStatus),
    reasonCode: history.reasonCode,
    reason: history.reason,
    actorId: history.actorId,
    actorName: history.actor?.name || null,
    version: history.version,
    createdAt: history.createdAt.toISOString(),
  };
}

router.get(
  '/',
  requireCapability('rfq', 'read'),
  asyncHandler(async (req, res) => {
    const { status, urgency, search, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const scopedWhere = buildRfqReadScope((req as AuthRequest).user!);
    const filters: Prisma.RFQWhereInput[] = [scopedWhere];
    if (status) {
      const statusValue = status.toString();
      filters.push({ status: normalizeRfqStatus(statusValue) || statusValue.toUpperCase() });
    }
    if (urgency) filters.push({ urgency: urgency.toString().toUpperCase() });
    const searchValue = typeof search === 'string' ? search.trim() : '';
    if (searchValue) {
      filters.push({
        OR: [
          { rfqNumber: { contains: searchValue, mode: 'insensitive' } },
          { partNumber: { contains: searchValue, mode: 'insensitive' } },
          { customer: { is: { name: { contains: searchValue, mode: 'insensitive' } } } },
        ],
      });
    }
    const where: Prisma.RFQWhereInput = filters.length === 1 ? filters[0] : { AND: filters };

    const [rfqs, total, statusCounts] = await Promise.all([
      prisma.rFQ.findMany({
        where,
        include: {
          customer: true,
          creator: {
            select: { id: true, name: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.rFQ.count({ where }),
      prisma.rFQ.groupBy({
        where,
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const summaryCount = (statusValue: string) =>
      statusCounts.find((entry) => entry.status === statusValue)?._count._all || 0;
    const summary = {
      total: statusCounts.reduce((sum, entry) => sum + entry._count._all, 0),
      pending: summaryCount('PENDING'),
      sourcing: summaryCount('SOURCING'),
      quoting: summaryCount('QUOTING'),
      won: summaryCount('COMPLETED'),
      lost: summaryCount('CANCELLED'),
    };

    res.json({
      success: true,
      data: rfqs.map((rfq) => toRfqResponse(rfq)),
      summary,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  })
);

router.get(
  '/:id/status-history',
  requireCapability('rfq', 'read'),
  asyncHandler(async (req, res) => {
    const rfq = await prisma.rFQ.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        createdBy: true,
        creator: { select: { department: true } },
      },
    });

    if (!rfq) {
      throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
    }
    assertRfqAccess((req as AuthRequest).user!, 'read', rfq);

    const history = await prisma.transactionStatusHistory.findMany({
      where: { entityType: 'RFQ', entityId: rfq.id },
      include: {
        actor: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      success: true,
      data: history.map(mapStatusHistoryEntry),
    });
  })
);

router.get(
  '/:id',
  requireCapability('rfq', 'read'),
  asyncHandler(async (req, res) => {
    const rfq = await prisma.rFQ.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        creator: {
          select: { id: true, name: true, department: true },
        },
        quotations: true,
      },
    });

    if (!rfq) {
      throw new AppError('RFQ不存在', 404);
    }
    assertRfqAccess((req as AuthRequest).user!, 'read', rfq);

    res.json({
      success: true,
      data: {
        ...toRfqResponse(rfq),
        quotations: rfq.quotations.map((q) => ({
          id: q.id,
          quoteNumber: q.quoteNumber,
          status: preferredQuotationStatus(q.statusEnum, q.status).toLowerCase(),
        })),
      },
    });
  })
);

router.post(
  '/',
  requireCapability('rfq', 'create'),
  validateBody(rfqCreateSchema),
  asyncHandler(async (req, res) => {
    const {
      customerId,
      partNumber,
      quantity,
      uom,
      conditionCode,
      description,
      serialNumber,
      batchNumber,
      ataChapter,
      aircraftType,
      aircraftModel,
      alternatePartNumbers,
      targetPrice,
      targetPriceCurrency,
      certificateRequired,
      certificateType,
      requiredDate,
      responseDeadline,
      leadTimeDays,
      urgency,
      urgencyJustification,
      notes,
      emailId,
    } = req.body;

    const userId = (req as AuthRequest).user!.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, userId, 'POST:/rfqs'),
      async (tx) => {
        const rfqNumber = `RFQ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const created = await tx.rFQ.create({
          data: {
            rfqNumber,
            customerId,
            partNumber,
            quantity,
            uom,
            conditionCode,
            description,
            serialNumber,
            batchNumber,
            ataChapter,
            aircraftType,
            aircraftModel,
            alternatePartNumbers,
            targetPrice,
            targetPriceCurrency,
            certificateRequired,
            certificateType,
            requiredDate: requiredDate ? new Date(requiredDate) : new Date(),
            responseDeadline: responseDeadline ? new Date(responseDeadline) : undefined,
            leadTimeDays,
            urgency: urgency?.toUpperCase() || 'STANDARD',
            urgencyJustification,
            status: 'PENDING',
            statusEnum: toRfqStatusEnum('PENDING')!,
            notes,
            emailId,
            createdBy: userId,
          },
          include: {
            customer: true,
          },
        });

        await createInitialStatusHistory(tx, {
          entityType: 'RFQ',
          entityId: created.id,
          toStatus: created.status,
          reasonCode: 'RFQ_CREATED',
          actorId: userId,
          version: created.version,
        });

        await enqueueBusinessEvent(tx, {
          eventType: 'rfq.created',
          aggregateType: 'RFQ',
          aggregateId: created.id,
          data: {
            rfqId: created.id,
            rfqNumber: created.rfqNumber,
            customerId: created.customerId,
            customerName: created.customer.name,
            partNumber: created.partNumber,
            quantity: created.quantity,
            requiredDate: created.requiredDate.toISOString(),
            urgency: created.urgency,
            status: created.status,
            createdBy: userId,
          },
          socket: {
            room: SocketRooms.RFQS,
            event: SocketEvents.RFQ_CREATED,
          },
          createdById: userId,
        });

        return {
          payload: toRfqResponse(created),
          statusCode: 201,
          resourceType: 'RFQ',
          resourceId: created.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.patch(
  '/:id',
  requireCapability('rfq', 'update'),
  validateBody(rfqCreateSchema.partial()),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const updateData: Prisma.RFQUpdateInput = {};
    const fields: string[] = [
      'customerId',
      'partNumber',
      'quantity',
      'uom',
      'conditionCode',
      'description',
      'serialNumber',
      'batchNumber',
      'ataChapter',
      'aircraftType',
      'aircraftModel',
      'alternatePartNumbers',
      'targetPrice',
      'targetPriceCurrency',
      'certificateRequired',
      'certificateType',
      'leadTimeDays',
      'urgency',
      'urgencyJustification',
      'notes',
    ];

    fields.forEach((field) => {
      if (field in req.body) {
        (updateData as Record<string, unknown>)[field] = (req.body as Record<string, unknown>)[field];
      }
    });

    if (req.body.requiredDate) {
      updateData.requiredDate = new Date(req.body.requiredDate);
    }
    if (req.body.responseDeadline) {
      updateData.responseDeadline = new Date(req.body.responseDeadline);
    }
    if (req.body.urgency) {
      updateData.urgency = req.body.urgency.toUpperCase();
    }

    const userId = (req as AuthRequest).user!.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, userId, 'PATCH:/rfqs/:id'),
      async (tx) => {
        const existing = await tx.rFQ.findUnique({
          where: { id },
          include: { creator: { select: { department: true } } },
        });
        if (!existing) {
          throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        assertRfqAccess((req as AuthRequest).user!, 'update', existing);

        const rfq = await tx.rFQ.update({
          where: { id },
          data: updateData,
          include: {
            customer: true,
            creator: {
              select: { id: true, name: true },
            },
          },
        });

        return {
          payload: toRfqResponse(rfq),
          resourceType: 'RFQ',
          resourceId: rfq.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.patch(
  '/:id/status',
  requireCapability('rfq', 'transition'),
  validateBody(rfqStatusUpdateSchema),
  asyncHandler(async (req, res) => {
    const nextStatus = String(req.body.status);
    const userId = (req as AuthRequest).user!.id;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, userId, 'PATCH:/rfqs/:id/status'),
      async (tx) => {
        const current = await tx.rFQ.findUnique({
          where: { id: req.params.id },
          include: { creator: { select: { department: true } } },
        });
        if (!current) {
          throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
        }
        assertRfqAccess((req as AuthRequest).user!, 'transition', current);

        const effectiveCurrentStatus = preferredRfqStatus(current.statusEnum, current.status);
        const currentStatus = normalizeRfqStatus(effectiveCurrentStatus);
        const normalizedNextStatus = toRfqStatusEnum(nextStatus);
        if (!currentStatus || !normalizedNextStatus || !isRfqStatusTransitionAllowed(effectiveCurrentStatus, normalizedNextStatus)) {
          throw new AppError(`RFQ 不允许从 ${toUiRfqStatus(effectiveCurrentStatus)} 变更为 ${toUiRfqStatus(nextStatus)}`, 409, 'INVALID_STATE_TRANSITION');
        }

        const isNoop = currentStatus === normalizedNextStatus;
        const rfq = isNoop
          ? await tx.rFQ.findUnique({
            where: { id: req.params.id },
            include: {
              customer: true,
              creator: {
                select: { id: true, name: true },
              },
            },
          })
          : await (async () => {
            await transitionRfqStatus(tx, {
              id: current.id,
              currentStatus: current.status,
              currentVersion: current.version,
              nextStatus: normalizedNextStatus,
              expectedVersion: req.body.version,
              actorId: userId,
              reasonCode: req.body.reasonCode || 'MANUAL_STATUS_UPDATE',
              reason: req.body.reason,
            });

            return tx.rFQ.findUnique({
              where: { id: req.params.id },
              include: {
                customer: true,
                creator: {
                  select: { id: true, name: true },
                },
              },
            });
          })();

        if (!rfq) {
          throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
        }

        if (!isNoop) {
          await enqueueBusinessEvent(tx, {
            eventType: 'rfq.status.changed',
            aggregateType: 'RFQ',
            aggregateId: rfq.id,
            data: {
              rfqId: rfq.id,
              rfqNumber: rfq.rfqNumber,
              oldStatus: effectiveCurrentStatus,
              newStatus: preferredRfqStatus(rfq.statusEnum, rfq.status),
              changedBy: userId,
              changedAt: new Date().toISOString(),
            },
            socket: {
              room: SocketRooms.RFQS,
              event: SocketEvents.RFQ_UPDATED,
            },
            createdById: userId,
          });
        }

        return {
          payload: toRfqResponse(rfq),
          resourceType: 'RFQ',
          resourceId: rfq.id,
        };
      },
    );

    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  }),
);

export default router;
