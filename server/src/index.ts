import dotenv from 'dotenv';
dotenv.config();

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { createServer } from 'http';
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
import usersRoutes from './routes/users.js';
import supplierQuoteRoutes from './routes/supplierQuotes.js';
import uploadRoutes from './routes/upload.js';
import filesRoutes from './routes/files.js';
import { legacyUploadsMiddleware } from './routes/legacyUploads.js';
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
import pricingBIRoutes from './routes/pricingBI.js';
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
import inventoryTransactionRoutes from './routes/inventoryTransactions.js';
import inventoryAllocationRoutes from './routes/inventoryAllocations.js';
import shipmentRoutes from './routes/shipments.js';
import purchaseCommitmentRoutes from './routes/purchaseCommitments.js';
import stockReceiptRoutes from './routes/stockReceipts.js';
import directShipmentRoutes from './routes/directShipments.js';
import settlementRoutes from './routes/settlements.js';
import shipmentTrackingRoutes from './routes/shipmentTracking.js';
import inquiryRoutes from './routes/inquiries.js';
import exchangeVmiRoutes from './routes/exchangeVmi.js';
import notificationPreferenceRoutes from './routes/notificationPreferences.js';
import channelBindingRoutes from './routes/channelBindings.js';
import pushRoutes from './routes/push.js';
import outboxRoutes from './routes/outbox.js';
import featureRoutes from './routes/features.js';
import { errorHandler } from './middleware/errorHandler.js';
import {
  authenticate,
  resolveCurrentAuthIdentity,
  type CurrentAuthIdentity,
} from './middleware/auth.js';
import { createRefreshRateLimiters } from './middleware/refreshRateLimit.js';
import { auditLogger } from './middleware/auditLogger.js';
import { requireCapability } from './middleware/capability.js';
import { logger, requestLogger } from './lib/logger.js';
import { getMetricsWithAlerts } from './lib/metrics.js';
import {
  initSocketIO,
  registerSocketSession,
  startSocketSessionRevalidation,
  stopSocketSessionRevalidation,
  unregisterSocketSession,
} from './lib/socketEvents.js';
import { API_OUTBOX_CHANNELS } from './lib/outboxService.js';
import { startWorker, type WorkerRuntime } from './worker.js';

const app = express();
const httpServer = createServer(app);
const isProduction = process.env.NODE_ENV === 'production';

const defaultClientOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
];

const configuredClientOrigins = process.env.CLIENT_URL
  ?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean) ?? [];
const clientOrigins = isProduction
  ? Array.from(new Set(configuredClientOrigins))
  : Array.from(new Set([...configuredClientOrigins, ...defaultClientOrigins]));

const io = new Server(httpServer, {
  cors: {
    origin: clientOrigins,
    methods: ['GET', 'POST'],
  },
});

initSocketIO(io);

if (isProduction) {
  app.set('trust proxy', 1);
}

app.use(helmet());
app.use(cors({
  origin: clientOrigins,
  credentials: true,
}));

function readRateLimitInteger(names: string[], fallback: number, minimum: number, maximum: number) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return Math.min(maximum, Math.max(minimum, parsed));
  }
  return fallback;
}

const loginRateLimitWindowMs = readRateLimitInteger(
  ['LOGIN_RATE_LIMIT_WINDOW_MS', 'AUTH_LOGIN_RATE_LIMIT_WINDOW_MS'],
  15 * 60 * 1000,
  1_000,
  24 * 60 * 60 * 1000,
);
const refreshRateLimitWindowMs = readRateLimitInteger(
  ['REFRESH_RATE_LIMIT_WINDOW_MS', 'AUTH_REFRESH_RATE_LIMIT_WINDOW_MS'],
  15 * 60 * 1000,
  1_000,
  24 * 60 * 60 * 1000,
);
const loginRateLimit = readRateLimitInteger(
  ['LOGIN_RATE_LIMIT', 'AUTH_LOGIN_RATE_LIMIT'],
  10,
  1,
  10_000,
);
const refreshRateLimit = readRateLimitInteger(
  ['REFRESH_RATE_LIMIT', 'AUTH_REFRESH_RATE_LIMIT'],
  30,
  1,
  10_000,
);
const passThroughRateLimiter = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

// Login remains source-address limited.  Refresh first validates the current
// user/session and consumes an independent identity bucket; only failed or
// unverified refresh attempts use the source-address abuse bucket.  Authenticated
// business requests are limited after current user/session validation in
// middleware/auth.ts.
const loginLimiter = isProduction
  ? rateLimit({
      windowMs: loginRateLimitWindowMs,
      limit: loginRateLimit,
      standardHeaders: true,
      legacyHeaders: false,
      skipFailedRequests: false,
    })
  : passThroughRateLimiter;
