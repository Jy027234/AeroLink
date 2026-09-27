import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { captureWinnerTargetVersion } from './sourcingWinnerTaskService.js';
import { prepareSupplierQuoteWinnerInTransaction } from './supplierQuoteSelectWinnerCommand.js';

vi.mock('./supplierQuoteSelectWinnerCommand.js', () => ({
  prepareSupplierQuoteWinnerInTransaction: vi.fn(),
  assertWinnerRfqReadAccess: vi.fn(),
}));

describe('staged winner source version', () => {
  const actor = { id: 'sales-1', email: 'sales@example.test', name: 'Sales', role: 'sales', department: 'Sales' };
  const quote = {
    id: 'quote-1', rfqId: 'rfq-1', rfqLineId: 'line-1', inquiryId: 'inquiry-1', inquiryItemId: 'item-1',
    supplierId: 'supplier-1', partNumber: 'PN-1', quantity: 2, quantityUnit: 'EA', unitPrice: 100,
    currency: 'USD', leadTimeDays: 5, validUntil: new Date('2026-12-01T00:00:00.000Z'),
    status: 'pending', isWinner: false, updatedAt: new Date('2026-09-26T00:00:00.000Z'), supersededAt: null,
  };

  it('changes when a related demand line changes without altering the quote row', async () => {
    vi.mocked(prepareSupplierQuoteWinnerInTransaction).mockResolvedValue({ quote } as never);
    const line = {
      id: 'line-1', rfqId: 'rfq-1', lineNo: 1, partNumber: 'PN-1', quantity: 4, uom: 'EA', status: 'OPEN',
      conditionCode: 'NE', certificateRequired: true, certificateType: null, alternatePartNumbers: null,
      updatedAt: new Date('2026-09-26T00:00:00.000Z'),
    };
    const tx = {
      supplierQuote: { findUnique: vi.fn().mockResolvedValue({ id: 'quote-1', rfqId: 'rfq-1', inquiry: { rfqId: 'rfq-1' } }) },
      inquiry: { findUnique: vi.fn().mockResolvedValue({ id: 'inquiry-1', rfqId: 'rfq-1', supplierId: 'supplier-1', status: 'SENT' }) },
      inquiryItem: { findUnique: vi.fn().mockResolvedValue({ id: 'item-1', inquiryId: 'inquiry-1', rfqLineId: 'line-1', partNumber: 'PN-1', quantity: 4 }) },
      rFQ: { findUnique: vi.fn().mockResolvedValue({ id: 'rfq-1', status: 'SOURCING', version: 2 }) },
      rfqLine: { findMany: vi.fn().mockResolvedValue([line]) },
    } as unknown as Prisma.TransactionClient;

    const first = await captureWinnerTargetVersion(tx, actor, quote.id);
    const repeated = await captureWinnerTargetVersion(tx, actor, quote.id);
    expect(repeated.targetVersion).toBe(first.targetVersion);
    expect(first.targetVersion).toMatch(/^[a-f0-9]{64}$/);

    vi.mocked(tx.rfqLine.findMany).mockResolvedValue([{ ...line, quantity: 5 }] as never);
    const changed = await captureWinnerTargetVersion(tx, actor, quote.id);
    expect(changed.targetVersion).not.toBe(first.targetVersion);
  });
});
