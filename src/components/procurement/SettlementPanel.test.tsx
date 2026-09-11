import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order } from '@/types';
import { procurementApi, settlementApi, type SettlementAccount } from '@/features/orders';
import { SettlementPanel } from './SettlementPanel';

const permissions = vi.hoisted(() => new Set<string>());

vi.mock('@/features/orders', () => ({
  procurementApi: { list: vi.fn() },
  settlementApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), appendRecord: vi.fn() },
}));

vi.mock('@/store', () => ({
  useCapabilityStore: (select: (state: { can: (capability: string) => boolean }) => unknown) => select({
    can: capability => permissions.has(capability),
  }),
}));

vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'zh-CN' }) }));

vi.mock('@/components/procurement/Shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/procurement/Shared')>();
  return {
    ...actual,
    EvidenceUpload: ({
      value,
      onChange,
      disabled,
      label,
    }: {
      value: Array<{ id: string; originalName: string }>;
      onChange: (next: Array<{ id: string; originalName: string }>) => void;
      disabled?: boolean;
      label?: string;
    }) => <button type="button" disabled={disabled} onClick={() => onChange([...value, { id: 'proof-1', originalName: 'voucher.pdf' }])}>{label || '添加附件'}</button>,
    EvidenceDownload: ({ id, label }: { id: string; label?: string }) => <button type="button" data-testid={`download-${id}`}>{label || '下载凭证'}</button>,
  };
});

const order = (id = 'order-1'): Order => ({
  id,
  orderNumber: `SO-${id}`,
  soNumber: `SO-${id}`,
  quotationId: 'quotation-1',
  customerId: 'customer-1',
  customerName: '客户一',
  partNumber: 'PN-100',
  quantity: 1,
  totalAmount: 100,
  status: 'so_created',
  version: 1,
  createdAt: '2026-09-10T00:00:00.000Z',
  lineItemsMode: true,
  lines: [{
    id: 'order-line-1', lineNo: 1, quotationLineId: 'quotation-line-1', partNumber: 'PN-100', quantity: 1,
    uom: 'EA', unitPrice: '100.0000', lineTotal: '100.0000', currency: 'USD', outboundQuantity: 0, outboundStatus: 'PENDING',
  }],
});

const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'record-open',
  kind: 'OPEN',
  version: 1,
  amount: null,
  dueDate: '2026-10-01T00:00:00.000Z',
  occurredAt: '2026-09-09T00:00:00.000Z',
  externalSystem: 'ERP',
  voucherNumber: 'OPEN-1',
  voucherLine: '1',
  reason: '开户',
  evidence: [],
  reversalOfId: null,
  actorName: 'Finance',
  createdAt: '2026-09-09T00:00:00.000Z',
  ...overrides,
});

const account = (side: 'RECEIVABLE' | 'PAYABLE', overrides: Record<string, unknown> = {}) => ({
  id: side === 'RECEIVABLE' ? 'ar-1' : 'ap-1',
  side,
  orderId: 'order-1',
  purchaseCommitmentId: side === 'RECEIVABLE' ? null : 'purchase-1',
  currency: 'USD',
  initialAmount: side === 'RECEIVABLE' ? '100.0000' : '80.0000',
  sourceSnapshot: side === 'RECEIVABLE'
    ? { kind: 'ORDER', sourceId: 'order-1', sourceNumber: 'SO-order-1', sourceVersion: 1, counterpartyId: 'customer-1', counterpartyName: '客户一', initialAmount: '100.0000', currency: 'USD' }
    : { kind: 'PURCHASE', sourceId: 'purchase-1', sourceNumber: 'PC-001', sourceVersion: 2, counterpartyId: 'supplier-1', counterpartyName: '供应商一', initialAmount: '80.0000', currency: 'USD' },
  dueDate: '2026-10-01T00:00:00.000Z',
  version: 3,
  createdAt: '2026-09-09T00:00:00.000Z',
  amounts: {
    initialAmount: side === 'RECEIVABLE' ? '100.0000' : '80.0000',
    grossPaid: '0.0000', refunded: '0.0000', effectivePaid: '0.0000', creditReduction: '0.0000',
    adjustedDue: side === 'RECEIVABLE' ? '100.0000' : '80.0000', unpaid: side === 'RECEIVABLE' ? '100.0000' : '80.0000',
    overpaid: '0.0000', pendingRefund: '0.0000',
  },
  records: [record()],
  ...overrides,
});

