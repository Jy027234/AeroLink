import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';

import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import rfqRoutes from './routes/rfqs.js';
import quotationRoutes from './routes/quotations.js';
import orderRoutes from './routes/orders.js';
import inventoryRoutes from './routes/inventory.js';
import customerRoutes from './routes/customers.js';
import supplierRoutes from './routes/suppliers.js';
import notificationRoutes from './routes/notifications.js';
import emailRoutes from './routes/emails.js';
import emailAccountRoutes from './routes/emailAccounts.js';
import emailSyncRoutes from './routes/emailSync.js';
import agentRoutes from './routes/agents.js';
import modelRoutes from './routes/models.js';
import supplierQuoteRoutes from './routes/supplierQuotes.js';
import uploadRoutes from './routes/upload.js';
import webhookRoutes from './routes/webhooks.js';
import webhooksPhase2Routes from './routes/webhooks-phase2.js';
import inboundWebhookRoutes from './routes/inboundWebhooks.js';
import documentTemplateRoutes from './routes/documentTemplates.js';
import documentRoutes from './routes/documents.js';
import ipcRoutes from './routes/ipc.js';
import certificateTemplateRoutes from './routes/certificateTemplates.js';
import certificateRoutes from './routes/certificates.js';
import workflowRoutes from './routes/workflows.js';
import auditLogRoutes from './routes/auditLogs.js';
import pricingRoutes from './routes/pricing.js';
import inventoryAnalyticsRoutes from './routes/inventoryAnalytics.js';
import auctionRoutes from './routes/auctions.js';
import consignmentRoutes from './routes/consignments.js';
import apiKeyRoutes from './routes/apiKeys.js';
import apiV1Routes from './routes/apiV1.js';
import fmvRoutes from './routes/fmv.js';
import blockchainRoutes from './routes/blockchain.js';
import aiRoutes from './routes/ai.js';
import reportsRoutes from './routes/reports.js';
import inventoryItemRoutes from './routes/inventoryItems.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authenticate } from './middleware/auth.js';
import { logger, requestLogger } from './lib/logger.js';
import { initSocketIO, SocketRooms } from './lib/socketEvents.js';
import { processPendingWebhookRetries } from './lib/webhookService.js';

const app = express();
const httpServer = createServer(app);

const defaultClientOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
];

const clientOrigins = Array.from(new Set([
  ...(process.env.CLIENT_URL?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? []),
  ...defaultClientOrigins,
]));

const io = new Server(httpServer, {
  cors: {
    origin: clientOrigins,
    methods: ['GET', 'POST'],
  },
});

initSocketIO(io);

const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet());
app.use(cors({
  origin: clientOrigins,
  credentials: true,
}));

const apiLimiter = isProduction
  ? rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 200,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === '/api/health',
    })
  : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
app.use(apiLimiter);

const authLimiter = isProduction
  ? rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      skipFailedRequests: false,
    })
  : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/refresh', authLimiter);

