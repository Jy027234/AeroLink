import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import type { AuthRequest } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { buildRfqReadScope } from '../lib/rfqAccess.js';
import { getCapabilityScope } from '../lib/capabilityPolicy.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { legacyRfqLineData } from '../modules/rfqSourcing/index.js';
import prisma from '../lib/prisma.js';

const router = Router();

function generateInquiryNumber(): string {
  return `INQ-${new Date().getFullYear()}-${randomUUID().slice(0, 12).toUpperCase()}`;
}

const createInquirySchema = z.object({
  rfqId: z.string().min(1), supplierIds: z.array(z.string().min(1)).min(1).max(50),
  lineIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  isAOG: z.boolean().optional(), notes: z.string().max(4000).optional(),
}).strict();

function inquiryReadScope(actor: NonNullable<AuthRequest['user']>): Prisma.InquiryWhereInput {
  const linked = { rfq: { is: buildRfqReadScope(actor) } } satisfies Prisma.InquiryWhereInput;
  // Unknown historical ownership is never inferred from a matching part number.
  return getCapabilityScope(actor, 'rfq.read') === 'all' ? { OR: [linked, { rfqId: null }] } : linked;
}

function serializeInquiry(inquiry: {
  id: string;
  inquiryNumber: string;
  supplierId: string;
  rfqId?: string | null;
  notes?: string | null;
  isAOG: boolean;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  supplier: { name: string };
  items: Array<{
    id: string;
    lineNo: number;
    rfqLineId: string | null;
    partNumber: string;
    quantity: number;
    requiredDate: Date;
    certificateRequired: boolean;
  }>;
}) {
  return {
    id: inquiry.id,
    inquiryNumber: inquiry.inquiryNumber,
    supplierId: inquiry.supplierId,
    rfqId: inquiry.rfqId ?? null,
    notes: inquiry.notes ?? null,
    sourceVerified: Boolean(inquiry.rfqId),
    supplierName: inquiry.supplier.name,
    items: inquiry.items.map((item) => ({
      id: item.id,
      lineNo: item.lineNo,
      rfqLineId: item.rfqLineId,
      partNumber: item.partNumber,
      quantity: item.quantity,
      requiredDate: item.requiredDate.toISOString(),
      certificateRequired: item.certificateRequired,
    })),
    isAOG: inquiry.isAOG,
    status: inquiry.status.toLowerCase(),
    createdAt: inquiry.createdAt.toISOString(),
    sentAt: inquiry.sentAt?.toISOString(),
  };
}

router.get(
  '/',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const inquiries = await prisma.inquiry.findMany({
      where: inquiryReadScope((req as AuthRequest).user!),
      include: {
        supplier: { select: { name: true } },
        items: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: inquiries.map(serializeInquiry),
    });
  })
);

router.get(
  '/:id',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const inquiry = await prisma.inquiry.findFirst({
      where: { id: req.params.id, ...inquiryReadScope((req as AuthRequest).user!) },
      include: {
        supplier: { select: { name: true } },
        items: true,
      },
    });

    if (!inquiry) {
      throw new AppError('询价单不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: serializeInquiry(inquiry),
    });
  })
);

router.post(
  '/',
  requireCapability('supplier_quote', 'create'),
  validateBody(createInquirySchema),
  asyncHandler(async (req, res) => {
    const { rfqId, supplierIds, lineIds, isAOG, notes } = req.body as z.infer<typeof createInquirySchema>;
    const actor = (req as AuthRequest).user!;
    const execution = await runIdempotentOperation(buildIdempotencyContext(req, actor.id, 'POST:/inquiries'), async tx => {
      const rfq = await tx.rFQ.findUnique({ where: { id: rfqId }, include: { lines: { orderBy: { lineNo: 'asc' } }, creator: { select: { department: true } } } });
      if (!rfq) throw new AppError('RFQ 不存在', 404, 'RESOURCE_NOT_FOUND');
      assertCapability(actor, 'rfq', 'read', { ownerId: rfq.createdBy, department: rfq.creator.department });
      if (rfq.status === 'CANCELLED' || rfq.status === 'COMPLETED') throw new AppError('需求已关闭，不能建立询价', 409, 'INVALID_STATE_TRANSITION');
      const uniqueSupplierIds = Array.from(new Set(supplierIds));
      const suppliers = await tx.supplier.findMany({ where: { id: { in: uniqueSupplierIds } }, select: { id: true } });
      if (suppliers.length !== uniqueSupplierIds.length) throw new AppError('存在无效供应商', 400, 'VALIDATION_ERROR');
      let lines = rfq.lines;
      if (lines.length === 0) {
        // The RFQ primary key supplies direct provenance for its one compatibility line.
        lines = [await tx.rfqLine.create({ data: { ...legacyRfqLineData(rfq), rfqId } })];
      }
      if (!lineIds && lines.length > 1) throw new AppError('多行需求必须选择需求行', 409, 'LINE_ID_REQUIRED');
      const selected = lineIds ? lines.filter(line => lineIds.includes(line.id)) : lines;
      if (lineIds && (new Set(lineIds).size !== lineIds.length || selected.length !== lineIds.length)) throw new AppError('需求行不属于当前 RFQ 或存在重复', 400, 'INVALID_RFQ_LINE');
      if (selected.some(line => line.status !== 'OPEN')) throw new AppError('所选需求行已关闭', 409, 'INVALID_STATE_TRANSITION');
      const inquiries = [];
      for (const supplierId of uniqueSupplierIds) {
        inquiries.push(await tx.inquiry.create({
          data: {
            inquiryNumber: generateInquiryNumber(),
            supplierId,
            rfqId,
            notes,
            isAOG: isAOG ?? rfq.urgency === 'AOG',
            status: 'DRAFT',
            items: {
              create: selected.map((line, index) => ({
                lineNo: index + 1, rfqLineId: line.id, partNumber: line.partNumber,
                quantity: line.quantity, requiredDate: line.requiredDate, certificateRequired: line.certificateRequired,
              })),
            },
          },
          include: {
            supplier: { select: { name: true } },
            items: true,
          },
        }));
      }
      return { payload: inquiries.map(serializeInquiry), statusCode: 201, resourceType: 'RFQ', resourceId: rfqId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    // Cached payloads are still subject to current RFQ access on every replay.
    const current = await prisma.rFQ.findFirst({ where: { id: rfqId, ...buildRfqReadScope(actor) }, select: { id: true } });
    if (!current) throw new AppError('RFQ 不存在或当前无权访问', 404, 'RESOURCE_NOT_FOUND');
    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({
      success: true,
      data: execution.payload,
    });
  })
);

router.post(
  '/:id/send',
  requireCapability('supplier_quote', 'create'),
  asyncHandler(async (req, _res) => {
    const inquiry = await prisma.inquiry.findFirst({
      where: { id: req.params.id, ...inquiryReadScope((req as AuthRequest).user!) },
      include: {
        supplier: { select: { name: true } },
        items: true,
      },
    });

    if (!inquiry) {
      throw new AppError('询价单不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    throw new AppError('询价尚未发送。请核对草稿并人工联系供应商；当前入口没有发送通道。', 409, 'MANUAL_WORKFLOW_REQUIRED');
  })
);

export default router;
