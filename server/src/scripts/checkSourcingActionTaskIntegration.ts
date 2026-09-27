import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';

const DATABASE_HOST = '127.0.0.1';
const DATABASE_PORT = 55433;
const DATABASE_NAME = 'sq07_sourcing_actiontask_it';
const DATABASE_USER = 'postgres';
const DATABASE_PASSWORD = 'sq07_sourcing_it_only';
const CONFIRMATION = 'isolated';

type JsonRecord = Record<string, unknown>;
type HttpResult = { status: number; body: JsonRecord };
type Fixture = {
  supplierId: string;
  rfqId: string;
  rfqLineId: string;
  inquiryId: string;
  inquiryItemId: string;
};

function assertIsolatedDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required; refusing an implicit or dotenv database');

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname !== DATABASE_HOST
    || Number(url.port) !== DATABASE_PORT
    || decodeURIComponent(url.pathname.replace(/^\/+/, '')) !== DATABASE_NAME
    || decodeURIComponent(url.username) !== DATABASE_USER
    || decodeURIComponent(url.password) !== DATABASE_PASSWORD) {
    throw new Error(`DATABASE_URL must point only to ${DATABASE_USER}@${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}`);
  }
  if (process.env.SOURCING_ACTION_TASK_INTEGRATION_CONFIRM !== CONFIRMATION) {
    throw new Error('Set SOURCING_ACTION_TASK_INTEGRATION_CONFIRM=isolated to authorize this one-time isolated database run');
  }
}

function expectStatus(result: HttpResult, expected: number, label: string) {
  assert.equal(result.status, expected, `${label}: HTTP ${result.status}, expected ${expected}: ${JSON.stringify(result.body)}`);
}

