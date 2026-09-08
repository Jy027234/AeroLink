import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inventoryApi, supplierQuoteApi, type SupplierQuoteItem } from '@/api/client';
import { CostSourceFields, type CostSourceValue } from './CostSourceFields';

const permissions = vi.hoisted(() => new Set<string>());
vi.mock('@/api/client', () => ({ inventoryApi: { getByPartNumber: vi.fn() }, supplierQuoteApi: { getAll: vi.fn() } }));
vi.mock('@/store', () => ({ useCapabilityStore: (select: (state: { can: (key: string) => boolean }) => unknown) => select({ can: key => permissions.has(key) }) }));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'zh-CN' }) }));
beforeEach(() => { vi.clearAllMocks(); permissions.clear(); });
afterEach(cleanup);
function show(value: CostSourceValue, onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><CostSourceFields value={value} onChange={onChange} rfqId="r1" partNumber="P1" quantity={2} /></QueryClientProvider>);
  return onChange;
}
function supplier(id: string, name: string, currencyStatus: SupplierQuoteItem['currencyStatus']): SupplierQuoteItem {
  return { id, rfqId: 'r1', inquiryId: null, partNumber: 'P1', quantity: 3, unitPrice: 50, totalPrice: 150, currency: currencyStatus === 'VERIFIED' ? 'USD' : null, currencyStatus, status: 'pending', validUntil: '2099-01-01', supplier: { id: 's1', name } } as SupplierQuoteItem;
}
it('does not request inventory costs without the dedicated capability', async () => {
  show({ costSourceType: 'INVENTORY_DETAIL', costSourceId: '', costSourceReason: '' });
  await screen.findByText(/没有满足当前件号/);
  expect(inventoryApi.getByPartNumber).not.toHaveBeenCalled();
});
it('offers only verified supplier quotes and fills the selected source price', async () => {
  permissions.add('supplier_quote.read');
  vi.mocked(supplierQuoteApi.getAll).mockResolvedValue([supplier('unknown', 'UnknownVendor', 'HISTORICAL_UNVERIFIED'), supplier('verified', 'VerifiedVendor', 'VERIFIED')]);
  const changed = show({ costSourceType: 'SUPPLIER_QUOTE', costSourceId: '', costSourceReason: '' });
  await waitFor(() => expect(screen.queryByText('正在加载来源…')).toBeNull());
  fireEvent.pointerDown(screen.getByRole('combobox', { name: '选择来源记录' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const option = await screen.findByRole('option', { name: /VerifiedVendor/ });
  expect(screen.queryByRole('option', { name: /UnknownVendor/ })).toBeNull();
  fireEvent.click(option);
  expect(changed).toHaveBeenCalledWith({ costSourceType: 'SUPPLIER_QUOTE', costSourceId: 'verified', costSourceReason: '' }, 50);
});
