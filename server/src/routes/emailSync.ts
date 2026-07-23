import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { authenticate } from '../middleware/auth.js';
import { autoClassifyEmail } from '../lib/emailService.js';
import { syncEmailAccount } from '../lib/inboundEmailSyncService.js';
import { logger } from '../lib/logger.js';
import prisma from '../lib/prisma.js';

const router = Router();

// 所有端点都需要认证
router.use(authenticate);

router.post(
  '/sync/:accountId',
  requireCapability('email_account', 'manage'),
  asyncHandler(async (req, res) => {
    const { accountId } = req.params;

    const account = await prisma.emailAccount.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      throw new AppError('邮箱账户不存在', 404);
    }

    try {
      const result = await syncEmailAccount(account.id, { force: true, batchSize: 50 });
      if (!result.claimed) {
        throw new AppError('该邮箱正在同步，请稍后重试', 409, 'STATE_CONFLICT');
      }

      logger.info({ accountId, syncedCount: result.savedCount }, 'Email sync completed via email-sync route');

      res.json({
        success: true,
        message: `同步完成，新增 ${result.savedCount} 封邮件`,
        data: {
          syncedCount: result.savedCount,
          fetchedCount: result.fetchedCount,
          lastSyncAt: result.lastSyncAt?.toISOString() || null,
          lastUid: result.lastUid,
          cursorReset: result.cursorReset,
        },
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error({ error, accountId }, 'Email sync failed via email-sync route');

      res.status(500).json({
        success: false,
        message: '邮件同步失败: ' + (error instanceof Error ? error.message : '未知错误'),
        code: 'SYNC_FAILED',
      });
    }
  })
);

router.get(
  '/list/:accountId',
  requireCapability('email_account', 'manage'),
  asyncHandler(async (req, res) => {
    const { accountId } = req.params;
    const { type, isRead } = req.query;

    const where: Prisma.EmailWhereInput = { accountId: accountId };
    if (type) where.type = type.toString().toUpperCase();
    if (isRead !== undefined) where.isRead = isRead === 'true';

    const emails = await prisma.email.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
    });

    res.json({
      success: true,
      data: emails.map((e) => ({
        id: e.id,
        from: e.from,
        fromName: e.fromName,
        subject: e.subject,
        body: e.body,
        receivedAt: e.receivedAt.toISOString(),
        type: e.type.toLowerCase(),
        isRead: e.isRead,
        attachments: e.attachments?.split(',').filter(Boolean) || [],
      })),
    });
  })
);

router.post(
  '/classify/:emailId',
  requireCapability('email_account', 'manage'),
  asyncHandler(async (req, res) => {
    const { emailId } = req.params;

    const email = await prisma.email.findUnique({
      where: { id: emailId },
    });

    if (!email) {
      throw new AppError('邮件不存在', 404);
    }

    const classifiedType = await autoClassifyEmail(email.subject, email.body);

    const updated = await prisma.email.update({
      where: { id: emailId },
      data: { type: classifiedType },
    });

    res.json({
      success: true,
      data: {
        ...updated,
        type: updated.type.toLowerCase(),
      },
    });
  })
);

export default router;
