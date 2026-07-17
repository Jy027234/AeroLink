import { Router } from 'express';
import type { EmailAccount } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { emailAccountCreateSchema, emailAccountUpdateSchema } from '../lib/validation.js';
import { testImapConnection, testSmtpConnection, syncEmails, saveSyncedEmails } from '../lib/emailService.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { MISSING_OUTBOUND_ACCOUNT_MESSAGE } from '../lib/authEmailService.js';
import { requireCapability } from '../middleware/capability.js';
import prisma from '../lib/prisma.js';

const router = Router();
router.use(requireCapability('email_account', 'manage'));
const AUTH_EMAIL_PURPOSES = ['USER_ACTIVATION', 'PASSWORD_RESET'] as const;

// 辅助函数：序列化账户响应（排除 authCode）
function serializeAccount(a: EmailAccount) {
  return {
    id: a.id,
    email: a.email,
    displayName: a.displayName,
    imapServer: a.imapServer,
    imapPort: a.imapPort,
    smtpServer: a.smtpServer,
    smtpPort: a.smtpPort,
    isActive: a.isActive,
    isDefault: a.isDefault,
    accountType: a.accountType,
    lastSyncAt: a.lastSyncAt?.toISOString?.() || a.lastSyncAt || null,
    syncInterval: a.syncInterval,
  };
}

// 辅助函数：构建 EmailAccountConfig（解密 authCode 用于连接）
function buildAccountConfig(a: EmailAccount) {
  return {
    id: a.id,
    email: a.email,
    displayName: a.displayName,
    imapServer: a.imapServer,
    imapPort: a.imapPort,
    smtpServer: a.smtpServer,
    smtpPort: a.smtpPort,
    authCode: decrypt(a.authCode),
    accountType: a.accountType,
  };
}

function resolveAuthDeliveryStatus(email: { status: string; errorMessage?: string | null }) {
  if (email.status === 'SENT') {
    return 'sent' as const;
  }

  if (email.status === 'PENDING') {
    return 'pending' as const;
  }

  if (email.status === 'SKIPPED' || email.errorMessage === MISSING_OUTBOUND_ACCOUNT_MESSAGE) {
    return 'skipped' as const;
  }

  return 'failed' as const;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const skip = (page - 1) * limit;

    const [accounts, total] = await Promise.all([
      prisma.emailAccount.findMany({
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.emailAccount.count(),
    ]);

    res.json({
      success: true,
      data: accounts.map(serializeAccount),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

router.get(
  '/auth-deliveries',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 10, 1), 50);

    const deliveries = await prisma.outboundEmail.findMany({
      where: {
        purpose: {
          in: [...AUTH_EMAIL_PURPOSES],
        },
      },
      include: {
        account: {
          select: {
            email: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });

    const items = deliveries.map((email) => ({
      id: email.id,
      purpose: email.purpose,
      deliveryStatus: resolveAuthDeliveryStatus(email),
      toEmail: email.toEmail,
      subject: email.subject,
      accountEmail: email.account?.email || null,
      errorMessage: email.errorMessage,
      createdAt: email.createdAt.toISOString(),
      sentAt: email.sentAt?.toISOString() || null,
    }));

    const summary = items.reduce(
      (acc, item) => {
        acc.total += 1;
        acc[item.deliveryStatus] += 1;
        return acc;
      },
      {
        total: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        pending: 0,
      }
    );

    res.json({
      success: true,
      data: {
        items,
        summary,
      },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const account = await prisma.emailAccount.findUnique({
      where: { id: req.params.id },
    });

    if (!account) {
      throw new AppError('邮箱账户不存在', 404);
    }

    res.json({
      success: true,
      data: serializeAccount(account),
    });
  })
);

router.post(
  '/',
  validateBody(emailAccountCreateSchema),
  asyncHandler(async (req, res) => {
    const { email, displayName, imapServer, imapPort, smtpServer, smtpPort, authCode, accountType, isDefault, syncInterval } = req.body;

    // 检查邮箱是否已存在
    const existing = await prisma.emailAccount.findUnique({ where: { email } });
    if (existing) {
      throw new AppError('该邮箱地址已存在', 409);
    }

    if (isDefault) {
      await prisma.emailAccount.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }

    const account = await prisma.emailAccount.create({
      data: {
        email,
        displayName: displayName || email.split('@')[0],
        imapServer,
        imapPort: imapPort || '993',
        smtpServer,
        smtpPort: smtpPort || '465',
        authCode: encrypt(authCode),
        accountType: accountType || '163',
        isDefault: isDefault || false,
        syncInterval: syncInterval ?? 5,
      },
    });

    res.status(201).json({
      success: true,
      data: serializeAccount(account),
    });
  })
);

router.put(
  '/:id',
  validateBody(emailAccountUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.emailAccount.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('邮箱账户不存在', 404);
    }

    const { email, displayName, imapServer, imapPort, smtpServer, smtpPort, authCode, accountType, isActive, isDefault, syncInterval } = req.body;

    // 检查邮箱唯一性
    if (email && email !== existing.email) {
      const duplicate = await prisma.emailAccount.findUnique({ where: { email } });
      if (duplicate) {
        throw new AppError('该邮箱地址已被其他账户使用', 409);
      }
    }

    if (isDefault && !existing.isDefault) {
      await prisma.emailAccount.updateMany({
        where: { isDefault: true, id: { not: req.params.id } },
        data: { isDefault: false },
      });
    }

    const account = await prisma.emailAccount.update({
      where: { id: req.params.id },
      data: {
        email: email ?? existing.email,
        displayName: displayName !== undefined ? displayName : existing.displayName,
        imapServer: imapServer ?? existing.imapServer,
        imapPort: imapPort ?? existing.imapPort,
        smtpServer: smtpServer ?? existing.smtpServer,
        smtpPort: smtpPort ?? existing.smtpPort,
        authCode: authCode ? encrypt(authCode) : existing.authCode,
        accountType: accountType ?? existing.accountType,
        isActive: isActive !== undefined ? isActive : existing.isActive,
        isDefault: isDefault !== undefined ? isDefault : existing.isDefault,
        syncInterval: syncInterval !== undefined ? syncInterval : existing.syncInterval,
      },
    });

    res.json({
      success: true,
      data: serializeAccount(account),
    });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const account = await prisma.emailAccount.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { emails: true } } },
    });

    if (!account) {
      throw new AppError('邮箱账户不存在', 404);
    }

    // 检查是否为默认账户
    if (account.isDefault) {
      throw new AppError('默认邮箱账户不能删除，请先设置其他账户为默认', 400);
    }

    // 删除前告知关联的邮件数量
    const emailCount = account._count?.emails ?? 0;

    await prisma.emailAccount.delete({
      where: { id: req.params.id },
    });

    res.json({
      success: true,
      message: emailCount > 0
        ? `邮箱账户已删除，${emailCount} 封关联邮件的账户归属已清除`
        : '邮箱账户已删除',
    });
  })
);

