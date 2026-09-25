import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { emailClassifySchema, emailInquiryLinkSchema } from '../lib/validation.js';
import { requireCapability } from '../middleware/capability.js';
import type { AuthRequest } from '../middleware/auth.js';
import { normalizeEmailAddress } from '../lib/emailAddress.js';
import prisma from '../lib/prisma.js';

const router = Router();
const EMAIL_TYPES = new Set(['aog', 'standard', 'inquiry', 'spam']);

export function normalizeEmailType(value: string) {
  const normalized = value.toLowerCase();
  return EMAIL_TYPES.has(normalized) ? normalized : 'standard';
}

function serializeEmail(email: {
  id: string;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  receivedAt: Date;
  type: string;
  isRead: boolean;
  attachments: string | null;
  processingStatus: string;
  processedAt: Date | null;
  discardedAt: Date | null;
  rfq?: { id: string } | null;
  threadMatchStatus?: string;
  threadMatchReason?: string | null;
  attachmentStatus?: string;
  attachmentError?: string | null;
  inquiryLinks?: Array<{
    id: string;
    emailId: string;
    inquiryId: string;
    method: string;
    confirmationStatus: string;
    confirmedAt: Date | null;
    confirmedById: string | null;
    manualReason: string | null;
    createdAt: Date;
    inquiry?: { id: string; inquiryNumber: string; supplierId: string } | null;
  }>;
  attachmentRecords?: Array<{
    id: string;
    storedObjectId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    contentId: string | null;
    createdAt: Date;
    storedObject?: { id: string; status: string } | null;
  }>;
}) {
  return {
    id: email.id,
    from: email.from,
    fromName: email.fromName,
    subject: email.subject,
    body: email.body,
    receivedAt: email.receivedAt.toISOString(),
    type: normalizeEmailType(email.type),
    isRead: email.isRead,
    attachments: email.attachments?.split(',').filter(Boolean) || [],
    processingStatus: email.rfq ? 'processed' : email.processingStatus.toLowerCase(),
    processedAt: email.processedAt?.toISOString() || null,
    discardedAt: email.discardedAt?.toISOString() || null,
    rfqId: email.rfq?.id || null,
    threadMatchStatus: email.threadMatchStatus || null,
    threadMatchReason: email.threadMatchReason || null,
    attachmentStatus: email.attachmentStatus || null,
    attachmentError: email.attachmentError || null,
    inquiryLinks: email.inquiryLinks?.map((link) => ({
      id: link.id,
      emailId: link.emailId,
      inquiryId: link.inquiryId,
      method: link.method,
      confirmationStatus: link.confirmationStatus,
      confirmedAt: link.confirmedAt?.toISOString() || null,
      confirmedById: link.confirmedById,
      manualReason: link.manualReason,
      createdAt: link.createdAt.toISOString(),
      inquiry: link.inquiry || null,
    })),
    attachmentRecords: email.attachmentRecords?.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      contentId: attachment.contentId,
      createdAt: attachment.createdAt.toISOString(),
      storedObjectId: attachment.storedObjectId,
      downloadUrl: attachment.storedObject?.status === 'AVAILABLE'
        ? '/api/files/' + encodeURIComponent(attachment.storedObjectId)
        : null,
    })),
  };
}

