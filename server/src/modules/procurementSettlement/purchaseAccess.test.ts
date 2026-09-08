import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { getOrderPurchaseCommitments, getPurchaseCommitment } from './purchaseAccess.js';

function fixture() {
  const purchase = { id: 'purchase', commitmentNumber: 'PC1', orderId: 'order', supplierId: 'supplier', supplier: { name: 'Supplier' },
    status: 'CONFIRMED', version: 1, currency: 'USD', totalCost: new Prisma.Decimal('5000.0001'),
    paymentTerms: 'sensitive terms', supplierReferenceNo: 'SUPPLIER-PO-SECRET',
    approvalSnapshot: { totalCost: '5000.0001' }, confirmationEvidence: { price: 'secret' },
    lines: [{ id: 'line', lineNo: 1, orderLineId: 'order-line', partNumber: 'PN1', uom: 'EA', quantity: 1,
      cancelledQuantity: 0, receivedQuantity: 0, directShippedQuantity: 0, version: 1,
      promisedDate: new Date('2027-01-01'), fulfillmentMode: 'STOCK_RECEIPT', currency: 'USD',
      unitCost: new Prisma.Decimal('5000.0001'), lineTotal: new Prisma.Decimal('5000.0001'),
      sourceSupplierQuoteId: 'source', sourceSnapshot: { cost: 'secret' } }] };
  const order = { id: 'order', lineItemsMode: true, status: 'SO_CREATED', version: 1,
    quotation: { createdBy: 'sales', creator: { department: 'Sales' } } };
  const mocks = { order: { findUnique: vi.fn().mockResolvedValue(order) },
    purchaseCommitment: { findMany: vi.fn().mockResolvedValue([purchase]), findUnique: vi.fn().mockResolvedValue(purchase) } };
  return { tx: mocks as unknown as Prisma.TransactionClient, mocks, order };
}
describe('purchase views and current scope', () => {
  it.each([{ id: 'sales', role: 'SALES' }, { id: 'quality', role: 'QUALITY_MANAGER' }, { id: 'warehouse', role: 'OPERATOR' }])
  ('returns operational quantities without procurement cost for $role', async actor => {
    const f = fixture();
    const result = await getOrderPurchaseCommitments({ tx: f.tx, actor, orderId: 'order' });
    expect(result.purchases[0].lines[0]).toMatchObject({ quantity: 1, receivedQuantity: 0, partNumber: 'PN1' });
    expect(JSON.stringify(result)).not.toMatch(/unitCost|totalCost|lineTotal|sourceSnapshot|approvalSnapshot|confirmationEvidence|supplierReferenceNo|paymentTerms|secret/i);
  });
  it('returns exact approved cost to finance', async () => {
    const f = fixture();
    const result = await getPurchaseCommitment({ tx: f.tx, actor: { id: 'finance', role: 'FINANCE' }, purchaseCommitmentId: 'purchase' });
    expect(result.totalCost).toBe('5000.0001');
    expect(result.lines[0].unitCost).toBe('5000.0001');
  });
  it('blocks cross-owner and cross-department reads before the purchase list query', async () => {
    for (const actor of [{ id: 'peer', role: 'SALES', department: 'Sales' }, { id: 'manager', role: 'MANAGER', department: 'Other' }]) {
      const f = fixture();
      await expect(getOrderPurchaseCommitments({ tx: f.tx, actor, orderId: 'order' })).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
      expect(f.mocks.purchaseCommitment.findMany).not.toHaveBeenCalled();
    }
  });
  it('does not infer a procurement lineage for a legacy order', async () => {
    const f = fixture(); f.order.lineItemsMode = false;
    await expect(getOrderPurchaseCommitments({ tx: f.tx, actor: { id: 'finance', role: 'FINANCE' }, orderId: 'order' }))
      .rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });
});