app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', authenticate, dashboardRoutes);
app.use('/api/rfqs', authenticate, rfqRoutes);
app.use('/api/quotations', authenticate, quotationRoutes);
app.use('/api/orders', authenticate, orderRoutes);
app.use('/api/inventory', authenticate, inventoryRoutes);
app.use('/api/customers', authenticate, customerRoutes);
app.use('/api/suppliers', authenticate, supplierRoutes);
app.use('/api/notifications', authenticate, notificationRoutes);
app.use('/api/emails', authenticate, emailRoutes);
app.use('/api/email-accounts', authenticate, emailAccountRoutes);
app.use('/api/email-sync', authenticate, emailSyncRoutes);
app.use('/api/agents', authenticate, agentRoutes);
app.use('/api/models', authenticate, modelRoutes);
app.use('/api/supplier-quotes', authenticate, supplierQuoteRoutes);
app.use('/api/upload', authenticate, uploadRoutes);
app.use('/api/webhooks', authenticate, webhookRoutes);
app.use('/api/webhooks/phase2', authenticate, webhooksPhase2Routes);
app.use('/api/inbound-webhooks', inboundWebhookRoutes);
app.use('/api/document-templates', authenticate, documentTemplateRoutes);
app.use('/api/documents', authenticate, documentRoutes);
app.use('/api/ipc', authenticate, ipcRoutes);
app.use('/api/certificate-templates', authenticate, certificateTemplateRoutes);
app.use('/api/certificates', authenticate, certificateRoutes);
app.use('/api/workflows', authenticate, workflowRoutes);
app.use('/api/audit-logs', authenticate, auditLogRoutes);
app.use('/api/pricing', authenticate, pricingRoutes);
app.use('/api/inventory-analytics', authenticate, inventoryAnalyticsRoutes);
app.use('/api/auctions', authenticate, auctionRoutes);
app.use('/api/consignments', authenticate, consignmentRoutes);
app.use('/api/api-keys', authenticate, apiKeyRoutes);
app.use('/api/v1', apiV1Routes);
app.use('/api/fmv', authenticate, fmvRoutes);
app.use('/api/blockchain', authenticate, blockchainRoutes);
app.use('/api/ai', authenticate, aiRoutes);
app.use('/api/reports', authenticate, reportsRoutes);
app.use('/api/inventory-items', authenticate, inventoryItemRoutes);
app.use('/uploads', authenticate, express.static('uploads'));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.toString().replace('Bearer ', '');
    if (!token) {
      return next(new Error('Authentication required'));
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return next(new Error('Server configuration error'));
    }
    const decoded = jwt.verify(token, secret) as { id: string; role: string };
    socket.data.user = decoded;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  logger.debug({ socketId: socket.id, userId: socket.data.user?.id }, 'Socket client connected');

  socket.on('join', (room: string) => {
    const userRole = socket.data.user?.role?.toLowerCase();
    const allowedRooms = ['dashboard', 'notifications', 'emails'];
    const roleRooms: Record<string, string[]> = {
      admin: Object.values(SocketRooms),
      manager: ['dashboard', 'rfqs', 'quotations', 'orders', 'inventory', 'notifications', 'emails'],
      sales: ['dashboard', 'rfqs', 'quotations', 'orders', 'notifications', 'emails'],
      finance: ['dashboard', 'quotations', 'orders', 'notifications'],
      gm: ['dashboard', 'rfqs', 'quotations', 'orders', 'notifications'],
      operator: ['dashboard', 'inventory', 'orders', 'notifications'],
      viewer: allowedRooms,
    };
    const userAllowed = roleRooms[userRole] || allowedRooms;
    if (!userAllowed.includes(room)) {
      logger.warn({ socketId: socket.id, userId: socket.data.user?.id, room }, 'Socket join denied');
      return;
    }
    socket.join(room);
    logger.debug({ socketId: socket.id, room }, 'Socket joined room');
  });

  socket.on('leave', (room: string) => {
    socket.leave(room);
    logger.debug({ socketId: socket.id, room }, 'Socket left room');
  });

  socket.on('disconnect', () => {
    logger.debug({ socketId: socket.id }, 'Socket client disconnected');
  });
});

const PORT = parseInt(process.env.PORT || '3000', 10);

const webhookRetryTimer = setInterval(() => {
  void processPendingWebhookRetries(30).catch((error) => {
    logger.error({ error }, 'Webhook retry worker execution failed');
  });
}, 30_000);

httpServer.listen(PORT, () => {
  logger.info(`🚀 AeroLink Server running on http://localhost:${PORT}`);
  logger.info(`📚 Health check: http://localhost:${PORT}/api/health`);
  logger.info('🔁 Webhook retry worker started (interval: 30s)');
});

function gracefulShutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gracefully...');
  clearInterval(webhookRetryTimer);
  io.close(() => {
    logger.info('Socket.IO closed');
  });
  httpServer.close(() => {
    logger.info('HTTP server closed');
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export { app, httpServer, io };
