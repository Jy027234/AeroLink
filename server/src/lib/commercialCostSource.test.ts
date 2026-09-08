import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  assertQuotationMatchesRfq,
  captureQuotationCostSource,
  assertQuotationCostSourceCurrent,
  HISTORICAL_CURRENCY_STATUS,
} from './commercialCostSource.js';

const rfq = {
  partNumber: 'PN-1',
  quantity: 5,
  alternatePartNumbers: JSON.stringify(['PN-ALT']),
};

function manualQuotation(overrides: Record<string, unknown> = {}) {
  const snapshot = JSON.stringify({
    type: 'MANUAL',
    id: null,
    currency: 'USD',
    costPrice: 40,
    partNumber: 'PN-1',
    quantity: 2,
    status: null,
    supplierId: null,
    capturedAt: '2026-09-08T00:00:00.000Z',
    reason: '合同成本表 2026-09-08',
  });
  return {
    id: 'quotation-manual',
    rfqId: 'rfq-1',
    partNumber: 'PN-1',
    quantity: 2,
    costPrice: 40,
    costPriceDecimal: null,
    currency: 'USD',
    costSourceType: 'MANUAL',
    costSourceId: null,
    costSourceReason: '合同成本表 2026-09-08',
    costSourceSnapshotJson: snapshot,
    ...overrides,
  };
}

describe('commercial quotation cost source policy', () => {
  it('allows an explicit RFQ alternate part but rejects unrelated parts and excess quantity', () => {
    expect(() => assertQuotationMatchesRfq('PN-ALT', 5, rfq)).not.toThrow();
    expect(() => assertQuotationMatchesRfq('PN-OTHER', 1, rfq)).toThrow(/件号/);
    expect(() => assertQuotationMatchesRfq('PN-1', 6, rfq)).toThrow(/数量/);
  });

  it('requires an explicit reason for manual cost and captures an immutable USD snapshot', async () => {
    const tx = {} as Prisma.TransactionClient;
    await expect(captureQuotationCostSource({
      tx,
      rfqId: 'rfq-1',
      rfq,
      partNumber: 'PN-1',
      quantity: 2,
      costPrice: 40,
      currency: 'USD',
      costSourceType: 'MANUAL',
    })).rejects.toThrow(/原因/);

    const result = await captureQuotationCostSource({
      tx,
      rfqId: 'rfq-1',
      rfq,
      partNumber: 'PN-1',
      quantity: 2,
      costPrice: 40,
      currency: 'USD',
      costSourceType: 'MANUAL',
      costSourceReason: '合同成本表 2026-09-08',
    });
    expect(result.costSourceType).toBe('MANUAL');
    expect(JSON.parse(result.costSourceSnapshotJson).currency).toBe('USD');
    expect(JSON.parse(result.costSourceSnapshotJson).reason).toBe('合同成本表 2026-09-08');
  });

  it('fails closed for a historical supplier quote without verified USD facts', async () => {
    const tx = {
      supplierQuote: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'sq-old', rfqId: 'rfq-1', supplierId: 'supplier-1', partNumber: 'PN-1', quantity: 5,
          unitPrice: 40, unitPriceDecimal: null, currency: null, currencyReviewStatus: null,
          status: 'pending', statusEnum: 'PENDING',
        }),
      },
    } as unknown as Prisma.TransactionClient;

    await expect(captureQuotationCostSource({
      tx,
      rfqId: 'rfq-1',
      rfq,
      partNumber: 'PN-1',
      quantity: 2,
      costPrice: 40,
      currency: 'USD',
      costSourceType: 'SUPPLIER_QUOTE',
      costSourceId: 'sq-old',
    })).rejects.toThrow(/待核/);
    expect(HISTORICAL_CURRENCY_STATUS).toBe('HISTORICAL_UNVERIFIED');
  });

  it('excludes the current quotation reservation when checking inventory quantity', async () => {
    const tx = {
      inventoryDetail: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'inv-1', type: 'OWN', status: 'RESERVED', quantity: 5, unitCost: 40, supplierId: 'supplier-1',
          inventoryItem: { partNumber: 'PN-1' },
        }),
      },
      quotation: {
        findMany: vi.fn().mockResolvedValue([{ reservedQuantity: 3 }]),
      },
    } as unknown as Prisma.TransactionClient;

    const result = await captureQuotationCostSource({
      tx,
      rfqId: 'rfq-1',
      rfq,
      partNumber: 'PN-1',
      quantity: 2,
      costPrice: 40,
      currency: 'USD',
      costSourceType: 'INVENTORY_DETAIL',
      costSourceId: 'inv-1',
      quotationId: 'quotation-current',
    });
    expect(result.costSourceType).toBe('INVENTORY_DETAIL');
    expect(tx.quotation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { not: 'quotation-current' } }),
    }));
  });

  it('keeps a valid manual snapshot usable after source inventory changes', async () => {
    await expect(assertQuotationCostSourceCurrent({} as Prisma.TransactionClient, manualQuotation())).resolves.toBeUndefined();
  });
});
