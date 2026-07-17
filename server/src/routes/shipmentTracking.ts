import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { getCapabilityScope } from '../lib/capabilityPolicy.js';
import prisma from '../lib/prisma.js';

const router = Router();

function buildShipmentTrackingReadScope(actor: NonNullable<AuthRequest['user']>): Prisma.ShipmentTrackingWhereInput {
  const scope = getCapabilityScope(actor, 'order.read');
  if (scope === 'all') return {};

  const own: Prisma.ShipmentTrackingWhereInput = {
    order: { is: { quotation: { is: { createdBy: actor.id } } } },
  };
  const department = actor.department
    ? { order: { is: { quotation: { is: { creator: { is: { department: actor.department } } } } } } }
    : undefined;

  if (scope === 'department') return department ?? own;
  if (scope === 'department_or_own') {
    return department ? { OR: [own, department] } : own;
  }
  return own;
}

function serializeTracking(tracking: {
  id: string;
  orderId: string;
  trackingNumber: string;
  carrier: string;
  origin: string;
  destination: string;
  status: string;
  estimatedDelivery: Date | null;
  events: Array<{
    timestamp: Date;
    location: string;
    status: string;
    description: string;
  }>;
}) {
  return {
    id: tracking.id,
    orderId: tracking.orderId,
    trackingNumber: tracking.trackingNumber,
    carrier: tracking.carrier,
    origin: tracking.origin,
    destination: tracking.destination,
    status: tracking.status,
    estimatedDelivery: tracking.estimatedDelivery?.toISOString() || '',
    events: tracking.events.map((event) => ({
      timestamp: event.timestamp.toISOString(),
      location: event.location,
      status: event.status,
      description: event.description,
    })),
  };
}

router.get(
  '/',
  requireCapability('order', 'read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const trackings = await prisma.shipmentTracking.findMany({
      where: buildShipmentTrackingReadScope(req.user!),
      include: {
        events: { orderBy: { timestamp: 'asc' } },
      },
      orderBy: { estimatedDelivery: 'asc' },
    });

    res.json({
      success: true,
      data: trackings.map(serializeTracking),
    });
  })
);

router.get(
  '/customs-risks',
  requireCapability('order', 'read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const trackings = await prisma.shipmentTracking.findMany({
      where: buildShipmentTrackingReadScope(req.user!),
      include: {
        order: {
          select: {
            partNumber: true,
            certificateType: true,
          },
        },
      },
      take: 10,
    });
    const partNumbers = Array.from(new Set(trackings.map((tracking) => tracking.order.partNumber)));
    const inventoryItems = await prisma.inventoryItem.findMany({
      where: { partNumber: { in: partNumbers } },
      select: { partNumber: true, hsCode: true },
    });
    const hsCodeByPartNumber = new Map(inventoryItems.map((item) => [item.partNumber, item.hsCode]));

    const risks = trackings.map((tracking) => {
      const statusUpper = tracking.status.toUpperCase();
      const riskLevel =
        statusUpper.includes('CUSTOMS')
          ? 'high'
          : !tracking.order.certificateType || tracking.order.certificateType === 'NONE'
            ? 'medium'
            : 'low';

      const inspectionRate = riskLevel === 'high' ? 28 : riskLevel === 'medium' ? 14 : 6;
      const requiredDocs = ['Commercial Invoice', 'Packing List'];
      if (riskLevel !== 'low') requiredDocs.push('Airworthiness Certificate');
      if (riskLevel === 'high') requiredDocs.push('Import Permit');

      return {
        partNumber: tracking.order.partNumber,
        hsCode: hsCodeByPartNumber.get(tracking.order.partNumber) || '8803.30',
        riskLevel,
        inspectionRate,
        requiredDocs,
        recommendations:
          riskLevel === 'high'
            ? ['提前准备适航与溯源文件', '安排报关行预审资料', '预留额外清关时间']
            : riskLevel === 'medium'
              ? ['核对证书与HS编码一致性', '提前确认收货方清关要求']
              : ['保持常规单证完整性'],
      };
    });

    res.json({
      success: true,
      data: risks,
    });
  })
);

router.get(
  '/alerts',
  requireCapability('order', 'read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const now = new Date();
    const trackings = await prisma.shipmentTracking.findMany({
      where: buildShipmentTrackingReadScope(req.user!),
      include: {
        events: { orderBy: { timestamp: 'desc' }, take: 1 },
        order: { select: { partNumber: true, status: true } },
      },
    });

    const alerts = trackings.flatMap((tracking) => {
      const alertsForTracking: Array<{
        id: string;
        type: 'delay' | 'customs' | 'resolved';
        title: string;
        description: string;
        orderId: string;
        partNumber: string;
        status: 'open' | 'in_progress' | 'resolved';
        createdAt: string;
      }> = [];

      const latestTimestamp = tracking.events[0]?.timestamp || tracking.estimatedDelivery || now;
      const statusUpper = tracking.status.toUpperCase();

      if (tracking.estimatedDelivery && tracking.estimatedDelivery < now && statusUpper !== 'DELIVERED') {
        alertsForTracking.push({
          id: `delay-${tracking.id}`,
          type: 'delay',
          title: '物流延误预警',
          description: `${tracking.trackingNumber} 已超过预计到达时间`,
          orderId: tracking.orderId,
          partNumber: tracking.order.partNumber,
          status: 'open',
          createdAt: latestTimestamp.toISOString(),
        });
      }

      if (statusUpper.includes('CUSTOMS')) {
        alertsForTracking.push({
          id: `customs-${tracking.id}`,
          type: 'customs',
          title: '清关异常跟踪',
          description: `${tracking.trackingNumber} 当前处于清关节点，请复核单证`,
          orderId: tracking.orderId,
          partNumber: tracking.order.partNumber,
          status: 'in_progress',
          createdAt: latestTimestamp.toISOString(),
        });
      }

      if (statusUpper === 'DELIVERED' || tracking.order.status === 'DELIVERED' || tracking.order.status === 'COMPLETED') {
        alertsForTracking.push({
          id: `resolved-${tracking.id}`,
          type: 'resolved',
          title: '物流任务已完成',
          description: `${tracking.trackingNumber} 已完成交付`,
          orderId: tracking.orderId,
          partNumber: tracking.order.partNumber,
          status: 'resolved',
          createdAt: latestTimestamp.toISOString(),
        });
      }

      return alertsForTracking;
    });

    res.json({
      success: true,
      data: alerts,
    });
  })
);

router.get(
  '/order/:orderId',
  requireCapability('order', 'read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const tracking = await prisma.shipmentTracking.findFirst({
      where: {
        AND: [
          buildShipmentTrackingReadScope(req.user!),
          { orderId: req.params.orderId },
        ],
      },
      include: {
        events: { orderBy: { timestamp: 'asc' } },
      },
    });

    res.json({
      success: true,
      data: tracking ? serializeTracking(tracking) : null,
    });
  })
);

router.get(
  '/:trackingNumber',
  requireCapability('order', 'read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const tracking = await prisma.shipmentTracking.findFirst({
      where: {
        AND: [
          buildShipmentTrackingReadScope(req.user!),
          { trackingNumber: req.params.trackingNumber },
        ],
      },
      include: {
        events: { orderBy: { timestamp: 'asc' } },
      },
    });

    res.json({
      success: true,
      data: tracking ? serializeTracking(tracking) : null,
    });
  })
);

export default router;
