/**
 * 登录失败锁定服务
 * 基于内存的简单实现，生产环境可替换为 Redis
 */

interface LoginAttempt {
  count: number;
  firstAttemptAt: number;
  lockedUntil?: number;
}

const MAX_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15分钟
const attempts = new Map<string, LoginAttempt>();

function getKey(identifier: string): string {
  return identifier.toLowerCase().trim();
}

export function recordFailedAttempt(identifier: string): { locked: boolean; remainingAttempts: number; lockDurationMinutes?: number } {
  const key = getKey(identifier);
  const now = Date.now();
  const existing = attempts.get(key);

  if (existing?.lockedUntil && existing.lockedUntil > now) {
    return {
      locked: true,
      remainingAttempts: 0,
      lockDurationMinutes: Math.ceil((existing.lockedUntil - now) / 60000),
    };
  }

  const attempt: LoginAttempt = existing
    ? { count: existing.count + 1, firstAttemptAt: existing.firstAttemptAt }
    : { count: 1, firstAttemptAt: now };

  // 如果超过最大尝试次数，锁定账户
  if (attempt.count >= MAX_ATTEMPTS) {
    attempt.lockedUntil = now + LOCK_DURATION_MS;
    attempts.set(key, attempt);
    return {
      locked: true,
      remainingAttempts: 0,
      lockDurationMinutes: LOCK_DURATION_MS / 60000,
    };
  }

  attempts.set(key, attempt);
  return {
    locked: false,
    remainingAttempts: MAX_ATTEMPTS - attempt.count,
  };
}

export function isLocked(identifier: string): { locked: boolean; remainingMinutes?: number } {
  const key = getKey(identifier);
  const now = Date.now();
  const attempt = attempts.get(key);

  if (attempt?.lockedUntil && attempt.lockedUntil > now) {
    return {
      locked: true,
      remainingMinutes: Math.ceil((attempt.lockedUntil - now) / 60000),
    };
  }

  return { locked: false };
}

export function clearAttempts(identifier: string): void {
  const key = getKey(identifier);
  attempts.delete(key);
}

// 定时清理过期的记录（每10分钟）
setInterval(() => {
  const now = Date.now();
  for (const [key, attempt] of attempts.entries()) {
    // 清理超过锁定时间后1小时的记录
    if (attempt.lockedUntil && attempt.lockedUntil + 3600000 < now) {
      attempts.delete(key);
    } else if (!attempt.lockedUntil && attempt.firstAttemptAt + 3600000 < now) {
      // 清理1小时前的未锁定记录
      attempts.delete(key);
    }
  }
}, 600000);
