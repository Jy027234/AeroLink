import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * Local-only HTTP evidence for the stock-receipt router.  This intentionally
 * assembles only the real authentication middleware, router and error handler;
 * Supertest owns the temporary listener and no persistent API/worker starts.
 */
const expectedDatabase = 'aerolink_procurement_test_receipts_20260909';
const expectedPort = '55970';
const databaseUrlValue = process.env.DATABASE_URL;
if (process.env.AEROLINK_STOCK_RECEIPTS_HTTP_INTEGRATION !== 'true' || !databaseUrlValue) {
  throw new Error(`Explicit AEROLINK_STOCK_RECEIPTS_HTTP_INTEGRATION=true and ${expectedDatabase} DATABASE_URL are required`);
}
const databaseUrl = new URL(databaseUrlValue);
if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)
  || databaseUrl.port !== expectedPort
  || databaseUrl.pathname !== `/${expectedDatabase}`) {
  throw new Error(`Refusing non-local/non-${expectedDatabase} DATABASE_URL`);
}

const tag = randomUUID().replaceAll('-', '').slice(0, 12);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= `d14-receipt-http-access-${tag}`;
process.env.JWT_REFRESH_SECRET ||= `d14-receipt-http-refresh-${tag}`;
process.env.AUTHENTICATED_REQUEST_RATE_LIMIT_ENABLED = 'false';

const db = new PrismaClient();
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

const actorSelect = { id: true, email: true, name: true, role: true, department: true, avatar: true, tokenVersion: true } as const;

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function token(auth: typeof import('../middleware/auth.js'), user: ActorRow) {
  return auth.generateTokens(user).accessToken;
}

function assertSuccess(response: { body?: unknown }, label: string): asserts response is { body: { success: true; data: any } } {
  assert.equal((response.body as { success?: unknown } | undefined)?.success, true, `${label} failed: ${JSON.stringify(response.body)}`);
}

function assertNoCostKeys(value: unknown, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCostKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^(?:unitCost|totalCost|costPrice|margin|marginAmount|marginPercent|paymentTerms|sourceSnapshot|supplierQuote)$/i.test(key),
      `${path}.${key} leaked commercial data`);
    assertNoCostKeys(child, `${path}.${key}`);
  }
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

function sourceIdentity(line: {
  identitySnapshot: Prisma.JsonValue;
  partNumber: string;
  uom: string;
  orderLine: { quotationLine: { rfqLine: { conditionCode: string; serialNumber: string | null; batchNumber: string | null } | null } };
}) {
  const identity = asRecord(line.identitySnapshot, 'purchase identitySnapshot');
  const rfqLine = line.orderLine.quotationLine.rfqLine;
  assert.ok(rfqLine, 'purchase fixture has no RFQ line');
  return {
    partNumber: text(line.partNumber, 'part number'),
    uom: text(line.uom, 'uom'),
    conditionCode: text(identity.conditionCode ?? rfqLine.conditionCode, 'condition code'),
    serialNumber: typeof identity.serialNumber === 'string' ? identity.serialNumber : rfqLine.serialNumber,
    batchNumber: typeof identity.batchNumber === 'string' ? identity.batchNumber : rfqLine.batchNumber,
    trackingType: typeof identity.trackingType === 'string' ? identity.trackingType.toUpperCase() : undefined,
  };
}

function physicalFor(line: {
  identitySnapshot: Prisma.JsonValue;
  partNumber: string;
  uom: string;
  orderLine: { quotationLine: { rfqLine: { conditionCode: string; serialNumber: string | null; batchNumber: string | null } | null } };
}, trackingType: string, tagValue: string) {
  const identity = sourceIdentity(line);
  const serial = trackingType === 'SERIAL' ? identity.serialNumber || `HTTP-SN-${tagValue}` : null;
  const batch = trackingType === 'BATCH' ? identity.batchNumber || `HTTP-BATCH-${tagValue}` : null;
  return {
    partNumber: identity.partNumber,
    uom: identity.uom,
    trackingType,
    quantity: trackingType === 'SERIAL' ? 1 : 1,
    serialNumber: serial,
    batchNumber: batch,
    conditionCode: identity.conditionCode,
    certificateReferences: [],
    certificateType: null,
    certificateNumber: null,
    lifeLimited: false,
    remainingHours: null,
    remainingCycles: null,
    shelfLifeDate: null,
    shelfLifeDays: null,
    nextOverhaulDue: null,
    storageCondition: null,
  };
}

