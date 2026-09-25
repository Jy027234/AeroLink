import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Sourcing } from './index';
import type { Inquiry, SourcingAiTaskRecord, SupplierQuoteCompareResult, SupplierQuoteDraftPayload, SupplierQuoteDraftRecord } from '@/api/client';
import type { Email, RFQ, RfqLine, Supplier } from '@/types';

const mocks = vi.hoisted(() => ({
  rfqs: [] as RFQ[],
  inquiries: [] as Inquiry[],
  suppliers: [] as Supplier[],
  compare: vi.fn(),
  send: vi.fn(),
  refetchInquiries: vi.fn(),
  emails: [] as Email[],
  pendingMatchEmails: [] as Email[],
  pendingEmailQueryOptions: [] as Array<Record<string, unknown> | undefined>,
  refetchPendingEmails: vi.fn(),
  requestedInquiryIds: [] as Array<string | null | undefined>,
  emailApi: { linkToInquiry: vi.fn() },
  supplierQuoteDraftApi: {
    create: vi.fn(),
    extract: vi.fn(),
    getById: vi.fn(),
    getLatest: vi.fn(),
    update: vi.fn(),
    confirm: vi.fn(),
  },
  sourcingAiTaskApi: { create: vi.fn(), list: vi.fn(), getById: vi.fn(), retry: vi.fn(), cancel: vi.fn() },
  fileApi: { download: vi.fn() },
  downloadBlob: vi.fn(),
}));

vi.mock('@/hooks/useApi', () => ({
  useRFQs: () => ({ data: mocks.rfqs, loading: false, error: null }),
  useSuppliers: () => ({ data: mocks.suppliers, loading: false, error: null }),
  useInventoryItems: () => ({ data: [], loading: false, error: null }),
  useCreateInquiry: () => ({ mutate: vi.fn(), loading: false }),
  useInquiries: () => ({ data: mocks.inquiries, loading: false, error: null, refetch: mocks.refetchInquiries }),
  useSendInquiry: () => ({ mutate: mocks.send, loading: false, error: null }),
  useCompareSupplierQuotes: () => ({ compare: mocks.compare, loading: false }),
  useEmails: (filters?: Record<string, unknown>) => {
    mocks.pendingEmailQueryOptions.push(filters);
    return {
      data: {
        success: true,
        data: mocks.pendingMatchEmails,
        pagination: { page: 1, limit: 100, total: mocks.pendingMatchEmails.length, totalPages: mocks.pendingMatchEmails.length ? 1 : 0 },
        summary: { total: mocks.pendingMatchEmails.length, aog: 0, standard: 0, inquiry: 0, unread: 0, spam: 0 },
      },
      loading: false,
      error: null,
      refetch: mocks.refetchPendingEmails,
    };
  },
  useInquiryEmails: (inquiryId?: string | null) => {
    mocks.requestedInquiryIds.push(inquiryId);
    return { data: mocks.emails, loading: false, error: null };
  },
}));

vi.mock('@/api/client', () => ({ emailApi: mocks.emailApi, fileApi: mocks.fileApi, sourcingAiTaskApi: mocks.sourcingAiTaskApi, supplierQuoteDraftApi: mocks.supplierQuoteDraftApi }));
vi.mock('@/lib/downloadBlob', () => ({ downloadBlob: mocks.downloadBlob }));

vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'zh-CN' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function demandLine(id: string, lineNo: number, partNumber: string): RfqLine {
  return {
    id,
    rfqId: 'rfq-1',
    lineNo,
    partNumber,
    quantity: lineNo * 2,
    uom: 'EA',
    conditionCode: 'NE',
    certificateRequired: true,
    requiredDate: '2026-10-15',
    targetPriceCurrency: 'USD',
    status: 'OPEN',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };
}

const lineOne = demandLine('line-1', 1, 'PN-ALPHA');
const lineTwo = demandLine('line-2', 2, 'PN-BETA');
const rfq = {
  id: 'rfq-1',
  rfqNumber: 'RFQ-TEST',
  customerId: 'customer-1',
  customerName: 'Test Customer',
  partNumber: lineOne.partNumber,
  quantity: lineOne.quantity,
  uom: 'EA',
  conditionCode: 'NE',
  targetPriceCurrency: 'USD',
  certificateRequired: true,
  requiredDate: '2026-10-15',
  urgency: 'standard',
  status: 'pending',
  version: 1,
  createdAt: '2026-09-20T00:00:00.000Z',
  createdBy: 'test-user',
  lines: [lineOne, lineTwo],
} as RFQ;

