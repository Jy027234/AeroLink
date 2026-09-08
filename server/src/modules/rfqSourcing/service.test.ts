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

  it('creates three server-numbered lines and derives the legacy header from line one', async () => {
    const created = {
      id: 'rfq-multi',
      status: 'PENDING',
      version: 1,
      customer: { id: 'c-1' },
      partNumber: 'PN-1',
      quantity: 2,
      requiredDate: new Date('2026-10-01'),
      lines: [{ id: 'line-1', lineNo: 1 }, { id: 'line-2', lineNo: 2 }, { id: 'line-3', lineNo: 3 }],
    };
    const create = vi.fn().mockResolvedValue(created);
    const tx = {
      rFQ: { create },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Prisma.TransactionClient;

    await createRfqAggregate(tx, {
      customerId: 'c-1',
      createdBy: 'u-1',
      lines: [
        { partNumber: 'PN-1', quantity: 2, requiredDate: '2026-10-01', alternatePartNumbers: '["PN-1A"]' },
        { partNumber: 'PN-2', quantity: 4, requiredDate: '2026-10-02', alternatePartNumbers: '["PN-2A"]' },
        { partNumber: 'PN-3', quantity: 6, requiredDate: '2026-10-03' },
      ],
    } as never, 'u-1');

    const call = create.mock.calls[0][0];
    expect(call.data).toMatchObject({ partNumber: 'PN-1', quantity: 2, lineItemsMode: true });
    expect(call.data.lines.create).toHaveLength(3);
    expect(call.data.lines.create.map((line: { lineNo: number; partNumber: string }) => [line.lineNo, line.partNumber]))
      .toEqual([[1, 'PN-1'], [2, 'PN-2'], [3, 'PN-3']]);
    expect(call.data.lines.create[1].alternatePartNumbers).toBe('["PN-2A"]');
  });

  it('keeps lineItemsMode true for a modern RFQ that currently has one line', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'rfq-modern-one',
      status: 'PENDING',
      version: 1,
      customer: { id: 'c-1' },
      partNumber: 'PN-1',
      quantity: 2,
      requiredDate: new Date('2026-10-01'),
      lines: [{ id: 'line-1', lineNo: 1 }],
    });
    const tx = {
      rFQ: { create },
      transactionStatusHistory: { create: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Prisma.TransactionClient;

    await createRfqAggregate(tx, {
      customerId: 'c-1',
      createdBy: 'u-1',
      lines: [{ partNumber: 'PN-1', quantity: 2, requiredDate: '2026-10-01' }],
    } as never, 'u-1');

    expect(create.mock.calls[0][0].data.lineItemsMode).toBe(true);
  });

  it('keeps modern mode when a two-line RFQ is reduced to one line', async () => {
    const existing = {
      id: 'r-modern',
      version: 4,
      lineItemsMode: true,
      customerId: 'c-1',
      partNumber: 'PN-1',
      quantity: 2,
      uom: 'EA',
      conditionCode: 'NE',
      lines: [
        { id: 'l1', lineNo: 1, partNumber: 'PN-1', quantity: 2, uom: 'EA', conditionCode: 'NE', description: null, serialNumber: null, batchNumber: null, ataChapter: null, aircraftType: null, aircraftModel: null, alternatePartNumbers: null, certificateRequired: true, certificateType: null, requiredDate: new Date('2026-10-01'), leadTimeDays: null, targetPriceDecimal: null, targetPriceCurrency: 'USD', status: 'OPEN' },
        { id: 'l2', lineNo: 2, partNumber: 'PN-2', quantity: 1, uom: 'EA', conditionCode: 'NE', description: null, serialNumber: null, batchNumber: null, ataChapter: null, aircraftType: null, aircraftModel: null, alternatePartNumbers: null, certificateRequired: true, certificateType: null, requiredDate: new Date('2026-10-02'), leadTimeDays: null, targetPriceDecimal: null, targetPriceCurrency: 'USD', status: 'OPEN' },
      ],
      _count: { quotations: 0, inquiries: 0, supplierQuotes: 0 },
    };
    const update = vi.fn().mockResolvedValue({ ...existing, version: 5, lineItemsMode: true });
    const findLines = vi.fn()
      .mockResolvedValueOnce(existing.lines.map((line) => ({ id: line.id, _count: { inquiryItems: 0, supplierQuotes: 0, quotationLines: 0 } })))
      .mockResolvedValueOnce([{ ...existing.lines[0] }, { ...existing.lines[1], status: 'CANCELLED' }]);
    const tx = {
      rFQ: { findUnique: vi.fn().mockResolvedValue(existing), update },
      rfqLine: { findMany: findLines, update: vi.fn().mockResolvedValue(undefined), create: vi.fn() },
    } as unknown as Prisma.TransactionClient;

    const result = await updateRfqAggregate(tx, 'r-modern', {
      lines: [{ id: 'l1', partNumber: 'PN-1', quantity: 2, requiredDate: '2026-10-01' }],
    });

    expect(update.mock.calls[0][0].data.lineItemsMode).toBe(true);
    expect(result.lines[1].status).toBe('CANCELLED');
  });

  it('protects the customer on a complete modern line update after a quotation exists', async () => {
    const existing = {
      id: 'r-modern-customer',
      version: 4,
      lineItemsMode: true,
      customerId: 'c-1',
      partNumber: 'PN-1',
      quantity: 2,
      lines: [
        { id: 'l1', lineNo: 1, partNumber: 'PN-1', quantity: 2, uom: 'EA', conditionCode: 'NE', description: null, serialNumber: null, batchNumber: null, ataChapter: null, aircraftType: null, aircraftModel: null, alternatePartNumbers: null, certificateRequired: true, certificateType: null, requiredDate: new Date('2026-10-01'), leadTimeDays: null, targetPriceDecimal: null, targetPriceCurrency: 'USD', status: 'OPEN' },
        { id: 'l2', lineNo: 2, partNumber: 'PN-2', quantity: 1, uom: 'EA', conditionCode: 'NE', description: null, serialNumber: null, batchNumber: null, ataChapter: null, aircraftType: null, aircraftModel: null, alternatePartNumbers: null, certificateRequired: true, certificateType: null, requiredDate: new Date('2026-10-02'), leadTimeDays: null, targetPriceDecimal: null, targetPriceCurrency: 'USD', status: 'OPEN' },
      ],
      _count: { quotations: 1, inquiries: 0, supplierQuotes: 0 },
    };
    const update = vi.fn();
    const findLines = vi.fn();
    const tx = {
      rFQ: { findUnique: vi.fn().mockResolvedValue(existing), update },
      rfqLine: { findMany: findLines, update: vi.fn(), create: vi.fn() },
    } as unknown as Prisma.TransactionClient;

    await expect(updateRfqAggregate(tx, 'r-modern-customer', {
      customerId: 'c-2',
      lines: [
        { id: 'l1', partNumber: 'PN-1', quantity: 2, requiredDate: '2026-10-01' },
        { id: 'l2', partNumber: 'PN-2', quantity: 1, requiredDate: '2026-10-02' },
      ],
    } as never)).rejects.toMatchObject({ code: 'RFQ_SOURCE_ALREADY_USED', statusCode: 409 });
    expect(update).not.toHaveBeenCalled();
    expect(findLines).not.toHaveBeenCalled();
  });

  it('prevents mixing legacy quotations with a later modern RFQ conversion', async () => {
    const update = vi.fn();
    const tx = { rFQ: { update, findUnique: vi.fn().mockResolvedValue({
      id: 'legacy-rfq', customerId: 'c-1', lineItemsMode: false, lines: [],
      _count: { quotations: 1, inquiries: 0, supplierQuotes: 0 },
    }) } } as unknown as Prisma.TransactionClient;
    await expect(updateRfqAggregate(tx, 'legacy-rfq', {
      lines: [{ partNumber: 'PN-1', quantity: 2, requiredDate: '2026-10-01' }],
    })).rejects.toMatchObject({ statusCode: 409, code: 'RFQ_SOURCE_ALREADY_USED' });
    expect(update).not.toHaveBeenCalled();
  });

  it('does not revive a cancelled sourced line through an unchanged modern edit', async () => {
    const existing = {
      id: 'r-modern-closed-line',
      version: 2,
      lineItemsMode: true,
      customerId: 'c-1',
      lines: [{
        id: 'l-closed', lineNo: 1, partNumber: 'PN-CLOSED', quantity: 2, uom: 'EA', conditionCode: 'NE', description: null, serialNumber: null, batchNumber: null, ataChapter: null, aircraftType: null, aircraftModel: null, alternatePartNumbers: null, certificateRequired: true, certificateType: null, requiredDate: new Date('2026-10-01'), leadTimeDays: null, targetPriceDecimal: null, targetPriceCurrency: 'USD', status: 'CANCELLED',
      }],
      _count: { quotations: 0, inquiries: 0, supplierQuotes: 0 },
    };
    const update = vi.fn();
    const tx = {
      rFQ: { findUnique: vi.fn().mockResolvedValue(existing), update },
      rfqLine: {
        findMany: vi.fn().mockResolvedValue([{ id: 'l-closed', _count: { inquiryItems: 1, supplierQuotes: 0, quotationLines: 0 } }]),
        update: vi.fn(),
        create: vi.fn(),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(updateRfqAggregate(tx, 'r-modern-closed-line', {
      lines: [{ id: 'l-closed', partNumber: 'PN-CLOSED', quantity: 2, requiredDate: '2026-10-01' }],
    })).rejects.toMatchObject({ code: 'RFQ_SOURCE_ALREADY_USED', statusCode: 409 });
    expect(update).not.toHaveBeenCalled();
  });

  it('blocks editing a sourced line but allows adding an unsourced line in one transaction', async () => {
    const existing = {
      id: 'r1', version: 3, partNumber: 'PN-1', quantity: 2, uom: 'EA', conditionCode: 'NE',
      lines: [{ id: 'l1', lineNo: 1, partNumber: 'PN-1', quantity: 2, uom: 'EA', conditionCode: 'NE', description: null, serialNumber: null, batchNumber: null, ataChapter: null, aircraftType: null, aircraftModel: null, alternatePartNumbers: null, certificateRequired: true, certificateType: null, requiredDate: new Date('2026-10-01'), leadTimeDays: null, targetPriceDecimal: null, targetPriceCurrency: 'USD', status: 'OPEN' }],
      _count: { quotations: 0, inquiries: 0, supplierQuotes: 0 },
    };
    const tx = {
      rFQ: { findUnique: vi.fn().mockResolvedValue(existing), update: vi.fn().mockResolvedValue({ ...existing, lines: existing.lines }) },
      rfqLine: {
        findMany: vi.fn().mockResolvedValue([{ id: 'l1', _count: { inquiryItems: 1, supplierQuotes: 0, quotationLines: 0 } }]),
        update: vi.fn(),
        create: vi.fn(),
      },
    } as unknown as Prisma.TransactionClient;
    await expect(updateRfqAggregate(tx, 'r1', {
      lines: [{ id: 'l1', partNumber: 'PN-CHANGED', quantity: 2, requiredDate: '2026-10-01' }],
    })).rejects.toMatchObject({ code: 'RFQ_SOURCE_ALREADY_USED' });
    expect((tx as any).rFQ.update).not.toHaveBeenCalled();
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
