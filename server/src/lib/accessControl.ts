import type { AuthRequest } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';

const PRIVILEGED_ROLES = new Set(['admin', 'administrator', 'gm']);

export function isPrivilegedRole(role?: string | null) {
  return Boolean(role && PRIVILEGED_ROLES.has(role.toLowerCase()));
}

export function requirePrivilegedRole(req: AuthRequest, message = '无权操作，仅管理员或总经理可执行此操作') {
  if (!isPrivilegedRole(req.user?.role)) {
    throw new AppError(message, 403, 'AUTH_FORBIDDEN');
  }
}