function comparison(lineId: string, supplierName: string, unitPrice: number): SupplierQuoteCompareResult {
  const quotes = lineId === 'line-1' ? [{
    id: `quote-${lineId}`,
    partNumber: lineOne.partNumber,
    rfqLineId: lineId,
    supplier: { id: `supplier-${lineId}`, name: supplierName, level: 'A', performanceScore: 90 },
    unitPrice,
    totalPrice: unitPrice * lineOne.quantity,
    currency: 'USD',
    currencyStatus: 'VERIFIED' as const,
    quantity: lineOne.quantity,
    leadTimeDays: 8,
    priceDiff: 0,
    isLowestPrice: true,
    scoreComponents: { price: 80, leadTime: 70, supplierPerformance: 90 },
    ruleScore: 81,
    status: 'active',
    isWinner: false,
  }] : lineId === 'line-2' ? [{
    id: `quote-${lineId}`,
    partNumber: lineTwo.partNumber,
    rfqLineId: lineId,
    supplier: { id: `supplier-${lineId}`, name: supplierName, level: 'A', performanceScore: 90 },
    unitPrice,
    totalPrice: unitPrice * lineTwo.quantity,
    currency: 'USD',
    currencyStatus: 'VERIFIED' as const,
    quantity: lineTwo.quantity,
    leadTimeDays: 12,
    priceDiff: 0,
    isLowestPrice: true,
    scoreComponents: { price: 80, leadTime: 70, supplierPerformance: 90 },
    ruleScore: 72,
    status: 'active',
    isWinner: false,
  }] : [];
  return {
    quotes,
    topRanked: quotes[0] ?? null,
    summary: { totalQuotes: quotes.length, lowestPrice: quotes[0]?.unitPrice ?? null, highestPrice: quotes[0]?.unitPrice ?? null, averagePrice: quotes[0]?.unitPrice ?? null },
    metadata: {
      status: quotes.length ? 'available' : 'insufficient_data',
      source: 'supplier_quotes',
      algorithmVersion: 'test',
      sampleSize: quotes.length,
      asOf: '2026-09-22T00:00:00.000Z',
      reason: quotes.length ? undefined : 'No recorded quotes for this line.',
      decisionBoundary: 'Quotes for one demand line only.',
    },
  };
}

function inquiry(id: string, line: RfqLine, deliveryStatus: string): Inquiry {
  return {
    id,
    inquiryNumber: `INQ-${id}`,
    rfqId: 'rfq-1',
    supplierId: `supplier-${id}`,
    supplierName: `Supplier ${id}`,
    items: [{ id: `inquiry-item-${id}`, rfqLineId: line.id, lineNo: line.lineNo, partNumber: line.partNumber, quantity: line.quantity, requiredDate: line.requiredDate, certificateRequired: line.certificateRequired }],
    isAOG: false,
    status: deliveryStatus === 'queued' || deliveryStatus === 'failed' ? 'queued' : deliveryStatus === 'sent' ? 'sent' : 'draft',
    deliveryStatus,
    latestOutboundEmail: { id: `email-${id}`, status: deliveryStatus },
    createdAt: '2026-09-22T00:00:00.000Z',
  } as Inquiry;
}

function replyEmail(inquiryId = 'sent'): Email {
  return {
    id: 'reply-1',
    from: 'vendor@example.com',
    fromName: 'Vendor Reply',
    subject: 'Re: INQ-sent quotation',
    body: 'USD 125 each for PN-ALPHA. Lead time 8 days.',
    receivedAt: '2026-09-22T09:15:00.000Z',
    type: 'inquiry',
    isRead: false,
    threadMatchStatus: 'AUTO_MATCHED',
    threadMatchReason: 'Matched by inquiry number.',
    inquiryLinks: [{ id: 'link-1', inquiryId, method: 'THREAD', confirmationStatus: 'CONFIRMED' }],
    attachmentRecords: [{ id: 'attachment-1', filename: 'quote.pdf', contentType: 'application/pdf', sizeBytes: 2048, sha256: 'sha', storedObjectId: 'stored-1', downloadUrl: '/api/files/stored-1' }],
  };
}

