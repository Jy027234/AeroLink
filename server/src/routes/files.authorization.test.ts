import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/prisma.js', () => ({ default: { returnHold: { findFirst: vi.fn() } } }));
import prisma from '../lib/prisma.js';
import { canReadStoredObject, canReadReturnEvidence } from './files.js';

describe('stored object authorization', () => {
  it('allows the owner and privileged operators only', () => {
    expect(canReadStoredObject({ ownerId: 'user-1' }, { id: 'user-1', role: 'sales' })).toBe(true);
    expect(canReadStoredObject({ ownerId: 'user-1' }, { id: 'user-2', role: 'sales' })).toBe(false);
    expect(canReadStoredObject({ ownerId: null }, { id: 'user-2', role: 'sales' })).toBe(false);
    expect(canReadStoredObject({ ownerId: null }, { id: 'user-2', role: 'manager' })).toBe(true);
    expect(canReadStoredObject({ ownerId: null }, { id: 'user-2', role: 'ADMIN' })).toBe(true);
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
