import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma.js';
import { AuthRequest } from './auth.js';
import { logger } from '../lib/logger.js';

export type AuditActionType = 'CREATE' | 'UPDATE' | 'DELETE' | 'VIEW' | 'LOGIN' | 'LOGOUT' | 'EXPORT' | 'APPROVE' | 'REJECT';
export type AuditResourceType = 'RFQ' | 'QUOTATION' | 'ORDER' | 'INVENTORY' | 'CUSTOMER' | 'SUPPLIER' | 'CERTIFICATE' | 'SETTINGS' | 'WORKFLOW';

interface AuditLoggerOptions {
  resourceType: AuditResourceType;
  actions?: AuditActionType[];
  /** Prisma model name used to fetch old data for UPDATE diffs */
  prismaModel?: keyof typeof prisma;
  /** Function to extract resource ID from request params or body */
  getResourceId?: (req: Request) => string | undefined;
  /** Function to extract resource name from request body or params */
  getResourceName?: (req: Request) => string | undefined;
  /** Fields to ignore when computing diff */
  ignoreFields?: string[];
}

const DEFAULT_IGNORE_FIELDS = ['createdAt', 'updatedAt', 'id', 'password', 'authCode', 'secret', 'token'];

function computeDiff(before: Record<string, unknown>, after: Record<string, unknown>, ignoreFields: string[]): string | null {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    if (ignoreFields.includes(key)) continue;
    const b = before[key];
    const a = after[key];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changes[key] = { before: b, after: a };
    }
  }

  return Object.keys(changes).length > 0 ? JSON.stringify(changes) : null;
}

async function fetchOldData(modelName: keyof typeof prisma, id: string): Promise<Record<string, unknown> | null> {
  try {
    const model = prisma[modelName] as unknown as {
      findUnique: (args: { where: { id: string } }) => Promise<Record<string, unknown> | null>;
    };
    if (!model || typeof model.findUnique !== 'function') {
      return null;
    }
    return await model.findUnique({ where: { id } });
  } catch (err) {
    logger.warn({ err, modelName, id }, 'Failed to fetch old data for audit diff');
    return null;
  }
}

function getClientIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0];
  return req.ip || req.socket.remoteAddress || undefined;
}

export function auditLogger(options: AuditLoggerOptions) {
  const {
    resourceType,
    actions = ['CREATE', 'UPDATE', 'DELETE'],
    prismaModel,
    getResourceId,
    getResourceName,
    ignoreFields = DEFAULT_IGNORE_FIELDS,
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    let action: AuditActionType | undefined;

    if (method === 'POST' && actions.includes('CREATE')) action = 'CREATE';
    else if ((method === 'PUT' || method === 'PATCH') && actions.includes('UPDATE')) action = 'UPDATE';
    else if (method === 'DELETE' && actions.includes('DELETE')) action = 'DELETE';
    else if (method === 'GET' && actions.includes('VIEW')) action = 'VIEW';

    if (!action) {
      return next();
    }

    const authReq = req as AuthRequest;
    const user = authReq.user;
    const resourceId = getResourceId?.(req) || req.params.id || (req.body?.id as string) || undefined;
    const resourceName = getResourceName?.(req) || (req.body?.name as string) || (req.body?.partNumber as string) || (req.body?.quoteNumber as string) || (req.body?.orderNumber as string) || (req.body?.rfqNumber as string) || undefined;

    let oldData: Record<string, unknown> | null = null;

    // For UPDATE, fetch old data before the route handler runs
    if (action === 'UPDATE' && prismaModel && resourceId) {
      oldData = await fetchOldData(prismaModel, resourceId);
    }

    // For DELETE, fetch old data before deletion
    if (action === 'DELETE' && prismaModel && resourceId) {
      oldData = await fetchOldData(prismaModel, resourceId);
    }

    // Hook into response finish to log after the operation completes
    const originalEnd = res.end.bind(res);
    let logged = false;

    const doLog = async (statusCode: number) => {
      if (logged) return;
      logged = true;

      try {
        let changes: string | null = null;
        let details: string | null = null;
        const status = statusCode >= 200 && statusCode < 400 ? 'SUCCESS' : 'FAILURE';
        const errorMessage = status === 'FAILURE' ? `HTTP ${statusCode}` : null;

        if (action === 'UPDATE' && prismaModel && resourceId && oldData) {
          const newData = await fetchOldData(prismaModel, resourceId);
          if (newData) {
            changes = computeDiff(oldData, newData, ignoreFields);
            details = `Updated ${resourceType}`;
          }
        }

        if (action === 'CREATE') {
          details = `Created ${resourceType}`;
        }

        if (action === 'DELETE') {
          details = `Deleted ${resourceType}`;
          if (oldData) {
            changes = JSON.stringify({ deleted: oldData });
          }
        }

        await prisma.auditLog.create({
          data: {
            userId: user?.id,
            userName: user?.name,
            userRole: user?.role,
            action,
            resourceType,
            resourceId: resourceId || null,
            resourceName: resourceName || null,
            changes,
            details,
            ipAddress: getClientIp(req) || null,
            userAgent: req.headers['user-agent'] || null,
            sessionId: authReq.sessionId || null,
            status,
            errorMessage,
          },
        });
      } catch (err) {
        logger.error({ err }, 'Audit log creation failed');
      }
    };

    res.end = function (this: Response, ...args: any[]) {
      res.end = originalEnd;
      const result = originalEnd.apply(this, args as any);
      void doLog(res.statusCode);
      return result;
    };

    res.on('finish', () => {
      void doLog(res.statusCode);
    });

    next();
  };
}

/**
 * Manual audit log helper for use inside route handlers when middleware is not enough.
 */
export async function createAuditLog(payload: {
  req: Request;
  action: AuditActionType;
  resourceType: AuditResourceType;
  resourceId?: string;
  resourceName?: string;
  changes?: Record<string, { before: unknown; after: unknown }> | null;
  details?: string;
  status?: 'SUCCESS' | 'FAILURE';
  errorMessage?: string;
}) {
  const { req, action, resourceType, resourceId, resourceName, changes, details, status, errorMessage } = payload;
  const user = (req as AuthRequest).user;

  try {
    await prisma.auditLog.create({
      data: {
        userId: user?.id,
        userName: user?.name,
        userRole: user?.role,
        action,
        resourceType,
        resourceId: resourceId || null,
        resourceName: resourceName || null,
        changes: changes ? JSON.stringify(changes) : null,
        details: details || null,
        ipAddress: getClientIp(req) || null,
        userAgent: req.headers['user-agent'] || null,
        sessionId: (req as AuthRequest).sessionId || null,
        status: status || 'SUCCESS',
        errorMessage: errorMessage || null,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Manual audit log creation failed');
  }
}
