import { afterEach, describe, expect, it, vi } from 'vitest';

const processPendingWebhookRetries = vi.fn(async () => 0);
const processPendingOutboxEvents = vi.fn(async () => ({ processed: 0, delivered: 0 }));
const pruneExpiredIdempotencyRecords = vi.fn(async () => undefined);
const processDueEmailSyncs = vi.fn(async () => ({ processed: 0, succeeded: 0, failed: 0 }));

vi.mock('./lib/webhookService.js', () => ({ processPendingWebhookRetries }));
vi.mock('./lib/outboxService.js', () => ({ processPendingOutboxEvents }));
vi.mock('./lib/idempotencyService.js', () => ({ pruneExpiredIdempotencyRecords }));
vi.mock('./lib/inboundEmailSyncService.js', () => ({ processDueEmailSyncs }));

describe('standalone worker lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('runs each queue once immediately, repeats on schedule and releases timers on stop', async () => {
    vi.useFakeTimers();
    const { startWorker } = await import('./worker.js');
    const runtime = startWorker({
      webhookIntervalMs: 100,
      outboxIntervalMs: 200,
      idempotencyIntervalMs: 500,
      emailSyncIntervalMs: 250,
      batchSize: 7,
    });

    expect(processPendingWebhookRetries).toHaveBeenCalledWith(7, expect.stringMatching(/^worker-/));
    expect(processPendingOutboxEvents).toHaveBeenCalledWith(7, expect.stringMatching(/^worker-/));
    expect(pruneExpiredIdempotencyRecords).toHaveBeenCalledTimes(1);
    expect(processDueEmailSyncs).toHaveBeenCalledWith(7, expect.stringMatching(/^worker-/));

    await vi.advanceTimersByTimeAsync(500);
    expect(processPendingWebhookRetries).toHaveBeenCalledTimes(6);
    expect(processPendingOutboxEvents).toHaveBeenCalledTimes(3);
    expect(pruneExpiredIdempotencyRecords).toHaveBeenCalledTimes(2);
    expect(processDueEmailSyncs).toHaveBeenCalledTimes(3);

    await runtime.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(processPendingWebhookRetries).toHaveBeenCalledTimes(6);
    expect(processPendingOutboxEvents).toHaveBeenCalledTimes(3);
    expect(pruneExpiredIdempotencyRecords).toHaveBeenCalledTimes(2);
    expect(processDueEmailSyncs).toHaveBeenCalledTimes(3);
  });

  it('waits for in-flight work during graceful stop', async () => {
    vi.useFakeTimers();
    let release!: (value: number) => void;
    const pending = new Promise<number>((resolve) => {
      release = resolve;
    });
    processPendingWebhookRetries.mockImplementationOnce(() => pending);
    const { startWorker } = await import('./worker.js');
    const runtime = startWorker({
      webhookIntervalMs: 1_000,
      outboxIntervalMs: 1_000,
      idempotencyIntervalMs: 1_000,
      emailSyncIntervalMs: 1_000,
      shutdownTimeoutMs: 5_000,
    });

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(1);
    await stopping;
    expect(stopped).toBe(true);
  });
});
