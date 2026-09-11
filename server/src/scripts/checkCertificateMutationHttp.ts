import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';

// Synthetic records only, in the explicitly named local trial clone. Preserve
// the resulting history as evidence; never modify an existing certificate.
const database = 'aerolink_trial_candidate_20260909';
if (process.env.AEROLINK_CERTIFICATE_HTTP_CHECK !== 'true' || !process.env.DATABASE_URL) {
  throw new Error('Explicit AEROLINK_CERTIFICATE_HTTP_CHECK=true and local trial DATABASE_URL required');
}
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '55970' || url.pathname !== `/${database}`) {
  throw new Error('Refusing to write outside the named local trial clone');
}
const tag = randomUUID().slice(0, 8);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = `synthetic-certificate-http-access-${randomUUID()}`;
process.env.JWT_REFRESH_SECRET = `synthetic-certificate-http-refresh-${randomUUID()}`;
const db = new PrismaClient();
const [{ default: router }, auth, { errorHandler }, { default: appDb }] = await Promise.all([
  import('../routes/certificates.js'), import('../middleware/auth.js'),
  import('../middleware/errorHandler.js'), import('../lib/prisma.js'),
]);
try {
  const actors = await Promise.all(['SALES', 'VIEWER', 'OPERATOR', 'QUALITY_MANAGER', 'ADMIN'].map(role => db.user.create({
    data: { email: `certificate-trial-${tag}-${role.toLowerCase()}@example.invalid`, name: `Synthetic ${role}`,
      password: 'unusable-synthetic-only', role, department: 'Synthetic trial' },
  })));
  const quality = actors.find(actor => actor.role === 'QUALITY_MANAGER')!;
  const tokens = new Map(actors.map(actor => [actor.role, auth.generateTokens(actor).accessToken]));
  const certificate = await db.certificate.create({ data: {
    certificateNumber: `SYNTHETIC-TRIAL-${tag}`, partNumber: `SYNTHETIC-PN-${tag}`,
    issuedBy: quality.name, issuedById: quality.id, certificateType: 'COC',
    expiryDate: new Date('2026-01-01T00:00:00.000Z'), fileHash: 'a'.repeat(64),
    traceHistory: JSON.stringify([{ action: 'SYNTHETIC_FIXTURE', tag }]),
  } });
  const app = express();
  app.use(express.json());
  app.use('/api/certificates', auth.authenticate, router);
  app.use(errorHandler);
  const post = (action: string, role: string, body: unknown) => request(app)
    .post(`/api/certificates/${certificate.id}/${action}`)
    .set('Authorization', `Bearer ${tokens.get(role)}`).send(body as object);

  await request(app).post(`/api/certificates/${certificate.id}/revoke`).send({ reason: 'Missing identity' }).expect(401);
  for (const role of ['SALES', 'VIEWER', 'OPERATOR']) {
    await post('revoke', role, { reason: 'Unauthorized attempt' }).expect(403);
    await post('renew', role, { newExpiryDate: '2099-01-01T00:00:00.000Z' }).expect(403);
  }
  for (const role of ['QUALITY_MANAGER', 'ADMIN']) {
    const response = await post('renew', role, { newExpiryDate: '2099-01-01T00:00:00.000Z' }).expect(409);
    assert.equal(response.body.code, 'QUALITY_EVIDENCE_REQUIRED');
  }
  for (const body of [{ reason: '' }, { reason: 'Forgery', userId: actors[0].id }, { reason: 'Forgery', status: 'ISSUED' }]) {
    await post('revoke', 'QUALITY_MANAGER', body).expect(400);
  }
  assert.deepEqual(await db.certificate.findUniqueOrThrow({ where: { id: certificate.id } }), certificate,
    'Rejected mutations changed the original certificate');

  // The same JWT must obey current role and token revocation, not its old role.
  await db.user.update({ where: { id: quality.id }, data: { role: 'VIEWER' } });
  await post('revoke', 'QUALITY_MANAGER', { reason: 'Role revoked' }).expect(403);
  await db.user.update({ where: { id: quality.id }, data: { role: 'QUALITY_MANAGER', tokenVersion: { increment: 1 } } });
  await post('revoke', 'QUALITY_MANAGER', { reason: 'Token revoked' }).expect(401);
  const currentQuality = await db.user.findUniqueOrThrow({ where: { id: quality.id } });
  tokens.set('QUALITY_MANAGER', auth.generateTokens(currentQuality).accessToken);

  const responses = await Promise.all([
    post('revoke', 'QUALITY_MANAGER', { reason: 'Synthetic source revoked A' }),
    post('revoke', 'ADMIN', { reason: 'Synthetic source revoked B' }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409],
    JSON.stringify(responses.map(response => ({ status: response.status, body: response.body }))));
  const after = await db.certificate.findUniqueOrThrow({ where: { id: certificate.id } });
  const history = JSON.parse(after.traceHistory) as Array<Record<string, unknown>>;
  assert.equal(after.status, 'REVOKED');
  assert.equal(after.fileHash, certificate.fileHash);
  assert.equal(after.expiryDate!.toISOString(), certificate.expiryDate!.toISOString());
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { action: 'SYNTHETIC_FIXTURE', tag });
  assert.equal(history[1].action, 'REVOKE');
  assert.ok([quality.id, actors.find(actor => actor.role === 'ADMIN')!.id].includes(history[1].userId as string));
  console.log(JSON.stringify({ status: 'PASS', database, tag, certificateId: certificate.id,
    checks: ['real JWT/current role', 'token revocation', 'unauthorized writes', 'renewal leaves evidence unchanged',
      'strict input', 'concurrent revoke has one winner', 'preserved history/hash/expiry'] }));
} finally {
  await Promise.all([db.$disconnect(), appDb.$disconnect()]);
}