const {
  validatedIdentityLimiter: validatedRefreshRateLimiter,
  ipLimiter: refreshLimiter,
} = createRefreshRateLimiters({
  production: isProduction,
  windowMs: refreshRateLimitWindowMs,
  limit: refreshRateLimit,
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/refresh', validatedRefreshRateLimiter, refreshLimiter);

app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', authenticate, dashboardRoutes);
app.use('/api/rfqs', authenticate, auditLogger({ resourceType: 'RFQ', prismaModel: 'rFQ' }), rfqRoutes);
app.use('/api/quotations', authenticate, auditLogger({ resourceType: 'QUOTATION', prismaModel: 'quotation' }), quotationRoutes);
app.use('/api/orders', authenticate, auditLogger({ resourceType: 'ORDER', prismaModel: 'order' }), orderRoutes);
app.use('/api/inventory', authenticate, auditLogger({ resourceType: 'INVENTORY', prismaModel: 'inventoryDetail' }), inventoryRoutes);
app.use('/api/customers', authenticate, auditLogger({ resourceType: 'CUSTOMER', prismaModel: 'customer' }), customerRoutes);
app.use('/api/suppliers', authenticate, auditLogger({ resourceType: 'SUPPLIER', prismaModel: 'supplier' }), supplierRoutes);
app.use('/api/notifications', authenticate, notificationRoutes);
app.use('/api/emails', authenticate, emailRoutes);
app.use('/api/email-accounts', authenticate, emailAccountRoutes);
app.use('/api/email-sync', authenticate, emailSyncRoutes);
app.use('/api/agents', authenticate, agentRoutes);
app.use('/api/models', authenticate, modelRoutes);
app.use('/api/users', authenticate, auditLogger({ resourceType: 'SETTINGS', actions: ['CREATE', 'UPDATE', 'DELETE'] }), usersRoutes);
app.use('/api/supplier-quotes', authenticate, auditLogger({ resourceType: 'QUOTATION', actions: ['CREATE', 'UPDATE', 'DELETE'] }), supplierQuoteRoutes);
app.use('/api/upload', authenticate, uploadRoutes);
app.use('/api/files', authenticate, filesRoutes);
app.use('/api/webhooks', authenticate, webhookRoutes);
app.use('/api/webhooks/phase2', authenticate, webhooksPhase2Routes);
app.use('/api/inbound-webhooks', inboundWebhookRoutes);
app.use('/api/document-templates', authenticate, auditLogger({ resourceType: 'CERTIFICATE', actions: ['CREATE', 'UPDATE', 'DELETE'] }), documentTemplateRoutes);
app.use('/api/documents', authenticate, auditLogger({ resourceType: 'CERTIFICATE', actions: ['CREATE', 'UPDATE', 'DELETE'] }), documentRoutes);
app.use('/api/ipc', authenticate, ipcRoutes);
app.use('/api/certificate-templates', authenticate, auditLogger({ resourceType: 'CERTIFICATE', actions: ['CREATE', 'UPDATE', 'DELETE'] }), certificateTemplateRoutes);
app.use('/api/certificates', authenticate, auditLogger({ resourceType: 'CERTIFICATE', prismaModel: 'certificate' }), certificateRoutes);
app.use('/api/workflows', authenticate, auditLogger({ resourceType: 'WORKFLOW', actions: ['CREATE', 'UPDATE', 'DELETE'] }), workflowRoutes);
app.use('/api/audit-logs', authenticate, auditLogRoutes);
app.use('/api/pricing', authenticate, auditLogger({ resourceType: 'QUOTATION', actions: ['CREATE', 'UPDATE', 'DELETE'] }), pricingRoutes);
app.use('/api/pricing-bi', authenticate, pricingBIRoutes);
app.use('/api/inventory-analytics', authenticate, inventoryAnalyticsRoutes);
app.use('/api/auctions', authenticate, auditLogger({ resourceType: 'ORDER', actions: ['CREATE', 'UPDATE', 'DELETE'] }), auctionRoutes);
app.use('/api/consignments', authenticate, auditLogger({ resourceType: 'INVENTORY', actions: ['CREATE', 'UPDATE', 'DELETE'] }), consignmentRoutes);
app.use('/api/api-keys', authenticate, auditLogger({ resourceType: 'SETTINGS', actions: ['CREATE', 'UPDATE', 'DELETE'] }), apiKeyRoutes);
app.use('/api/v1', apiV1Routes);
app.use('/api/fmv', authenticate, fmvRoutes);
app.use('/api/blockchain', authenticate, blockchainRoutes);
app.use('/api/ai', authenticate, aiRoutes);
app.use('/api/reports', authenticate, reportsRoutes);
app.use('/api/inventory-items', authenticate, auditLogger({ resourceType: 'INVENTORY', actions: ['CREATE', 'UPDATE', 'DELETE'] }), inventoryItemRoutes);
app.use('/api/inventory-transactions', authenticate, auditLogger({ resourceType: 'INVENTORY', actions: ['CREATE', 'UPDATE', 'DELETE'] }), inventoryTransactionRoutes);
app.use('/api/inventory-allocations', authenticate, auditLogger({ resourceType: 'INVENTORY', actions: ['CREATE', 'UPDATE', 'DELETE'] }), inventoryAllocationRoutes);
app.use('/api/shipments', authenticate, auditLogger({ resourceType: 'ORDER', actions: ['CREATE', 'UPDATE', 'DELETE'] }), shipmentRoutes);
app.use('/api/purchase-commitments', authenticate, auditLogger({ resourceType: 'PURCHASE_COMMITMENT', actions: ['CREATE', 'UPDATE', 'DELETE'] }), purchaseCommitmentRoutes);
app.use('/api/stock-receipts', authenticate, auditLogger({ resourceType: 'STOCK_RECEIPT', actions: ['CREATE', 'UPDATE', 'DELETE'] }), stockReceiptRoutes);
app.use('/api/direct-shipments', authenticate, auditLogger({ resourceType: 'SUPPLIER_DIRECT_SHIPMENT', actions: ['CREATE', 'UPDATE', 'DELETE'] }), directShipmentRoutes);
app.use('/api/settlements', authenticate, auditLogger({ resourceType: 'SETTLEMENT', actions: ['CREATE', 'UPDATE', 'DELETE'] }), settlementRoutes);
app.use('/api/shipment-tracking', authenticate, auditLogger({ resourceType: 'ORDER', actions: ['CREATE', 'UPDATE', 'DELETE'] }), shipmentTrackingRoutes);
app.use('/api/inquiries', authenticate, auditLogger({ resourceType: 'RFQ', actions: ['CREATE', 'UPDATE', 'DELETE'] }), inquiryRoutes);
app.use('/api/exchange-vmi', authenticate, auditLogger({ resourceType: 'INVENTORY', actions: ['CREATE', 'UPDATE', 'DELETE'] }), exchangeVmiRoutes);
app.use('/api/notification-preferences', authenticate, notificationPreferenceRoutes);
app.use('/api/channel-bindings', authenticate, channelBindingRoutes);
app.use('/api/push', authenticate, pushRoutes);
app.use('/api/outbox', authenticate, auditLogger({ resourceType: 'SETTINGS', actions: ['UPDATE'] }), outboxRoutes);
app.use('/api/features', authenticate, featureRoutes);
app.use('/uploads', authenticate, legacyUploadsMiddleware);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/metrics', authenticate, requireCapability('settings', 'read'), (_req, res) => {
  res.json({ success: true, data: getMetricsWithAlerts() });
});

