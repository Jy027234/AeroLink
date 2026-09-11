import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { buildPurchaseApprovalSnapshot } from './purchasePolicy.js';
import {
  assertPurchaseSourcesCurrent,
  bindPurchaseEvidence,
  resolvePurchaseLines,
  type PurchaseLineInput,
} from './purchaseSources.js';

const buyer = { id: 'buyer-1', role: 'purchasing_manager', department: 'procurement' };
const qualityActor = { id: 'quality-1', role: 'quality_manager', department: null };
const now = new Date('2026-09-09T00:00:00.000Z');

function orderLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-line-1', orderId: 'order-1', lineNo: 2, quotationLineId: 'quotation-line-1',
    partNumber: 'PN-1', uom: 'EA', quantity: 3, currency: 'USD', serialNumber: null, batchNumber: 'B-1',
    order: { id: 'order-1', quotationId: 'quotation-1', quotation: { id: 'quotation-1', rfqId: 'rfq-1' } },
    quotationLine: {
      id: 'quotation-line-1', quotationId: 'quotation-1', rfqLineId: 'rfq-line-1',
      partNumber: 'PN-1', quantity: 3, uom: 'EA', currency: 'USD', serialNumber: null, batchNumber: 'B-1',
      rfqLine: {
        id: 'rfq-line-1', rfqId: 'rfq-1', partNumber: 'PN-1', quantity: 3, uom: 'EA',
        conditionCode: 'NE', description: 'Synthetic part', serialNumber: null, batchNumber: 'B-1',
        alternatePartNumbers: JSON.stringify(['ALT-PN-1']), certificateRequired: false, certificateType: null,
        requiredDate: new Date('2026-09-20T00:00:00.000Z'),
      },
    },
    ...overrides,
  };
}

function supplierQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'supplier-quote-1', rfqId: 'rfq-1', rfqLineId: 'rfq-line-1', supplierId: 'supplier-1',
    partNumber: 'PN-1', quantity: 4, unitPriceDecimal: new Prisma.Decimal('10.1250'),
    currency: 'USD', currencyReviewStatus: 'VERIFIED', validUntil: new Date('2026-09-30T00:00:00.000Z'),
    status: 'pending', statusEnum: null,
    ...overrides,
  };
}

function storedFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE', ownerId: buyer.id,
    domain: null, resourceId: null, ...overrides,
  };
}

