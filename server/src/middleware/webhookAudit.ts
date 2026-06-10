import type { NextFunction, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { AuthRequest } from './auth.js';

type ResourceType = 'endpoint' | 'subscription' | 'delivery' | 'dlq_message' | 'inbound_endpoint' | 'inbound_delivery';

const sanitizeBody = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const clone = { ...(body as Record<string, unknown>) };
  if ('token' in clone) clone.token = '[REDACTED]';
  if ('secret' in clone) clone.secret = '[REDACTED]';
  if ('authToken' in clone) clone.authToken = '[REDACTED]';

  return JSON.stringify(clone);
};

export const webhookAudit = (
  action: string,
  resourceType: ResourceType,
  resolveResourceId?: (req: Request) => string
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      // Only persist successful operations to keep audit signal clean.
      if (res.statusCode >= 400) {
        return;
      }

      const authReq = req as AuthRequest;
      const userId = authReq.user?.id ?? 'SYSTEM';
      const resourceId = resolveResourceId?.(req) ?? req.params.id ?? req.params.batchId ?? 'unknown';

      void prisma.webhookAuditLog.create({
        data: {
          userId,
          action,
          resourceType,
          resourceId,
          changes: sanitizeBody(req.body),
          sourceIp: req.ip,
        },
      }).catch((error) => {
        logger.warn({ error, action, resourceType, resourceId }, 'Failed to write webhook audit log');
      });
    });

    next();
  };
};
