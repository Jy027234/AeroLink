import crypto from 'node:crypto';
import { logger } from './lib/logger.js';
import { processPendingWebhookRetries } from './lib/webhookService.js';
import {
  processPendingOutboxEvents,
  type OutboxChannelValue,
} from './lib/outboxService.js';
import { pruneExpiredIdempotencyRecords } from './lib/idempotencyService.js';
import { processDueEmailSyncs } from './lib/inboundEmailSyncService.js';
import { expireUnassignedAllocations } from './modules/inventoryQuality/allocationExpiry.js';
import { processPendingSourcingAiTasks } from './lib/sourcingAiTaskService.js';

export interface WorkerRuntime {
  stop: () => Promise<void>;
}

export interface WorkerOptions {
  webhookIntervalMs?: number;
  outboxIntervalMs?: number;
  idempotencyIntervalMs?: number;
  emailSyncIntervalMs?: number;
  allocationExpiryIntervalMs?: number;
  sourcingAiTaskIntervalMs?: number;
  batchSize?: number;
  workerId?: string;
  shutdownTimeoutMs?: number;
  /** Channel ownership is explicit: standalone Worker defaults to EMAIL/WEBHOOK. */
  outboxChannels?: readonly OutboxChannelValue[];
  runWebhookRetries?: boolean;
  runIdempotencyCleanup?: boolean;
  runEmailSync?: boolean;
  runAllocationExpiry?: boolean;
  runSourcingAiTasks?: boolean;
}

function configuredInterval(value: number | undefined, envName: string, fallback: number) {
  if (value !== undefined && Number.isFinite(value) && value > 0) return value;
  const fromEnvironment = Number.parseInt(process.env[envName] ?? '', 10);
  return Number.isFinite(fromEnvironment) && fromEnvironment > 0 ? fromEnvironment : fallback;
}

function configuredEnabled(value: boolean | undefined, envName: string, fallback: boolean) {
  if (value !== undefined) return value;
  const fromEnvironment = process.env[envName]?.trim().toLowerCase();
  if (fromEnvironment === 'true' || fromEnvironment === '1' || fromEnvironment === 'yes') return true;
  if (fromEnvironment === 'false' || fromEnvironment === '0' || fromEnvironment === 'no') return false;
  return fallback;
}

/**
 * Starts only database-backed asynchronous work. The API entrypoint imports
 * this factory for a controlled test fixture; production runs it as a
 * separate process so HTTP lifecycle and job lifecycle can be deployed and
 * restarted independently.
 */
