import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { generateTokens, verifyRefreshToken, authenticate, AuthRequest, isTokenVersionValid } from '../middleware/auth.js';
import { assertCapability, requireCapability } from '../middleware/capability.js';
import { sendActivationEmailToUser, sendPasswordResetEmailToUser } from '../lib/authEmailService.js';
import { generateAuthToken, getActivationExpiryDate, getPasswordResetExpiryDate } from '../lib/authFlow.js';
import { forgotPasswordSchema, loginSchema, tokenPasswordSchema, validatePasswordStrength } from '../lib/validation.js';
import { isLocked, recordFailedAttempt, clearAttempts } from '../lib/loginAttempt.js';
import { getCapabilitiesForActor, normalizeRole } from '../lib/capabilityPolicy.js';
import {
  getSessionExpiryDate,
  getSessionMetadata,
  hashRefreshToken,
  matchesRefreshTokenHash,
} from '../lib/sessionService.js';
import prisma from '../lib/prisma.js';

const router = Router();
const PASSWORD_ASSISTANCE_MESSAGE = '如果该邮箱对应账户存在，系统已发送后续操作邮件，请注意查收。如未收到，请联系管理员。';
const REFRESH_COOKIE_NAME = 'aerolink_refresh_token';
const refreshCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/api/auth',
};

function setRefreshTokenCookie(res: Response, refreshToken: string) {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);
}

function clearRefreshTokenCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: refreshCookieOptions.secure,
    sameSite: refreshCookieOptions.sameSite,
    path: refreshCookieOptions.path,
  });
}

