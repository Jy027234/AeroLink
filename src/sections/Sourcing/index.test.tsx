import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Sourcing } from './index';
import type { Inquiry, SourcingAiTaskRecord, SupplierQuoteCompareResult, SupplierQuoteDraftPayload, SupplierQuoteDraftRecord } from '@/api/client';
import type { Email, RFQ, RfqLine, Supplier } from '@/types';
import { useCapabilityStore } from '@/store';

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
  rfqApi: { getSourcingCandidates: vi.fn(), getSourcingTimeline: vi.fn() },
  supplierQuoteApi: { selectWinner: vi.fn(), clearWinner: vi.fn() },
  inquiryApi: { cancelSend: vi.fn(), getById: vi.fn() },
  sourcingActionTaskApi: { create: vi.fn(), list: vi.fn(), getById: vi.fn(), confirm: vi.fn(), retry: vi.fn(), cancel: vi.fn() },
  supplierQuoteDraftApi: {
    create: vi.fn(),
    extract: vi.fn(),
    getById: vi.fn(),
    getLatest: vi.fn(),
    update: vi.fn(),
    confirm: vi.fn(),
  },
  sourcingAiTaskApi: { create: vi.fn(), list: vi.fn(), getById: vi.fn(), retry: vi.fn(), cancel: vi.fn(), confirmDraft: vi.fn() },
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