const receivable = () => account('RECEIVABLE') as unknown as SettlementAccount;
const payable = () => account('PAYABLE') as unknown as SettlementAccount;
const listResult = (accounts: unknown[], orderId = 'order-1') => ({ orderId, accounts }) as never;

function enable(...capabilities: string[]) {
  capabilities.forEach(capability => permissions.add(capability));
}

function fillCommonRecord(form: HTMLElement, reason = '核对外部凭证') {
  fireEvent.change(within(form).getByLabelText('外部系统'), { target: { value: 'ERP' } });
  fireEvent.change(within(form).getByLabelText('凭证号'), { target: { value: 'V-001' } });
  fireEvent.change(within(form).getByLabelText('凭证行号'), { target: { value: '1' } });
  fireEvent.change(within(form).getByLabelText('原因'), { target: { value: reason } });
  fireEvent.click(within(form).getByRole('button', { name: '结算凭证（至少一份）' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions.clear();
  vi.mocked(settlementApi.list).mockResolvedValue(listResult([receivable()]));
  vi.mocked(settlementApi.appendRecord).mockResolvedValue(receivable() as never);
  vi.mocked(settlementApi.create).mockResolvedValue(receivable() as never);
  vi.mocked(procurementApi.list).mockResolvedValue({ orderId: 'order-1', purchases: [] } as never);
});

afterEach(cleanup);

describe('SettlementPanel', () => {
  it('shows sales only the AR account and no payable or write controls', async () => {
    enable('settlement.read');
    vi.mocked(settlementApi.list).mockResolvedValue(listResult([receivable(), payable()]));

    render(<SettlementPanel order={order()} />);

    expect(await screen.findByTestId('settlement-account-ar-1')).toBeInTheDocument();
    expect(screen.queryByTestId('settlement-account-ap-1')).toBeNull();
    expect(screen.queryByRole('button', { name: '登记结算记录' })).toBeNull();
    expect(screen.queryByRole('button', { name: '新建结算记录' })).toBeNull();
    expect(procurementApi.list).not.toHaveBeenCalled();
  });

  it('clears stale order data and does not show a fake empty state after a load failure', async () => {
    enable('settlement.read');
    vi.mocked(settlementApi.list).mockImplementation(async requestedOrderId => {
      if (requestedOrderId === 'order-1') return listResult([receivable()]);
      throw new Error('结算读取失败');
    });
    const view = render(<SettlementPanel order={order('order-1')} />);
    expect(await screen.findByTestId('settlement-account-ar-1')).toBeInTheDocument();

    view.rerender(<SettlementPanel order={order('order-2')} />);

    await waitFor(() => expect(screen.queryByTestId('settlement-account-ar-1')).toBeNull());
    expect(await screen.findByRole('alert')).toHaveTextContent('结算读取失败');
    expect(screen.queryByText('当前订单还没有结算记录。')).toBeNull();
    expect(settlementApi.list).toHaveBeenLastCalledWith('order-2');
  });

  it('submits a four-decimal payment and rejects zero without sending a write', async () => {
    enable('settlement.read', 'settlement.create');
    const ar = receivable();
    vi.mocked(settlementApi.list).mockResolvedValue(listResult([ar]));
    vi.mocked(settlementApi.appendRecord).mockResolvedValue(ar as never);
    render(<SettlementPanel order={order()} />);
    const card = await screen.findByTestId('settlement-account-ar-1');
    fireEvent.click(within(card).getByRole('button', { name: '登记结算记录' }));
    const form = await screen.findByTestId('settlement-record-form-ar-1');
    fireEvent.change(within(form).getByLabelText('金额（USD）'), { target: { value: '0' } });
    fillCommonRecord(form);
    fireEvent.click(within(form).getByRole('button', { name: '保存结算记录' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('金额须大于零');
    expect(settlementApi.appendRecord).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText('金额（USD）'), { target: { value: '0.0001' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存结算记录' }));
    await waitFor(() => expect(settlementApi.appendRecord).toHaveBeenCalledTimes(1));
    expect(settlementApi.appendRecord).toHaveBeenCalledWith('ar-1', expect.objectContaining({
      version: 3, kind: 'PAYMENT', amount: '0.0001', evidenceIds: ['proof-1'],
    }), expect.any(String));
  });

  it('keeps input and reuses the command key after a failed write retry', async () => {
    enable('settlement.read', 'settlement.create');
    const ar = receivable();
    vi.mocked(settlementApi.list).mockResolvedValue(listResult([ar]));
    vi.mocked(settlementApi.appendRecord)
      .mockRejectedValueOnce(new Error('凭证服务暂时不可用'))
      .mockResolvedValueOnce(ar as never);
    render(<SettlementPanel order={order()} />);
    const card = await screen.findByTestId('settlement-account-ar-1');
    fireEvent.click(within(card).getByRole('button', { name: '登记结算记录' }));
    const form = await screen.findByTestId('settlement-record-form-ar-1');
    fireEvent.change(within(form).getByLabelText('金额（USD）'), { target: { value: '12.3400' } });
    fillCommonRecord(form, '首次提交失败后保留');

    fireEvent.click(within(form).getByRole('button', { name: '保存结算记录' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('凭证服务暂时不可用');
    expect(within(form).getByLabelText('金额（USD）')).toHaveValue('12.3400');
    fireEvent.click(within(form).getByRole('button', { name: '保存结算记录' }));

    await waitFor(() => expect(settlementApi.appendRecord).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(settlementApi.appendRecord).mock.calls;
    expect(calls[0][2]).toBe(calls[1][2]);
    expect(calls[0][1]).toEqual(calls[1][1]);
  });

  it('submits a reversal target without inventing an amount', async () => {
    enable('settlement.read', 'settlement.create', 'settlement.reconcile');
    const ar = receivable();
    const payment = record({ id: 'payment-1', kind: 'PAYMENT', version: 2, amount: '25.0000', voucherNumber: 'PAY-001' });
    const accountWithPayment = { ...ar, records: [record(), payment] } as SettlementAccount;
    vi.mocked(settlementApi.list).mockResolvedValue(listResult([accountWithPayment]));
    vi.mocked(settlementApi.appendRecord).mockResolvedValue(accountWithPayment as never);
    render(<SettlementPanel order={order()} />);
    const card = await screen.findByTestId('settlement-account-ar-1');
    fireEvent.click(within(card).getByRole('button', { name: '登记结算记录' }));
    const form = await screen.findByTestId('settlement-record-form-ar-1');
    fireEvent.change(within(form).getByLabelText('记录类型'), { target: { value: 'REVERSAL' } });
    fireEvent.change(within(form).getByLabelText('冲销原记录'), { target: { value: 'payment-1' } });
    fillCommonRecord(form, '原付款凭证作废');
    fireEvent.click(within(form).getByRole('button', { name: '保存结算记录' }));

    await waitFor(() => expect(settlementApi.appendRecord).toHaveBeenCalledTimes(1));
    const body = vi.mocked(settlementApi.appendRecord).mock.calls[0][1] as Record<string, unknown>;
    expect(body).toEqual(expect.objectContaining({ version: 3, kind: 'REVERSAL', reversalOfId: 'payment-1', evidenceIds: ['proof-1'] }));
    expect(body).not.toHaveProperty('amount');
  });

  it('keeps a successful settlement visible when the surrounding order refresh fails', async () => {
    enable('settlement.read', 'settlement.create');
    const ar = receivable();
    vi.mocked(settlementApi.list).mockResolvedValue(listResult([ar]));
    vi.mocked(settlementApi.appendRecord).mockResolvedValue(ar as never);
    const onChanged = vi.fn().mockRejectedValue(new Error('订单刷新失败'));
    render(<SettlementPanel order={order()} onChanged={onChanged} />);
    const card = await screen.findByTestId('settlement-account-ar-1');
    fireEvent.click(within(card).getByRole('button', { name: '登记结算记录' }));
    const form = await screen.findByTestId('settlement-record-form-ar-1');
    fireEvent.change(within(form).getByLabelText('金额（USD）'), { target: { value: '1.0000' } });
    fillCommonRecord(form, '记录已保存但订单刷新失败');
    fireEvent.click(within(form).getByRole('button', { name: '保存结算记录' }));

    await waitFor(() => expect(settlementApi.appendRecord).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('结算已保存，订单详情刷新失败'));
    expect(screen.queryByTestId('settlement-record-form-ar-1')).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
