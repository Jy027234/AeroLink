import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';
import { AppError } from './errorHandler.js';
import { matchesRefreshTokenHash } from '../lib/sessionService.js';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error('FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be set in environment');
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
  sessionId?: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: string;
  department?: string | null;
  avatar?: string | null;
}

/**
 * The identity returned after both token and current database state have been
 * checked.  The extra fields are kept on the server side and are never copied
 * into `req.user`, whose shape is part of the public HTTP response contract.
 */
export interface CurrentAuthIdentity extends AuthenticatedUser {
  tokenVersion: number;
  sessionId?: string;
  accessTokenExpiresAt?: number;
}

export interface VerifiedTokenPayload {
  id: string;
  role?: string;
  ver?: number;
  sid?: string;
  jti?: string;
  exp?: number;
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
  if (!('exp' in decoded) || typeof decoded.exp !== 'number') {
    throw new AppError('无效的令牌有效期', 401, 'AUTH_TOKEN_INVALID');
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

function readBoundedInteger(names: string[], fallback: number, minimum: number, maximum: number) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(maximum, Math.max(minimum, parsed));
    }
  }
  return fallback;
}

const AUTHENTICATED_REQUEST_WINDOW_MS = readBoundedInteger(
  ['AUTHENTICATED_REQUEST_WINDOW_MS', 'AUTH_REQUEST_WINDOW_MS'],
  15 * 60 * 1000,
  1_000,
  24 * 60 * 60 * 1000,
);
const AUTHENTICATED_REQUEST_LIMIT = readBoundedInteger(
  ['AUTHENTICATED_REQUEST_LIMIT', 'AUTH_REQUEST_LIMIT'],
  300,
  1,
  10_000,
);
const authenticatedRequestBuckets = new Map<string, { count: number; windowStartedAt: number }>();

function authenticatedRequestRateLimitEnabled() {
  return process.env.AUTHENTICATED_REQUEST_RATE_LIMIT_ENABLED?.toLowerCase() !== 'false';
}

/**
 * Consume the authenticated request quota after current user/session
 * validation.  This deliberately does not use an IP address or JWT claims as
 * the identity key, so employees behind one egress address do not throttle one
 * another and forged claims cannot choose a bucket.
 */
export function consumeAuthenticatedRequestQuota(
  userId: string,
  sessionId?: string,
  now = Date.now(),
): boolean {
  if (!authenticatedRequestRateLimitEnabled()) return true;

  const key = `user:${userId}:session:${sessionId || 'legacy'}`;
  const existing = authenticatedRequestBuckets.get(key);
  if (!existing || now - existing.windowStartedAt >= AUTHENTICATED_REQUEST_WINDOW_MS) {
    authenticatedRequestBuckets.set(key, { count: 1, windowStartedAt: now });
    if (authenticatedRequestBuckets.size > 10_000) {
      for (const [bucketKey, bucket] of authenticatedRequestBuckets) {
        if (now - bucket.windowStartedAt >= AUTHENTICATED_REQUEST_WINDOW_MS) {
          authenticatedRequestBuckets.delete(bucketKey);
        }
      }
    }
    return true;
  }

  if (existing.count >= AUTHENTICATED_REQUEST_LIMIT) return false;
  existing.count += 1;
  return true;
}

/** Test/support hook; it does not alter production policy. */
export function resetAuthenticatedRequestQuotaForTests() {
  authenticatedRequestBuckets.clear();
}

const REFRESH_AUTHENTICATED_REQUEST_WINDOW_MS = readBoundedInteger(
  ['REFRESH_AUTHENTICATED_REQUEST_WINDOW_MS', 'REFRESH_REQUEST_WINDOW_MS'],
  15 * 60 * 1000,
  1_000,
  24 * 60 * 60 * 1000,
);
const REFRESH_AUTHENTICATED_REQUEST_LIMIT = readBoundedInteger(
  ['REFRESH_AUTHENTICATED_REQUEST_LIMIT', 'REFRESH_REQUEST_LIMIT'],
  60,
  1,
  10_000,
);
const refreshRequestBuckets = new Map<string, { count: number; windowStartedAt: number }>();

function refreshRequestRateLimitEnabled() {
  return process.env.REFRESH_AUTHENTICATED_RATE_LIMIT_ENABLED?.toLowerCase() !== 'false';
}

/**
 * Consume the per-session refresh quota after the refresh token has been
 * verified against the current user and stored session hash.  The IP limiter
 * in index.ts remains a separate pre-authentication abuse control.
 */
export function consumeRefreshRequestQuota(
  userId: string,
  sessionId?: string,
  now = Date.now(),
): boolean {
  if (!refreshRequestRateLimitEnabled()) return true;

  const key = `user:${userId}:session:${sessionId || 'legacy'}`;
  const existing = refreshRequestBuckets.get(key);
  if (!existing || now - existing.windowStartedAt >= REFRESH_AUTHENTICATED_REQUEST_WINDOW_MS) {
    refreshRequestBuckets.set(key, { count: 1, windowStartedAt: now });
    if (refreshRequestBuckets.size > 10_000) {
      for (const [bucketKey, bucket] of refreshRequestBuckets) {
        if (now - bucket.windowStartedAt >= REFRESH_AUTHENTICATED_REQUEST_WINDOW_MS) {
          refreshRequestBuckets.delete(bucketKey);
        }
      }
    }
    return true;
  }

  if (existing.count >= REFRESH_AUTHENTICATED_REQUEST_LIMIT) return false;
  existing.count += 1;
  return true;
}