vi.mock('@/api/client', () => ({ emailApi: mocks.emailApi, rfqApi: mocks.rfqApi, supplierQuoteApi: mocks.supplierQuoteApi, inquiryApi: mocks.inquiryApi, fileApi: mocks.fileApi, sourcingActionTaskApi: mocks.sourcingActionTaskApi, sourcingAiTaskApi: mocks.sourcingAiTaskApi, supplierQuoteDraftApi: mocks.supplierQuoteDraftApi }));
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
    updatedAt: '2026-09-25T08:00:00.000Z',
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
    comparisonEligibility: { eligible: true, reasons: [], warnings: [] },
  }] : lineId === 'line-2' ? [{
    id: `quote-${lineId}`,
    updatedAt: '2026-09-25T08:00:00.000Z',
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
    comparisonEligibility: { eligible: true, reasons: [], warnings: [] },
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
    status: deliveryStatus === 'queued' || deliveryStatus === 'failed' || deliveryStatus === 'needs_verification' ? 'queued' : deliveryStatus === 'sent' || deliveryStatus === 'smtp_accepted' ? 'sent' : 'draft',
    deliveryStatus,
    latestOutboundEmail: {
      id: `email-${id}`,
      status: deliveryStatus,
      canCancel: deliveryStatus === 'queued',
      manualVerificationRequired: deliveryStatus === 'needs_verification',
      manualVerificationMessage: deliveryStatus === 'needs_verification'
        ? '邮件投递结果无法确认，请核对发件箱或联系供应商。'
        : null,
    },
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
  window.location.href = 'http://localhost/';
  mocks.rfqs = [rfq];
  mocks.inquiries = [];
  mocks.suppliers = [];
  mocks.emails = [];
  mocks.pendingMatchEmails = [];
  mocks.pendingEmailQueryOptions = [];
  mocks.requestedInquiryIds = [];
  mocks.emailApi.linkToInquiry.mockReset();
  mocks.emailApi.linkToInquiry.mockResolvedValue({ id: 'link-1' });
  mocks.rfqApi.getSourcingCandidates.mockResolvedValue({ rfqId: 'rfq-1', rfqNumber: 'RFQ-TEST', lines: [], limits: { candidatesPerLine: 20, evidenceTruncated: false } });
  mocks.rfqApi.getSourcingTimeline.mockResolvedValue({ rfqId: 'rfq-1', events: [] });
  mocks.supplierQuoteApi.selectWinner.mockReset();
  mocks.supplierQuoteApi.selectWinner.mockResolvedValue({ id: 'quote-line-1' });
  mocks.supplierQuoteApi.clearWinner.mockReset();
  mocks.supplierQuoteApi.clearWinner.mockResolvedValue({ id: 'quote-line-1', isWinner: false });
  mocks.inquiryApi.cancelSend.mockReset();
  mocks.inquiryApi.getById.mockReset();
  mocks.inquiryApi.cancelSend.mockImplementation(async (id: string) => {
    const current = mocks.inquiries.find((candidate) => candidate.id === id)!;
    return {
      ...current,
      status: 'draft',
      deliveryStatus: 'cancelled',
      latestOutboundEmail: {
        ...current.latestOutboundEmail,
        status: 'withdrawn',
        canCancel: false,
        manualVerificationRequired: false,
        manualVerificationMessage: null,
      },
    };
  });
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
  mocks.sourcingAiTaskApi.confirmDraft.mockReset();
  mocks.sourcingActionTaskApi.create.mockReset();
  mocks.sourcingActionTaskApi.list.mockReset().mockResolvedValue([]);
  mocks.sourcingActionTaskApi.getById.mockReset();
  mocks.sourcingActionTaskApi.confirm.mockReset();
  mocks.sourcingActionTaskApi.retry.mockReset();
  mocks.sourcingActionTaskApi.cancel.mockReset();
  mocks.sourcingActionTaskApi.create.mockImplementation(async (payload: { action: string; targetId: string; content?: { subject: string; textBody: string } }) => ({
    id: `action-${payload.targetId}`, action: payload.action, targetId: payload.targetId,
    status: 'WAITING_HUMAN', version: 1, contentSnapshot: payload.content
      ? { subject: payload.content.subject.trim(), textBody: payload.content.textBody.trim() } : null,
  }));
  mocks.sourcingActionTaskApi.confirm.mockImplementation(async (id: string) => ({
    id, status: 'COMPLETED', version: 1,
    ...(id.includes('quote')
      ? { outboundEmailId: null, result: { supplierQuoteId: 'quote-line-1', rfqLineId: 'line-1', isWinner: true, status: 'accepted' } }
      : { outboundEmailId: 'email-draft', result: { inquiryId: 'draft', inquiryStatus: 'QUEUED', outboundEmailId: 'email-draft', outboundEmailStatus: 'PENDING', outboxEventId: 'outbox-1' } }),
  }));
  mocks.fileApi.download.mockReset();
  mocks.fileApi.download.mockResolvedValue(new Blob(['quote']));
  mocks.downloadBlob.mockReset();
  mocks.refetchInquiries.mockResolvedValue(undefined);
  useCapabilityStore.setState({ grants: [
    { capability: 'supplier_quote.update', scope: 'all' },
    { capability: 'supplier_quote.read', scope: 'all' },
    { capability: 'quotation.create', scope: 'all' },
  ] });
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

it('shows natural reply drafts side by side with exact-line isolation and missing-term prompts, without ranking them', async () => {
  mocks.rfqs = [{ ...rfq, lines: [lineOne, { ...lineTwo, partNumber: 'PN-ALPHA' }] }];
  const base = {
    inquiryId: 'sent', inquiryItemId: 'item-1', draftId: 'draft-1', draftVersion: 1, emailId: 'reply-1',
    source: 'ai' as const, partNumber: 'PN-ALPHA', quantity: null, quantityUnit: null,
    unitPrice: 100, currency: 'CNY', leadTimeDays: null, leadTimeMinDays: null, leadTimeMaxDays: null,
    condition: null, certificate: null, taxIncluded: true, freightIncluded: true, validUntil: null,
  };
  mocks.rfqApi.getSourcingTimeline.mockResolvedValue({ rfqId: 'rfq-1', events: [], pendingQuoteRows: [
    { ...base, rfqLineId: 'line-1', supplierName: 'Pending QQ Supplier' },
    { ...base, rfqLineId: 'line-1', inquiryId: 'hot', inquiryItemId: 'item-2', draftId: 'draft-2', emailId: 'reply-2', supplierName: 'Pending Hotmail Supplier', unitPrice: 150, taxIncluded: null, freightIncluded: null },
    { ...base, rfqLineId: 'line-1', inquiryId: 'bms', inquiryItemId: 'item-3', draftId: 'draft-3', emailId: 'reply-3', supplierName: 'Pending BMS Supplier', unitPrice: 2560, leadTimeMinDays: 5, leadTimeMaxDays: 10 },
    { ...base, rfqLineId: 'line-2', inquiryItemId: 'item-4', draftId: 'draft-4', supplierName: 'Other Line Supplier' },
  ] });

  render(<Sourcing />);
  selectRfq();
  const firstLine = await screen.findByRole('region', { name: '需求行 1 · PN-ALPHA' });
  const secondLine = screen.getByRole('region', { name: '需求行 2 · PN-ALPHA' });
  const pendingFirst = await within(firstLine).findByRole('region', { name: '需求行待核实报价' });
  const pendingSecond = within(secondLine).getByRole('region', { name: '需求行待核实报价' });
  expect(within(pendingFirst).getByText('Pending QQ Supplier')).toBeInTheDocument();
  expect(within(pendingFirst).getByText('Pending Hotmail Supplier')).toBeInTheDocument();
  expect(within(pendingFirst).getByText('Pending BMS Supplier')).toBeInTheDocument();
  expect(within(pendingFirst).queryByText('Other Line Supplier')).toBeNull();
  expect(within(pendingSecond).getByText('Other Line Supplier')).toBeInTheDocument();
  expect(within(pendingFirst).getAllByText('非 USD，不能直接参与最低价')).toHaveLength(3);
  expect(within(pendingFirst).getByText('5–10 天')).toBeInTheDocument();
  expect(within(pendingFirst).getAllByText('可供数量待核')).toHaveLength(3);
  expect(within(pendingFirst).queryByRole('button', { name: /中选/ })).toBeNull();
  expect(within(pendingFirst).getAllByRole('button', { name: '核对原邮件与草稿' })).toHaveLength(3);
});

it('requires a person to confirm an eligible row-level winner and refreshes persisted comparison and timeline', async () => {
  render(<Sourcing />);
  selectRfq();
  const firstLine = await screen.findByRole('region', { name: '需求行 1 · PN-ALPHA' });
  const selectButton = await within(firstLine).findByRole('button', { name: '选为中选供应商' });
  expect(selectButton).toBeEnabled();

  fireEvent.click(selectButton);
  expect(mocks.sourcingActionTaskApi.confirm).not.toHaveBeenCalled();
  await waitFor(() => expect(mocks.sourcingActionTaskApi.list).toHaveBeenCalledWith({ targetId: 'quote-line-1', limit: 20 }));
  fireEvent.click(screen.getByRole('button', { name: '保存待确认中选任务' }));
  await waitFor(() => expect(mocks.sourcingActionTaskApi.create).toHaveBeenCalledWith(expect.objectContaining({
    action: 'SELECT_WINNER', targetId: 'quote-line-1', expectedUpdatedAt: '2026-09-25T08:00:00.000Z',
  })));
  expect(mocks.sourcingActionTaskApi.confirm).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: '确认中选' }));
  await waitFor(() => expect(mocks.sourcingActionTaskApi.confirm).toHaveBeenCalledWith('action-quote-line-1', 1));
  expect(mocks.supplierQuoteApi.selectWinner).not.toHaveBeenCalled();
  await waitFor(() => expect(mocks.compare.mock.calls.length).toBeGreaterThanOrEqual(4));
  await waitFor(() => expect(mocks.rfqApi.getSourcingTimeline.mock.calls.length).toBeGreaterThanOrEqual(2));
});

