import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { CapabilityActor } from '../../lib/capabilityPolicy.js';
import {
  assertCanReadSettlementEvidence,
  bindSettlementEvidence,
} from './settlementEvidence.js';

const hash = 'a'.repeat(64);
const finance: CapabilityActor = { id: 'finance-1', role: 'FINANCE', department: 'Finance' };
const salesOwner: CapabilityActor = { id: 'sales-owner', role: 'SALES', department: 'Sales' };

function fingerprint(overrides: Record<string, unknown> = {}) {
  return { id: 'file-1', version: 2, sha256: hash, status: 'AVAILABLE', ...overrides };
}

function storedObject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1', ownerId: finance.id, domain: 'upload', resourceId: null,
    version: 1, sha256: hash, status: 'AVAILABLE', ...overrides,
  };
}

function fixture(options: {
  object?: Record<string, unknown>;
  objects?: Record<string, unknown>[];
  account?: Record<string, unknown> | null;
  order?: Record<string, unknown>;
  updateCount?: number;
} = {}) {
  const findObject = vi.fn().mockResolvedValue(options.object ?? storedObject({ domain: 'settlement_account', resourceId: 'account-ap', version: 2 }));
  const findObjects = vi.fn().mockResolvedValue(options.objects ?? [storedObject()]);
  const updateMany = vi.fn().mockResolvedValue({ count: options.updateCount ?? 1 });
  const account = options.account ?? {
    orderId: 'order-1', side: 'PAYABLE', records: [{ evidence: [fingerprint()] }],
  };
  const findAccount = vi.fn().mockImplementation((args: { where: { id: string } }) => Promise.resolve(
    args.where.id === 'account-ap' ? account : null,
  ));
  const findOrder = vi.fn().mockResolvedValue(options.order ?? {
    id: 'order-1', orderNumber: 'SO-001', lineItemsMode: true, status: 'SO_CREATED', version: 1,
    totalAmountDecimal: { isFinite: () => true, isNegative: () => false }, customerId: 'customer-1', customer: { name: 'Customer' },
    quotation: { currency: 'USD', createdBy: salesOwner.id, creator: { department: 'Sales' } },
  });
  const tx = {
    storedObject: { findUnique: findObject, findMany: findObjects, updateMany },
    settlementAccount: { findUnique: findAccount },
    order: { findUnique: findOrder },
  } as unknown as Prisma.TransactionClient;
  return { tx, findObject, findObjects, updateMany, findAccount, findOrder };
}

describe('settlement evidence ownership and read ACL', () => {
  it('binds only the current owner’s unbound upload and records the incremented fingerprint', async () => {
    const f = fixture({ objects: [storedObject({ ownerId: finance.id })] });

    await expect(bindSettlementEvidence(f.tx, finance, 'account-ap', ['file-1']))
      .resolves.toEqual([{ id: 'file-1', version: 2, sha256: hash, status: 'AVAILABLE' }]);
    expect(f.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'file-1', ownerId: finance.id, resourceId: null, version: 1 }),
      data: { domain: 'settlement_account', resourceId: 'account-ap', version: { increment: 1 } },
    }));
  });

  it('does not let an upload owner bypass payable cost authorization when downloading', async () => {
    const f = fixture();

    await expect(assertCanReadSettlementEvidence(f.tx, {
      ...salesOwner,
      id: finance.id,
    }, 'file-1')).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    expect(f.findOrder).toHaveBeenCalled();
  });

  it('allows finance to download exact payable evidence but rejects a cross-order sales read', async () => {
    const allowed = fixture();
    await expect(assertCanReadSettlementEvidence(allowed.tx, finance, 'file-1')).resolves.toBeUndefined();

    const cross = fixture({ account: {
      orderId: 'other-order', side: 'RECEIVABLE', records: [{ evidence: [fingerprint()] }],
    }, order: {
      id: 'other-order', orderNumber: 'SO-OTHER', lineItemsMode: true, status: 'SO_CREATED', version: 1,
      totalAmountDecimal: { isFinite: () => true, isNegative: () => false }, customerId: 'customer-2', customer: { name: 'Other customer' },
      quotation: { currency: 'USD', createdBy: 'other-sales', creator: { department: 'Sales' } },
    } });
    await expect(assertCanReadSettlementEvidence(cross.tx, salesOwner, 'file-1'))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
  });

  it('rejects evidence after a version or hash change, and rejects rebound or revoked files', async () => {
    for (const changed of [
      { version: 3 },
      { sha256: 'b'.repeat(64) },
    ]) {
      const f = fixture({ object: storedObject({ domain: 'settlement_account', resourceId: 'account-ap', version: 2, ...changed }) });
      await expect(assertCanReadSettlementEvidence(f.tx, finance, 'file-1'))
        .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
    }
    for (const changed of [
      { status: 'REVOKED' },
      { resourceId: 'account-other' },
      { domain: 'purchase_commitment', resourceId: 'purchase-1' },
    ]) {
      const f = fixture({ object: storedObject({ domain: 'settlement_account', resourceId: 'account-ap', ...changed }) });
      await expect(assertCanReadSettlementEvidence(f.tx, finance, 'file-1'))
        .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    }
  });

  it('rejects a lost bind CAS and never claims a file twice', async () => {
    const lost = fixture({ updateCount: 0 });
    await expect(bindSettlementEvidence(lost.tx, finance, 'account-ap', ['file-1']))
      .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });

    const alreadyBound = fixture({ objects: [storedObject({ domain: 'settlement_account', resourceId: 'account-ap' })] });
    await expect(bindSettlementEvidence(alreadyBound.tx, finance, 'account-ap', ['file-1']))
      .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
    expect(alreadyBound.updateMany).not.toHaveBeenCalled();
  });
});
