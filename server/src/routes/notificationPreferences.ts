import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = Router();

function serializePreference(preference: {
  id: string;
  userId: string;
  emailNotify: boolean;
  systemNotify: boolean;
  approvalNotify: boolean;
  aogAlert: boolean;
  weeklyReport: boolean;
  wechatNotify: boolean;
  dingtalkNotify: boolean;
  larkNotify: boolean;
  smsNotify: boolean;
  pushNotify: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...preference,
    createdAt: preference.createdAt.toISOString(),
    updatedAt: preference.updatedAt.toISOString(),
  };
}

router.get(
  '/mine',
  asyncHandler(async (req: AuthRequest, res) => {
    const preference = await prisma.notificationPreference.upsert({
      where: { userId: req.user!.id },
      update: {},
      create: { userId: req.user!.id },
    });

    res.json({
      success: true,
      data: serializePreference(preference),
    });
  })
);

router.put(
  '/mine',
  asyncHandler(async (req: AuthRequest, res) => {
    const {
      emailNotify,
      systemNotify,
      approvalNotify,
      aogAlert,
      weeklyReport,
      wechatNotify,
      dingtalkNotify,
      larkNotify,
      smsNotify,
      pushNotify,
    } = req.body as Record<string, boolean | undefined>;

    const preference = await prisma.notificationPreference.upsert({
      where: { userId: req.user!.id },
      update: {
        ...(emailNotify !== undefined ? { emailNotify } : {}),
        ...(systemNotify !== undefined ? { systemNotify } : {}),
        ...(approvalNotify !== undefined ? { approvalNotify } : {}),
        ...(aogAlert !== undefined ? { aogAlert } : {}),
        ...(weeklyReport !== undefined ? { weeklyReport } : {}),
        ...(wechatNotify !== undefined ? { wechatNotify } : {}),
        ...(dingtalkNotify !== undefined ? { dingtalkNotify } : {}),
        ...(larkNotify !== undefined ? { larkNotify } : {}),
        ...(smsNotify !== undefined ? { smsNotify } : {}),
        ...(pushNotify !== undefined ? { pushNotify } : {}),
      },
      create: {
        userId: req.user!.id,
        emailNotify: emailNotify ?? true,
        systemNotify: systemNotify ?? true,
        approvalNotify: approvalNotify ?? true,
        aogAlert: aogAlert ?? true,
        weeklyReport: weeklyReport ?? false,
        wechatNotify: wechatNotify ?? false,
        dingtalkNotify: dingtalkNotify ?? false,
        larkNotify: larkNotify ?? false,
        smsNotify: smsNotify ?? false,
        pushNotify: pushNotify ?? false,
      },
    });

    res.json({
      success: true,
      data: serializePreference(preference),
    });
  })
);

export default router;
