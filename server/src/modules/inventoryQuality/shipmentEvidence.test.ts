import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { bindShipmentEvidence } from './shipmentEvidence.js';

const actor = { id: 'u-1', role: 'manager' };
const admin = { id: 'admin-1', role: 'admin' };
const hash = 'a'.repeat(64);

type StoredObjectRow = {
  id: string;
  version: number;
  sha256: string;
  status: string;
  ownerId: string | null;
  domain: string | null;
  resourceId: string | null;
};

function row(overrides: Partial<StoredObjectRow> = {}): StoredObjectRow {
  return {
    id: 'file-1',
    version: 2,
    sha256: hash,
    status: 'AVAILABLE',
    ownerId: actor.id,
    domain: null,
    resourceId: null,
    ...overrides,
  };
}

function fixture(rows: StoredObjectRow[], updateCount = 1) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const updateMany = vi.fn().mockResolvedValue({ count: updateCount });
  const tx = { storedObject: { findMany, updateMany } } as unknown as Prisma.TransactionClient;
  return { tx, findMany, updateMany };
}

describe('bindShipmentEvidence', () => {
  it('requires at least one distinct evidence id', async () => {
    const empty = fixture([]);
    await expect(bindShipmentEvidence(empty.tx, actor, [], 'order-1'))
      .rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
    expect(empty.findMany).not.toHaveBeenCalled();

    const duplicate = fixture([]);
    await expect(bindShipmentEvidence(duplicate.tx, actor, ['file-1', ' file-1 '], 'order-1'))
      .rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
    expect(duplicate.findMany).not.toHaveBeenCalled();
  });

  it('rejects missing, unavailable, stale, or non-64-hex documents', async () => {
    for (const invalid of [
      row({ status: 'REVOKED' }),
      row({ version: 0 }),
      row({ sha256: 'not-a-sha256' }),
    ]) {
      const f = fixture([invalid]);
      await expect(bindShipmentEvidence(f.tx, actor, [invalid.id], 'order-1'))
        .rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
      expect(f.updateMany).not.toHaveBeenCalled();
    }

    const missing = fixture([]);
    await expect(bindShipmentEvidence(missing.tx, actor, ['file-1'], 'order-1'))
      .rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
  });

  it('requires the current owner for a first binding, including admin', async () => {
    const otherOwner = fixture([row({ ownerId: 'u-2' })]);
    await expect(bindShipmentEvidence(otherOwner.tx, actor, ['file-1'], 'order-1'))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });

    const adminCannotClaim = fixture([row({ ownerId: actor.id })]);
    await expect(bindShipmentEvidence(adminCannotClaim.tx, admin, ['file-1'], 'order-1'))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    expect(adminCannotClaim.updateMany).not.toHaveBeenCalled();
  });

  it('claims an unbound document with a versioned order-scope CAS', async () => {
    const f = fixture([row({ version: 3 })]);
    await expect(bindShipmentEvidence(f.tx, actor, ['file-1'], 'order-1')).resolves.toEqual([
      { id: 'file-1', version: 4, sha256: hash, status: 'AVAILABLE' },
    ]);
    expect(f.updateMany).toHaveBeenCalledWith({
      where: { id: 'file-1', status: 'AVAILABLE', ownerId: 'u-1', version: 3, resourceId: null },
      data: { domain: 'order', resourceId: 'order-1', version: { increment: 1 } },
    });
  });

  it('leaves a document bound to this order unchanged and permits reuse by its owner in another role', async () => {
    const f = fixture([row({ ownerId: 'u-1', domain: 'orders', resourceId: 'order-1', version: 7 })]);
    await expect(bindShipmentEvidence(f.tx, { id: 'u-1', role: 'quality_manager' }, ['file-1'], 'order-1'))
      .resolves.toEqual([{ id: 'file-1', version: 7, sha256: hash, status: 'AVAILABLE' }]);
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it('does not let another user reuse an already order-scoped document through a new submission', async () => {
    const f = fixture([row({ ownerId: 'u-1', domain: 'order', resourceId: 'order-1' })]);
    await expect(bindShipmentEvidence(f.tx, { id: 'u-2', role: 'manager' }, ['file-1'], 'order-1'))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an attachment already scoped to another order or domain', async () => {
    const otherOrder = fixture([row({ domain: 'order', resourceId: 'order-2' })]);
    await expect(bindShipmentEvidence(otherOrder.tx, actor, ['file-1'], 'order-1'))
      .rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
    expect(otherOrder.updateMany).not.toHaveBeenCalled();

    const wrongDomain = fixture([row({ domain: 'quotation', resourceId: 'order-1' })]);
    await expect(bindShipmentEvidence(wrongDomain.tx, actor, ['file-1'], 'order-1'))
      .rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
    expect(wrongDomain.updateMany).not.toHaveBeenCalled();
  });

  it('rejects when the first-binding CAS loses a concurrent claim', async () => {
    const f = fixture([row()], 0);
    await expect(bindShipmentEvidence(f.tx, actor, ['file-1'], 'order-1'))
      .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
    expect(f.updateMany).toHaveBeenCalledTimes(1);
  });

  it('validates every row before claiming any document', async () => {
    const f = fixture([row({ id: 'file-1' }), row({ id: 'file-2', ownerId: 'u-2' })]);
    await expect(bindShipmentEvidence(f.tx, actor, ['file-1', 'file-2'], 'order-1'))
      .rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(f.updateMany).not.toHaveBeenCalled();
  });
});
