import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  assertInventoryUseAllowed,
  assertNoOpenReturnHold,
  assertNoReturnHistory,
  assertSerialReentryAllowed,
} from './returnGuards.js';

function txFixture(overrides: Record<string, unknown> = {}) {
  const tx: any = {
    returnHold: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    inventoryTransaction: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  };
  return tx as Prisma.TransactionClient;
}

describe('D13 return guards', () => {
  it('blocks legacy status/quantity paths while a return is quarantined', async () => {
    const tx = txFixture({
      returnHold: {
        findFirst: vi.fn().mockResolvedValue({ id: 'hold-1', status: 'QUARANTINED' }),
        findMany: vi.fn(),
      },
    });
    await expect(assertNoOpenReturnHold(tx, 'detail-1')).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    await expect(assertInventoryUseAllowed(tx, { id: 'detail-1', serialNumber: 'SN-1', inventoryItem: { trackingType: 'SERIAL' } }))
      .rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });

  it('keeps remaining saleable batch quantity usable while another batch quantity is quarantined', async () => {
    const tx = txFixture({
      returnHold: {
        findFirst: vi.fn().mockResolvedValue({ id: 'hold-batch-1', status: 'QUARANTINED' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    await expect(assertInventoryUseAllowed(tx, {
      id: 'detail-batch-1', serialNumber: null, inventoryItem: { trackingType: 'BATCH' },
    })).resolves.toBeUndefined();
    expect((tx.returnHold as any).findFirst).not.toHaveBeenCalled();
  });

  it('does not allow deletion after a released return history exists', async () => {
    const tx = txFixture({
      returnHold: {
        findFirst: vi.fn().mockResolvedValue({ id: 'hold-1', status: 'RELEASED' }),
        findMany: vi.fn(),
      },
    });
    await expect(assertNoReturnHistory(tx, 'detail-1')).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });

  it('allows serial reuse only for the latest outbound with a released return and RETURN ledger', async () => {
    const tx = txFixture({
      inventoryTransaction: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          { id: 'outbound-1', quantity: -1 },
          { id: 'outbound-2', quantity: -1 },
        ]),
      },
      returnHold: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([{
          id: 'hold-old',
          quantity: 1,
          status: 'RELEASED',
          returnTransactionId: 'return-1',
          returnTransaction: { id: 'return-1', type: 'RETURN', inventoryDetailId: 'detail-1', quantity: 1 },
          shipmentLine: { outboundTransactionId: 'outbound-1' },
        }, {
          id: 'hold-current',
          quantity: 1,
          status: 'RELEASED',
          returnTransactionId: 'return-2',
          returnTransaction: { id: 'return-2', type: 'RETURN', inventoryDetailId: 'detail-1', quantity: 1 },
          shipmentLine: { outboundTransactionId: 'outbound-2' },
        }]),
      },
    });
    await expect(assertSerialReentryAllowed(tx, {
      inventoryDetailId: 'detail-1', trackingType: 'SERIAL', serialNumber: 'SN-1',
    })).resolves.toBeUndefined();
    expect((tx.returnHold as any).findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ inventoryDetailId: 'detail-1', status: 'RELEASED' }),
    }));
  });

  it('rejects reusing an earlier return authorization after a later outbound', async () => {
    const tx = txFixture({
      inventoryTransaction: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          { id: 'outbound-old', quantity: -1 },
          { id: 'outbound-newer', quantity: -1 },
        ]),
      },
      returnHold: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([{
          id: 'hold-old',
          quantity: 1,
          status: 'RELEASED',
          returnTransactionId: 'return-old',
          returnTransaction: { id: 'return-old', type: 'RETURN', inventoryDetailId: 'detail-1', quantity: 1 },
          shipmentLine: { outboundTransactionId: 'outbound-old' },
        }]),
      },
    });
    await expect(assertSerialReentryAllowed(tx, {
      inventoryDetailId: 'detail-1', trackingType: 'SERIAL', serialNumber: 'SN-1',
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });

  it('does not infer a serial latest outbound from same-millisecond timestamps or UUID order', async () => {
    const tx = txFixture({
      inventoryTransaction: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          { id: 'zz-outbound', quantity: -1 },
          { id: 'aa-outbound', quantity: -1 },
        ]),
      },
      returnHold: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([{
          id: 'hold-for-aa',
          status: 'RELEASED',
          returnTransactionId: 'return-aa',
          returnTransaction: { id: 'return-aa', type: 'RETURN', inventoryDetailId: 'detail-1', quantity: 1 },
          shipmentLine: { outboundTransactionId: 'aa-outbound' },
        }]),
      },
    });

    await expect(assertSerialReentryAllowed(tx, {
      inventoryDetailId: 'detail-1', trackingType: 'SERIAL', serialNumber: 'SN-1',
    })).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect((tx.inventoryTransaction as any).findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { inventoryDetailId: 'detail-1', type: 'OUTBOUND' },
    }));
  });
});
