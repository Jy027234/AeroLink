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
    const created = { id: 'rfq-1', status: 'PENDING', version: 1, customer: { id: 'c-1' } };
    const txMock = {
      rFQ: {
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn().mockResolvedValue({ ...created, partNumber: 'PN-2', creator: { id: 'u-1', name: '经理' } }),
      },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue(undefined) },
    };
    const tx = txMock as unknown as Prisma.TransactionClient;

    const result = await createRfqAggregate(tx, { customerId: 'c-1', partNumber: 'PN-1', quantity: 1, createdBy: 'u-1', requiredDate: new Date() }, 'u-1');
    expect(result.id).toBe('rfq-1');
    expect(txMock.rFQ.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }));
    expect(txMock.transactionStatusHistory.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ entityType: 'RFQ', entityId: 'rfq-1' }) }));

    const updated = await updateRfqAggregate(tx, 'rfq-1', { partNumber: 'PN-2' });
    expect(updated.partNumber).toBe('PN-2');
    expect(txMock.rFQ.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'rfq-1' }, data: { partNumber: 'PN-2' } }));
  });
});
