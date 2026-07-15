import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { rfqCreateSchema, rfqStatusUpdateSchema } from '../lib/validation.js';
import { AuthRequest } from '../middleware/auth.js';
import { emitWebhookEvent } from '../lib/webhookService.js';
import { isRfqStatusTransitionAllowed, normalizeRfqStatus, toUiRfqStatus } from '../lib/rfqStateMachine.js';
import { createInitialStatusHistory, transitionRfqStatus } from '../lib/transactionStateService.js';
import prisma from '../lib/prisma.js';

const router = Router();

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
    status: toUiRfqStatus(rfq.status),
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
  asyncHandler(async (req, res) => {
    const { status, urgency, search, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.RFQWhereInput = {};
    if (status) {
      const statusValue = status.toString();
      where.status = normalizeRfqStatus(statusValue) || statusValue.toUpperCase();
    }
    if (urgency) where.urgency = urgency.toString().toUpperCase();
    const searchValue = typeof search === 'string' ? search.trim() : '';
    if (searchValue) {
      where.OR = [
        { rfqNumber: { contains: searchValue, mode: 'insensitive' } },
        { partNumber: { contains: searchValue, mode: 'insensitive' } },
        { customer: { is: { name: { contains: searchValue, mode: 'insensitive' } } } },
      ];
    }

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
  asyncHandler(async (req, res) => {
    const rfq = await prisma.rFQ.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });

    if (!rfq) {
      throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
    }

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
  asyncHandler(async (req, res) => {
    const rfq = await prisma.rFQ.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        creator: {
          select: { id: true, name: true },
        },
        quotations: true,
      },
    });

    if (!rfq) {
      throw new AppError('RFQ不存在', 404);
    }

    res.json({
      success: true,
      data: {
        ...toRfqResponse(rfq),
        quotations: rfq.quotations.map((q) => ({
          id: q.id,
          quoteNumber: q.quoteNumber,
          status: q.status.toLowerCase(),
        })),
      },
    });
  })
);

router.post(
  '/',
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

    const rfqNumber = `RFQ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    const userId = (req as AuthRequest).user!.id;
    const rfq = await prisma.$transaction(async (tx) => {
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

      return created;
    });

    await emitWebhookEvent('rfq.created', {
      rfqId: rfq.id,
      rfqNumber: rfq.rfqNumber,
      customerId: rfq.customerId,
      customerName: rfq.customer.name,
      partNumber: rfq.partNumber,
      quantity: rfq.quantity,
      requiredDate: rfq.requiredDate.toISOString(),
      urgency: rfq.urgency,
      status: rfq.status,
      createdBy: (req as AuthRequest).user?.id,
    });

    res.status(201).json({
      success: true,
      data: toRfqResponse(rfq),
    });
  })
);

router.patch(
  '/:id',
  validateBody(rfqCreateSchema.partial()),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await prisma.rFQ.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('RFQ不存在', 404);
    }

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

    const rfq = await prisma.rFQ.update({
      where: { id },
      data: updateData,
      include: {
        customer: true,
        creator: {
          select: { id: true, name: true },
        },
      },
    });

    res.json({
      success: true,
      data: toRfqResponse(rfq),
    });
  })
);

router.patch(
  '/:id/status',
  validateBody(rfqStatusUpdateSchema),
  asyncHandler(async (req, res) => {
    const nextStatus = String(req.body.status);

    const current = await prisma.rFQ.findUnique({ where: { id: req.params.id } });
    if (!current) {
      throw new AppError('RFQ不存在', 404);
    }

    const currentStatus = normalizeRfqStatus(current.status);
    if (!currentStatus || !isRfqStatusTransitionAllowed(current.status, nextStatus)) {
      throw new AppError(`RFQ 不允许从 ${toUiRfqStatus(current.status)} 变更为 ${toUiRfqStatus(nextStatus)}`, 409, 'INVALID_STATE_TRANSITION');
    }

    const isNoop = current.status === nextStatus;
    const rfq = isNoop
      ? await prisma.rFQ.findUnique({
        where: { id: req.params.id },
        include: {
          customer: true,
          creator: {
            select: { id: true, name: true },
          },
        },
      })
      : await prisma.$transaction(async (tx) => {
        await transitionRfqStatus(tx, {
          id: current.id,
          currentStatus: current.status,
          currentVersion: current.version,
          nextStatus,
          expectedVersion: req.body.version,
          actorId: (req as AuthRequest).user?.id,
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
      });

    if (!rfq) {
      throw new AppError('RFQ不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (current.status !== rfq.status) {
      await emitWebhookEvent('rfq.status.changed', {
        rfqId: rfq.id,
        rfqNumber: rfq.rfqNumber,
        oldStatus: current.status,
        newStatus: rfq.status,
        changedBy: (req as AuthRequest).user?.id,
        changedAt: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      data: toRfqResponse(rfq),
    });
  })
);

export default router;
