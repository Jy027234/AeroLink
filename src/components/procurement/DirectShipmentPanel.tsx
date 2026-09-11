import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2, PackageCheck, RefreshCw, ShieldCheck, Truck, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { directShipmentApi, type DirectShipment, type PurchaseCommitment, type ReceiptPhysical } from '@/features/orders';
import { useCapabilityStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EvidenceDownload, EvidenceUpload, emptyPhysical, PhysicalFields, type EvidenceFile, useCommandRunner } from '@/components/procurement/Shared';

type DirectShipmentList = NonNullable<Awaited<ReturnType<typeof directShipmentApi.list>>>;
type ReviewContext = NonNullable<Awaited<ReturnType<typeof directShipmentApi.context>>>;
type PurchaseLine = PurchaseCommitment['lines'][number];
type DirectLine = DirectShipment['lines'][number];
type ReviewDecision = 'APPROVED' | 'REJECTED';

type Checks = {
  identity: boolean;
  documents: boolean;
  conditionAndLife: boolean;
  customerRequirements: boolean;
};

type ReviewForm = {
  checks: Checks;
  reason: string;
  evidence: EvidenceFile[];
};

type ReceiptForm = {
  quantity: string;
  signedBy: string;
  signedAt: string;
  reason: string;
  evidence: EvidenceFile[];
};

type PhysicalRow = {
  id: string;
  value: ReceiptPhysical;
};

const emptyChecks: Checks = {
  identity: false,
  documents: false,
  conditionAndLife: false,
  customerRequirements: false,
};

function freshChecks(): Checks {
  return { ...emptyChecks };
}

function freshReviewForm(): ReviewForm {
  return { checks: freshChecks(), reason: '', evidence: [] };
}

function remainingPurchaseQuantity(line: PurchaseLine, preparedQuantity = 0) {
  return Math.max(0, line.quantity - line.cancelledQuantity - line.directShippedQuantity - preparedQuantity);
}

function remainingReceiptQuantity(line: DirectLine) {
  return Math.max(0, line.quantity - line.receivedQuantity);
}

