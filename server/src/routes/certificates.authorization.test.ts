import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  actor: { id: 'quality-1', name: 'Quality reviewer', role: 'QUALITY_MANAGER', department: 'Quality' },
  prisma: {
    certificate: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  runIdempotentOperation: vi.fn(),
  buildIdempotencyContext: vi.fn(() => ({ key: 'certificate-command-1' })),
  applyIdempotencyHeaders: vi.fn(),
  storeCertificate: vi.fn(),
  enqueueBusinessEvent: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({ default: mocks.prisma }));
vi.mock('../lib/blockchain.js', () => ({ storeCertificate: mocks.storeCertificate }));
vi.mock('../lib/outboxService.js', () => ({ enqueueBusinessEvent: mocks.enqueueBusinessEvent }));
vi.mock('../lib/idempotencyService.js', () => ({
  applyIdempotencyHeaders: mocks.applyIdempotencyHeaders,
  buildIdempotencyContext: mocks.buildIdempotencyContext,
  runIdempotentOperation: mocks.runIdempotentOperation,
}));

import router from './certificates.js';
import { errorHandler } from '../middleware/errorHandler.js';

const updatedAt = new Date('2026-09-09T00:00:00.000Z');

function certificate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'certificate-1',
    certificateNumber: 'CERT-1',
    status: 'ISSUED',
    expiryDate: new Date('2026-09-01T00:00:00.000Z'),
    traceHistory: '[]',
    updatedAt,
    fileHash: 'a'.repeat(64),
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { user: mocks.actor });
    next();
  });
  app.use('/api/certificates', router);
  app.use(errorHandler);
  return app;
}

describe('certificate mutation authorization and CAS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor.id = 'quality-1';
    mocks.actor.name = 'Quality reviewer';
    mocks.actor.role = 'QUALITY_MANAGER';
    mocks.actor.department = 'Quality';
    mocks.prisma.$transaction.mockImplementation(async (operation: (tx: typeof mocks.prisma) => Promise<unknown>) => operation(mocks.prisma));
    mocks.runIdempotentOperation.mockImplementation(async (
      _context: unknown,
      operation: (tx: typeof mocks.prisma) => Promise<unknown>,
    ) => ({ statusCode: 200, payload: await operation(mocks.prisma), replayed: false }));
    mocks.prisma.certificate.findUnique.mockResolvedValue(certificate());
    mocks.prisma.certificate.findUniqueOrThrow.mockResolvedValue(certificate({ status: 'REVOKED' }));
    mocks.prisma.certificate.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.certificate.update.mockResolvedValue(certificate({ status: 'REVOKED' }));
  });

  it.each(['SALES', 'VIEWER', 'WAREHOUSE', 'CUSTOM_ROLE'])('denies %s on revoke and renew before any database read', async role => {
    mocks.actor.role = role;
    const app = buildApp();

    const revoke = await request(app)
      .post('/api/certificates/certificate-1/revoke')
      .set('Idempotency-Key', `revoke-${role}`)
      .send({ reason: 'invalid source' });
    const renew = await request(app)
      .post('/api/certificates/certificate-1/renew')
      .set('Idempotency-Key', `renew-${role}`)
      .send({ newExpiryDate: '2099-01-01T00:00:00.000Z', reason: 'replacement evidence pending' });

    expect(revoke.status).toBe(403);
    expect(revoke.body.code).toBe('AUTH_FORBIDDEN');
    expect(renew.status).toBe(403);
    expect(renew.body.code).toBe('AUTH_FORBIDDEN');
    expect(mocks.prisma.certificate.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.certificate.update).not.toHaveBeenCalled();
    expect(mocks.prisma.certificate.updateMany).not.toHaveBeenCalled();
  });

  it.each(['QUALITY_MANAGER', 'ADMIN'])('allows %s through the mutation capability but never revives an old hash with renew', async role => {
    mocks.actor.role = role;
    const app = buildApp();

    const response = await request(app)
      .post('/api/certificates/certificate-1/renew')
      .set('Idempotency-Key', `renew-${role}`)
      .send({ newExpiryDate: '2099-01-01T00:00:00.000Z', reason: 'old certificate renewal attempt' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('QUALITY_EVIDENCE_REQUIRED');
    expect(mocks.prisma.certificate.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.certificate.update).not.toHaveBeenCalled();
    expect(mocks.prisma.certificate.updateMany).not.toHaveBeenCalled();
  });

  it('requires a non-empty revoke reason before reading or mutating the certificate', async () => {
    const app = buildApp();

    const response = await request(app)
      .post('/api/certificates/certificate-1/revoke')
      .set('Idempotency-Key', 'revoke-missing-reason')
      .send({ reason: '   ' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(mocks.prisma.certificate.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.certificate.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'valid reason', userId: 'forged-user' },
    { reason: 'valid reason', status: 'ISSUED' },
    { reason: 'valid reason', updatedAt: updatedAt.toISOString() },
  ])('rejects client-owned revoke fields before any database access: %j', async body => {
    const app = buildApp();

    const response = await request(app)
      .post('/api/certificates/certificate-1/revoke')
      .set('Idempotency-Key', 'revoke-strict-body')
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(mocks.prisma.certificate.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.certificate.updateMany).not.toHaveBeenCalled();
  });

  it('lets a quality reviewer revoke with a strict CAS update', async () => {
    const oldHistory = [{ action: 'ISSUE', userId: 'issuer-1', reason: 'initial issue' }];
    mocks.prisma.certificate.findUnique.mockResolvedValue(certificate({ traceHistory: JSON.stringify(oldHistory) }));
    const app = buildApp();

    const response = await request(app)
      .post('/api/certificates/certificate-1/revoke')
      .set('Idempotency-Key', 'revoke-quality-1')
      .send({ reason: 'Source certificate was superseded' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: 'certificate-1', status: 'REVOKED' });
    expect(mocks.prisma.certificate.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'certificate-1', updatedAt, status: 'ISSUED' }),
    }));
    const updateArgs = mocks.prisma.certificate.updateMany.mock.calls[0][0] as { data: { traceHistory: string } };
    const nextHistory = JSON.parse(updateArgs.data.traceHistory) as Array<Record<string, unknown>>;
    expect(nextHistory[0]).toEqual(oldHistory[0]);
    expect(nextHistory.at(-1)).toMatchObject({
      action: 'REVOKE', userId: mocks.actor.id, userName: mocks.actor.name, reason: 'Source certificate was superseded',
    });
  });

  it('returns a state conflict and does not claim success when the revoke CAS loses a race', async () => {
    mocks.prisma.certificate.updateMany.mockResolvedValue({ count: 0 });
    const app = buildApp();

    const response = await request(app)
      .post('/api/certificates/certificate-1/revoke')
      .set('Idempotency-Key', 'revoke-cas-lost')
      .send({ reason: 'Concurrent revocation' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RESOURCE_CONFLICT');
  });
});