function partiallyStoredReplyEmail(inquiryId = 'sent'): Email {
  return {
    ...replyEmail(inquiryId),
    attachmentStatus: 'PARTIAL',
    attachmentError: '1 attachment exceeded the configured size limit.',
  };
}

function unmatchedReplyEmail(): Email {
  return {
    ...replyEmail(),
    id: 'unmatched-reply',
    from: 'other-vendor@example.com',
    fromName: 'Other Vendor',
    subject: 'Unmatched quotation',
    threadMatchStatus: 'UNMATCHED',
    threadMatchReason: 'No inquiry number found.',
    inquiryLinks: [],
    attachmentStatus: 'PARTIAL',
    attachmentError: 'One attachment could not be stored.',
  };
}

function quoteDraft(payload: SupplierQuoteDraftPayload, version = 2, status = 'DRAFT'): SupplierQuoteDraftRecord {
  return {
    id: 'draft-1', emailId: 'reply-1', inquiryId: 'sent', supplierId: 'supplier-sent', status, version, payload,
    email: { id: 'reply-1', from: 'vendor@example.com', fromName: 'Vendor Reply', subject: 'Quotation', receivedAt: '2026-09-22T09:15:00.000Z', attachments: [] },
    inquiry: { id: 'sent', inquiryNumber: 'INQ-sent', supplierId: 'supplier-sent', items: [{ id: 'inquiry-item-sent', partNumber: 'PN-ALPHA', quantity: lineOne.quantity, rfqLineId: lineOne.id }] },
    supplier: { id: 'supplier-sent', name: 'Supplier sent', email: 'vendor@example.com' },
    supplierQuotes: [],
    createdAt: '2026-09-22T09:15:00.000Z',
    updatedAt: '2026-09-22T09:15:00.000Z',
    confirmedAt: status === 'CONFIRMED' ? '2026-09-22T10:00:00.000Z' : null,
  };
}

function extractionTask(overrides: Partial<SourcingAiTaskRecord> = {}): SourcingAiTaskRecord {
  return {
    id: 'task-1', actorId: 'sales-1', type: 'supplier_quote_extraction', emailId: 'reply-1', inquiryId: 'sent',
    status: 'COMPLETED', attempt: 1, maxAttempts: 3, draftId: 'draft-1', errorSummary: null,
    createdAt: '2026-09-22T09:15:00.000Z', startedAt: '2026-09-22T09:15:00.000Z',
    completedAt: '2026-09-22T09:15:01.000Z', cancelledAt: null, updatedAt: '2026-09-22T09:15:01.000Z',
    ...overrides,
  };
}