function responseData(result: HttpResult, label: string): JsonRecord {
  assert(result.status >= 200 && result.status < 300, `${label}: HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.success, true, `${label}: response was not successful`);
  assert(result.body.data && typeof result.body.data === 'object', `${label}: response has no data`);
  return result.body.data as JsonRecord;
}

async function main() {
  assertIsolatedDatabase();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = `sq07-it-access-${randomUUID()}`;
  process.env.JWT_REFRESH_SECRET = `sq07-it-refresh-${randomUUID()}`;
  process.env.AUTHENTICATED_REQUEST_RATE_LIMIT_ENABLED = 'false';

  const [{ default: prisma }, auth, errors, taskRoutes] = await Promise.all([
    import('../lib/prisma.js'),
    import('../middleware/auth.js'),
    import('../middleware/errorHandler.js'),
    import('../routes/sourcingActionTasks.js'),
  ]);

  const runTag = randomUUID().replaceAll('-', '').slice(0, 12);
  const checks: string[] = [];
  let server: ReturnType<express.Express['listen']> | undefined;

  try {
    const actor = await prisma.user.create({
      data: {
        name: `SQ-07 acceptance sales ${runTag}`,
        email: `sq07-sales-${runTag}@example.test`,
        password: 'isolated-acceptance-only',
        role: 'SALES',
        department: `SQ07-${runTag}`,
      },
    });
    const outsider = await prisma.user.create({
      data: {
        name: `SQ-07 acceptance outsider ${runTag}`,
        email: `sq07-outsider-${runTag}@example.test`,
        password: 'isolated-acceptance-only',
        role: 'SALES',
        department: `OTHER-${runTag}`,
      },
    });
    const outsiderToken = auth.generateTokens(outsider).accessToken;
    const actorToken = auth.generateTokens(actor).accessToken;

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/sourcing-action-tasks', auth.authenticate, taskRoutes.default);
    app.use(errors.errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    async function call(token: string, method: 'GET' | 'POST', path: string, body?: JsonRecord): Promise<HttpResult> {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      let parsed: unknown = {};
      try { parsed = text ? JSON.parse(text) as unknown : {}; } catch { parsed = { raw: text }; }
      return { status: response.status, body: parsed && typeof parsed === 'object' ? parsed as JsonRecord : {} };
    }

    async function createFixture(label: string): Promise<Fixture> {
      const customer = await prisma.customer.create({
        data: {
          name: `SQ-07 ${label} customer ${runTag}`,
          contactName: `Buyer ${runTag}`,
          email: `buyer-${label}-${runTag}@example.test`,
        },
      });
      const supplier = await prisma.supplier.create({
        data: {
          name: `SQ-07 ${label} supplier ${runTag}`,
          email: `supplier-${label}-${runTag}@example.test`,
        },
      });
      const requiredDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const rfq = await prisma.rFQ.create({
        data: {
          rfqNumber: `SQ07-${runTag}-${label}`,
          customerId: customer.id,
          partNumber: `PN-${runTag}`,
          quantity: 4,
          uom: 'EA',
          requiredDate,
          status: 'QUOTING',
          createdBy: actor.id,
          lines: {
            create: [{
              lineNo: 1,
              partNumber: `PN-${runTag}`,
              quantity: 4,
              uom: 'EA',
              conditionCode: 'NE',
              requiredDate,
              certificateRequired: true,
              status: 'OPEN',
            }],
          },
        },
        include: { lines: true },
      });
      const line = rfq.lines[0];
      const inquiry = await prisma.inquiry.create({
        data: {
          inquiryNumber: `SQ07-INQ-${runTag}-${label}`,
          supplierId: supplier.id,
          rfqId: rfq.id,
          status: 'DRAFT',
          notes: `SQ-07 isolated ${label}`,
          items: {
            create: [{
              lineNo: 1,
              rfqLineId: line.id,
              partNumber: line.partNumber,
              quantity: line.quantity,
              requiredDate,
              certificateRequired: true,
            }],
          },
        },
        include: { items: true },
      });
      return {
        supplierId: supplier.id,
        rfqId: rfq.id,
        rfqLineId: line.id,
        inquiryId: inquiry.id,
        inquiryItemId: inquiry.items[0].id,
      };
    }

    async function createQuote(fixture: Fixture, label: string) {
      return prisma.supplierQuote.create({
        data: {
          inquiryId: fixture.inquiryId,
          inquiryItemId: fixture.inquiryItemId,
          rfqId: fixture.rfqId,
          rfqLineId: fixture.rfqLineId,
          supplierId: fixture.supplierId,
          partNumber: `PN-${runTag}`,
          quantity: 4,
          quantityUnit: 'EA',
          unitPrice: 125.5,
          totalPrice: 502,
          currency: 'USD',
          currencyReviewStatus: 'VERIFIED',
          leadTimeDays: 10,
          validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: 'pending',
          statusEnum: 'pending',
          notes: `SQ-07 isolated ${label}`,
        },
      });
    }

    const createActionTask = (token: string, body: JsonRecord) => call(token, 'POST', '/api/sourcing-action-tasks', body);
    const confirmTask = (token: string, taskId: string, expectedVersion: number) =>
      call(token, 'POST', `/api/sourcing-action-tasks/${encodeURIComponent(taskId)}/confirm`, { expectedVersion });

    // This database is a disposable isolated acceptance database. Previous
    // successful invocations intentionally retain their tagged fixture rows;
    // make this run's account the only eligible default without deleting data.
    await prisma.emailAccount.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const account = await prisma.emailAccount.create({
      data: {
        email: `sq07-${runTag}@example.test`,
        displayName: 'SQ-07 isolated enqueue fixture',
        imapServer: '127.0.0.1',
        imapPort: '11143',
        smtpServer: '127.0.0.1',
        smtpPort: '11025',
        authCode: 'unused-acceptance-fixture',
        accountType: 'CUSTOM',
        isActive: true,
        isDefault: true,
      },
    });

    const sendFixture = await createFixture('send');
    const stagedContent = {
      subject: `SQ-07 reviewed ${runTag}`,
      textBody: `Exact human reviewed body ${runTag}\nLine 2 is retained.`,
    };
    const stageSend = await createActionTask(actorToken, {
      action: 'SEND_INQUIRY',
      targetId: sendFixture.inquiryId,
      content: stagedContent,
      idempotencyKey: `sq07-${runTag}-send-idempotent`,
    });
    expectStatus(stageSend, 201, 'stage SEND_INQUIRY');
    const sendTask = responseData(stageSend, 'stage SEND_INQUIRY');
    assert.equal(sendTask.status, 'WAITING_HUMAN');
    assert.equal(sendTask.version, 1);
    assert.deepEqual(sendTask.contentSnapshot, stagedContent, 'staged exact message content was not returned');
    const duplicateStage = await createActionTask(actorToken, {
      action: 'SEND_INQUIRY',
      targetId: sendFixture.inquiryId,
      content: stagedContent,
      idempotencyKey: `sq07-${runTag}-send-idempotent`,
    });
    expectStatus(duplicateStage, 200, 'idempotent SEND_INQUIRY replay');
    assert.equal((responseData(duplicateStage, 'idempotent SEND_INQUIRY replay').id), sendTask.id);
    assert.equal(await prisma.outboundEmail.count({ where: { inquiryId: sendFixture.inquiryId } }), 0,
      'staging created an outbound email before human confirmation');
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateType: 'INQUIRY', aggregateId: sendFixture.inquiryId } }), 0,
      'staging created an outbox event before human confirmation');
    expectStatus(await confirmTask(actorToken, String(sendTask.id), 2), 409, 'reject stale task version');
    const stillWaiting = await prisma.sourcingActionTask.findUniqueOrThrow({ where: { id: String(sendTask.id) } });
    assert.equal(stillWaiting.status, 'WAITING_HUMAN', 'wrong task version changed the task state');

    const [sendConfirmA, sendConfirmB] = await Promise.all([
      confirmTask(actorToken, String(sendTask.id), 1),
      confirmTask(actorToken, String(sendTask.id), 1),
    ]);
    expectStatus(sendConfirmA, 200, 'concurrent SEND_INQUIRY confirmation A');
    expectStatus(sendConfirmB, 200, 'concurrent SEND_INQUIRY confirmation B');
    const confirmedSendA = responseData(sendConfirmA, 'concurrent SEND_INQUIRY confirmation A');
    const confirmedSendB = responseData(sendConfirmB, 'concurrent SEND_INQUIRY confirmation B');
    assert.equal(confirmedSendA.status, 'COMPLETED');
    assert.equal(confirmedSendB.status, 'COMPLETED');
    assert.equal(confirmedSendA.confirmedById, actor.id);
    assert.equal(confirmedSendB.confirmedById, actor.id);
    assert.equal(confirmedSendA.outboundEmailId, confirmedSendB.outboundEmailId,
      'concurrent confirmation returned different outbound artifacts');
    const queuedInquiry = await prisma.inquiry.findUniqueOrThrow({ where: { id: sendFixture.inquiryId } });
    assert.equal(queuedInquiry.status, 'QUEUED');
    const sendArtifacts = await prisma.outboundEmail.findMany({ where: { inquiryId: sendFixture.inquiryId } });
    assert.equal(sendArtifacts.length, 1, 'concurrent confirmation created duplicate outbound email rows');
    assert.equal(sendArtifacts[0].subject, stagedContent.subject);
    assert.equal(sendArtifacts[0].textBody, stagedContent.textBody);
    assert.equal(sendArtifacts[0].status, 'PENDING', 'confirmation should enqueue, not report delivery');
    assert.equal(sendArtifacts[0].sentAt, null, 'confirmation unexpectedly recorded actual delivery');
    const sendEvents = await prisma.outboxEvent.findMany({
      where: { channel: 'EMAIL', eventType: 'inquiry.email.send', aggregateId: sendFixture.inquiryId },
    });
    assert.equal(sendEvents.length, 1, 'concurrent confirmation created duplicate outbound outbox events');
    assert.equal(sendEvents[0].status, 'PENDING');
    assert.equal(sendEvents[0].attemptCount, 0);
    assert.equal(sendEvents[0].deliveredAt, null);
    assert.equal(JSON.parse(sendEvents[0].payload).outboundEmailId, sendArtifacts[0].id);
    checks.push('SEND_INQUIRY stages exact content, rejects a mismatched task version, duplicate create replays, simultaneous confirmation creates one queued email/outbox and no delivery claim');

    const retryFixture = await createFixture('retry');
    const retryStage = await createActionTask(actorToken, {
      action: 'SEND_INQUIRY',
      targetId: retryFixture.inquiryId,
      content: { subject: `Retry ${runTag}`, textBody: 'retry fixture body' },
      idempotencyKey: `sq07-${runTag}-retry-send`,
    });
    const retryTask = responseData(retryStage, 'stage retryable send');
    expectStatus(retryStage, 201, 'stage retryable send');
    await prisma.emailAccount.update({ where: { id: account.id }, data: { isActive: false } });
    const failedSend = await confirmTask(actorToken, String(retryTask.id), 1);
    expectStatus(failedSend, 409, 'confirm send with inactive mail account');
    const failedTask = await prisma.sourcingActionTask.findUniqueOrThrow({ where: { id: String(retryTask.id) } });
    assert.equal(failedTask.status, 'FAILED');
    assert.equal(failedTask.errorSummary, 'SEND_CONFIGURATION_INVALID');
    assert.equal(await prisma.outboundEmail.count({ where: { inquiryId: retryFixture.inquiryId } }), 0,
      'failed enqueue transaction left an outbound email behind');
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateType: 'INQUIRY', aggregateId: retryFixture.inquiryId } }), 0,
      'failed enqueue transaction left an outbox event behind');

    await prisma.emailAccount.update({ where: { id: account.id }, data: { isActive: true } });
    const retryResponse = await call(actorToken, 'POST', `/api/sourcing-action-tasks/${encodeURIComponent(String(retryTask.id))}/retry`);
    expectStatus(retryResponse, 200, 'retry unchanged SEND_INQUIRY source');
    const retriedTask = responseData(retryResponse, 'retry unchanged SEND_INQUIRY source');
    assert.equal(retriedTask.status, 'WAITING_HUMAN');
    assert.equal(retriedTask.attempt, 2);
    assert.equal(retriedTask.version, 2);
    assert.equal(retriedTask.retriedById, actor.id);
    assert.equal((retriedTask.retryHistory as unknown[]).length, 1);
    const retriedConfirm = await confirmTask(actorToken, String(retryTask.id), 2);
    expectStatus(retriedConfirm, 200, 'confirm retried send');
    assert.equal(responseData(retriedConfirm, 'confirm retried send').status, 'COMPLETED');
    assert.equal(await prisma.outboundEmail.count({ where: { inquiryId: retryFixture.inquiryId } }), 1);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateType: 'INQUIRY', aggregateId: retryFixture.inquiryId } }), 1);
    checks.push('failed enqueue rolls back, bounded same-source retry advances version/attempt and can be confirmed');

    const staleSendFixture = await createFixture('stale-send');
    const staleSend = await createActionTask(actorToken, {
      action: 'SEND_INQUIRY',
      targetId: staleSendFixture.inquiryId,
      content: { subject: `Stale ${runTag}`, textBody: 'stale fixture body' },
      idempotencyKey: `sq07-${runTag}-stale-send`,
    });
    const staleSendTask = responseData(staleSend, 'stage stale send');
    expectStatus(staleSend, 201, 'stage stale send');
    await prisma.inquiryItem.update({ where: { id: staleSendFixture.inquiryItemId }, data: { quantity: 5 } });
    expectStatus(await confirmTask(actorToken, String(staleSendTask.id), 1), 409, 'reject changed inquiry source');
    const staleSendStored = await prisma.sourcingActionTask.findUniqueOrThrow({ where: { id: String(staleSendTask.id) } });
    assert.equal(staleSendStored.status, 'FAILED');
    assert.equal(staleSendStored.errorSummary, 'SOURCE_VERSION_CHANGED');
    expectStatus(await call(actorToken, 'POST', `/api/sourcing-action-tasks/${encodeURIComponent(String(staleSendTask.id))}/retry`),
      409, 'reject retry after inquiry source changed');
    assert.equal(await prisma.outboundEmail.count({ where: { inquiryId: staleSendFixture.inquiryId } }), 0);
    checks.push('SEND_INQUIRY refuses confirmation/retry against changed requirement quantity');

    const cancelFixture = await createFixture('cancel');
    const cancelStage = await createActionTask(actorToken, {
      action: 'SEND_INQUIRY',
      targetId: cancelFixture.inquiryId,
      content: { subject: `Cancel ${runTag}`, textBody: 'cancel fixture body' },
      idempotencyKey: `sq07-${runTag}-cancel-send`,
    });
    const cancelTask = responseData(cancelStage, 'stage cancellable send');
    expectStatus(cancelStage, 201, 'stage cancellable send');
    const cancelledResponse = await call(actorToken, 'POST', `/api/sourcing-action-tasks/${encodeURIComponent(String(cancelTask.id))}/cancel`);
    expectStatus(cancelledResponse, 200, 'cancel waiting task');
    const cancelledTask = responseData(cancelledResponse, 'cancel waiting task');
    assert.equal(cancelledTask.status, 'CANCELLED');
    assert.equal(cancelledTask.version, 2);
    assert.equal(cancelledTask.cancelledById, actor.id);
    expectStatus(await confirmTask(actorToken, String(cancelTask.id), 1), 409, 'confirmation after cancellation');
    assert.equal(await prisma.outboundEmail.count({ where: { inquiryId: cancelFixture.inquiryId } }), 0);
    checks.push('waiting task cancellation records actor/version and prevents later confirmation');

    const winnerFixture = await createFixture('winner');
    const winnerQuote = await createQuote(winnerFixture, 'concurrent winner');
    const staleQuoteTime = new Date(winnerQuote.updatedAt.getTime() - 1_000).toISOString();
    const winnerCountBefore = await prisma.sourcingActionTask.count({ where: { actorId: actor.id } });
    const staleExpectedVersion = await createActionTask(actorToken, {
      action: 'SELECT_WINNER',
      targetId: winnerQuote.id,
      expectedUpdatedAt: staleQuoteTime,
      idempotencyKey: `sq07-${runTag}-old-winner-version`,
    });
    expectStatus(staleExpectedVersion, 409, 'SELECT_WINNER create with stale expectedUpdatedAt');
    assert.equal(await prisma.sourcingActionTask.count({ where: { actorId: actor.id } }), winnerCountBefore,
      'stale expectedUpdatedAt created a task');

    const winnerStageBody = {
      action: 'SELECT_WINNER',
      targetId: winnerQuote.id,
      idempotencyKey: `sq07-${runTag}-winner-idempotent`,
    };
    const winnerStage = await createActionTask(actorToken, winnerStageBody);
    expectStatus(winnerStage, 201, 'stage SELECT_WINNER');
    const winnerTask = responseData(winnerStage, 'stage SELECT_WINNER');
    assert.equal(winnerTask.status, 'WAITING_HUMAN');
    assert.equal(winnerTask.version, 1);
    const winnerReplay = await createActionTask(actorToken, winnerStageBody);
    expectStatus(winnerReplay, 200, 'idempotent SELECT_WINNER replay');
    assert.equal(responseData(winnerReplay, 'idempotent SELECT_WINNER replay').id, winnerTask.id);

    const [winnerConfirmA, winnerConfirmB] = await Promise.all([
      confirmTask(actorToken, String(winnerTask.id), 1),
      confirmTask(actorToken, String(winnerTask.id), 1),
    ]);
    expectStatus(winnerConfirmA, 200, 'concurrent SELECT_WINNER confirmation A');
    expectStatus(winnerConfirmB, 200, 'concurrent SELECT_WINNER confirmation B');
    const completedWinnerA = responseData(winnerConfirmA, 'concurrent SELECT_WINNER confirmation A');
    const completedWinnerB = responseData(winnerConfirmB, 'concurrent SELECT_WINNER confirmation B');
    assert.equal(completedWinnerA.status, 'COMPLETED');
    assert.equal(completedWinnerB.status, 'COMPLETED');
    const selectedQuote = await prisma.supplierQuote.findUniqueOrThrow({ where: { id: winnerQuote.id } });
    assert.equal(selectedQuote.isWinner, true);
    assert.equal(selectedQuote.status, 'accepted');
    assert.equal(await prisma.supplierQuote.count({ where: { rfqLineId: winnerFixture.rfqLineId, isWinner: true } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { resourceType: 'SUPPLIER_QUOTE', resourceId: winnerQuote.id, action: 'APPROVE' } }), 1,
      'winner confirmation replay created duplicate audit artifact');
    assert.equal(completedWinnerA.result && JSON.stringify(completedWinnerA.result),
      completedWinnerB.result && JSON.stringify(completedWinnerB.result));
    checks.push('SELECT_WINNER rejects stale expectedUpdatedAt at creation, pins accepted quote to the confirmed task version, and simultaneous confirmations produce one winner/audit');

    const staleWinnerFixture = await createFixture('stale-winner');
    const staleWinnerQuote = await createQuote(staleWinnerFixture, 'stale winner');
    const staleWinnerStage = await createActionTask(actorToken, {
      action: 'SELECT_WINNER',
      targetId: staleWinnerQuote.id,
      idempotencyKey: `sq07-${runTag}-stale-winner`,
    });
    const staleWinnerTask = responseData(staleWinnerStage, 'stage stale winner');
    expectStatus(staleWinnerStage, 201, 'stage stale winner');
    await prisma.supplierQuote.update({ where: { id: staleWinnerQuote.id }, data: { unitPrice: 126, totalPrice: 504 } });
    expectStatus(await confirmTask(actorToken, String(staleWinnerTask.id), 1), 409, 'reject changed winner source');
    const staleWinnerStored = await prisma.sourcingActionTask.findUniqueOrThrow({ where: { id: String(staleWinnerTask.id) } });
    assert.equal(staleWinnerStored.status, 'FAILED');
    assert.equal(staleWinnerStored.errorSummary, 'SOURCE_VERSION_CHANGED');
    assert.equal((await prisma.supplierQuote.findUniqueOrThrow({ where: { id: staleWinnerQuote.id } })).isWinner, false);
    expectStatus(await call(actorToken, 'POST', `/api/sourcing-action-tasks/${encodeURIComponent(String(staleWinnerTask.id))}/retry`),
      409, 'reject retry after winner source changed');
    checks.push('SELECT_WINNER refuses changed price/version and creates no winner artifact');

    expectStatus(await call(outsiderToken, 'GET', `/api/sourcing-action-tasks/${encodeURIComponent(String(winnerTask.id))}`),
      404, 'other sales user reads actor-scoped task');
    expectStatus(await confirmTask(outsiderToken, String(winnerTask.id), 1), 404, 'other sales user confirms actor-scoped task');
    expectStatus(await createActionTask(outsiderToken, {
      action: 'SELECT_WINNER',
      targetId: winnerQuote.id,
      idempotencyKey: `sq07-${runTag}-outsider-winner`,
    }), 404, 'other sales user stages winner in another department');
    expectStatus(await createActionTask(outsiderToken, {
      action: 'SEND_INQUIRY',
      targetId: sendFixture.inquiryId,
      content: { subject: 'forbidden', textBody: 'forbidden' },
      idempotencyKey: `sq07-${runTag}-outsider-send`,
    }), 404, 'other sales user stages send for another department');
    checks.push('current authenticated role/department scopes hide and reject cross-owner task/target access');

    console.log(JSON.stringify({
      status: 'PASS',
      database: `${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}`,
      fixtureTag: runTag,
      actorId: actor.id,
      outsiderId: outsider.id,
      sendTaskId: sendTask.id,
      winnerTaskId: winnerTask.id,
      checks,
      deliveryLimit: 'HTTP routes and PostgreSQL queue state exercised; no SMTP/IMAP server, worker, AI model, or real delivery was started',
    }, null, 2));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    }
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
