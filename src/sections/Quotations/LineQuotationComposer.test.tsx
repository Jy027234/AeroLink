import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RFQ, RfqLine } from '@/types';
import { supplierQuoteApi, type SupplierQuoteItem } from '@/api/client';
import { LineQuotationComposer, type LineQuotationDraft } from './LineQuotationComposer';
import { createLineQuotationDrafts } from './lineQuotationComposerModel';

const permissions = vi.hoisted(() => new Set<string>());

vi.mock('@/api/client', () => ({
  inventoryApi: { getByPartNumber: vi.fn() },
  supplierQuoteApi: { getAll: vi.fn() },
}));

vi.mock('@/store', () => ({
  useCapabilityStore: (select: (state: { can: (key: string) => boolean }) => unknown) =>
    select({ can: key => permissions.has(key) }),
}));

vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'zh-CN' }) }));

const rfqLines: RfqLine[] = [
  {
    id: 'line-1', rfqId: 'rfq-1', lineNo: 1, partNumber: 'PN-100', quantity: 5, uom: 'EA',
    conditionCode: 'NE', certificateRequired: false, requiredDate: '2026-10-01', targetPriceCurrency: 'USD',
    status: 'OPEN', createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
  },
  {
    id: 'line-2', rfqId: 'rfq-1', lineNo: 2, partNumber: 'PN-200', quantity: 3, uom: 'EA',
    conditionCode: 'OH', certificateRequired: true, requiredDate: '2026-10-01', targetPriceCurrency: 'USD',
    status: 'OPEN', createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
  },
  {
    id: 'line-cancelled', rfqId: 'rfq-1', lineNo: 3, partNumber: 'PN-300', quantity: 1, uom: 'EA',
    conditionCode: 'NE', certificateRequired: false, requiredDate: '2026-10-01', targetPriceCurrency: 'USD',
    status: 'CANCELLED', createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
  },
];

const rfq: RFQ = {
  id: 'rfq-1', rfqNumber: 'RFQ-001', customerId: 'customer-1', customerName: '客户一',
  partNumber: 'PN-100', quantity: 5, uom: 'EA', conditionCode: 'NE', targetPriceCurrency: 'USD',
  certificateRequired: false, requiredDate: '2026-10-01', urgency: 'standard', status: 'quoting', version: 1,
  createdAt: '2026-09-08T00:00:00.000Z', createdBy: 'sales-1', lines: rfqLines,
};

function renderComposer(value: LineQuotationDraft[], onChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <LineQuotationComposer rfq={rfq} value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

function ControlledComposer({ initial }: { initial: LineQuotationDraft[] }) {
  const [value, setValue] = useState(initial);
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <LineQuotationComposer rfq={rfq} value={value} onChange={setValue} />
    </QueryClientProvider>
  );
}

