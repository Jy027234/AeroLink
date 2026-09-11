import type { NextFunction, Request, Response } from 'express';
import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import {
  consumeRefreshRequestQuota,
  resolveCurrentRefreshIdentity,
  type CurrentRefreshIdentity,
} from './auth.js';

const REFRESH_COOKIE_NAME = 'aerolink_refresh_token';

export type RefreshRateLimitOptions = {
  production: boolean;
  windowMs: number;
  limit: number;
  resolveIdentity?: (token: string) => Promise<CurrentRefreshIdentity>;
  consumeIdentityQuota?: (userId: string, sessionId?: string) => boolean;
};

export function readRefreshToken(req: Request) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!cookie) return undefined;
  try {
    const token = decodeURIComponent(cookie.slice(REFRESH_COOKIE_NAME.length + 1));
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the two refresh controls in order: a validated user/session quota,
 * then an IP-only abuse quota for requests that could not be validated.
 * `res.locals` is request-local and prevents a valid session from consuming
 * the shared source-address bucket.
 */
export function createRefreshRateLimiters(options: RefreshRateLimitOptions): {
  validatedIdentityLimiter: (req: Request, res: Response, next: NextFunction) => void;
  ipLimiter: RateLimitRequestHandler;
} {
  const resolveIdentity = options.resolveIdentity ?? resolveCurrentRefreshIdentity;
  const consumeIdentity = options.consumeIdentityQuota ?? consumeRefreshRequestQuota;

  const validatedIdentityLimiter = async (req: Request, res: Response, next: NextFunction) => {
    if (!options.production) return next();
    const token = readRefreshToken(req);
    if (!token) return next();
    try {
      const identity = await resolveIdentity(token);
      if (!consumeIdentity(identity.userId, identity.sessionId)) {
        return res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMIT', message: '刷新请求过于频繁，请稍后重试' },
        });
      }
      res.locals.refreshIdentityValidated = true;
    } catch {
      // Invalid/expired/mismatched tokens continue to the route and consume
      // only the separate IP abuse quota below.
    }
    return next();
  };

  const ipLimiter = rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: false,
    skip: (_req, res) => !options.production || res.locals.refreshIdentityValidated === true,
  });

  return { validatedIdentityLimiter, ipLimiter };
}
