import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import type { AuthRequest } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { buildRfqReadScope } from '../lib/rfqAccess.js';
import { applyIdempotencyHeaders, buildIdempotencyContext, runIdempotentOperation } from '../lib/idempotencyService.js';
import { inquiryReadScope, sendInquiryCommand } from '../lib/inquirySendCommand.js';
import { legacyRfqLineData } from '../modules/rfqSourcing/index.js';
import prisma from '../lib/prisma.js';
import { MAX_INQUIRY_ATTACHMENT_BYTES, listInquiryAttachmentSnapshots, persistInquiryAttachment } from '../lib/inquiryAttachments.js';
import { isUploadSizeAllowed, verifyFileSignature } from './upload.js';
import { hasUnsafeInquiryAttachmentContent, isSafeInquiryAttachmentFilename } from '../lib/inquiryAttachmentSafety.js';

const router = Router();

const attachmentMimeTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const inquiryAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      const stagingDirectory = path.resolve(process.env.UPLOAD_STAGING_DIR || path.join(os.tmpdir(), 'aerolink-upload-staging'));
      fs.mkdir(stagingDirectory, { recursive: true }, (error) => callback(error, stagingDirectory));
    },
    filename: (_req, _file, callback) => callback(null, `inquiry-attachment-${randomUUID()}`),
  }),
  fileFilter: (_req, file, callback) => {
    if (attachmentMimeTypes.has(file.mimetype) && isSafeInquiryAttachmentFilename(file.originalname, file.mimetype)) callback(null, true);
    else callback(new AppError('不支持的文件类型', 400, 'VALIDATION_ERROR'));
  },
  limits: { fileSize: MAX_INQUIRY_ATTACHMENT_BYTES, files: 1 },
});
const receiveInquiryAttachment = (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
  inquiryAttachmentUpload.single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      next(new AppError(error.code === 'LIMIT_FILE_SIZE' ? '单个附件不能超过 10 MB' : '附件上传请求无效', 400, 'VALIDATION_ERROR'));
      return;
    }
    next(error);
  });
};

function generateInquiryNumber(): string {
  return `INQ-${new Date().getFullYear()}-${randomUUID().slice(0, 12).toUpperCase()}`;
}

const createInquirySchema = z.object({
  rfqId: z.string().min(1), supplierIds: z.array(z.string().min(1)).min(1).max(50),
  lineIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  isAOG: z.boolean().optional(), notes: z.string().max(4000).optional(),
}).strict();

const sendInquirySchema = z.object({
  subject: z.string().max(255).trim().min(1).refine(value =>
    !value.includes('\r') && !value.includes('\n') && !value.includes('\u0000'), '主题不能包含换行符').optional(),
  textBody: z.string().max(20_000).trim().min(1).refine(value => !value.includes('\u0000'), '正文包含无效字符').optional(),
  attachmentIds: z.array(z.string().min(1).max(200)).max(10)
    .refine(ids => new Set(ids).size === ids.length, '附件选择不能重复').optional(),
}).strict().default({});

function inquiryDeliveryStatus(inquiryStatus: string, emailStatus?: string) {
  if (emailStatus === 'SENT' || inquiryStatus === 'SENT') return 'smtp_accepted';
  if (emailStatus === 'WITHDRAWN') return 'cancelled';
  if (emailStatus === 'FAILED') return 'failed';
  if (emailStatus === 'PENDING' || inquiryStatus === 'QUEUED') return 'queued';
  return 'draft';
}

type InquiryOutboxEvent = {
  id: string;
  status: string;
  attemptCount: number;
  payload: string;
  workerId?: string | null;
  lockedAt?: Date | null;
};

function outboundEmailIdFromPayload(payload: string) {
  try {
    const parsed = JSON.parse(payload) as { outboundEmailId?: unknown };
    return typeof parsed.outboundEmailId === 'string' ? parsed.outboundEmailId : null;
  } catch {
    return null;
  }
}

