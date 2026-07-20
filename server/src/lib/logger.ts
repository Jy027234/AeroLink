import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import pino from 'pino';
import { recordHttpRequest } from './metrics.js';
import { runWithRequestContext } from './requestContext.js';
import { beginTraceSpan, configureTraceExporterFromEnvironment } from './trace.js';

const isDev = process.env.NODE_ENV === 'development';

configureTraceExporterFromEnvironment();

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    env: process.env.NODE_ENV || 'development',
    service: 'aerolink-api',
  },
});

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const suppliedRequestId = req.get('x-request-id');
  const requestId = suppliedRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : crypto.randomUUID();
  const suppliedTraceId = req.get('x-trace-id');
  const traceId = suppliedTraceId && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedTraceId)
    ? suppliedTraceId
    : crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Trace-Id', traceId);
  const requestSpan = runWithRequestContext(
    requestId,
    () => beginTraceSpan('http.request', { method: req.method, path: req.path }),
    traceId,
  );

  const safeQuery = Object.fromEntries(Object.entries(req.query).map(([key, value]) => {
    if (/token|password|secret|cookie|authorization|signature/i.test(key)) return [key, '[REDACTED]'];
    return [key, value];
  }));

  res.on('finish', () => {
    const duration = Date.now() - start;
    recordHttpRequest(res.statusCode, duration);
    logger.info({
      requestId,
      traceId,
      req: {
        method: req.method,
        path: req.path,
        query: safeQuery,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      },
      res: {
        statusCode: res.statusCode,
      },
      durationMs: duration,
    }, `${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
    requestSpan.end(res.statusCode >= 500 ? 'error' : 'ok', { statusCode: res.statusCode });
  });

  runWithRequestContext(requestId, next, traceId);
};
