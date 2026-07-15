import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.js';
import { AppError } from './errorHandler.js';

export type Role = 'admin' | 'administrator' | 'manager' | 'finance' | 'sales' | 'gm' | 'operator' | 'viewer';

const roleHierarchy: Record<string, number> = {
  viewer: 1,
  operator: 2,
  sales: 2,
  finance: 3,
  manager: 4,
  gm: 5,
  admin: 6,
  administrator: 6,
};

export const requireRole = (...allowedRoles: Role[]) => {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new AppError('未授权，请先登录', 401);
    }

    const userRole = req.user.role.toLowerCase() as Role;
    const userLevel = roleHierarchy[userRole] || 0;
    const minRequiredLevel = Math.min(...allowedRoles.map((r) => roleHierarchy[r] || 0));

    if (userLevel < minRequiredLevel) {
      throw new AppError('权限不足，无法执行此操作', 403, 'AUTH_FORBIDDEN');
    }

    next();
  };
};

export const requireExactRole = (...allowedRoles: Role[]) => {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new AppError('未授权，请先登录', 401);
    }

    const userRole = req.user.role.toLowerCase() as Role;

    if (!allowedRoles.includes(userRole)) {
      throw new AppError('权限不足，无法执行此操作', 403, 'AUTH_FORBIDDEN');
    }

    next();
  };
};
