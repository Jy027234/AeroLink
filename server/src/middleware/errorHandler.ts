import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger.js';

export type ErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_UNAUTHORIZED'
  | 'AUTH_FORBIDDEN'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_TOO_MANY_ATTEMPTS'
  | 'VALIDATION_ERROR'
  | 'RESOURCE_NOT_FOUND'
  | 'RESOURCE_CONFLICT'
  | 'INVALID_STATE_TRANSITION'
  | 'INTERNAL_ERROR'
  | 'RATE_LIMIT'
  | 'BAD_REQUEST';

export class AppError extends Error {
  statusCode: number;
  code: ErrorCode;
  isOperational: boolean;
  details?: Record<string, string[]>;

  constructor(message: string, statusCode: number, code?: ErrorCode, details?: Record<string, string[]>) {
    super(message);
    this.statusCode = statusCode;
    this.code = code || 'BAD_REQUEST';
    this.isOperational = true;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error | AppError,
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  void next;
  if (err instanceof ZodError) {
    const details: Record<string, string[]> = {};
    err.errors.forEach((e) => {
      const path = e.path.join('.');
      if (!details[path]) details[path] = [];
      details[path].push(e.message);
    });

    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: '请求参数校验失败',
      details,
    });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.details && { details: err.details }),
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const codeMap: Record<string, { status: number; code: ErrorCode; message: string }> = {
      P2002: { status: 409, code: 'RESOURCE_CONFLICT', message: '记录已存在' },
      P2025: { status: 404, code: 'RESOURCE_NOT_FOUND', message: '记录不存在' },
      P2003: { status: 400, code: 'BAD_REQUEST', message: '外键约束失败' },
      P2014: { status: 400, code: 'BAD_REQUEST', message: '关联关系错误' },
    };
    const mapped = codeMap[(err as Prisma.PrismaClientKnownRequestError).code];
    if (mapped) {
      return res.status(mapped.status).json({
        success: false,
        code: mapped.code,
        message: mapped.message,
      });
    }
  }

  logger.error({ err }, 'Unexpected error');

  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: '服务器内部错误，请稍后重试',
  });
};

export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (!res.headersSent) {
        next(err);
      } else {
        logger.error({ err }, 'Error after response sent');
      }
    });
  };
};
