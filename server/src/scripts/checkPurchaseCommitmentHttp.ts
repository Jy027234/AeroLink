import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';

/**
 * HTTP boundary evidence for D14 procurement commands.
 *
 * It imports only the real authentication middleware, procurement router and
 * error handler. Supertest owns a temporary local HTTP server; this script
 * does not import index.ts, start a persistent API/Socket.IO server, or run a worker.
 */
const expectedDatabase = 'aerolink_procurement_test_commands_20260909';
const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_PURCHASE_HTTP_INTEGRATION !== 'true'
  || !['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.pathname !== `/${expectedDatabase}`) {
  throw new Error(`Explicit opt-in and local ${expectedDatabase} database required`);
}

const tag = randomUUID().replaceAll('-', '').slice(0, 12);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= `d14-http-access-${tag}`;
process.env.JWT_REFRESH_SECRET ||= `d14-http-refresh-${tag}`;

const db = new PrismaClient();

function authHeader(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

function assertSuccess(response: { body?: unknown }, label: string): asserts response is { body: { success: true; data: Record<string, any> } } {
  assert.equal((response.body as { success?: unknown } | undefined)?.success, true, `${label} failed: ${JSON.stringify(response.body)}`);
}

try {
  const fixtureOrder = await db.order.findFirst({
    where: { orderNumber: { startsWith: 'D14-CMD-ORDER-' } },
    orderBy: { createdAt: 'desc' },
    include: {
      lines: { orderBy: { lineNo: 'asc' }, include: { quotationLine: true } },
      quotation: { include: { creator: true } },
    },
  });
  assert(fixtureOrder, 'D14 command fixture order is required; run checkPurchaseCommitments.ts first');
  assert(fixtureOrder.lineItemsMode, 'HTTP fixture order must be modern line mode');
  const fixtureLine = fixtureOrder.lines[0];
  assert(fixtureLine, 'HTTP fixture order line is required');
  const fixturePrevious = await db.purchaseCommitment.findFirst({
    where: { orderId: fixtureOrder.id, status: 'CANCELLED' },
    orderBy: { createdAt: 'desc' },
  });
  assert(fixturePrevious, 'HTTP fixture must have a cancelled command-chain commitment');
  assert(fixturePrevious.approvedById, 'HTTP fixture must have an independent approver');
  const activeCount = await db.purchaseCommitment.count({
    where: { orderId: fixtureOrder.id, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'CLOSED'] } },
  });
  assert.equal(activeCount, 0, 'HTTP fixture order already has an active commitment; use a fresh commands database');

  const sales = fixtureOrder.quotation.creator;
  const buyer = await db.user.findUniqueOrThrow({ where: { id: fixturePrevious.createdById } });
  const approver = await db.user.findUniqueOrThrow({ where: { id: fixturePrevious.approvedById! } });
  assert.notEqual(buyer.id, sales.id, 'buyer and sales owner must be independent');
  assert.notEqual(approver.id, buyer.id, 'approver must be independent from buyer');
  const sourceQuote = await db.supplierQuote.findFirst({
    where: {
      supplierId: fixturePrevious.supplierId,
      rfqLineId: fixtureLine.quotationLine.rfqLineId,
      partNumber: fixtureLine.partNumber,
      currency: 'USD',
      currencyReviewStatus: 'VERIFIED',
      status: 'pending',
    },
    orderBy: { createdAt: 'desc' },
  });
  assert(sourceQuote, 'HTTP fixture source supplier quote is required');
  assert.equal(sourceQuote.currency, 'USD');
  assert.equal(sourceQuote.currencyReviewStatus, 'VERIFIED');
  assert(sourceQuote.unitPriceDecimal !== null, 'HTTP fixture source quote must have Decimal unit cost');
  assert.equal(sourceQuote.quantity >= fixtureLine.quantity, true);
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (!sourceQuote.validUntil || sourceQuote.validUntil.getTime() <= Date.now()) {
    await db.supplierQuote.update({ where: { id: sourceQuote.id }, data: { validUntil: future, status: 'pending' } });
  }

  const finance = await db.user.create({
    data: {
      email: `d14-http-finance-${tag}@example.invalid`,
      name: `D14 HTTP finance ${tag}`,
      password: 'synthetic-only',
      role: 'FINANCE',
      department: 'Finance',
    },
  });
  const proof = await db.storedObject.create({
    data: {
      objectKey: `synthetic/d14-purchase-http/${tag}/confirmation-proof.pdf`,
      sha256: 'c'.repeat(64),
      sizeBytes: 18,
      mimeType: 'application/pdf',
      originalName: 'synthetic-http-confirmation-proof.pdf',
      ownerId: approver.id,
      status: 'AVAILABLE',
      metadata: { synthetic: true, tag, purpose: 'D14 HTTP confirmation metadata' },
    },
  });

  const [{ default: purchaseCommitmentRoutes }, auth, errorModule, prismaModule] = await Promise.all([
    import('../routes/purchaseCommitments.js'),
    import('../middleware/auth.js'),
    import('../middleware/errorHandler.js'),
    import('../lib/prisma.js'),
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api/purchase-commitments', auth.authenticate, purchaseCommitmentRoutes);
  app.use(errorModule.errorHandler);

  const salesToken = auth.generateTokens({ ...sales, tokenVersion: sales.tokenVersion }).accessToken;
  const buyerToken = auth.generateTokens({ ...buyer, tokenVersion: buyer.tokenVersion }).accessToken;
  const approverToken = auth.generateTokens({ ...approver, tokenVersion: approver.tokenVersion }).accessToken;
  const financeToken = auth.generateTokens({ ...finance, tokenVersion: finance.tokenVersion }).accessToken;
  const baseBody = {
    orderId: fixtureOrder.id,
    supplierId: fixturePrevious.supplierId,
    lines: [{
      orderLineId: fixtureLine.id,
      source: { type: 'SUPPLIER_QUOTE', supplierQuoteId: sourceQuote.id },
      quantity: fixtureLine.quantity,
      promisedDate: future.toISOString(),
      fulfillmentMode: 'STOCK_RECEIPT',
    }],
  };
  const commandKey = `d14-http-create-${tag}`;

  const missingAuth = await request(app)
    .get(`/api/purchase-commitments/${fixturePrevious.id}`)
    .expect(401);
  assert.equal(missingAuth.body.success, false);

  const createResponse = await request(app)
    .post('/api/purchase-commitments')
    .set(authHeader(buyerToken))
    .set('Idempotency-Key', commandKey)
    .send(baseBody)
    .expect(201);
  assertSuccess(createResponse, 'buyer create');
  const purchaseId = createResponse.body.data.id as string;
  assert.equal(createResponse.body.data.totalCost, sourceQuote.unitPriceDecimal!.mul(fixtureLine.quantity).toFixed(4));
  assert.equal(createResponse.body.data.lines[0].unitCost, sourceQuote.unitPriceDecimal!.toFixed(4));
  const createdVersion = createResponse.body.data.version as number;
  assert.equal(createdVersion, 1);

  const replayResponse = await request(app)
    .post('/api/purchase-commitments')
    .set(authHeader(buyerToken))
    .set('Idempotency-Key', commandKey)
    .send(baseBody)
    .expect(201);
  assertSuccess(replayResponse, 'buyer create replay');
  assert.equal(replayResponse.body.data.id, purchaseId);
  assert.equal(replayResponse.headers['idempotency-replayed'], 'true');

  const salesRead = await request(app)
    .get(`/api/purchase-commitments/${purchaseId}`)
    .set(authHeader(salesToken))
    .expect(200);
  assertSuccess(salesRead, 'sales safe read');
  assert.equal(salesRead.body.data.id, purchaseId);
  assert.equal(Object.prototype.hasOwnProperty.call(salesRead.body.data, 'totalCost'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(salesRead.body.data.lines[0], 'unitCost'), false);

  const financeRead = await request(app)
    .get(`/api/purchase-commitments/${purchaseId}`)
    .set(authHeader(financeToken))
    .expect(200);
  assertSuccess(financeRead, 'finance cost read');
  assert.equal(financeRead.body.data.totalCost, createResponse.body.data.totalCost);
  assert.equal(financeRead.body.data.lines[0].unitCost, createResponse.body.data.lines[0].unitCost);

  await db.user.update({ where: { id: buyer.id }, data: { role: 'SALES' } });
  const revokedReplay = await request(app)
    .post('/api/purchase-commitments')
    .set(authHeader(buyerToken))
    .set('Idempotency-Key', commandKey)
    .send(baseBody)
    .expect(403);
  assert.equal(revokedReplay.body.code, 'AUTH_FORBIDDEN');
  await db.user.update({ where: { id: buyer.id }, data: { role: 'MANAGER' } });

  const submitResponse = await request(app)
    .post(`/api/purchase-commitments/${purchaseId}/submit`)
    .set(authHeader(buyerToken))
    .set('Idempotency-Key', `d14-http-submit-${tag}`)
    .send({ version: createdVersion, reason: 'HTTP synthetic USD source review complete' })
    .expect(200);
  assertSuccess(submitResponse, 'buyer submit');
  assert.equal(submitResponse.body.data.status, 'PENDING_APPROVAL');
  const pendingVersion = submitResponse.body.data.version as number;

  const approveResponse = await request(app)
    .post(`/api/purchase-commitments/${purchaseId}/approve`)
    .set(authHeader(approverToken))
    .set('Idempotency-Key', `d14-http-approve-${tag}`)
    .send({ version: pendingVersion, reason: 'HTTP synthetic independent approval' })
    .expect(200);
  assertSuccess(approveResponse, 'independent approve');
  assert.equal(approveResponse.body.data.status, 'APPROVED');
  const approvedVersion = approveResponse.body.data.version as number;

  const confirmResponse = await request(app)
    .post(`/api/purchase-commitments/${purchaseId}/confirm`)
    .set(authHeader(approverToken))
    .set('Idempotency-Key', `d14-http-confirm-${tag}`)
    .send({
      version: approvedVersion,
      reason: 'HTTP synthetic supplier confirmation',
      supplierReferenceNo: `HTTP-SUP-${tag}`,
      evidenceIds: [proof.id],
    })
    .expect(200);
  assertSuccess(confirmResponse, 'supplier confirmation');
  assert.equal(confirmResponse.body.data.status, 'CONFIRMED');
  assert.deepEqual(confirmResponse.body.data.confirmationEvidence, [{
    id: proof.id,
    version: 2,
    sha256: proof.sha256,
    status: 'AVAILABLE',
  }]);
  assert.equal(Buffer.isBuffer(confirmResponse.body.data.confirmationEvidence), false);

  const beforeSalesWrite = await db.purchaseCommitment.count({ where: { orderId: fixtureOrder.id } });
  const salesWrite = await request(app)
    .post('/api/purchase-commitments')
    .set(authHeader(salesToken))
    .set('Idempotency-Key', `d14-http-sales-write-${tag}`)
    .send(baseBody)
    .expect(403);
  assert.equal(salesWrite.body.code, 'AUTH_FORBIDDEN');
  assert.equal(await db.purchaseCommitment.count({ where: { orderId: fixtureOrder.id } }), beforeSalesWrite);

  const final = await db.purchaseCommitment.findUniqueOrThrow({ where: { id: purchaseId }, include: { lines: true } });
  assert.equal(final.status, 'CONFIRMED');
  assert.equal(final.version, 4);
  const eventCount = await db.purchaseCommitmentEvent.count({ where: { purchaseCommitmentId: purchaseId } });
  assert.equal(eventCount, 4);
  const persistedProof = await db.storedObject.findUniqueOrThrow({ where: { id: proof.id } });
  assert.equal(persistedProof.domain, 'purchase_commitment');
  assert.equal(persistedProof.resourceId, purchaseId);
  console.log(JSON.stringify({
    result: 'PASS',
    database: expectedDatabase,
    tag,
    orderId: fixtureOrder.id,
    purchaseCommitmentId: purchaseId,
    checks: [
      'missing bearer token returns 401',
      'sales read omits totalCost and line unitCost',
      'finance read includes current Decimal cost projection',
      'create returns 201 and same-key replay returns cached id only',
      'replay after current buyer role revocation returns 403',
      'buyer submit and independent manager approve return current state',
      'supplier confirmation returns safe evidence metadata only',
      'sales write returns 403 and creates no commitment',
      'only a temporary Supertest HTTP server; no persistent API, Socket.IO, worker, email or file download',
    ],
    eventCount,
  }, null, 2));
} finally {
  await db.$disconnect();
  const appPrisma = (await import('../lib/prisma.js')).default;
  await appPrisma.$disconnect();
}
