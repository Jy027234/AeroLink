import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { assertRfqTransition, createRfqAggregate, toUiRfqStatus, updateRfqAggregate } from './service.js';

describe('rfqSourcing module policy', () => {
  it('allows legal RFQ transitions and projects enum values for UI', () => {
    expect(assertRfqTransition('PENDING', 'SOURCING')).toBe('SOURCING');
    expect(toUiRfqStatus('SOURCING')).toBe('sourcing');
  });

  it('rejects illegal transitions at the module boundary', () => {
    expect(() => assertRfqTransition('WON', 'PENDING')).toThrowError(/不能从/);
  });

  it('owns RFQ create/update writes and records the initial history in the same transaction client', async () => {
    const created = { id: 'rfq-1', status: 'PENDING', version: 1, customer: { id: 'c-1' }, partNumber: 'PN-1', quantity: 1, requiredDate: new Date('2026-10-01'), lines: [] };
    const txMock = {
      rFQ: {
        create: vi.fn().mockResolvedValue(created),
        findUnique: vi.fn().mockResolvedValue({ ...created, _count: { quotations: 0, inquiries: 0 } }),
        update: vi.fn().mockResolvedValue({ ...created, partNumber: 'PN-2', creator: { id: 'u-1', name: '经理' } }),
      },
      rfqLine: { upsert: vi.fn().mockResolvedValue({ id: 'line-1', partNumber: 'PN-2' }) },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue(undefined) },
    };
    const tx = txMock as unknown as Prisma.TransactionClient;

    const result = await createRfqAggregate(tx, { customerId: 'c-1', partNumber: 'PN-1', quantity: 1, createdBy: 'u-1', requiredDate: new Date() }, 'u-1');
    expect(result.id).toBe('rfq-1');
    expect(txMock.rFQ.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }));
    expect(txMock.transactionStatusHistory.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ entityType: 'RFQ', entityId: 'rfq-1' }) }));

    const updated = await updateRfqAggregate(tx, 'rfq-1', { partNumber: 'PN-2' });
    expect(updated.partNumber).toBe('PN-2');
    expect(txMock.rFQ.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'rfq-1', version: 1 }, data: { partNumber: 'PN-2', version: { increment: 1 } } }));
    expect(updated.lines[0].id).toBe('line-1');
  });

  it('keeps a quoted source immutable while allowing unchanged line fields in a notes edit', async () => {
    const stored = { id: 'r1', partNumber: 'P1', quantity: 1, version: 3, lines: [{ id: 'l1' }], _count: { quotations: 1, inquiries: 0 } };
    const update = vi.fn().mockResolvedValue(stored);
    const tx = { rFQ: { findUnique: vi.fn().mockResolvedValue(stored), update } } as unknown as Prisma.TransactionClient;
    await expect(updateRfqAggregate(tx, 'r1', { quantity: 2 })).rejects.toMatchObject({ code: 'RFQ_SOURCE_ALREADY_USED' });
    expect(update).not.toHaveBeenCalled();
    await expect(updateRfqAggregate(tx, 'r1', { partNumber: 'P1', quantity: 1, notes: 'Contact customer' })).resolves.toMatchObject({ id: 'r1' });
  });

  it('protects supplier-quoted demand and customer relationship changes', async () => {
    const update = vi.fn();
    const tx = { rFQ: { findUnique: vi.fn().mockResolvedValue({
      id: 'r1', customerId: 'c1', partNumber: 'P1', quantity: 1, version: 3,
      lines: [{ id: 'l1' }], _count: { quotations: 0, inquiries: 0, supplierQuotes: 1 },
    }), update } } as unknown as Prisma.TransactionClient;
    await expect(updateRfqAggregate(tx, 'r1', { partNumber: 'P2' })).rejects.toMatchObject({ code: 'RFQ_SOURCE_ALREADY_USED' });
    await expect(updateRfqAggregate(tx, 'r1', { customer: { connect: { id: 'c2' } } })).rejects.toMatchObject({ code: 'RFQ_SOURCE_ALREADY_USED' });
    expect(update).not.toHaveBeenCalled();
  });

  it('returns a version conflict when a concurrent edit wins the header update', async () => {
    const upsert = vi.fn();
    const tx = {
      rFQ: {
        findUnique: vi.fn().mockResolvedValue({ id: 'r1', version: 3, lines: [{ id: 'l1' }], _count: { quotations: 0, inquiries: 0, supplierQuotes: 0 } }),
        update: vi.fn().mockRejectedValue({ code: 'P2025' }),
      },
      rfqLine: { upsert },
    } as unknown as Prisma.TransactionClient;
    await expect(updateRfqAggregate(tx, 'r1', { notes: 'Concurrent edit' })).rejects.toMatchObject({ code: 'STATE_CONFLICT', statusCode: 409 });
    expect(upsert).not.toHaveBeenCalled();
  });
});
