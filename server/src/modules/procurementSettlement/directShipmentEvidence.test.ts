import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

vi.mock('./directShipmentAccess.js', () => ({
  assertDirectShipmentOrderScope: vi.fn().mockResolvedValue({
    order: { id: 'order-1' },
    scope: { ownerId: 'sales-1', department: 'Sales' },
  }),
}));

import {
  assertCanReadDirectShipmentEvidence,
  bindDirectShipmentEvidence,
  validateDirectShipmentEvidence,
} from './directShipmentEvidence.js';

const hash = 'a'.repeat(64);
const manager = { id: 'manager-1', role: 'MANAGER', department: 'Operations' };
const quality = { id: 'quality-1', role: 'QUALITY_MANAGER', department: 'Quality' };

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1', ownerId: manager.id, domain: 'upload', resourceId: null,
    status: 'AVAILABLE', version: 1, sha256: hash, ...overrides,
  };
}

function txFor(files: unknown[], shipment: Record<string, unknown> = {}) {
  return {
    storedObject: {
      findMany: vi.fn().mockResolvedValue(files),
      findUnique: vi.fn().mockResolvedValue(files[0] ?? null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supplierDirectShipment: {
      findUnique: vi.fn().mockResolvedValue({ id: 'shipment-1', orderId: 'order-1', ...shipment }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ evidence: [], lines: [], events: [] }),
    },
  } as unknown as Prisma.TransactionClient;
}

describe('direct shipment evidence ACL', () => {
  beforeEach(() => vi.clearAllMocks());

  it('CAS-binds only the current owner’s unbound operational upload', async () => {
    const tx = txFor([file()]);
    const result = await bindDirectShipmentEvidence(tx, manager, 'shipment-1', ['file-1'], 'manage');
    expect(result).toEqual([{ id: 'file-1', version: 2, sha256: hash, status: 'AVAILABLE' }]);
    expect(tx.storedObject.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'file-1', ownerId: manager.id, version: 1, resourceId: null }),
      data: { domain: 'supplier_direct_shipment', resourceId: 'shipment-1', version: { increment: 1 } },
    }));
  });

  it('rejects purchase/cross-shipment objects even for an owner or manager', async () => {
    for (const bad of [
      file({ domain: 'purchase_commitment' }),
      file({ domain: 'supplier_direct_shipment', resourceId: 'other-shipment' }),
      file({ ownerId: 'other-user' }),
    ]) {
      const tx = txFor([bad]);
      await expect(bindDirectShipmentEvidence(tx, manager, 'shipment-1', ['file-1'], 'manage')).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
      expect(tx.storedObject.updateMany).not.toHaveBeenCalled();
    }
  });

  it('accepts an exact current fingerprint and rejects replay after version/hash/resource changes', async () => {
    const reference = [{ id: 'file-1', version: 2, sha256: hash, status: 'AVAILABLE' as const }];
    const tx = txFor([file({ domain: 'supplier_direct_shipment', resourceId: 'shipment-1', version: 2 })]);
    await expect(validateDirectShipmentEvidence(tx, quality, 'shipment-1', reference)).resolves.toEqual(reference);

    const stale = txFor([file({ domain: 'supplier_direct_shipment', resourceId: 'shipment-1', version: 3 })]);
    await expect(validateDirectShipmentEvidence(stale, quality, 'shipment-1', reference)).rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });

    const cross = txFor([file({ domain: 'supplier_direct_shipment', resourceId: 'other-shipment', version: 2 })]);
    await expect(validateDirectShipmentEvidence(cross, quality, 'shipment-1', reference)).rejects.toMatchObject({ code: 'QUALITY_EVIDENCE_INVALID' });
  });

  it('allows current scoped quality access only when the file is cited by immutable shipment evidence', async () => {
    const reference = { id: 'file-1', version: 2, sha256: hash, status: 'AVAILABLE' as const };
    const tx = txFor([file({ domain: 'supplier_direct_shipment', resourceId: 'shipment-1', version: 2 })]);
    (tx.supplierDirectShipment.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue({
      evidence: [reference], lines: [], events: [],
    });
    await expect(assertCanReadDirectShipmentEvidence(tx, quality, 'file-1')).resolves.toBeUndefined();

    const unreferenced = txFor([file({ domain: 'supplier_direct_shipment', resourceId: 'shipment-1', version: 2 })]);
    await expect(assertCanReadDirectShipmentEvidence(unreferenced, quality, 'file-1')).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    const ownerOnly = txFor([file({ domain: 'supplier_direct_shipment', resourceId: 'shipment-1', version: 2 })]);
    await expect(assertCanReadDirectShipmentEvidence(ownerOnly, { id: manager.id, role: 'SALES' }, 'file-1')).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });
});
