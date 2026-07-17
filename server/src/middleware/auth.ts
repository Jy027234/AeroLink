import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';
import { AppError } from './errorHandler.js';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error('FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be set in environment');
}

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    name: string;
    role: string;
    department?: string | null;
    avatar?: string | null;
  };
  sessionId?: string;
}

export interface VerifiedTokenPayload {
  id: string;
  role?: string;
  ver?: number;
  sid?: string;
  jti?: string;
}

export const generateTokens = (user: {
  id: string;
  email: string;
  name: string;
  role: string;
  department?: string | null;
  avatar?: string | null;
  tokenVersion?: number;
  sessionId?: string;
  refreshTokenId?: string;
}) => {
  const tokenVersion = user.tokenVersion ?? 0;
  const accessToken = jwt.sign(
    { id: user.id, role: user.role, ver: tokenVersion, sid: user.sessionId },
    JWT_SECRET,
    { expiresIn: '15m' },
  );
  const refreshToken = jwt.sign(
    { id: user.id, ver: tokenVersion, sid: user.sessionId, jti: user.refreshTokenId },
    JWT_REFRESH_SECRET,
    { expiresIn: '7d' },
  );

  return { accessToken, refreshToken };
};

function assertTokenClaims(decoded: object): asserts decoded is VerifiedTokenPayload {
  if (!('id' in decoded) || typeof decoded.id !== 'string') {
    throw new AppError('无效的令牌格式', 401);
  }
  if ('ver' in decoded && decoded.ver !== undefined && typeof decoded.ver !== 'number') {
    throw new AppError('无效的令牌版本', 401, 'AUTH_TOKEN_INVALID');
  }
  if ('sid' in decoded && decoded.sid !== undefined && typeof decoded.sid !== 'string') {
    throw new AppError('无效的会话标识', 401, 'AUTH_TOKEN_INVALID');
  }
  if ('jti' in decoded && decoded.jti !== undefined && typeof decoded.jti !== 'string') {
    throw new AppError('无效的刷新令牌标识', 401, 'AUTH_TOKEN_INVALID');
  }
}

export const verifyAccessToken = (token: string): VerifiedTokenPayload => {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (typeof decoded !== 'object' || !decoded) {
    throw new AppError('无效的令牌格式', 401);
  }
  assertTokenClaims(decoded);
  return decoded;
};

export const verifyRefreshToken = (token: string): VerifiedTokenPayload => {
  const decoded = jwt.verify(token, JWT_REFRESH_SECRET);
  if (typeof decoded !== 'object' || !decoded) {
    throw new AppError('无效的刷新令牌格式', 401);
  }
  assertTokenClaims(decoded);
  return decoded;
};

export function isTokenVersionValid(tokenVersion: unknown, currentVersion: number): boolean {
  return tokenVersion === undefined || (typeof tokenVersion === 'number' && tokenVersion === currentVersion);
}

async function isSessionActive(sessionId: string, userId: string): Promise<boolean> {
  const session = await prisma.userSession.findUnique({
    where: { id: sessionId },
    select: { userId: true, revokedAt: true, expiresAt: true },
  });
  return Boolean(
    session
      && session.userId === userId
      && !session.revokedAt
      && session.expiresAt.getTime() > Date.now(),
  );
}

export const authenticate = async (req: AuthRequest, _res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('未授权，请先登录', 401);
    }

    const token = authHeader.replace('Bearer ', '');
    const decoded = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        department: true,
        avatar: true,
        isActive: true,
        tokenVersion: true,
      },
    });

    if (!user) {
      throw new AppError('用户不存在', 401);
    }

    if (!user.isActive) {
      throw new AppError('账户已被禁用', 403);
    }

    if (!isTokenVersionValid(decoded.ver, user.tokenVersion)) {
      throw new AppError('登录会话已失效，请重新登录', 401, 'AUTH_TOKEN_INVALID');
    }

    if (decoded.sid && !(await isSessionActive(decoded.sid, user.id))) {
      throw new AppError('设备会话已撤销，请重新登录', 401, 'AUTH_TOKEN_INVALID');
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role.toLowerCase(),
      department: user.department,
      avatar: user.avatar,
    };
    req.sessionId = decoded.sid;

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new AppError('登录已过期，请重新登录', 401));
    } else if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError('无效的认证令牌', 401));
    } else {
      next(error);
    }
  }
};

export const optionalAuth = async (req: AuthRequest, _res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.replace('Bearer ', '');
    const decoded = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        department: true,
        avatar: true,
        isActive: true,
        tokenVersion: true,
      },
    });

    if (
      user
      && user.isActive
      && isTokenVersionValid(decoded.ver, user.tokenVersion)
      && (!decoded.sid || await isSessionActive(decoded.sid, user.id))
    ) {
      req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role.toLowerCase(),
        department: user.department,
        avatar: user.avatar,
      };
      req.sessionId = decoded.sid;
    }

    next();
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[optionalAuth] silent auth failure:', err);
    }
    next();
  }
};
