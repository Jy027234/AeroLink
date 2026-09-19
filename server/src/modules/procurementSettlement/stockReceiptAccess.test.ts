import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { assertStockReceiptOrderScope, getStockReceipt, stockReceiptReadSelect } from './stockReceiptAccess.js';

function fixture(department = 'Operations', modern = true) {
  return { order: { findUnique: vi.fn().mockResolvedValue({ id: 'order', lineItemsMode: modern, version: 1,
    status: 'SO_CREATED', quotation: { createdBy: 'owner', creator: { department } } }) },
  stockReceipt: { findUnique: vi.fn().mockResolvedValue({ id: 'receipt', purchaseCommitment: { orderId: 'order' } }) } };
}
describe('stock receipt operational access', () => {
  it('allows independent quality review while preserving existing receiving authority', async () => {
    const tx = fixture() as unknown as Prisma.TransactionClient;
    await expect(assertStockReceiptOrderScope(tx, { id: 'quality', role: 'QUALITY_MANAGER' }, 'order', 'review')).resolves.toHaveProperty('order.id', 'order');
    await expect(assertStockReceiptOrderScope(tx, { id: 'manager', role: 'MANAGER', department: 'Operations' }, 'order', 'receive')).resolves.toHaveProperty('order.id', 'order');
    await expect(assertStockReceiptOrderScope(tx, { id: 'operator', role: 'OPERATOR' }, 'order', 'receive')).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertStockReceiptOrderScope(tx, { id: 'operator', role: 'OPERATOR' }, 'order', 'review')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('rechecks current department scope and rejects legacy orders', async () => {
    const actor = { id: 'manager', role: 'MANAGER', department: 'Operations' };
    await expect(getStockReceipt({ tx: fixture('Other') as unknown as Prisma.TransactionClient, actor, receiptId: 'receipt' }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(assertStockReceiptOrderScope(fixture('Operations', false) as unknown as Prisma.TransactionClient, actor, 'order', 'receive'))
      .rejects.toMatchObject({ statusCode: 409 });
  });
  it('selects no procurement or inventory commercial fields', () => {
    expect(JSON.stringify(stockReceiptReadSelect)).not.toMatch(/unitCost|sourceSnapshot|totalCost|paymentTerms|confirmationEvidence|approvalSnapshot/);
  });
});
