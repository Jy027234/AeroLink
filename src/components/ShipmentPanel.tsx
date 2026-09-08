import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, FileCheck2, Loader2, RefreshCw, ShipWheel, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  qualityReviewApi,
  shipmentApi,
  type ShipmentLineView,
  type ShipmentOrderView,
  type ShipmentReturnHoldView,
} from '@/api/client';
import { useCapabilityStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { downloadBlob } from '@/lib/downloadBlob';

type EvidenceFile = { id: string; originalName: string };
type Checks = { identity: boolean; documents: boolean; conditionAndLife: boolean; customerRequirements: boolean };

const emptyChecks: Checks = {
  identity: false,
  documents: false,
  conditionAndLife: false,
  customerRequirements: false,
};

export interface ShipmentPanelProps {
  orderId: string;
  onChanged?: () => void | Promise<unknown>;
  className?: string;
}

function positiveInteger(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function displayQuantity(value: number) {
  return `${value.toLocaleString()} EA`;
}

function displayDate(value: string | null | undefined, locale: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
}

function statusText(status: string, locale: string) {
  if (locale !== 'zh-CN') return status;
  const labels: Record<string, string> = {
    DRAFT: '草稿',
    SHIPPED: '已发运',
    IN_TRANSIT: '运输中',
    DELIVERED: '已交付',
    PARTIAL: '部分签收',
    PENDING: '待处理',
    PENDING_INSPECTION: '待检隔离',
    RELEASED: '已放行',
    REJECTED: '已拒绝',
  };
  return labels[status] || status;
}

function isReleasedHold(hold: ShipmentReturnHoldView) {
  const normalized = hold.status.toUpperCase();
  return normalized === 'RELEASED' || normalized === 'AVAILABLE' || Boolean(hold.releasedAt);
}

function snapshotIdentity(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { partNumber: '—', serialNumber: '—', batchNumber: '—' };
  const record = value as Record<string, unknown>;
  const nested = record.inventory && typeof record.inventory === 'object' && !Array.isArray(record.inventory)
    ? record.inventory as Record<string, unknown>
    : record;
  const text = (candidate: unknown) => typeof candidate === 'string' && candidate.trim() ? candidate : '—';
  return {
    partNumber: text(record.partNumber ?? nested.partNumber),
    serialNumber: text(record.serialNumber ?? nested.serialNumber),
    batchNumber: text(record.batchNumber ?? nested.batchNumber),
  };
}

function lineIdentity(line: ShipmentLineView) {
  return snapshotIdentity(line.identitySnapshot);
}

function EvidencePicker({
  label,
  files,
  busy,
  required,
  onUpload,
}: {
  label: string;
  files: EvidenceFile[];
  busy: boolean;
  required?: boolean;
  onUpload: (files: FileList | null) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="flex items-center gap-2 text-xs">
        <Upload className="h-3 w-3" />
        {label}{required ? ' *' : ''}
      </Label>
      <Input
        type="file"
        multiple
        aria-label={label}
        className="h-8"
        onChange={(event) => {
          onUpload(event.target.files);
          event.target.value = '';
        }}
        disabled={busy}
      />
      {files.length > 0 && <p className="text-xs text-gray-600">{files.map((file) => file.originalName).join(', ')}</p>}
    </div>
  );
}

export function ShipmentPanel({ orderId, onChanged, className }: ShipmentPanelProps) {
  const { locale } = useTranslation();
  const can = useCapabilityStore((state) => state.can);
  const tx = useCallback((zh: string, en: string) => (locale === 'zh-CN' ? zh : en), [locale]);
  const canManage = can('inventory.manage');
  const canApproveQuality = can('quality_review.approve');

  const [data, setData] = useState<ShipmentOrderView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reload, setReload] = useState(0);

  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [selectedSources, setSelectedSources] = useState<Record<string, boolean>>({});
  const [sourceQuantities, setSourceQuantities] = useState<Record<string, string>>({});
  const [shipmentEvidence, setShipmentEvidence] = useState<EvidenceFile[]>([]);

  const [receiptQuantities, setReceiptQuantities] = useState<Record<string, string>>({});
  const [receiptReason, setReceiptReason] = useState('');
  const [receiptEvidence, setReceiptEvidence] = useState<EvidenceFile[]>([]);

  const [returnLineId, setReturnLineId] = useState('');
  const [returnQuantity, setReturnQuantity] = useState('');
  const [returnSerialNumber, setReturnSerialNumber] = useState('');
  const [returnBatchNumber, setReturnBatchNumber] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [returnEvidence, setReturnEvidence] = useState<EvidenceFile[]>([]);

  const [releaseHoldId, setReleaseHoldId] = useState('');
  const [releaseContext, setReleaseContext] = useState<Awaited<ReturnType<typeof shipmentApi.getReturnReleaseContext>> | null>(null);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [releaseError, setReleaseError] = useState('');
  const [releaseSerialNumber, setReleaseSerialNumber] = useState('');
  const [releaseBatchNumber, setReleaseBatchNumber] = useState('');
  const [releaseReason, setReleaseReason] = useState('');
  const [releaseEvidence, setReleaseEvidence] = useState<EvidenceFile[]>([]);
  const [releaseChecks, setReleaseChecks] = useState<Checks>(emptyChecks);
  const [downloadingEvidenceId, setDownloadingEvidenceId] = useState('');

  const reloadData = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    setError('');
    try {
      setData(await shipmentApi.getByOrderId(orderId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : tx('发运数据加载失败', 'Failed to load shipment data'));
    } finally {
      setLoading(false);
    }
  }, [orderId, tx]);

  useEffect(() => {
    void reloadData();
  }, [reloadData, reload]);

  const allShipmentLines = useMemo(() => data?.shipments.flatMap((shipment) => shipment.lines.map((line) => ({ shipment, line }))) ?? [], [data]);
  const allReturnHolds = useMemo(() => allShipmentLines.flatMap(({ shipment, line }) => line.returns.map((hold) => ({ shipment, line, hold }))), [allShipmentLines]);
  const selectedReleaseHold = allReturnHolds.find(({ hold }) => hold.id === releaseHoldId)?.hold;
  const selectedReturnLine = allShipmentLines.find(({ line }) => line.id === returnLineId)?.line;

  const uploadFiles = async (
    files: FileList | null,
    setFiles: (updater: (previous: EvidenceFile[]) => EvidenceFile[]) => void,
    busyName: string,
  ) => {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;
    setBusy(busyName);
    setError('');
    try {
      for (const file of selected) {
        const uploaded = await qualityReviewApi.uploadEvidence(file);
        setFiles((previous) => [...previous, uploaded]);
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : tx('证据上传失败', 'Evidence upload failed');
      setError(message);
      toast.error(message);
    } finally {
      setBusy('');
    }
  };

  const runAction = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError('');
    try {
      await action();
      setReload((value) => value + 1);
      await onChanged?.();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : tx('操作失败', 'Operation failed');
      setError(message);
      toast.error(message);
    } finally {
      setBusy('');
    }
  };

  const handleCreateShipment = async () => {
    if (!data || !canManage) return;
    const lines = data.outboundTransactions
      .filter((source) => selectedSources[source.id])
      .map((source) => ({ outboundTransactionId: source.id, quantity: positiveInteger(sourceQuantities[source.id] || '') }))
      .filter((line) => line.quantity > 0);
    if (lines.length === 0 || !carrier.trim() || !trackingNumber.trim() || !origin.trim() || !destination.trim()) return;
    await runAction('shipment', async () => {
      await shipmentApi.create({
        orderId,
        carrier: carrier.trim(),
        trackingNumber: trackingNumber.trim(),
        origin: origin.trim(),
        destination: destination.trim(),
        lines,
        evidenceIds: shipmentEvidence.map((file) => file.id),
      });
      toast.success(tx('发运单已创建', 'Shipment created'));
      setSelectedSources({});
      setSourceQuantities({});
      setShipmentEvidence([]);
    });
  };

  const handleReceipt = async () => {
    if (!canManage) return;
    const lines = allShipmentLines
      .map(({ line }) => ({ shipmentLineId: line.id, quantity: positiveInteger(receiptQuantities[line.id] || '') }))
      .filter((line) => line.quantity > 0);
    if (lines.length === 0 || receiptEvidence.length === 0 || !receiptReason.trim()) return;
    const shipmentId = allShipmentLines.find(({ line }) => line.id === lines[0].shipmentLineId)?.shipment.id;
    if (!shipmentId || lines.some((line) => allShipmentLines.find(({ line: candidate }) => candidate.id === line.shipmentLineId)?.shipment.id !== shipmentId)) {
      setError(tx('一次签收只能提交同一发运单的行，请分批提交。', 'A receipt command can contain lines from one shipment only. Submit each shipment separately.'));
      return;
    }
    await runAction('receipt', async () => {
      await shipmentApi.createReceipt(shipmentId, { lines, evidenceIds: receiptEvidence.map((file) => file.id), reason: receiptReason.trim() });
      toast.success(tx('签收记录已保存', 'Receipt recorded'));
      setReceiptQuantities({});
      setReceiptEvidence([]);
      setReceiptReason('');
    });
  };

  const handleReturn = async () => {
    if (!selectedReturnLine || !canManage) return;
    const amount = positiveInteger(returnQuantity);
    if (amount <= 0 || amount > Math.max(0, selectedReturnLine.quantity - selectedReturnLine.returnedQuantity) || returnEvidence.length === 0 || !returnReason.trim()) return;
    await runAction('return', async () => {
      await shipmentApi.createReturn({
        shipmentLineId: selectedReturnLine.id,
        quantity: amount,
        evidenceIds: returnEvidence.map((file) => file.id),
        verifiedSerialNumber: returnSerialNumber.trim(),
        verifiedBatchNumber: returnBatchNumber.trim(),
        reason: returnReason.trim(),
      });
      toast.success(tx('退货已进入待检隔离', 'Return moved to inspection hold'));
      setReturnLineId('');
      setReturnQuantity('');
      setReturnSerialNumber('');
      setReturnBatchNumber('');
      setReturnReason('');
      setReturnEvidence([]);
    });
  };

  const loadReleaseContext = useCallback(async () => {
    if (!releaseHoldId || !canApproveQuality) return;
    setReleaseLoading(true);
    setReleaseError('');
    setReleaseContext(null);
    try {
      const context = await shipmentApi.getReturnReleaseContext(releaseHoldId);
      setReleaseContext(context);
      setReleaseSerialNumber('');
      setReleaseBatchNumber('');
      setReleaseChecks(emptyChecks);
    } catch (requestError) {
      setReleaseError(requestError instanceof Error ? requestError.message : tx('退货放行快照加载失败', 'Failed to load return release context'));
    } finally {
      setReleaseLoading(false);
    }
  }, [canApproveQuality, releaseHoldId, tx]);

  const downloadReceivedEvidence = async (evidenceId: string) => {
    if (!evidenceId) return;
    setDownloadingEvidenceId(evidenceId);
    setReleaseError('');
    try {
      const blob = await qualityReviewApi.getEvidenceBlob(evidenceId);
      downloadBlob(blob, `shipment-return-receipt-evidence-${evidenceId.slice(0, 12)}.bin`);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : tx('接收证据下载失败', 'Failed to download receipt evidence');
      setReleaseError(message);
      toast.error(message);
    } finally {
      setDownloadingEvidenceId('');
    }
  };

  useEffect(() => {
    if (!releaseHoldId) {
      setReleaseContext(null);
      setReleaseError('');
      return;
    }
    void loadReleaseContext();
  }, [loadReleaseContext, releaseHoldId]);

  const handleRelease = async () => {
    if (!releaseContext || !selectedReleaseHold || !canApproveQuality) return;
    if (releaseEvidence.length === 0 || !releaseReason.trim() || Object.values(releaseChecks).some((checked) => !checked)) return;
    await runAction('release-return', async () => {
      await shipmentApi.releaseReturn(selectedReleaseHold.id, {
        snapshotHash: releaseContext.snapshotHash,
        evidenceIds: releaseEvidence.map((file) => file.id),
        verifiedSerialNumber: releaseSerialNumber.trim(),
        verifiedBatchNumber: releaseBatchNumber.trim(),
        checks: releaseChecks,
        reason: releaseReason.trim(),
      });
      toast.success(tx('退货已通过独立质量放行', 'Return released by independent quality review'));
      setReleaseHoldId('');
      setReleaseContext(null);
      setReleaseEvidence([]);
      setReleaseReason('');
    });
  };

  const shipmentLines = allShipmentLines;
  const selectedShipmentLines = data?.outboundTransactions.filter((source) => selectedSources[source.id]) ?? [];
  const selectedSourceLines = selectedShipmentLines
    .map((source) => ({ source, quantity: positiveInteger(sourceQuantities[source.id] || '') }))
    .filter(({ quantity }) => quantity > 0);
  const canCreate = canManage
    && selectedSourceLines.length > 0
    && selectedSourceLines.every(({ source, quantity }) => quantity <= source.availableQuantity)
    && Boolean(carrier.trim() && trackingNumber.trim() && origin.trim() && destination.trim());
  const selectedReceiptLines = shipmentLines
    .map(({ line }) => ({ line, quantity: positiveInteger(receiptQuantities[line.id] || '') }))
    .filter(({ quantity }) => quantity > 0);
  const canReceive = canManage
    && receiptEvidence.length > 0
    && Boolean(receiptReason.trim())
    && selectedReceiptLines.length > 0
    && selectedReceiptLines.every(({ line, quantity }) => quantity <= Math.max(0, line.quantity - line.receivedQuantity));
  const canReturn = canManage
    && Boolean(selectedReturnLine)
    && positiveInteger(returnQuantity) > 0
    && positiveInteger(returnQuantity) <= Math.max(0, (selectedReturnLine?.quantity ?? 0) - (selectedReturnLine?.returnedQuantity ?? 0))
    && returnEvidence.length > 0
    && Boolean(returnReason.trim());
  const releaseIdentity = releaseContext?.snapshot ?? selectedReleaseHold?.identitySnapshot;
  const releaseIdentityView = snapshotIdentity(releaseIdentity);
  const canRelease = canApproveQuality
    && Boolean(releaseContext && selectedReleaseHold && !isReleasedHold(selectedReleaseHold))
    && releaseEvidence.length > 0
    && Boolean(releaseReason.trim())
    && Object.values(releaseChecks).every(Boolean);

  const labels = {
    identity: tx('已核对退回件号、状态及序号/批次', 'Returned part, condition and serial/batch checked'),
    documents: tx('已核对退货文件与实物一致', 'Return documents match the physical item'),
    conditionAndLife: tx('已核对寿命、货架期及保存条件', 'Life, shelf life and storage checked'),
    customerRequirements: tx('已满足退货质量要求', 'Return quality requirements met'),
  };

  return (
    <section className={cn('space-y-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4', className)} aria-label={tx('发运、签收与退货', 'Shipments, receipts and returns')}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-2 font-medium"><ShipWheel className="h-4 w-4 text-slate-700" />{tx('分批发运与签收', 'Shipments and receipts')}</h4>
          <p className="text-xs text-gray-500">{tx('发运来源必须选择真实 OUTBOUND 流水；已发运、签收、待检隔离和质量放行分别记录。', 'Select real OUTBOUND sources; shipped, received, inspection hold and quality release remain separate facts.')}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setReload((value) => value + 1)} disabled={loading || Boolean(busy)} aria-label={tx('刷新发运', 'Refresh shipments')}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {error && <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {loading ? <div className="flex items-center gap-2 py-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />{tx('加载发运数据...', 'Loading shipment data...')}</div> : data && (
        <>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div className="rounded border bg-white p-2"><span className="block text-xs text-gray-500">{tx('应交付', 'Required')}</span><strong>{displayQuantity(data.delivery.requiredQuantity)}</strong></div>
            <div className="rounded border bg-white p-2"><span className="block text-xs text-gray-500">{tx('实际签收', 'Received')}</span><strong>{displayQuantity(data.delivery.receivedQuantity)}</strong></div>
            <div className="rounded border bg-white p-2"><span className="block text-xs text-gray-500">{tx('待签收', 'Remaining')}</span><strong>{displayQuantity(data.delivery.remainingQuantity)}</strong></div>
            <div className="rounded border bg-white p-2"><span className="block text-xs text-gray-500">{tx('交付状态', 'Delivery')}</span><strong className={data.delivery.complete ? 'text-green-700' : 'text-amber-700'}>{data.delivery.complete ? tx('全部签收', 'Complete') : tx('未完成', 'Incomplete')}</strong></div>
          </div>

          {canManage && <div className="space-y-3 rounded border bg-white p-3">
            <div className="flex items-center gap-2"><FileCheck2 className="h-4 w-4 text-slate-700" /><p className="text-sm font-medium">{tx('创建发运单', 'Create shipment')}</p></div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Label>{tx('承运人', 'Carrier')}<Input value={carrier} onChange={(event) => setCarrier(event.target.value)} /></Label>
              <Label>{tx('运单号', 'Tracking number')}<Input value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} /></Label>
              <Label>{tx('起运地', 'Origin')}<Input value={origin} onChange={(event) => setOrigin(event.target.value)} /></Label>
              <Label>{tx('目的地', 'Destination')}<Input value={destination} onChange={(event) => setDestination(event.target.value)} /></Label>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-gray-600">{tx('明确选择实际 OUTBOUND 来源（可多批次）', 'Explicitly select actual OUTBOUND sources (multiple batches allowed)')}</p>
              {data.outboundTransactions.length === 0 ? <p className="text-xs text-gray-500">{tx('暂无可发运的实际出库流水。', 'No actual OUTBOUND quantity is available.')}</p> : data.outboundTransactions.map((source) => {
                const selected = Boolean(selectedSources[source.id]);
                return <div key={source.id} className="grid gap-2 rounded border p-2 sm:grid-cols-[auto_1fr_8rem] sm:items-center">
                  <input type="checkbox" aria-label={`${tx('选择发运来源', 'Select shipment source')} ${source.partNumber} ${source.id}`} checked={selected} onChange={(event) => setSelectedSources((previous) => ({ ...previous, [source.id]: event.target.checked }))} disabled={source.availableQuantity <= 0 || Boolean(busy)} />
                  <div className="text-xs"><p className="font-mono">{source.partNumber}</p><p className="text-gray-500">{source.batchNumber ? `BN ${source.batchNumber}` : source.serialNumber ? `SN ${source.serialNumber}` : tx('未提供批次/序号', 'No batch/serial')} · {tx('可发运', 'Available')} {displayQuantity(source.availableQuantity)}</p>{source.requiresHistoricalReview && <p className="text-amber-700">{tx('缺少当前质量复核映射，需历史复核后才能发运', 'Historical quality review is required before shipment')}</p>}</div>
                  <Label>{tx('本次发运', 'Ship qty')}<Input type="number" min={1} max={source.availableQuantity} step={1} value={sourceQuantities[source.id] || ''} onChange={(event) => setSourceQuantities((previous) => ({ ...previous, [source.id]: event.target.value }))} disabled={!selected || Boolean(busy)} aria-label={`${tx('发运数量', 'Shipment quantity')} ${source.partNumber}`} /></Label>
                </div>;
              })}
            </div>
            <EvidencePicker label={tx('附加订单证据（可选）', 'Additional order evidence (optional)')} files={shipmentEvidence} busy={Boolean(busy)} onUpload={(files) => void uploadFiles(files, setShipmentEvidence, 'shipment-evidence')} />
            <Button size="sm" onClick={() => void handleCreateShipment()} disabled={!canCreate || Boolean(busy)}>{busy === 'shipment' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('创建发运单', 'Create shipment')}</Button>
          </div>}

          {data.shipments.length === 0 ? <p className="rounded border bg-white p-3 text-sm text-gray-500">{tx('暂无发运单。', 'No shipment has been created.')}</p> : <div className="space-y-3">
            {data.shipments.map((shipment) => <div key={shipment.id} className="space-y-3 rounded border bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{shipment.shipmentNumber}</p><p className="text-xs text-gray-500">{shipment.carrier} · {shipment.trackingNumber} · {shipment.origin} → {shipment.destination}</p></div><Badge variant="outline">{statusText(shipment.status, locale)}</Badge></div>
              <div className="space-y-2">{shipment.lines.map((line) => {
                const identity = lineIdentity(line);
                const remainingToReceive = Math.max(0, line.quantity - line.receivedQuantity);
                const remainingToReturn = Math.max(0, line.quantity - line.returnedQuantity);
                return <div key={line.id} className="rounded border p-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2"><div><span className="font-mono">{identity.partNumber}</span><span className="ml-2 text-xs text-gray-500">{identity.batchNumber !== '—' ? `BN ${identity.batchNumber}` : identity.serialNumber !== '—' ? `SN ${identity.serialNumber}` : ''}</span></div><span className="text-xs text-gray-600">{tx('发运', 'Shipped')} {displayQuantity(line.quantity)} · {tx('签收', 'Received')} {displayQuantity(line.receivedQuantity)} · {tx('退货隔离/收回', 'Returned')} {displayQuantity(line.returnedQuantity)}</span></div>
                  <p className="mt-1 text-xs text-gray-500">{tx('待签收', 'To receive')} {displayQuantity(remainingToReceive)} · {tx('可退回至隔离', 'Return headroom')} {displayQuantity(remainingToReturn)} · {tx('发运时间', 'Shipped at')} {displayDate(shipment.shippedAt, locale)}</p>
                  {line.returns.length > 0 && <div className="mt-2 space-y-1 border-t pt-2">{line.returns.map((hold) => <div key={hold.id} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{tx('隔离退货', 'Return hold')} {displayQuantity(hold.quantity)} · {statusText(hold.status, locale)}</span>{isReleasedHold(hold) && <Badge variant="outline" className="text-green-700">{tx('已放行', 'Released')}</Badge>}</div>)}</div>}
                  {canManage && remainingToReceive > 0 && <Label className="mt-2 block max-w-xs text-xs">{tx('本行签收数量', 'Receive this line')}<Input type="number" min={1} max={remainingToReceive} step={1} value={receiptQuantities[line.id] || ''} onChange={(event) => setReceiptQuantities((previous) => ({ ...previous, [line.id]: event.target.value }))} aria-label={`${tx('签收数量', 'Receipt quantity')} ${shipment.shipmentNumber} ${line.lineNo}`} /></Label>}
                </div>;
              })}</div>
            </div>)}
          </div>}

          {canManage && data.shipments.length > 0 && <div className="space-y-3 rounded border bg-white p-3">
            <p className="text-sm font-medium">{tx('记录签收', 'Record receipt')}</p>
            <div><p className="mb-1 text-xs text-gray-500">{tx('签收依据', 'Receipt evidence')}</p><EvidencePicker label={tx('本人上传签收证据', 'Upload receipt evidence')} files={receiptEvidence} busy={Boolean(busy)} required onUpload={(files) => void uploadFiles(files, setReceiptEvidence, 'receipt-evidence')} /></div>
            <Label>{tx('签收说明', 'Receipt reason')}<Textarea value={receiptReason} onChange={(event) => setReceiptReason(event.target.value)} placeholder={tx('填写签收或拒收说明', 'Record the receipt or refusal reason')} /></Label>
            <Button size="sm" onClick={() => void handleReceipt()} disabled={!canReceive || Boolean(busy)}>{busy === 'receipt' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('保存签收', 'Record receipt')}</Button>
          </div>}

          {canManage && data.shipments.length > 0 && <div className="space-y-3 rounded border bg-white p-3">
            <p className="text-sm font-medium">{tx('登记退货并进入隔离', 'Record return to inspection hold')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Label>{tx('选择发运行', 'Select shipment line')}<select className="h-9 w-full rounded-md border bg-white px-3 text-sm" aria-label={tx('选择退货发运行', 'Select return shipment line')} value={returnLineId} onChange={(event) => setReturnLineId(event.target.value)}><option value="">{tx('请选择来源行', 'Select a source line')}</option>{allShipmentLines.map(({ shipment, line }) => <option key={line.id} value={line.id}>{shipment.shipmentNumber} · {lineIdentity(line).partNumber} · {tx('可退', 'Returnable')} {Math.max(0, line.quantity - line.returnedQuantity)} EA</option>)}</select></Label>
              <Label>{tx('退货数量', 'Return qty')}<Input type="number" min={1} max={selectedReturnLine ? Math.max(0, selectedReturnLine.quantity - selectedReturnLine.returnedQuantity) : undefined} step={1} value={returnQuantity} onChange={(event) => setReturnQuantity(event.target.value)} disabled={!selectedReturnLine} /></Label>
              <Label>{tx('核对序号', 'Verified serial')}<Input value={returnSerialNumber} onChange={(event) => setReturnSerialNumber(event.target.value)} disabled={!selectedReturnLine} /></Label>
              <Label>{tx('核对批次', 'Verified batch')}<Input value={returnBatchNumber} onChange={(event) => setReturnBatchNumber(event.target.value)} disabled={!selectedReturnLine} /></Label>
            </div>
            <EvidencePicker label={tx('本人上传退货证据', 'Upload return evidence')} files={returnEvidence} busy={Boolean(busy)} required onUpload={(files) => void uploadFiles(files, setReturnEvidence, 'return-evidence')} />
            <Label>{tx('退货原因', 'Return reason')}<Textarea value={returnReason} onChange={(event) => setReturnReason(event.target.value)} placeholder={tx('填写拒收或退货原因', 'Record refusal or return reason')} /></Label>
            <Button size="sm" onClick={() => void handleReturn()} disabled={!canReturn || Boolean(busy)}>{busy === 'return' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('登记退货隔离', 'Record return hold')}</Button>
          </div>}

          {allReturnHolds.length > 0 && <div className="space-y-3 rounded border bg-white p-3">
            <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-green-700" /><p className="text-sm font-medium">{tx('退货质量放行', 'Return quality release')}</p></div>
            <div className="space-y-2">{allReturnHolds.map(({ shipment, line, hold }) => <div key={hold.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-xs"><span>{shipment.shipmentNumber} · {lineIdentity(line).partNumber} · {tx('隔离', 'Hold')} {displayQuantity(hold.quantity)} · {statusText(hold.status, locale)}</span><Button variant="outline" size="sm" onClick={() => setReleaseHoldId(hold.id)} disabled={isReleasedHold(hold) || !canApproveQuality}>{tx('选择复核', 'Review')}</Button></div>)}</div>
            {releaseHoldId && selectedReleaseHold && canApproveQuality && <div className="space-y-3 rounded border border-green-200 bg-green-50/50 p-3">
              {releaseLoading ? <p className="text-sm text-gray-600"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />{tx('加载放行快照...', 'Loading release snapshot...')}</p> : releaseContext ? <>
                 <p className="text-xs text-gray-700">{releaseIdentityView.partNumber} · {tx('序号', 'Serial')}: {releaseIdentityView.serialNumber} · {tx('批次', 'Batch')}: {releaseIdentityView.batchNumber} · {tx('快照', 'Snapshot')}: {releaseContext.snapshotHash.slice(0, 12)}…</p>
                 <div className="grid gap-2 text-xs sm:grid-cols-2">
                   <div className="rounded border bg-white p-2"><p className="font-medium">{tx('当前库存事实', 'Current inventory facts')}</p><p>{tx('状态', 'Status')}: {releaseContext.inventoryDetail.status} · {tx('数量', 'Quantity')}: {displayQuantity(releaseContext.inventoryDetail.quantity)} · {tx('活动分配', 'Allocated')}: {displayQuantity(releaseContext.inventoryDetail.allocatedQuantity)}</p><p>{tx('证书类型', 'Certificate type')}: {releaseContext.inventoryDetail.certificateType || '—'}</p><p>{tx('寿命限制', 'Life limited')}: {releaseContext.inventoryDetail.lifeLimited ? tx('是', 'Yes') : tx('否', 'No')} · {tx('剩余小时/循环', 'Remaining hours/cycles')}: {releaseContext.inventoryDetail.remainingHours ?? '—'} / {releaseContext.inventoryDetail.remainingCycles ?? '—'}</p><p>{tx('货架期/检修到期', 'Shelf life / overhaul due')}: {displayDate(releaseContext.inventoryDetail.shelfLifeDate, locale)} / {displayDate(releaseContext.inventoryDetail.nextOverhaulDue, locale)}</p></div>
                   <div className="rounded border bg-white p-2"><p className="font-medium">{tx('证书记录', 'Certificate records')}</p>{releaseContext.certificates.length === 0 ? <p>—</p> : <ul className="space-y-1">{releaseContext.certificates.map((certificate) => <li key={certificate.id}>{certificate.certificateNumber} · {certificate.certificateType} · {statusText(certificate.status, locale)} · {tx('有效期', 'Expires')}: {displayDate(certificate.expiryDate, locale)}</li>)}</ul>}</div>
                 </div>
                 <div className="rounded border bg-white p-2 text-xs"><p className="font-medium">{tx('接收证据', 'Receipt evidence')}</p>{releaseContext.evidence.length === 0 ? <p>—</p> : <div className="space-y-1">{releaseContext.evidence.map((evidence) => <div key={evidence.id} className="flex flex-wrap items-center justify-between gap-2"><span>{evidence.id.slice(0, 12)}… · {statusText(evidence.status, locale)}</span><Button variant="outline" size="sm" onClick={() => void downloadReceivedEvidence(evidence.id)} disabled={Boolean(busy) || Boolean(downloadingEvidenceId)} aria-label={tx(`查看接收证据 ${evidence.id.slice(0, 12)}`, `View receipt evidence ${evidence.id.slice(0, 12)}`)}>{downloadingEvidenceId === evidence.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{downloadingEvidenceId === evidence.id ? tx('下载中', 'Downloading') : <><Download className="mr-1 h-3 w-3" />{tx('查看接收证据', 'View receipt evidence')}</>}</Button></div>)}</div>}</div>
                 <div className="grid gap-2 sm:grid-cols-2"><Label>{tx('核对序号', 'Verified serial')}<Input value={releaseSerialNumber} onChange={(event) => setReleaseSerialNumber(event.target.value)} /></Label><Label>{tx('核对批次', 'Verified batch')}<Input value={releaseBatchNumber} onChange={(event) => setReleaseBatchNumber(event.target.value)} /></Label></div>
                <div className="grid gap-1 text-xs">{(Object.keys(labels) as Array<keyof Checks>).map((key) => <label key={key} className="flex items-start gap-2"><input type="checkbox" checked={releaseChecks[key]} onChange={(event) => setReleaseChecks((previous) => ({ ...previous, [key]: event.target.checked }))} />{labels[key]}</label>)}</div>
                <EvidencePicker label={tx('本人上传放行证据', 'Upload release evidence')} files={releaseEvidence} busy={Boolean(busy)} required onUpload={(files) => void uploadFiles(files, setReleaseEvidence, 'release-evidence')} />
                <Label>{tx('放行依据', 'Release reason')}<Textarea value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)} placeholder={tx('填写独立质量核对依据', 'Record the independent quality checks')} /></Label>
                <Button size="sm" onClick={() => void handleRelease()} disabled={!canRelease || Boolean(busy)}>{busy === 'release-return' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('质量放行退货', 'Release return')}</Button>
              </> : releaseError ? <p role="alert" className="text-xs text-red-700">{releaseError}</p> : null}
            </div>}
          </div>}
        </>
      )}
    </section>
  );
}

export default ShipmentPanel;
