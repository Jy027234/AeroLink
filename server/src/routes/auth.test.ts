import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Auth routes integration', () => {
  let app: express.Application;

  beforeEach(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    vi.resetModules();
    vi.doMock('../lib/prisma.js', () => ({
      default: {
        user: {
          findUnique: vi.fn(),
          update: vi.fn(),
        },
      },
    }));

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
});