async function createSyntheticEvidence(ownerId: string) {
  const content = `stock-receipt-http:${tag}`;
  return db.storedObject.create({
    data: {
      objectKey: `synthetic/d14-receipt-http/${tag}/arrival-proof.pdf`,
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length,
      mimeType: 'application/pdf',
      originalName: `synthetic-stock-receipt-http-${tag}.pdf`,
      ownerId,
      status: 'AVAILABLE',
      metadata: { synthetic: true, tag, purpose: 'D14 stock receipt HTTP evidence' },
    },
  });
}

async function findReadFixture() {
  const receipts = await db.stockReceipt.findMany({
    include: {
      receivedBy: { select: actorSelect },
      purchaseCommitment: {
        select: {
          orderId: true,
          order: { select: { id: true, lineItemsMode: true, quotation: { select: { createdBy: true, creator: { select: { department: true } } } } } },
        },
      },
      lines: { orderBy: { lineNo: 'asc' }, select: { id: true, status: true, quantity: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const fixture = receipts.find((receipt) => {
    const receivedBy = receipt.receivedBy;
    const ownerDepartment = receipt.purchaseCommitment.order.quotation.creator.department;
    const role = receivedBy.role.toUpperCase();
    return ['MANAGER', 'ADMIN'].includes(role)
      && receipt.purchaseCommitment.order.lineItemsMode
      && (role === 'ADMIN' || receivedBy.id === receipt.purchaseCommitment.order.quotation.createdBy || receivedBy.department === ownerDepartment);
  });
  assert.ok(fixture, `no modern receipt received by an accessible manager/admin was found in ${expectedDatabase}`);
  const line = fixture.lines.find((candidate) => candidate.status === 'PENDING_REVIEW') ?? fixture.lines[0];
  assert.ok(line, 'HTTP fixture receipt has no line');
  return { ...fixture, line };
}

async function findOptionalArrivalFixture(manager: ActorRow) {
  const candidates = await db.purchaseCommitment.findMany({
    where: {
      status: 'CONFIRMED',
      lines: { some: { receivedQuantity: 0, directShippedQuantity: 0, cancelledQuantity: 0, stockReceiptLines: { none: {} } } },
    },
    include: {
      order: { select: {
        lineItemsMode: true, status: true, certificateRequired: true, certificateType: true, inspectionRequired: true,
        quotation: { select: { createdBy: true, creator: { select: { department: true } } } },
      } },
      lines: { include: { stockReceiptLines: { select: { id: true } }, orderLine: { include: { quotationLine: { include: { rfqLine: true } } } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return candidates.find((purchase) => {
    const ownerDepartment = purchase.order.quotation.creator.department;
    const hasScope = manager.role.toUpperCase() === 'ADMIN'
      || manager.id === purchase.order.quotation.createdBy
      || Boolean(manager.department && ownerDepartment && manager.department === ownerDepartment);
    return purchase.order.lineItemsMode && ['SO_CREATED', 'PO_CREATED'].includes(purchase.order.status) && hasScope
      && purchase.lines.some((line) => {
        const rfqLine = line.orderLine.quotationLine.rfqLine;
        const certificateFree = !purchase.order.certificateRequired && !purchase.order.certificateType
          && !purchase.order.inspectionRequired && !rfqLine?.certificateRequired && !rfqLine?.certificateType;
        return certificateFree && line.receivedQuantity === 0 && line.directShippedQuantity === 0
          && line.cancelledQuantity === 0 && line.stockReceiptLines.length === 0 && line.orderLine.orderId === purchase.orderId;
      });
  });
}

async function main() {
  const [{ default: stockReceiptRoutes }, auth, errorModule, appPrismaModule] = await Promise.all([
    import('../routes/stockReceipts.js'),
    import('../middleware/auth.js'),
    import('../middleware/errorHandler.js'),
    import('../lib/prisma.js'),
  ]);
  const fixture = await findReadFixture();
  const manager = fixture.receivedBy as ActorRow;
  const quality = await db.user.findFirst({ where: { isActive: true, role: 'QUALITY_MANAGER', id: { not: manager.id } }, select: actorSelect });
  assert.ok(quality, 'an independent active QUALITY_MANAGER is required for review-context HTTP evidence');
  const operator = await db.user.create({ data: { name: 'Synthetic receipt HTTP readonly operator',
    email: `receipt-http-operator-${tag}@example.invalid`, role: 'OPERATOR', password: 'unusable', department: manager.department }, select: actorSelect });

  const app = express();
  app.use(express.json());
  app.use('/api/stock-receipts', auth.authenticate, stockReceiptRoutes);
  app.use(errorModule.errorHandler);

  const managerToken = token(auth, manager);
  const qualityToken = token(auth, quality);
  const operatorToken = token(auth, operator);

  const missingAuth = await request(app).get(`/api/stock-receipts/${fixture.id}`).expect(401);
  assert.equal(missingAuth.body.success, false);

  const managerRead = await request(app).get(`/api/stock-receipts?orderId=${fixture.purchaseCommitment.orderId}`)
    .set(authHeader(managerToken)).expect(200);
  assertSuccess(managerRead, 'manager stock receipt list');
  assertNoCostKeys(managerRead.body.data);
  const managerDetail = await request(app).get(`/api/stock-receipts/${fixture.id}`)
    .set(authHeader(managerToken)).expect(200);
  assertSuccess(managerDetail, 'manager stock receipt detail');
  assertNoCostKeys(managerDetail.body.data);

  const qualityRead = await request(app).get(`/api/stock-receipts?orderId=${fixture.purchaseCommitment.orderId}`)
    .set(authHeader(qualityToken)).expect(200);
  assertSuccess(qualityRead, 'quality stock receipt list');
  assertNoCostKeys(qualityRead.body.data);
  const qualityDetail = await request(app).get(`/api/stock-receipts/${fixture.id}`)
    .set(authHeader(qualityToken)).expect(200);
  assertSuccess(qualityDetail, 'quality stock receipt detail');
  assertNoCostKeys(qualityDetail.body.data);

  const reviewContext = await request(app).get(`/api/stock-receipts/lines/${fixture.line.id}/review-context`)
    .set(authHeader(qualityToken)).expect(200);
  assertSuccess(reviewContext, 'quality review context');
  assert.equal(reviewContext.body.data.receiptLineId, fixture.line.id);
  assertNoCostKeys(reviewContext.body.data);

  const noWriteBody = {
    purchaseCommitmentId: fixture.purchaseCommitmentId,
    purchaseVersion: 1,
    supplierDeliveryReference: `HTTP-NOKEY-${tag}`,
    reason: 'HTTP negative validation',
    evidenceIds: ['missing-evidence-id'],
    lines: [{ purchaseCommitmentLineId: 'missing-purchase-line', physical: {
      partNumber: 'PN-HTTP', uom: 'EA', trackingType: 'BATCH', quantity: 1, serialNumber: null,
      batchNumber: `HTTP-BATCH-${tag}`, conditionCode: 'NE', certificateReferences: [], certificateType: null,
      certificateNumber: null, lifeLimited: false, remainingHours: null, remainingCycles: null,
      shelfLifeDate: null, shelfLifeDays: null, nextOverhaulDue: null, storageCondition: null,
    }, storage: { location: 'HTTP', warehouse: 'HTTP', shelf: null } }],
  };
  await request(app).post('/api/stock-receipts').set(authHeader(operatorToken)).set('Idempotency-Key', `operator-${tag}`).send(noWriteBody).expect(403);
  const strictField = await request(app).post('/api/stock-receipts').set(authHeader(managerToken)).set('Idempotency-Key', `strict-${tag}`)
    .send({ ...noWriteBody, id: 'forged', status: 'ACCEPTED', costPrice: '999.00' }).expect(400);
  assert.equal(strictField.body.code, 'VALIDATION_ERROR');
  await request(app).post('/api/stock-receipts').set(authHeader(managerToken)).send(noWriteBody).expect(400);

  let revokedRole: string | null = null;
  try {
    revokedRole = manager.role;
    await db.user.update({ where: { id: manager.id }, data: { role: 'VIEWER' } });
    const revokedTokenRead = await request(app).get(`/api/stock-receipts?orderId=${fixture.purchaseCommitment.orderId}`)
      .set(authHeader(managerToken)).expect(403);
    assert.equal(revokedTokenRead.body.code, 'AUTH_FORBIDDEN');
  } finally {
    if (revokedRole) await db.user.update({ where: { id: manager.id }, data: { role: revokedRole } });
  }

  const optionalPurchase = await findOptionalArrivalFixture(manager);
  let optionalEvidenceId: string | undefined;
  let optionalChain: Record<string, unknown>;
  if (!optionalPurchase) {
    optionalChain = { status: 'NOT_RUN', reason: 'no remaining CONFIRMED modern purchase line without a receipt' };
  } else {
    const purchaseLine = optionalPurchase.lines.find((line) => line.receivedQuantity === 0 && line.directShippedQuantity === 0
      && line.cancelledQuantity === 0 && line.stockReceiptLines.length === 0 && line.orderLine.orderId === optionalPurchase.orderId);
    assert.ok(purchaseLine, 'optional purchase fixture lost its eligible line');
    const item = await db.inventoryItem.findUnique({ where: { partNumber: purchaseLine.partNumber }, select: { trackingType: true, unitOfMeasure: true } });
    if (item) assert.equal(item.unitOfMeasure, purchaseLine.uom, 'optional purchase uom differs from inventory master');
    const identity = sourceIdentity(purchaseLine);
    const trackingType = item?.trackingType.toUpperCase() || identity.trackingType || (identity.serialNumber ? 'SERIAL' : 'BATCH');
    const physical = physicalFor(purchaseLine, trackingType, tag);
    const evidence = await createSyntheticEvidence(manager.id);
    optionalEvidenceId = evidence.id;
    const body = {
      purchaseCommitmentId: optionalPurchase.id,
      purchaseVersion: optionalPurchase.version,
      supplierDeliveryReference: `HTTP-DELIVERY-${tag}`,
      reason: 'HTTP synthetic arrival awaiting independent quality review',
      evidenceIds: [evidence.id],
      lines: [{ purchaseCommitmentLineId: purchaseLine.id, physical, storage: { location: `HTTP-${tag}`, warehouse: 'HTTP-WH', shelf: null } }],
    };
    const created = await request(app).post('/api/stock-receipts').set(authHeader(managerToken)).set('Idempotency-Key', `arrival-${tag}`)
      .send(body).expect(201);
    assertSuccess(created, 'HTTP arrival');
    assertNoCostKeys(created.body.data);
    const replay = await request(app).post('/api/stock-receipts').set(authHeader(managerToken)).set('Idempotency-Key', `arrival-${tag}`)
      .send(body).expect(201);
    assertSuccess(replay, 'HTTP arrival replay');
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.equal(replay.body.data.id, created.body.data.id);
    assertNoCostKeys(replay.body.data);
    const newLine = await db.stockReceiptLine.findFirst({ where: { receiptId: created.body.data.id }, orderBy: { lineNo: 'asc' } });
    assert.ok(newLine, 'HTTP arrival did not create a receipt line');
    const context = await request(app).get(`/api/stock-receipts/lines/${newLine.id}/review-context`).set(authHeader(qualityToken)).expect(200);
    assertSuccess(context, 'HTTP new review context');
    const reviewed = await request(app).post(`/api/stock-receipts/lines/${newLine.id}/review`).set(authHeader(qualityToken))
      .set('Idempotency-Key', `review-${tag}`).send({
        version: context.body.data.version,
        snapshotHash: context.body.data.snapshotHash,
        decision: 'ACCEPTED',
        reason: 'HTTP independent quality acceptance',
        checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
      }).expect(200);
    assertSuccess(reviewed, 'HTTP quality acceptance');
    assertNoCostKeys(reviewed.body.data);
    optionalChain = { status: 'PASS', receiptId: created.body.data.id, receiptLineId: newLine.id, evidenceId: evidence.id };
  }

  console.log(JSON.stringify({
    result: 'PASS', database: expectedDatabase, tag, fixtureReceiptId: fixture.id,
    orderId: fixture.purchaseCommitment.orderId, qualityUserId: quality.id, operatorUserId: operator.id,
    optionalArrivalQualityChain: optionalChain,
    checks: [
      'missing bearer token returns 401',
      'manager and quality receipt reads return operational data without cost fields',
      'quality review context is reachable with current order scope',
      'operator receipt write returns 403',
      'cost/status/id server-owned fields return 400',
      'missing Idempotency-Key returns 400',
      'revoked manager role makes the same token fail current authorization',
      ...(optionalEvidenceId ? ['real HTTP arrival, same-key replay, and independent ACCEPT review completed'] : ['no eligible CONFIRMED purchase remained; write chain intentionally not claimed']),
    ],
  }, null, 2));
  void appPrismaModule;
}

try {
  await main();
} finally {
  await db.$disconnect();
  const appPrisma = (await import('../lib/prisma.js')).default;
  await appPrisma.$disconnect();
}