function selectRfq() {
  fireEvent.click(screen.getByText('RFQ-TEST'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rfqs = [rfq];
  mocks.inquiries = [];
  mocks.suppliers = [];
  mocks.emails = [];
  mocks.pendingMatchEmails = [];
  mocks.pendingEmailQueryOptions = [];
  mocks.requestedInquiryIds = [];
  mocks.emailApi.linkToInquiry.mockReset();
  mocks.emailApi.linkToInquiry.mockResolvedValue({ id: 'link-1' });
  mocks.refetchPendingEmails.mockReset();
  mocks.refetchPendingEmails.mockResolvedValue(undefined);
  mocks.supplierQuoteDraftApi.create.mockReset();
  mocks.supplierQuoteDraftApi.extract.mockReset();
  mocks.supplierQuoteDraftApi.getById.mockReset();
  mocks.supplierQuoteDraftApi.getLatest.mockReset();
  mocks.supplierQuoteDraftApi.getLatest.mockResolvedValue(null);
  mocks.supplierQuoteDraftApi.update.mockReset();
  mocks.supplierQuoteDraftApi.confirm.mockReset();
  mocks.sourcingAiTaskApi.create.mockReset();
  mocks.sourcingAiTaskApi.list.mockReset();
  mocks.sourcingAiTaskApi.list.mockResolvedValue([]);
  mocks.sourcingAiTaskApi.getById.mockReset();
  mocks.sourcingAiTaskApi.retry.mockReset();
  mocks.sourcingAiTaskApi.cancel.mockReset();
  mocks.fileApi.download.mockReset();
  mocks.fileApi.download.mockResolvedValue(new Blob(['quote']));
  mocks.downloadBlob.mockReset();
  mocks.refetchInquiries.mockResolvedValue(undefined);
  mocks.compare.mockImplementation(({ rfqLineId }: { rfqLineId?: string }) => Promise.resolve(
    comparison(rfqLineId ?? '', rfqLineId === 'line-1' ? 'Quote Alpha Supplier' : 'Quote Beta Supplier', rfqLineId === 'line-1' ? 125 : 240)
  ));
  mocks.send.mockResolvedValue(null);
});

afterEach(cleanup);

it('compares each demand line separately and keeps its quote under that line', async () => {
  render(<Sourcing />);
  selectRfq();

  await waitFor(() => {
    expect(mocks.compare).toHaveBeenCalledWith({ rfqId: 'rfq-1', rfqLineId: 'line-1' });
    expect(mocks.compare).toHaveBeenCalledWith({ rfqId: 'rfq-1', rfqLineId: 'line-2' });
  });

  const firstLine = screen.getByRole('region', { name: '需求行 1 · PN-ALPHA' });
  const secondLine = screen.getByRole('region', { name: '需求行 2 · PN-BETA' });
  expect(await within(firstLine).findByText('Quote Alpha Supplier')).toBeTruthy();
  expect(within(firstLine).queryByText('Quote Beta Supplier')).toBeNull();
  expect(within(secondLine).getByText('Quote Beta Supplier')).toBeTruthy();
  expect(within(secondLine).queryByText('Quote Alpha Supplier')).toBeNull();
  expect(within(firstLine).getAllByRole('cell').some((cell) => cell.textContent?.includes('USD 125'))).toBe(true);
  expect(within(secondLine).getAllByRole('cell').some((cell) => cell.textContent?.includes('USD 240'))).toBe(true);
});

it('loads the global unmatched reply queue, requires a manual reason on supplier email mismatch, then links and refreshes it', async () => {
  mocks.pendingMatchEmails = [unmatchedReplyEmail()];
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.suppliers = [{ id: 'supplier-sent', name: 'Supplier sent', email: 'vendor@example.com' } as Supplier];
  mocks.emailApi.linkToInquiry.mockImplementation(async () => {
    mocks.pendingMatchEmails = [];
    return { id: 'link-1' };
  });

  render(<Sourcing />);

  const unmatchedCard = await screen.findByRole('article', { name: '待匹配回邮 Unmatched quotation' });
  expect(within(unmatchedCard).getByText('Other Vendor <other-vendor@example.com>')).toBeTruthy();
  expect(within(unmatchedCard).getByText('No inquiry number found.')).toBeTruthy();
  expect(within(unmatchedCard).getByText(/附件部分保存/)).toBeTruthy();
  expect(mocks.pendingEmailQueryOptions).toContainEqual({ needsInquiryMatch: true, page: 1, limit: 100 });

  fireEvent.change(within(unmatchedCard).getByRole('combobox', { name: '目标询价 Unmatched quotation' }), { target: { value: 'sent' } });
  const linkButton = within(unmatchedCard).getByRole('button', { name: '关联 Unmatched quotation 到询价' });
  expect(within(unmatchedCard).getByText(/需要填写人工原因/)).toBeTruthy();
  expect(linkButton).toBeDisabled();

  fireEvent.change(within(unmatchedCard).getByLabelText(/人工匹配原因/), { target: { value: '该回邮回复此询价' } });
  expect(linkButton).toBeEnabled();
  fireEvent.click(linkButton);

  await waitFor(() => expect(mocks.emailApi.linkToInquiry).toHaveBeenCalledWith('unmatched-reply', {
    inquiryId: 'sent',
    manualReason: '该回邮回复此询价',
  }));
  await waitFor(() => expect(mocks.refetchPendingEmails).toHaveBeenCalled());
  await waitFor(() => expect(mocks.refetchInquiries).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole('article', { name: '待匹配回邮 Unmatched quotation' })).toBeNull());
});

it('recognizes a matching supplier mailbox inside a display-name address without forcing a manual reason', async () => {
  mocks.pendingMatchEmails = [{
    ...unmatchedReplyEmail(),
    from: 'Vendor Contact <VENDOR@example.com>',
    fromName: 'Vendor Contact',
  }];
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.suppliers = [{ id: 'supplier-sent', name: 'Supplier sent', email: 'vendor@example.com' } as Supplier];

  render(<Sourcing />);

  const unmatchedCard = await screen.findByRole('article', { name: '待匹配回邮 Unmatched quotation' });
  fireEvent.change(within(unmatchedCard).getByRole('combobox', { name: '目标询价 Unmatched quotation' }), { target: { value: 'sent' } });
  const linkButton = within(unmatchedCard).getByRole('button', { name: '关联 Unmatched quotation 到询价' });
  expect(within(unmatchedCard).queryByText(/需要填写人工原因/)).toBeNull();
  expect(linkButton).toBeEnabled();
  fireEvent.click(linkButton);

  await waitFor(() => expect(mocks.emailApi.linkToInquiry).toHaveBeenCalledWith('unmatched-reply', { inquiryId: 'sent' }));
});

