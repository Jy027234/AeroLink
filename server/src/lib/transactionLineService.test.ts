import { describe, expect, it, vi } from 'vitest';
import {
  assertSingleTransactionLineRequest,
  ensureSingleOrderLine,
  ensureSingleQuotationLine,
  syncQuotationLineSource,
  syncOrderLineState,
  syncQuotationLineState,
} from './transactionLineService.js';
import { quotationLineStatus, rfqLineStatus } from './transactionLineStateProjection.js';

const requiredDate = new Date('2026-10-01T00:00:00.000Z');

const rfq = {
  id: 'rfq-1', partNumber: 'P1', quantity: 10, uom: 'EA', conditionCode: 'NE', description: 'line',
  serialNumber: null, batchNumber: null, alternatePartNumbers: '["ALT-P1"]', certificateRequired: true,
  certificateType: null, requiredDate, leadTimeDays: 7, targetPrice: 12.5, targetPriceCurrency: 'USD',
  lines: [],
};
const rfqLine = {
  id: 'rfq-line-1', rfqId: 'rfq-1', lineNo: 1, partNumber: 'P1', quantity: 10, uom: 'EA', conditionCode: 'NE',
  description: 'line', serialNumber: null, batchNumber: null, alternatePartNumbers: '["ALT-P1"]', certificateRequired: true,
  certificateType: null, requiredDate, leadTimeDays: 7, targetPriceDecimal: '12.5000', targetPriceCurrency: 'USD', status: 'OPEN',
};
const quotation = {
  id: 'quotation-1', rfqId: 'rfq-1', partNumber: 'ALT-P1', quantity: 4, unitPrice: 3.25, unitPriceDecimal: '3.2500',
  totalPrice: 13, totalPriceDecimal: '13.0000', costPrice: 2, costPriceDecimal: '2.0000', currency: 'USD',
  status: 'APPROVED', reservedQuantity: 2, inventoryDetailId: 'detail-1', serialNumber: null, batchNumber: null,
};

function quotationLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'quotation-line-1', quotationId: 'quotation-1', lineNo: 1, rfqLineId: 'rfq-line-1', sourceSupplierQuoteId: null,
    partNumber: 'ALT-P1', description: 'line', uom: 'EA', quantity: 4, unitPrice: '3.2500', costPrice: '2.0000',
    lineTotal: '13.0000', marginAmount: '5.0000', marginPercent: '38.4615', currency: 'USD', status: 'APPROVED',
    acceptedQuantity: 0, reservedQuantity: 2, inventoryDetailId: 'detail-1', serialNumber: null, batchNumber: null,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1', orderNumber: 'SO-1', quotationId: 'quotation-1', partNumber: 'ALT-P1', quantity: 2,
    totalAmount: 6.5, totalAmountDecimal: '6.5000', status: 'SO_CREATED', outboundQuantity: 0, outboundStatus: 'PENDING',
    inventoryDetailId: 'detail-1', serialNumber: null, batchNumber: null, ...overrides,
  };
}

function createTx(options: { qLines?: unknown[]; orders?: unknown[]; oLines?: unknown[] } = {}) {
  const state = {
    qLines: [...(options.qLines ?? [])] as any[],
    orders: [...(options.orders ?? [])] as any[],
    oLines: [...(options.oLines ?? [])] as any[],
  };
  const tx = {
    rFQ: { findUnique: vi.fn().mockResolvedValue({ ...rfq, lines: [rfqLine] }) },
    rfqLine: {
      findMany: vi.fn().mockResolvedValue([rfqLine]),
      findUnique: vi.fn().mockResolvedValue(rfqLine),
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...rfqLine, ...data })),
    },
    supplierQuote: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    quotation: { findUnique: vi.fn().mockResolvedValue(quotation) },
    quotationLine: {
      findMany: vi.fn().mockImplementation(async () => state.qLines),
      findUnique: vi.fn().mockImplementation(async () => state.qLines[0] ?? null),
      create: vi.fn().mockImplementation(async ({ data }) => { const value = { ...quotationLine(), ...data }; state.qLines.push(value); return value; }),
      update: vi.fn().mockImplementation(async ({ where, data }) => { const current = state.qLines.find(line => line.id === where.id); Object.assign(current, data); return current; }),
    },
    order: {
      findFirst: vi.fn().mockImplementation(async () => state.orders[0] ?? null),
    },
    orderLine: {
      findMany: vi.fn().mockImplementation(async () => state.oLines),
      create: vi.fn().mockImplementation(async ({ data }) => { const value = { ...data }; state.oLines.push(value); return value; }),
      update: vi.fn().mockImplementation(async ({ where, data }) => { const current = state.oLines.find(line => line.id === where.id); Object.assign(current, data); return current; }),
    },
  };
  return { tx, state };
}

