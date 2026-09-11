import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectShipmentPanel } from './DirectShipmentPanel';
import type { DirectShipment, PurchaseCommitment } from '@/features/orders';

const permissions = vi.hoisted(() => new Set<string>());
const directApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  context: vi.fn(),
  review: vi.fn(),
  dispatch: vi.fn(),
  cancel: vi.fn(),
  receive: vi.fn(),
}));

vi.mock('@/features/orders', () => ({ directShipmentApi: directApi }));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ locale: 'zh-CN' }) }));
vi.mock('@/store', () => ({
  useCapabilityStore: (select: (state: { can: (key: string) => boolean }) => unknown) => select({ can: key => permissions.has(key) }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/procurement/Shared', () => ({
  emptyPhysical: (partNumber: string, uom = 'EA') => ({
    partNumber, uom, trackingType: 'BATCH', quantity: 1, serialNumber: null, batchNumber: null,
    conditionCode: 'NE', certificateReferences: [], certificateType: null, certificateNumber: null,
    lifeLimited: false, remainingHours: null, remainingCycles: null, shelfLifeDate: null,
    shelfLifeDays: null, nextOverhaulDue: null, storageCondition: null,
  }),
  PhysicalFields: ({ value, onChange }: { value: { quantity: number }; onChange: (value: unknown) => void }) => (
    <button type="button" aria-label="编辑实际实物" onClick={() => onChange({ ...value, quantity: 2 })}>编辑实际实物</button>
  ),
  EvidenceUpload: ({ label, onChange }: { label?: string; onChange: (value: Array<{ id: string; originalName: string }>) => void }) => (
    <button type="button" onClick={() => onChange([{ id: 'evidence-1', originalName: 'proof.pdf' }])}>{label || '上传证据'}</button>
  ),
  EvidenceDownload: ({ id, label }: { id: string; label?: string }) => <button type="button" data-testid={`download-${id}`}>{label || '下载证据'}</button>,
  useCommandRunner: () => ({ busy: false, run: (_signature: string, operation: (key: string) => Promise<unknown>) => operation('command-key') }),
}));

const physical = {
  partNumber: 'PN-DIRECT', uom: 'EA', trackingType: 'BATCH' as const, quantity: 2,
  serialNumber: null, batchNumber: 'BATCH-01', conditionCode: 'NE', certificateReferences: [],
  certificateType: null, certificateNumber: null, lifeLimited: false, remainingHours: null,
  remainingCycles: null, shelfLifeDate: null, shelfLifeDays: null, nextOverhaulDue: null, storageCondition: null,
};

const purchase = {
  id: 'purchase-1', commitmentNumber: 'PC-001', orderId: 'order-1', supplierId: 'supplier-1', supplierName: '供应商一',
  status: 'CONFIRMED' as const, version: 3, createdAt: '2026-09-09T00:00:00.000Z', submittedAt: null,
  approvedAt: '2026-09-09T00:00:00.000Z', confirmedAt: '2026-09-09T00:00:00.000Z', currency: 'USD' as const,
  totalCost: '100.00', lines: [{
    id: 'line-direct', lineNo: 1, orderLineId: 'order-line-1', partNumber: 'PN-DIRECT', uom: 'EA', quantity: 4,
    cancelledQuantity: 0, receivedQuantity: 0, directShippedQuantity: 0, version: 1,
    promisedDate: '2026-10-01T00:00:00.000Z', fulfillmentMode: 'SUPPLIER_DIRECT' as const, unitCost: '50.00', lineTotal: '100.00',
  }],
} satisfies PurchaseCommitment;

const shipment = {
  id: 'shipment-1', shipmentNumber: 'DS-001', purchaseCommitmentId: 'purchase-1', orderId: 'order-1',
  carrier: 'Carrier', trackingNumber: 'TRACK-1', origin: 'Origin', destination: 'Destination', reason: 'Direct delivery',
  evidence: [{ id: 'evidence-1', version: 2, sha256: 'a'.repeat(64), status: 'AVAILABLE' as const }], status: 'PREPARED' as const,
  version: 1, createdById: 'operator-1', createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
  dispatchedById: null, dispatchedAt: null, cancelledById: null, cancelledAt: null, cancellationReason: null,
  lines: [{
    id: 'shipment-line-1', lineNo: 1, purchaseCommitmentLineId: 'line-direct', quantity: 2, physicalSnapshot: physical,
    reviewStatus: 'PENDING_REVIEW' as const, reviewedById: null, reviewedAt: null, reviewReason: null, checks: null,
    reviewEvidence: [], receivedQuantity: 0, version: 1, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
  }],
} satisfies DirectShipment;

const reviewContext = {
  shipmentLineId: 'shipment-line-1', shipmentId: 'shipment-1', version: 1, reviewStatus: 'PENDING_REVIEW' as const,
  snapshot: {
    quality: {
      schemaVersion: 1,
      chain: {
        order: { id: 'order-1', quotationId: 'quotation-1', lineItemsMode: true, currency: 'USD', saleType: 'Sale', certificateRequired: true, certificateType: 'FORM1', inspectionRequired: true },
        orderLine: { id: 'order-line-1', orderId: 'order-1', quotationLineId: 'quotation-line-1', partNumber: 'PN-DIRECT', uom: 'EA', quantity: 2, serialNumber: null, batchNumber: 'BATCH-01', currency: 'USD' },
        quotation: { id: 'quotation-1', rfqId: 'rfq-1', currency: 'USD' },
        quotationLine: { id: 'quotation-line-1', quotationId: 'quotation-1', rfqLineId: 'rfq-line-1', partNumber: 'PN-DIRECT', uom: 'EA', quantity: 2, serialNumber: null, batchNumber: 'BATCH-01', currency: 'USD' },
        rfqLine: { id: 'rfq-line-1', rfqId: 'rfq-1', partNumber: 'PN-DIRECT', uom: 'EA', quantity: 2, conditionCode: 'NE', serialNumber: null, batchNumber: 'BATCH-01', certificateRequired: true, certificateType: 'FORM1', alternatePartNumbers: null },
      },
      purchase: {
        purchaseCommitmentId: 'purchase-1', purchaseCommitmentLineId: 'line-direct', orderId: 'order-1', supplierId: 'supplier-1', orderLineId: 'order-line-1', partNumber: 'PN-DIRECT', uom: 'EA', quantity: 2, fulfillmentMode: 'SUPPLIER_DIRECT' as const,
        identitySnapshot: { schemaVersion: 1, orderLineId: 'order-line-1', quotationLineId: 'quotation-line-1', rfqLineId: 'rfq-line-1', partNumber: 'PN-DIRECT', uom: 'EA', conditionCode: 'NE', serialNumber: null, batchNumber: 'BATCH-01', certificateRequired: true, certificateType: 'FORM1', trackingType: 'BATCH' as const },
      },
      physical: { ...physical, lifeLimited: true, remainingHours: 120, remainingCycles: 30, shelfLifeDate: '2027-01-01T00:00:00.000Z', shelfLifeDays: 90, nextOverhaulDue: '2027-06-01T00:00:00.000Z', storageCondition: 'Keep dry', certificateType: 'FORM1', certificateNumber: 'CERT-001' },
      certificates: [{ id: 'cert-1', certificateNumber: 'CERT-001', partNumber: 'PN-DIRECT', serialNumber: null, batchNumber: 'BATCH-01', certificateType: 'FORM1', status: 'ISSUED', expiryDate: '2027-01-01T00:00:00.000Z', fileHash: 'a'.repeat(64), supplierId: null, orderId: null, inventoryDetailId: null, updatedAt: '2026-09-09T00:00:00.000Z' }],
    },
    evidence: [{ id: 'shipment-evidence-1', version: 2, sha256: 'c'.repeat(64), status: 'AVAILABLE' as const }],
  },
  snapshotHash: 'b'.repeat(64), issues: [], canApprove: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  permissions.clear();
  directApi.list.mockResolvedValue({ orderId: 'order-1', shipments: [] });
  directApi.create.mockResolvedValue({ id: 'shipment-1' });
  directApi.context.mockResolvedValue(reviewContext);
  directApi.review.mockResolvedValue({ id: 'shipment-1' });
  directApi.dispatch.mockResolvedValue({ id: 'shipment-1' });
  directApi.cancel.mockResolvedValue({ id: 'shipment-1' });
  directApi.receive.mockResolvedValue({ id: 'shipment-1' });
});