function inquiryDeliveryAssessment(emailStatus: string, event?: InquiryOutboxEvent | null) {
  const status = event?.status;
  const attemptCount = event?.attemptCount ?? null;
  const safeToCancel = emailStatus === 'PENDING'
    && status === 'PENDING'
    && attemptCount === 0
    && !event?.workerId
    && !event?.lockedAt;

  if (emailStatus === 'SENT') {
    return { deliveryStatus: 'smtp_accepted', safeToCancel: false, manualVerificationRequired: false, outboxStatus: status ?? null, attemptCount };
  }
  if (emailStatus === 'WITHDRAWN') {
    return { deliveryStatus: 'cancelled', safeToCancel: false, manualVerificationRequired: false, outboxStatus: status ?? null, attemptCount };
  }
  if (emailStatus === 'SENDING') {
    return { deliveryStatus: 'processing', safeToCancel: false, manualVerificationRequired: false, outboxStatus: status ?? null, attemptCount };
  }
  if (emailStatus === 'FAILED') {
    return { deliveryStatus: 'failed', safeToCancel: false, manualVerificationRequired: false, outboxStatus: status ?? null, attemptCount };
  }
  if (emailStatus === 'NEEDS_VERIFICATION' || (status && ['FAILED', 'CANCELLED', 'DELIVERED'].includes(status))) {
    return { deliveryStatus: 'needs_verification', safeToCancel: false, manualVerificationRequired: true, outboxStatus: status ?? null, attemptCount };
  }
  if (status === 'PROCESSING') {
    return { deliveryStatus: 'processing', safeToCancel: false, manualVerificationRequired: false, outboxStatus: status, attemptCount };
  }
  if (status === 'RETRYING') {
    return { deliveryStatus: 'retrying', safeToCancel: false, manualVerificationRequired: false, outboxStatus: status, attemptCount };
  }
  if (safeToCancel) {
    return { deliveryStatus: 'queued', safeToCancel: true, manualVerificationRequired: false, outboxStatus: status, attemptCount };
  }
  return { deliveryStatus: 'needs_verification', safeToCancel: false, manualVerificationRequired: true, outboxStatus: status ?? null, attemptCount };
}

const manualVerificationMessage = '询价邮件投递结果不确定，当前记录无法证明供应商未收到邮件。请核对发件箱或联系供应商后再决定是否重新询价；此状态不支持安全自动重试。';

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
}, outboxEvent?: InquiryOutboxEvent | null) {
  const latestEmail = inquiry.outboundEmails?.[0] ?? null;
  const assessment = latestEmail
    ? inquiryDeliveryAssessment(latestEmail.status, outboxEvent)
    : null;
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
    deliveryStatus: assessment?.deliveryStatus ?? inquiryDeliveryStatus(inquiry.status, latestEmail?.status),
    latestOutboundEmail: latestEmail ? {
      id: latestEmail.id,
      status: latestEmail.status.toLowerCase(),
      // Raw transport errors can contain server or account details. Expose a
      // stable, actionable message while keeping those details in the logs.
      error: latestEmail.errorMessage ? '邮件投递失败，请检查邮箱配置或联系管理员' : null,
      sentAt: latestEmail.sentAt?.toISOString() ?? null,
      outboxStatus: assessment?.outboxStatus?.toLowerCase() ?? null,
      attemptCount: assessment?.attemptCount,
      canCancel: assessment?.safeToCancel ?? false,
      manualVerificationRequired: assessment?.manualVerificationRequired ?? true,
      manualVerificationMessage: assessment?.manualVerificationRequired ? manualVerificationMessage : null,
    } : null,
  };
}

async function loadInquiryOutboxEvents(inquiryIds: string[]) {
  if (inquiryIds.length === 0) return new Map<string, InquiryOutboxEvent>();
  const events = await prisma.outboxEvent.findMany({
    where: {
      channel: 'EMAIL',
      eventType: 'inquiry.email.send',
      aggregateType: 'INQUIRY',
      aggregateId: { in: inquiryIds },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, aggregateId: true, status: true, attemptCount: true, payload: true, workerId: true, lockedAt: true },
  });
  const latestByOutboundEmailId = new Map<string, InquiryOutboxEvent>();
  for (const event of events) {
    const outboundEmailId = outboundEmailIdFromPayload(event.payload);
    if (outboundEmailId && !latestByOutboundEmailId.has(outboundEmailId)) {
      latestByOutboundEmailId.set(outboundEmailId, event);
    }
  }
  return latestByOutboundEmailId;
}

