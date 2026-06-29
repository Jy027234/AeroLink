import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Auth routes integration', () => {
  let app: express.Application;
  let prismaMock: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
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

  it('should reject missing refresh token', async () => {
    const res = await request(app).post('/api/auth/refresh').send({});
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('AUTH_UNAUTHORIZED');
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
    expect(res.body.data.user.email).toBe('active.user@example.com');
  });
});