it('shows server comparison eligibility, expiry and row-level quantity shortfall without recalculating scores', async () => {
  mocks.compare.mockImplementation(({ rfqLineId }: { rfqLineId?: string }) => {
    const result = comparison(rfqLineId ?? '', 'Quote Alpha Supplier', 125);
    if (rfqLineId !== 'line-1' || !result.quotes[0]) return Promise.resolve(result);
    const quote = {
      ...result.quotes[0],
      isExpired: true,
      coversRequiredQuantity: false,
      quantityShortfall: 3,
      comparisonEligibility: { eligible: false, reasons: ['报价已过期'], warnings: ['供应商邮箱未验证'] },
      commercialTerms: { condition: 'NE', certificate: 'FAA Form 1', taxIncluded: true, freightIncluded: false, incoterm: 'FCA' },
      commercialBasisLabel: 'NE · FAA Form 1 · TAX_INCLUDED · FREIGHT_EXCLUDED · FCA',
    };
    return Promise.resolve({
      ...result,
      quotes: [quote],
      topRanked: quote,
      summary: { ...result.summary, comparableQuoteCount: 0, expiredQuoteCount: 1, requiredQuantity: 2, bestAvailableQuantity: 1, remainingQuantityGap: 1 },
    });
  });

  render(<Sourcing />);
  selectRfq();

  const firstLine = screen.getByRole('region', { name: '需求行 1 · PN-ALPHA' });
  expect(await within(firstLine).findByText('不参与比价')).toBeTruthy();
  expect(within(firstLine).getByText('已过期')).toBeTruthy();
  expect(within(firstLine).getByText('数量不足')).toBeTruthy();
  expect(within(firstLine).getByText('缺口: 3 EA')).toBeTruthy();
  expect(within(firstLine).getByText(/报价已过期/)).toBeTruthy();
  expect(within(firstLine).getByText(/供应商邮箱未验证/)).toBeTruthy();
  expect(within(firstLine).getByText('可比报价: 0')).toBeTruthy();
  expect(within(firstLine).getByText('81')).toBeTruthy();
  expect(within(firstLine).getByText(/条件: NE/)).toBeTruthy();
  expect(within(firstLine).getByText(/证书: FAA Form 1/)).toBeTruthy();
  expect(within(firstLine).getByText(/税费: 含税/)).toBeTruthy();
  expect(within(firstLine).getByText(/运费: 未含运费/)).toBeTruthy();
  expect(within(firstLine).getByText(/贸易术语: FCA/)).toBeTruthy();
  expect(within(firstLine).getByText(/比较口径: NE/)).toBeTruthy();
});

it('shows queued, failed and sent inquiries as distinct delivery states on their own demand lines', async () => {
  mocks.inquiries = [inquiry('queued', lineOne, 'queued'), inquiry('failed', lineOne, 'failed'), inquiry('sent', lineTwo, 'sent')];
  render(<Sourcing />);
  selectRfq();

  const firstLine = screen.getByRole('region', { name: '需求行 1 · PN-ALPHA' });
  const secondLine = screen.getByRole('region', { name: '需求行 2 · PN-BETA' });
  expect(await within(firstLine).findByText('排队中')).toBeTruthy();
  expect(within(firstLine).getByText('发送失败')).toBeTruthy();
  expect(within(firstLine).queryByText('已发送')).toBeNull();
  expect(await within(secondLine).findByText('已发送')).toBeTruthy();
  expect(within(secondLine).queryByText('排队中')).toBeNull();
  expect(within(firstLine).queryByRole('button', { name: '预览 Supplier queued 的询价邮件' })).toBeNull();
  expect(within(firstLine).queryByRole('button', { name: '预览 Supplier failed 的询价邮件' })).toBeNull();
  expect(within(secondLine).queryByRole('button', { name: '预览 Supplier sent 的询价邮件' })).toBeNull();
});

