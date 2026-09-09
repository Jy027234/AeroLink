import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';

/**
 * Local-only HTTP evidence for the supplier-direct router.  The fixture is
 * created by the command-chain script in an explicit fixture-only mode, then
 * every direct-shipment operation below goes through the real authentication,
 * capability, idempotency and Express route layers.  Supertest owns the
 * ephemeral listener: this script never starts the API or worker.
 */
const expectedDatabase = 'aerolink_procurement_test_direct_20260909';
const expectedPort = '55970';
const databaseUrlValue = process.env.DATABASE_URL;
if (process.env.AEROLINK_DIRECT_SHIPMENT_HTTP_INTEGRATION !== 'true' || !databaseUrlValue) {
  throw new Error(`Explicit AEROLINK_DIRECT_SHIPMENT_HTTP_INTEGRATION=true and ${expectedDatabase} DATABASE_URL are required`);
}
const databaseUrl = new URL(databaseUrlValue);
if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.port !== expectedPort
  || databaseUrl.pathname !== `/${expectedDatabase}`) {
  throw new Error(`Refusing non-local/non-${expectedDatabase} DATABASE_URL`);
}

const tag = randomUUID().replaceAll('-', '').slice(0, 12);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= `d14-direct-http-access-${tag}`;
process.env.JWT_REFRESH_SECRET ||= `d14-direct-http-refresh-${tag}`;
process.env.AUTHENTICATED_REQUEST_RATE_LIMIT_ENABLED = 'false';

const execFileAsync = promisify(execFile);
const db = new PrismaClient();
const actorSelect = {
  id: true, email: true, name: true, role: true, department: true, avatar: true, tokenVersion: true,
} as const;
type ActorRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  department: string | null;
  avatar: string | null;
  tokenVersion: number;
};
type JsonRecord = Record<string, unknown>;

type Fixture = {
  result: 'FIXTURE_ONLY';
  database: string;
  tag: string;
  orderId: string;
  purchaseCommitmentId: string;
  batchPurchaseLineId: string;
  serialPurchaseLineId: string;
  batchPart: string;
  batchNumber: string;
  serialPart: string;
  serialNumber: string;
  users: {
    salesId: string;
    buyerId: string;
    managerApproverId: string;
    approverId: string;
    qualityId: string;
  };
};

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function asRecord(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} is not an object`);
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} is not a string`);
  assert.ok((value as string).trim(), `${label} is empty`);
  return (value as string).trim();
}

function assertSuccess(response: { body?: unknown }, label: string): asserts response is { body: { success: true; data: any } } {
  assert.equal((response.body as { success?: unknown } | undefined)?.success, true,
    `${label} failed: ${JSON.stringify(response.body)}`);
}

function errorCode(response: { body?: unknown }): unknown {
  return (response.body as { code?: unknown } | undefined)?.code;
}

function batchPhysical(partNumber: string, batchNumber: string, quantity: number) {
  return {
    partNumber,
    uom: 'EA',
    trackingType: 'BATCH',
    quantity,
    serialNumber: null,
    batchNumber,
    conditionCode: 'NE',
    certificateReferences: [],
    certificateType: null,
    certificateNumber: null,
    lifeLimited: false,
    remainingHours: null,
    remainingCycles: null,
    shelfLifeDate: null,
    shelfLifeDays: null,
    nextOverhaulDue: null,
    storageCondition: 'SYNTHETIC-HTTP',
  };
}

function serialPhysical(partNumber: string, serialNumber: string) {
  return {
    partNumber,
    uom: 'EA',
    trackingType: 'SERIAL',
    quantity: 1,
    serialNumber,
    batchNumber: null,
    conditionCode: 'NE',
    certificateReferences: [],
    certificateType: null,
    certificateNumber: null,
    lifeLimited: false,
    remainingHours: null,
    remainingCycles: null,
    shelfLifeDate: null,
    shelfLifeDays: null,
    nextOverhaulDue: null,
    storageCondition: 'SYNTHETIC-HTTP',
  };
}

