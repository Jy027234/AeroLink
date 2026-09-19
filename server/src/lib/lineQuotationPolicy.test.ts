import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  assertCommercialApprovalSnapshotCurrent,
  assertLineCostSnapshot,
  buildCommercialApprovalSnapshot,
  captureQuotationLineCost,
  hashCommercialApprovalSnapshot,
  isCommercialApprovalSnapshotCurrent,
} from './lineQuotationPolicy.js';

const rfqLine = {
  id: 'rfq-line-1',
  rfqId: 'rfq-1',
  partNumber: 'PN-1',
  quantity: 5,
  alternatePartNumbers: JSON.stringify(['ALT-PN-1']),
};

function supplierQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'supplier-quote-1',
    rfqId: 'rfq-1',
    rfqLineId: 'rfq-line-1',
    partNumber: 'PN-1',
    quantity: 5,
    unitPrice: 40,
    unitPriceDecimal: '40.0000',
    currency: 'USD',
    currencyReviewStatus: 'VERIFIED',
    validUntil: new Date('2099-01-01T00:00:00.000Z'),
    status: 'pending',
    statusEnum: null,
    ...overrides,
  };
}

function sourceTx(
  source: Record<string, unknown>,
  lineCount = 1,
) {
  return {
    supplierQuote: {
      findUnique: vi.fn().mockResolvedValue(source),
    },
    rfqLine: {
      count: vi.fn().mockResolvedValue(lineCount),
      findFirst: vi.fn().mockResolvedValue({ id: rfqLine.id }),
    },
    inventoryDetail: {
      findUnique: vi.fn(),
    },
    quotation: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as any;
}

describe('line quotation cost and commercial approval policy', () => {
  it('rejects a supplier quote that belongs to another RFQ line', async () => {
    const tx = sourceTx(supplierQuote({ rfqLineId: 'rfq-line-2' }));

    await expect(captureQuotationLineCost({
      tx,
      rfqId: 'rfq-1',
      rfqLine,
      input: {
        partNumber: 'PN-1',
        quantity: 2,
        costPrice: 40,
        currency: 'USD',
        costSourceType: 'SUPPLIER_QUOTE',
        costSourceId: 'supplier-quote-1',
      },
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
    expect(tx.rfqLine.count).not.toHaveBeenCalled();
  });

  it('does not infer a legacy NULL source line from one supplier quote', async () => {
    const tx = sourceTx(supplierQuote({ rfqLineId: null }), 2);

    await expect(captureQuotationLineCost({
      tx,
      rfqId: 'rfq-1',
      rfqLine,
      input: {
        partNumber: 'PN-1',
        quantity: 2,
        costPrice: 40,
        currency: 'USD',
        costSourceType: 'SUPPLIER_QUOTE',
        costSourceId: 'supplier-quote-1',
      },
    })).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_CONFLICT' });
    expect(tx.rfqLine.count).toHaveBeenCalledWith({ where: { rfqId: 'rfq-1' } });
  });

  it('allows an explicitly clarified legacy source only for the unique RFQ line', async () => {
    const tx = sourceTx(supplierQuote({ rfqLineId: null, partNumber: 'ALT-PN-1' }), 1);
    const captured = await captureQuotationLineCost({
      tx,
      rfqId: 'rfq-1',
      rfqLine,
      input: {
        partNumber: 'ALT-PN-1',
        quantity: 2,
        costPrice: 40,
        currency: 'USD',
        costSourceType: 'SUPPLIER_QUOTE',
        costSourceId: 'supplier-quote-1',
      },
    });

    expect(captured.sourceSupplierQuoteId).toBe('supplier-quote-1');
    expect(JSON.parse(captured.costSourceSnapshotJson).partNumber).toBe('ALT-PN-1');
    expect(tx.rfqLine.findFirst).toHaveBeenCalledWith({
      where: { rfqId: 'rfq-1' },
      select: { id: true },
    });
  });

  it('keeps an approved line snapshot valid when reservation or acceptance changes', async () => {
    const tx = sourceTx({});
    const captured = await captureQuotationLineCost({
      tx,
      rfqId: 'rfq-1',
      rfqLine,
      input: {
        partNumber: 'PN-1',
        quantity: 2,
        costPrice: 40,
        currency: 'USD',
        costSourceType: 'MANUAL',
        costSourceReason: '合同成本表 D11',
      },
    });

    const line = {
      partNumber: 'PN-1',
      quantity: 2,
      costPrice: 40,
      currency: 'USD',
      costSourceType: 'MANUAL',
      costSourceId: null,
      costSourceReason: '合同成本表 D11',
      costSourceSnapshotJson: captured.costSourceSnapshotJson,
      reservedQuantity: 2,
      acceptedQuantity: 1,
      status: 'PARTIALLY_ACCEPTED',
    };

    expect(() => assertLineCostSnapshot(line)).not.toThrow();
    expect(() => assertLineCostSnapshot({ ...line, costPrice: 41 })).toThrowError(/成本与成本来源快照一致|快照/);
  });

  it('requires the supplier relation projection to match the captured source ID', async () => {
    const tx = sourceTx(supplierQuote());
    const captured = await captureQuotationLineCost({
      tx,
      rfqId: 'rfq-1',
      rfqLine,
      input: {
        partNumber: 'PN-1',
        quantity: 2,
        costPrice: 40,
        currency: 'USD',
        costSourceType: 'SUPPLIER_QUOTE',
        costSourceId: 'supplier-quote-1',
      },
    });
    const line = {
      partNumber: 'PN-1',
      quantity: 2,
      costPrice: new Prisma.Decimal('40.0000'),
      currency: 'USD',
      costSourceType: 'SUPPLIER_QUOTE',
      costSourceId: 'supplier-quote-1',
      sourceSupplierQuoteId: 'different-source',
      costSourceSnapshotJson: captured.costSourceSnapshotJson,
    };

    expect(() => assertLineCostSnapshot(line)).toThrowError(/供应商报价外键与成本来源 ID/);
    expect(() => assertLineCostSnapshot({
      ...line,
      costSourceType: 'MANUAL',
      costSourceId: null,
      sourceSupplierQuoteId: 'supplier-quote-1',
      costSourceReason: 'manual basis',
      costSourceSnapshotJson: JSON.stringify({
        type: 'MANUAL', id: null, currency: 'USD', costPrice: 40, partNumber: 'PN-1', quantity: 2,
        status: null, supplierId: null, capturedAt: '2026-09-08T00:00:00.000Z', reason: 'manual basis',
      }),
    })).toThrowError(/非供应商成本来源不能携带供应商报价外键/);
  });

  it('builds a canonical multi-line snapshot and excludes lifecycle fields', () => {
    const headerTerms = {
      quoteNumber: 'Q-1',
      currency: 'USD',
      totalPrice: '60.0000',
      version: 7,
      status: 'APPROVED',
      reservedQuantity: 3,
      validityDeadline: new Date('2026-12-01T00:00:00.000Z'),
    };
    const lines = [
      {
        id: 'line-2',
        lineNo: 2,
        partNumber: 'PN-2',
        quantity: 2,
        unitPrice: '20.0000',
        costPrice: '10.0000',
        marginAmount: '20.0000',
        marginPercent: '50.0000',
        status: 'PARTIALLY_ACCEPTED',
        reservedQuantity: 2,
        acceptedQuantity: 1,
        outboundQuantity: 1,
        version: 4,
      },
      {
        id: 'line-1',
        lineNo: 1,
        partNumber: 'PN-1',
        quantity: 1,
        unitPrice: '40.0000',
        costPrice: '20.0000',
        marginAmount: '20.0000',
        marginPercent: '50.0000',
        status: 'APPROVED',
        reservedQuantity: 1,
        acceptedQuantity: 0,
        outboundQuantity: 0,
        version: 3,
      },
    ];

    const snapshot = buildCommercialApprovalSnapshot({ headerTerms, lines });
    expect(snapshot.lines.map((line) => line.lineNo)).toEqual([1, 2]);
    expect(snapshot.headerTerms).not.toHaveProperty('version');
    expect(snapshot.headerTerms).not.toHaveProperty('status');
    expect(snapshot.lines[0]).not.toHaveProperty('reservedQuantity');
    expect(snapshot.lines[0]).not.toHaveProperty('acceptedQuantity');
    expect(snapshot.lines[0]).not.toHaveProperty('outboundQuantity');
    expect(snapshot.lines[0]).toMatchObject({ costPrice: 20, marginAmount: 20, marginPercent: 50 });

    const lifecycleChanged = buildCommercialApprovalSnapshot({
      headerTerms: { ...headerTerms, version: 99, status: 'ACCEPTED', reservedQuantity: 0 },
      lines: lines.map((line) => ({ ...line, version: 99, status: 'ACCEPTED', reservedQuantity: 0, acceptedQuantity: line.quantity, outboundQuantity: line.quantity })),
    });
    expect(isCommercialApprovalSnapshotCurrent(snapshot, lifecycleChanged)).toBe(true);

    const commercialChanged = buildCommercialApprovalSnapshot({
      headerTerms,
      lines: lines.map((line) => line.id === 'line-1' ? { ...line, unitPrice: '41.0000' } : line),
    });
    expect(isCommercialApprovalSnapshotCurrent(snapshot, commercialChanged)).toBe(false);
    expect(() => assertCommercialApprovalSnapshotCurrent(snapshot, {
      headerTerms,
      lines: lines.map((line) => line.id === 'line-1' ? { ...line, unitPrice: '41.0000' } : line),
    })).toThrowError(/需要重新审批/);
  });

  it('keeps the approval hash stable across Prisma Decimal JSON round trips', () => {
    const snapshot = buildCommercialApprovalSnapshot({
      headerTerms: { currency: 'USD', totalPrice: new Prisma.Decimal('60.0000') },
      lines: [{
        id: 'line-1',
        lineNo: 1,
        partNumber: 'PN-1',
        quantity: 2,
        unitPrice: new Prisma.Decimal('30.0000'),
        costPrice: new Prisma.Decimal('10.1250'),
        lineTotal: new Prisma.Decimal('60.0000'),
        marginAmount: new Prisma.Decimal('39.7500'),
        marginPercent: new Prisma.Decimal('66.2500'),
      }],
    });
    const restored = JSON.parse(JSON.stringify(snapshot));
    expect(hashCommercialApprovalSnapshot(restored)).toBe(hashCommercialApprovalSnapshot(snapshot));
  });
});
