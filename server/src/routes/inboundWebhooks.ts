import crypto from 'crypto';
import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { webhookAudit } from '../middleware/webhookAudit.js';

const router = Router();

const createInboundAlert = async (title: string, message: string, link = '/settings') => {
  await prisma.notification.create({
    data: {
      title,
      message,
      type: 'WARNING',
      link,
      userId: null,
    },
  });
};

const verifyInboundSignature = (secret: string, payload: string, signature?: string) => {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const normalized = signature.replace(/^sha256=/i, '');
  return expected === normalized;
};

router.get(
  '/endpoints',
  authenticate,
  requireRole('manager', 'admin'),
  asyncHandler(async (_req, res) => {
    const endpoints = await prisma.inboundWebhookEndpoint.findMany({
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: endpoints });
  })
);

router.post(
  '/endpoints',
  authenticate,
  requireRole('manager', 'admin'),
  webhookAudit('CREATE', 'inbound_endpoint', (req) => req.body?.urlPath || 'new'),
  asyncHandler(async (req, res) => {
    const { name, sourceSystem, urlPath, authMethod = 'HMAC', secret, isActive = true } = req.body || {};

    if (!name || !sourceSystem || !urlPath) {
      throw new AppError('name/sourceSystem/urlPath are required', 400, 'BAD_REQUEST');
    }

    const endpoint = await prisma.inboundWebhookEndpoint.create({
      data: {
        name,
        sourceSystem,
        urlPath,
        authMethod,
        secret: secret ?? null,
        isActive,
      },
    });

    res.status(201).json({ success: true, data: endpoint });
  })
);

router.get(
  '/endpoints/:id',
  authenticate,
  requireRole('manager', 'admin'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const endpoint = await prisma.inboundWebhookEndpoint.findUnique({
      where: { id },
    });

    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({ success: true, data: endpoint });
  })
);

router.patch(
  '/endpoints/:id',
  authenticate,
  requireRole('manager', 'admin'),
  webhookAudit('UPDATE', 'inbound_endpoint', (req) => req.params?.id || 'unknown'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, authMethod, secret, sourceSystem } = req.body || {};

    const endpoint = await prisma.inboundWebhookEndpoint.findUnique({
      where: { id },
    });

    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'RESOURCE_NOT_FOUND');
    }

    const updated = await prisma.inboundWebhookEndpoint.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(authMethod !== undefined ? { authMethod } : {}),
        ...(secret !== undefined ? { secret: secret ?? null } : {}),
        ...(sourceSystem !== undefined ? { sourceSystem } : {}),
      },
    });

    res.json({ success: true, data: updated });
  })
);

router.post(
  '/endpoints/:id/disable',
  authenticate,
  requireRole('manager', 'admin'),
  webhookAudit('DISABLE_ENDPOINT', 'inbound_endpoint', (req) => req.params?.id || 'unknown'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const endpoint = await prisma.inboundWebhookEndpoint.findUnique({
      where: { id },
    });

    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'RESOURCE_NOT_FOUND');
    }

    const updated = await prisma.inboundWebhookEndpoint.update({
      where: { id },
      data: { isActive: false },
    });

    res.json({ success: true, data: updated });
  })
);

router.post(
  '/endpoints/:id/enable',
  authenticate,
  requireRole('manager', 'admin'),
  webhookAudit('ENABLE_ENDPOINT', 'inbound_endpoint', (req) => req.params?.id || 'unknown'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const endpoint = await prisma.inboundWebhookEndpoint.findUnique({
      where: { id },
    });

    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'RESOURCE_NOT_FOUND');
    }

    const updated = await prisma.inboundWebhookEndpoint.update({
      where: { id },
      data: { isActive: true },
    });

    res.json({ success: true, data: updated });
  })
);