it('restores a persisted winner task and confirms its saved version without restaging', async () => {
  mocks.sourcingActionTaskApi.list.mockResolvedValue([{
    id: 'persisted-winner-1', action: 'SELECT_WINNER', targetId: 'quote-line-1',
    status: 'WAITING_HUMAN', version: 4,
  }]);
  mocks.sourcingActionTaskApi.confirm.mockResolvedValue({
    id: 'persisted-winner-1', status: 'COMPLETED', version: 4,
    result: { supplierQuoteId: 'quote-line-1', rfqLineId: 'line-1', isWinner: true, status: 'accepted' },
  });
  render(<Sourcing />);
  selectRfq();
  const firstLine = await screen.findByRole('region', { name: '需求行 1 · PN-ALPHA' });
  fireEvent.click(await within(firstLine).findByRole('button', { name: '选为中选供应商' }));
  expect(await screen.findByText(/persisted-winner-1/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '确认中选' }));
  await waitFor(() => expect(mocks.sourcingActionTaskApi.confirm).toHaveBeenCalledWith('persisted-winner-1', 4));
  expect(mocks.sourcingActionTaskApi.create).not.toHaveBeenCalled();
});

it('requires a person to confirm clearing the current row winner without selecting another quote', async () => {
  mocks.compare.mockImplementation(({ rfqLineId }: { rfqLineId?: string }) => {
    const result = comparison(rfqLineId ?? '', 'Selected Supplier', 125);
    if (rfqLineId === 'line-1' && result.quotes[0]) result.quotes[0].isWinner = true;
    return Promise.resolve(result);
  });
  render(<Sourcing />);
  selectRfq();

  const firstLine = await screen.findByRole('region', { name: '需求行 1 · PN-ALPHA' });
  fireEvent.click(await within(firstLine).findByRole('button', { name: '取消当前中选' }));
  expect(mocks.supplierQuoteApi.clearWinner).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认取消中选' }));

  await waitFor(() => expect(mocks.supplierQuoteApi.clearWinner).toHaveBeenCalledWith('quote-line-1', '2026-09-25T08:00:00.000Z'));
  expect(mocks.supplierQuoteApi.selectWinner).not.toHaveBeenCalled();
});

it('disables row-level winner selection when the server marks a quote ineligible', async () => {
  mocks.compare.mockImplementation(({ rfqLineId }: { rfqLineId?: string }) => {
    const result = comparison(rfqLineId ?? '', 'Ineligible Supplier', 125);
    if (result.quotes[0]) result.quotes[0].comparisonEligibility = { eligible: false, reasons: ['报价已过期'], warnings: [] };
    return Promise.resolve(result);
  });
  render(<Sourcing />);
  selectRfq();

  const firstLine = await screen.findByRole('region', { name: '需求行 1 · PN-ALPHA' });
  expect(await within(firstLine).findByRole('button', { name: '选为中选供应商' })).toBeDisabled();
  expect(mocks.supplierQuoteApi.selectWinner).not.toHaveBeenCalled();
});

