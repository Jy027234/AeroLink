import { describe, expect, it } from 'vitest';
import { hasCapability } from './capabilityPolicy.js';
import {
  canViewQuotationCost,
  projectOrderResponse,
  projectQuotationResponse,
} from './responsePolicy.js';

const salesActor = { id: 'sales-1', role: 'sales', department: 'Sales' };
const financeActor = { id: 'finance-1', role: 'finance', department: 'Finance' };
const salesScope = { ownerId: salesActor.id, department: 'Sales' };

describe('sensitive response policy', () => {
  it('removes quotation, nested order, and nested quotation costs for sales', () => {
    const payload = {
      id: 'quotation-1',
      costPrice: 80,
      costPriceDecimal: '80.0000',
      margin: 20,
      costSourceType: 'SUPPLIER_QUOTE',
      costSourceId: 'sq-secret',
      costSourceReason: 'supplier record',
      costSourceSnapshotJson: '{"unitPrice":80}',
      costSourceCapturedAt: '2026-09-08T00:00:00.000Z',
      orders: [{
        id: 'order-1',
        totalLandCost: 110,
        importDuty: 10,
        exchangeCoreDueDate: '2026-09-08T00:00:00.000Z',
        quotation: {
          costPrice: 80,
          margin: 20,
          costSourceType: 'INVENTORY_DETAIL',
          costSourceId: 'inv-secret',
        },
      }],
      order: {
        id: 'order-2',
        totalLandCost: 120,
        quotation: { costSourceType: 'MANUAL', costSourceReason: 'hidden' },
      },
    };

    const projected = projectQuotationResponse(payload, salesActor, salesScope);

    expect(projected).toEqual({
      id: 'quotation-1',
      orders: [{ id: 'order-1', quotation: {} }],
      order: { id: 'order-2', quotation: {} },
    });
  });

  it('keeps costs for an actor with the current cost capability', () => {
    const payload = {
      costPrice: 80,
      margin: 20,
      costSourceType: 'MANUAL',
      costSourceId: null,
      costSourceReason: 'confidential',
      costSourceSnapshotJson: '{}',
      costSourceCapturedAt: '2026-09-08T00:00:00.000Z',
      totalLandCost: 110,
      quotation: { costPrice: 80, margin: 20 },
    };

    expect(canViewQuotationCost(financeActor, salesScope)).toBe(true);
    expect(projectOrderResponse(payload, financeActor, salesScope)).toEqual(payload);
  });

  it('does not change the existing sales supplier quote read policy', () => {
    expect(hasCapability(salesActor, 'supplier_quote', 'read')).toBe(true);
  });

  it('projects cost fields inside approval snapshots with the current actor policy', () => {
    const payload = {
      id: 'quotation-approval-1',
      approvals: [{
        id: 'approval-1',
        action: 'APPROVE',
        snapshotJson: JSON.stringify({
          totalPrice: 4200,
          costPrice: 1800,
          costPriceDecimal: '1800.0000',
          margin: 57.14,
          currency: 'USD',
          costSourceType: 'SUPPLIER_QUOTE',
          costSourceId: 'sq-secret',
          costSourceReason: 'supplier record',
          costSourceHash: 'hash-secret',
        }),
        approver: { id: 'manager-1', name: '经理', email: 'manager@example.com' },
      }],
    };

    const salesProjection = projectQuotationResponse(payload, salesActor, salesScope);
    const salesSnapshot = JSON.parse((salesProjection.approvals as Array<{ snapshotJson: string }>)[0].snapshotJson);
    expect(salesSnapshot).toEqual({ totalPrice: 4200, currency: 'USD' });
    expect((salesProjection.approvals as Array<{ approver: Record<string, unknown> }>)[0].approver)
      .toEqual({ id: 'manager-1', name: '经理' });

    const financeProjection = projectQuotationResponse(payload, financeActor, salesScope);
    expect(JSON.parse((financeProjection.approvals as Array<{ snapshotJson: string }>)[0].snapshotJson))
      .toMatchObject({ costPrice: 1800, margin: 57.14, costSourceType: 'SUPPLIER_QUOTE', costSourceId: 'sq-secret', costSourceHash: 'hash-secret' });
  });

  it('recursively removes line costs and source metadata for sales', () => {
    const payload = {
      id: 'quotation-lines-1',
      unitPrice: 120,
      lines: [{
        id: 'line-1',
        partNumber: 'PN-1',
        unitPrice: 120,
        costPrice: 80,
        marginAmount: 40,
        marginPercent: 33.3333,
        costSourceType: 'SUPPLIER_QUOTE',
        costSourceId: 'supplier-secret',
        costSourceReason: 'supplier record',
        costSourceSnapshotJson: '{"costPrice":80}',
        costSourceCapturedAt: '2026-09-08T00:00:00.000Z',
        costSourceHash: 'hash-secret',
        nested: {
          costPrice: 79,
          marginPercent: 34,
          visible: 'line fact',
        },
      }],
      approvals: [{
        snapshotJson: JSON.stringify({
          totalPrice: 120,
          lines: [{
            lineNo: 1,
            unitPrice: 120,
            costPrice: 80,
            marginAmount: 40,
            marginPercent: 33.3333,
            costSourceType: 'SUPPLIER_QUOTE',
            costSourceId: 'supplier-secret',
            costSourceSnapshotJson: '{"costPrice":80}',
          }],
        }),
      }],
    };

    const projected = projectQuotationResponse(payload, salesActor, salesScope);
    expect(projected.lines).toEqual([{
      id: 'line-1',
      partNumber: 'PN-1',
      unitPrice: 120,
      nested: { visible: 'line fact' },
    }]);
    const snapshot = JSON.parse((projected.approvals as Array<{ snapshotJson: string }>)[0].snapshotJson);
    expect(snapshot).toEqual({
      totalPrice: 120,
      lines: [{ lineNo: 1, unitPrice: 120 }],
    });
  });

  it('keeps nested line cost evidence for an actor with quotation cost capability', () => {
    const payload = {
      lines: [{
        costPrice: 80,
        marginAmount: 40,
        marginPercent: 33.3333,
        costSourceType: 'MANUAL',
        costSourceReason: 'contract sheet',
      }],
    };

    expect(projectQuotationResponse(payload, financeActor, salesScope)).toEqual(payload);
  });
});
