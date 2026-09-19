import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { Prisma, PrismaClient } from '@prisma/client';

// Dedicated synthetic clone only. Preserve fixtures and failed attempts; never reset a database.
const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_SETTLEMENT_INTEGRATION !== 'true'
  || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '55970'
  || url.pathname !== '/aerolink_settlement_test_20260910') {
  throw new Error('Explicit opt-in and local aerolink_settlement_test_20260910:55970 required');
}
const tag = randomUUID().replaceAll('-', '').slice(0, 12);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= `settlement-access-${tag}`;
process.env.JWT_REFRESH_SECRET ||= `settlement-refresh-${tag}`;
const db = new PrismaClient();
const checks: string[] = [];
let disconnectApp: (() => Promise<void>) | undefined;
try {
  const purchase = await db.purchaseCommitment.findFirst({
    where: { status: { in: ['CONFIRMED', 'CLOSED'] }, currency: 'USD', totalCost: { gt: 1 },
      order: { lineItemsMode: true, totalAmountDecimal: { gt: 1 },
        status: { in: ['SO_CREATED', 'PO_CREATED', 'SHIPPED', 'DELIVERED'] }, settlementAccounts: { none: {} } } },
    orderBy: { createdAt: 'desc' }, include: { order: { include: { quotation: { include: { creator: true } } } } },
  });
  assert(purchase, 'Need an unused confirmed purchase + modern order in the direct-delivery clone');
  const order = purchase.order;
  const finance = await db.user.create({ data: { name: `Settlement finance ${tag}`, email: `settlement-${tag}@example.invalid`,
    password: 'synthetic-only', role: 'FINANCE', department: 'Finance' } });
  const outsider = await db.user.create({ data: { name: `Settlement other sales ${tag}`, email: `settlement-other-${tag}@example.invalid`,
    password: 'synthetic-only', role: 'SALES', department: 'Other' } });
  const [{ default: router }, auth, errors, prismaModule, files, legacy] = await Promise.all([
    import('../routes/settlements.js'), import('../middleware/auth.js'), import('../middleware/errorHandler.js'),
    import('../lib/prisma.js'), import('../routes/files.js'), import('../routes/legacyUploads.js'),
  ]);
  disconnectApp = () => prismaModule.default.$disconnect();
  const app = express();
  app.use(express.json());
  app.use('/api/settlements', auth.authenticate, router);
  app.use(errors.errorHandler);
  const financeToken = auth.generateTokens(finance).accessToken;
  const salesToken = auth.generateTokens(order.quotation.creator).accessToken;
  const outsiderToken = auth.generateTokens(outsider).accessToken;
  const actor = { id: finance.id, role: finance.role, department: finance.department };
  const proof = async (label: string) => db.storedObject.create({ data: {
    ownerId: finance.id, objectKey: `synthetic/settlement/${tag}/${label}-${randomUUID()}.pdf`,
    originalName: `${label}.pdf`, sizeBytes: 1, mimeType: 'application/pdf', status: 'AVAILABLE',
    sha256: createHash('sha256').update(`${tag}:${label}`).digest('hex'), metadata: { synthetic: true, tag },
  } });
  const metadata = async (label: string) => ({ externalSystem: 'SYNTHETIC-FINANCE', voucherNumber: `${tag}-${label}`,
    voucherLine: '1', reason: `Synthetic ${label}`, occurredAt: new Date(Date.now() - 1000).toISOString(), evidenceIds: [(await proof(label)).id] });
  const post = (path: string, body: object, key: string, token = financeToken) => request(app).post(`/api/settlements${path}`)
    .auth(token, { type: 'bearer' }).set('Idempotency-Key', key).send(body);
  const read = (path: string, token = financeToken) => request(app).get(`/api/settlements${path}`).auth(token, { type: 'bearer' });
  const ok = (response: request.Response, label: string, status = 201) => {
    assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.success, true, label);
    return response.body.data;
  };
  assert.equal((await request(app).get(`/api/settlements?orderId=${order.id}`)).status, 401);
  const openBody = { side: 'RECEIVABLE', orderId: order.id, dueDate: '2026-10-01T00:00:00.000Z', ...await metadata('open-ar') };
  assert.equal((await post('', openBody, `${tag}-sales`, salesToken)).status, 403);
  assert.equal((await request(app).post('/api/settlements').auth(financeToken, { type: 'bearer' }).send(openBody)).status, 400);
  assert.equal((await post('', { ...openBody, initialAmount: '1' }, `${tag}-forged`)).status, 400);
  let ar = ok(await post('', openBody, `${tag}-open-ar`), 'open receivable');
  assert.equal(ar.initialAmount, order.totalAmountDecimal!.toFixed(4));
  assert.equal(ok(await post('', openBody, `${tag}-open-ar`), 'open replay').id, ar.id);
  assert.equal(await db.settlementRecord.count({ where: { accountId: ar.id } }), 1);
  const ap = ok(await post('', { side: 'PAYABLE', orderId: order.id, purchaseCommitmentId: purchase.id,
    dueDate: openBody.dueDate, ...await metadata('open-ap') }, `${tag}-open-ap`), 'open payable');
  assert.equal(ap.initialAmount, purchase.totalCost.toFixed(4));
  const visible = ok(await read(`?orderId=${order.id}`, salesToken), 'sales list', 200);
  assert.equal(visible.accounts.length, 1);
  assert.equal(visible.accounts[0].id, ar.id);
  assert(!JSON.stringify(visible).includes(ap.id), 'sales response leaks payable ID');
  assert.equal((await read(`/${ap.id}`, salesToken)).status, 403);
  assert.equal((await read(`/${ar.id}`, outsiderToken)).status, 403);
  checks.push('source-derived AR/AP, mandatory idempotency, forged amount rejected, current order/cost scope');

  const paymentBody = { version: ar.version, kind: 'PAYMENT', amount: ar.initialAmount, ...await metadata('customer-payment') };
  ar = ok(await post(`/${ar.id}/records`, paymentBody, `${tag}-payment`), 'payment');
  assert.equal(ar.amounts.unpaid, '0.0000');
  assert.equal(ok(await post(`/${ar.id}/records`, paymentBody, `${tag}-payment`), 'payment replay').version, ar.version);
  assert.equal((await post(`/${ar.id}/records`, { ...paymentBody, amount: '0.01' }, `${tag}-payment`)).status, 409);
  const paidId = ar.records.find((row: { kind: string }) => row.kind === 'PAYMENT').id;
  ar = ok(await post(`/${ar.id}/records`, { version: ar.version, kind: 'CREDIT', amount: '1.0000',
    ...await metadata('credit') }, `${tag}-credit`), 'credit');
  assert.equal(ar.amounts.pendingRefund, '1.0000');
  ar = ok(await post(`/${ar.id}/records`, { version: ar.version, kind: 'REFUND', amount: '1.0000',
    ...await metadata('refund') }, `${tag}-refund`), 'refund');
  assert.equal(ar.amounts.pendingRefund, '0.0000');
  const refundId = ar.records.find((row: { kind: string }) => row.kind === 'REFUND').id;
  const beforeInvalid = ar.version;
  assert.equal((await post(`/${ar.id}/records`, { version: ar.version, kind: 'REVERSAL', reversalOfId: paidId,
    ...await metadata('invalid-payment-reversal') }, `${tag}-bad-reversal`)).status, 409);
  assert.equal((await db.settlementAccount.findUniqueOrThrow({ where: { id: ar.id } })).version, beforeInvalid);
  ar = ok(await post(`/${ar.id}/records`, { version: ar.version, kind: 'REVERSAL', reversalOfId: refundId,
    ...await metadata('refund-reversal') }, `${tag}-refund-reversal`), 'refund reversal');
  assert.equal(ar.amounts.pendingRefund, '1.0000');
  assert.equal((await post(`/${ar.id}/records`, { version: ar.version, kind: 'REVERSAL', reversalOfId: refundId,
    ...await metadata('duplicate-reversal') }, `${tag}-duplicate-reversal`)).status, 409);
  checks.push('payment → credit → refund → reversal balances; invalid and duplicate reversal rollback');

  const apFile = await db.storedObject.findUniqueOrThrow({ where: { id: ap.records[0].evidence[0].id } });
  assert.equal(await files.canReadStoredObjectDownload(db, apFile, actor), true);
  assert.equal(await files.canReadStoredObjectDownload(db, apFile, { ...actor, role: 'SALES' }), false);
  assert.equal(legacy.getLegacyUploadDecision(apFile, { id: finance.id, role: 'ADMIN' }), 'forbidden');
  const oldPaymentFile = await db.storedObject.findUniqueOrThrow({ where: { id: paymentBody.evidenceIds[0] } });
  await db.storedObject.update({ where: { id: oldPaymentFile.id }, data: { status: 'DELETED', version: { increment: 1 } } });
  const revoked = await db.storedObject.findUniqueOrThrow({ where: { id: oldPaymentFile.id } });
  assert.equal(await files.canReadStoredObjectDownload(db, revoked, actor), false);
  assert.equal(ok(await read(`/${ar.id}`), 'history after evidence revocation', 200).amounts.grossPaid, ar.initialAmount);
  ar = ok(await post(`/${ar.id}/records`, { version: ar.version, kind: 'TERMS', dueDate: '2026-11-01T00:00:00.000Z',
    ...await metadata('new-terms') }, `${tag}-terms`), 'terms with revoked historical evidence');
  checks.push('current proof ACL, legacy URL denial, revoked history preserves money and permits correction');

  const concurrentVersion = ar.version;
  const concurrentBodies = await Promise.all(['race-a', 'race-b'].map(async label => ({ version: concurrentVersion,
    kind: 'TERMS', dueDate: '2026-12-01T00:00:00.000Z', ...await metadata(label) })));
  const race = await Promise.all(concurrentBodies.map((body, index) => post(`/${ar.id}/records`, body, `${tag}-race-${index}`)));
  assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
  ar = ok(await read(`/${ar.id}`), 'after race', 200);
  assert.equal(ar.version, concurrentVersion + 1);
  const duplicateVoucherBody = { version: ar.version, kind: 'PAYMENT', amount: '1', ...await metadata('duplicate-voucher'),
    externalSystem: openBody.externalSystem, voucherNumber: openBody.voucherNumber, voucherLine: openBody.voucherLine };
  assert.equal((await post(`/${ar.id}/records`, duplicateVoucherBody, `${tag}-duplicate-voucher`)).status, 409);
  const unusedProof = await db.storedObject.findUniqueOrThrow({ where: { id: duplicateVoucherBody.evidenceIds[0] } });
  assert.equal(unusedProof.domain, null, 'failed voucher consumed proof');
  await db.user.update({ where: { id: finance.id }, data: { role: 'SALES' } });
  assert.equal((await post('', openBody, `${tag}-open-ar`)).status, 403, 'cached command bypassed role downgrade');
  await db.user.update({ where: { id: finance.id }, data: { role: 'FINANCE' } });
  checks.push('concurrent CAS single winner, duplicate voucher rollback, cached replay checks current role');

  const transact = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async tx => {
    const result = await run(tx);
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return result;
  });
  await assert.rejects(transact(tx => tx.settlementRecord.update({ where: { id: paidId }, data: { amount: '0.01' } })));
  await assert.rejects(transact(tx => tx.settlementRecord.delete({ where: { id: paidId } })));
  await assert.rejects(transact(tx => tx.settlementAccount.update({ where: { id: ar.id }, data: { initialAmount: '0' } })));
  await assert.rejects(transact(tx => tx.settlementAccount.update({ where: { id: ar.id }, data: { version: { increment: 1 } } })));
  const final = await db.settlementAccount.findUniqueOrThrow({ where: { id: ar.id }, include: { records: true } });
  assert.equal(final.version, final.records.length);
  assert.equal(final.initialAmount.toFixed(4), order.totalAmountDecimal!.toFixed(4));
  checks.push('SQL immutable records/base and deferred contiguous version invariant');
  console.log(JSON.stringify({ success: true, tag, database: url.pathname.slice(1), orderId: order.id,
    receivableId: ar.id, payableId: ap.id, version: final.version, checks,
    evidenceLimit: 'Synthetic stored-object metadata; no physical PDF download or financial UI exercised' }, null, 2));
} finally {
  await db.$disconnect();
  await disconnectApp?.();
}