it('renders persisted sourcing events chronologically and does not infer a missing actor', async () => {
  mocks.rfqApi.getSourcingTimeline.mockResolvedValue({ rfqId: 'rfq-1', events: [
    { id: 'winner', type: 'WINNER_SELECTED', status: 'SELECTED', occurredAt: '2026-09-22T10:00:00.000Z', actor: null, rfqLineId: 'line-1', supplierQuoteId: 'quote-line-1', summary: 'Supplier selected' },
    { id: 'inbound', type: 'INBOUND_EMAIL', status: 'RECEIVED', occurredAt: '2026-09-22T09:30:00.000Z', actor: { id: 'external-1', name: 'Unverified sender', kind: 'external_email' }, rfqLineId: 'line-1', emailId: 'reply-1', summary: 'Supplier reply received' },
    { id: 'draft-revised', type: 'QUOTE_DRAFT_REVISED', status: 'SAVED', occurredAt: '2026-09-22T09:45:00.000Z', actor: { id: 'user-1', name: 'Sales One', kind: 'user' }, rfqLineId: 'line-1', draftId: 'draft-1', summary: '报价草稿已人工修订（v2）' },
    { id: 'send-confirmed', type: 'INQUIRY_SEND_CONFIRMED', status: 'QUEUED', occurredAt: '2026-09-22T08:59:00.000Z', actor: { id: 'user-1', name: 'Sales One', kind: 'user' }, rfqLineId: 'line-1', outboundEmailId: 'outbound-1', summary: 'Human confirmed this outbound version' },
    { id: 'outbound', type: 'OUTBOUND_EMAIL', status: 'SMTP_ACCEPTED', occurredAt: '2026-09-22T09:00:00.000Z', actor: null, rfqLineId: 'line-1', outboundEmailId: 'outbound-1', summary: 'Inquiry accepted by SMTP' },
  ] });
  render(<Sourcing />);
  selectRfq();

  const timeline = await screen.findByRole('region', { name: '寻源业务时间线' });
  const events = within(timeline).getAllByRole('article');
  expect(events).toHaveLength(5);
  expect(events[0]).toHaveTextContent('人工确认询价发送');
  expect(events[0]).toHaveTextContent('Sales One');
  expect(events[0]).toHaveTextContent('发件版本: outbound-1');
  expect(events[1]).toHaveTextContent('SMTP_ACCEPTED');
  expect(events[1]).toHaveTextContent('未记录');
  expect(events[2]).toHaveTextContent('external_email');
  expect(events[2]).toHaveTextContent('外部发件人身份未验证');
  expect(events[3]).toHaveTextContent('人工修订报价草稿');
  expect(events[3]).toHaveTextContent('草稿: draft-1');
  expect(events[4]).toHaveTextContent('SELECTED');
  expect(events[4]).toHaveTextContent('未记录');
  expect(events[4]).toHaveTextContent('quote-line-1');
});

it('shows the immutable AI candidate snapshot separately from later human revision events', async () => {
  mocks.rfqApi.getSourcingTimeline.mockResolvedValue({ rfqId: 'rfq-1', events: [
    {
      id: 'ai-draft', type: 'QUOTE_DRAFT', status: 'DRAFT', occurredAt: '2026-09-22T09:00:00.000Z',
      actor: null, rfqLineId: 'line-1', draftId: 'draft-1', summary: 'AI candidate draft',
      originalAiCandidates: {
        available: true, candidateCount: 1, truncated: false,
        items: [{
          itemKey: 'item-1', inquiryItemId: 'inquiry-item-1', partNumber: 'PN-ORIGINAL',
          quantity: 2, quantityUnit: 'EA', unitPrice: 100, currency: 'USD',
          leadTimeDays: 5, leadTimeMinDays: null, leadTimeMaxDays: null, validUntil: '2026-12-31',
          taxIncluded: true, freightIncluded: false, incoterm: 'FCA',
        }],
      },
    },
    {
      id: 'draft-revised', type: 'QUOTE_DRAFT_REVISED', status: 'SAVED', occurredAt: '2026-09-22T09:30:00.000Z',
      actor: { id: 'user-1', name: 'Sales One', kind: 'user' }, rfqLineId: 'line-1', draftId: 'draft-1',
      summary: '报价草稿已人工修订（v2）',
    },
  ] });
  render(<Sourcing />);
  selectRfq();

  const timeline = await screen.findByRole('region', { name: '寻源业务时间线' });
  const events = within(timeline).getAllByRole('article');
  expect(events).toHaveLength(2);
  expect(events[0]).toHaveTextContent('AI 建稿时原始建议快照');
  expect(events[0]).toHaveTextContent('PN-ORIGINAL');
  expect(events[0]).toHaveTextContent('100 USD');
  expect(events[1]).toHaveTextContent('人工修订报价草稿');
  expect(events[1]).toHaveTextContent('Sales One');
});

