import type { NextFunction, Request, Response } from 'express';
import type { AuthRequest } from './auth.js';
import { asyncHandler, AppError } from './errorHandler.js';
import {
  type CapabilityAction,
  type CapabilityResource,
  type CapabilityResourceContext,
  hasCapability,
} from '../lib/capabilityPolicy.js';

export type CapabilityContextResolver = (
  req: AuthRequest,
) => CapabilityResourceContext | undefined | Promise<CapabilityResourceContext | undefined>;

export function assertCapability(
  actor: NonNullable<AuthRequest['user']>,
  resource: CapabilityResource,
  action: CapabilityAction,
  context?: CapabilityResourceContext,
) {
  if (!hasCapability(actor, resource, action, context)) {
    throw new AppError('权限不足，无法执行此操作', 403, 'AUTH_FORBIDDEN');
  }
}

/**
 * Enforces the same capability contract exposed by GET /api/auth/capabilities.
 * A context resolver is optional for collection routes and required when an
 * ownership or department scoped action targets a single resource.
 */
export function requireCapability(
  resource: CapabilityResource,
  action: CapabilityAction,
  resolveContext?: CapabilityContextResolver,
) {
  return asyncHandler(async (request: Request, _res: Response, next: NextFunction) => {
    const req = request as AuthRequest;
    if (!req.user) {
      throw new AppError('未授权，请先登录', 401, 'AUTH_UNAUTHORIZED');
    }

    const context = resolveContext ? await resolveContext(req) : undefined;
    assertCapability(req.user, resource, action, context);

    next();
  });
}
