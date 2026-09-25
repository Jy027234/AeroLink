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
import { enqueueOutboundEmail } from '../lib/outboxService.js';
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

const sendInquirySchema = z.object({
  subject: z.string().max(255).trim().min(1).refine(value => !/[\r\n\u0000]/.test(value), '主题不能包含换行符').optional(),
  textBody: z.string().max(20_000).trim().min(1).refine(value => !value.includes('\u0000'), '正文包含无效字符').optional(),
}).strict().default({});

function inquiryReadScope(actor: NonNullable<AuthRequest['user']>): Prisma.InquiryWhereInput {
  const linked = { rfq: { is: buildRfqReadScope(actor) } } satisfies Prisma.InquiryWhereInput;
  // Unknown historical ownership is never inferred from a matching part number.
  return getCapabilityScope(actor, 'rfq.read') === 'all' ? { OR: [linked, { rfqId: null }] } : linked;
}

function inquiryDeliveryStatus(inquiryStatus: string, emailStatus?: string) {
  if (emailStatus === 'SENT' || inquiryStatus === 'SENT') return 'sent';
  if (emailStatus === 'FAILED' || emailStatus === 'WITHDRAWN') return 'failed';
  if (emailStatus === 'PENDING' || inquiryStatus === 'QUEUED') return 'queued';
  return 'draft';
}

function defaultInquirySubject(inquiry: { inquiryNumber: string; isAOG: boolean; rfq?: { rfqNumber: string } | null }) {
  const markers = [inquiry.isAOG ? 'AOG' : null, inquiry.rfq?.rfqNumber].filter(Boolean).join(' · ');
  return `航材询价 ${inquiry.inquiryNumber}${markers ? ` - ${markers}` : ''}`;
}

function defaultInquiryText(inquiry: {
  inquiryNumber: string;
  isAOG: boolean;
  rfq?: { rfqNumber: string } | null;
  items: Array<{ lineNo: number; partNumber: string; quantity: number; requiredDate: Date; certificateRequired: boolean }>;
}) {
  const lines = [
    '尊敬的供应商：',
    '',
    '请贵司就以下航材需求提供报价。',
    `询价单号：${inquiry.inquiryNumber}`,
    ...(inquiry.rfq?.rfqNumber ? [`需求单号：${inquiry.rfq.rfqNumber}`] : []),
    `紧急程度：${inquiry.isAOG ? 'AOG（停场紧急）' : '标准'}`,
    '',
    '需求明细：',
    ...inquiry.items.map(item => `${item.lineNo}. 件号 ${item.partNumber}；数量 ${item.quantity}；需求日期 ${item.requiredDate.toISOString().slice(0, 10)}；要求适航证书 ${item.certificateRequired ? '是' : '否'}`),
    '',
    '请回复单价及币种、航材状态、交期、证书情况和报价有效期。',
    '',
    '谢谢。',
  ];
  return lines.join('\n');
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
  rfq?: { rfqNumber: string } | null;
  outboundEmails?: Array<{
    id: string;
    status: string;
    errorMessage: string | null;
    sentAt: Date | null;
  }>;
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
  const latestEmail = inquiry.outboundEmails?.[0] ?? null;
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
    deliveryStatus: inquiryDeliveryStatus(inquiry.status, latestEmail?.status),
    latestOutboundEmail: latestEmail ? {
      id: latestEmail.id,
      status: latestEmail.status.toLowerCase(),
      // Raw transport errors can contain server or account details. Expose a
      // stable, actionable message while keeping those details in the logs.
      error: latestEmail.errorMessage ? '邮件投递失败，请检查邮箱配置或联系管理员' : null,
      sentAt: latestEmail.sentAt?.toISOString() ?? null,
    } : null,
  };
}

const inquiryEmailInclude = {
  supplier: { select: { name: true } },
  items: true,
  rfq: { select: { rfqNumber: true } },
  outboundEmails: {
    where: { purpose: 'INQUIRY_SEND' },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, status: true, errorMessage: true, sentAt: true },
  },
};

router.get(
  '/',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const inquiries = await prisma.inquiry.findMany({
      where: inquiryReadScope((req as AuthRequest).user!),
      include: {
        ...inquiryEmailInclude,
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
        ...inquiryEmailInclude,
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
  validateBody(sendInquirySchema),
  asyncHandler(async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const inquiryId = req.params.id;
    const { subject, textBody } = req.body as z.infer<typeof sendInquirySchema>;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actor.id, `POST:/inquiries/${inquiryId}/send`),
      async tx => {
        const inquiry = await tx.inquiry.findFirst({
          where: { id: inquiryId, ...inquiryReadScope(actor) },
          include: {
            supplier: { select: { id: true, name: true, email: true } },
            items: { orderBy: { lineNo: 'asc' } },
            rfq: { include: { creator: { select: { department: true } } } },
          },
        });

        if (!inquiry) throw new AppError('询价单不存在或当前无权访问', 404, 'RESOURCE_NOT_FOUND');
        if (inquiry.status !== 'DRAFT') {
          throw new AppError(`询价状态为 ${inquiry.status}，只有草稿可以发送`, 409, 'STATE_CONFLICT');
        }
        if (inquiry.rfq) {
          assertCapability(actor, 'rfq', 'read', {
            ownerId: inquiry.rfq.createdBy,
            department: inquiry.rfq.creator.department,
          });
        }
        if (!inquiry.items.length) throw new AppError('询价没有需求明细，无法发送', 409, 'STATE_CONFLICT');

        const recipient = inquiry.supplier.email?.trim();
        if (!recipient || !z.string().email().safeParse(recipient).success) {
          throw new AppError('供应商没有有效的询价邮箱，无法发送', 409, 'RESOURCE_CONFLICT');
        }

        const account = await tx.emailAccount.findFirst({
          where: { isDefault: true, isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (!account) throw new AppError('没有已启用的默认邮箱账户，无法发送询价', 409, 'RESOURCE_CONFLICT');

        const emailSubject = subject ?? defaultInquirySubject(inquiry);
        const emailText = textBody ?? defaultInquiryText(inquiry);
        const outboundEmail = await tx.outboundEmail.create({
          data: {
            purpose: 'INQUIRY_SEND',
            inquiryId: inquiry.id,
            accountId: account.id,
            toEmail: recipient,
            subject: emailSubject,
            textBody: emailText,
            status: 'PENDING',
          },
          select: { id: true, status: true, errorMessage: true, sentAt: true },
        });
        const queuedInquiry = await tx.inquiry.update({
          where: { id: inquiry.id },
          data: { status: 'QUEUED' },
        });
        await enqueueOutboundEmail(tx, {
          eventType: 'inquiry.email.send',
          aggregateType: 'INQUIRY',
          aggregateId: inquiry.id,
          outboundEmailId: outboundEmail.id,
          createdById: actor.id,
        });

        return {
          payload: serializeInquiry({
            ...inquiry,
            ...queuedInquiry,
            status: 'QUEUED',
            outboundEmails: [outboundEmail],
          }),
          statusCode: 202,
          resourceType: 'INQUIRY',
          resourceId: inquiry.id,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // A cached idempotent response must not survive a later loss of RFQ access.
    const current = await prisma.inquiry.findFirst({
      where: { id: inquiryId, ...inquiryReadScope(actor) },
      select: { id: true },
    });
    if (!current) throw new AppError('询价单不存在或当前无权访问', 404, 'RESOURCE_NOT_FOUND');
    applyIdempotencyHeaders(res, execution);
    res.status(execution.statusCode).json({ success: true, data: execution.payload });
  })
);

export default router;