it('previews the message and sends the edited subject and body with queued status preserved', async () => {
  const draft = inquiry('draft', lineOne, 'draft');
  mocks.inquiries = [draft];
  mocks.send.mockResolvedValue({
    ...draft,
    status: 'queued',
    deliveryStatus: 'queued',
    latestOutboundEmail: { id: 'email-draft', status: 'queued' },
  });
  render(<Sourcing />);
  selectRfq();

  fireEvent.click(await screen.findByRole('button', { name: '预览 Supplier draft 的询价邮件' }));
  const subject = screen.getByLabelText('主题') as HTMLInputElement;
  const body = screen.getByLabelText('邮件正文') as HTMLTextAreaElement;
  fireEvent.change(subject, { target: { value: '报价请求 RFQ-TEST' } });
  fireEvent.change(body, { target: { value: '请提供 PN-ALPHA 的报价。' } });
  fireEvent.click(screen.getByRole('button', { name: '确认并发送' }));

  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith({
    id: 'draft',
    payload: { subject: '报价请求 RFQ-TEST', textBody: '请提供 PN-ALPHA 的报价。' },
  }));
  const firstLine = screen.getByRole('region', { name: '需求行 1 · PN-ALPHA' });
  expect(await within(firstLine).findByText('排队中')).toBeTruthy();
  expect(within(firstLine).queryByText('已发送')).toBeNull();
});

it('shows the selected inquiry reply details and downloads attachments through the same-origin files route', async () => {
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [replyEmail()];
  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '核对 Supplier sent 的回邮' }));

  expect(mocks.requestedInquiryIds).toContain('sent');
  expect(await screen.findByText('USD 125 each for PN-ALPHA. Lead time 8 days.')).toBeTruthy();
  expect(screen.getByText('Vendor Reply <vendor@example.com>')).toBeTruthy();
  expect(screen.getByText('Matched by inquiry number.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '下载' }));
  await waitFor(() => expect(mocks.fileApi.download).toHaveBeenCalledWith('stored-1'));
  expect(mocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'quote.pdf');
});

it('surfaces partial attachment ingestion failures for manual review', async () => {
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [partiallyStoredReplyEmail()];
  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '核对 Supplier sent 的回邮' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('1 attachment exceeded the configured size limit.');
});

it('keeps manual draft creation available when AI extraction fails', async () => {
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [replyEmail()];
  mocks.sourcingAiTaskApi.create.mockResolvedValue(extractionTask({ status: 'FAILED', draftId: null, errorSummary: '模型不可用', completedAt: null }));
  mocks.supplierQuoteDraftApi.create.mockImplementation(async ({ payload }: { payload: SupplierQuoteDraftPayload }) => quoteDraft(payload));
  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '核对 Supplier sent 的回邮' }));
  fireEvent.click(await screen.findByRole('button', { name: 'AI 提取草稿' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('模型不可用');
  const manualButton = screen.getByRole('button', { name: '新建手工草稿' });
  expect(manualButton).toBeEnabled();
  fireEvent.click(manualButton);

  expect(await screen.findByRole('region', { name: '报价草稿编辑' })).toBeTruthy();
  expect(mocks.supplierQuoteDraftApi.create).toHaveBeenCalledWith({
    emailId: 'reply-1',
    inquiryId: 'sent',
    payload: {
      items: [{
        itemKey: 'inquiry-item:inquiry-item-sent',
        inquiryItemId: 'inquiry-item-sent',
        partNumber: 'PN-ALPHA',
        quantity: lineOne.quantity,
        unitPrice: null,
        currency: null,
        leadTimeDays: null,
        validUntil: null,
        taxIncluded: null,
        freightIncluded: null,
        incoterm: null,
        evidenceText: null,
      }],
    },
  });
});

it('retries a persisted failed AI extraction task and restores the created draft', async () => {
  const payload: SupplierQuoteDraftPayload = {
    items: [{ itemKey: 'item-1', inquiryItemId: 'inquiry-item-sent', partNumber: 'PN-ALPHA', quantity: 2, unitPrice: 125, currency: 'USD', leadTimeDays: 8 }],
  };
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [replyEmail()];
  mocks.sourcingAiTaskApi.create.mockResolvedValue(extractionTask({ status: 'FAILED', draftId: null, errorSummary: 'AI 抽取失败，请稍后重试', completedAt: null }));
  mocks.sourcingAiTaskApi.retry.mockResolvedValue(extractionTask({ attempt: 2 }));
  mocks.supplierQuoteDraftApi.getById.mockResolvedValue(quoteDraft(payload, 1));

  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '核对 Supplier sent 的回邮' }));
  fireEvent.click(await screen.findByRole('button', { name: 'AI 提取草稿' }));
  fireEvent.click(await screen.findByRole('button', { name: '重试任务' }));

  await waitFor(() => expect(mocks.sourcingAiTaskApi.retry).toHaveBeenCalledWith('task-1'));
  expect(await screen.findByText('报价草稿 · v1')).toBeTruthy();
  expect(mocks.supplierQuoteDraftApi.getById).toHaveBeenCalledWith('draft-1');
});

