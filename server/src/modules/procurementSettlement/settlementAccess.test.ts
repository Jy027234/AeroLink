import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityActor } from '../../lib/capabilityPolicy.js';
import type { Prisma as PrismaTypes } from '@prisma/client';
import {
  getOrderSettlements,
  getSettlementAccount,
  projectSettlementAccount,
} from './settlementAccess.js';

const sales: CapabilityActor = { id: 'sales-1', role: 'SALES', department: 'Sales' };
const salesPeer: CapabilityActor = { id: 'sales-peer', role: 'SALES', department: 'Sales' };
const finance: CapabilityActor = { id: 'finance-1', role: 'FINANCE', department: 'Finance' };

const order = {
  id: 'order-1', orderNumber: 'SO-001', lineItemsMode: true, status: 'SO_CREATED', version: 1,
  totalAmountDecimal: new Prisma.Decimal('100.0000'), customerId: 'customer-1', customer: { name: 'Customer' },
  quotation: { currency: 'USD', createdBy: sales.id, creator: { department: 'Sales' } },
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'record-open', kind: 'OPEN', accountVersion: 1, amount: null, dueDate: new Date('2026-10-01T00:00:00.000Z'),
    occurredAt: new Date('2026-09-09T00:00:00.000Z'), externalSystem: 'ERP', voucherNumber: 'OPEN-1', voucherLine: '1',
    reason: 'Account opened', evidence: [], reversalOfId: null, actor: { name: 'Operator' },
    createdAt: new Date('2026-09-09T00:00:00.000Z'), ...overrides,
  };
}

function account(id: string, side: 'RECEIVABLE' | 'PAYABLE', initialAmount: string, overrides: Record<string, unknown> = {}) {
  return {
    id, side, orderId: order.id, purchaseCommitmentId: side === 'PAYABLE' ? 'purchase-1' : null, currency: 'USD',
    initialAmount: new Prisma.Decimal(initialAmount), sourceSnapshot: { kind: side },
    dueDate: new Date('2026-10-01T00:00:00.000Z'), version: 1, createdAt: new Date('2026-09-09T00:00:00.000Z'),
    records: [record()], ...overrides,
  };
}

function fixture(accounts: unknown[], orderOverrides: Record<string, unknown> = {}) {
  const findOrder = vi.fn().mockResolvedValue({ ...order, ...orderOverrides });
  const findMany = vi.fn().mockImplementation((args: { where?: { side?: string } }) => Promise.resolve(
    accounts.filter((value) => !args.where?.side || (value as { side: string }).side === args.where?.side),
  ));
  const findAccount = vi.fn().mockImplementation((args: { where: { id: string } }) => Promise.resolve(
    accounts.find((value) => (value as { id: string }).id === args.where.id) ?? null,
  ));
  const tx = {
    order: { findUnique: findOrder },
    settlementAccount: { findMany, findUnique: findAccount },
  } as unknown as PrismaTypes.TransactionClient;
  return { tx, findOrder, findMany, findAccount };
}

describe('settlement order scope and response projection', () => {
  it('lets sales read its receivable account while filtering payable accounts before projection', async () => {
    const receivable = account('ar-1', 'RECEIVABLE', '100.0000');
    const payable = account('ap-1', 'PAYABLE', '80.0000', { sourceSnapshot: { kind: 'PURCHASE', supplierCost: '80.0000' } });
    const f = fixture([receivable, payable]);

    const result = await getOrderSettlements(f.tx, sales, order.id);

    expect(f.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: order.id, side: 'RECEIVABLE' } }));
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({ id: 'ar-1', side: 'RECEIVABLE' });
    expect(JSON.stringify(result)).not.toContain('ap-1');
    expect(JSON.stringify(result)).not.toContain('supplierCost');
  });

  it('rejects sales access to a payable account even when the sales user owns the order', async () => {
    const payable = account('ap-1', 'PAYABLE', '80.0000');
    const f = fixture([payable]);

    await expect(getSettlementAccount(f.tx, sales, payable.id))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
  });

  it('rejects a cross-order sales read before loading any settlement account', async () => {
    const f = fixture([account('ar-1', 'RECEIVABLE', '100.0000')], {
      id: 'other-order', quotation: { currency: 'USD', createdBy: 'other-sales', creator: { department: 'Sales' } },
    });

    await expect(getOrderSettlements(f.tx, salesPeer, order.id))
      .rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('allows finance to read both sides and preserves the current money projection', async () => {
    const receivable = account('ar-1', 'RECEIVABLE', '100.0000', {
      records: [record(), record({ id: 'payment-1', kind: 'PAYMENT', accountVersion: 2, amount: new Prisma.Decimal('25.0000') })],
    });
    const payable = account('ap-1', 'PAYABLE', '80.0000');
    const f = fixture([receivable, payable]);

    const list = await getOrderSettlements(f.tx, finance, order.id);
    expect(list.accounts.map((value) => value.id)).toEqual(['ar-1', 'ap-1']);
    expect(list.accounts.find((value) => value.id === 'ar-1')?.amounts.grossPaid).toBe('25.0000');

    await expect(getSettlementAccount(f.tx, finance, payable.id)).resolves.toMatchObject({ id: payable.id, side: 'PAYABLE' });
  });

  it('keeps settlement amounts stable when a historical evidence status changes', () => {
    const payable = account('ap-1', 'PAYABLE', '80.0000', {
      records: [record({
        id: 'payment-1', kind: 'PAYMENT', accountVersion: 2, amount: new Prisma.Decimal('30.0000'),
        evidence: [{ id: 'file-1', version: 2, sha256: 'a'.repeat(64), status: 'REVOKED' }],
      })],
    });

    const projection = projectSettlementAccount(payable as unknown as Parameters<typeof projectSettlementAccount>[0]);
    expect(projection.amounts.grossPaid).toBe('30.0000');
    expect(projection.records[0].evidence).toEqual([{ id: 'file-1', version: 2, sha256: 'a'.repeat(64), status: 'REVOKED' }]);
  });
});
