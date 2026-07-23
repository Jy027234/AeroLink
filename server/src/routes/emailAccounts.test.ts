import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('Email account routes integration', () => {
  let app: express.Application;
  let router: express.Router;
  let errorHandler: express.ErrorRequestHandler;
  let prismaMock: {
    outboundEmail: {
      findMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.resetModules();
    prismaMock = {
      outboundEmail: {
        findMany: vi.fn(),
      },
    };

    vi.doMock('../lib/prisma.js', () => ({
      default: prismaMock,
    }));
    vi.doMock('../lib/emailService.js', () => ({
      testImapConnection: vi.fn(),
      testSmtpConnection: vi.fn(),
    }));
    vi.doMock('../lib/inboundEmailSyncService.js', () => ({
      syncEmailAccount: vi.fn(),
    }));
    vi.doMock('../lib/crypto.js', () => ({
      encrypt: vi.fn((value: string) => value),
      decrypt: vi.fn((value: string) => value),
    }));
    vi.doMock('../lib/logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }));
    vi.doMock('../lib/authEmailService.js', () => ({
      MISSING_OUTBOUND_ACCOUNT_MESSAGE: '未配置可用的发件邮箱，请先在系统设置中启用默认邮箱账户',
    }));

    router = (await import('./emailAccounts.js')).default;
    ({ errorHandler } = await import('../middleware/errorHandler.js'));

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string; role: string } }).user = {
        id: 'gm-1',
        role: 'gm',
      };
      next();
    });
    app.use('/api/email-accounts', router);
    app.use(errorHandler);
  });

  it('should return recent auth delivery history with summary counts', async () => {
    prismaMock.outboundEmail.findMany.mockResolvedValue([
      {
        id: 'mail-1',
        purpose: 'USER_ACTIVATION',
        toEmail: 'new.user@example.com',
        subject: 'AeroLink 账户激活',
        status: 'SENT',
        errorMessage: null,
        createdAt: new Date('2026-06-13T08:00:00.000Z'),
        sentAt: new Date('2026-06-13T08:01:00.000Z'),
        account: { email: 'ops@example.com' },
      },
      {
        id: 'mail-2',
        purpose: 'PASSWORD_RESET',
        toEmail: 'buyer@example.com',
        subject: 'AeroLink 密码重置',
        status: 'SKIPPED',
        errorMessage: '未配置可用的发件邮箱，请先在系统设置中启用默认邮箱账户',
        createdAt: new Date('2026-06-13T07:00:00.000Z'),
        sentAt: null,
        account: null,
      },
      {
        id: 'mail-3',
        purpose: 'PASSWORD_RESET',
        toEmail: 'buyer.two@example.com',
        subject: 'AeroLink 密码重置',
        status: 'FAILED',
        errorMessage: 'SMTP auth failed',
        createdAt: new Date('2026-06-13T06:00:00.000Z'),
        sentAt: null,
        account: { email: 'ops@example.com' },
      },
    ]);

    const res = await request(app).get('/api/email-accounts/auth-deliveries?limit=3');

    expect(res.status).toBe(200);
    expect(prismaMock.outboundEmail.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 3,
      orderBy: [{ createdAt: 'desc' }],
    }));
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toHaveLength(3);
    expect(res.body.data.items[0].deliveryStatus).toBe('sent');
    expect(res.body.data.items[1].deliveryStatus).toBe('skipped');
    expect(res.body.data.items[2].deliveryStatus).toBe('failed');
    expect(res.body.data.summary).toEqual({
      total: 3,
      sent: 1,
      failed: 1,
      skipped: 1,
      pending: 0,
    });
  });

  it('should reject auth delivery history access for non-privileged roles', async () => {
    const unauthorizedApp = express();
    unauthorizedApp.use(express.json());
    unauthorizedApp.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string; role: string } }).user = {
        id: 'sales-1',
        role: 'sales',
      };
      next();
    });
    unauthorizedApp.use('/api/email-accounts', router);
    unauthorizedApp.use(errorHandler);

    const res = await request(unauthorizedApp).get('/api/email-accounts/auth-deliveries');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_FORBIDDEN');
  });
});