it('opens an RFQ directly at the linked demand line and quote row', async () => {
  window.location.href = 'http://localhost/sourcing?rfqId=rfq-1&rfqLineId=line-2&supplierQuoteId=quote-line-2';
  expect(window.location.search).toContain('rfqId=rfq-1');
  render(<Sourcing />);
  expect(window.location.search).toContain('rfqId=rfq-1');

  const secondLine = await screen.findByRole('region', { name: '需求行 2 · PN-BETA' });
  expect(secondLine).toHaveAttribute('id', 'sourcing-line-line-2');
  const quoteRow = await within(secondLine).findByText('Quote Beta Supplier');
  expect(quoteRow.closest('tr')).toHaveAttribute('id', 'sourcing-quote-quote-line-2');
  expect(secondLine).toHaveClass('ring-2');
  expect(quoteRow.closest('tr')).toHaveClass('bg-blue-50');
});

it('shows source-backed supplier candidates per demand line without claiming current supply', async () => {
  mocks.rfqApi.getSourcingCandidates.mockResolvedValue({ rfqId: 'rfq-1', rfqNumber: 'RFQ-TEST', lines: [
    { id: 'line-1', rfqLineId: 'line-1', lineNo: 1, partNumber: 'PN-ALPHA', sourcingStatus: 'EVIDENCE_FOUND',
      candidatesTruncated: false, candidates: [{ supplier: { id: 'supplier-1', name: 'Evidence Supplier', status: 'active', level: 'A' },
        currentSupplyPromiseVerified: false, evidence: [{ type: 'HISTORICAL_SUPPLIER_QUOTE' }] }] },
    { id: 'line-2', rfqLineId: 'line-2', lineNo: 2, partNumber: 'PN-BETA', sourcingStatus: 'INQUIRY_REQUIRED',
      candidatesTruncated: false, candidates: [] },
  ], limits: { candidatesPerLine: 20, evidenceTruncated: false } });
  render(<Sourcing />);
  selectRfq();
  const first = await screen.findByRole('region', { name: '需求行 1 · PN-ALPHA' });
  const second = screen.getByRole('region', { name: '需求行 2 · PN-BETA' });
  expect(await within(first).findByText('Evidence Supplier')).toBeInTheDocument();
  expect(within(first).getByText('历史报价')).toBeInTheDocument();
  expect(within(second).queryByText('Evidence Supplier')).not.toBeInTheDocument();
  expect(within(second).getByText(/暂无可核实候选依据/)).toBeInTheDocument();
  expect(mocks.rfqApi.getSourcingCandidates).toHaveBeenCalledWith('rfq-1');
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

it('distinguishes queued, uncertain and SMTP-accepted inquiries on their own demand lines', async () => {
  mocks.inquiries = [inquiry('queued', lineOne, 'queued'), inquiry('failed', lineOne, 'needs_verification'), inquiry('sent', lineTwo, 'smtp_accepted')];
  render(<Sourcing />);
  selectRfq();

  const firstLine = screen.getByRole('region', { name: '需求行 1 · PN-ALPHA' });
  const secondLine = screen.getByRole('region', { name: '需求行 2 · PN-BETA' });
  expect(await within(firstLine).findByText('排队中（Worker 尚未领取）')).toBeTruthy();
  expect(within(firstLine).getByText('需人工核实投递结果')).toBeTruthy();
  expect(within(firstLine).getByRole('alert')).toHaveTextContent('核对发件箱或联系供应商');
  expect(within(firstLine).queryByText('已发送')).toBeNull();
  expect(await within(secondLine).findByText('SMTP 已接受，未确认收件方收到')).toBeTruthy();
  expect(within(secondLine).getByText(/不证明供应商已收到或阅读/)).toBeTruthy();
  expect(within(secondLine).queryByText('排队中')).toBeNull();
  expect(within(firstLine).queryByRole('button', { name: '预览 Supplier queued 的询价邮件' })).toBeNull();
  expect(within(firstLine).queryByRole('button', { name: '预览 Supplier failed 的询价邮件' })).toBeNull();
  expect(within(secondLine).queryByRole('button', { name: '预览 Supplier sent 的询价邮件' })).toBeNull();
});

it('allows cancelling an unclaimed inquiry and offers no retry for an uncertain outcome', async () => {
  mocks.inquiries = [inquiry('queued', lineOne, 'queued'), inquiry('uncertain', lineOne, 'needs_verification')];
  render(<Sourcing />);
  selectRfq();

  const firstLine = screen.getByRole('region', { name: '需求行 1 · PN-ALPHA' });
  const cancel = await within(firstLine).findByRole('button', { name: '取消 Supplier queued 的排队询价发送' });
  expect(within(firstLine).getByRole('alert')).toHaveTextContent('核对发件箱或联系供应商');
  expect(within(firstLine).queryByRole('button', { name: /重试|再次发送/ })).toBeNull();

  fireEvent.click(cancel);

  await waitFor(() => expect(mocks.inquiryApi.cancelSend).toHaveBeenCalledWith('queued'));
  await waitFor(() => expect(mocks.refetchInquiries).toHaveBeenCalled());
  expect(await within(firstLine).findByRole('button', { name: '预览 Supplier queued 的询价邮件' })).toBeTruthy();
  expect(within(firstLine).getByText('已安全取消（Worker 未领取）')).toBeTruthy();
});

it('stages the edited message for a second human confirmation and preserves queued versus delivered status', async () => {
  const draft = inquiry('draft', lineOne, 'draft');
  mocks.inquiries = [draft];
  mocks.inquiryApi.getById.mockResolvedValue({
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
  await waitFor(() => expect(mocks.sourcingActionTaskApi.list).toHaveBeenCalledWith({ targetId: 'draft', limit: 20 }));
  fireEvent.click(screen.getByRole('button', { name: '保存待确认邮件版本' }));

  await waitFor(() => expect(mocks.sourcingActionTaskApi.create).toHaveBeenCalledWith(expect.objectContaining({
    action: 'SEND_INQUIRY', targetId: 'draft',
    content: { subject: '报价请求 RFQ-TEST', textBody: '请提供 PN-ALPHA 的报价。' },
  })));
  expect(mocks.sourcingActionTaskApi.confirm).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: '确认此版本并入队' }));
  await waitFor(() => expect(mocks.sourcingActionTaskApi.confirm).toHaveBeenCalledWith('action-draft', 1));
  expect(mocks.send).not.toHaveBeenCalled();
  const firstLine = screen.getByRole('region', { name: '需求行 1 · PN-ALPHA' });
  expect(await within(firstLine).findByText('排队中（Worker 尚未领取）')).toBeTruthy();
  expect(within(firstLine).queryByText('已发送')).toBeNull();
});

it('restores a staged send after reopening and confirms its immutable content without restaging', async () => {
  const draft = inquiry('draft', lineOne, 'draft');
  mocks.inquiries = [draft];
  mocks.sourcingActionTaskApi.list.mockResolvedValue([{
    id: 'persisted-send-1', action: 'SEND_INQUIRY', targetId: 'draft', status: 'WAITING_HUMAN', version: 3,
    contentSnapshot: { subject: 'Persisted subject', textBody: 'Persisted body' },
  }]);
  mocks.inquiryApi.getById.mockResolvedValue({ ...draft, status: 'queued', deliveryStatus: 'queued' });
  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '预览 Supplier draft 的询价邮件' }));
  expect(await screen.findByDisplayValue('Persisted subject')).toBeDisabled();
  expect(screen.getByDisplayValue('Persisted body')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '确认此版本并入队' }));
  await waitFor(() => expect(mocks.sourcingActionTaskApi.confirm).toHaveBeenCalledWith('persisted-send-1', 3));
  expect(mocks.sourcingActionTaskApi.create).not.toHaveBeenCalled();
});

