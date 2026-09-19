import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createRefreshRateLimiters } from './refreshRateLimit.js';

function createRefreshProbe(options: Parameters<typeof createRefreshRateLimiters>[0]) {
  const app = express();
  const limiters = createRefreshRateLimiters(options);
  app.post('/refresh', limiters.validatedIdentityLimiter, limiters.ipLimiter, (_req, res) => {
    res.json({ success: true });
  });
  return app;
}

describe('refresh rate-limit separation', () => {
  it('does not share the IP quota across more than thirty validated sessions', async () => {
    const resolveIdentity = vi.fn(async (token: string) => ({
      userId: `user-${token}`,
      sessionId: `session-${token}`,
    }));
    const consumeIdentityQuota = vi.fn(() => true);
    const app = createRefreshProbe({
      production: true,
      windowMs: 60_000,
      limit: 2,
      resolveIdentity,
      consumeIdentityQuota,
    });

    const responses = await Promise.all(
      Array.from({ length: 31 }, (_, index) => request(app)
        .post('/refresh')
        .set('Cookie', `aerolink_refresh_token=validated-${index}`)),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(resolveIdentity).toHaveBeenCalledTimes(31);
    expect(consumeIdentityQuota).toHaveBeenCalledTimes(31);
  });

  it('uses the IP abuse quota only when validation fails', async () => {
    const resolveIdentity = vi.fn(async () => {
      throw new Error('invalid refresh token');
    });
    const app = createRefreshProbe({
      production: true,
      windowMs: 60_000,
      limit: 2,
      resolveIdentity,
      consumeIdentityQuota: vi.fn(() => true),
    });

    const first = await request(app).post('/refresh').set('Cookie', 'aerolink_refresh_token=invalid-1');
    const second = await request(app).post('/refresh').set('Cookie', 'aerolink_refresh_token=invalid-2');
    const third = await request(app).post('/refresh').set('Cookie', 'aerolink_refresh_token=invalid-3');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it('disables both refresh limiters outside production', async () => {
    const resolveIdentity = vi.fn(async () => {
      throw new Error('should not validate outside production');
    });
    const app = createRefreshProbe({
      production: false,
      windowMs: 60_000,
      limit: 1,
      resolveIdentity,
      consumeIdentityQuota: vi.fn(() => true),
    });

    const responses = await Promise.all(
      Array.from({ length: 31 }, () => request(app).post('/refresh')),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(resolveIdentity).not.toHaveBeenCalled();
  });
});