function readRefreshTokenCookie(req: Request): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;

  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REFRESH_COOKIE_NAME}=`));

  if (!cookie) return undefined;
  return decodeURIComponent(cookie.slice(REFRESH_COOKIE_NAME.length + 1));
}

function serializeAuthUser(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  department: string | null;
  avatar: string | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role.toLowerCase(),
    department: user.department,
    avatar: user.avatar,
  };
}

type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  department: string | null;
  avatar: string | null;
  tokenVersion: number;
};

type SecurityEventInput = {
  userId: string;
  sessionId?: string | null;
  type: string;
  severity?: 'INFO' | 'WARNING';
  message: string;
};

async function recordSecurityEvent(req: Request, input: SecurityEventInput) {
  const metadata = getSessionMetadata(req);
  const severity = input.severity ?? 'INFO';
  const status = severity === 'WARNING' ? 'OPEN' : 'RESOLVED';

  await prisma.securityEvent.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      type: input.type,
      severity,
      message: input.message,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      status,
      resolvedAt: status === 'RESOLVED' ? new Date() : null,
    },
  });
}

function issueSessionTokens(user: SessionUser, sessionId: string) {
  const refreshTokenId = randomUUID();
  const tokens = generateTokens({
    ...serializeAuthUser(user),
    tokenVersion: user.tokenVersion,
    sessionId,
    refreshTokenId,
  });
  return { ...tokens, refreshTokenId };
}

async function createUserSession(user: SessionUser, req: Request, eventType = 'LOGIN_SUCCESS') {
  const sessionId = randomUUID();
  const tokens = issueSessionTokens(user, sessionId);
  const metadata = getSessionMetadata(req);
  const now = new Date();

  await prisma.userSession.create({
    data: {
      id: sessionId,
      userId: user.id,
      refreshTokenHash: hashRefreshToken(tokens.refreshToken),
      deviceName: metadata.deviceName,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: getSessionExpiryDate(now),
    },
  });
  await recordSecurityEvent(req, {
    userId: user.id,
    sessionId,
    type: eventType,
    message: eventType === 'LOGIN_SUCCESS' ? '已创建新的设备会话' : '已升级为可管理设备会话',
  });

  return { ...tokens, sessionId };
}

async function rotateUserSession(
  user: SessionUser,
  sessionId: string,
  req: Request,
) {
  const tokens = issueSessionTokens(user, sessionId);
  const metadata = getSessionMetadata(req);
  const now = new Date();

  await prisma.userSession.update({
    where: { id: sessionId },
    data: {
      refreshTokenHash: hashRefreshToken(tokens.refreshToken),
      deviceName: metadata.deviceName,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      lastSeenAt: now,
      expiresAt: getSessionExpiryDate(now),
    },
  });

  return { ...tokens, sessionId };
}

async function revokeUserSession(
  session: { id: string; userId: string; revokedAt: Date | null },
  req: Request,
  reason: string,
) {
  if (session.revokedAt) return false;

  await prisma.userSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  await recordSecurityEvent(req, {
    userId: session.userId,
    sessionId: session.id,
    type: 'SESSION_REVOKED',
    message: `设备会话已撤销：${reason}`,
  });
  return true;
}

async function revokeAllUserSessions(userId: string, req: Request, reason: string, sessionId?: string) {
  const result = await prisma.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  await recordSecurityEvent(req, {
    userId,
    sessionId,
    type: 'ALL_SESSIONS_REVOKED',
    message: `已撤销全部设备会话：${reason}`,
  });
  return result.count;
}

router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // 检查账户是否被锁定
    const lockStatus = isLocked(email);
    if (lockStatus.locked) {
      throw new AppError(
        `账户已锁定，请 ${lockStatus.remainingMinutes} 分钟后重试`,
        429,
        'AUTH_TOO_MANY_ATTEMPTS'
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      recordFailedAttempt(email);
      throw new AppError('邮箱或密码错误', 401, 'AUTH_INVALID_CREDENTIALS');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      await recordSecurityEvent(req, {
        userId: user.id,
        type: 'LOGIN_FAILED',
        severity: 'WARNING',
        message: '登录失败：密码不匹配',
      });
      const result = recordFailedAttempt(email);
      if (result.locked) {
        throw new AppError(
          `账户已锁定，请 ${result.lockDurationMinutes} 分钟后重试`,
          429,
          'AUTH_TOO_MANY_ATTEMPTS'
        );
      }
      throw new AppError('邮箱或密码错误', 401, 'AUTH_INVALID_CREDENTIALS');
    }

    if (!user.isActive) {
      throw new AppError(
        user.activationToken ? '账户尚未激活，请使用激活链接设置密码' : '账户已被禁用',
        403,
        'AUTH_FORBIDDEN'
      );
    }

    // 登录成功，清除失败记录
    clearAttempts(email);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const { accessToken, refreshToken } = await createUserSession(user, req);

    setRefreshTokenCookie(res, refreshToken);

    res.json({
      success: true,
      data: {
        token: accessToken,
        user: serializeAuthUser(user),
      },
    });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const refreshToken = readRefreshTokenCookie(req);

    if (!refreshToken) {
      throw new AppError('请提供刷新令牌', 401, 'AUTH_UNAUTHORIZED');
    }

    const decoded = verifyRefreshToken(refreshToken);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (!user || !user.isActive) {
      throw new AppError('无效的刷新令牌', 401, 'AUTH_TOKEN_INVALID');
    }

    if (!isTokenVersionValid(decoded.ver, user.tokenVersion)) {
      throw new AppError('刷新令牌已失效，请重新登录', 401, 'AUTH_TOKEN_INVALID');
    }

    let tokens: {
      accessToken: string;
      refreshToken: string;
      refreshTokenId: string;
      sessionId: string;
    };
    if (decoded.sid && decoded.jti) {
      const session = await prisma.userSession.findUnique({
        where: { id: decoded.sid },
        select: {
          id: true,
          userId: true,
          refreshTokenHash: true,
          revokedAt: true,
          expiresAt: true,
        },
      });

      if (!session || session.userId !== user.id || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
        throw new AppError('设备会话已失效，请重新登录', 401, 'AUTH_TOKEN_INVALID');
      }

      if (!matchesRefreshTokenHash(refreshToken, session.refreshTokenHash)) {
        await revokeUserSession(session, req, '检测到已轮换刷新令牌被复用');
        await recordSecurityEvent(req, {
          userId: user.id,
          sessionId: session.id,
          type: 'REFRESH_TOKEN_REUSE_DETECTED',
          severity: 'WARNING',
          message: '检测到已轮换刷新令牌被复用，当前设备会话已撤销',
        });
        throw new AppError('刷新令牌已失效，请重新登录', 401, 'AUTH_TOKEN_INVALID');
      }

      tokens = await rotateUserSession(user, session.id, req);
    } else {
      // Cookies issued before device-session support are upgraded on their next
      // successful refresh instead of forcing an immediate, system-wide logout.
      tokens = await createUserSession(user, req, 'LEGACY_SESSION_UPGRADED');
    }

    setRefreshTokenCookie(res, tokens.refreshToken);

    res.json({
      success: true,
      data: { accessToken: tokens.accessToken },
    });
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const refreshToken = readRefreshTokenCookie(req);
    if (refreshToken) {
      try {
        const decoded = verifyRefreshToken(refreshToken);
        if (decoded.sid) {
          const session = await prisma.userSession.findUnique({
            where: { id: decoded.sid },
            select: { id: true, userId: true, refreshTokenHash: true, revokedAt: true },
          });
          if (session && session.userId === decoded.id && matchesRefreshTokenHash(refreshToken, session.refreshTokenHash)) {
            await revokeUserSession(session, req, '用户主动退出登录');
          }
        }
      } catch {
        // Logout remains idempotent even for expired or already-cleared cookies.
      }
    }
    clearRefreshTokenCookie(res);
    res.json({ success: true });
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json({
      success: true,
      data: req.user,
    });
  })
);

router.get(
  '/capabilities',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const actor = req.user!;
    res.json({
      success: true,
      data: {
        role: normalizeRole(actor.role),
        grants: getCapabilitiesForActor(actor),
      },
    });
  })
);

router.get(
  '/sessions',
  authenticate,
  requireCapability('session', 'read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const sessions = await prisma.userSession.findMany({
      where: { userId: req.user!.id },
      select: {
        id: true,
        deviceName: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true,
        revokedReason: true,
      },
      orderBy: [{ revokedAt: 'asc' }, { lastSeenAt: 'desc' }],
      take: 100,
    });

    res.json({
      success: true,
      data: sessions.map((session) => ({
        id: session.id,
        deviceName: session.deviceName,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        revokedAt: session.revokedAt?.toISOString() ?? null,
        revokedReason: session.revokedReason,
        isCurrent: session.id === req.sessionId,
        isActive: !session.revokedAt && session.expiresAt.getTime() > Date.now(),
      })),
    });
  })
);

router.post(
  '/sessions/revoke-all',
  authenticate,
  requireCapability('session', 'manage'),
  asyncHandler(async (req: AuthRequest, res) => {
    const actor = req.user!;
    assertCapability(actor, 'session', 'manage', { ownerId: actor.id });
    const updatedUser = await prisma.user.update({
      where: { id: actor.id },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    const revokedSessions = await revokeAllUserSessions(actor.id, req, '用户撤销全部设备会话', req.sessionId);

    clearRefreshTokenCookie(res);
    res.json({
      success: true,
      data: { revokedSessions, tokenVersion: updatedUser.tokenVersion },
    });
  })
);

router.post(
  '/sessions/:id/revoke',
  authenticate,
  requireCapability('session', 'manage'),
  asyncHandler(async (req: AuthRequest, res) => {
    const session = await prisma.userSession.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (!session) {
      throw new AppError('设备会话不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    assertCapability(req.user!, 'session', 'manage', { ownerId: session.userId });
    const revoked = await revokeUserSession(session, req, '用户手动撤销设备会话');
    if (session.id === req.sessionId) {
      clearRefreshTokenCookie(res);
    }

    res.json({ success: true, data: { id: session.id, revoked } });
  })
);

router.get(
  '/security-events',
  authenticate,
  requireCapability('session', 'read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '30'), 10) || 30));
    const status = req.query.status === 'OPEN' || req.query.status === 'RESOLVED'
      ? req.query.status
      : undefined;
    const where = { userId: req.user!.id, ...(status ? { status } : {}) };
    const [events, total] = await Promise.all([
      prisma.securityEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.securityEvent.count({ where }),
    ]);

    res.json({
      success: true,
      data: events.map((event) => ({
        id: event.id,
        sessionId: event.sessionId,
        type: event.type,
        severity: event.severity,
        message: event.message,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        metadata: event.metadata,
        status: event.status,
        createdAt: event.createdAt.toISOString(),
        resolvedAt: event.resolvedAt?.toISOString() ?? null,
      })),
      pagination: { limit, total },
    });
  })
);

router.post(
  '/security-events/:id/acknowledge',
  authenticate,
  requireCapability('session', 'manage'),
  asyncHandler(async (req: AuthRequest, res) => {
    const event = await prisma.securityEvent.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true, status: true, resolvedAt: true },
    });
    if (!event) {
      throw new AppError('安全事件不存在', 404, 'RESOURCE_NOT_FOUND');
    }
    assertCapability(req.user!, 'session', 'manage', { ownerId: event.userId });

    const updated = event.status === 'RESOLVED'
      ? event
      : await prisma.securityEvent.update({
          where: { id: event.id },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
          select: { id: true, status: true, resolvedAt: true },
        });
    res.json({
      success: true,
      data: {
        id: updated.id,
        status: updated.status,
        resolvedAt: updated.resolvedAt?.toISOString() ?? null,
      },
    });
  })
);

router.get(
  '/activation/:token',
  asyncHandler(async (req, res) => {
    const token = req.params.token;
    if (!token) {
      throw new AppError('激活令牌不能为空', 400, 'VALIDATION_ERROR');
    }

    const user = await prisma.user.findUnique({
      where: { activationToken: token },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        activationTokenExpiresAt: true,
      },
    });

    if (!user || !user.activationTokenExpiresAt) {
      throw new AppError('激活链接无效', 404, 'RESOURCE_NOT_FOUND');
    }

    if (user.isActive) {
      throw new AppError('账户已激活，请直接登录', 400, 'BAD_REQUEST');
    }

    if (user.activationTokenExpiresAt.getTime() < Date.now()) {
      throw new AppError('激活链接已过期，请联系管理员重新发送', 410, 'AUTH_TOKEN_EXPIRED');
    }

    res.json({
      success: true,
      data: {
        email: user.email,
        name: user.name,
        activationExpiresAt: user.activationTokenExpiresAt.toISOString(),
      },
    });
  })
);

router.post(
  '/activate',
  validateBody(tokenPasswordSchema),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body as {
      token: string;
      password: string;
    };

    const user = await prisma.user.findUnique({
      where: { activationToken: token },
    });

    if (!user || !user.activationTokenExpiresAt) {
      throw new AppError('激活链接无效', 404, 'RESOURCE_NOT_FOUND');
    }

    if (user.isActive) {
      throw new AppError('账户已激活，请直接登录', 400, 'BAD_REQUEST');
    }

    if (user.activationTokenExpiresAt.getTime() < Date.now()) {
      throw new AppError('激活链接已过期，请联系管理员重新发送', 410, 'AUTH_TOKEN_EXPIRED');
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      throw new AppError(strength.message, 400, 'VALIDATION_ERROR');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        isActive: true,
        activationToken: null,
        activationTokenExpiresAt: null,
        passwordResetToken: null,
        passwordResetTokenExpiresAt: null,
        lastLoginAt: new Date(),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        department: true,
        avatar: true,
        tokenVersion: true,
      },
    });

    const { accessToken, refreshToken } = await createUserSession(updatedUser, req, 'ACCOUNT_ACTIVATED');

    setRefreshTokenCookie(res, refreshToken);

    res.json({
      success: true,
      data: {
        token: accessToken,
        user: serializeAuthUser(updatedUser),
      },
    });
  })
);

router.post(
  '/forgot-password',
  validateBody(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body as { email: string };

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        activationToken: true,
        activationTokenExpiresAt: true,
      },
    });

    if (user?.isActive) {
      const resetToken = generateAuthToken();
      const resetExpiresAt = getPasswordResetExpiryDate();

      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetToken: resetToken,
          passwordResetTokenExpiresAt: resetExpiresAt,
        },
      });

      await sendPasswordResetEmailToUser(
        { id: user.id, name: user.name, email: user.email },
        resetToken,
        resetExpiresAt
      );
    } else if (user && (user.activationToken || user.activationTokenExpiresAt)) {
      const activationToken = generateAuthToken();
      const activationExpiresAt = getActivationExpiryDate();

      await prisma.user.update({
        where: { id: user.id },
        data: {
          activationToken,
          activationTokenExpiresAt: activationExpiresAt,
          passwordResetToken: null,
          passwordResetTokenExpiresAt: null,
        },
      });

      await sendActivationEmailToUser(
        { id: user.id, name: user.name, email: user.email },
        activationToken,
        activationExpiresAt
      );
    }

    res.json({
      success: true,
      data: {
        message: PASSWORD_ASSISTANCE_MESSAGE,
      },
    });
  })
);

router.get(
  '/reset/:token',
  asyncHandler(async (req, res) => {
    const token = req.params.token;
    if (!token) {
      throw new AppError('重置令牌不能为空', 400, 'VALIDATION_ERROR');
    }

    const user = await prisma.user.findUnique({
      where: { passwordResetToken: token },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        passwordResetTokenExpiresAt: true,
      },
    });

    if (!user || !user.passwordResetTokenExpiresAt) {
      throw new AppError('重置链接无效', 404, 'RESOURCE_NOT_FOUND');
    }

    if (!user.isActive) {
      throw new AppError('账户尚未激活，请先完成账户激活', 400, 'BAD_REQUEST');
    }

    if (user.passwordResetTokenExpiresAt.getTime() < Date.now()) {
      throw new AppError('重置链接已过期，请重新申请', 410, 'AUTH_TOKEN_EXPIRED');
    }

    res.json({
      success: true,
      data: {
        email: user.email,
        name: user.name,
        resetExpiresAt: user.passwordResetTokenExpiresAt.toISOString(),
      },
    });
  })
);

router.post(
  '/reset-password',
  validateBody(tokenPasswordSchema),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body as {
      token: string;
      password: string;
    };

    const user = await prisma.user.findUnique({
      where: { passwordResetToken: token },
    });

    if (!user || !user.passwordResetTokenExpiresAt) {
      throw new AppError('重置链接无效', 404, 'RESOURCE_NOT_FOUND');
    }

    if (!user.isActive) {
      throw new AppError('账户尚未激活，请先完成账户激活', 400, 'BAD_REQUEST');
    }

    if (user.passwordResetTokenExpiresAt.getTime() < Date.now()) {
      throw new AppError('重置链接已过期，请重新申请', 410, 'AUTH_TOKEN_EXPIRED');
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      throw new AppError(strength.message, 400, 'VALIDATION_ERROR');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordResetToken: null,
        passwordResetTokenExpiresAt: null,
        lastLoginAt: new Date(),
        tokenVersion: { increment: 1 },
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        department: true,
        avatar: true,
        tokenVersion: true,
      },
    });

    await revokeAllUserSessions(updatedUser.id, req, '密码重置后撤销旧会话');
    const { accessToken, refreshToken } = await createUserSession(updatedUser, req, 'PASSWORD_RESET_COMPLETED');

    setRefreshTokenCookie(res, refreshToken);

    res.json({
      success: true,
      data: {
        token: accessToken,
        user: serializeAuthUser(updatedUser),
      },
    });
  })
);

router.put(
  '/me',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { name, email, department, avatar } = req.body as {
      name?: string;
      email?: string;
      department?: string;
      avatar?: string;
    };

    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(department !== undefined ? { department: department || null } : {}),
        ...(avatar !== undefined ? { avatar: avatar || null } : {}),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        department: true,
        avatar: true,
        lastLoginAt: true,
      },
    });

    res.json({
      success: true,
      data: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role.toLowerCase(),
        department: updated.department,
        avatar: updated.avatar,
        lastLoginAt: updated.lastLoginAt?.toISOString(),
      },
    });
  })
);

router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword || !newPassword) {
      throw new AppError('当前密码和新密码不能为空', 400, 'VALIDATION_ERROR');
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
    });

    if (!user) {
      throw new AppError('用户不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new AppError('当前密码错误', 400, 'BAD_REQUEST');
    }

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      throw new AppError(strength.message, 400, 'VALIDATION_ERROR');
    }

    const password = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { password, tokenVersion: { increment: 1 } },
    });
    await revokeAllUserSessions(req.user!.id, req, '密码修改后撤销旧会话', req.sessionId);

    clearRefreshTokenCookie(res);

    res.json({
      success: true,
      data: { message: '密码已更新' },
    });
  })
);

export default router;