async function createSyntheticEvidence(ownerId: string, purpose: string) {
  const content = `direct-shipment-http:${tag}:${purpose}`;
  return db.storedObject.create({
    data: {
      objectKey: `synthetic/d14-direct-http/${tag}/${purpose}.pdf`,
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length,
      mimeType: 'application/pdf',
      originalName: `synthetic-direct-http-${purpose}.pdf`,
      ownerId,
      status: 'AVAILABLE',
      metadata: { synthetic: true, tag, purpose },
    },
    select: { id: true, version: true, status: true },
  });
}

async function createFixture(): Promise<Fixture> {
  const serverRoot = fileURLToPath(new URL('../..', import.meta.url));
  const childEnv = {
    ...process.env,
    NODE_ENV: 'test',
    AEROLINK_DIRECT_SHIPMENT_INTEGRATION: 'true',
    AEROLINK_DIRECT_SHIPMENT_FIXTURE_ONLY: 'true',
    DATABASE_URL: databaseUrlValue!,
    JWT_SECRET: `d14-direct-fixture-access-${tag}`,
    JWT_REFRESH_SECRET: `d14-direct-fixture-refresh-${tag}`,
  };
  const child = await execFileAsync(process.execPath,
    ['--import', 'tsx', 'src/scripts/checkDirectShipmentCommands.ts'],
    { cwd: serverRoot, env: childEnv, maxBuffer: 2 * 1024 * 1024 });
  try {
    const fixture = JSON.parse(child.stdout.trim()) as Fixture;
    assert.equal(fixture.result, 'FIXTURE_ONLY');
    assert.equal(fixture.database, expectedDatabase);
    return fixture;
  } catch (error) {
    throw new Error(`fixture-only command did not emit valid JSON: ${String(error)}\nstdout=${child.stdout}\nstderr=${child.stderr}`);
  }
}