async function findInquiryOutboxEvent(tx: Prisma.TransactionClient, inquiryId: string, outboundEmailId: string) {
  const events = await tx.outboxEvent.findMany({
    where: {
      channel: 'EMAIL',
      eventType: 'inquiry.email.send',
      aggregateType: 'INQUIRY',
      aggregateId: inquiryId,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, attemptCount: true, payload: true, workerId: true, lockedAt: true },
  });
  return events.find(event => outboundEmailIdFromPayload(event.payload) === outboundEmailId) ?? null;
}

function assertInquiryDeliveryAccess(actor: NonNullable<AuthRequest['user']>, inquiry: {
  rfq?: { createdBy: string; creator?: { department?: string | null } | null } | null;
}) {
  assertCapability(actor, 'supplier_quote', 'update');
  assertCapability(actor, 'rfq', 'update', {
    ownerId: inquiry.rfq?.createdBy,
    department: inquiry.rfq?.creator?.department,
  });
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

    const eventsByOutboundEmailId = await loadInquiryOutboxEvents(inquiries.map(inquiry => inquiry.id));
    res.json({
      success: true,
      data: inquiries.map(inquiry => serializeInquiry(
        inquiry,
        inquiry.outboundEmails?.[0] ? eventsByOutboundEmailId.get(inquiry.outboundEmails[0].id) : null,
      )),
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

    const eventsByOutboundEmailId = await loadInquiryOutboxEvents([inquiry.id]);

    res.json({
      success: true,
      data: serializeInquiry(
        inquiry,
        inquiry.outboundEmails?.[0] ? eventsByOutboundEmailId.get(inquiry.outboundEmails[0].id) : null,
      ),
    });
  })
);

router.get(
  '/:id/attachments',
  requireCapability('supplier_quote', 'read'),
  asyncHandler(async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const attachments = await prisma.$transaction((tx) => listInquiryAttachmentSnapshots(tx, actor, req.params.id));
    res.json({ success: true, data: { attachments } });
  }),
);

