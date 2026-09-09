import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PurchaseCommitment, ReceiptPhysical, StockReceipt } from '@/features/orders';
import { stockReceiptApi } from '@/features/orders';
import { StockReceiptPanel } from './StockReceiptPanel';

const permissions = vi.hoisted(() => new Set<string>());
const commandState = vi.hoisted(() => ({ keys: new Map<string, string>() }));

vi.mock('@/features/orders', () => ({
  stockReceiptApi: {
    list: vi.fn(),
    create: vi.fn(),
    context: vi.fn(),
    review: vi.fn(),
  },
}));

vi.mock('@/store', () => ({
  useCapabilityStore: (select: (state: { can: (capability: string) => boolean }) => unknown) => select({ can: capability => permissions.has(capability) }),
}));

vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'zh-CN' }) }));

vi.mock('@/components/procurement/Shared', () => ({
  emptyPhysical: (partNumber: string, uom = 'EA'): ReceiptPhysical => ({
    partNumber, uom, trackingType: 'BATCH', quantity: 1, conditionCode: 'NE', serialNumber: null, batchNumber: null,
    certificateReferences: [], certificateType: null, certificateNumber: null, lifeLimited: false,
    remainingHours: null, remainingCycles: null, shelfLifeDate: null, shelfLifeDays: null,
    nextOverhaulDue: null, storageCondition: null,
  }),
  PhysicalFields: ({ value, onChange, disabled }: { value: ReceiptPhysical; onChange: (next: ReceiptPhysical) => void; disabled?: boolean }) => <div>
    <label>实物件号<input aria-label="实物件号" disabled={disabled} value={value.partNumber} onChange={event => onChange({ ...value, partNumber: event.target.value })} /></label>
    <label>批次号<input aria-label="批次号" disabled={disabled} value={value.batchNumber || ''} onChange={event => onChange({ ...value, batchNumber: event.target.value || null })} /></label>
    <label>实物数量<input aria-label="实物数量" type="number" disabled={disabled} value={value.quantity} onChange={event => onChange({ ...value, quantity: Number(event.target.value) })} /></label>
  </div>,
  EvidenceUpload: ({ value, onChange, disabled }: { value: Array<{ id: string; originalName: string }>; onChange: (next: Array<{ id: string; originalName: string }>) => void; disabled?: boolean }) => <div>
    <button type="button" disabled={disabled} onClick={() => onChange([...value, { id: 'evidence-1', originalName: 'arrival.pdf' }])}>添加附件</button>
  </div>,
  EvidenceDownload: ({ id, label }: { id: string; label?: string }) => <button type="button" data-testid={`download-${id}`}>{label || '查看附件'}</button>,
  useCommandRunner: () => ({
    busy: false,
    run: async <T,>(signature: string, operation: (key: string) => Promise<T>) => {
      const key = commandState.keys.get(signature) || `command-${commandState.keys.size + 1}`;
      commandState.keys.set(signature, key);
      const result = await operation(key);
      commandState.keys.delete(signature);
      return result;
    },
  }),
}));

const purchase = {
  id: 'purchase-1', commitmentNumber: 'PC-001', orderId: 'order-1', supplierId: 'supplier-1', supplierName: '供应商一',
  status: 'CONFIRMED', version: 4, createdAt: '2026-09-09T00:00:00.000Z', submittedAt: null, approvedAt: null, confirmedAt: '2026-09-09T00:00:00.000Z',
  lines: [
    { id: 'pcl-1', lineNo: 1, orderLineId: 'ol-1', partNumber: 'PN-100', uom: 'EA', quantity: 2, cancelledQuantity: 0, receivedQuantity: 0, directShippedQuantity: 0, version: 1, promisedDate: '2026-09-20T00:00:00.000Z', fulfillmentMode: 'STOCK_RECEIPT' },
    { id: 'pcl-2', lineNo: 2, orderLineId: 'ol-2', partNumber: 'PN-200', uom: 'EA', quantity: 3, cancelledQuantity: 0, receivedQuantity: 0, directShippedQuantity: 0, version: 1, promisedDate: '2026-09-20T00:00:00.000Z', fulfillmentMode: 'STOCK_RECEIPT' },
  ],
} as PurchaseCommitment;