function supplierQuote(id: string, partNumber: string, unitPrice: number, rfqLineId = partNumber === 'PN-100' ? 'line-1' : 'line-2', supplierName = '供应商一'): SupplierQuoteItem {
  return {
    id, rfqId: 'rfq-1', rfqLineId, inquiryId: null, partNumber, description: null, quantity: 5,
    unitPrice, totalPrice: unitPrice * 5, currency: 'USD', currencyStatus: 'VERIFIED',
    leadTimeDays: 14, validUntil: '2099-01-01', notes: null, status: 'pending', isWinner: false,
    ruleScore: null, createdAt: '2026-09-08T00:00:00.000Z',
    supplier: { id: `supplier-${id}`, name: supplierName, level: 'A', performanceScore: null, contactName: null, contactEmail: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions.clear();
});

afterEach(cleanup);

describe('LineQuotationComposer', () => {
  it('selects a subset of RFQ lines while retaining each line id and actual part number', () => {
    const initial = createLineQuotationDrafts(rfq, ['line-2']);
    const changed = renderComposer(initial);

    expect(screen.queryByRole('region', { name: '报价行 1 PN-100' })).toBeNull();
    expect(screen.getByRole('region', { name: '报价行 2 PN-200' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 PN-100' }));

    const next = changed.mock.lastCall?.[0] as LineQuotationDraft[];
    expect(next.map(line => line.rfqLineId)).toEqual(['line-1', 'line-2']);
    expect(next.map(line => line.partNumber)).toEqual(['PN-100', 'PN-200']);
    expect(screen.queryByText('PN-300')).toBeNull();
  });

  it('allows partial quantity and unit price edits and calculates a display-only total', () => {
    const initial = createLineQuotationDrafts(rfq, ['line-1', 'line-2']).map(line => ({
      ...line,
      unitPrice: line.rfqLineId === 'line-1' ? 100 : 50,
    }));
    render(<ControlledComposer initial={initial} />);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'PN-100 报价数量' }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'PN-100 销售单价' }), { target: { value: '120.5' } });

    expect(screen.getByRole('spinbutton', { name: 'PN-100 报价数量' })).toHaveValue(2);
    expect(screen.getByRole('spinbutton', { name: 'PN-100 销售单价' })).toHaveValue(120.5);
    expect(screen.getByTestId('quotation-display-total')).toHaveTextContent('$391.00');
    expect(screen.getByText(/合计仅用于当前页面展示/)).toBeInTheDocument();
  });

  it('keeps up to four decimal places in the display-only USD total', () => {
    const initial = createLineQuotationDrafts(rfq, ['line-1']).map(line => ({
      ...line,
      quantity: 1,
      unitPrice: 10000.3706,
    }));
    renderComposer(initial);

    expect(screen.getByTestId('quotation-display-total')).toHaveTextContent('$10,000.3706');
  });

  it('keeps a policy-redacted cost blank until the user re-enters it', () => {
    const initial = createLineQuotationDrafts(rfq, ['line-1']).map(line => ({
      ...line,
      costPrice: 0,
      costPriceRedacted: true,
    }));
    const changed = renderComposer(initial);
    const costInput = screen.getByRole('spinbutton', { name: 'PN-100 成本单价' });

    expect(costInput).toHaveValue(null);
    fireEvent.change(costInput, { target: { value: '42.5' } });

    const next = changed.mock.lastCall?.[0] as LineQuotationDraft[];
    expect(next[0]).toMatchObject({ costPrice: 42.5, costPriceRedacted: false });
  });

  it('queries and accepts a cost source for the selected line using that line part number', async () => {
    permissions.add('supplier_quote.read');
    vi.mocked(supplierQuoteApi.getAll).mockImplementation(async filters => {
      expect(filters).toEqual({ rfqId: 'rfq-1', partNumber: 'PN-100' });
      return [supplierQuote('source-1', 'PN-100', 42), supplierQuote('wrong-line', 'PN-100', 88, 'line-2', '另一条需求行')];
    });
    const initial = createLineQuotationDrafts(rfq, ['line-1']).map(line => ({ ...line, costSourceType: 'SUPPLIER_QUOTE' as const }));
    const changed = renderComposer(initial);
    const line = screen.getByRole('region', { name: '报价行 1 PN-100' });

    await waitFor(() => expect(supplierQuoteApi.getAll).toHaveBeenCalledWith({ rfqId: 'rfq-1', partNumber: 'PN-100' }));
    await waitFor(() => expect(screen.queryByText('正在加载来源…')).toBeNull());
    fireEvent.pointerDown(within(line).getByRole('combobox', { name: '选择来源记录' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByRole('option', { name: /供应商一.*PN-100/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /PN-200/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /供应商一.*PN-100/ }));

    const next = changed.mock.lastCall?.[0] as LineQuotationDraft[];
    expect(next[0]).toMatchObject({ rfqLineId: 'line-1', partNumber: 'PN-100', costSourceId: 'source-1', costPrice: 42 });
    expect(screen.queryByRole('option', { name: /另一条需求行/ })).toBeNull();
  });
});