it('polls a queued background extraction task until its draft is ready', async () => {
  const payload: SupplierQuoteDraftPayload = {
    items: [{ itemKey: 'item-1', inquiryItemId: 'inquiry-item-sent', partNumber: 'PN-ALPHA', quantity: 2, unitPrice: 125, currency: 'USD', leadTimeDays: 8 }],
  };
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [replyEmail()];
  mocks.sourcingAiTaskApi.create.mockResolvedValue(extractionTask({
    status: 'PENDING', draftId: null, startedAt: null, completedAt: null,
  }));
  mocks.sourcingAiTaskApi.getById.mockResolvedValue(extractionTask());
  mocks.supplierQuoteDraftApi.getById.mockResolvedValue(quoteDraft(payload, 1));

  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '核对 Supplier sent 的回邮' }));
  fireEvent.click(await screen.findByRole('button', { name: 'AI 提取草稿' }));

  expect(await screen.findByText('AI 提取任务已排队，页面将自动刷新结果。')).toBeTruthy();
  await waitFor(() => expect(mocks.sourcingAiTaskApi.getById).toHaveBeenCalledWith('task-1'), { timeout: 2_500 });
  expect(await screen.findByText('报价草稿 · v1')).toBeTruthy();
  expect(mocks.supplierQuoteDraftApi.getById).toHaveBeenCalledWith('draft-1');
});

it('restores an existing draft after reopening the reply review', async () => {
  const savedPayload: SupplierQuoteDraftPayload = {
    items: [{ itemKey: 'saved-item', inquiryItemId: 'inquiry-item-sent', partNumber: 'PN-ALPHA', quantity: 2, unitPrice: 125, currency: 'USD', leadTimeDays: 8 }],
  };
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [replyEmail()];
  mocks.supplierQuoteDraftApi.getLatest.mockResolvedValue(quoteDraft(savedPayload, 6));

  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '核对 Supplier sent 的回邮' }));

  expect(await screen.findByText('报价草稿 · v6')).toBeTruthy();
  expect(mocks.supplierQuoteDraftApi.getLatest).toHaveBeenCalledWith('reply-1', 'sent');
  expect(screen.queryByRole('button', { name: 'AI 提取草稿' })).toBeNull();
});

it('recovers the latest persisted extraction task after reopening the reply review', async () => {
  const recoveredPayload: SupplierQuoteDraftPayload = {
    items: [{ itemKey: 'recovered-item', inquiryItemId: 'inquiry-item-sent', partNumber: 'PN-ALPHA', quantity: 2, unitPrice: 130, currency: 'USD', leadTimeDays: 9 }],
  };
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [replyEmail()];
  mocks.sourcingAiTaskApi.list.mockResolvedValue([extractionTask()]);
  mocks.supplierQuoteDraftApi.getById.mockResolvedValue(quoteDraft(recoveredPayload, 2));

  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '核对 Supplier sent 的回邮' }));

  expect(await screen.findByText('报价草稿 · v2')).toBeTruthy();
  expect(mocks.sourcingAiTaskApi.list).toHaveBeenCalledWith({ limit: 1, emailId: 'reply-1', inquiryId: 'sent' });
  expect(mocks.supplierQuoteDraftApi.getById).toHaveBeenCalledWith('draft-1');
});