app.use(errorHandler);

io.use(async (socket, next) => {
  try {
    const authToken = socket.handshake.auth?.token;
    const authorization = socket.handshake.headers?.authorization?.toString();
    const token = typeof authToken === 'string' && authToken.trim()
      ? authToken.trim()
      : authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    const identity = await resolveCurrentAuthIdentity(token);
    socket.data.authIdentity = identity;
    next();
  } catch {
    next(new Error('Invalid current session'));
  }
});

io.on('connection', (socket) => {
  const identity = socket.data.authIdentity as CurrentAuthIdentity | undefined;
  if (!identity) {
    socket.disconnect(true);
    return;
  }
  registerSocketSession(socket, identity);
  logger.debug({ socketId: socket.id, userId: identity.id }, 'Socket client connected to server-managed user room');

  socket.on('disconnect', () => {
    unregisterSocketSession(socket);
    logger.debug({ socketId: socket.id }, 'Socket client disconnected');
  });
});

startSocketSessionRevalidation();

const PORT = parseInt(process.env.PORT || '3000', 10);
const isMainModule = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

// Production is intentionally single API + Worker.  The API process owns only
// SOCKET outbox leases; the standalone worker defaults to EMAIL/WEBHOOK.  A
// multi-API deployment would need a shared Socket.IO adapter or event cursor.
const inlineWorker: WorkerRuntime | null = isMainModule && process.env.SOCKET_OUTBOX_CONSUMER !== 'false'
  ? startWorker({
      workerId: process.env.API_SOCKET_WORKER_ID?.trim() || `api-socket-${process.pid}`,
      outboxChannels: API_OUTBOX_CHANNELS,
      runWebhookRetries: false,
      runIdempotencyCleanup: false,
      runEmailSync: false,
      runAllocationExpiry: false,
    })
  : null;

if (isMainModule) {
  httpServer.listen(PORT, () => {
    logger.info(`🚀 AeroLink Server running on http://localhost:${PORT}`);
    logger.info(`📚 Health check: http://localhost:${PORT}/api/health`);
    logger.info(inlineWorker ? '🔁 API Socket outbox consumer enabled (single-API topology)' : '🔁 Socket outbox consumer disabled');
  });
}

function gracefulShutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gracefully...');
  stopSocketSessionRevalidation();
  void inlineWorker?.stop();
  io.close(() => {
    logger.info('Socket.IO closed');
  });
  httpServer.close(() => {
    logger.info('HTTP server closed');
  });
}

if (isMainModule) {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

export { app, httpServer, io };