router.get(
  '/',
  requireCapability('email', 'read'),
  asyncHandler(async (req, res) => {
    const { type, isRead, processingStatus, excludeSpam, page, limit, inquiryId, needsInquiryMatch } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    if (needsInquiryMatch !== undefined
      && (typeof needsInquiryMatch !== 'string' || !['true', 'false'].includes(needsInquiryMatch))) {
      throw new AppError('needsInquiryMatch 必须是 true 或 false', 400, 'BAD_REQUEST');
    }
    if (needsInquiryMatch === 'true' && inquiryId !== undefined) {
      throw new AppError('inquiryId 不能与 needsInquiryMatch=true 同时使用', 400, 'BAD_REQUEST');
    }

    const where: Prisma.EmailWhereInput = {};
    if (type) where.type = type.toString().toUpperCase();
    if (!type && excludeSpam === 'true') where.type = { not: 'SPAM' };
    if (isRead !== undefined) where.isRead = isRead === 'true';
    if (processingStatus) where.processingStatus = processingStatus.toString().toUpperCase();
    if (inquiryId !== undefined) {
      if (typeof inquiryId !== 'string' || !inquiryId.trim()) {
        throw new AppError('inquiryId 必须是非空字符串', 400, 'BAD_REQUEST');
      }
      where.inquiryLinks = { some: { inquiryId: inquiryId.trim() } };
    }
    if (needsInquiryMatch === 'true') {
      where.threadMatchStatus = { in: ['UNMATCHED', 'NEEDS_REVIEW'] };
      where.inquiryLinks = { none: { confirmationStatus: 'CONFIRMED' } };
    }

    const [emails, total, totalNonSpam, aog, standard, inquiry, unread, spam] = await Promise.all([
      prisma.email.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          rfq: { select: { id: true } },
          inquiryLinks: {
            include: { inquiry: { select: { id: true, inquiryNumber: true, supplierId: true } } },
            orderBy: { createdAt: 'asc' },
          },
          attachmentRecords: {
            include: { storedObject: { select: { id: true, status: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
      prisma.email.count({ where }),
      prisma.email.count({ where: { type: { not: 'SPAM' } } }),
      prisma.email.count({ where: { type: 'AOG' } }),
      prisma.email.count({ where: { type: 'STANDARD' } }),
      prisma.email.count({ where: { type: 'INQUIRY' } }),
      prisma.email.count({ where: { isRead: false, type: { not: 'SPAM' } } }),
      prisma.email.count({ where: { type: 'SPAM' } }),
    ]);

    res.json({
      success: true,
      data: emails.map(serializeEmail),
      pagination: {
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
      summary: { total: totalNonSpam, aog, standard, inquiry, unread, spam },
    });
  })
);

router.get(
  '/:id',
  requireCapability('email', 'read'),
  asyncHandler(async (req, res) => {
    const email = await prisma.email.findUnique({
      where: { id: req.params.id },
      include: {
        rfq: { select: { id: true } },
        inquiryLinks: {
          include: { inquiry: { select: { id: true, inquiryNumber: true, supplierId: true } } },
          orderBy: { createdAt: 'asc' },
        },
        attachmentRecords: {
          include: { storedObject: { select: { id: true, status: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!email) {
      throw new AppError('邮件不存在', 404);
    }

    res.json({
      success: true,
      data: serializeEmail(email),
    });
  })
);

router.patch(
  '/:id/read',
  requireCapability('email', 'update'),
  asyncHandler(async (req, res) => {
    const email = await prisma.email.update({
      where: { id: req.params.id },
      data: { isRead: true },
    });

    res.json({
      success: true,
      data: serializeEmail(email),
    });
  })
);

router.patch(
  '/:id/classify',
  requireCapability('email', 'update'),
  validateBody(emailClassifySchema),
  asyncHandler(async (req, res) => {
    const { type } = req.body;

    const email = await prisma.email.update({
      where: { id: req.params.id },
      data: { type: type.toUpperCase() },
    });

    res.json({
      success: true,
      data: serializeEmail(email),
    });
  })
);

router.post(
  '/:id/inquiry-links',
  requireCapability('email', 'update'),
  validateBody(emailInquiryLinkSchema),
  asyncHandler(async (req, res) => {
    const email = await prisma.email.findUnique({
      where: { id: req.params.id },
      select: { id: true, from: true },
    });
    if (!email) throw new AppError('邮件不存在', 404, 'RESOURCE_NOT_FOUND');

    const inquiry = await prisma.inquiry.findUnique({
      where: { id: req.body.inquiryId },
      select: { id: true, supplierId: true, supplier: { select: { email: true } } },
    });
    if (!inquiry) throw new AppError('询价单不存在', 404, 'RESOURCE_NOT_FOUND');

    const senderAddress = normalizeEmailAddress(email.from);
    const supplierAddress = normalizeEmailAddress(inquiry.supplier.email);
    const manualReason = req.body.manualReason || null;
    if ((!senderAddress || !supplierAddress || senderAddress !== supplierAddress) && !manualReason) {
      throw new AppError('邮件发件人地址与询价供应商邮箱不一致，不能关联', 409, 'RESOURCE_CONFLICT');
    }

    const userId = (req as AuthRequest).user!.id;
    const confirmedAt = new Date();
    const link = await prisma.inquiryEmailLink.upsert({
      where: {
        emailId_inquiryId: { emailId: email.id, inquiryId: inquiry.id },
      },
      create: {
        emailId: email.id,
        inquiryId: inquiry.id,
        method: 'MANUAL',
        confirmationStatus: 'CONFIRMED',
        confirmedAt,
        confirmedById: userId,
        manualReason,
      },
      update: {
        method: 'MANUAL',
        confirmationStatus: 'CONFIRMED',
        confirmedAt,
        confirmedById: userId,
        manualReason,
      },
      include: { inquiry: { select: { id: true, inquiryNumber: true, supplierId: true } } },
    });

    res.json({
      success: true,
      data: {
        id: link.id,
        emailId: link.emailId,
        inquiryId: link.inquiryId,
        method: link.method,
        confirmationStatus: link.confirmationStatus,
        confirmedAt: link.confirmedAt?.toISOString() || null,
        confirmedById: link.confirmedById,
        manualReason: link.manualReason,
        createdAt: link.createdAt.toISOString(),
        inquiry: link.inquiry,
      },
    });
  }),
);

router.patch(
  '/:id/discard',
  requireCapability('email', 'update'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.email.findUnique({
      where: { id: req.params.id },
      include: { rfq: { select: { id: true } } },
    });

    if (!existing) throw new AppError('邮件不存在', 404, 'RESOURCE_NOT_FOUND');
    if (existing.rfq) throw new AppError('已生成需求单的邮件不能丢弃', 409, 'STATE_CONFLICT');

    const discardedAt = new Date();
    const email = await prisma.email.update({
      where: { id: existing.id },
      data: {
        processingStatus: 'DISCARDED',
        discardedAt,
        processedAt: discardedAt,
        isRead: true,
      },
    });

    res.json({ success: true, data: serializeEmail(email) });
  }),
);

export default router;
