import { startWorker } from './worker.js';

function intervalFromEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const runtime = startWorker({
  webhookIntervalMs: intervalFromEnv('WORKER_WEBHOOK_INTERVAL_MS', 30_000),
  outboxIntervalMs: intervalFromEnv('WORKER_OUTBOX_INTERVAL_MS', 5_000),
  idempotencyIntervalMs: intervalFromEnv('WORKER_IDEMPOTENCY_INTERVAL_MS', 6 * 60 * 60 * 1000),
  shutdownTimeoutMs: intervalFromEnv('WORKER_SHUTDOWN_TIMEOUT_MS', 30_000),
});

async function shutdown(signal: string) {
  await runtime.stop();
  process.exitCode = 0;
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  console.info(`AeroLink worker stopped (${signal})`);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
