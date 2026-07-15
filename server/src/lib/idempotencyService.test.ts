import { beforeEach, describe, expect, it, vi } from 'vitest';

function createPrismaMock() {
  const tx = {
    idempotencyRecord: {
      create: vi.fn().mockResolvedValue({ id: 'idem-1' }),
      update: vi.fn().mockResolvedValue({ id: 'idem-1', status: 'COMPLETED' }),
    },
  };

  return {
    idempotencyRecord: {
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    __tx: tx,
  };
}

describe('idempotencyService', () => {
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let runIdempotentOperation: typeof import('./idempotencyService.js').runIdempotentOperation;

  beforeEach(async () => {
    vi.resetModules();
    prismaMock = createPrismaMock();
    vi.doMock('./prisma.js', () => ({ default: prismaMock }));
    ({ runIdempotentOperation } = await import('./idempotencyService.js'));
  });

  it('stores the first successful result in the same transaction as the business mutation', async () => {
    const operation = vi.fn().mockResolvedValue({
      payload: { id: 'rfq-1', status: 'pending' },
      statusCode: 201,
      resourceType: 'RFQ',
      resourceId: 'rfq-1',
    });

    const result = await runIdempotentOperation({
      actorId: 'user-1',
      scope: 'POST:/rfqs',
      key: 'create-rfq-001',
      requestHash: 'hash-001',
    }, operation as never);

    expect(result).toEqual({
      payload: { id: 'rfq-1', status: 'pending' },
      statusCode: 201,
      replayed: false,
      key: 'create-rfq-001',
    });
    expect(operation).toHaveBeenCalledWith(prismaMock.__tx);
    expect(prismaMock.__tx.idempotencyRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorId: 'user-1',
        scope: 'POST:/rfqs',
        idempotencyKey: 'create-rfq-001',
        requestHash: 'hash-001',
      }),
    }));
    expect(prismaMock.__tx.idempotencyRecord.update).toHaveBeenCalledWith({
      where: { id: 'idem-1' },
      data: expect.objectContaining({
        status: 'COMPLETED',
        responseStatus: 201,
        responseBody: JSON.stringify({ id: 'rfq-1', status: 'pending' }),
        resourceType: 'RFQ',
        resourceId: 'rfq-1',
      }),
    });
  });

  it('replays a completed response after a concurrent unique-key conflict', async () => {
    prismaMock.__tx.idempotencyRecord.create.mockRejectedValueOnce({ code: 'P2002' });
    prismaMock.idempotencyRecord.findFirst.mockResolvedValue({
      id: 'idem-1',
      requestHash: 'hash-001',
      status: 'COMPLETED',
      responseStatus: 202,
      responseBody: JSON.stringify({ outboundEmailId: 'mail-1', emailDeliveryStatus: 'queued' }),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const operation = vi.fn();

    const result = await runIdempotentOperation({
      actorId: 'user-1',
      scope: 'POST:/quotations/:id/send',
      key: 'send-q-001',
      requestHash: 'hash-001',
    }, operation as never);

    expect(result).toEqual({
      payload: { outboundEmailId: 'mail-1', emailDeliveryStatus: 'queued' },
      statusCode: 202,
      replayed: true,
      key: 'send-q-001',
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects use of the same key with a different request fingerprint', async () => {
    prismaMock.__tx.idempotencyRecord.create.mockRejectedValueOnce({ code: 'P2002' });
    prismaMock.idempotencyRecord.findFirst.mockResolvedValue({
      id: 'idem-1',
      requestHash: 'original-hash',
      status: 'COMPLETED',
      responseStatus: 201,
      responseBody: '{}',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(runIdempotentOperation({
      actorId: 'user-1',
      scope: 'POST:/rfqs',
      key: 'reused-key',
      requestHash: 'different-hash',
    }, vi.fn() as never)).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('propagates a business unique-key conflict instead of replaying it', async () => {
    const businessConflict = { code: 'P2002', meta: { target: ['orderNumber'] } };
    const operation = vi.fn().mockRejectedValue(businessConflict);

    await expect(runIdempotentOperation({
      actorId: 'user-1',
      scope: 'POST:/orders',
      key: 'create-order-001',
      requestHash: 'hash-001',
    }, operation as never)).rejects.toBe(businessConflict);

    expect(prismaMock.idempotencyRecord.findFirst).not.toHaveBeenCalled();
  });

  it('keeps existing clients compatible when no key is supplied', async () => {
    const operation = vi.fn().mockResolvedValue({ payload: { id: 'order-1' } });

    const result = await runIdempotentOperation({
      actorId: 'user-1',
      scope: 'POST:/orders',
      requestHash: 'hash-001',
    }, operation as never);

    expect(result).toMatchObject({ payload: { id: 'order-1' }, statusCode: 200, replayed: false });
    expect(prismaMock.__tx.idempotencyRecord.create).not.toHaveBeenCalled();
  });
});
