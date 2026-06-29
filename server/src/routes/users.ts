import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { requirePrivilegedRole } from '../lib/accessControl.js';
import { sendActivationEmailToUser, type AuthEmailDeliveryResult } from '../lib/authEmailService.js';
import { generateAuthToken, getActivationExpiryDate } from '../lib/authFlow.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.use((req, _res, next) => {
  requirePrivilegedRole(req as AuthRequest, '无权操作，仅管理员或总经理可管理用户');
  next();
});

function serializeUser(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
  avatar: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  activationTokenExpiresAt?: Date | null;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.toLowerCase(),
    department: user.department || '',
    avatar: user.avatar || undefined,
    isActive: user.isActive,
    activationPending: !user.isActive && Boolean(user.activationTokenExpiresAt),
    activationExpiresAt: user.activationTokenExpiresAt?.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString(),
  };
}

function buildOnboardingPayload(
  user: ReturnType<typeof serializeUser>,
  activationToken: string,
  activationExpiresAt: Date,
  delivery: AuthEmailDeliveryResult
) {
  return {
    user,
    activationToken,
    activationLink: delivery.link,
    activationExpiresAt: activationExpiresAt.toISOString(),
    emailDeliveryStatus: delivery.emailDeliveryStatus,
    emailDeliveryError: delivery.emailDeliveryError,
    outboundEmailId: delivery.outboundEmailId,
  };
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        avatar: true,
        isActive: true,
        activationTokenExpiresAt: true,
        lastLoginAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: users.map(serializeUser),
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        avatar: true,
        isActive: true,
        activationTokenExpiresAt: true,
        lastLoginAt: true,
      },
    });

    if (!user) {
      throw new AppError('用户不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: serializeUser(user),
    });
  })
);

router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res) => {
    const { name, email, role, department } = req.body as {
      name?: string;
      email?: string;
      role?: string;
      department?: string;
    };

    if (!name || !email) {
      throw new AppError('姓名和邮箱不能为空', 400, 'VALIDATION_ERROR');
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new AppError('该邮箱已存在', 409, 'RESOURCE_CONFLICT');
    }

    const activationToken = generateAuthToken();
    const activationExpiresAt = getActivationExpiryDate();
    const password = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
    const user = await prisma.user.create({
      data: {
        name,
        email,
        role: (role || 'sales').toUpperCase(),
        department: department || null,
        password,
        isActive: false,
        activationToken,
        activationTokenExpiresAt: activationExpiresAt,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        avatar: true,
        isActive: true,
        activationTokenExpiresAt: true,
        lastLoginAt: true,
      },
    });
    const delivery = await sendActivationEmailToUser(
      { id: user.id, name: user.name, email: user.email },
      activationToken,
      activationExpiresAt
    );

    res.status(201).json({
      success: true,
      data: buildOnboardingPayload(serializeUser(user), activationToken, activationExpiresAt, delivery),
    });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('用户不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const { name, email, role, department, isActive, avatar } = req.body as {
      name?: string;
      email?: string;
      role?: string;
      department?: string;
      isActive?: boolean;
      avatar?: string;
    };

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(role !== undefined ? { role: role.toUpperCase() } : {}),
        ...(department !== undefined ? { department: department || null } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        ...(avatar !== undefined ? { avatar: avatar || null } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        avatar: true,
        isActive: true,
        activationTokenExpiresAt: true,
        lastLoginAt: true,
      },
    });

    res.json({
      success: true,
      data: serializeUser(user),
    });
  })
);

router.post(
  '/:id/activation-link',
  asyncHandler(async (req, res) => {
    const existing = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        avatar: true,
        isActive: true,
        activationTokenExpiresAt: true,
        lastLoginAt: true,
      },
    });

    if (!existing) {
      throw new AppError('用户不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (existing.isActive) {
      throw new AppError('仅未激活用户可重发激活链接', 400, 'BAD_REQUEST');
    }

    const activationToken = generateAuthToken();
    const activationExpiresAt = getActivationExpiryDate();
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        activationToken,
        activationTokenExpiresAt: activationExpiresAt,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        avatar: true,
        isActive: true,
        activationTokenExpiresAt: true,
        lastLoginAt: true,
      },
    });
    const delivery = await sendActivationEmailToUser(
      { id: user.id, name: user.name, email: user.email },
      activationToken,
      activationExpiresAt
    );

    res.json({
      success: true,
      data: buildOnboardingPayload(serializeUser(user), activationToken, activationExpiresAt, delivery),
    });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res) => {
    if (req.user?.id === req.params.id) {
      throw new AppError('不能删除当前登录账户', 400, 'BAD_REQUEST');
    }

    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('用户不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    await prisma.user.delete({ where: { id: req.params.id } });

    res.json({
      success: true,
      data: { message: '用户已删除' },
    });
  })
);

export default router;