function txFixture(overrides: { line?: Record<string, unknown>; quote?: Record<string, unknown>; file?: Record<string, unknown> } = {}) {
  const file = storedFile(overrides.file);
  const tx: any = {
    orderLine: { findUnique: vi.fn().mockResolvedValue(orderLine(overrides.line)) },
    supplierQuote: { findUnique: vi.fn().mockResolvedValue(supplierQuote(overrides.quote)) },
    storedObject: {
      findMany: vi.fn().mockResolvedValue([file]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { tx, file };
}

function supplierInput(overrides: Partial<PurchaseLineInput> = {}): PurchaseLineInput {
  return {
    orderLineId: 'order-line-1',
    source: { type: 'SUPPLIER_QUOTE', supplierQuoteId: 'supplier-quote-1' },
    quantity: 2,
    promisedDate: '2026-09-25T00:00:00.000Z',
    fulfillmentMode: 'STOCK_RECEIPT',
    ...overrides,
  };
}

function manualInput(overrides: Partial<PurchaseLineInput> = {}): PurchaseLineInput {
  return {
    orderLineId: 'order-line-1',
    source: { type: 'MANUAL', unitCost: '9.5000', reason: '供应商邮件确认，待采购复核', evidenceFileIds: ['file-1'] },
    quantity: 2,
    promisedDate: '2026-09-25T00:00:00.000Z',
    fulfillmentMode: 'STOCK_RECEIPT',
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string) {
  try {
    action();
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('D14 purchase source resolver', () => {
  it('re-reads a supplier quote through the order, quotation, RFQ line chain and emits a policy-safe snapshot', async () => {
    const f = txFixture();
    const result = await resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', lines: [supplierInput()], now,
    });
    expect(result.currency).toBe('USD');
    expect(result.totalCost).toBe('20.2500');
    expect(result.lines[0]).toMatchObject({
      orderLineId: 'order-line-1', sourceSupplierQuoteId: 'supplier-quote-1',
      quantity: 2, unitCost: '10.1250', lineTotal: '20.2500', currency: 'USD', fulfillmentMode: 'STOCK_RECEIPT',
    });
    expect(result.lines[0].id).not.toBe('order-line-1');
    expect((result.lines[0].sourceSnapshot as any)).toMatchObject({
      type: 'SUPPLIER_QUOTE', id: 'supplier-quote-1', supplierId: 'supplier-1', rfqLineId: 'rfq-line-1',
      partNumber: 'PN-1', unitCost: '10.1250', currency: 'USD',
    });
    expect(buildPurchaseApprovalSnapshot({
      orderId: result.orderId, supplierId: result.supplierId, currency: result.currency,
      totalCost: result.totalCost, paymentTerms: null, lines: result.lines,
    })).toMatchObject({ orderId: 'order-1', supplierId: 'supplier-1', totalCost: '20.2500' });
  });

  it('rejects mismatched supplier, RFQ line, PN, status, expiry, quantity, and missing Decimal source', async () => {
    const cases: Array<{ quote: Record<string, unknown>; code: string }> = [
      { quote: { supplierId: 'other-supplier' }, code: 'RESOURCE_CONFLICT' },
      { quote: { rfqLineId: 'other-rfq-line' }, code: 'RESOURCE_CONFLICT' },
      { quote: { partNumber: 'OTHER-PN' }, code: 'RESOURCE_CONFLICT' },
      { quote: { status: 'rejected' }, code: 'RESOURCE_CONFLICT' },
      { quote: { validUntil: new Date('2026-09-01T00:00:00.000Z') }, code: 'RESOURCE_CONFLICT' },
      { quote: { quantity: 1 }, code: 'RESOURCE_CONFLICT' },
      { quote: { unitPriceDecimal: null }, code: 'RESOURCE_CONFLICT' },
    ];
    for (const item of cases) {
      const f = txFixture({ quote: item.quote });
      await expect(resolvePurchaseLines({
        tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', lines: [supplierInput()], now,
      })).rejects.toMatchObject({ code: item.code });
    }
  });

  it('keeps explicit RFQ alternate PN matching while requiring the supplier quote PN to equal the order line', async () => {
    const f = txFixture({ line: {
      partNumber: 'ALT-PN-1',
      quotationLine: {
        ...orderLine().quotationLine,
        partNumber: 'ALT-PN-1',
        rfqLine: { ...orderLine().quotationLine.rfqLine, partNumber: 'PN-1' },
      },
    }, quote: { partNumber: 'ALT-PN-1' } });
    const result = await resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', lines: [supplierInput()], now,
    });
    expect(result.lines[0].partNumber).toBe('ALT-PN-1');
  });

  it('binds manual evidence to a private purchase commitment domain with a CAS version bump', async () => {
    const f = txFixture();
    const result = await resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', purchaseCommitmentId: 'purchase-1',
      lines: [manualInput()], now,
    });
    expect(f.tx.storedObject.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'file-1', resourceId: null, version: 1 }),
      data: expect.objectContaining({ domain: 'purchase_commitment', resourceId: 'purchase-1', version: { increment: 1 } }),
    }));
    expect((result.lines[0].sourceSnapshot as any)).toMatchObject({
      type: 'MANUAL', id: null, supplierId: 'supplier-1', reason: '供应商邮件确认，待采购复核',
      evidence: [{ id: 'file-1', version: 2, sha256: 'a'.repeat(64), status: 'AVAILABLE' }],
    });
  });

  it('rejects manual evidence without a commitment id, wrong owner, or another resource binding', async () => {
    const missing = txFixture();
    await expect(resolvePurchaseLines({
      tx: missing.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', lines: [manualInput()], now,
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    const wrongOwner = txFixture({ file: { ownerId: 'someone-else' } });
    await expect(resolvePurchaseLines({
      tx: wrongOwner.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', purchaseCommitmentId: 'purchase-1',
      lines: [manualInput()], now,
    })).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    const otherResource = txFixture({ file: { domain: 'purchase_commitment', resourceId: 'other-purchase' } });
    await expect(bindPurchaseEvidence(otherResource.tx, buyer, ['file-1'], 'purchase-1'))
      .rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });

  it('allows an already bound file only for the same commitment and preserves its version', async () => {
    const f = txFixture({ file: { domain: 'purchase_commitment', resourceId: 'purchase-1', version: 3 } });
    const evidence = await bindPurchaseEvidence(f.tx, buyer, ['file-1'], 'purchase-1');
    expect(evidence).toEqual([{ id: 'file-1', version: 3, sha256: 'a'.repeat(64), status: 'AVAILABLE' }]);
    expect(f.tx.storedObject.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks supplier source facts immediately before submit or approval', async () => {
    const f = txFixture();
    const resolved = await resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', lines: [supplierInput()], now,
    });
    await expect(assertPurchaseSourcesCurrent({
      tx: f.tx, orderId: 'order-1', supplierId: 'supplier-1', purchaseCommitmentId: 'purchase-1', lines: resolved.lines, now,
    })).resolves.toBeUndefined();
    vi.mocked(f.tx.supplierQuote.findUnique).mockResolvedValue(supplierQuote({ unitPriceDecimal: new Prisma.Decimal('10.1251') }) as never);
    await expect(assertPurchaseSourcesCurrent({
      tx: f.tx, orderId: 'order-1', supplierId: 'supplier-1', purchaseCommitmentId: 'purchase-1', lines: resolved.lines, now,
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });

  it('rejects a changed order identity or RFQ constraint instead of reusing the old snapshot', async () => {
    const f = txFixture();
    const resolved = await resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', lines: [supplierInput()], now,
    });
    const changed = orderLine({
      batchNumber: 'B-2',
      quotationLine: {
        ...orderLine().quotationLine,
        batchNumber: 'B-2',
        rfqLine: { ...orderLine().quotationLine.rfqLine, batchNumber: 'B-2' },
      },
    });
    vi.mocked(f.tx.orderLine.findUnique).mockResolvedValue(changed as never);
    await expect(assertPurchaseSourcesCurrent({
      tx: f.tx, orderId: 'order-1', supplierId: 'supplier-1', purchaseCommitmentId: 'purchase-1', lines: resolved.lines, now,
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });

  it('rechecks manual evidence binding and exact fingerprints without requiring reviewer ownership', async () => {
    const f = txFixture();
    const resolved = await resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', purchaseCommitmentId: 'purchase-1',
      lines: [manualInput()], now,
    });
    vi.mocked(f.tx.storedObject.findMany).mockResolvedValue([storedFile({ version: 2, domain: 'purchase_commitment', resourceId: 'purchase-1' })] as never);
    await expect(assertPurchaseSourcesCurrent({
      tx: f.tx, orderId: 'order-1', supplierId: 'supplier-1', purchaseCommitmentId: 'purchase-1', lines: resolved.lines, now,
    })).resolves.toBeUndefined();
    vi.mocked(f.tx.storedObject.findMany).mockResolvedValue([storedFile({ version: 3, domain: 'purchase_commitment', resourceId: 'purchase-1' })] as never);
    await expect(assertPurchaseSourcesCurrent({
      tx: f.tx, orderId: 'order-1', supplierId: 'supplier-1', purchaseCommitmentId: 'purchase-1', lines: resolved.lines, now,
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    void qualityActor;
  });

  it('rejects duplicate source lines, unsupported currency, invalid quantity, and invalid date', async () => {
    const f = txFixture();
    await expect(resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', lines: [supplierInput(), supplierInput()], now,
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    await expect(resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1',
      lines: [manualInput({ source: { ...manualInput().source, currency: 'EUR' } as any })], now,
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    await expect(resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', purchaseCommitmentId: 'purchase-1',
      lines: [manualInput({ source: { ...manualInput().source, currency: null } as any })], now,
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    await expect(resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', lines: [supplierInput({ quantity: 0 })], now,
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    await expect(resolvePurchaseLines({
      tx: f.tx, actor: buyer, orderId: 'order-1', supplierId: 'supplier-1', lines: [supplierInput({ promisedDate: 'invalid' })], now,
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });
});
