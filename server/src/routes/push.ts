import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.get(
  '/vapid-public-key',
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      data: { publicKey: process.env.VAPID_PUBLIC_KEY || '' },
    });
  })
);

router.post(
  '/subscribe',
  asyncHandler(async (req: AuthRequest, res) => {
    const { endpoint, keys } = req.body as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };

    await prisma.pushSubscription.upsert({
      where: { userId: req.user!.id },
      update: {
        endpoint: endpoint || '',
        p256dh: keys?.p256dh || '',
        auth: keys?.auth || '',
        isActive: true,
      },
      create: {
        userId: req.user!.id,
        endpoint: endpoint || '',
        p256dh: keys?.p256dh || '',
        auth: keys?.auth || '',
        isActive: true,
      },
    });

    res.json({
      success: true,
      data: { success: true },
    });
  })
);

router.delete(
  '/unsubscribe',
  asyncHandler(async (req: AuthRequest, res) => {
    await prisma.pushSubscription.updateMany({
      where: { userId: req.user!.id },
      data: { isActive: false },
    });

    res.json({
      success: true,
      data: { success: true },
    });
  })
);

router.get(
  '/status',
  asyncHandler(async (req: AuthRequest, res) => {
    const subscription = await prisma.pushSubscription.findUnique({
      where: { userId: req.user!.id },
    });

    res.json({
      success: true,
      data: { subscribed: !!subscription?.isActive },
    });
  })
);

export default router;
