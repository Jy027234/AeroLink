import crypto from 'node:crypto';
import { logger } from './lib/logger.js';
import { processPendingWebhookRetries } from './lib/webhookService.js';
import { processPendingOutboxEvents } from './lib/outboxService.js';
import { pruneExpiredIdempotencyRecords } from './lib/idempotencyService.js';
import { processDueEmailSyncs } from './lib/inboundEmailSyncService.js';

export interface WorkerRuntime {
  stop: () => Promise<void>;
}

export interface WorkerOptions {
  webhookIntervalMs?: number;
  outboxIntervalMs?: number;
  idempotencyIntervalMs?: number;
  emailSyncIntervalMs?: number;
  batchSize?: number;
  workerId?: string;
  shutdownTimeoutMs?: number;
}

/**
 * Starts only database-backed asynchronous work. The API entrypoint imports
 * this factory for a controlled test fixture; production runs it as a
 * separate process so HTTP lifecycle and job lifecycle can be deployed and
 * restarted independently.
 */
export function startWorker(options: WorkerOptions = {}): WorkerRuntime {
  const webhookIntervalMs = options.webhookIntervalMs ?? 30_000;
  const outboxIntervalMs = options.outboxIntervalMs ?? 5_000;
  const idempotencyIntervalMs = options.idempotencyIntervalMs ?? 6 * 60 * 60 * 1000;
  const emailSyncIntervalMs = options.emailSyncIntervalMs ?? 30_000;
  const batchSize = options.batchSize ?? 30;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
  const workerId = options.workerId?.trim() || process.env.WORKER_ID?.trim() || `worker-${crypto.randomUUID()}`;
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
    () => processPendingOutboxEvents(batchSize, workerId),
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

  const webhookTimer = setInterval(runWebhooks, webhookIntervalMs);
  const outboxTimer = setInterval(runOutbox, outboxIntervalMs);
  const idempotencyTimer = setInterval(runIdempotencyCleanup, idempotencyIntervalMs);
  const emailSyncTimer = setInterval(runEmailSync, emailSyncIntervalMs);

  runWebhooks();
  runOutbox();
  runIdempotencyCleanup();
  runEmailSync();

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(webhookTimer);
      clearInterval(outboxTimer);
      clearInterval(idempotencyTimer);
      clearInterval(emailSyncTimer);
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
