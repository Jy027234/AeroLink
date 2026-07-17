import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import prisma from '../lib/prisma.js';

const router = Router();

function parseBindingConfig(value: unknown) {
  if (typeof value !== 'string') {
    return (value as Record<string, string>) || {};
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function serializeBinding(binding: {
  id: string;
  userId: string;
  channel: string;
  config: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: binding.id,
    userId: binding.userId,
    channel: binding.channel,
    config: parseBindingConfig(binding.config),
    isActive: binding.isActive,
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
  };
}

router.get(
  '/mine',
  requireCapability('integration', 'read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const bindings = await prisma.userChannelBinding.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: bindings.map(serializeBinding),
    });
  })
);

router.post(
  '/',
  requireCapability('integration', 'manage'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { channel, config } = req.body as {
      channel?: string;
      config?: Record<string, string>;
    };

    if (!channel) {
      throw new AppError('渠道不能为空', 400, 'VALIDATION_ERROR');
    }

    const existing = await prisma.userChannelBinding.findFirst({
      where: {
        userId: req.user!.id,
        channel: channel.toUpperCase(),
      },
    });

    if (existing) {
      throw new AppError('该渠道已绑定，请直接编辑', 409, 'RESOURCE_CONFLICT');
    }

    const binding = await prisma.userChannelBinding.create({
      data: {
        userId: req.user!.id,
        channel: channel.toUpperCase(),
        config: JSON.stringify(config || {}),
        isActive: true,
      },
    });

    res.status(201).json({
      success: true,
      data: serializeBinding(binding),
    });
  })
);

router.put(
  '/:id',
  requireCapability('integration', 'manage'),
  asyncHandler(async (req: AuthRequest, res) => {
    const existing = await prisma.userChannelBinding.findUnique({
      where: { id: req.params.id },
    });

    if (!existing || existing.userId !== req.user!.id) {
      throw new AppError('渠道绑定不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const { config, isActive } = req.body as {
      config?: Record<string, string>;
      isActive?: boolean;
    };

    const binding = await prisma.userChannelBinding.update({
      where: { id: req.params.id },
      data: {
        ...(config !== undefined ? { config: JSON.stringify(config) } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });

    res.json({
      success: true,
      data: serializeBinding(binding),
    });
  })
);

router.delete(
  '/:id',
  requireCapability('integration', 'manage'),
  asyncHandler(async (req: AuthRequest, res) => {
    const existing = await prisma.userChannelBinding.findUnique({
      where: { id: req.params.id },
    });

    if (!existing || existing.userId !== req.user!.id) {
      throw new AppError('渠道绑定不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    await prisma.userChannelBinding.delete({ where: { id: req.params.id } });

    res.json({
      success: true,
      data: { message: '渠道绑定已删除' },
    });
  })
);

export default router;