it('blocks incomplete, non-USD and ranged-lead-time drafts, then uses expected versions for save and confirm', async () => {
  const rangePayload: SupplierQuoteDraftPayload = {
    items: [{
      itemKey: 'item-1', inquiryItemId: 'inquiry-item-sent', partNumber: 'PN-ALPHA', quantity: 2,
      unitPrice: 125, currency: 'EUR', leadTimeMinDays: 8, leadTimeMaxDays: 12,
      validUntil: '2026-10-01', evidenceText: 'Vendor email body',
    }],
  };
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [replyEmail()];
  mocks.sourcingAiTaskApi.create.mockResolvedValue(extractionTask());
  mocks.supplierQuoteDraftApi.getById.mockResolvedValue(quoteDraft(rangePayload, 2));
  mocks.supplierQuoteDraftApi.update.mockImplementation(async (_id: string, input: { payload: SupplierQuoteDraftPayload }) => quoteDraft(input.payload, 3));
  mocks.supplierQuoteDraftApi.confirm.mockRejectedValue(new Error('草稿版本冲突'));
  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '核对 Supplier sent 的回邮' }));
  fireEvent.click(await screen.findByRole('button', { name: 'AI 提取草稿' }));

  const confirmButton = await screen.findByRole('button', { name: '确认并录入比价' });
  expect(confirmButton).toBeDisabled();
  expect(screen.getByText(/非 USD/)).toBeTruthy();
  expect(screen.getAllByText(/交期区间/).length).toBeGreaterThan(0);
  expect(screen.getByText(/缺项或格式不符合确认要求/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText('币种 1'), { target: { value: 'USD' } });
  fireEvent.change(screen.getByLabelText('交期（天，单值） 1'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('税费口径 1'), { target: { value: 'included' } });
  fireEvent.change(screen.getByLabelText('运费口径 1'), { target: { value: 'excluded' } });
  fireEvent.change(screen.getByLabelText('贸易术语 1'), { target: { value: 'fca' } });
  expect(confirmButton).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  const savedItem = { ...rangePayload.items[0], currency: 'USD', leadTimeDays: 10, taxIncluded: true, freightIncluded: false, incoterm: 'FCA' };
  delete savedItem.leadTimeMinDays;
  delete savedItem.leadTimeMaxDays;
  await waitFor(() => expect(mocks.supplierQuoteDraftApi.update).toHaveBeenCalledWith('draft-1', {
    expectedVersion: 2,
    payload: { items: [savedItem] },
  }));
  await waitFor(() => expect(confirmButton).toBeEnabled());
  fireEvent.click(confirmButton);
  expect(await screen.findByRole('alert')).toHaveTextContent('草稿版本冲突');
  expect(mocks.supplierQuoteDraftApi.confirm).toHaveBeenCalledWith('draft-1', { expectedVersion: 3 });
  expect(mocks.refetchInquiries).not.toHaveBeenCalled();
  expect(screen.queryByText(/已创建正式报价并刷新逐行比价/)).toBeNull();
});

it('refreshes per-line comparisons only after the server confirms supplier quote creation', async () => {
  const completePayload: SupplierQuoteDraftPayload = {
    items: [{ itemKey: 'item-1', inquiryItemId: 'inquiry-item-sent', partNumber: 'PN-ALPHA', quantity: 2, unitPrice: 125, currency: 'USD', leadTimeDays: 8 }],
  };
  const extracted = quoteDraft(completePayload, 4);
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [replyEmail()];
  mocks.sourcingAiTaskApi.create.mockResolvedValue(extractionTask());
  mocks.supplierQuoteDraftApi.getById.mockResolvedValue(extracted);
  mocks.supplierQuoteDraftApi.confirm.mockResolvedValue({
    draftId: 'draft-1', status: 'CONFIRMED', version: 5, reused: false,
    supplierQuoteIds: ['quote-confirmed'], createdSupplierQuoteIds: ['quote-confirmed'],
    reusedSupplierQuoteIds: [], supplierQuotes: [],
  });
  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '核对 Supplier sent 的回邮' }));
  fireEvent.click(await screen.findByRole('button', { name: 'AI 提取草稿' }));
  const confirmButton = await screen.findByRole('button', { name: '确认并录入比价' });
  expect(confirmButton).toBeEnabled();
  fireEvent.click(confirmButton);

  expect(await screen.findByText(/已创建正式报价并刷新逐行比价/)).toHaveTextContent('quote-confirmed');
  expect(mocks.supplierQuoteDraftApi.confirm).toHaveBeenCalledWith('draft-1', { expectedVersion: 4 });
  await waitFor(() => expect(mocks.refetchInquiries).toHaveBeenCalled());
  await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(4));
});
