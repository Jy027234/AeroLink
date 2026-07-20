import assert from 'node:assert/strict';
import { getOperationalAlerts, resetOperationalAlerts } from '../lib/alerting.js';
import {
  processOutboxEvent,
  processPendingOutboxEvents,
  retryOutboxEvent,
} from '../lib/outboxService.js';
import prisma from '../lib/prisma.js';

async function main() {
  if (!['1', 'true', 'yes'].includes((process.env.P2_FAULT_INJECTION ?? '').toLowerCase())) {
    throw new Error('Refusing worker fault injection without P2_FAULT_INJECTION=true');
  }

  resetOperationalAlerts();
  const createdIds: string[] = [];
  try {
    const concurrentEvent = await prisma.outboxEvent.create({
      data: {
        channel: 'SYNTHETIC_INVALID',
        eventType: 'p2.synthetic.worker.failure',
        aggregateType: 'P2_SYNTHETIC',
        aggregateId: `concurrent-${Date.now()}`,
        payload: '{}',
        maxAttempts: 1,
      },
    });
    createdIds.push(concurrentEvent.id);

    const concurrentResults = await Promise.all([
      processOutboxEvent(concurrentEvent.id, 'p2-worker-a'),
      processOutboxEvent(concurrentEvent.id, 'p2-worker-b'),
    ]);
    const failedEvent = await prisma.outboxEvent.findUnique({ where: { id: concurrentEvent.id } });
    assert.equal(concurrentResults.filter(Boolean).length, 0);
    assert.equal(concurrentResults.filter((result) => result === false).length, 2);
    assert.equal(failedEvent?.status, 'FAILED');
    assert.equal(failedEvent?.attemptCount, 1);
    assert.match(failedEvent?.lastError ?? '', /Unsupported outbox channel/);

    const replayedEvent = await retryOutboxEvent(concurrentEvent.id);
    assert.equal(replayedEvent?.status, 'PENDING');
    assert.equal(replayedEvent?.attemptCount, 0);
    await processOutboxEvent(concurrentEvent.id, 'p2-replay-worker');
    const replayFailedEvent = await prisma.outboxEvent.findUnique({ where: { id: concurrentEvent.id } });
    assert.equal(replayFailedEvent?.status, 'FAILED');

    const staleEvent = await prisma.outboxEvent.create({
      data: {
        channel: 'SYNTHETIC_INVALID',
        eventType: 'p2.synthetic.worker.stale-lease',
        aggregateType: 'P2_SYNTHETIC',
        aggregateId: `stale-${Date.now()}`,
        payload: '{}',
        status: 'PROCESSING',
        workerId: 'crashed-worker',
        lockedAt: new Date(Date.now() - 10 * 60 * 1000),
        maxAttempts: 1,
      },
    });
    createdIds.push(staleEvent.id);

    await processPendingOutboxEvents(100, 'p2-recovery-worker');
    const recoveredEvent = await prisma.outboxEvent.findUnique({ where: { id: staleEvent.id } });
    assert.equal(recoveredEvent?.status, 'FAILED');
    assert.equal(recoveredEvent?.workerId, null);
    assert.match(recoveredEvent?.lastError ?? '', /Unsupported outbox channel/);

    const alerts = getOperationalAlerts();
    assert.ok(alerts.some((alert) => alert.key === `worker.outbox.retry-exhausted.${concurrentEvent.id}`));
    assert.ok(alerts.some((alert) => alert.key === `worker.outbox.retry-exhausted.${staleEvent.id}`));

    console.log(JSON.stringify({
      status: 'PASS',
      concurrentClaim: {
        workers: 2,
        results: concurrentResults,
        finalStatus: failedEvent?.status,
        attemptCount: failedEvent?.attemptCount,
        replay: replayedEvent?.status === 'PENDING' && replayFailedEvent?.status === 'FAILED',
      },
      staleLeaseRecovery: {
        finalStatus: recoveredEvent?.status,
        workerIdReleased: recoveredEvent?.workerId === null,
      },
      alertKeys: alerts
        .filter((alert) => alert.key.includes('worker.outbox.retry-exhausted'))
        .map((alert) => alert.key),
    }));
  } finally {
    await prisma.outboxEvent.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