router.delete(
  '/endpoints/:id',
  authenticate,
  requireRole('manager', 'admin'),
  webhookAudit('DELETE_ENDPOINT', 'inbound_endpoint', (req) => req.params?.id || 'unknown'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const endpoint = await prisma.inboundWebhookEndpoint.findUnique({
      where: { id },
    });

    if (!endpoint) {
      throw new AppError('Endpoint not found', 404, 'RESOURCE_NOT_FOUND');
    }

    await prisma.inboundWebhookEndpoint.delete({
      where: { id },
    });

    res.json({ success: true, message: 'Endpoint deleted successfully' });
  })
);

router.get(
  '/deliveries',
  authenticate,
  requireRole('manager', 'admin'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);
    const endpointId = typeof req.query.endpointId === 'string' ? req.query.endpointId : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;

    const where = {
      ...(endpointId ? { endpointId } : {}),
      ...(status ? { status } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.inboundWebhookDelivery.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.inboundWebhookDelivery.count({ where }),
    ]);

    res.json({ success: true, data, pagination: { limit, offset, total } });
  })
);

router.get(
  '/audit',
  authenticate,
  requireRole('manager', 'admin'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);
    const action = typeof req.query.action === 'string' ? req.query.action : undefined;
    const resourceType = typeof req.query.resourceType === 'string' ? req.query.resourceType : undefined;

    const where = {
      ...(action ? { action } : {}),
      ...(resourceType ? { resourceType } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.webhookAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.webhookAuditLog.count({ where }),
    ]);

    res.json({ success: true, data, pagination: { limit, offset, total } });
  })
);

router.post(
  '/:urlPath',
  asyncHandler(async (req, res) => {
    const { urlPath } = req.params;
    const endpoint = await prisma.inboundWebhookEndpoint.findUnique({
      where: { urlPath },
    });

    if (!endpoint || !endpoint.isActive) {
      await createInboundAlert(
        'Inbound Webhook Rejected',
        `Unknown or inactive inbound endpoint: ${urlPath}`,
        '/settings'
      );
      throw new AppError('Inbound endpoint not found', 404, 'RESOURCE_NOT_FOUND');
    }

    const payloadString = JSON.stringify(req.body ?? {});

    if (endpoint.authMethod === 'API_KEY') {
      const apiKey = req.header('x-api-key');
      if (!endpoint.secret || !apiKey || endpoint.secret !== apiKey) {
        await prisma.inboundWebhookDelivery.create({
          data: {
            endpointId: endpoint.id,
            payload: payloadString,
            status: 'failed',
            errorMessage: 'Invalid API key',
          },
        });
        await createInboundAlert(
          'Inbound Webhook Auth Failed',
          `API key validation failed for endpoint ${endpoint.name}`,
          '/settings'
        );
        throw new AppError('Invalid API key', 401, 'AUTH_UNAUTHORIZED');
      }
    }

    if (endpoint.authMethod === 'HMAC') {
      const signature = req.header('x-signature') ?? undefined;
      if (!endpoint.secret || !verifyInboundSignature(endpoint.secret, payloadString, signature)) {
        await prisma.inboundWebhookDelivery.create({
          data: {
            endpointId: endpoint.id,
            payload: payloadString,
            status: 'failed',
            errorMessage: 'Invalid signature',
          },
        });
        await createInboundAlert(
          'Inbound Webhook Signature Failed',
          `HMAC validation failed for endpoint ${endpoint.name}`,
          '/settings'
        );
        throw new AppError('Invalid signature', 401, 'AUTH_UNAUTHORIZED');
      }
    }

    const delivery = await prisma.inboundWebhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        payload: payloadString,
        status: 'pending',
      },
    });

    await prisma.inboundWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'success',
        processedAt: new Date(),
      },
    });

    await prisma.webhookAuditLog.create({
      data: {
        userId: 'SYSTEM',
        action: 'INBOUND_ACCEPTED',
        resourceType: 'inbound_delivery',
        resourceId: delivery.id,
        changes: JSON.stringify({ endpointId: endpoint.id, urlPath }),
        sourceIp: req.ip,
      },
    });

    res.status(202).json({
      success: true,
      data: {
        endpointId: endpoint.id,
        deliveryId: delivery.id,
        status: 'accepted',
      },
    });
  })
);

export default router;
