import { Router } from 'express';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { requireCapability } from '../middleware/capability.js';
import { validateBody } from '../middleware/validate.js';
import {
  webhookEndpointCreateSchema,
  webhookEndpointUpdateSchema,
  webhookSubscriptionReplaceSchema,
} from '../lib/validation.js';
import {
  createWebhookEndpoint,
  getSupportedWebhookEvents,
  getWebhookEndpointById,
  listWebhookDeliveries,
  listWebhookEndpoints,
  projectWebhookDelivery,
  projectWebhookSubscription,
  replaceWebhookSubscriptions,
  retryWebhookDelivery,
  sendWebhookPing,
  updateWebhookEndpoint,
} from '../lib/webhookService.js';
import prisma from '../lib/prisma.js';

const router = Router();

router.get(
  '/events',
  requireCapability('webhook', 'read'),
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      data: getSupportedWebhookEvents(),
    });
  })
);

router.get(
  '/endpoints',
  requireCapability('webhook', 'read'),
  asyncHandler(async (_req, res) => {
    const data = await listWebhookEndpoints();
    res.json({
      success: true,
      data,
    });
  })
);

router.post(
  '/endpoints',
  requireCapability('webhook', 'manage'),
  validateBody(webhookEndpointCreateSchema),
  asyncHandler(async (req, res) => {
    const endpoint = await createWebhookEndpoint(req.body);
    res.status(201).json({
      success: true,
      data: endpoint,
    });
  })
);

router.get(
  '/endpoints/:id',
  requireCapability('webhook', 'read'),
  asyncHandler(async (req, res) => {
    const endpoint = await getWebhookEndpointById(req.params.id);
    if (!endpoint) {
      throw new AppError('Webhook端点不存在', 404, 'RESOURCE_NOT_FOUND');
    }
    res.json({ success: true, data: endpoint });
  })
);

router.patch(
  '/endpoints/:id',
  requireCapability('webhook', 'manage'),
  validateBody(webhookEndpointUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.webhookEndpoint.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('Webhook端点不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const endpoint = await updateWebhookEndpoint(req.params.id, req.body);
    res.json({ success: true, data: endpoint });
  })
);

router.delete(
  '/endpoints/:id',
  requireCapability('webhook', 'delete'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.webhookEndpoint.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('Webhook端点不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    await prisma.webhookEndpoint.delete({ where: { id: req.params.id } });
    res.json({
      success: true,
      data: { message: 'Webhook端点已删除' },
    });
  })
);

router.get(
  '/endpoints/:id/subscriptions',
  requireCapability('webhook', 'read'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.webhookEndpoint.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('Webhook端点不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const subscriptions = await prisma.webhookSubscription.findMany({
      where: { endpointId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, data: subscriptions.map(projectWebhookSubscription) });
  })
);

router.put(
  '/endpoints/:id/subscriptions',
  requireCapability('webhook', 'manage'),
  validateBody(webhookSubscriptionReplaceSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.webhookEndpoint.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('Webhook端点不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const subscriptions = await replaceWebhookSubscriptions(req.params.id, req.body.eventTypes);
    res.json({ success: true, data: subscriptions.map(projectWebhookSubscription) });
  })
);

router.post(
  '/endpoints/:id/test',
  requireCapability('webhook', 'manage'),
  asyncHandler(async (req, res) => {
    const deliveryId = await sendWebhookPing(req.params.id);
    if (!deliveryId) {
      throw new AppError('Webhook端点不存在', 404, 'RESOURCE_NOT_FOUND');
    }
    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    res.json({ success: true, data: delivery ? projectWebhookDelivery(delivery) : null });
  })
);

router.get(
  '/endpoints/:id/deliveries',
  requireCapability('webhook', 'read'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.webhookEndpoint.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      throw new AppError('Webhook端点不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const result = await listWebhookDeliveries(req.params.id, page, limit);

    res.json({ success: true, data: result.items, pagination: result.pagination });
  })
);

router.post(
  '/deliveries/:id/retry',
  requireCapability('webhook', 'manage'),
  asyncHandler(async (req, res) => {
    const deliveryId = await retryWebhookDelivery(req.params.id);
    if (!deliveryId) {
      throw new AppError('投递记录不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    res.json({ success: true, data: delivery ? projectWebhookDelivery(delivery) : null });
  })
);

export default router;