async function main() {
  const [{ default: directShipmentRoutes }, auth, errorModule] = await Promise.all([
    import('../routes/directShipments.js'),
    import('../middleware/auth.js'),
    import('../middleware/errorHandler.js'),
  ]);
  const fixture = await createFixture();
  const [sales, buyer, quality] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: fixture.users.salesId }, select: actorSelect }),
    db.user.findUniqueOrThrow({ where: { id: fixture.users.buyerId }, select: actorSelect }),
    db.user.findUniqueOrThrow({ where: { id: fixture.users.qualityId }, select: actorSelect }),
  ]) as [ActorRow, ActorRow, ActorRow];

  const app = express();
  app.use(express.json());
  app.use('/api/direct-shipments', auth.authenticate, directShipmentRoutes);
  app.use(errorModule.errorHandler);

  const salesToken = auth.generateTokens(sales).accessToken;
  const buyerToken = auth.generateTokens(buyer).accessToken;
  const qualityToken = auth.generateTokens(quality).accessToken;

  const missingAuth = await request(app).get('/api/direct-shipments/does-not-exist');
  assert.equal(missingAuth.status, 401, `anonymous request was not rejected: ${JSON.stringify(missingAuth.body)}`);

  const batchEvidence = await createSyntheticEvidence(buyer.id, 'batch-plan');
  const batchBody = {
    purchaseCommitmentId: fixture.purchaseCommitmentId,
    purchaseVersion: (await db.purchaseCommitment.findUniqueOrThrow({ where: { id: fixture.purchaseCommitmentId }, select: { version: true } })).version,
    carrier: 'HTTP Synthetic Carrier',
    trackingNumber: `HTTP-BATCH-${tag}`,
    origin: 'HTTP Synthetic Supplier',
    destination: 'HTTP Synthetic Customer',
    reason: 'HTTP synthetic direct shipment plan',
    evidenceIds: [batchEvidence.id],
    lines: [{
      purchaseCommitmentLineId: fixture.batchPurchaseLineId,
      physical: batchPhysical(fixture.batchPart, fixture.batchNumber, 2),
    }],
  };

  // Capability is checked before purchase access and before idempotency.  A
  // SALES token therefore cannot reserve a direct shipment in this scope.
  const salesDenied = await request(app).post('/api/direct-shipments')
    .set(authHeader(salesToken)).set('Idempotency-Key', `sales-denied-${tag}`).send(batchBody);
  assert.equal(salesDenied.status, 403, `sales write was accepted: ${JSON.stringify(salesDenied.body)}`);
  assert.equal(errorCode(salesDenied), 'AUTH_FORBIDDEN');

  const created = await request(app).post('/api/direct-shipments')
    .set(authHeader(buyerToken)).set('Idempotency-Key', `batch-create-${tag}`).send(batchBody);
  assert.equal(created.status, 201, `HTTP direct create failed: ${JSON.stringify(created.body)}`);
  assertSuccess(created, 'HTTP direct create');
  const createdData = asRecord(created.body.data, 'created direct shipment');
  const shipmentId = text(createdData.id, 'shipment id');
  const createdLines = createdData.lines as Array<JsonRecord>;
  assert.ok(Array.isArray(createdLines) && createdLines.length === 1, 'HTTP direct create did not return one line');
  const shipmentLineId = text(createdLines[0]!.id, 'shipment line id');

  // A replay must still pass current capability/scope checks.  Downgrading the
  // current DB role makes the exact same token/key replay fail before cache
  // lookup; a stale role claim cannot recover the cached 201 response.
  await db.user.update({ where: { id: buyer.id }, data: { role: 'SALES' } });
  let downgradeChecked = false;
  try {
    const replayAfterDowngrade = await request(app).post('/api/direct-shipments')
      .set(authHeader(buyerToken)).set('Idempotency-Key', `batch-create-${tag}`).send(batchBody);
    assert.equal(replayAfterDowngrade.status, 403,
      `downgraded replay was accepted: ${JSON.stringify(replayAfterDowngrade.body)}`);
    assert.equal(errorCode(replayAfterDowngrade), 'AUTH_FORBIDDEN');
    downgradeChecked = true;
  } finally {
    await db.user.update({ where: { id: buyer.id }, data: { role: buyer.role } });
  }
  assert.ok(downgradeChecked, 'current-role idempotency replay check did not run');

  // Token-version revocation is checked from the current user row, not from
  // the JWT claims.  Restore the synthetic row for the rest of the chain.
  const revokedToken = auth.generateTokens(buyer).accessToken;
  await db.user.update({ where: { id: buyer.id }, data: { tokenVersion: { increment: 1 } } });
  let tokenVersionChecked = false;
  try {
    const revoked = await request(app).get(`/api/direct-shipments/${shipmentId}`).set(authHeader(revokedToken));
    assert.equal(revoked.status, 401, `revoked token was accepted: ${JSON.stringify(revoked.body)}`);
    assert.equal(errorCode(revoked), 'AUTH_TOKEN_INVALID');
    tokenVersionChecked = true;
  } finally {
    await db.user.update({ where: { id: buyer.id }, data: { tokenVersion: buyer.tokenVersion } });
  }
  assert.ok(tokenVersionChecked, 'token-version revocation check did not run');

  // Independent QUALITY_MANAGER review uses the exact current context hash.
  const context = await request(app).get(`/api/direct-shipments/lines/${shipmentLineId}/review-context`)
    .set(authHeader(qualityToken));
  assert.equal(context.status, 200, `HTTP review context failed: ${JSON.stringify(context.body)}`);
  assertSuccess(context, 'HTTP direct review context');
  const contextData = asRecord(context.body.data, 'review context');
  const review = await request(app).post(`/api/direct-shipments/lines/${shipmentLineId}/review`)
    .set(authHeader(qualityToken)).set('Idempotency-Key', `batch-review-${tag}`).send({
      version: contextData.version,
      snapshotHash: text(contextData.snapshotHash, 'review snapshot hash'),
      decision: 'APPROVED',
      reason: 'HTTP independent synthetic quality review',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      evidenceIds: [],
    });
  assert.equal(review.status, 200, `HTTP direct review failed: ${JSON.stringify(review.body)}`);
  assertSuccess(review, 'HTTP direct review');

  const afterReview = await request(app).get(`/api/direct-shipments/${shipmentId}`).set(authHeader(buyerToken));
  assert.equal(afterReview.status, 200, `HTTP direct read after review failed: ${JSON.stringify(afterReview.body)}`);
  assertSuccess(afterReview, 'HTTP direct read after review');
  const afterReviewData = asRecord(afterReview.body.data, 'shipment after review');
  const dispatch = await request(app).post(`/api/direct-shipments/${shipmentId}/dispatch`)
    .set(authHeader(buyerToken)).set('Idempotency-Key', `batch-dispatch-${tag}`).send({
      version: afterReviewData.version,
      reason: 'HTTP synthetic supplier dispatch',
    });
  assert.equal(dispatch.status, 200, `HTTP direct dispatch failed: ${JSON.stringify(dispatch.body)}`);
  assertSuccess(dispatch, 'HTTP direct dispatch');

  const afterDispatch = await request(app).get(`/api/direct-shipments/${shipmentId}`).set(authHeader(buyerToken));
  assert.equal(afterDispatch.status, 200, `HTTP direct read after dispatch failed: ${JSON.stringify(afterDispatch.body)}`);
  assertSuccess(afterDispatch, 'HTTP direct read after dispatch');
  const afterDispatchData = asRecord(afterDispatch.body.data, 'shipment after dispatch');
  const dispatchLines = afterDispatchData.lines as Array<JsonRecord>;
  assert.ok(Array.isArray(dispatchLines) && dispatchLines.length === 1, 'dispatched shipment line missing');
  const receiptVersion = dispatchLines[0]!.version;
  const signedAt = new Date(Date.now() - 5_000).toISOString();
  const receiptBody = {
    version: receiptVersion,
    quantity: 1,
    signedBy: 'HTTP Synthetic Customer Receiver',
    signedAt,
    reason: 'HTTP concurrent synthetic receipt',
    evidenceIds: [batchEvidence.id],
  };

  // Two distinct commands intentionally carry the same line version.  The
  // Serializable route must allow exactly one quantity increment; the other
  // must observe the version/quantity conflict and no extra event.
  const receiptResponses = await Promise.all([
    request(app).post(`/api/direct-shipments/lines/${shipmentLineId}/receipt`)
      .set(authHeader(buyerToken)).set('Idempotency-Key', `batch-receipt-race-a-${tag}`).send(receiptBody),
    request(app).post(`/api/direct-shipments/lines/${shipmentLineId}/receipt`)
      .set(authHeader(buyerToken)).set('Idempotency-Key', `batch-receipt-race-b-${tag}`).send(receiptBody),
  ]);
  const receiptWinners = receiptResponses.filter(response => response.status === 200);
  const receiptLosers = receiptResponses.filter(response => response.status === 409);
  assert.equal(receiptWinners.length, 1,
    `same-version receipt race did not have one winner: ${JSON.stringify(receiptResponses.map(response => ({ status: response.status, body: response.body })))}`);
  assert.equal(receiptLosers.length, 1,
    `same-version receipt race did not have one conflict: ${JSON.stringify(receiptResponses.map(response => ({ status: response.status, body: response.body })))}`);
  assert.ok(['RESOURCE_CONFLICT', 'STATE_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS'].includes(String(errorCode(receiptLosers[0]))),
    `unexpected receipt race code: ${JSON.stringify(receiptLosers[0]!.body)}`);
  assertSuccess(receiptWinners[0]!, 'HTTP concurrent receipt winner');

  const winnerIndex = receiptResponses.findIndex(response => response.status === 200);
  assert.ok(winnerIndex >= 0, 'receipt winner index missing');
  const winnerKey = winnerIndex === 0 ? `batch-receipt-race-a-${tag}` : `batch-receipt-race-b-${tag}`;
  const receiptReplay = await request(app).post(`/api/direct-shipments/lines/${shipmentLineId}/receipt`)
    .set(authHeader(buyerToken)).set('Idempotency-Key', winnerKey).send(receiptBody);
  assert.equal(receiptReplay.status, 200, `receipt idempotency replay failed: ${JSON.stringify(receiptReplay.body)}`);
  assert.equal(receiptReplay.headers['idempotency-replayed'], 'true');
  assertSuccess(receiptReplay, 'HTTP receipt replay');

  const afterReceipt = await request(app).get(`/api/direct-shipments/${shipmentId}`).set(authHeader(buyerToken));
  assert.equal(afterReceipt.status, 200, `HTTP direct read after receipt failed: ${JSON.stringify(afterReceipt.body)}`);
  assertSuccess(afterReceipt, 'HTTP direct read after receipt');
  const afterReceiptData = asRecord(afterReceipt.body.data, 'shipment after receipt');
  const receiptLines = afterReceiptData.lines as Array<JsonRecord>;
  assert.equal(receiptLines[0]!.receivedQuantity, 1);
  assert.equal(afterReceiptData.status, 'PARTIALLY_RECEIVED');
  const eventCount = await db.supplierDirectShipmentEvent.count({ where: { shipmentId } });
  assert.equal(eventCount, 4, 'receipt race/replay added a duplicate event');

  // A second independent plan race uses the remaining SERIAL purchase line.
  // Both requests carry one purchase version and distinct idempotency keys;
  // the purchase-version CAS permits one plan only.
  const serialEvidence = await createSyntheticEvidence(buyer.id, 'serial-race');
  const purchaseForRace = await db.purchaseCommitment.findUniqueOrThrow({ where: { id: fixture.purchaseCommitmentId }, select: { version: true } });
  const serialBody = {
    purchaseCommitmentId: fixture.purchaseCommitmentId,
    purchaseVersion: purchaseForRace.version,
    carrier: 'HTTP Synthetic Carrier',
    trackingNumber: `HTTP-SERIAL-RACE-${tag}`,
    origin: 'HTTP Synthetic Supplier',
    destination: 'HTTP Synthetic Customer',
    reason: 'HTTP concurrent direct-plan race',
    evidenceIds: [serialEvidence.id],
    lines: [{
      purchaseCommitmentLineId: fixture.serialPurchaseLineId,
      physical: serialPhysical(fixture.serialPart, fixture.serialNumber),
    }],
  };
  const planResponses = await Promise.all([
    request(app).post('/api/direct-shipments').set(authHeader(buyerToken))
      .set('Idempotency-Key', `serial-plan-race-a-${tag}`).send(serialBody),
    request(app).post('/api/direct-shipments').set(authHeader(buyerToken))
      .set('Idempotency-Key', `serial-plan-race-b-${tag}`).send(serialBody),
  ]);
  const planWinners = planResponses.filter(response => response.status === 201);
  const planLosers = planResponses.filter(response => response.status === 409);
  assert.equal(planWinners.length, 1,
    `same-version plan race did not have one winner: ${JSON.stringify(planResponses.map(response => ({ status: response.status, body: response.body })))}`);
  assert.equal(planLosers.length, 1,
    `same-version plan race did not have one conflict: ${JSON.stringify(planResponses.map(response => ({ status: response.status, body: response.body })))}`);
  assert.ok(['RESOURCE_CONFLICT', 'STATE_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS'].includes(String(errorCode(planLosers[0]))),
    `unexpected plan race code: ${JSON.stringify(planLosers[0]!.body)}`);
  assertSuccess(planWinners[0]!, 'HTTP concurrent plan winner');
  const planData = asRecord(planWinners[0]!.body.data, 'concurrent plan');
  const planId = text(planData.id, 'concurrent plan id');
  const purchaseAfterPlan = await db.purchaseCommitment.findUniqueOrThrow({
    where: { id: fixture.purchaseCommitmentId },
    include: { lines: { where: { id: fixture.serialPurchaseLineId } } },
  });
  assert.equal(purchaseAfterPlan.lines[0]!.directShippedQuantity, 0);
  assert.equal(purchaseAfterPlan.lines[0]!.receivedQuantity, 0);

  // Keep the synthetic clone auditable but release the unused plan through the
  // real cancel command so it does not leave a live serial claim.
  const planRead = await request(app).get(`/api/direct-shipments/${planId}`).set(authHeader(buyerToken));
  assert.equal(planRead.status, 200, `HTTP plan read failed: ${JSON.stringify(planRead.body)}`);
  assertSuccess(planRead, 'HTTP concurrent plan read');
  const planReadData = asRecord(planRead.body.data, 'plan read');
  const cancelled = await request(app).post(`/api/direct-shipments/${planId}/cancel`)
    .set(authHeader(buyerToken)).set('Idempotency-Key', `serial-plan-cancel-${tag}`).send({
      version: planReadData.version,
      reason: 'HTTP release synthetic losing-race capacity',
    });
  assert.equal(cancelled.status, 200, `HTTP plan cancel failed: ${JSON.stringify(cancelled.body)}`);
  assertSuccess(cancelled, 'HTTP plan cancel');
  const cancelledData = asRecord(cancelled.body.data, 'cancelled plan');
  assert.equal(cancelledData.status, 'CANCELLED');

  const finalPurchase = await db.purchaseCommitment.findUniqueOrThrow({
    where: { id: fixture.purchaseCommitmentId },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
  const finalBatch = finalPurchase.lines.find(line => line.id === fixture.batchPurchaseLineId)!;
  const finalSerial = finalPurchase.lines.find(line => line.id === fixture.serialPurchaseLineId)!;
  assert.equal(finalBatch.directShippedQuantity, 2);
  assert.equal(finalBatch.receivedQuantity, 0);
  assert.equal(finalSerial.directShippedQuantity, 0);
  assert.equal(finalSerial.receivedQuantity, 0);
  const directEvents = await db.supplierDirectShipmentEvent.count({ where: { shipmentId } });
  assert.equal(directEvents, 4);

  console.log(JSON.stringify({
    result: 'PASS', database: expectedDatabase, tag, orderId: fixture.orderId,
    purchaseCommitmentId: fixture.purchaseCommitmentId, shipmentId, planId,
    checks: [
      'anonymous direct read returns 401',
      'SALES cannot create a supplier-direct plan',
      'current-role downgrade blocks an idempotency replay before cached response',
      'tokenVersion revocation blocks the previously issued access token',
      'real HTTP create, independent quality review, dispatch and customer receipt',
      'same-version receipt race has one winner and one conflict',
      'same-key receipt replay returns cached result without a duplicate event',
      'same-version purchase remaining plan race has one winner and one conflict',
      'cancel releases the losing-race synthetic serial plan claim',
      'direct shipping leaves local stock and purchase receivedQuantity unchanged',
    ],
    receiptRace: { winnerCount: receiptWinners.length, conflictCount: receiptLosers.length, eventCount: directEvents },
    planRace: { winnerCount: planWinners.length, conflictCount: planLosers.length },
    finalQuantities: {
      batchDirectShipped: finalBatch.directShippedQuantity,
      batchPurchaseReceived: finalBatch.receivedQuantity,
      serialDirectShipped: finalSerial.directShippedQuantity,
      serialPurchaseReceived: finalSerial.receivedQuantity,
    },
  }, null, 2));
}

try {
  await main();
} finally {
  await db.$disconnect();
  const appPrisma = (await import('../lib/prisma.js')).default;
  await appPrisma.$disconnect();
}