afterEach(cleanup);

describe('DirectShipmentPanel', () => {
  it('requires inventory.read before loading or exposing direct shipment data', () => {
    render(<DirectShipmentPanel orderId="order-1" purchases={[purchase]} />);

    expect(screen.getByText('需要库存读取权限才能查看直发状态。')).toBeInTheDocument();
    expect(directApi.list).not.toHaveBeenCalled();
  });

  it('selects only confirmed supplier-direct lines and creates without rendering cost fields', async () => {
    permissions.add('inventory.read');
    permissions.add('inventory.manage');
    render(<DirectShipmentPanel orderId="order-1" purchases={[purchase]} />);

    await waitFor(() => expect(directApi.list).toHaveBeenCalledWith('order-1'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'purchase-1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /第 1 行 · PN-DIRECT/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '编辑实际实物' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '添加实际批次/序号' }));
    fireEvent.click(screen.getAllByRole('button', { name: '编辑实际实物' })[1]);
    fireEvent.change(screen.getByRole('textbox', { name: '承运商' }), { target: { value: 'Carrier' } });
    fireEvent.change(screen.getByRole('textbox', { name: '运单号' }), { target: { value: 'TRACK-1' } });
    fireEvent.change(screen.getByRole('textbox', { name: '起运地' }), { target: { value: 'Origin' } });
    fireEvent.change(screen.getByRole('textbox', { name: '目的地' }), { target: { value: 'Destination' } });
    fireEvent.change(screen.getByRole('textbox', { name: '创建原因' }), { target: { value: '客户要求直发' } });
    fireEvent.click(screen.getByRole('button', { name: '运单证据（至少一份）' }));
    fireEvent.click(screen.getByRole('button', { name: '创建直发单' }));

    await waitFor(() => expect(directApi.create).toHaveBeenCalledWith(expect.objectContaining({
      purchaseCommitmentId: 'purchase-1', purchaseVersion: 3, evidenceIds: ['evidence-1'],
      lines: [
        expect.objectContaining({ purchaseCommitmentLineId: 'line-direct', physical: expect.objectContaining({ quantity: 2 }) }),
        expect.objectContaining({ purchaseCommitmentLineId: 'line-direct', physical: expect.objectContaining({ quantity: 2 }) }),
      ],
    }), 'command-key'));
    expect(screen.queryByText('100.00')).not.toBeInTheDocument();
    expect(screen.queryByText('50.00')).not.toBeInTheDocument();
  });

  it('loads quality issues and submits an independent four-check approval with the server snapshot', async () => {
    permissions.add('inventory.read');
    permissions.add('quality_review.approve');
    directApi.list.mockResolvedValue({ orderId: 'order-1', shipments: [shipment] });
    render(<DirectShipmentPanel orderId="order-1" purchases={[purchase]} />);

    await waitFor(() => expect(screen.getByRole('button', { name: '加载质量审核' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '加载质量审核' }));
    await waitFor(() => expect(screen.getByText('当前没有质量问题。')).toBeInTheDocument());
    expect(screen.getByTestId('direct-quality-facts')).toBeInTheDocument();
    expect(screen.getByText('剩余小时')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getAllByText('CERT-001').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('证书状态')).toBeInTheDocument();
    expect(screen.getByText('ISSUED')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载运单证据' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '身份一致' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '证书/文件' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '状态与寿命' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '客户要求' }));
    fireEvent.change(screen.getByRole('textbox', { name: '审核原因' }), { target: { value: '四项质量检查均已核对' } });
    fireEvent.click(screen.getByRole('button', { name: '通过' }));

    await waitFor(() => expect(directApi.review).toHaveBeenCalledWith('shipment-line-1', expect.objectContaining({
      version: 1, snapshotHash: 'b'.repeat(64), decision: 'APPROVED',
      checks: { identity: true, documents: true, conditionAndLife: true, customerRequirements: true },
    }), 'command-key'));
  });
});
