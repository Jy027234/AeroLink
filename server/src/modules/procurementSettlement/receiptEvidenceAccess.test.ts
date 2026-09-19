import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  assertCanReadReceiptEvidence,
  bindReceiptEvidence,
  readReceiptEvidence,
  type ReceiptStoredObject,
} from './receiptEvidenceAccess.js';

const hash = 'a'.repeat(64);
const manager = { id: 'inventory-1', role: 'manager', department: 'Operations' };
const quality = { id: 'quality-1', role: 'quality_manager', department: 'Quality' };
const owner = { id: 'receiver-1', role: 'manager', department: 'Operations' };

type StoredObjectRow = ReceiptStoredObject & { ownerId: string | null };

function row(overrides: Partial<StoredObjectRow> = {}): StoredObjectRow {
  return {
    id: 'file-1', version: 2, sha256: hash, status: 'AVAILABLE', ownerId: owner.id,
    domain: 'upload', resourceId: null, ...overrides,
  };
}

function fixture(options: {
  evidence?: unknown;
  objects?: StoredObjectRow[];
  updateCount?: number;
  createdBy?: string;
  department?: string;
} = {}) {
  const evidence = options.evidence ?? [];
  const findReceipt = vi.fn().mockResolvedValue({
    id: 'receipt-1', evidence,
    purchaseCommitment: { order: { id: 'order-1', quotation: {
      createdBy: options.createdBy ?? owner.id,
      creator: { department: options.department ?? 'Operations' },
    } } },
  });
  const findMany = vi.fn().mockResolvedValue(options.objects ?? [row()]);
  const updateMany = vi.fn().mockResolvedValue({ count: options.updateCount ?? 1 });
  const tx = { stockReceipt: { findUnique: findReceipt }, storedObject: { findMany, updateMany } } as unknown as Prisma.TransactionClient;
  return { tx, findReceipt, findMany, updateMany };
}

const fingerprint = (id = 'file-1', version = 3) => ({ id, version, sha256: hash, status: 'AVAILABLE' as const });

