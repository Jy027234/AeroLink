import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseEmailById: vi.fn(),
  createRFQ: vi.fn(),
  useEmails: vi.fn(),
  useCustomers: vi.fn(),
  markAsRead: vi.fn(),
  classify: vi.fn(),
  discard: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  aiApi: { parseEmailById: mocks.parseEmailById },
  emailApi: { markAsRead: mocks.markAsRead, classify: mocks.classify, discard: mocks.discard },
}));
vi.mock('@/hooks/useApi', () => ({ useEmails: mocks.useEmails }));
vi.mock('@/features/rfqs', () => ({
  useRFQs: () => ({ loading: false, refetch: vi.fn() }),
  useCreateRFQ: () => ({ mutate: mocks.createRFQ }),
}));
vi.mock('@/features/customers', () => ({ useCustomers: mocks.useCustomers }));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'zh-CN' }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { IngestionHub } from './index';
import { useEmailStore, useCapabilityStore } from '@/store';

const email = {
  id: 'email-1',
  from: 'buyer@example.com',
  fromName: 'Jordan Buyer',
  subject: 'Parts needed',
  body: 'PN: PN-RULE',
  receivedAt: '2026-09-25T08:00:00.000Z',
  type: 'standard' as const,
  isRead: true,
};

const extraction = {
  items: [
    { partNumber: 'PN-DUP', quantity: 2, quantityUnit: 'EA', requiredDate: null, evidenceText: 'PN-DUP x 2 EA' },
    { partNumber: 'PN-DUP', quantity: 3, quantityUnit: 'EA', requiredDate: null, evidenceText: 'PN-DUP x 3 EA' },
    { partNumber: 'PN-OTHER', quantity: 1, quantityUnit: 'EA', requiredDate: null, evidenceText: 'PN-OTHER x 1 EA' },
  ],
  partNumbers: ['PN-DUP', 'PN-DUP', 'PN-OTHER'],
  quantities: [2, 3, 1],
  urgency: 'STANDARD' as const,
  type: 'STANDARD' as const,
  ai: { agentId: 'agent-1', promptVersion: 2, model: 'test-model' },
};

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  useEmailStore.setState({ emails: [email], selectedEmail: null, filter: 'all' });
  useCapabilityStore.setState({ grants: [{ capability: 'agent.run', scope: 'all' }, { capability: 'email.read', scope: 'all' }] });
  mocks.useEmails.mockReturnValue({ data: null, loading: false, error: null, refetch: vi.fn() });
  mocks.useCustomers.mockReturnValue({
    data: [{ id: 'customer-1', name: 'Acme Aviation' }],
    loading: false,
  });
  mocks.parseEmailById.mockResolvedValue(extraction);
  mocks.createRFQ.mockResolvedValue({ rfqNumber: 'RFQ-1' });
});

afterEach(() => {
  cleanup();
  useEmailStore.setState({ emails: [], selectedEmail: null, filter: 'all' });
});

describe('IngestionHub multi-line RFQ draft', () => {
  it('requires missing fields and a valid customer, then creates all AI lines in one RFQ', async () => {
    render(<IngestionHub />);
    fireEvent.click(screen.getByText('Parts needed'));

    expect(screen.getByLabelText('数量 (Qty) 1')).toHaveValue(null);
    expect(screen.getByLabelText('需求日期 1')).toHaveValue('');
    expect(screen.getByRole('button', { name: '创建需求单' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '添加需求行' }));
    expect(screen.getByLabelText('件号 (PN) 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除需求行 2' }));
    expect(screen.queryByLabelText('件号 (PN) 2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'AI 提取需求建议' }));
    await screen.findByRole('button', { name: '将全部需求行填入草稿' });
    fireEvent.click(screen.getByRole('button', { name: '将全部需求行填入草稿' }));

    expect(screen.getByLabelText('件号 (PN) 1')).toHaveValue('PN-DUP');
    expect(screen.getByLabelText('件号 (PN) 2')).toHaveValue('PN-DUP');
    expect(screen.getByLabelText('件号 (PN) 3')).toHaveValue('PN-OTHER');
    expect(screen.getByLabelText('数量 (Qty) 1')).toHaveValue(2);
    expect(screen.getByLabelText('单位 1')).toHaveValue('EA');
    expect(screen.getByLabelText('需求日期 1')).toHaveValue('');

    fireEvent.click(screen.getByRole('combobox', { name: '选择客户' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Acme Aviation' }));

    for (const index of [1, 2, 3]) {
      fireEvent.change(screen.getByLabelText(`需求日期 ${index}`), { target: { value: `2026-10-0${index}` } });
    }
    expect(screen.getByRole('button', { name: '创建需求单' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '创建需求单' }));
    await waitFor(() => expect(mocks.createRFQ).toHaveBeenCalledTimes(1));
    expect(mocks.createRFQ).toHaveBeenCalledWith({
      emailId: 'email-1',
      customerId: 'customer-1',
      urgency: 'STANDARD',
      lines: [
        { partNumber: 'PN-DUP', quantity: 2, uom: 'EA', requiredDate: '2026-10-01' },
        { partNumber: 'PN-DUP', quantity: 3, uom: 'EA', requiredDate: '2026-10-02' },
        { partNumber: 'PN-OTHER', quantity: 1, uom: 'EA', requiredDate: '2026-10-03' },
      ],
    });
  });
});