router.post(
  '/:id/attachments',
  requireCapability('supplier_quote', 'create'),
  receiveInquiryAttachment,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('没有上传文件', 400, 'VALIDATION_ERROR');
    try {
      if (!isUploadSizeAllowed(req.file.size)) {
        throw new AppError('文件大小超出限制', 400, 'VALIDATION_ERROR');
      }
      const baseFilename = req.file.originalname
        .replace(/\\/g, '/')
        .split('/')
        .at(-1)!;
      const filename = Array.from(baseFilename)
        .filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
        .join('').trim();
      const safeFilename = Array.from(filename).slice(0, 255).join('') || 'attachment';
      const content = await fs.promises.readFile(req.file.path);
      if (!isSafeInquiryAttachmentFilename(safeFilename, req.file.mimetype)
        || !verifyFileSignature(req.file.path, req.file.mimetype)
        || hasUnsafeInquiryAttachmentContent(safeFilename, req.file.mimetype, content)) {
        throw new AppError('文件内容与声明的类型不匹配', 400, 'VALIDATION_ERROR');
      }
      const attachment = await persistInquiryAttachment({
        sourcePath: req.file.path,
        inquiryId: req.params.id,
        actor: (req as AuthRequest).user!,
        filename: safeFilename,
        contentType: req.file.mimetype,
      });
      res.status(201).json({ success: true, data: { attachment } });
    } finally {
      await fs.promises.unlink(req.file.path).catch(() => undefined);
    }
  }),
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
      return { payload: inquiries.map(inquiry => serializeInquiry(inquiry)), statusCode: 201, resourceType: 'RFQ', resourceId: rfqId };
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
    const { subject, textBody, attachmentIds } = req.body as z.infer<typeof sendInquirySchema>;
    const execution = await runIdempotentOperation(
      buildIdempotencyContext(req, actor.id, `POST:/inquiries/${inquiryId}/send`),
      async tx => {
        const { inquiry, queuedInquiry, outboundEmail, outboxEvent } = await sendInquiryCommand(
          tx,
          actor,
          inquiryId,
          { subject, textBody, attachmentIds },
        );

        return {
          payload: serializeInquiry({
            ...inquiry,
            ...queuedInquiry,
            status: 'QUEUED',
            outboundEmails: [outboundEmail],
          }, outboxEvent as InquiryOutboxEvent),
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

router.post(
  '/:id/cancel-send',
  requireCapability('supplier_quote', 'update'),
  asyncHandler(async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const result = await prisma.$transaction(async (tx) => {
      const inquiry = await tx.inquiry.findFirst({
        where: { id: req.params.id, ...inquiryReadScope(actor) },
        include: {
          supplier: { select: { name: true } },
          items: { orderBy: { lineNo: 'asc' } },
          rfq: { include: { creator: { select: { department: true } } } },
          outboundEmails: {
            where: { purpose: 'INQUIRY_SEND' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, status: true, errorMessage: true, sentAt: true },
          },
        },
      });
      if (!inquiry) throw new AppError('询价单不存在或当前无权访问', 404, 'RESOURCE_NOT_FOUND');
      assertInquiryDeliveryAccess(actor, inquiry);

      const email = inquiry.outboundEmails[0];
      if (inquiry.status !== 'QUEUED' || !email || email.status !== 'PENDING') {
        throw new AppError('只有尚未投递的排队询价可以取消；失败或结果不确定时请先核实供应商是否收到邮件', 409, 'STATE_CONFLICT');
      }
      const event = await findInquiryOutboxEvent(tx, inquiry.id, email.id);
      if (!event || event.status !== 'PENDING' || event.attemptCount !== 0 || event.workerId || event.lockedAt) {
        throw new AppError('Worker 可能已领取或尝试投递该邮件，无法安全取消；请核实供应商是否收到邮件', 409, 'STATE_CONFLICT');
      }

      const now = new Date();
      const cancelled = await tx.outboxEvent.updateMany({
        where: {
          id: event.id,
          channel: 'EMAIL',
          status: 'PENDING',
          attemptCount: 0,
          workerId: null,
          lockedAt: null,
        },
        data: {
          status: 'CANCELLED',
          nextRetryAt: null,
          lastError: 'Inquiry email cancelled before worker claim',
        },
      });
      if (cancelled.count !== 1) {
        throw new AppError('Worker 已领取该邮件，无法安全取消；请核实供应商是否收到邮件', 409, 'STATE_CONFLICT');
      }

      const withdrawn = await tx.outboundEmail.updateMany({
        where: { id: email.id, inquiryId: inquiry.id, purpose: 'INQUIRY_SEND', status: 'PENDING' },
        data: {
          status: 'WITHDRAWN',
          withdrawnAt: now,
          withdrawalReason: 'Cancelled before worker claim',
        },
      });
      if (withdrawn.count !== 1) {
        throw new AppError('邮件状态已变化，无法安全取消；请刷新并核实投递结果', 409, 'STATE_CONFLICT');
      }

      const resetInquiry = await tx.inquiry.updateMany({
        where: { id: inquiry.id, status: 'QUEUED' },
        data: { status: 'DRAFT' },
      });
      if (resetInquiry.count !== 1) {
        throw new AppError('询价状态已变化，无法安全取消；请刷新并核实投递结果', 409, 'STATE_CONFLICT');
      }

      return serializeInquiry({
        ...inquiry,
        status: 'DRAFT',
        sentAt: null,
        outboundEmails: [{ ...email, status: 'WITHDRAWN', sentAt: null, errorMessage: null }],
      }, { ...event, status: 'CANCELLED' });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    res.json({ success: true, data: result });
  }),
);

export default router;