router.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const account = await prisma.emailAccount.findUnique({
      where: { id: req.params.id },
    });

    if (!account) {
      throw new AppError('邮箱账户不存在', 404);
    }

    if (!account.isActive) {
      throw new AppError('账户已停用', 400);
    }

    const config = buildAccountConfig(account);

    const [imapOk, smtpOk] = await Promise.all([
      testImapConnection(config),
      testSmtpConnection(config),
    ]);

    if (!imapOk && !smtpOk) {
      throw new AppError('IMAP和SMTP连接均失败，请检查配置', 400);
    }

    if (!imapOk || !smtpOk) {
      logger.warn({ accountId: account.id, imap: imapOk, smtp: smtpOk }, 'Partial connection test failure');
    }

    res.json({
      success: true,
      message: `连接测试完成。IMAP: ${imapOk ? '成功' : '失败'}, SMTP: ${smtpOk ? '成功' : '失败'}`,
      data: { imap: imapOk, smtp: smtpOk },
    });
  })
);

router.post(
  '/:id/sync',
  asyncHandler(async (req, res) => {
    const account = await prisma.emailAccount.findUnique({
      where: { id: req.params.id },
    });

    if (!account) {
      throw new AppError('邮箱账户不存在', 404);
    }

    if (!account.isActive) {
      throw new AppError('账户已停用', 400);
    }

    const config = buildAccountConfig(account);

    try {
      const emails = await syncEmails(config, 50);
      const savedCount = await saveSyncedEmails(account.id, emails);

      await prisma.emailAccount.update({
        where: { id: req.params.id },
        data: { lastSyncAt: new Date() },
      });

      logger.info({ accountId: account.id, syncedCount: savedCount }, 'Email sync completed');

      res.json({
        success: true,
        message: `邮件同步完成，新增 ${savedCount} 封邮件`,
        data: {
          syncedCount: savedCount,
          fetchedCount: emails.length,
          lastSyncAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error({ error, accountId: account.id }, 'Email sync failed');
      throw new AppError('邮件同步失败: ' + (error instanceof Error ? error.message : '未知错误'), 500);
    }
  })
);

export default router;
