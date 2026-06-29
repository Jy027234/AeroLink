import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Users routes integration', () => {
  let app: express.Application;
  let prismaMock: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
  };
  let authEmailServiceMock: {
    sendActivationEmailToUser: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.resetModules();
    prismaMock = {
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    };
    authEmailServiceMock = {
      sendActivationEmailToUser: vi.fn().mockResolvedValue({
        link: 'http://127.0.0.1:5173/?activate=new-user-token',
        emailDeliveryStatus: 'sent',
        outboundEmailId: 'mail-1',
      }),
    };

    vi.doMock('../lib/prisma.js', () => ({
      default: prismaMock,
    }));
    vi.doMock('../lib/authEmailService.js', () => authEmailServiceMock);

    const usersRouter = (await import('./users.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string; role: string } }).user = {
        id: 'admin-1',
        role: 'gm',
      };
      next();
    });
    app.use('/api/users', usersRouter);
    app.use(errorHandler);
  });

  it('should create an inactive user and return onboarding delivery info', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({
      id: 'u1',
      name: 'New User',
      email: 'new.user@example.com',
      role: 'SALES',
      department: 'Sales',
      avatar: null,
      isActive: false,
      activationTokenExpiresAt: new Date('2026-06-20T00:00:00.000Z'),
      lastLoginAt: null,
    });

    const res = await request(app)
      .post('/api/users')
      .send({ name: 'New User', email: 'new.user@example.com', role: 'sales', department: 'Sales' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe('new.user@example.com');
    expect(res.body.data.activationLink).toBe('http://127.0.0.1:5173/?activate=new-user-token');
    expect(res.body.data.emailDeliveryStatus).toBe('sent');
    expect(authEmailServiceMock.sendActivationEmailToUser).toHaveBeenCalledWith(
      { id: 'u1', name: 'New User', email: 'new.user@example.com' },
      expect.any(String),
      expect.any(Date)
    );
  });

  it('should reject user management access for non-privileged roles', async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string; role: string } }).user = {
        id: 'sales-1',
        role: 'sales',
      };
      next();
    });
    const usersRouter = (await import('./users.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app.use('/api/users', usersRouter);
    app.use(errorHandler);

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_FORBIDDEN');
  });
});