const directPurchase = { ...purchase, id: 'purchase-direct', commitmentNumber: 'PC-DIRECT', lines: [{ ...purchase.lines[0], id: 'pcl-direct', fulfillmentMode: 'SUPPLIER_DIRECT' as const }] } as PurchaseCommitment;
const pendingReceipt = {
  id: 'receipt-1', receiptNumber: 'SR-001', purchaseCommitmentId: purchase.id, version: 1, receivedById: 'receiver', receivedAt: '2026-09-09T01:00:00.000Z',
  supplierDeliveryReference: 'DEL-001', reason: '到货待检', evidence: [{ id: 'evidence-1', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE' as const }],
  createdAt: '2026-09-09T01:00:00.000Z', updatedAt: '2026-09-09T01:00:00.000Z',
  purchaseCommitment: { orderId: purchase.orderId, commitmentNumber: purchase.commitmentNumber, supplierId: purchase.supplierId },
  lines: [{
    id: 'receipt-line-1', lineNo: 1, purchaseCommitmentLineId: 'pcl-1', quantity: 1, status: 'PENDING_REVIEW' as const, version: 2,
    identitySnapshot: { schemaVersion: 1 as const, purchaseCommitmentLineId: 'pcl-1', orderLineId: 'ol-1', quotationLineId: 'ql-1', rfqLineId: 'rfq-line-1', partNumber: 'PN-100', uom: 'EA', serialNumber: null, batchNumber: 'B-1', conditionCode: 'NE', trackingType: 'BATCH' as const },
    qualitySnapshot: { physical: { partNumber: 'PN-100', uom: 'EA', trackingType: 'BATCH' as const, quantity: 1, serialNumber: null, batchNumber: 'B-1', conditionCode: 'NE' }, storage: { warehouse: 'WH-1', location: 'A-01', shelf: null } },
    evidence: [{ id: 'evidence-1', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE' as const }], reviewedById: null, reviewedAt: null, reviewReason: null, inventoryDetailId: null,
    createdAt: '2026-09-09T01:00:00.000Z', updatedAt: '2026-09-09T01:00:00.000Z',
  }],
} as StockReceipt;

const reviewContext = {
  receiptLineId: 'receipt-line-1', version: 2, status: 'PENDING_REVIEW' as const, snapshotHash: 'b'.repeat(64), canAccept: true,
  snapshot: {
    receiptId: pendingReceipt.id, receiptLineId: 'receipt-line-1', version: 2, receiptVersion: 1,
    identity: pendingReceipt.lines[0].identitySnapshot,
    physical: pendingReceipt.lines[0].qualitySnapshot,
    requirements: {
      schemaVersion: 1,
      chain: {
        order: { certificateRequired: true, certificateType: 'FORM-1', inspectionRequired: true },
        rfqLine: { partNumber: 'PN-100', uom: 'EA', conditionCode: 'NE', serialNumber: null, batchNumber: 'B-1', certificateRequired: true, certificateType: 'FORM-1', alternatePartNumbers: null },
      },
      physical: { ...pendingReceipt.lines[0].qualitySnapshot.physical, lifeLimited: true, remainingHours: 120, remainingCycles: 30, shelfLifeDate: '2027-01-01T00:00:00.000Z', shelfLifeDays: 90, nextOverhaulDue: '2027-06-01T00:00:00.000Z', storageCondition: 'Keep dry', certificateType: 'FORM-1', certificateNumber: 'CERT-001' },
      certificates: [{ id: 'certificate-1', certificateNumber: 'CERT-001', partNumber: 'PN-100', serialNumber: null, batchNumber: 'B-1', certificateType: 'FORM-1', status: 'ISSUED', expiryDate: '2027-01-01T00:00:00.000Z', fileHash: 'c'.repeat(64), updatedAt: '2026-09-09T00:00:00.000Z' }],
    },
    evidence: pendingReceipt.lines[0].evidence,
  },
  issues: [],
};

function enable(...capabilities: string[]) {
  capabilities.forEach(capability => permissions.add(capability));
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions.clear();
  commandState.keys.clear();
  vi.mocked(stockReceiptApi.list).mockResolvedValue({ orderId: 'order-1', receipts: [] });
  vi.mocked(stockReceiptApi.create).mockResolvedValue(pendingReceipt);
  vi.mocked(stockReceiptApi.context).mockResolvedValue(reviewContext);
  vi.mocked(stockReceiptApi.review).mockResolvedValue(pendingReceipt);
});

afterEach(cleanup);

describe('StockReceiptPanel', () => {
  it('shows only confirmed stock-receipt commitments and keeps cost fields out of the receiving UI', async () => {
    enable('inventory.read', 'inventory.manage');
    render(<StockReceiptPanel orderId="order-1" purchases={[purchase, directPurchase]} />);

    expect(await screen.findByRole('option', { name: /PC-001/ })).toBeInTheDocument();
    expect(screen.queryByText('PC-DIRECT')).toBeNull();
    expect(screen.queryByText(/成本|cost|USD/i)).toBeNull();
    expect(screen.getByRole('button', { name: '建立待检收货' })).toBeInTheDocument();
  });

  it('clears the previous order records when orderId changes', async () => {
    enable('inventory.read');
    vi.mocked(stockReceiptApi.list).mockImplementation(async orderId => orderId === 'order-1'
      ? { orderId, receipts: [pendingReceipt] }
      : { orderId, receipts: [] });
    const view = render(<StockReceiptPanel orderId="order-1" purchases={[purchase]} />);
    expect(await screen.findByText('SR-001')).toBeInTheDocument();

    view.rerender(<StockReceiptPanel orderId="order-2" purchases={[{ ...purchase, orderId: 'order-2' }]} />);
    await waitFor(() => expect(screen.queryByText('SR-001')).toBeNull());
    expect(stockReceiptApi.list).toHaveBeenLastCalledWith('order-2');
  });

  it('loads the server snapshot and submits an independent four-check acceptance', async () => {
    enable('inventory.read', 'quality_review.approve');
    vi.mocked(stockReceiptApi.list).mockResolvedValue({ orderId: 'order-1', receipts: [pendingReceipt] });
    render(<StockReceiptPanel orderId="order-1" purchases={[purchase]} />);

    expect(await screen.findByTestId('stock-receipt-quality-facts')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`b{64}`))).toBeNull();
    expect(screen.getByText('剩余小时')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('客户/需求质量要求')).toBeInTheDocument();
    expect(screen.getByText('证书状态')).toBeInTheDocument();
    expect(screen.getByText('ISSUED')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看收货凭证' })).toBeInTheDocument();
    const checks = screen.getAllByRole('checkbox');
    checks.forEach(check => fireEvent.click(check));
    fireEvent.change(screen.getByLabelText('审核依据/拒收原因'), { target: { value: '实物与来源要求一致' } });
    fireEvent.click(screen.getByRole('button', { name: '审核通过' }));

    await waitFor(() => expect(stockReceiptApi.review).toHaveBeenCalledWith('receipt-line-1', expect.objectContaining({
      version: 2, snapshotHash: 'b'.repeat(64), decision: 'ACCEPTED', reason: '实物与来源要求一致',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
    }), expect.any(String)));
  });

  it('submits multiple explicitly selected arrival batches without exposing internal ids', async () => {
    enable('inventory.read', 'inventory.manage');
    render(<StockReceiptPanel orderId="order-1" purchases={[purchase]} />);
    await screen.findByRole('option', { name: /PC-001/ });
    fireEvent.change(screen.getByRole('combobox', { name: '选择采购承诺' }), { target: { value: purchase.id } });
    fireEvent.change(screen.getByRole('combobox', { name: '选择采购行' }), { target: { value: 'pcl-1' } });
    fireEvent.click(screen.getByRole('button', { name: '添加到货批次' }));
    fireEvent.change(screen.getByRole('combobox', { name: '选择采购行' }), { target: { value: 'pcl-2' } });
    fireEvent.click(screen.getByRole('button', { name: '添加到货批次' }));
    expect(screen.getAllByRole('heading', { name: /到货实物行/ })).toHaveLength(2);
    screen.getAllByLabelText('批次号').forEach((input, index) => fireEvent.change(input, { target: { value: `B-${index + 1}` } }));
    screen.getAllByLabelText('仓库').forEach(input => fireEvent.change(input, { target: { value: 'WH-1' } }));
    screen.getAllByLabelText('库位').forEach((input, index) => fireEvent.change(input, { target: { value: `A-0${index + 1}` } }));
    fireEvent.change(screen.getByLabelText('供应商送货单号'), { target: { value: 'DEL-002' } });
    fireEvent.change(screen.getByLabelText('收货说明'), { target: { value: '分批到货，进入待检' } });
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('button', { name: '建立待检收货' }));

    await waitFor(() => expect(stockReceiptApi.create).toHaveBeenCalledWith(expect.objectContaining({
      purchaseCommitmentId: purchase.id, purchaseVersion: 4, supplierDeliveryReference: 'DEL-002', evidenceIds: ['evidence-1'],
      lines: expect.arrayContaining([
        expect.objectContaining({ purchaseCommitmentLineId: 'pcl-1' }),
        expect.objectContaining({ purchaseCommitmentLineId: 'pcl-2' }),
      ]),
    }), expect.any(String)));
    expect(screen.queryByText('pcl-1')).toBeNull();
    expect(screen.queryByText('pcl-2')).toBeNull();
  });
});
