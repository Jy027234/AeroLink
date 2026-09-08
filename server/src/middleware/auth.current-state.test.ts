import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';

const originalAuthenticatedLimit = process.env.AUTHENTICATED_REQUEST_LIMIT;
const originalAuthenticatedWindow = process.env.AUTHENTICATED_REQUEST_WINDOW_MS;
const originalRefreshLimit = process.env.REFRESH_AUTHENTICATED_REQUEST_LIMIT;
const originalRefreshWindow = process.env.REFRESH_AUTHENTICATED_REQUEST_WINDOW_MS;

describe('current authentication state', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    process.env.AUTHENTICATED_REQUEST_LIMIT = '2';
    process.env.AUTHENTICATED_REQUEST_WINDOW_MS = '60000';
    process.env.REFRESH_AUTHENTICATED_REQUEST_LIMIT = '2';
    process.env.REFRESH_AUTHENTICATED_REQUEST_WINDOW_MS = '60000';
  });

  afterEach(() => {
    if (originalAuthenticatedLimit === undefined) delete process.env.AUTHENTICATED_REQUEST_LIMIT;
    else process.env.AUTHENTICATED_REQUEST_LIMIT = originalAuthenticatedLimit;
    if (originalAuthenticatedWindow === undefined) delete process.env.AUTHENTICATED_REQUEST_WINDOW_MS;
    else process.env.AUTHENTICATED_REQUEST_WINDOW_MS = originalAuthenticatedWindow;
    if (originalRefreshLimit === undefined) delete process.env.REFRESH_AUTHENTICATED_REQUEST_LIMIT;
    else process.env.REFRESH_AUTHENTICATED_REQUEST_LIMIT = originalRefreshLimit;
    if (originalRefreshWindow === undefined) delete process.env.REFRESH_AUTHENTICATED_REQUEST_WINDOW_MS;
    else process.env.REFRESH_AUTHENTICATED_REQUEST_WINDOW_MS = originalRefreshWindow;
  });

  it('uses the database role and rejects revoked or disabled sessions', async () => {
    const prismaMock = {
      user: { findUnique: vi.fn() },
      userSession: { findUnique: vi.fn() },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    const {
      resolveCurrentAuthIdentity,
      revalidateCurrentAuthIdentity,
    } = await import('./auth.js');

    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Current User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: true,
      tokenVersion: 4,
    });
    prismaMock.userSession.findUnique.mockResolvedValue({
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const token = jwt.sign(
      { id: 'user-1', role: 'admin', ver: 4, sid: 'session-1' },
      'test-jwt-secret',
      { expiresIn: '5m' },
    );
    const identity = await resolveCurrentAuthIdentity(token);
    expect(identity).toMatchObject({
      id: 'user-1',
      role: 'sales',
      department: 'Sales',
      sessionId: 'session-1',
      tokenVersion: 4,
    });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' },
    }));

    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Current User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: false,
      tokenVersion: 4,
    });
    await expect(revalidateCurrentAuthIdentity(identity)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('keys authenticated quotas by validated user and session instead of shared IP', async () => {
    vi.doMock('../lib/prisma.js', () => ({ default: { user: {}, userSession: {} } }));
    const {
      consumeAuthenticatedRequestQuota,
      resetAuthenticatedRequestQuotaForTests,
    } = await import('./auth.js');
    resetAuthenticatedRequestQuotaForTests();

    expect(consumeAuthenticatedRequestQuota('user-a', 'session-a', 1)).toBe(true);
    expect(consumeAuthenticatedRequestQuota('user-a', 'session-a', 1)).toBe(true);
    expect(consumeAuthenticatedRequestQuota('user-a', 'session-a', 1)).toBe(false);
    // A different validated session has an independent business quota even if
    // it would arrive through the same proxy address.
    expect(consumeAuthenticatedRequestQuota('user-b', 'session-b', 1)).toBe(true);
  });

  it('derives a refresh quota key only from the current user and matching session hash', async () => {
    const prismaMock = {
      user: { findUnique: vi.fn() },
      userSession: { findUnique: vi.fn() },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    const {
      resolveCurrentRefreshIdentity,
      consumeRefreshRequestQuota,
      resetRefreshRequestQuotaForTests,
    } = await import('./auth.js');

    const refreshToken = jwt.sign(
      { id: 'user-a', ver: 3, sid: 'session-a', jti: 'refresh-a' },
      'test-refresh-secret',
      { expiresIn: '5m' },
    );
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-a', isActive: true, tokenVersion: 3 });
    prismaMock.userSession.findUnique.mockResolvedValue({
      id: 'session-a',
      userId: 'user-a',
      refreshTokenHash: createHash('sha256').update(refreshToken).digest('hex'),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(resolveCurrentRefreshIdentity(refreshToken)).resolves.toEqual({
      userId: 'user-a',
      sessionId: 'session-a',
    });
    resetRefreshRequestQuotaForTests();
    expect(consumeRefreshRequestQuota('user-a', 'session-a', 1)).toBe(true);
    expect(consumeRefreshRequestQuota('user-a', 'session-a', 1)).toBe(true);
    expect(consumeRefreshRequestQuota('user-a', 'session-a', 1)).toBe(false);
    expect(consumeRefreshRequestQuota('user-b', 'session-b', 1)).toBe(true);

    prismaMock.userSession.findUnique.mockResolvedValue({
      id: 'session-a',
      userId: 'user-a',
      refreshTokenHash: '0'.repeat(64),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(resolveCurrentRefreshIdentity(refreshToken)).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });
});