it('allows a failed send task to be retried without automatically queueing mail', async () => {
  mocks.inquiries = [inquiry('draft', lineOne, 'draft')];
  mocks.sourcingActionTaskApi.list.mockResolvedValue([{
    id: 'failed-send-1', action: 'SEND_INQUIRY', targetId: 'draft', status: 'FAILED', version: 1,
    attempt: 1, errorSummary: 'SOURCE_VERSION_CHANGED',
    contentSnapshot: { subject: 'Persisted subject', textBody: 'Persisted body' },
  }]);
  mocks.sourcingActionTaskApi.retry.mockResolvedValue({
    id: 'failed-send-1', action: 'SEND_INQUIRY', targetId: 'draft', status: 'WAITING_HUMAN', version: 2,
    contentSnapshot: { subject: 'Persisted subject', textBody: 'Persisted body' },
  });
  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '预览 Supplier draft 的询价邮件' }));
  fireEvent.click(await screen.findByRole('button', { name: '重试待确认任务' }));
  await waitFor(() => expect(mocks.sourcingActionTaskApi.retry).toHaveBeenCalledWith('failed-send-1'));
  expect(mocks.sourcingActionTaskApi.confirm).not.toHaveBeenCalled();
  expect(mocks.sourcingActionTaskApi.create).not.toHaveBeenCalled();
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
        quantityUnit: null,
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
  mocks.sourcingAiTaskApi.confirmDraft.mockRejectedValue(new Error('草稿版本冲突'));
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
  fireEvent.change(screen.getByLabelText('报价数量单位 1'), { target: { value: 'EA' } });
  fireEvent.change(screen.getByLabelText('交期（天，单值） 1'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('税费口径 1'), { target: { value: 'included' } });
  fireEvent.change(screen.getByLabelText('运费口径 1'), { target: { value: 'excluded' } });
  fireEvent.change(screen.getByLabelText('贸易术语 1'), { target: { value: 'fca' } });
  expect(confirmButton).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  const savedItem = { ...rangePayload.items[0], quantityUnit: 'EA', currency: 'USD', leadTimeDays: 10, taxIncluded: true, freightIncluded: false, incoterm: 'FCA' };
  delete savedItem.leadTimeMinDays;
  delete savedItem.leadTimeMaxDays;
  await waitFor(() => expect(mocks.supplierQuoteDraftApi.update).toHaveBeenCalledWith('draft-1', {
    expectedVersion: 2,
    payload: { items: [savedItem] },
  }));
  await waitFor(() => expect(confirmButton).toBeEnabled());
  fireEvent.click(confirmButton);
  expect(await screen.findByRole('alert')).toHaveTextContent('草稿版本冲突');
  expect(mocks.sourcingAiTaskApi.confirmDraft).toHaveBeenCalledWith('task-1', { expectedVersion: 3 });
  expect(mocks.supplierQuoteDraftApi.confirm).not.toHaveBeenCalled();
  expect(mocks.refetchInquiries).not.toHaveBeenCalled();
  expect(screen.queryByText(/已创建正式报价并刷新逐行比价/)).toBeNull();
});

