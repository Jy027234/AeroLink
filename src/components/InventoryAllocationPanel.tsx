import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Package, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { inventoryAllocationApi, inventoryItemApi, qualityReviewApi, type AllocationQualityReviewContext, type InventoryAllocationView, type OrderLineInventoryAvailability } from '@/api/client';
import type { InventoryDetail } from '@/types';
import { useCapabilityStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

type AllocationPanelMode = 'quotation' | 'order';

export interface InventoryAllocationPanelProps {
  mode: AllocationPanelMode;
  quotationLineId: string;
  orderLineId?: string;
  partNumber: string;
  quantity: number;
  acceptedQuantity?: number;
  outboundQuantity?: number;
  onChanged?: () => void | Promise<unknown>;
  className?: string;
}

type Checks = {
  identity: boolean;
  documents: boolean;
  conditionAndLife: boolean;
  customerRequirements: boolean;
};

const emptyChecks: Checks = {
  identity: false,
  documents: false,
  conditionAndLife: false,
  customerRequirements: false,
};

function positiveInteger(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function detailAvailable(detail: InventoryDetail) {
  const allocated = detail.allocatedQuantity ?? 0;
  return detail.status === 'AVAILABLE' && Math.max(0, detail.quantity - allocated) > 0;
}

function detailLabel(detail: InventoryDetail, available: number) {
  const serial = detail.serialNumber ? ` · SN ${detail.serialNumber}` : '';
  const batch = detail.batchNumber ? ` · BN ${detail.batchNumber}` : '';
  const location = detail.warehouse || detail.location ? ` · ${detail.warehouse || detail.location}` : '';
  return `${available} EA · ${detail.conditionCode}${serial}${batch}${location}`;
}

function allocationActive(allocation: InventoryAllocationView) {
  return Math.max(0, allocation.activeQuantity);
}

function assignmentActive(assignment: { activeQuantity: number }) {
  return Math.max(0, assignment.activeQuantity);
}

function sumConsumed(allocations: InventoryAllocationView[]) {
  return allocations.reduce((total, allocation) => total + Math.max(0, allocation.consumedQuantity), 0);
}

export function InventoryAllocationPanel({
  mode,
  quotationLineId,
  orderLineId,
  partNumber,
  quantity,
  outboundQuantity,
  onChanged,
  className,
}: InventoryAllocationPanelProps) {
  const can = useCapabilityStore((state) => state.can);
  const { locale } = useTranslation();
  const tx = useCallback((zh: string, en: string) => (locale === 'zh-CN' ? zh : en), [locale]);
  const isOrder = mode === 'order';
  const canManage = can('inventory.manage');
  const canReadQuality = isOrder && can('quality_review.read');
  const canApproveQuality = isOrder && can('quality_review.approve');

  const [availability, setAvailability] = useState<Awaited<ReturnType<typeof inventoryAllocationApi.getQuotationLine>> | null>(null);
  const [orderView, setOrderView] = useState<OrderLineInventoryAvailability | null>(null);
  const [details, setDetails] = useState<InventoryDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailsError, setDetailsError] = useState('');
  const [reload, setReload] = useState(0);

  const [selectedDetailId, setSelectedDetailId] = useState('');
  const [reserveQuantity, setReserveQuantity] = useState('1');
  const [selectedAllocationId, setSelectedAllocationId] = useState('');
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('');
  const [actionQuantity, setActionQuantity] = useState('1');
  const [releaseReason, setReleaseReason] = useState('');
  const [busy, setBusy] = useState('');

  const [reviewQuantity, setReviewQuantity] = useState('1');
  const [reviewContext, setReviewContext] = useState<AllocationQualityReviewContext | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [checks, setChecks] = useState<Checks>(emptyChecks);
  const [verifiedSerialNumber, setVerifiedSerialNumber] = useState('');
  const [verifiedBatchNumber, setVerifiedBatchNumber] = useState('');
  const [reviewReason, setReviewReason] = useState('');
  const [reviewEvidence, setReviewEvidence] = useState<Array<{ id: string; originalName: string }>>([]);
  const [consumeNotes, setConsumeNotes] = useState('');

  const reloadData = useCallback(async () => {
    if (!quotationLineId || (isOrder && !orderLineId)) return;
    setLoading(true);
    setDetailsLoading(true);
    setError('');
    try {
      if (isOrder && orderLineId) {
        // Quality-only users may have order scope without quotation.read.
        // Load the order-line view first so their review/outbound workflow is
        // independent from the parent allocation read permission.
        setOrderView(await inventoryAllocationApi.getOrderLine(orderLineId));
        if (can('quotation.read')) {
          try {
            setAvailability(await inventoryAllocationApi.getQuotationLine(quotationLineId));
          } catch (requestError) {
            setAvailability(null);
            setDetailsError(requestError instanceof Error ? requestError.message : tx('父分配数据加载失败', 'Failed to load parent allocations'));
          }
        } else {
          setAvailability(null);
        }
      } else {
        setAvailability(await inventoryAllocationApi.getQuotationLine(quotationLineId));
        setOrderView(null);
      }
      try {
        const item = await inventoryItemApi.getByPartNumber(partNumber);
        setDetails(item.details ?? []);
        setDetailsError('');
      } catch (requestError) {
        setDetails([]);
        const statusCode = requestError && typeof requestError === 'object' && 'statusCode' in requestError
          ? (requestError as { statusCode?: unknown }).statusCode
          : undefined;
        if (statusCode === 404) {
          // A missing inventory catalog row is a normal empty-stock state for
          // a new part or a supplier-direct-only order. Keep the actionable
          // empty-state copy below instead of showing a red transport error.
          setDetailsError('');
        } else {
          setDetailsError(requestError instanceof Error ? requestError.message : tx('库存明细加载失败', 'Failed to load inventory details'));
        }
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : tx('库存分配数据加载失败', 'Failed to load allocation data'));
    } finally {
      setLoading(false);
      setDetailsLoading(false);
    }
  }, [can, isOrder, orderLineId, partNumber, quotationLineId, tx]);

  useEffect(() => {
    void reloadData();
  }, [reloadData, reload]);

  const availableDetails = useMemo(() => details.filter(detailAvailable), [details]);
  const selectedDetail = availableDetails.find((detail) => detail.id === selectedDetailId);
  const selectedDetailAvailable = selectedDetail
    ? Math.max(0, selectedDetail.quantity - (selectedDetail.allocatedQuantity ?? 0))
    : 0;
  const allocationViews = availability?.allocations ?? [];
  const selectedAllocation = allocationViews.find((allocation) => allocation.id === selectedAllocationId);
  const orderAssignments = orderView?.assignments ?? [];
  const selectedAssignment = orderAssignments.find((assignment) => assignment.id === selectedAssignmentId);
  const allocationDetail = (allocation: InventoryAllocationView) => details.find((detail) => detail.id === allocation.inventoryDetailId);

  const demand = isOrder ? (orderView?.quantity ?? quantity) : (availability?.quantity ?? quantity);
  const unassigned = availability?.unassignedQuantity ?? 0;
  const assigned = isOrder
    ? orderAssignments.reduce((total, assignment) => total + assignmentActive(assignment), 0)
    : (availability?.assignedActiveQuantity ?? 0);
  const outbound = isOrder ? (orderView?.outboundQuantity ?? outboundQuantity ?? 0) : sumConsumed(allocationViews);
  const directShipped = isOrder ? (orderView?.directShippedQuantity ?? 0) : 0;
  const localFulfillmentRemaining = isOrder ? Math.max(0, demand - outbound - directShipped - assigned) : Number.POSITIVE_INFINITY;
  const selectedDetailReserveLimit = selectedDetail ? Math.min(selectedDetailAvailable, localFulfillmentRemaining) : 0;
  const selectedAllocationAssignLimit = selectedAllocation ? Math.min(selectedAllocation.unassignedQuantity, localFulfillmentRemaining) : 0;

  useEffect(() => {
    if (!selectedDetailId && availableDetails.length === 1) {
      // A single result is still displayed for explicit selection; do not
      // silently choose it. The operator must confirm the detail/batch.
      return;
    }
    if (selectedDetailId && !selectedDetail) setSelectedDetailId('');
  }, [availableDetails.length, selectedDetail, selectedDetailId]);

  useEffect(() => {
    if (selectedAllocationId && !selectedAllocation) setSelectedAllocationId('');
    if (selectedAssignmentId && !selectedAssignment) setSelectedAssignmentId('');
  }, [selectedAllocation, selectedAllocationId, selectedAssignment, selectedAssignmentId]);

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

  const handleReserve = async () => {
    const reserveAmount = positiveInteger(reserveQuantity);
    if (!selectedDetail || reserveAmount <= 0 || reserveAmount > selectedDetailReserveLimit) return;
    await runAction('reserve', async () => {
      await inventoryAllocationApi.reserve({
        quotationLineId,
        ...(isOrder && orderLineId ? { orderLineId } : {}),
        allocations: [{ inventoryDetailId: selectedDetail.id, quantity: reserveAmount }],
      });
      toast.success(tx('库存预留成功', 'Inventory reserved'));
      setSelectedDetailId('');
      setReserveQuantity('1');
    });
  };

  const handleAssign = async () => {
    if (!isOrder || !orderLineId || !selectedAllocation) return;
    const amount = positiveInteger(actionQuantity);
    if (amount <= 0 || amount > selectedAllocationAssignLimit) return;
    await runAction('assign', async () => {
      await inventoryAllocationApi.assign({ orderLineId, allocations: [{ allocationId: selectedAllocation.id, quantity: amount }] });
      toast.success(tx('库存分配成功', 'Inventory assigned'));
      setSelectedAllocationId('');
      setActionQuantity('1');
    });
  };

  const handleRelease = async () => {
    const amount = positiveInteger(actionQuantity);
    if (!selectedAllocation && !selectedAssignment) return;
    const max = selectedAssignment ? assignmentActive(selectedAssignment) : selectedAllocation ? selectedAllocation.unassignedQuantity : 0;
    if (amount <= 0 || amount > max || releaseReason.trim().length < 1) return;
    await runAction('release', async () => {
      await inventoryAllocationApi.release({
        allocationId: selectedAssignment?.allocationId ?? selectedAllocation!.id,
        ...(selectedAssignment ? { assignmentId: selectedAssignment.id } : {}),
        quantity: amount,
        reason: releaseReason.trim(),
      });
      toast.success(tx('库存释放成功', 'Inventory release recorded'));
      setSelectedAllocationId('');
      setSelectedAssignmentId('');
      setActionQuantity('1');
      setReleaseReason('');
    });
  };

  const loadReview = useCallback(async () => {
    if (!canReadQuality || !selectedAssignment || !Number.isSafeInteger(positiveInteger(reviewQuantity))) return;
    const amount = positiveInteger(reviewQuantity);
    if (amount > assignmentActive(selectedAssignment)) return;
    setReviewLoading(true);
    setReviewError('');
    setReviewContext(null);
    try {
      const context = await inventoryAllocationApi.getQualityReview(selectedAssignment.id, amount);
      setReviewContext(context);
      setVerifiedSerialNumber(context.snapshot.inventory.serialNumber ?? '');
      setVerifiedBatchNumber(context.snapshot.inventory.batchNumber ?? '');
      setChecks(emptyChecks);
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : tx('质量复核数据加载失败', 'Failed to load quality review context'));
    } finally {
      setReviewLoading(false);
    }
  }, [canReadQuality, selectedAssignment, reviewQuantity, tx]);

  useEffect(() => {
    if (!selectedAssignmentId) {
      setReviewContext(null);
      setReviewError('');
      return;
    }
    void loadReview();
  }, [loadReview, selectedAssignmentId]);

  const reviewApproved = Boolean(
    reviewContext?.review?.approved
      && !reviewContext.review.consumedAt
      && reviewContext.review.snapshotHash === reviewContext.snapshotHash
      && reviewContext.review.quantity === positiveInteger(reviewQuantity),
  );

  const handleUploadEvidence = async (files: FileList | null) => {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;
    setBusy('evidence');
    setError('');
    try {
      for (const file of selected) {
        const uploaded = await qualityReviewApi.uploadEvidence(file);
        setReviewEvidence((previous) => [...previous, uploaded]);
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : tx('证据上传失败', 'Evidence upload failed');
      setError(message);
      toast.error(message);
    } finally {
      setBusy('');
    }
  };

  const handleCreateReview = async () => {
    if (!reviewContext || !selectedAssignment || !canApproveQuality) return;
    const amount = positiveInteger(reviewQuantity);
    if (amount <= 0 || reviewReason.trim().length < 3 || Object.values(checks).some((checked) => !checked)) return;
    await runAction('review', async () => {
      await inventoryAllocationApi.createQualityReview({
        assignmentId: selectedAssignment.id,
        quantity: amount,
        snapshotHash: reviewContext.snapshotHash,
        approved: true,
        evidenceIds: reviewEvidence.map((file) => file.id),
        verifiedSerialNumber,
        verifiedBatchNumber,
        checks,
        reason: reviewReason.trim(),
      });
      toast.success(tx('质量复核已记录', 'Quality review recorded'));
      setReviewEvidence([]);
      setReviewReason('');
      await loadReview();
    });
  };

  const handleConsume = async () => {
    if (!reviewApproved || !selectedAssignment || !reviewContext || !canManage) return;
    const amount = positiveInteger(reviewQuantity);
    await runAction('consume', async () => {
      await inventoryAllocationApi.consume({ assignmentId: selectedAssignment.id, quantity: amount, reviewId: reviewContext.review!.id, notes: consumeNotes.trim() || undefined });
      toast.success(tx('出库成功', 'Outbound completed'));
      setSelectedAssignmentId('');
      setReviewContext(null);
      setConsumeNotes('');
    });
  };

  const canReserve = canManage && Boolean(selectedDetail) && selectedDetailReserveLimit > 0 && positiveInteger(reserveQuantity) > 0 && positiveInteger(reserveQuantity) <= selectedDetailReserveLimit;
  const selectedReleaseMax = selectedAssignment ? assignmentActive(selectedAssignment) : selectedAllocation ? selectedAllocation.unassignedQuantity : 0;
  const canRelease = canManage && selectedReleaseMax > 0 && positiveInteger(actionQuantity) > 0 && positiveInteger(actionQuantity) <= selectedReleaseMax && releaseReason.trim().length > 0;
  const canAssign = canManage && isOrder && Boolean(selectedAllocation) && selectedAllocationAssignLimit > 0 && positiveInteger(actionQuantity) > 0 && positiveInteger(actionQuantity) <= selectedAllocationAssignLimit;
  const labels = {
    identity: tx('已核对件号、状态及序号/批次', 'Physical identity, condition and serial/batch checked'),
    documents: tx('已核对交付文件与实物一致', 'Delivery documents match the physical item'),
    conditionAndLife: tx('已核对寿命、货架期及保存条件', 'Life, shelf life and storage checked'),
    customerRequirements: tx('已满足客户质量要求', 'Customer quality requirements met'),
  };

  return (
    <section className={cn('space-y-4 rounded-lg border border-blue-100 bg-blue-50/30 p-4', className)} aria-label={tx('现代行库存分配', 'Modern line inventory allocation')}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-2 font-medium"><Package className="h-4 w-4 text-blue-600" />{tx('行级库存分配', 'Line inventory allocation')}</h4>
          <p className="text-xs text-gray-500">{tx('仅现代多行报价/订单可用；库存明细和批次必须由操作员明确选择。', 'Available for modern line quotations/orders; an operator must explicitly select each inventory detail and batch.')}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setReload((value) => value + 1)} disabled={loading || Boolean(busy)} aria-label={tx('刷新分配', 'Refresh allocation')}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {error && <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {loading ? <div className="flex items-center gap-2 py-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />{tx('加载分配数据...', 'Loading allocation data...')}</div> : (
        <>
          <div className={cn('grid grid-cols-2 gap-2 text-sm', isOrder ? 'sm:grid-cols-5' : 'sm:grid-cols-4')}>
            <div className="rounded border bg-white p-2"><span className="block text-xs text-gray-500">{tx('需求', 'Demand')}</span><strong>{demand} EA</strong></div>
            <div className="rounded border bg-white p-2"><span className="block text-xs text-gray-500">{tx('未分配', 'Unassigned')}</span><strong>{unassigned} EA</strong></div>
            <div className="rounded border bg-white p-2"><span className="block text-xs text-gray-500">{tx('已分配', 'Assigned')}</span><strong>{assigned} EA</strong></div>
            <div className="rounded border bg-white p-2"><span className="block text-xs text-gray-500">{tx('本地已出库', 'Local outbound')}</span><strong>{outbound} EA</strong></div>
            {isOrder && <div className="rounded border bg-white p-2"><span className="block text-xs text-gray-500">{tx('供应商直发', 'Direct shipped')}</span><strong>{directShipped} EA</strong></div>}
          </div>

          {canManage && (
            <div className="space-y-3 rounded border bg-white p-3">
              <p className="text-sm font-medium">{isOrder ? tx('预留到本订单行', 'Reserve to this order line') : tx('预留报价行库存', 'Reserve inventory for this quotation line')}</p>
              {detailsError && <p role="alert" className="text-xs text-red-600">{detailsError}</p>}
              <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
                <div className="space-y-1">
                  <Label>{tx('明确选择库存明细/批次', 'Select inventory detail/batch explicitly')}</Label>
                  {detailsLoading ? <div className="rounded border px-3 py-2 text-sm text-gray-500"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />{tx('加载库存...', 'Loading inventory...')}</div> : (
                    <Select value={selectedDetailId} onValueChange={setSelectedDetailId}>
                      <SelectTrigger><SelectValue placeholder={tx('请选择库存明细', 'Select an inventory detail')} /></SelectTrigger>
                      <SelectContent>
                        {availableDetails.map((detail) => {
                          const available = Math.max(0, detail.quantity - (detail.allocatedQuantity ?? 0));
                          return <SelectItem key={detail.id} value={detail.id}>{detailLabel(detail, available)}</SelectItem>;
                        })}
                      </SelectContent>
                    </Select>
                  )}
                  {!detailsLoading && availableDetails.length === 0 && <p className="text-xs text-amber-700">{detailsError || tx('没有可用库存明细，请先刷新或补充库存。', 'No available inventory detail. Refresh or add stock first.')}</p>}
                </div>
                <div className="space-y-1"><Label>{tx('数量', 'Quantity')}</Label><Input type="number" min={1} max={selectedDetailReserveLimit || undefined} step={1} value={reserveQuantity} onChange={(event) => setReserveQuantity(event.target.value)} /></div>
                <Button onClick={() => void handleReserve()} disabled={!canReserve || Boolean(busy)}>{busy === 'reserve' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('预留', 'Reserve')}</Button>
              </div>
            </div>
          )}

          {allocationViews.length > 0 && <div className="space-y-2">
            <p className="text-sm font-medium">{tx('父分配与批次', 'Parent allocations and batches')}</p>
            <div className="space-y-2">
              {allocationViews.map((allocation) => {
                const detail = allocationDetail(allocation);
                const active = allocationActive(allocation);
                const unassignedActive = Math.max(0, allocation.unassignedQuantity);
                return <div key={allocation.id} className="rounded border bg-white p-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div><span className="font-mono">{detail?.batchNumber ? `BN ${detail.batchNumber}` : detail?.serialNumber ? `SN ${detail.serialNumber}` : tx('未提供批次', 'Batch not provided')}</span><span className="ml-2 text-gray-500">{detail?.location || allocation.inventoryDetailId}</span></div>
                    <Badge variant="outline">{tx('活动', 'Active')} {active} EA</Badge>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">{tx('预留', 'Reserved')} {allocation.allocatedQuantity} · {tx('未分配', 'Unassigned')} {unassignedActive} · {tx('已分配', 'Assigned')} {allocation.assignedActiveQuantity} · {tx('已出库', 'Outbound')} {allocation.consumedQuantity}</div>
                  {isOrder && unassignedActive > 0 && canManage && <label className="mt-2 flex items-center gap-2 text-xs"><input type="radio" name={`allocation-${orderLineId}`} checked={selectedAllocationId === allocation.id} onChange={() => { setSelectedAllocationId(allocation.id); setSelectedAssignmentId(''); setActionQuantity(String(Math.min(unassignedActive, 1))); }} />{tx('选择此父分配进行订单分配', 'Select this parent allocation for order assignment')}</label>}
                  {!isOrder && unassignedActive > 0 && canManage && <label className="mt-2 flex items-center gap-2 text-xs"><input type="radio" name={`release-${quotationLineId}`} checked={selectedAllocationId === allocation.id} onChange={() => { setSelectedAllocationId(allocation.id); setActionQuantity(String(Math.min(unassignedActive, 1))); }} />{tx('选择此未分配库存以释放', 'Select this unassigned parent to release')}</label>}
                </div>;
              })}
            </div>
          </div>}

          {!isOrder && canManage && selectedAllocation && selectedAllocation.unassignedQuantity > 0 && <div className="grid gap-2 rounded border bg-white p-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
            <div className="space-y-1"><Label>{tx('释放数量', 'Release qty')}</Label><Input type="number" min={1} max={selectedAllocation.unassignedQuantity} step={1} value={actionQuantity} onChange={(event) => setActionQuantity(event.target.value)} /></div>
            <div className="space-y-1"><Label>{tx('释放原因', 'Release reason')}</Label><Input value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)} placeholder={tx('必填', 'Required')} /></div>
            <Button variant="outline" onClick={() => void handleRelease()} disabled={!canRelease || Boolean(busy)}>{busy === 'release' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('释放未分配库存', 'Release unassigned')}</Button>
          </div>}

          {isOrder && (
            <div className="space-y-3 rounded border bg-white p-3">
              <p className="text-sm font-medium">{tx('订单分配、释放与出库', 'Order assignment, release and outbound')}</p>
              {canManage && selectedAllocation && selectedAllocation.unassignedQuantity > 0 && <div className="flex flex-wrap items-end gap-2 rounded bg-blue-50 p-2 text-sm">
                <div><p className="text-xs text-gray-500">{tx('选择父分配', 'Selected parent')}</p><p className="font-mono text-xs">{selectedAllocation.id}</p></div>
                <Label className="w-28">{tx('分配数量', 'Assign qty')}<Input type="number" min={1} max={selectedAllocationAssignLimit || undefined} step={1} value={actionQuantity} onChange={(event) => setActionQuantity(event.target.value)} /></Label>
                <Button size="sm" onClick={() => void handleAssign()} disabled={!canAssign || Boolean(busy)}>{busy === 'assign' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('分配到订单行', 'Assign to order')}</Button>
              </div>}
              {orderAssignments.length === 0 ? <p className="text-xs text-gray-500">{tx('本订单行尚无子分配。', 'No child assignment exists for this order line.')}</p> : orderAssignments.map((assignment) => {
                const detail = details.find((item) => item.id === assignment.inventoryDetailId);
                const active = assignmentActive(assignment);
                return <div key={assignment.id} className="rounded border p-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2"><label className="flex items-center gap-2"><input type="radio" name={`assignment-${orderLineId}`} checked={selectedAssignmentId === assignment.id} onChange={() => { setSelectedAssignmentId(assignment.id); setSelectedAllocationId(''); setActionQuantity(String(Math.min(active || 1, 1))); setReviewQuantity(String(Math.min(active || 1, 1))); }} /><span className="font-mono">{detail?.batchNumber ? `BN ${detail.batchNumber}` : detail?.serialNumber ? `SN ${detail.serialNumber}` : assignment.inventoryDetailId}</span></label><Badge variant="outline">{tx('活动', 'Active')} {active} EA</Badge></div>
                  <p className="mt-1 text-xs text-gray-500">{tx('已分配', 'Assigned')} {assignment.assignedQuantity} · {tx('已释放', 'Released')} {assignment.releasedQuantity} · {tx('已出库', 'Outbound')} {assignment.consumedQuantity}</p>
                </div>;
              })}
              {canManage && selectedAssignment && assignmentActive(selectedAssignment) > 0 && <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
                <div className="space-y-1"><Label>{tx('数量', 'Quantity')}</Label><Input type="number" min={1} max={selectedReleaseMax} step={1} value={actionQuantity} onChange={(event) => setActionQuantity(event.target.value)} /></div>
                <div className="space-y-1"><Label>{tx('释放原因', 'Release reason')}</Label><Input value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)} placeholder={tx('必填', 'Required')} /></div>
                <Button variant="outline" onClick={() => void handleRelease()} disabled={!canRelease || Boolean(busy)}>{busy === 'release' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('释放', 'Release')}</Button>
              </div>}

              {canReadQuality && selectedAssignment && assignmentActive(selectedAssignment) > 0 && <div className="space-y-3 rounded border border-green-200 bg-green-50/50 p-3">
                <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-green-700" /><p className="text-sm font-medium">{tx('质量复核与出库', 'Quality review and outbound')}</p></div>
                <div className="grid gap-2 sm:grid-cols-[8rem_1fr] sm:items-end"><div className="space-y-1"><Label>{tx('本次数量', 'Planned qty')}</Label><Input type="number" min={1} max={assignmentActive(selectedAssignment)} step={1} value={reviewQuantity} onChange={(event) => setReviewQuantity(event.target.value)} /></div><div className="text-xs text-gray-600">{reviewLoading ? <span><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />{tx('加载复核快照...', 'Loading review snapshot...')}</span> : reviewContext ? tx(`快照：${reviewContext.snapshotHash.slice(0, 12)}…`, `Snapshot: ${reviewContext.snapshotHash.slice(0, 12)}…`) : tx('选择数量后加载复核快照。', 'Choose a quantity to load the review snapshot.')}</div></div>
                {reviewError && <p role="alert" className="text-xs text-red-700">{reviewError}</p>}
                {reviewContext && <div className="space-y-2 text-xs text-gray-700"><p>{reviewContext.snapshot.inventory.partNumber} · {reviewContext.snapshot.inventory.conditionCode} · {tx('序号', 'Serial')}: {reviewContext.snapshot.inventory.serialNumber || '—'} · {tx('批次', 'Batch')}: {reviewContext.snapshot.inventory.batchNumber || '—'}</p><p>{tx('证书', 'Certificate')}: {reviewContext.snapshot.inventory.certificateType || '—'} · {tx('需求状态', 'Required condition')}: {reviewContext.snapshot.rfqLine.conditionCode}</p></div>}
                {reviewContext && !reviewApproved && canApproveQuality && <>
                  <div className="grid gap-2 sm:grid-cols-2"><Label>{tx('核对序号', 'Verified serial')}<Input value={verifiedSerialNumber} onChange={(event) => setVerifiedSerialNumber(event.target.value)} /></Label><Label>{tx('核对批次', 'Verified batch')}<Input value={verifiedBatchNumber} onChange={(event) => setVerifiedBatchNumber(event.target.value)} /></Label></div>
                  <div className="grid gap-1 text-xs">{(Object.keys(labels) as Array<keyof Checks>).map((key) => <label key={key} className="flex items-start gap-2"><input type="checkbox" checked={checks[key]} onChange={(event) => setChecks((previous) => ({ ...previous, [key]: event.target.checked }))} />{labels[key]}</label>)}</div>
                  <Label>{tx('审核依据', 'Review basis')}<Textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder={tx('填写本次实物和文件核对依据', 'Record the physical and document checks')} /></Label>
                  <Label className="flex items-center gap-2 text-xs"><Upload className="h-3 w-3" />{tx('上传交付证据（如客户要求证书/检验，必须上传）', 'Upload delivery evidence when a certificate/inspection is required')}<Input type="file" multiple className="h-8" onChange={(event) => { void handleUploadEvidence(event.target.files); event.target.value = ''; }} disabled={Boolean(busy)} /></Label>
                  {reviewEvidence.length > 0 && <p className="text-xs text-gray-600">{reviewEvidence.map((file) => file.originalName).join(', ')}</p>}
                  <Button size="sm" onClick={() => void handleCreateReview()} disabled={Boolean(busy) || !reviewContext || reviewReason.trim().length < 3 || Object.values(checks).some((checked) => !checked)}>{busy === 'review' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('提交质量复核', 'Submit quality review')}</Button>
                </>}
                {reviewApproved && canManage && <div className="space-y-2"><p className="text-xs text-green-700">{tx('已有同数量、同快照的有效质量复核。', 'A valid review exists for this quantity and snapshot.')}</p><Label>{tx('出库备注', 'Outbound notes')}<Input value={consumeNotes} onChange={(event) => setConsumeNotes(event.target.value)} /></Label><Button size="sm" onClick={() => void handleConsume()} disabled={Boolean(busy)}>{busy === 'consume' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('确认出库', 'Confirm outbound')}</Button></div>}
                {!canApproveQuality && !reviewApproved && <p className="text-xs text-amber-700">{tx('当前用户没有质量审核批准权限。', 'The current user cannot approve quality reviews.')}</p>}
              </div>}
            </div>
          )}

          {isOrder && canManage && selectedAllocation && !selectedAssignment && selectedAllocation.unassignedQuantity > 0 && <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto] sm:items-end"><div className="space-y-1"><Label>{tx('释放数量', 'Release qty')}</Label><Input type="number" min={1} max={selectedReleaseMax} step={1} value={actionQuantity} onChange={(event) => setActionQuantity(event.target.value)} /></div><div className="space-y-1"><Label>{tx('释放原因', 'Release reason')}</Label><Input value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)} placeholder={tx('必填', 'Required')} /></div><Button variant="outline" onClick={() => void handleRelease()} disabled={!canRelease || Boolean(busy)}>{busy === 'release' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tx('释放未分配库存', 'Release unassigned')}</Button></div>}
        </>
      )}
    </section>
  );
}

export default InventoryAllocationPanel;
