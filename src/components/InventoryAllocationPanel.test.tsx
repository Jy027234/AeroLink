import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inventoryAllocationApi, inventoryItemApi } from '@/api/client';
import { InventoryAllocationPanel } from './InventoryAllocationPanel';

const capabilityState = vi.hoisted(() => {
  const permissions = new Set<string>();
  return {
    permissions,
    can: (capability: string) => permissions.has(capability),
  };
});

vi.mock('@/api/client', () => ({
  inventoryAllocationApi: {
    getQuotationLine: vi.fn(),
    getOrderLine: vi.fn(),
    reserve: vi.fn(),
    assign: vi.fn(),
    release: vi.fn(),
    getQualityReview: vi.fn(),
    createQualityReview: vi.fn(),
    consume: vi.fn(),
  },
  inventoryItemApi: { getByPartNumber: vi.fn() },
  qualityReviewApi: { uploadEvidence: vi.fn() },
}));

vi.mock('@/store', () => ({
  useCapabilityStore: (select: (state: { can: (capability: string) => boolean }) => unknown) => select({ can: capabilityState.can }),
}));

vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'zh-CN' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const detail = {
  id: 'detail-1', inventoryItemId: 'item-1', quantity: 4, allocatedQuantity: 0, status: 'AVAILABLE',
  conditionCode: 'NE', serialNumber: null, batchNumber: 'B-1', warehouse: 'WH-1', location: 'A-01',
} as never;

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterAll(() => { HTMLElement.prototype.scrollIntoView = originalScrollIntoView; });

beforeEach(() => {
  vi.clearAllMocks();
  capabilityState.permissions.clear();
  capabilityState.permissions.add('inventory.manage');
  capabilityState.permissions.add('quotation.read');
  capabilityState.permissions.add('order.read');
  vi.mocked(inventoryAllocationApi.getOrderLine).mockResolvedValue({
    id: 'order-line-1', quotationLineId: 'quotation-line-1', quantity: 5, outboundQuantity: 1,
    directShippedQuantity: 3, assignments: [],
  });
  vi.mocked(inventoryAllocationApi.getQuotationLine).mockResolvedValue({
    quotationLineId: 'quotation-line-1', quantity: 5, acceptedQuantity: 5, reservedQuantity: 0,
    unassignedQuantity: 0, assignedActiveQuantity: 0, activeQuantity: 0, allocations: [],
  });
  vi.mocked(inventoryItemApi.getByPartNumber).mockResolvedValue({ details: [detail] } as never);
});

afterEach(cleanup);

describe('InventoryAllocationPanel', () => {
  it('limits new reservations to demand remaining after local and direct delivery', async () => {
    render(<InventoryAllocationPanel mode="order" quotationLineId="quotation-line-1" orderLineId="order-line-1" partNumber="PN-1" quantity={5} />);

    expect(await screen.findByText('供应商直发')).toBeInTheDocument();
    expect(screen.getByText('3 EA')).toBeInTheDocument();
    expect(screen.getByText('本地已出库')).toBeInTheDocument();
    expect(screen.getByText('1 EA')).toBeInTheDocument();

    // Select the batch explicitly, as required by the real operator flow.
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /4 EA/ }));
    const reserveInput = screen.getByRole('spinbutton');
    const reserveButton = screen.getByRole('button', { name: '预留' });
    await waitFor(() => expect(reserveButton).toBeEnabled());
    fireEvent.change(reserveInput, { target: { value: '2' } });
    expect(reserveButton).toBeDisabled();
    fireEvent.change(reserveInput, { target: { value: '1' } });
    expect(reserveButton).toBeEnabled();
  });

  it('treats a missing inventory catalog row as an empty state', async () => {
    vi.mocked(inventoryItemApi.getByPartNumber).mockRejectedValue(Object.assign(new Error('InventoryItem not found'), { statusCode: 404 }));
    render(<InventoryAllocationPanel mode="order" quotationLineId="quotation-line-1" orderLineId="order-line-1" partNumber="PN-MISSING" quantity={5} />);

    expect(await screen.findByText('没有可用库存明细，请先刷新或补充库存。')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps unexpected inventory lookup failures visible', async () => {
    vi.mocked(inventoryItemApi.getByPartNumber).mockRejectedValue(Object.assign(new Error('Inventory service unavailable'), { statusCode: 503 }));
    render(<InventoryAllocationPanel mode="order" quotationLineId="quotation-line-1" orderLineId="order-line-1" partNumber="PN-1" quantity={5} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Inventory service unavailable');
    expect(screen.getByRole('button', { name: '预留', exact: true })).toBeDisabled();
  });
});
