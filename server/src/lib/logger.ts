import type { NextFunction, Request, Response } from 'express';
import pino from 'pino';

const isDev = process.env.NODE_ENV === 'development';

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

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      req: {
        method: req.method,
        url: req.url,
        query: req.query,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      },
      res: {
        statusCode: res.statusCode,
      },
      duration: `${duration}ms`,
    }, `${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
  });

  next();
};
