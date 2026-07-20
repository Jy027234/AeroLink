import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import prisma from '../lib/prisma.js';
import { processPendingOutboxEvents } from '../lib/outboxService.js';

const CRASH_POINTS = ['before-dispatch', 'during-side-effect', 'before-finalize'] as const;
type CrashPoint = typeof CRASH_POINTS[number];
const createdEventIds: string[] = [];

function enabled(value: string | undefined) {
  return ['1', 'true', 'yes'].includes((value ?? '').toLowerCase());
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 15_000) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Worker crash probe timed out'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function runCrashPoint(point: CrashPoint) {
  const event = await prisma.outboxEvent.create({
    data: {
      channel: 'WEBHOOK',
      eventType: 'p2.synthetic.worker.crash-recovery',
      aggregateType: 'P2_CRASH_PROBE',
      aggregateId: `probe-${point}-${crypto.randomUUID()}`,
      payload: JSON.stringify({ probe: point }),
      maxAttempts: 3,
    },
  });
  createdEventIds.push(event.id);

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker-entry.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      P2_FAULT_INJECTION: 'true',
      P2_WORKER_CRASH_POINT: point,
      P2_WORKER_CRASH_DELAY_MS: '50',
      WORKER_ID: `p2-crash-${point}`,
      WORKER_OUTBOX_INTERVAL_MS: '25',
      WORKER_WEBHOOK_INTERVAL_MS: '60000',
      WORKER_IDEMPOTENCY_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const exit = await waitForExit(child);
  assert.equal(exit.code, 70, `expected injected worker exit at ${point}, got ${JSON.stringify(exit)}`);

  const claimed = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
  assert.equal(claimed?.status, 'PROCESSING', `worker did not leave a recoverable lease at ${point}`);
  await prisma.outboxEvent.update({
    where: { id: event.id },
    data: { lockedAt: new Date(Date.now() - 10 * 60 * 1000) },
  });

  await processPendingOutboxEvents(10, `p2-recovery-${point}`);
  const recovered = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
  assert.equal(recovered?.status, 'DELIVERED', `recovery did not deliver ${point}`);
  assert.equal(recovered?.workerId, null);
  assert.equal(recovered?.lockedAt, null);

  return {
    point,
    childExitCode: exit.code,
    attemptsAfterRecovery: recovered?.attemptCount,
    status: recovered?.status,
    workerIdReleased: recovered?.workerId === null,
  };
}

async function main() {
  if (!enabled(process.env.P2_FAULT_INJECTION)) {
    throw new Error('Refusing worker crash recovery check without P2_FAULT_INJECTION=true');
  }
  // The parent process must remain a recovery worker, not another injected
  // crash victim. The child receives the point-specific environment above.
  delete process.env.P2_WORKER_CRASH_POINT;

  const results = [];
  try {
    for (const point of CRASH_POINTS) results.push(await runCrashPoint(point));
    console.log(JSON.stringify({ status: 'PASS', crashPoints: results }));
  } finally {
    await prisma.webhookDelivery.deleteMany({ where: { outboxEventId: { in: createdEventIds } } });
    await prisma.outboxEvent.deleteMany({ where: { id: { in: createdEventIds } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