/** Test/support hook; it does not alter production policy. */
export function resetRefreshRequestQuotaForTests() {
  refreshRequestBuckets.clear();
}

export interface CurrentRefreshIdentity {
  userId: string;
  sessionId?: string;
}

type RefreshUserRecord = {
  id: string;
  isActive: boolean;
  tokenVersion: number;
};

/**
 * Validate a refresh cookie far enough to derive a safe quota key.  A caller
 * only reaches the identity bucket when both current user/session state and
 * the stored rotating refresh-token hash agree; malformed or failed refresh
 * attempts remain covered by the independent IP limiter.
 */
export async function resolveCurrentRefreshIdentity(token: string): Promise<CurrentRefreshIdentity> {
  const decoded = verifyRefreshToken(token);
  const user = await prisma.user.findUnique({
    where: { id: decoded.id },
    select: { id: true, isActive: true, tokenVersion: true },
  }) as RefreshUserRecord | null;

  if (!user || !user.isActive || !isTokenVersionValid(decoded.ver, user.tokenVersion)) {
    throw new AppError('无效的刷新令牌', 401, 'AUTH_TOKEN_INVALID');
  }

  if (!decoded.sid || !decoded.jti) {
    // Legacy refresh cookies are still accepted and upgraded by routes/auth,
    // but they can only use the validated current-user legacy bucket.
    return { userId: user.id };
  }

  const session = await prisma.userSession.findUnique({
    where: { id: decoded.sid },
    select: {
      id: true,
      userId: true,
      refreshTokenHash: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (
    !session
    || session.userId !== user.id
    || session.revokedAt
    || session.expiresAt.getTime() <= Date.now()
    || !matchesRefreshTokenHash(token, session.refreshTokenHash)
  ) {
    throw new AppError('设备会话已失效，请重新登录', 401, 'AUTH_TOKEN_INVALID');
  }

  return { userId: user.id, sessionId: session.id };
}

type CurrentUserRecord = {
  id: string;
  email: string;
  name: string;
  role: string;
  department: string | null;
  avatar: string | null;
  isActive: boolean;
  tokenVersion: number;
};

const currentUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  department: true,
  avatar: true,
  isActive: true,
  tokenVersion: true,
} as const;

function publicUser(user: CurrentAuthIdentity): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    department: user.department,
    avatar: user.avatar,
  };
}

async function loadCurrentIdentity(input: {
  userId: string;
  tokenVersion?: number;
  sessionId?: string;
  accessTokenExpiresAt?: number;
}): Promise<CurrentAuthIdentity> {
  if (input.accessTokenExpiresAt !== undefined && input.accessTokenExpiresAt <= Date.now()) {
    throw new AppError('登录已过期，请重新登录', 401, 'AUTH_TOKEN_EXPIRED');
  }

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: currentUserSelect,
  }) as CurrentUserRecord | null;

  if (!user) {
    throw new AppError('用户不存在', 401, 'AUTH_TOKEN_INVALID');
  }

  if (!user.isActive) {
    throw new AppError('账户已被禁用', 403, 'AUTH_FORBIDDEN');
  }

  if (!isTokenVersionValid(input.tokenVersion, user.tokenVersion)) {
    throw new AppError('登录会话已失效，请重新登录', 401, 'AUTH_TOKEN_INVALID');
  }

  if (input.sessionId && !(await isSessionActive(input.sessionId, user.id))) {
    throw new AppError('设备会话已撤销，请重新登录', 401, 'AUTH_TOKEN_INVALID');
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role.toLowerCase(),
    department: user.department,
    avatar: user.avatar,
    tokenVersion: user.tokenVersion,
    sessionId: input.sessionId,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
  };
}

/** Resolve an access token against current user, role and session state. */
export async function resolveCurrentAuthIdentity(token: string): Promise<CurrentAuthIdentity> {
  const decoded = verifyAccessToken(token);
  return loadCurrentIdentity({
    userId: decoded.id,
    tokenVersion: decoded.ver,
    sessionId: decoded.sid,
    accessTokenExpiresAt: decoded.exp === undefined ? undefined : decoded.exp * 1000,
  });
}

/** Re-check an established Socket.IO connection without trusting stale claims. */
export async function revalidateCurrentAuthIdentity(identity: CurrentAuthIdentity): Promise<CurrentAuthIdentity> {
  return loadCurrentIdentity({
    userId: identity.id,
    tokenVersion: identity.tokenVersion,
    sessionId: identity.sessionId,
    accessTokenExpiresAt: identity.accessTokenExpiresAt,
  });
}

export const authenticate = async (req: AuthRequest, _res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('未授权，请先登录', 401);
    }

    const token = authHeader.replace('Bearer ', '');
    const identity = await resolveCurrentAuthIdentity(token);
    if (!consumeAuthenticatedRequestQuota(identity.id, identity.sessionId)) {
      throw new AppError('已认证请求过于频繁，请稍后重试', 429, 'RATE_LIMIT');
    }

    req.user = publicUser(identity);
    req.sessionId = identity.sessionId;

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
    const identity = await resolveCurrentAuthIdentity(token);
    req.user = publicUser(identity);
    req.sessionId = identity.sessionId;

    next();
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[optionalAuth] silent auth failure:', err);
    }
    next();
  }
};
