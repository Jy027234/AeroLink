import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { validateBody } from '../middleware/validate.js';
import { generateTokens, verifyRefreshToken, authenticate, AuthRequest } from '../middleware/auth.js';
import { loginSchema } from '../lib/validation.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new AppError('邮箱或密码错误', 401, 'AUTH_INVALID_CREDENTIALS');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new AppError('邮箱或密码错误', 401, 'AUTH_INVALID_CREDENTIALS');
    }

    if (!user.isActive) {
      throw new AppError('账户已被禁用', 403, 'AUTH_FORBIDDEN');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const { accessToken, refreshToken } = generateTokens({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role.toLowerCase(),
      department: user.department,
      avatar: user.avatar,
    });

    res.json({
      success: true,
      data: {
        token: accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role.toLowerCase(),
          department: user.department,
          avatar: user.avatar,
        },
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
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role.toLowerCase(),
      department: user.department,
      avatar: user.avatar,
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

export default router;
