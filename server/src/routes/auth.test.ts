import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createHash } from 'crypto';

function createActiveUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'active.user@example.com',
    name: 'Active User',
    role: 'SALES',
    department: 'Sales',
    avatar: null,
    isActive: true,
    tokenVersion: 0,
    ...overrides,
  };
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    userId: 'u1',
    refreshTokenHash: '0'.repeat(64),
    deviceName: 'Chrome on Windows',
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    lastSeenAt: new Date('2026-07-17T00:01:00.000Z'),
    expiresAt: new Date('2026-07-24T00:00:00.000Z'),
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

describe('Auth routes integration', () => {
  let app: express.Application;
  let prismaMock: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    userSession: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    securityEvent: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let authEmailServiceMock: {
    sendActivationEmailToUser: ReturnType<typeof vi.fn>;
    sendPasswordResetEmailToUser: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    vi.resetModules();
    prismaMock = {
      user: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      userSession: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      securityEvent: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
      },
    };
    authEmailServiceMock = {
      sendActivationEmailToUser: vi.fn().mockResolvedValue({
        link: 'http://127.0.0.1:5173/?activate=test-token',
        emailDeliveryStatus: 'sent',
      }),
      sendPasswordResetEmailToUser: vi.fn().mockResolvedValue({
        link: 'http://127.0.0.1:5173/?reset=test-token',
        emailDeliveryStatus: 'sent',
      }),
    };
    vi.doMock('../lib/prisma.js', () => ({
      default: prismaMock,
    }));
    vi.doMock('../lib/authEmailService.js', () => authEmailServiceMock);

    const authRouter = (await import('./auth.js')).default;
    const { errorHandler: eh } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use(eh);
  });

  it('should reject invalid email format', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('should reject empty password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('should expose the refresh token only through an HttpOnly cookie on login', async () => {
    const password = 'Password123!';
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'active.user@example.com',
      name: 'Active User',
      password: await bcrypt.hash(password, 10),
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: true,
      tokenVersion: 0,
    });
    prismaMock.user.update.mockResolvedValue({ id: 'u1' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'active.user@example.com', password });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.refreshToken).toBeUndefined();
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] || []);
    expect(cookies.some((value) => value.includes('HttpOnly'))).toBe(true);
    expect(prismaMock.userSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'u1',
        refreshTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        deviceName: expect.any(String),
        expiresAt: expect.any(Date),
      }),
    }));
    expect(prismaMock.securityEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'LOGIN_SUCCESS', sessionId: expect.any(String) }),
    }));
  });

  it('should reject missing refresh token', async () => {
    const res = await request(app).post('/api/auth/refresh').send({});
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('AUTH_UNAUTHORIZED');
  });

  it('should reject a refresh token supplied in JSON instead of the HttpOnly cookie', async () => {
    const refreshToken = jwt.sign({ id: 'u1' }, 'test-refresh-secret', { expiresIn: '7d' });
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_UNAUTHORIZED');
  });

  it('should accept the HttpOnly refresh cookie and rotate it', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'active.user@example.com',
      name: 'Active User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: true,
    });

    const refreshToken = jwt.sign({ id: 'u1' }, 'test-refresh-secret', { expiresIn: '7d' });
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `aerolink_refresh_token=${encodeURIComponent(refreshToken)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeUndefined();
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] || []);
    expect(cookies.some((value) => value.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((value) => value.includes('SameSite=Lax'))).toBe(true);
  });

  it('should reject a refresh token from a revoked session version', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'active.user@example.com',
      name: 'Active User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: true,
      tokenVersion: 2,
    });

    const staleToken = jwt.sign({ id: 'u1', ver: 1 }, 'test-refresh-secret', { expiresIn: '7d' });
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `aerolink_refresh_token=${encodeURIComponent(staleToken)}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('should clear the refresh cookie on logout', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', 'aerolink_refresh_token=legacy-token');

    expect(res.status).toBe(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] || []);
    expect(cookies.some((value) => /Max-Age=0|Expires=Thu, 01 Jan 1970/.test(value))).toBe(true);
  });

  it('should expose normalized capability grants for the authenticated user', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'sales.user@example.com',
      name: 'Sales User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: true,
      tokenVersion: 0,
    });
    const accessToken = jwt.sign({ id: 'u1', role: 'SALES', ver: 0 }, 'test-jwt-secret', { expiresIn: '15m' });

    const res = await request(app)
      .get('/api/auth/capabilities')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('sales');
    expect(res.body.data.grants).toEqual(expect.arrayContaining([
      { capability: 'rfq.read', scope: 'own' },
      { capability: 'quotation.send', scope: 'own' },
    ]));
    expect(res.body.data.grants).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'email_account.manage' }),
    ]));
  });

  it('lists the caller\'s device sessions and marks the token session as current', async () => {
    prismaMock.user.findUnique.mockResolvedValue(createActiveUser());
    prismaMock.userSession.findUnique.mockResolvedValue(createSession({ id: 'session-current' }));
    prismaMock.userSession.findMany.mockResolvedValue([
      createSession({ id: 'session-current' }),
      createSession({
        id: 'session-revoked',
        revokedAt: new Date('2026-07-17T00:05:00.000Z'),
        revokedReason: 'manual',
      }),
    ]);
    const accessToken = jwt.sign(
      { id: 'u1', role: 'SALES', ver: 0, sid: 'session-current' },
      'test-jwt-secret',
      { expiresIn: '15m' },
    );

    const res = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'session-current', isCurrent: true, isActive: true }),
      expect.objectContaining({ id: 'session-revoked', isCurrent: false, isActive: false }),
    ]));
    expect(prismaMock.userSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1' },
      take: 100,
    }));
  });

  it('revokes a selected device session and records the security event', async () => {
    prismaMock.user.findUnique.mockResolvedValue(createActiveUser());
    prismaMock.userSession.findUnique
      .mockResolvedValueOnce(createSession({ id: 'session-current' }))
      .mockResolvedValueOnce(createSession({ id: 'session-other' }));
    prismaMock.userSession.update.mockResolvedValue(createSession({
      id: 'session-other',
      revokedAt: new Date('2026-07-17T00:10:00.000Z'),
    }));
    const accessToken = jwt.sign(
      { id: 'u1', role: 'SALES', ver: 0, sid: 'session-current' },
      'test-jwt-secret',
      { expiresIn: '15m' },
    );

    const res = await request(app)
      .post('/api/auth/sessions/session-other/revoke')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 'session-other', revoked: true });
    expect(prismaMock.userSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'session-other' },
      data: expect.objectContaining({ revokedAt: expect.any(Date), revokedReason: '用户手动撤销设备会话' }),
    }));
    expect(prismaMock.securityEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'SESSION_REVOKED', sessionId: 'session-other' }),
    }));
  });

  it('revokes every session and increments the user token version', async () => {
    prismaMock.user.findUnique.mockResolvedValue(createActiveUser());
    prismaMock.userSession.findUnique.mockResolvedValue(createSession({ id: 'session-current' }));
    prismaMock.user.update.mockResolvedValue({ tokenVersion: 1 });
    prismaMock.userSession.updateMany.mockResolvedValue({ count: 2 });
    const accessToken = jwt.sign(
      { id: 'u1', role: 'SALES', ver: 0, sid: 'session-current' },
      'test-jwt-secret',
      { expiresIn: '15m' },
    );

    const res = await request(app)
      .post('/api/auth/sessions/revoke-all')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revokedSessions: 2, tokenVersion: 1 });
    expect(prismaMock.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { tokenVersion: { increment: 1 } },
    }));
    expect(prismaMock.userSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1', revokedAt: null },
      data: expect.objectContaining({ revokedReason: '用户撤销全部设备会话' }),
    }));
  });

  it('detects refresh-token reuse and revokes that device session', async () => {
    const refreshToken = jwt.sign(
      { id: 'u1', ver: 0, sid: 'session-1', jti: 'refresh-1' },
      'test-refresh-secret',
      { expiresIn: '7d' },
    );
    prismaMock.user.findUnique.mockResolvedValue(createActiveUser());
    prismaMock.userSession.findUnique.mockResolvedValue(createSession({
      id: 'session-1',
      refreshTokenHash: createHash('sha256').update('older-token').digest('hex'),
    }));
    prismaMock.userSession.update.mockResolvedValue(createSession({
      id: 'session-1',
      revokedAt: new Date('2026-07-17T00:12:00.000Z'),
    }));

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `aerolink_refresh_token=${encodeURIComponent(refreshToken)}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_TOKEN_INVALID');
    expect(prismaMock.userSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'session-1' },
      data: expect.objectContaining({ revokedReason: '检测到已轮换刷新令牌被复用' }),
    }));
    expect(prismaMock.securityEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'REFRESH_TOKEN_REUSE_DETECTED', severity: 'WARNING', status: 'OPEN' }),
    }));
  });

  it('rejects an access token whose device session was revoked', async () => {
    prismaMock.user.findUnique.mockResolvedValue(createActiveUser());
    prismaMock.userSession.findUnique.mockResolvedValue(createSession({
      id: 'session-revoked',
      revokedAt: new Date('2026-07-17T00:15:00.000Z'),
    }));
    const accessToken = jwt.sign(
      { id: 'u1', role: 'SALES', ver: 0, sid: 'session-revoked' },
      'test-jwt-secret',
      { expiresIn: '15m' },
    );

    const res = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_TOKEN_INVALID');
    expect(prismaMock.userSession.findMany).not.toHaveBeenCalled();
  });

  it('should reject activation with a short password', async () => {
    const res = await request(app)
      .post('/api/auth/activate')
      .send({ token: 'abc123', password: '1234567' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('should return activation metadata for a valid token', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'new.user@example.com',
      name: 'New User',
      isActive: false,
      activationTokenExpiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app).get('/api/auth/activation/test-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe('new.user@example.com');
  });

  it('should activate account and return login tokens', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'new.user@example.com',
      name: 'New User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: false,
      activationToken: 'test-token',
      activationTokenExpiresAt: new Date(Date.now() + 60_000),
      password: 'old-hash',
    });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'new.user@example.com',
      name: 'New User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
    });

    const res = await request(app)
      .post('/api/auth/activate')
      .send({ token: 'test-token', password: 'Password123!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(res.body.data.user.email).toBe('new.user@example.com');
  });

  it('should send forgot-password email for an active user', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'active.user@example.com',
      name: 'Active User',
      isActive: true,
      activationToken: null,
      activationTokenExpiresAt: null,
    });
    prismaMock.user.update.mockResolvedValue({ id: 'u1' });

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'active.user@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toContain('如果该邮箱对应账户存在');
    expect(prismaMock.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'u1' },
      data: expect.objectContaining({
        passwordResetToken: expect.any(String),
        passwordResetTokenExpiresAt: expect.any(Date),
      }),
    }));
    expect(authEmailServiceMock.sendPasswordResetEmailToUser).toHaveBeenCalledWith(
      { id: 'u1', name: 'Active User', email: 'active.user@example.com' },
      expect.any(String),
      expect.any(Date)
    );
  });

  it('should return reset metadata for a valid reset token', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'active.user@example.com',
      name: 'Active User',
      isActive: true,
      passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app).get('/api/auth/reset/reset-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe('active.user@example.com');
  });

  it('should reset password and return login tokens', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'active.user@example.com',
      name: 'Active User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: true,
      passwordResetToken: 'reset-token',
      passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
      password: 'old-hash',
    });
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      email: 'active.user@example.com',
      name: 'Active User',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
    });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'reset-token', password: 'Password123!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(res.body.data.user.email).toBe('active.user@example.com');
  });
});