describe('receipt evidence binding and access', () => {
  it('requires inventory manage plus current order read scope before inspecting files', async () => {
    const f = fixture();
    await expect(bindReceiptEvidence(f.tx, quality, ['file-1'], 'receipt-1'))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    expect(f.findMany).not.toHaveBeenCalled();

    const wrongDepartment = fixture({ department: 'Other' });
    await expect(bindReceiptEvidence(wrongDepartment.tx, manager, ['file-1'], 'receipt-1'))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
  });

  it('claims only the current owner’s unbound ordinary upload with stock_receipt CAS', async () => {
    const f = fixture({ objects: [row({ version: 4, ownerId: manager.id })] });
    await expect(bindReceiptEvidence(f.tx, manager, ['file-1'], 'receipt-1'))
      .resolves.toEqual([{ id: 'file-1', version: 5, sha256: hash, status: 'AVAILABLE' }]);
    expect(f.updateMany).toHaveBeenCalledWith({
      where: { id: 'file-1', status: 'AVAILABLE', ownerId: manager.id, version: 4, resourceId: null, domain: 'upload' },
      data: { domain: 'stock_receipt', resourceId: 'receipt-1', version: { increment: 1 } },
    });
  });

  it('does not let admin, another owner, or a cost file enter the receipt domain', async () => {
    const admin = { id: 'admin-1', role: 'admin' };
    const adminFile = fixture({ objects: [row({ ownerId: owner.id })] });
    await expect(bindReceiptEvidence(adminFile.tx, admin, ['file-1'], 'receipt-1'))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });

    const other = fixture({ objects: [row({ ownerId: 'someone-else' })] });
    await expect(bindReceiptEvidence(other.tx, manager, ['file-1'], 'receipt-1'))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });

    const cost = fixture({ objects: [row({ ownerId: manager.id, domain: 'purchase_commitment', resourceId: 'purchase-1' })] });
    await expect(bindReceiptEvidence(cost.tx, manager, ['file-1'], 'receipt-1'))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUALITY_EVIDENCE_INVALID' });
    expect(cost.updateMany).not.toHaveBeenCalled();
  });

  it('rejects files already bound to any resource, stale or unavailable files, and a lost CAS', async () => {
    for (const invalid of [
      row({ ownerId: manager.id, domain: 'stock_receipt', resourceId: 'receipt-2' }),
      row({ ownerId: manager.id, domain: 'order', resourceId: 'order-1' }),
      row({ ownerId: manager.id, status: 'REVOKED' }),
      row({ ownerId: manager.id, version: 0 }),
      row({ ownerId: manager.id, sha256: 'bad' }),
    ]) {
      const f = fixture({ objects: [invalid] });
      await expect(bindReceiptEvidence(f.tx, manager, [invalid.id], 'receipt-1'))
        .rejects.toMatchObject({ statusCode: 409, code: 'QUALITY_EVIDENCE_INVALID' });
      expect(f.updateMany).not.toHaveBeenCalled();
    }

    const lost = fixture({ updateCount: 0, objects: [row({ ownerId: manager.id })] });
    await expect(bindReceiptEvidence(lost.tx, manager, ['file-1'], 'receipt-1'))
      .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
  });

  it('validates all files before claiming any and rejects duplicate or missing ids', async () => {
    const duplicate = fixture();
    await expect(bindReceiptEvidence(duplicate.tx, manager, ['file-1', ' file-1 '], 'receipt-1'))
      .rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
    expect(duplicate.findMany).not.toHaveBeenCalled();

    const partial = fixture({ objects: [row({ ownerId: manager.id })] });
    await expect(bindReceiptEvidence(partial.tx, manager, ['file-1', 'missing'], 'receipt-1'))
      .rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
    expect(partial.updateMany).not.toHaveBeenCalled();

    const two = fixture({ objects: [row({ id: 'file-1', ownerId: manager.id }), row({ id: 'file-2', ownerId: 'other' })] });
    await expect(bindReceiptEvidence(two.tx, manager, ['file-1', 'file-2'], 'receipt-1'))
      .rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(two.updateMany).not.toHaveBeenCalled();
  });

  it('reads only exact current AVAILABLE snapshots bound to this receipt', async () => {
    const f = fixture({ evidence: [fingerprint()] , objects: [row({ domain: 'stock_receipt', resourceId: 'receipt-1', version: 3 })] });
    await expect(readReceiptEvidence(f.tx, quality, 'receipt-1')).resolves.toEqual([fingerprint()]);
    expect(f.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['file-1'] } } }));

    const stale = fixture({ evidence: [fingerprint()], objects: [row({ domain: 'stock_receipt', resourceId: 'receipt-1', version: 4 })] });
    await expect(readReceiptEvidence(stale.tx, quality, 'receipt-1'))
      .rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
  });

  it('lets quality approve readers access logistics evidence without view_cost or uploader ownership', async () => {
    const f = fixture({ evidence: [fingerprint()] });
    const object = { ...row({ domain: 'stock_receipt', resourceId: 'receipt-1', version: 3 }), ownerId: 'receiver-2' };
    await expect(assertCanReadReceiptEvidence(f.tx, object, quality)).resolves.toEqual({ receiptId: 'receipt-1', orderId: 'order-1' });

    const finance = { id: 'finance-1', role: 'finance' };
    await expect(assertCanReadReceiptEvidence(f.tx, object, finance))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    const ownerOnly = { id: 'receiver-2', role: 'sales', department: 'Operations' };
    await expect(assertCanReadReceiptEvidence(f.tx, object, ownerOnly))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
  });

  it('does not permit cost-domain, cross-receipt, stale, revoked, or unreferenced objects to download', async () => {
    const f = fixture({ evidence: [fingerprint()] });
    const base = { ...row({ domain: 'stock_receipt', resourceId: 'receipt-1', version: 3 }) };
    for (const changed of [
      { domain: 'purchase_commitment', resourceId: 'purchase-1' },
      { resourceId: 'receipt-2' },
      { version: 4 },
      { sha256: 'b'.repeat(64) },
      { status: 'REVOKED' },
      { id: 'other-file' },
    ]) {
      await expect(assertCanReadReceiptEvidence(f.tx, { ...base, ...changed }, quality))
        .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    }
  });
});