function positiveInteger(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function formatQuantity(quantity: number, uom: string) {
  return `${quantity.toLocaleString()} ${uom || 'EA'}`;
}

function displayDate(value: string | null | undefined, locale: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
}

function commandSignature(name: string, target: string, body: unknown) {
  return `${name}:${target}:${JSON.stringify(body)}`;
}

function statusLabel(value: string, locale: string) {
  if (locale !== 'zh-CN') return value;
  const labels: Record<string, string> = {
    CONFIRMED: '已确认',
    PREPARED: '待发运',
    DISPATCHED: '已发运',
    PARTIALLY_RECEIVED: '部分签收',
    DELIVERED: '已签收',
    CANCELLED: '已取消',
    PENDING_REVIEW: '待质检审核',
    APPROVED: '已通过',
    REJECTED: '已拒绝',
  };
  return labels[value] || value;
}

function errorText(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function getMapValue<T>(map: Record<string, T>, key: string, create: () => T) {
  return map[key] ?? create();
}

function QualityFact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded border bg-background px-2 py-1.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="break-words text-sm font-medium">{value || '—'}</dd>
  </div>;
}

function booleanFact(value: boolean | undefined, tx: (zh: string, en: string) => string) {
  if (value === undefined) return '—';
  return value ? tx('是', 'Yes') : tx('否', 'No');
}

function optionalFact(value: string | number | null | undefined) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function DirectShipmentQualityFacts({
  quality,
  evidence,
  locale,
  tx,
}: {
  quality: ReviewContext['snapshot']['quality'];
  evidence: ReviewContext['snapshot']['evidence'];
  locale: string;
  tx: (zh: string, en: string) => string;
}) {
  const physical = quality.physical;
  const requirement = quality.chain.rfqLine;
  return <div className="space-y-3 rounded border bg-background p-3" data-testid="direct-quality-facts">
    <div>
      <p className="font-medium">{tx('实际质量事实', 'Physical quality facts')}</p>
      <p className="text-xs text-muted-foreground">{tx('审核前请核对实物、寿命、期限和证书当前状态。', 'Verify the physical item, life limits, dates, and current certificate status before review.')}</p>
    </div>
    <dl className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <QualityFact label={tx('件号', 'Part number')} value={optionalFact(physical.partNumber)} />
      <QualityFact label={tx('单位', 'UOM')} value={optionalFact(physical.uom)} />
      <QualityFact label={tx('跟踪方式', 'Tracking type')} value={optionalFact(physical.trackingType)} />
      <QualityFact label={tx('数量', 'Quantity')} value={formatQuantity(physical.quantity, physical.uom)} />
      <QualityFact label={physical.trackingType === 'SERIAL' ? tx('序号', 'Serial number') : tx('批次', 'Batch number')} value={optionalFact(physical.trackingType === 'SERIAL' ? physical.serialNumber : physical.batchNumber)} />
      <QualityFact label={tx('状态代码', 'Condition code')} value={optionalFact(physical.conditionCode)} />
      <QualityFact label={tx('寿命限制', 'Life limited')} value={booleanFact(physical.lifeLimited, tx)} />
      <QualityFact label={tx('剩余小时', 'Remaining hours')} value={optionalFact(physical.remainingHours)} />
      <QualityFact label={tx('剩余循环', 'Remaining cycles')} value={optionalFact(physical.remainingCycles)} />
      <QualityFact label={tx('货架期截止', 'Shelf life date')} value={displayDate(physical.shelfLifeDate, locale)} />
      <QualityFact label={tx('货架期天数', 'Shelf life days')} value={optionalFact(physical.shelfLifeDays)} />
      <QualityFact label={tx('下次检修截止', 'Next overhaul due')} value={displayDate(physical.nextOverhaulDue, locale)} />
      <QualityFact label={tx('保存条件', 'Storage condition')} value={optionalFact(physical.storageCondition)} />
      <QualityFact label={tx('实物证书类型', 'Physical certificate type')} value={optionalFact(physical.certificateType)} />
      <QualityFact label={tx('实物证书编号', 'Physical certificate number')} value={optionalFact(physical.certificateNumber)} />
    </dl>

    <div className="space-y-2">
      <p className="font-medium">{tx('客户/需求质量要求', 'Customer quality requirements')}</p>
      <dl className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <QualityFact label={tx('要求件号', 'Required part number')} value={optionalFact(requirement.partNumber)} />
        <QualityFact label={tx('要求状态代码', 'Required condition code')} value={optionalFact(requirement.conditionCode)} />
        <QualityFact label={tx('要求跟踪序号', 'Required serial number')} value={optionalFact(requirement.serialNumber)} />
        <QualityFact label={tx('要求跟踪批次', 'Required batch number')} value={optionalFact(requirement.batchNumber)} />
        <QualityFact label={tx('要求证书', 'Certificate required')} value={booleanFact(requirement.certificateRequired, tx)} />
        <QualityFact label={tx('要求证书类型', 'Required certificate type')} value={optionalFact(requirement.certificateType)} />
        <QualityFact label={tx('允许替代件号', 'Allowed alternate part numbers')} value={optionalFact(requirement.alternatePartNumbers)} />
      </dl>
    </div>

    <div className="space-y-2">
      <p className="font-medium">{tx('供应商证书当前事实', 'Current supplier certificate facts')}</p>
      {quality.certificates.length === 0 ? <p className="text-sm text-muted-foreground">{tx('当前没有可核验的证书记录。', 'No verifiable certificate records are available.')}</p> : <div className="space-y-2">
        {quality.certificates.map(certificate => <div key={certificate.id} className="min-w-0 rounded border px-2 py-2">
          <dl className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <QualityFact label={tx('证书编号', 'Certificate number')} value={optionalFact(certificate.certificateNumber)} />
            <QualityFact label={tx('证书类型', 'Certificate type')} value={optionalFact(certificate.certificateType)} />
            <QualityFact label={tx('证书状态', 'Certificate status')} value={optionalFact(certificate.status)} />
            <QualityFact label={tx('证书件号', 'Certificate part number')} value={optionalFact(certificate.partNumber)} />
            <QualityFact label={tx('证书序号', 'Certificate serial number')} value={optionalFact(certificate.serialNumber)} />
            <QualityFact label={tx('证书批次', 'Certificate batch number')} value={optionalFact(certificate.batchNumber)} />
            <QualityFact label={tx('证书有效期', 'Certificate expiry')} value={displayDate(certificate.expiryDate, locale)} />
          </dl>
        </div>)}
      </div>}
    </div>

    <div className="space-y-2">
      <p className="font-medium">{tx('运单证据', 'Shipment evidence')}</p>
      {evidence.length === 0 ? <p className="text-sm text-muted-foreground">{tx('当前没有可下载的运单证据。', 'No downloadable shipment evidence is available.')}</p> : <ul className="space-y-2">
        {evidence.map((file, index) => <li key={`${file.id}:${file.version}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded border px-2 py-2 text-sm">
          <span>{tx(`运单附件 ${index + 1}`, `Shipment evidence ${index + 1}`)}</span>
          <EvidenceDownload id={file.id} label={tx('下载运单证据', 'Download shipment evidence')} />
        </li>)}
      </ul>}
    </div>
  </div>;
}

export interface DirectShipmentPanelProps {
  orderId: string;
  purchases: PurchaseCommitment[];
  onChanged?: () => void | Promise<unknown>;
  className?: string;
}

export function DirectShipmentPanel({ orderId, purchases, onChanged, className }: DirectShipmentPanelProps) {
  const { locale } = useTranslation();
  const can = useCapabilityStore(state => state.can);
  const { busy, run } = useCommandRunner();
  const tx = useCallback((zh: string, en: string) => (locale === 'zh-CN' ? zh : en), [locale]);

  const canRead = can('inventory.read');
  const canManage = can('inventory.manage');
  const canReview = can('quality_review.approve');

  const [shipments, setShipments] = useState<DirectShipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);
  const physicalRowSequence = useRef(0);
  const [uploadBusy, setUploadBusy] = useState(false);

  const [selectedPurchaseId, setSelectedPurchaseId] = useState('');
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);
  const [physicalRowsByLine, setPhysicalRowsByLine] = useState<Record<string, PhysicalRow[]>>({});
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [createReason, setCreateReason] = useState('');
  const [createEvidence, setCreateEvidence] = useState<EvidenceFile[]>([]);

  const [contexts, setContexts] = useState<Record<string, ReviewContext>>({});
  const [contextLoading, setContextLoading] = useState<Record<string, boolean>>({});
  const [reviewForms, setReviewForms] = useState<Record<string, ReviewForm>>({});
  const [headReasons, setHeadReasons] = useState<Record<string, string>>({});
  const [receiptForms, setReceiptForms] = useState<Record<string, ReceiptForm>>({});

  const reloadShipments = useCallback(async () => {
    const requestId = ++requestVersion.current;
    if (!orderId || !canRead) {
      setShipments([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result: DirectShipmentList | undefined = await directShipmentApi.list(orderId);
      if (requestId !== requestVersion.current) return;
      setShipments(result?.shipments ?? []);
      setError('');
    } catch (cause) {
      if (requestId !== requestVersion.current) return;
      setShipments([]);
      setError(errorText(cause, tx('直发数据加载失败', 'Failed to load direct shipments')));
    } finally {
      if (requestId === requestVersion.current) setLoading(false);
    }
  }, [canRead, orderId, tx]);

  useEffect(() => {
    // A panel can stay mounted while the order drawer changes. Clear all
    // command forms first so a previous order's line IDs cannot be submitted.
    requestVersion.current += 1;
    setShipments([]);
    setSelectedPurchaseId('');
    setSelectedLineIds([]);
    setPhysicalRowsByLine({});
    setCarrier('');
    setTrackingNumber('');
    setOrigin('');
    setDestination('');
    setCreateReason('');
    setCreateEvidence([]);
    setContexts({});
    setContextLoading({});
    setReviewForms({});
    setHeadReasons({});
    setReceiptForms({});
    setError('');
  }, [orderId]);

  useEffect(() => {
    void reloadShipments();
  }, [reload, reloadShipments]);

  const preparedQuantityByLine = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const shipment of shipments) {
      if (shipment.status !== 'PREPARED') continue;
      for (const line of shipment.lines) {
        if (line.reviewStatus === 'REJECTED') continue;
        totals[line.purchaseCommitmentLineId] = (totals[line.purchaseCommitmentLineId] ?? 0) + line.quantity;
      }
    }
    return totals;
  }, [shipments]);

  const eligiblePurchases = useMemo(
    () => purchases.filter(purchase => purchase.status === 'CONFIRMED'
      && purchase.lines.some(line => line.fulfillmentMode === 'SUPPLIER_DIRECT'
        && remainingPurchaseQuantity(line, preparedQuantityByLine[line.id] ?? 0) > 0)),
    [preparedQuantityByLine, purchases],
  );

  const selectedPurchase = eligiblePurchases.find(purchase => purchase.id === selectedPurchaseId);
  const eligibleLines = useMemo(
    () => selectedPurchase?.lines.filter(line => line.fulfillmentMode === 'SUPPLIER_DIRECT'
      && remainingPurchaseQuantity(line, preparedQuantityByLine[line.id] ?? 0) > 0) ?? [],
    [preparedQuantityByLine, selectedPurchase],
  );
  const selectedLines = eligibleLines.filter(line => selectedLineIds.includes(line.id));

  useEffect(() => {
    if (selectedPurchaseId && !eligiblePurchases.some(purchase => purchase.id === selectedPurchaseId)) {
      setSelectedPurchaseId('');
      setSelectedLineIds([]);
      setPhysicalRowsByLine({});
    }
  }, [eligiblePurchases, selectedPurchaseId]);

  const runCommand = useCallback(async (signature: string, operation: (key: string) => Promise<unknown>) => {
    setError('');
    try {
      await run(signature, operation);
      setReload(value => value + 1);
      await onChanged?.();
      return true;
    } catch (cause) {
      const message = errorText(cause, tx('操作失败', 'Operation failed'));
      setError(message);
      toast.error(message);
      return false;
    }
  }, [onChanged, run, tx]);

  const newPhysicalRow = useCallback((line: PurchaseLine): PhysicalRow => {
    physicalRowSequence.current += 1;
    return { id: `${line.id}:physical:${physicalRowSequence.current}`, value: emptyPhysical(line.partNumber, line.uom) };
  }, []);

  const rowsForLine = (line: PurchaseLine) => physicalRowsByLine[line.id] ?? [];

  const updatePhysical = useCallback((line: PurchaseLine, rowId: string, value: ReceiptPhysical) => {
    setPhysicalRowsByLine(previous => ({
      ...previous,
      [line.id]: (previous[line.id] ?? [newPhysicalRow(line)]).map(row => row.id === rowId ? { ...row, value } : row),
    }));
  }, [newPhysicalRow]);

  const addPhysicalRow = (line: PurchaseLine) => {
    setPhysicalRowsByLine(previous => ({ ...previous, [line.id]: [...(previous[line.id] ?? [newPhysicalRow(line)]), newPhysicalRow(line)] }));
  };

  const removePhysicalRow = (line: PurchaseLine, rowId: string) => {
    setPhysicalRowsByLine(previous => {
      const rows = previous[line.id] ?? [];
      if (rows.length <= 1) return previous;
      return { ...previous, [line.id]: rows.filter(row => row.id !== rowId) };
    });
  };

  const toggleLine = (line: PurchaseLine) => {
    const selected = selectedLineIds.includes(line.id);
    setSelectedLineIds(previous => selected ? previous.filter(id => id !== line.id) : [...previous, line.id]);
    if (!selected) {
      setPhysicalRowsByLine(previous => previous[line.id] ? previous : { ...previous, [line.id]: [newPhysicalRow(line)] });
    }
  };

  const handleCreate = async () => {
    if (!selectedPurchase || selectedLines.length === 0) {
      setError(tx('请选择已确认的背靠背采购行', 'Select confirmed back-to-back purchase lines'));
      return;
    }
    const trimmedReason = createReason.trim();
    if (trimmedReason.length < 3 || !carrier.trim() || !trackingNumber.trim() || !origin.trim() || !destination.trim()) {
      setError(tx('请完整填写运单信息和至少 3 个字符的原因', 'Enter complete shipment details and a reason of at least 3 characters'));
      return;
    }
    if (createEvidence.length === 0) {
      setError(tx('请上传至少一份运单证据', 'Upload at least one shipment evidence file'));
      return;
    }
    const lines = [] as Array<{ purchaseCommitmentLineId: string; physical: ReceiptPhysical }>;
    for (const line of selectedLines) {
      const rows = rowsForLine(line);
      const total = rows.reduce((sum, row) => sum + positiveInteger(String(row.value.quantity)), 0);
      const available = remainingPurchaseQuantity(line, preparedQuantityByLine[line.id] ?? 0);
      if (rows.length === 0 || rows.some(row => positiveInteger(String(row.value.quantity)) <= 0) || total > available) {
        setError(tx(`第 ${line.lineNo} 行实际数量超过可直发余量或未填写`, `Line ${line.lineNo} physical quantities exceed the remaining direct-shipment capacity or are empty`));
        return;
      }
      lines.push(...rows.map(row => ({ purchaseCommitmentLineId: line.id, physical: row.value })));
    }
    const body = {
      purchaseCommitmentId: selectedPurchase.id,
      purchaseVersion: selectedPurchase.version,
      carrier: carrier.trim(),
      trackingNumber: trackingNumber.trim(),
      origin: origin.trim(),
      destination: destination.trim(),
      reason: trimmedReason,
      evidenceIds: createEvidence.map(file => file.id),
      lines,
    };
    const succeeded = await runCommand(commandSignature('direct-create', orderId, body), key => directShipmentApi.create(body, key));
    if (!succeeded) return;
    toast.success(tx('直发单已创建', 'Direct shipment created'));
    setSelectedPurchaseId('');
    setSelectedLineIds([]);
    setPhysicalRowsByLine({});
    setCarrier('');
    setTrackingNumber('');
    setOrigin('');
    setDestination('');
    setCreateReason('');
    setCreateEvidence([]);
  };

  const loadReviewContext = async (lineId: string) => {
    setContextLoading(previous => ({ ...previous, [lineId]: true }));
    setError('');
    try {
      const context = await directShipmentApi.context(lineId);
      if (!context) throw new Error(tx('审核上下文为空', 'Review context is empty'));
      setContexts(previous => ({ ...previous, [lineId]: context }));
    } catch (cause) {
      const message = errorText(cause, tx('质量审核上下文加载失败', 'Failed to load quality review context'));
      setError(message);
      toast.error(message);
    } finally {
      setContextLoading(previous => ({ ...previous, [lineId]: false }));
    }
  };

  const updateReviewForm = (lineId: string, update: Partial<ReviewForm>) => {
    setReviewForms(previous => ({
      ...previous,
      [lineId]: { ...getMapValue(previous, lineId, freshReviewForm), ...update },
    }));
  };

  const updateReviewCheck = (lineId: string, key: keyof Checks, value: boolean) => {
    const form = getMapValue(reviewForms, lineId, freshReviewForm);
    updateReviewForm(lineId, { checks: { ...form.checks, [key]: value } });
  };

  const handleReview = async (line: DirectLine, decision: ReviewDecision) => {
    const context = contexts[line.id];
    if (!context) {
      await loadReviewContext(line.id);
      return;
    }
    const form = getMapValue(reviewForms, line.id, freshReviewForm);
    const reason = form.reason.trim();
    if (reason.length < 3) {
      setError(tx('审核原因至少需要 3 个字符', 'Review reason must contain at least 3 characters'));
      return;
    }
    if (decision === 'APPROVED' && Object.values(form.checks).some(value => !value)) {
      setError(tx('通过前必须完成四项质量检查', 'All four quality checks must pass before approval'));
      return;
    }
    const body = {
      version: context.version,
      snapshotHash: context.snapshotHash,
      decision,
      reason,
      checks: form.checks,
      evidenceIds: form.evidence.map(file => file.id),
    };
    const succeeded = await runCommand(commandSignature(`direct-review-${decision.toLowerCase()}`, line.id, body), key => directShipmentApi.review(line.id, body, key));
    if (!succeeded) return;
    toast.success(decision === 'APPROVED' ? tx('质量审核已通过', 'Quality review approved') : tx('质量审核已拒绝', 'Quality review rejected'));
    setContexts(previous => {
      const next = { ...previous };
      delete next[line.id];
      return next;
    });
  };

  const handleHeadAction = async (shipment: DirectShipment, action: 'dispatch' | 'cancel') => {
    const reason = (headReasons[shipment.id] || '').trim();
    if (reason.length < 3) {
      setError(tx('操作原因至少需要 3 个字符', 'Action reason must contain at least 3 characters'));
      return;
    }
    const body = { version: shipment.version, reason };
    const operation = action === 'dispatch' ? directShipmentApi.dispatch : directShipmentApi.cancel;
    const succeeded = await runCommand(commandSignature(`direct-${action}`, shipment.id, body), key => operation(shipment.id, body, key));
    if (!succeeded) return;
    toast.success(action === 'dispatch' ? tx('直发单已发运', 'Direct shipment dispatched') : tx('直发单已取消', 'Direct shipment cancelled'));
    setHeadReasons(previous => ({ ...previous, [shipment.id]: '' }));
  };

  const receiptDefault = (line: DirectLine): ReceiptForm => ({
    quantity: String(Math.max(1, remainingReceiptQuantity(line))),
    signedBy: '',
    signedAt: '',
    reason: '',
    evidence: [],
  });

  const updateReceiptForm = (line: DirectLine, update: Partial<ReceiptForm>) => {
    setReceiptForms(previous => ({
      ...previous,
      [line.id]: { ...receiptDefault(line), ...previous[line.id], ...update },
    }));
  };

  const handleReceive = async (line: DirectLine) => {
    const form = receiptForms[line.id] ?? receiptDefault(line);
    const quantity = positiveInteger(form.quantity);
    const signedAt = form.signedAt ? new Date(form.signedAt) : null;
    const reason = form.reason.trim();
    if (quantity <= 0 || quantity > remainingReceiptQuantity(line)) {
      setError(tx('签收数量必须在剩余数量范围内', 'Receipt quantity must be within the remaining quantity'));
      return;
    }
    if (!form.signedBy.trim() || !signedAt || Number.isNaN(signedAt.getTime()) || reason.length < 3 || form.evidence.length === 0) {
      setError(tx('请填写签收人、时间、原因并上传签收证据', 'Enter signer, time, reason, and receipt evidence'));
      return;
    }
    const body = {
      version: line.version,
      quantity,
      signedBy: form.signedBy.trim(),
      signedAt: signedAt.toISOString(),
      reason,
      evidenceIds: form.evidence.map(file => file.id),
    };
    const succeeded = await runCommand(commandSignature('direct-receive', line.id, body), key => directShipmentApi.receive(line.id, body, key));
    if (!succeeded) return;
    toast.success(tx('签收记录已保存', 'Receipt recorded'));
    setReceiptForms(previous => {
      const next = { ...previous };
      delete next[line.id];
      return next;
    });
  };

  if (!canRead) {
    return (
      <Card className={cn('border-dashed', className)}>
        <CardHeader className="px-3 sm:px-6">
          <CardTitle>{tx('供应商直发', 'Supplier direct shipment')}</CardTitle>
          <CardDescription>{tx('需要库存读取权限才能查看直发状态。', 'Inventory read permission is required to view direct shipments.')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className={cn('space-y-5', className)} data-testid="direct-shipment-panel">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 px-3 sm:px-6">
          <div>
            <CardTitle className="flex items-center gap-2"><Truck className="h-5 w-5" />{tx('供应商直发', 'Supplier direct shipment')}</CardTitle>
            <CardDescription>{tx('直发只记录履约、实物和质量证据；商业成本不会显示。', 'Direct shipment shows fulfillment, physical facts, and quality evidence only; commercial costs are hidden.')}</CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setReload(value => value + 1)} disabled={loading || Boolean(busy)}>
            <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />{tx('刷新', 'Refresh')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 px-3 sm:px-6">
          {error && <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {loading && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{tx('正在加载直发记录…', 'Loading direct shipments…')}</div>}
          {!loading && shipments.length === 0 && <p className="text-sm text-muted-foreground">{tx('当前订单还没有供应商直发单。', 'No supplier direct shipments for this order yet.')}</p>}
          {!loading && shipments.length > 0 && <div className="space-y-4">{shipments.map(shipment => (
            <ShipmentCard
              key={shipment.id}
              shipment={shipment}
              locale={locale}
              tx={tx}
              canManage={canManage}
              canReview={canReview}
              busy={Boolean(busy) || uploadBusy}
              headReason={headReasons[shipment.id] || ''}
              onHeadReasonChange={value => setHeadReasons(previous => ({ ...previous, [shipment.id]: value }))}
              onHeadAction={action => { void handleHeadAction(shipment, action); }}
              contexts={contexts}
              contextLoading={contextLoading}
              reviewForms={reviewForms}
              onLoadContext={lineId => { void loadReviewContext(lineId); }}
              onReviewReasonChange={(lineId, value) => updateReviewForm(lineId, { reason: value })}
              onReviewCheckChange={updateReviewCheck}
              onReviewEvidenceChange={(lineId, value) => updateReviewForm(lineId, { evidence: value })}
              onReview={handleReview}
              receiptForms={receiptForms}
              onReceiptChange={updateReceiptForm}
              onReceive={handleReceive}
              onUploadBusyChange={setUploadBusy}
            />
          ))}</div>}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader className="px-3 sm:px-6">
            <CardTitle>{tx('创建直发单', 'Create direct shipment')}</CardTitle>
            <CardDescription>{tx('只可选择已确认的背靠背采购行；每行填写实际批次或序号事实。', 'Choose confirmed back-to-back purchase lines and enter physical batch or serial facts for each line.')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 px-3 sm:px-6">
            {eligiblePurchases.length === 0 && <p className="text-sm text-muted-foreground">{tx('没有可直发的已确认采购行。', 'No confirmed supplier-direct purchase lines are available.')}</p>}
            {eligiblePurchases.length > 0 && <>
              <Label className="grid gap-2">{tx('选择采购承诺', 'Purchase commitment')}
                <select className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" value={selectedPurchaseId} onChange={event => {
                  setSelectedPurchaseId(event.target.value);
                  setSelectedLineIds([]);
                  setPhysicalRowsByLine({});
                }} disabled={Boolean(busy) || uploadBusy}>
                  <option value="">{tx('请选择已确认采购承诺', 'Select a confirmed purchase commitment')}</option>
                  {eligiblePurchases.map(purchase => <option key={purchase.id} value={purchase.id}>{purchase.commitmentNumber} · {purchase.supplierName}</option>)}
                </select>
              </Label>
              {selectedPurchase && <div className="space-y-3 rounded border p-3">
                <p className="text-sm font-medium">{tx('选择直发采购行', 'Select direct purchase lines')}</p>
                {eligibleLines.map(line => {
                  const selected = selectedLineIds.includes(line.id);
                  const rows = rowsForLine(line);
                  const planned = preparedQuantityByLine[line.id] ?? 0;
                  const available = remainingPurchaseQuantity(line, planned);
                  const physicalTotal = rows.reduce((sum, row) => sum + positiveInteger(String(row.value.quantity)), 0);
                  return <div key={line.id} className="space-y-3 rounded border p-3">
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-1" checked={selected} onChange={() => toggleLine(line)} disabled={Boolean(busy) || uploadBusy} />
                      <span><strong>{tx(`第 ${line.lineNo} 行`, `Line ${line.lineNo}`)} · {line.partNumber}</strong><br />
                        <span className="text-muted-foreground">{tx('可直发数量', 'Available for direct shipment')}: {formatQuantity(available, line.uom)}</span></span>
                    </label>
                    {selected && <div className="space-y-3">
                      {rows.map((row, index) => <div key={row.id} className="space-y-2 rounded border border-dashed p-2">
                        <div className="flex items-center justify-between gap-2 text-sm font-medium">
                          <span>{tx(`实际批次/序号 ${index + 1}`, `Physical batch/serial ${index + 1}`)}</span>
                          {rows.length > 1 && <Button type="button" size="sm" variant="ghost" onClick={() => removePhysicalRow(line, row.id)} disabled={Boolean(busy) || uploadBusy}>{tx('移除', 'Remove')}</Button>}
                        </div>
                        <PhysicalFields
                          value={row.value}
                          onChange={value => updatePhysical(line, row.id, value)}
                          disabled={Boolean(busy) || uploadBusy}
                          supplierId={selectedPurchase.supplierId}
                        />
                      </div>)}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className={cn('text-xs text-muted-foreground', physicalTotal > available && 'text-red-600')}>
                          {tx('本次实物合计', 'Physical total')}: {formatQuantity(physicalTotal, line.uom)} / {formatQuantity(available, line.uom)}
                        </p>
                        <Button type="button" size="sm" variant="outline" onClick={() => addPhysicalRow(line)} disabled={Boolean(busy) || uploadBusy || physicalTotal >= available}>
                          {tx('添加实际批次/序号', 'Add physical batch/serial')}
                        </Button>
                      </div>
                    </div>}
                  </div>;
                })}
              </div>}
              {selectedPurchase && selectedLines.length > 0 && <div className="grid gap-3 sm:grid-cols-2">
                <Label className="grid gap-2">{tx('承运商', 'Carrier')}<Input value={carrier} onChange={event => setCarrier(event.target.value)} disabled={Boolean(busy) || uploadBusy} /></Label>
                <Label className="grid gap-2">{tx('运单号', 'Tracking number')}<Input value={trackingNumber} onChange={event => setTrackingNumber(event.target.value)} disabled={Boolean(busy) || uploadBusy} /></Label>
                <Label className="grid gap-2">{tx('起运地', 'Origin')}<Input value={origin} onChange={event => setOrigin(event.target.value)} disabled={Boolean(busy) || uploadBusy} /></Label>
                <Label className="grid gap-2">{tx('目的地', 'Destination')}<Input value={destination} onChange={event => setDestination(event.target.value)} disabled={Boolean(busy) || uploadBusy} /></Label>
              </div>}
              {selectedPurchase && selectedLines.length > 0 && <>
                <Label className="grid gap-2">{tx('创建原因', 'Creation reason')}<Textarea value={createReason} onChange={event => setCreateReason(event.target.value)} minLength={3} maxLength={4000} disabled={Boolean(busy) || uploadBusy} /></Label>
                <EvidenceUpload value={createEvidence} onChange={setCreateEvidence} onBusyChange={setUploadBusy} disabled={Boolean(busy)} label={tx('运单证据（至少一份）', 'Shipment evidence (at least one)')} />
                <Button type="button" onClick={() => { void handleCreate(); }} disabled={Boolean(busy) || uploadBusy || !selectedPurchase || selectedLines.length === 0}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />}{tx('创建直发单', 'Create direct shipment')}
                </Button>
              </>}
            </>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ShipmentCard({
  shipment,
  locale,
  tx,
  canManage,
  canReview,
  busy,
  headReason,
  onHeadReasonChange,
  onHeadAction,
  contexts,
  contextLoading,
  reviewForms,
  onLoadContext,
  onReviewReasonChange,
  onReviewCheckChange,
  onReviewEvidenceChange,
  onReview,
  receiptForms,
  onReceiptChange,
  onReceive,
  onUploadBusyChange,
}: {
  shipment: DirectShipment;
  locale: string;
  tx: (zh: string, en: string) => string;
  canManage: boolean;
  canReview: boolean;
  busy: boolean;
  headReason: string;
  onHeadReasonChange: (value: string) => void;
  onHeadAction: (action: 'dispatch' | 'cancel') => void;
  contexts: Record<string, ReviewContext>;
  contextLoading: Record<string, boolean>;
  reviewForms: Record<string, ReviewForm>;
  onLoadContext: (lineId: string) => void;
  onReviewReasonChange: (lineId: string, value: string) => void;
  onReviewCheckChange: (lineId: string, key: keyof Checks, value: boolean) => void;
  onReviewEvidenceChange: (lineId: string, value: EvidenceFile[]) => void;
  onReview: (line: DirectLine, decision: ReviewDecision) => Promise<void>;
  receiptForms: Record<string, ReceiptForm>;
  onReceiptChange: (line: DirectLine, update: Partial<ReceiptForm>) => void;
  onReceive: (line: DirectLine) => Promise<void>;
  onUploadBusyChange: (busy: boolean) => void;
}) {
  const showReceipt = canManage && (shipment.status === 'DISPATCHED' || shipment.status === 'PARTIALLY_RECEIVED');
  return <Card className="border-muted">
    <CardHeader className="gap-3 px-3 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <span>{shipment.shipmentNumber}</span>
            <Badge variant="outline">{statusLabel(shipment.status, locale)}</Badge>
          </CardTitle>
          <CardDescription>{shipment.carrier} · {shipment.trackingNumber} · {shipment.origin} → {shipment.destination}</CardDescription>
          <p className="mt-1 text-xs text-muted-foreground">{tx('创建于', 'Created')} {displayDate(shipment.createdAt, locale)}</p>
        </div>
        {canManage && shipment.status === 'PREPARED' && <div className="flex items-center gap-2">
          {shipment.status === 'PREPARED' && <Button type="button" size="sm" onClick={() => onHeadAction('dispatch')} disabled={busy}>
            <Truck className="mr-1 h-4 w-4" />{tx('发运', 'Dispatch')}
          </Button>}
          {shipment.status === 'PREPARED' && <Button type="button" size="sm" variant="outline" onClick={() => onHeadAction('cancel')} disabled={busy}>
            <XCircle className="mr-1 h-4 w-4" />{tx('取消', 'Cancel')}
          </Button>}
        </div>}
      </div>
      {canManage && shipment.status === 'PREPARED' && <Label className="grid gap-2">{tx('发运/取消原因', 'Dispatch/cancellation reason')}<Textarea value={headReason} onChange={event => onHeadReasonChange(event.target.value)} minLength={3} maxLength={4000} disabled={busy} /></Label>}
    </CardHeader>
    <CardContent className="space-y-4 px-3 sm:px-6">
      {shipment.lines.map(line => <DirectShipmentLineCard
        key={line.id}
        line={line}
        locale={locale}
        tx={tx}
        canReview={canReview}
        canManage={canManage}
        busy={busy}
        showReceipt={showReceipt && remainingReceiptQuantity(line) > 0}
        context={contexts[line.id]}
        contextLoading={Boolean(contextLoading[line.id])}
        reviewForm={reviewForms[line.id] ?? freshReviewForm()}
        onLoadContext={() => onLoadContext(line.id)}
        onReviewReasonChange={value => onReviewReasonChange(line.id, value)}
        onReviewCheckChange={(key, value) => onReviewCheckChange(line.id, key, value)}
        onReviewEvidenceChange={value => onReviewEvidenceChange(line.id, value)}
        onReview={decision => { void onReview(line, decision); }}
        receiptForm={receiptForms[line.id] ?? { quantity: String(Math.max(1, remainingReceiptQuantity(line))), signedBy: '', signedAt: '', reason: '', evidence: [] }}
        onReceiptChange={update => onReceiptChange(line, update)}
        onReceive={() => { void onReceive(line); }}
        onUploadBusyChange={onUploadBusyChange}
      />)}
    </CardContent>
  </Card>;
}

function DirectShipmentLineCard({
  line,
  locale,
  tx,
  canReview,
  canManage,
  busy,
  showReceipt,
  context,
  contextLoading,
  reviewForm,
  onLoadContext,
  onReviewReasonChange,
  onReviewCheckChange,
  onReviewEvidenceChange,
  onReview,
  receiptForm,
  onReceiptChange,
  onReceive,
  onUploadBusyChange,
}: {
  line: DirectLine;
  locale: string;
  tx: (zh: string, en: string) => string;
  canReview: boolean;
  canManage: boolean;
  busy: boolean;
  showReceipt: boolean;
  context?: ReviewContext;
  contextLoading: boolean;
  reviewForm: ReviewForm;
  onLoadContext: () => void;
  onReviewReasonChange: (value: string) => void;
  onReviewCheckChange: (key: keyof Checks, value: boolean) => void;
  onReviewEvidenceChange: (value: EvidenceFile[]) => void;
  onReview: (decision: ReviewDecision) => void;
  receiptForm: ReceiptForm;
  onReceiptChange: (update: Partial<ReceiptForm>) => void;
  onReceive: () => void;
  onUploadBusyChange: (busy: boolean) => void;
}) {
  const quality = line.physicalSnapshot;
  const checks: Array<[keyof Checks, string, string]> = [
    ['identity', '身份一致', 'Identity'],
    ['documents', '证书/文件', 'Documents'],
    ['conditionAndLife', '状态与寿命', 'Condition and life'],
    ['customerRequirements', '客户要求', 'Customer requirements'],
  ];
  return <div className="space-y-3 rounded border p-2 sm:p-3" data-testid={`direct-shipment-line-${line.lineNo}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="font-medium">{tx(`第 ${line.lineNo} 行`, `Line ${line.lineNo}`)} · {quality.partNumber}</p>
        <p className="text-sm text-muted-foreground">
          {formatQuantity(line.quantity, quality.uom)} · {quality.trackingType === 'SERIAL' ? `${tx('序号', 'Serial')}: ${quality.serialNumber || '—'}` : `${tx('批次', 'Batch')}: ${quality.batchNumber || '—'}`}
          {' · '}{tx('已签收', 'Received')}: {formatQuantity(line.receivedQuantity, quality.uom)} · <Badge variant="outline">{statusLabel(line.reviewStatus, locale)}</Badge>
        </p>
      </div>
      {canReview && line.reviewStatus !== 'APPROVED' && <Button type="button" size="sm" variant="outline" onClick={onLoadContext} disabled={busy || contextLoading}>
        {contextLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1 h-4 w-4" />}{context ? tx('刷新审核上下文', 'Refresh review context') : tx('加载质量审核', 'Load quality review')}
      </Button>}
    </div>

    {context && canReview && <div className="space-y-3 rounded bg-muted/40 p-3">
      <p className="font-medium">{tx('质量审核上下文', 'Quality review context')}</p>
      <DirectShipmentQualityFacts quality={context.snapshot.quality} evidence={context.snapshot.evidence} locale={locale} tx={tx} />
      {context.issues.length > 0 ? <ul className="list-disc space-y-1 pl-5 text-sm text-red-700">{context.issues.map(issue => <li key={`${issue.code}:${issue.path}`}>{issue.message}</li>)}</ul> : <p className="text-sm text-green-700">{tx('当前没有质量问题。', 'No current quality issues.')}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {checks.map(([key, zh, en]) => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reviewForm.checks[key]} onChange={event => onReviewCheckChange(key, event.target.checked)} disabled={busy} />{tx(zh, en)}</label>)}
      </div>
      <Label className="grid gap-2">{tx('审核原因', 'Review reason')}<Textarea value={reviewForm.reason} onChange={event => onReviewReasonChange(event.target.value)} minLength={3} maxLength={4000} disabled={busy} /></Label>
      <EvidenceUpload value={reviewForm.evidence} onChange={onReviewEvidenceChange} onBusyChange={onUploadBusyChange} disabled={busy} label={tx('审核证据（可选）', 'Review evidence (optional)')} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => onReview('APPROVED')} disabled={busy || !context.canApprove || context.issues.length > 0}>
          <CheckCircle2 className="mr-1 h-4 w-4" />{tx('通过', 'Approve')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onReview('REJECTED')} disabled={busy}>
          <XCircle className="mr-1 h-4 w-4" />{tx('拒绝', 'Reject')}
        </Button>
      </div>
    </div>}

    {line.reviewReason && <p className="text-sm text-muted-foreground">{tx('审核说明', 'Review note')}: {line.reviewReason}</p>}

    {canManage && (line.reviewStatus === 'APPROVED' || line.reviewStatus === 'REJECTED') && <p className="text-xs text-muted-foreground">{tx('质量结论由独立审核记录；发运时服务端会重新检查当前快照。', 'Quality decisions are independently recorded; dispatch rechecks the current snapshot server-side.')}</p>}

    {showReceipt && <div className="space-y-3 rounded bg-muted/30 p-3">
      <p className="flex items-center gap-2 font-medium"><PackageCheck className="h-4 w-4" />{tx('分次签收', 'Partial receipt')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label className="grid gap-2">{tx('本次数量', 'This receipt quantity')}<Input type="number" min={1} max={remainingReceiptQuantity(line)} step={1} value={receiptForm.quantity} onChange={event => onReceiptChange({ quantity: event.target.value })} disabled={busy} /></Label>
        <Label className="grid gap-2">{tx('签收人', 'Signed by')}<Input value={receiptForm.signedBy} maxLength={200} onChange={event => onReceiptChange({ signedBy: event.target.value })} disabled={busy} /></Label>
        <Label className="grid gap-2">{tx('签收时间', 'Signed at')}<Input type="datetime-local" value={receiptForm.signedAt} onChange={event => onReceiptChange({ signedAt: event.target.value })} disabled={busy} /></Label>
        <Label className="grid gap-2">{tx('签收原因', 'Receipt reason')}<Input value={receiptForm.reason} minLength={3} maxLength={4000} onChange={event => onReceiptChange({ reason: event.target.value })} disabled={busy} /></Label>
      </div>
      <EvidenceUpload value={receiptForm.evidence} onChange={value => onReceiptChange({ evidence: value })} onBusyChange={onUploadBusyChange} disabled={busy} label={tx('签收证明（至少一份）', 'Receipt proof (at least one)')} />
      <Button type="button" size="sm" onClick={onReceive} disabled={busy || receiptForm.evidence.length === 0}>
        <PackageCheck className="mr-1 h-4 w-4" />{tx('保存签收', 'Record receipt')}
      </Button>
    </div>}
  </div>;
}