it('refreshes per-line comparisons only after the server confirms supplier quote creation', async () => {
  const completePayload: SupplierQuoteDraftPayload = {
    items: [{ itemKey: 'item-1', inquiryItemId: 'inquiry-item-sent', partNumber: 'PN-ALPHA', quantity: 2, quantityUnit: 'EA', unitPrice: 125, currency: 'USD', leadTimeDays: 8 }],
  };
  const extracted = quoteDraft(completePayload, 4);
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [replyEmail()];
  mocks.sourcingAiTaskApi.create.mockResolvedValue(extractionTask());
  mocks.supplierQuoteDraftApi.getById.mockResolvedValue(extracted);
  mocks.sourcingAiTaskApi.confirmDraft.mockResolvedValue({
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
  expect(mocks.sourcingAiTaskApi.confirmDraft).toHaveBeenCalledWith('task-1', { expectedVersion: 4 });
  expect(mocks.supplierQuoteDraftApi.confirm).not.toHaveBeenCalled();
  await waitFor(() => expect(mocks.refetchInquiries).toHaveBeenCalled());
  await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(4));
});

it('keeps manual quote drafts on the same direct human confirmation command', async () => {
  const completePayload: SupplierQuoteDraftPayload = {
    items: [{ itemKey: 'manual-item', inquiryItemId: 'inquiry-item-sent', partNumber: 'PN-ALPHA', quantity: 2, quantityUnit: 'EA', unitPrice: 125, currency: 'USD', leadTimeDays: 8 }],
  };
  mocks.inquiries = [inquiry('sent', lineOne, 'sent')];
  mocks.emails = [replyEmail()];
  mocks.supplierQuoteDraftApi.create.mockResolvedValue(quoteDraft(completePayload, 1));
  mocks.supplierQuoteDraftApi.confirm.mockResolvedValue({
    draftId: 'draft-1', status: 'CONFIRMED', version: 2, reused: false,
    supplierQuoteIds: ['manual-quote'], createdSupplierQuoteIds: ['manual-quote'],
    reusedSupplierQuoteIds: [], supplierQuotes: [],
  });
  render(<Sourcing />);
  selectRfq();
  fireEvent.click(await screen.findByRole('button', { name: '核对 Supplier sent 的回邮' }));
  fireEvent.click(await screen.findByRole('button', { name: '新建手工草稿' }));
  const confirmButton = await screen.findByRole('button', { name: '确认并录入比价' });
  await waitFor(() => expect(confirmButton).toBeEnabled());
  fireEvent.click(confirmButton);

  await waitFor(() => expect(mocks.supplierQuoteDraftApi.confirm).toHaveBeenCalledWith('draft-1', { expectedVersion: 1 }));
  expect(mocks.sourcingAiTaskApi.confirmDraft).not.toHaveBeenCalled();
});

it('shows exact server-derived waiting counts separately from comparison quantity metrics', async () => {
  mocks.rfqApi.getSourcingTimeline.mockResolvedValue({ rfqId: 'rfq-1', events: [], counts: {
    lines: [
      { rfqLineId: 'line-1', pendingQuoteCount: 2, pendingConfirmationCount: 1 },
      { rfqLineId: 'line-2', pendingQuoteCount: 0, pendingConfirmationCount: 3 },
    ],
    unassignedNeedsVerification: {
      pendingQuoteCount: 1,
      pendingConfirmationCount: 2,
      supplierQuoteCount: 1,
      unreadableDraftCount: 1,
    },
  } });
  mocks.compare.mockImplementation(({ rfqLineId }: { rfqLineId?: string }) => {
    const result = comparison(rfqLineId ?? '', 'Comparable Supplier', 125);
    result.summary = {
      ...result.summary,
      comparableQuoteCount: 1,
      requiredQuantity: 2,
      bestAvailableQuantity: 1,
      remainingQuantityGap: 1,
    };
    return Promise.resolve(result);
  });

  render(<Sourcing />);
  selectRfq();

  const firstLine = await screen.findByRole('region', { name: '需求行 1 · PN-ALPHA' });
  const secondLine = screen.getByRole('region', { name: '需求行 2 · PN-BETA' });
  expect(await within(firstLine).findByText('待报价项: 2')).toBeInTheDocument();
  expect(within(firstLine).getByText('待人工确认项: 1')).toBeInTheDocument();
  expect(within(secondLine).getByText('待报价项: 0')).toBeInTheDocument();
  expect(within(secondLine).getByText('待人工确认项: 3')).toBeInTheDocument();
  expect(await screen.findByRole('status', { name: '未能精确归属的寻源记录' })).toHaveTextContent('正式报价归属待核实: 1');
  expect(within(firstLine).getByText('可比报价: 1')).toBeInTheDocument();
  expect(within(firstLine).getByText('剩余数量缺口: 1 EA')).toBeInTheDocument();
  expect(within(firstLine).getByText(/待办项数与可比报价数不同/)).toBeInTheDocument();
});

it('shows a definitive send failure separately from an unknown delivery outcome', async () => {
  mocks.inquiries = [inquiry('failed', lineOne, 'failed')];
  render(<Sourcing />);
  selectRfq();

  const firstLine = screen.getByRole('region', { name: '需求行 1 · PN-ALPHA' });
  expect(await within(firstLine).findByText('发送失败，请检查配置后再确认是否重发')).toBeInTheDocument();
  expect(within(firstLine).queryByRole('alert')).toBeNull();
  expect(within(firstLine).queryByRole('button', { name: /重试|再次发送/ })).toBeNull();
});

it('shows the server-derived workflow state and concrete next action on the supplier inquiry card', async () => {
  mocks.inquiries = [inquiry('workflow', lineOne, 'smtp_accepted')];
  mocks.rfqApi.getSourcingTimeline.mockResolvedValue({
    rfqId: 'rfq-1', events: [], workflowStates: [{
      inquiryId: 'workflow', status: 'WAITING_REPLY', nextAction: 'FOLLOW_UP_SUPPLIER',
    }],
  });
  render(<Sourcing />);
  selectRfq();

  const firstLine = screen.getByRole('region', { name: '需求行 1 · PN-ALPHA' });
  const workflow = await within(firstLine).findByLabelText('询价处理流程状态');
  expect(workflow).toHaveTextContent('待供应商回邮');
  expect(workflow).toHaveTextContent('人工跟进供应商是否已回复');
});

it('shows the demand-line stage as quote-record coverage without claiming quantity or purchasing completion', async () => {
  mocks.inquiries = [inquiry('workflow-line', lineOne, 'smtp_accepted')];
  mocks.rfqApi.getSourcingTimeline.mockResolvedValue({
    rfqId: 'rfq-1', events: [], lineWorkflowStates: [{
      rfqLineId: lineOne.id, status: 'COMPLETED', nextAction: 'REVIEW_COMPARISON',
      inquiryIds: ['workflow-line'], quoteCoverage: {
        currentFormalQuoteCount: 1, activeInquiryItemCount: 1, quotedInquiryItemCount: 1,
        basis: 'CURRENT_FORMAL_QUOTE_RECORDS_ONLY',
        quantitySufficiencyAssessed: false, purchasingCommitted: false,
      },
    }],
  });
  render(<Sourcing />);
  selectRfq();

  const firstLine = screen.getByRole('region', { name: '需求行 1 · PN-ALPHA' });
  const stage = await within(firstLine).findByLabelText('需求行寻源阶段');
  expect(stage).toHaveTextContent('需求项均有正式报价');
  expect(stage).toHaveTextContent('当前正式报价覆盖询价项: 1/1');
  expect(stage).toHaveTextContent('数量、商务条件与采购承诺须另行核对');
});