export function startWorker(options: WorkerOptions = {}): WorkerRuntime {
  const webhookIntervalMs = configuredInterval(options.webhookIntervalMs, 'WORKER_WEBHOOK_INTERVAL_MS', 30_000);
  const outboxIntervalMs = configuredInterval(options.outboxIntervalMs, 'WORKER_OUTBOX_INTERVAL_MS', 5_000);
  const idempotencyIntervalMs = configuredInterval(options.idempotencyIntervalMs, 'WORKER_IDEMPOTENCY_INTERVAL_MS', 6 * 60 * 60 * 1000);
  const emailSyncIntervalMs = configuredInterval(options.emailSyncIntervalMs, 'WORKER_EMAIL_SYNC_INTERVAL_MS', 30_000);
  const allocationExpiryIntervalMs = configuredInterval(options.allocationExpiryIntervalMs, 'WORKER_ALLOCATION_EXPIRY_INTERVAL_MS', 60_000);
  const sourcingAiTaskIntervalMs = configuredInterval(options.sourcingAiTaskIntervalMs, 'WORKER_SOURCING_AI_TASK_INTERVAL_MS', 5_000);
  const batchSize = options.batchSize ?? 30;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
  const workerId = options.workerId?.trim() || process.env.WORKER_ID?.trim() || `worker-${crypto.randomUUID()}`;
  const outboxChannels = options.outboxChannels ?? (['EMAIL', 'WEBHOOK'] as const satisfies readonly OutboxChannelValue[]);
  const runWebhookRetriesEnabled = options.runWebhookRetries ?? true;
  const runIdempotencyCleanupEnabled = options.runIdempotencyCleanup ?? true;
  const runEmailSyncEnabled = options.runEmailSync ?? true;
  const runAllocationExpiryEnabled = options.runAllocationExpiry ?? true;
  const runSourcingAiTasksEnabled = configuredEnabled(
    options.runSourcingAiTasks,
    'WORKER_SOURCING_AI_TASK_ENABLED',
    !outboxChannels.includes('SOCKET'),
  );
  let allocationExpiryRunning = false;
  let sourcingAiTasksRunning = false;
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  const runTask = (task: () => Promise<unknown>, label: string) => {
    if (stopped) return;
    let taskResult: Promise<unknown>;
    try {
      taskResult = task();
    } catch (error) {
      taskResult = Promise.reject(error);
    }
    const taskPromise = Promise.resolve(taskResult)
      .then(() => undefined)
      .catch((error) => {
        logger.error({ error, worker: label, workerId }, `${label} worker execution failed`);
      })
      .finally(() => {
        inFlight.delete(taskPromise);
      });
    inFlight.add(taskPromise);
  };

  const runWebhooks = () => runTask(
    () => processPendingWebhookRetries(batchSize, workerId),
    'webhook-retry',
  );
  const runOutbox = () => runTask(
    () => processPendingOutboxEvents(batchSize, workerId, { channels: outboxChannels }),
    'transactional-outbox',
  );
  const runIdempotencyCleanup = () => runTask(
    () => pruneExpiredIdempotencyRecords(),
    'idempotency-cleanup',
  );
  const runEmailSync = () => runTask(
    () => processDueEmailSyncs(Math.min(10, batchSize), workerId),
    'inbound-email-sync',
  );
  const runAllocationExpiry = () => {
    if (allocationExpiryRunning) return;
    runTask(async () => {
      allocationExpiryRunning = true;
      try { await expireUnassignedAllocations({ limit: batchSize }); }
      finally { allocationExpiryRunning = false; }
    }, 'allocation-expiry');
  };
  const runSourcingAiTasks = () => {
    if (sourcingAiTasksRunning) return;
    runTask(async () => {
      sourcingAiTasksRunning = true;
      try { await processPendingSourcingAiTasks(batchSize); }
      finally { sourcingAiTasksRunning = false; }
    }, 'sourcing-ai-task');
  };

  const webhookTimer = runWebhookRetriesEnabled ? setInterval(runWebhooks, webhookIntervalMs) : null;
  const outboxTimer = setInterval(runOutbox, outboxIntervalMs);
  const idempotencyTimer = runIdempotencyCleanupEnabled
    ? setInterval(runIdempotencyCleanup, idempotencyIntervalMs)
    : null;
  const emailSyncTimer = runEmailSyncEnabled ? setInterval(runEmailSync, emailSyncIntervalMs) : null;
  const allocationExpiryTimer = runAllocationExpiryEnabled ? setInterval(runAllocationExpiry, allocationExpiryIntervalMs) : null;
  const sourcingAiTaskTimer = runSourcingAiTasksEnabled ? setInterval(runSourcingAiTasks, sourcingAiTaskIntervalMs) : null;

  if (runWebhookRetriesEnabled) runWebhooks();
  runOutbox();
  if (runIdempotencyCleanupEnabled) runIdempotencyCleanup();
  if (runEmailSyncEnabled) runEmailSync();
  if (runAllocationExpiryEnabled) runAllocationExpiry();
  if (runSourcingAiTasksEnabled) runSourcingAiTasks();

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (webhookTimer) clearInterval(webhookTimer);
      clearInterval(outboxTimer);
      if (idempotencyTimer) clearInterval(idempotencyTimer);
      if (emailSyncTimer) clearInterval(emailSyncTimer);
      if (allocationExpiryTimer) clearInterval(allocationExpiryTimer);
      if (sourcingAiTaskTimer) clearInterval(sourcingAiTaskTimer);
      const deadline = Date.now() + Math.max(0, shutdownTimeoutMs);
      while (inFlight.size > 0 && Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        await Promise.race([
          ...inFlight,
          new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
        ]);
      }
      if (inFlight.size > 0) {
        logger.warn({ workerId, pendingTasks: inFlight.size }, 'AeroLink worker shutdown timed out; leases will recover');
      }
      logger.info({ workerId }, 'AeroLink worker timers stopped');
    },
  };
}
