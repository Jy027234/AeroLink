import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import prisma from '../lib/prisma.js';
import crypto from 'crypto';
import { buildJsonArrayShadow, preferredJsonArray } from '../lib/jsonConfigurationShadows.js';

const router = Router();

router.use(requireCapability('api_key', 'manage'));

function generateApiKey(): { fullKey: string; prefix: string; hash: string } {
  const prefix = 'ak_live_';
  const randomPart = crypto.randomBytes(32).toString('hex');
  const fullKey = prefix + randomPart;
  const hash = crypto.createHash('sha256').update(fullKey).digest('hex');
  return { fullKey, prefix: fullKey.slice(0, 16) + '...', hash };
}

function normalizeScopes(value: unknown): string[] {
  const scopes = value === undefined ? ['read'] : value;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string' && scope.trim())) {
    throw new AppError('scopes 必须是仅含非空字符串的数组', 400, 'BAD_REQUEST');
  }
  return Array.from(new Set(scopes.map((scope) => scope.trim())));
}

function projectScopes(scopesJson: Parameters<typeof preferredJsonArray>[0], scopes: string): string[] {
  return preferredJsonArray(scopesJson, scopes).filter((scope): scope is string => typeof scope === 'string');
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
        scopesJson: true,
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
      data: keys.map(({ scopesJson, ...key }) => ({
        ...key,
        scopes: projectScopes(scopesJson, key.scopes),
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
    const normalizedScopes = normalizeScopes(scopes);
    const scopesShadow = buildJsonArrayShadow(normalizedScopes);

    const key = await prisma.apiKey.create({
      data: {
        name,
        keyHash: hash,
        keyPrefix: prefix,
        scopes: scopesShadow.legacy,
        scopesJson: scopesShadow.shadow,
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
        scopes: normalizedScopes,
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

    const normalizedScopes = scopes === undefined ? undefined : normalizeScopes(scopes);
    const scopesShadow = normalizedScopes === undefined ? undefined : buildJsonArrayShadow(normalizedScopes);
    const updated = await prisma.apiKey.update({
      where: { id },
      data: {
        name: name || key.name,
        ...(scopesShadow && {
          scopes: scopesShadow.legacy,
          scopesJson: scopesShadow.shadow,
        }),
        rateLimit: rateLimit || key.rateLimit,
        isActive: isActive !== undefined ? isActive : key.isActive,
        expiresAt: expiresAt ? new Date(expiresAt) : key.expiresAt,
        updatedAt: new Date(),
      },
    });

    res.json({
      success: true,
      data: (() => {
        const { scopesJson, ...legacyKey } = updated;
        return {
          ...legacyKey,
          scopes: projectScopes(scopesJson, legacyKey.scopes),
        };
      })(),
    });
  })
);

export default router;
