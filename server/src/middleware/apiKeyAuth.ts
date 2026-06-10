import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler.js';
import prisma from '../lib/prisma.js';
import crypto from 'crypto';

// 简单的内存限流存储（生产环境应使用 Redis）
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function getRateLimitKey(keyHash: string): string {
  return `ratelimit:${keyHash}:${Math.floor(Date.now() / 3600000)}`; // 每小时
}

export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
      throw new AppError('缺少 API Key，请在请求头中提供 X-API-Key', 401, 'AUTH_UNAUTHORIZED');
    }

    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const key = await prisma.apiKey.findUnique({
      where: { keyHash: hash },
    });

    if (!key || !key.isActive) {
      throw new AppError('API Key 无效或已撤销', 401, 'AUTH_UNAUTHORIZED');
    }

    if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
      throw new AppError('API Key 已过期', 401, 'AUTH_UNAUTHORIZED');
    }

    // 限流检查
    const rateKey = getRateLimitKey(key.keyHash);
    const now = Date.now();
    const limitEntry = rateLimitStore.get(rateKey);

    if (!limitEntry || limitEntry.resetAt < now) {
      rateLimitStore.set(rateKey, { count: 1, resetAt: now + 3600000 });
    } else {
      limitEntry.count += 1;
      if (limitEntry.count > key.rateLimit) {
        throw new AppError('请求频率超限，请稍后再试', 429, 'RATE_LIMIT');
      }
    }

    // 更新最后使用时间
    await prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    });

    // 将 API Key 信息附加到请求
    (req as any).apiKey = {
      id: key.id,
      name: key.name,
      scopes: JSON.parse(key.scopes || '[]'),
      rateLimit: key.rateLimit,
    };

    next();
  } catch (err) {
    next(err);
  }
}

export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const apiKey = (req as any).apiKey;
    if (!apiKey) {
      return next(new AppError('未认证', 401, 'AUTH_UNAUTHORIZED'));
    }

    const scopes: string[] = apiKey.scopes || [];
    if (!scopes.includes(scope) && !scopes.includes('admin')) {
      return next(new AppError(`缺少权限: ${scope}`, 403, 'AUTH_FORBIDDEN'));
    }

    next();
  };
}
