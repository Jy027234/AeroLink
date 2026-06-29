import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { generateTokens, verifyRefreshToken, authenticate, AuthRequest } from '../middleware/auth.js';
import { sendActivationEmailToUser, sendPasswordResetEmailToUser } from '../lib/authEmailService.js';
import { generateAuthToken, getActivationExpiryDate, getPasswordResetExpiryDate } from '../lib/authFlow.js';
import { forgotPasswordSchema, loginSchema, tokenPasswordSchema, validatePasswordStrength } from '../lib/validation.js';
import { isLocked, recordFailedAttempt, clearAttempts } from '../lib/loginAttempt.js';
import prisma from '../lib/prisma.js';

const router = Router();
const PASSWORD_ASSISTANCE_MESSAGE = '如果该邮箱对应账户存在，系统已发送后续操作邮件，请注意查收。如未收到，请联系管理员。';

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

    const { accessToken, refreshToken } = generateTokens({
      ...serializeAuthUser(user),
    });

    res.json({
      success: true,
      data: {
        token: accessToken,
        refreshToken,
        user: serializeAuthUser(user),
      },
    });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

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

    const tokens = generateTokens({
      ...serializeAuthUser(user),
    });

    res.json({
      success: true,
      data: tokens,
    });
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
      },
    });

    const { accessToken, refreshToken } = generateTokens({
      ...serializeAuthUser(updatedUser),
    });

    res.json({
      success: true,
      data: {
        token: accessToken,
        refreshToken,
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
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        department: true,
        avatar: true,
      },
    });

    const { accessToken, refreshToken } = generateTokens({
      ...serializeAuthUser(updatedUser),
    });

    res.json({
      success: true,
      data: {
        token: accessToken,
        refreshToken,
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
      data: { password },
    });

    res.json({
      success: true,
      data: { message: '密码已更新' },
    });
  })
);

export default router;
