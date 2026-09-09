import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
vi.mock('../lib/prisma.js', () => ({ default: { returnHold: { findFirst: vi.fn() } } }));
import prisma from '../lib/prisma.js';
import { canReadStoredObject, canReadStoredObjectDownload, canReadReturnEvidence } from './files.js';

describe('stored object authorization', () => {
  it('allows the owner and privileged operators only', () => {
    expect(canReadStoredObject({ ownerId: 'user-1' }, { id: 'user-1', role: 'sales' })).toBe(true);
    expect(canReadStoredObject({ ownerId: 'user-1' }, { id: 'user-2', role: 'sales' })).toBe(false);
    expect(canReadStoredObject({ ownerId: null }, { id: 'user-2', role: 'sales' })).toBe(false);
    expect(canReadStoredObject({ ownerId: null }, { id: 'user-2', role: 'manager' })).toBe(true);
    expect(canReadStoredObject({ ownerId: null }, { id: 'user-2', role: 'ADMIN' })).toBe(true);
    expect(canReadStoredObject({ ownerId: 'user-1', domain: 'stock_receipt' }, { id: 'user-1', role: 'sales' })).toBe(false);
    expect(canReadStoredObject({ ownerId: null, domain: 'stock_receipt' }, { id: 'user-2', role: 'ADMIN' })).toBe(false);
  });
});

describe('dedicated receipt download authorization', () => {
  const hash = 'a'.repeat(64);
  const evidence = [{ id: 'proof', version: 3, sha256: hash, status: 'AVAILABLE' as const }];
  const receipt = { id: 'receipt-1', evidence, purchaseCommitment: { order: { id: 'order-1', quotation: {
    createdBy: 'sales-1', creator: { department: 'Sales' },
  } } } };
  const object = { id: 'proof', ownerId: 'other-user', domain: 'stock_receipt', resourceId: 'receipt-1', version: 3, sha256: hash, status: 'AVAILABLE' };

  it('uses receipt ACL and does not grant generic owner/admin access', async () => {
    const tx = {
      stockReceipt: { findUnique: vi.fn().mockResolvedValue(receipt) },
      storedObject: { findMany: vi.fn() },
    } as unknown as Prisma.TransactionClient;
    await expect(canReadStoredObjectDownload(tx, object, { id: 'quality-1', role: 'QUALITY_MANAGER' }))
      .resolves.toBe(true);
    await expect(canReadStoredObjectDownload(tx, object, { id: 'admin-1', role: 'ADMIN' }))
      .resolves.toBe(true);
    await expect(canReadStoredObjectDownload(tx, object, { id: 'other-user', role: 'SALES' }))
      .resolves.toBe(false);
  });

  it('does not let a purchase cost object fall through to receipt or generic ACL', async () => {
    const tx = {
      stockReceipt: { findUnique: vi.fn() },
      purchaseCommitment: { findUnique: vi.fn().mockResolvedValue(null) },
      storedObject: { findMany: vi.fn() },
    } as unknown as Prisma.TransactionClient;
    await expect(canReadStoredObjectDownload(tx, { ...object, domain: 'purchase_commitment', resourceId: 'purchase-1' }, { id: 'admin-1', role: 'ADMIN' }))
      .resolves.toBe(false);
    expect(tx.stockReceipt.findUnique).not.toHaveBeenCalled();
  });
});

describe('independent quality return evidence access', () => {
  const file = { id: 'proof', ownerId: 'receiver', domain: 'order', resourceId: 'order-1', version: 2, sha256: 'a'.repeat(64), status: 'AVAILABLE' };
  const quality = { id: 'quality', role: 'QUALITY_MANAGER' };
  beforeEach(() => vi.mocked(prisma.returnHold.findFirst).mockReset());
  it('allows quality to inspect evidence bound to the return and current order scope', async () => {
    vi.mocked(prisma.returnHold.findFirst).mockResolvedValue({ shipmentLine: { shipment: { order: {
      quotation: { createdBy: 'sales', creator: { department: 'Sales' } },
    } } } } as never);
    expect(await canReadReturnEvidence(file, quality)).toBe(true);
    expect(prisma.returnHold.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      evidence: { array_contains: [{ id: file.id, version: file.version, sha256: file.sha256, status: file.status }] },
      shipmentLine: { shipment: { orderId: 'order-1' } },
    } }));
  });
  it('does not grant quality access merely because a file is tagged with an order', async () => {
    vi.mocked(prisma.returnHold.findFirst).mockResolvedValue(null);
    expect(await canReadReturnEvidence(file, quality)).toBe(false);
  });
  it('rejects unbound files, revoked evidence and users without quality access', async () => {
    expect(await canReadReturnEvidence({ ...file, resourceId: null }, quality)).toBe(false);
    expect(await canReadReturnEvidence({ ...file, status: 'REVOKED' }, quality)).toBe(false);
    expect(await canReadReturnEvidence(file, { id: 'sales', role: 'SALES' })).toBe(false);
    expect(prisma.returnHold.findFirst).not.toHaveBeenCalled();
  });
});
