import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { requirePrivilegedRole } from '../lib/accessControl.js';
import prisma from '../lib/prisma.js';
import crypto from 'crypto';

const router = Router();

router.use((req, _res, next) => {
  requirePrivilegedRole(req as AuthRequest, '无权操作，仅管理员或总经理可管理 API Key');
  next();
});

function generateApiKey(): { fullKey: string; prefix: string; hash: string } {
  const prefix = 'ak_live_';
  const randomPart = crypto.randomBytes(32).toString('hex');
  const fullKey = prefix + randomPart;
  const hash = crypto.createHash('sha256').update(fullKey).digest('hex');
  return { fullKey, prefix: fullKey.slice(0, 16) + '...', hash };
}

/**
 * GET /api/api-keys - list API keys
 */
router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res) => {
    const keys = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        rateLimit: true,
        isActive: true,
        lastUsedAt: true,
        expiresAt: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({
      success: true,
      data: keys.map((k) => ({
        ...k,
        scopes: JSON.parse(k.scopes || '[]'),
      })),
    });
  })
);

/**
 * POST /api/api-keys - create API key
 */
router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res) => {
    const { name, scopes, rateLimit, expiresAt } = req.body;

    if (!name) {
      throw new AppError('名称不能为空', 400, 'BAD_REQUEST');
    }

    const { fullKey, prefix, hash } = generateApiKey();

    const key = await prisma.apiKey.create({
      data: {
        name,
        keyHash: hash,
        keyPrefix: prefix,
        scopes: JSON.stringify(scopes || ['read']),
        rateLimit: rateLimit || 1000,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        createdBy: req.user!.id,
      },
    });

    res.json({
      success: true,
      data: {
        id: key.id,
        name: key.name,
        key: fullKey, // 仅创建时返回一次
        keyPrefix: key.keyPrefix,
        scopes: scopes || ['read'],
        rateLimit: key.rateLimit,
        isActive: key.isActive,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
      },
    });
  })
);

/**
 * DELETE /api/api-keys/:id - revoke API key
 */
router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;

    const key = await prisma.apiKey.findUnique({ where: { id } });
    if (!key) throw new AppError('API Key 不存在', 404, 'RESOURCE_NOT_FOUND');

    await prisma.apiKey.update({
      where: { id },
      data: { isActive: false },
    });

    res.json({ success: true, message: 'API Key 已撤销' });
  })
);

/**
 * PUT /api/api-keys/:id - update API key
 */
router.put(
  '/:id',
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { name, scopes, rateLimit, isActive, expiresAt } = req.body;

    const key = await prisma.apiKey.findUnique({ where: { id } });
    if (!key) throw new AppError('API Key 不存在', 404, 'RESOURCE_NOT_FOUND');

    const updated = await prisma.apiKey.update({
      where: { id },
      data: {
        name: name || key.name,
        scopes: scopes ? JSON.stringify(scopes) : key.scopes,
        rateLimit: rateLimit || key.rateLimit,
        isActive: isActive !== undefined ? isActive : key.isActive,
        expiresAt: expiresAt ? new Date(expiresAt) : key.expiresAt,
        updatedAt: new Date(),
      },
    });

    res.json({
      success: true,
      data: {
        ...updated,
        scopes: JSON.parse(updated.scopes || '[]'),
      },
    });
  })
);

export default router;
