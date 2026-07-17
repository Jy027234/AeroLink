import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

export const USER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionMetadata {
  deviceName: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function matchesRefreshTokenHash(token: string, storedHash: string): boolean {
  const actual = Buffer.from(hashRefreshToken(token), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function getSessionExpiryDate(now = new Date()): Date {
  return new Date(now.getTime() + USER_SESSION_TTL_MS);
}

function getClientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim() || null;
  if (Array.isArray(forwarded)) return forwarded[0] || null;
  return req.ip || req.socket.remoteAddress || null;
}

function inferPlatform(userAgent: string): string {
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'iOS';
  if (/android/i.test(userAgent)) return 'Android';
  if (/windows/i.test(userAgent)) return 'Windows';
  if (/mac os|macintosh/i.test(userAgent)) return 'macOS';
  if (/linux/i.test(userAgent)) return 'Linux';
  return 'Unknown device';
}

function inferBrowser(userAgent: string): string {
  if (/edg\//i.test(userAgent)) return 'Edge';
  if (/chrome\//i.test(userAgent)) return 'Chrome';
  if (/safari\//i.test(userAgent) && !/chrome|chromium/i.test(userAgent)) return 'Safari';
  if (/firefox\//i.test(userAgent)) return 'Firefox';
  return 'Browser';
}

export function getSessionMetadata(req: Request): SessionMetadata {
  const rawUserAgent = req.headers['user-agent'];
  const userAgent = typeof rawUserAgent === 'string' ? rawUserAgent.slice(0, 512) : null;
  const deviceName = userAgent
    ? `${inferBrowser(userAgent)} on ${inferPlatform(userAgent)}`
    : 'Unknown device';

  return {
    deviceName,
    ipAddress: getClientIp(req),
    userAgent,
  };
}
