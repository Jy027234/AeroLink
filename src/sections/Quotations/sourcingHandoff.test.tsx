import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreateQuoteDialog } from './index';
import { parseSourcingQuoteHandoff } from './sourcingHandoff';
import type { RFQ, RfqLine } from '@/types';

const mocks = vi.hoisted(() => ({
  getRfq: vi.fn(),
  getSupplierQuote: vi.fn(),
  getSupplierQuotes: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  rfqApi: { getById: mocks.getRfq },
  supplierQuoteApi: { getById: mocks.getSupplierQuote, getAll: mocks.getSupplierQuotes },
  inventoryApi: { getByPartNumber: vi.fn() },
  quotationApi: { createMultiLine: vi.fn() },
  documentApi: {},
  inventoryAllocationApi: {},
}));

vi.mock('@/features/quotations', () => ({
  useCreateQuotation: () => ({ mutate: vi.fn() }),
  useQuotation: () => ({ data: undefined }),
  useAcceptQuotation: () => ({ accept: vi.fn() }),
  useApproveQuotation: () => ({ approve: vi.fn() }),
  useQuotations: () => ({ data: [] }),
  useSendQuotation: () => ({ send: vi.fn() }),
  useSubmitQuotation: () => ({ submit: vi.fn() }),
  useWithdrawQuotation: () => ({ withdraw: vi.fn() }),
}));
vi.mock('@/features/rfqs', () => ({ useRFQ: () => ({ data: undefined }), useRFQs: () => ({ data: [] }) }));
vi.mock('@/store', () => ({
  useCapabilityStore: (select: (state: { can: (capability: string) => boolean }) => unknown) =>
    select({ can: (capability) => capability === 'supplier_quote.read' || capability === 'quotation.create' }),
}));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'zh-CN' }) }));

const demandLine: RfqLine = {
  id: 'line-1', rfqId: 'rfq-1', lineNo: 1, partNumber: 'PN-ALPHA', quantity: 2, uom: 'EA',
  conditionCode: 'NE', certificateRequired: false, requiredDate: '2026-10-15', targetPriceCurrency: 'USD',
  status: 'OPEN', createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
};
const rfq: RFQ = {
  id: 'rfq-1', rfqNumber: 'RFQ-TEST', customerId: 'customer-1', customerName: 'Test Customer',
  partNumber: demandLine.partNumber, quantity: demandLine.quantity, uom: 'EA', conditionCode: 'NE',
  targetPriceCurrency: 'USD', certificateRequired: false, requiredDate: demandLine.requiredDate,
  urgency: 'standard', status: 'sourcing', version: 1, createdAt: '2026-09-20T00:00:00.000Z',
  createdBy: 'user-1', lineItemsMode: true, lines: [demandLine],
};
const winningQuote = {
  id: 'quote-1', rfqId: 'rfq-1', rfqLineId: 'line-1', inquiryId: 'inquiry-1', partNumber: 'PN-ALPHA',
  description: null, quantity: 2, unitPrice: 125, totalPrice: 250, currency: 'USD', currencyStatus: 'VERIFIED',
  leadTimeDays: 8, validUntil: '2099-01-01T00:00:00.000Z', notes: null, status: 'active', isWinner: true,
  ruleScore: 90, createdAt: '2026-09-22T00:00:00.000Z', supersededAt: null,
  supplier: { id: 'supplier-1', name: 'Winner Vendor', level: 'A', performanceScore: 90, contactName: null, contactEmail: null },
};

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <CreateQuoteDialog
        isOpen
        onClose={vi.fn()}
        onCreated={vi.fn()}
        initialSourcingContext={{ rfqId: 'rfq-1', rfqLineId: 'line-1', supplierQuoteId: 'quote-1' }}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRfq.mockResolvedValue(rfq);
  mocks.getSupplierQuote.mockResolvedValue(winningQuote);
  mocks.getSupplierQuotes.mockResolvedValue([winningQuote]);
});
afterEach(cleanup);

it('parses a complete sourcing handoff and ignores incomplete query context', () => {
  expect(parseSourcingQuoteHandoff('?rfqId=rfq-1&rfqLineId=line-1&supplierQuoteId=quote-1')).toEqual({
    rfqId: 'rfq-1', rfqLineId: 'line-1', supplierQuoteId: 'quote-1',
  });
  expect(parseSourcingQuoteHandoff('?rfqId=rfq-1&supplierQuoteId=quote-1')).toBeNull();
});

it('prefills the exact winning quote as line cost while leaving customer sale price for manual entry', async () => {
  renderDialog();

  expect(await screen.findByText(/已将中选报价带入目标需求行/)).toBeInTheDocument();
  expect(screen.getByLabelText('PN-ALPHA 报价数量')).toHaveValue(2);
  expect(screen.getByLabelText('PN-ALPHA 销售单价')).toHaveValue(0);
  expect(screen.getByLabelText('PN-ALPHA 成本单价')).toHaveValue(125);
  await waitFor(() => expect(mocks.getSupplierQuotes).toHaveBeenCalledWith({ rfqId: 'rfq-1', partNumber: 'PN-ALPHA' }));
  await waitFor(() => expect(screen.queryByText('正在加载来源…')).toBeNull());
  const sourceSelect = screen.getByRole('combobox', { name: '选择来源记录' });
  fireEvent.pointerDown(sourceSelect, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  expect(await screen.findByRole('option', { name: /Winner Vendor/ })).toHaveAttribute('aria-selected', 'true');
});

it('does not prefill an ineligible cost source even when the handoff URL names it', async () => {
  mocks.getSupplierQuote.mockResolvedValue({ ...winningQuote, currency: null, currencyStatus: 'HISTORICAL_UNVERIFIED' });
  renderDialog();

  expect(await screen.findByRole('alert')).toHaveTextContent('报价币种尚未核实为 USD');
  expect(screen.getByLabelText('PN-ALPHA 成本单价')).toHaveValue(0);
  expect(screen.queryByRole('combobox', { name: '选择来源记录' })).not.toBeInTheDocument();
});