describe('transaction line service', () => {
  it('projects legacy header statuses into the line-table check values', () => {
    expect(rfqLineStatus('COMPLETED')).toBe('COMPLETED');
    expect(rfqLineStatus('won')).toBe('COMPLETED');
    expect(rfqLineStatus('lost')).toBe('CANCELLED');
    expect(quotationLineStatus('SENT', 0, 1)).toBe('APPROVED');
    expect(quotationLineStatus('WITHDRAWN', 0, 1)).toBe('CANCELLED');
  });

  it('creates a stable one-row quotation line and preserves an explicit alternate part', async () => {
    const { tx } = createTx();
    const result = await ensureSingleQuotationLine({ tx: tx as never, quotation, rfq });
    expect(result.created).toBe(true);
    expect(result.line).toMatchObject({ quotationId: 'quotation-1', lineNo: 1, rfqLineId: 'rfq-line-1', partNumber: 'ALT-P1', quantity: 4, currency: 'USD' });
    expect(tx.quotationLine.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ partNumber: 'ALT-P1', unitPrice: expect.anything(), lineTotal: expect.anything() }) }));
  });

  it('rejects missing Decimal shadows and existing commercial-line conflicts', async () => {
    const { tx } = createTx();
    await expect(ensureSingleQuotationLine({ tx: tx as never, quotation: { ...quotation, totalPriceDecimal: null }, rfq })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(tx.quotationLine.create).not.toHaveBeenCalled();

    const conflicting = quotationLine({ unitPrice: '9.0000' });
    const conflictTx = createTx({ qLines: [conflicting] });
    await expect(ensureSingleQuotationLine({ tx: conflictTx.tx as never, quotation, rfq })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(conflictTx.tx.quotationLine.update).not.toHaveBeenCalled();
  });

  it('rejects a target-price shadow mismatch and never guesses a requested missing RFQ line', async () => {
    const mismatch = createTx();
    await expect(ensureSingleQuotationLine({
      tx: mismatch.tx as never,
      quotation,
      rfq: { ...rfq, targetPrice: 99 },
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(mismatch.tx.rfqLine.create).not.toHaveBeenCalled();

    const missing = createTx();
    missing.tx.rfqLine.findMany.mockResolvedValue([]);
    missing.tx.rfqLine.findUnique.mockResolvedValue(null);
    await expect(ensureSingleQuotationLine({
      tx: missing.tx as never,
      quotation,
      rfq: { ...rfq, lines: [] },
      rfqLineId: 'rfq-line-that-is-not-there',
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(missing.tx.rfqLine.create).not.toHaveBeenCalled();
  });

  it('synchronizes quotation status and quantities without rewriting commercial facts', async () => {
    const existing = quotationLine({ status: 'DRAFT', acceptedQuantity: 0, reservedQuantity: 0, inventoryDetailId: null });
    const { tx } = createTx({ qLines: [existing], orders: [order()] });
    const result = await ensureSingleQuotationLine({ tx: tx as never, quotation: { ...quotation, status: 'ACCEPTED' }, rfq });
    expect(result.created).toBe(false);
    expect(tx.quotationLine.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: existing.id },
      data: expect.objectContaining({ status: 'PARTIALLY_ACCEPTED', acceptedQuantity: 2, reservedQuantity: 2, inventoryDetailId: 'detail-1' }),
    }));
  });

  it('creates one order line, synchronizes accepted quantity, and rejects amount conflicts', async () => {
    const qLine = quotationLine();
    const { tx } = createTx({ qLines: [qLine], orders: [order()] });
    const result = await ensureSingleOrderLine({ tx: tx as never, order: order(), quotation, quotationLine: qLine as never });
    expect(result.created).toBe(true);
    expect(result.line).toMatchObject({ orderId: 'order-1', quotationLineId: qLine.id, partNumber: 'ALT-P1', quantity: 2, lineTotal: expect.anything() });
    expect(tx.quotationLine.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ acceptedQuantity: 2 }) }));

    const bad = createTx({ qLines: [qLine], orders: [order()] });
    await expect(ensureSingleOrderLine({ tx: bad.tx as never, order: order({ totalAmount: 99 }), quotation, quotationLine: qLine as never })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(bad.tx.orderLine.create).not.toHaveBeenCalled();
  });

  it('rejects multi-line requests and existing multi-line lifecycle state', async () => {
    expect(() => assertSingleTransactionLineRequest([{ lineNo: 1 }, { lineNo: 2 }], '报价')).toThrowError(expect.objectContaining({ code: 'LINE_ID_REQUIRED' }));
    const { tx } = createTx({ qLines: [quotationLine(), quotationLine({ id: 'quotation-line-2', lineNo: 2 })] });
    await expect(ensureSingleQuotationLine({ tx: tx as never, quotation, rfq })).rejects.toMatchObject({ code: 'LINE_ID_REQUIRED' });
  });

  it('synchronizes lifecycle state and leaves missing historical lines untouched', async () => {
    const qLine = quotationLine({ acceptedQuantity: 0, reservedQuantity: 0 });
    const oLine = { id: 'order-line-1', orderId: 'order-1', lineNo: 1, quotationLineId: qLine.id, partNumber: 'ALT-P1', uom: 'EA', quantity: 2, unitPrice: '3.2500', lineTotal: '6.5000', currency: 'USD', outboundQuantity: 0, outboundStatus: 'PENDING', inventoryDetailId: 'detail-1', serialNumber: null, batchNumber: null };
    const { tx } = createTx({ qLines: [qLine], orders: [order()], oLines: [oLine] });
    await syncQuotationLineState(tx as never, quotation);
    expect(tx.quotationLine.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ acceptedQuantity: 2, reservedQuantity: 2 }) }));
    await syncOrderLineState(tx as never, order({ outboundQuantity: 1, outboundStatus: 'PARTIAL' }));
    expect(tx.orderLine.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outboundQuantity: 1, outboundStatus: 'PARTIAL' }) }));

    const empty = createTx();
    await expect(syncQuotationLineState(empty.tx as never, quotation)).resolves.toBeNull();
  });

  it('does not revalidate live supplier-quote quantity during an approved lifecycle transition', async () => {
    const sourceLine = quotationLine({ sourceSupplierQuoteId: 'supplier-quote-1' });
    const { tx } = createTx({ qLines: [sourceLine], orders: [order()] });
    tx.supplierQuote.findUnique.mockResolvedValue({
      id: 'supplier-quote-1', rfqId: 'rfq-1', rfqLineId: 'rfq-line-1', partNumber: 'ALT-P1', quantity: 1,
    });

    await expect(syncQuotationLineState(tx as never, {
      ...quotation,
      costSourceType: 'SUPPLIER_QUOTE',
      costSourceId: 'supplier-quote-1',
    })).resolves.toBeTruthy();
    expect(tx.supplierQuote.findUnique).not.toHaveBeenCalled();
  });

  it('allows a validated approval source replacement to update only the source projection', async () => {
    const sourceLine = quotationLine();
    const { tx } = createTx({ qLines: [sourceLine] });
    tx.supplierQuote.findUnique.mockResolvedValue({
      id: 'supplier-quote-2', rfqId: 'rfq-1', rfqLineId: 'rfq-line-1', partNumber: 'ALT-P1', quantity: 4,
    });

    await syncQuotationLineSource(tx as never, quotation, 'supplier-quote-2');
    expect(tx.quotationLine.update).toHaveBeenCalledWith({
      where: { id: sourceLine.id },
      data: { sourceSupplierQuoteId: 'supplier-quote-2' },
    });
  });
});
