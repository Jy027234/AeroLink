import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { emailClassifySchema } from '../lib/validation.js';
import { requireCapability } from '../middleware/capability.js';
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
  };
}

router.get(
  '/',
  requireCapability('email', 'read'),
  asyncHandler(async (req, res) => {
    const { type, isRead, processingStatus, excludeSpam, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.EmailWhereInput = {};
    if (type) where.type = type.toString().toUpperCase();
    if (!type && excludeSpam === 'true') where.type = { not: 'SPAM' };
    if (isRead !== undefined) where.isRead = isRead === 'true';
    if (processingStatus) where.processingStatus = processingStatus.toString().toUpperCase();

    const [emails, total, totalNonSpam, aog, standard, inquiry, unread, spam] = await Promise.all([
      prisma.email.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip,
        take: pageSize,
        include: { rfq: { select: { id: true } } },
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
      include: { rfq: { select: { id: true } } },
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
