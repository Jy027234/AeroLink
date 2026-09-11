import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { stockReceiptApi, type PurchaseCommitment, type ReceiptPhysical, type StockReceipt } from '@/features/orders';
import { useCapabilityStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EvidenceDownload, EvidenceUpload, emptyPhysical, PhysicalFields, useCommandRunner, type EvidenceFile } from '@/components/procurement/Shared';

type ReceiptStorage = StockReceipt['lines'][number]['qualitySnapshot']['storage'];
type ReceiptLine = StockReceipt['lines'][number];
type ReviewContext = NonNullable<Awaited<ReturnType<typeof stockReceiptApi.context>>>;
type ReviewChecks = {
  identity: boolean;
  documents: boolean;
  conditionAndLife: boolean;
  customerRequirements: boolean;
};
type ReviewForm = { checks: ReviewChecks; reason: string };
type ArrivalDraft = {
  key: string;
  purchaseCommitmentLineId: string;
  physical: ReceiptPhysical;
  storage: ReceiptStorage;
};

const emptyChecks: ReviewChecks = {
  identity: false,
  documents: false,
  conditionAndLife: false,
  customerRequirements: false,
};

function newDraftKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `receipt-line-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function positiveInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function displayDate(value: string | null | undefined, locale: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
}

function statusText(status: string, locale: string) {
  if (locale !== 'zh-CN') return status;
  const labels: Record<string, string> = {
    CONFIRMED: '已确认',
    PENDING_REVIEW: '待质检',
    ACCEPTED: '已接收',
    REJECTED: '已拒收',
  };
  return labels[status] || status;
}

function physicalSummary(physical: ReceiptPhysical, locale: string) {
  const tracking = physical.trackingType === 'SERIAL'
    ? `${locale === 'zh-CN' ? '序号' : 'Serial'} ${physical.serialNumber || '—'}`
    : `${locale === 'zh-CN' ? '批次' : 'Batch'} ${physical.batchNumber || '—'}`;
  return `${physical.partNumber} · ${physical.uom} · ${physical.quantity} · ${tracking} · ${physical.conditionCode}`;
}

function storageSummary(storage: ReceiptStorage, locale: string) {
  return `${locale === 'zh-CN' ? '仓库' : 'Warehouse'} ${storage.warehouse} · ${locale === 'zh-CN' ? '库位' : 'Location'} ${storage.location}${storage.shelf ? ` · ${locale === 'zh-CN' ? '货架' : 'Shelf'} ${storage.shelf}` : ''}`;
}

function createReviewForm(): ReviewForm {
  return { checks: { ...emptyChecks }, reason: '' };
}

type ReceiptQualityCertificate = {
  id: string;
  certificateNumber: string;
  partNumber: string;
  serialNumber: string | null;
  batchNumber: string | null;
  certificateType: string;
  status: string;
  expiryDate: string | null;
  fileHash: string | null;
  updatedAt?: string;
};

type ReceiptQualityFacts = {
  physical?: ReceiptPhysical;
  chain?: {
    order?: { certificateRequired?: boolean; certificateType?: string | null; inspectionRequired?: boolean };
    rfqLine?: {
      partNumber?: string;
      uom?: string;
      conditionCode?: string;
      serialNumber?: string | null;
      batchNumber?: string | null;
      certificateRequired?: boolean;
      certificateType?: string | null;
      alternatePartNumbers?: string | null;
    };
  };
  certificates?: ReceiptQualityCertificate[];
};

function booleanText(value: boolean | undefined, tx: (zh: string, en: string) => string) {
  if (value === undefined) return '—';
  return value ? tx('是', 'Yes') : tx('否', 'No');
}

function optionalText(value: string | number | null | undefined) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function QualityFact({ label, value }: { label: string; value: string }) {
  return <div className="rounded border bg-background px-2 py-1.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="break-words text-sm font-medium">{value || '—'}</dd>
  </div>;
}

function ReceiptQualityFacts({ context, locale, tx }: {
  context: ReviewContext;
  locale: string;
  tx: (zh: string, en: string) => string;
}) {
  const facts = context.snapshot.requirements as ReceiptQualityFacts;
  const physical = facts.physical ?? context.snapshot.physical?.physical;
  const storage = context.snapshot.physical?.storage;
  const requirement = facts.chain?.rfqLine;
  const orderRequirement = facts.chain?.order;
  const certificates = facts.certificates ?? [];
  const evidence = context.snapshot.evidence ?? [];
  return <div className="mt-3 space-y-3 rounded border bg-background p-3" data-testid="stock-receipt-quality-facts">
    <div>
      <p className="font-medium">{tx('实际质量事实', 'Physical quality facts')}</p>
      <p className="text-xs text-muted-foreground">{tx('请核对实物身份、状态、寿命、期限和证书当前状态。', 'Verify identity, condition, life limits, dates, and current certificate facts.')}</p>
    </div>
    <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <QualityFact label={tx('件号', 'Part number')} value={optionalText(physical?.partNumber)} />
      <QualityFact label={tx('单位', 'UOM')} value={optionalText(physical?.uom)} />
      <QualityFact label={tx('跟踪方式', 'Tracking type')} value={optionalText(physical?.trackingType)} />
      <QualityFact label={tx('数量', 'Quantity')} value={optionalText(physical?.quantity)} />
      <QualityFact label={physical?.trackingType === 'SERIAL' ? tx('序号', 'Serial number') : tx('批次', 'Batch number')} value={optionalText(physical?.trackingType === 'SERIAL' ? physical.serialNumber : physical?.batchNumber)} />
      <QualityFact label={tx('状态代码', 'Condition code')} value={optionalText(physical?.conditionCode)} />
      <QualityFact label={tx('寿命限制', 'Life limited')} value={booleanText(physical?.lifeLimited, tx)} />
      <QualityFact label={tx('剩余小时', 'Remaining hours')} value={optionalText(physical?.remainingHours)} />
      <QualityFact label={tx('剩余循环', 'Remaining cycles')} value={optionalText(physical?.remainingCycles)} />
      <QualityFact label={tx('货架期截止', 'Shelf life date')} value={displayDate(physical?.shelfLifeDate, locale)} />
      <QualityFact label={tx('货架期天数', 'Shelf life days')} value={optionalText(physical?.shelfLifeDays)} />
      <QualityFact label={tx('下次检修截止', 'Next overhaul due')} value={displayDate(physical?.nextOverhaulDue, locale)} />
      <QualityFact label={tx('保存条件', 'Storage condition')} value={optionalText(physical?.storageCondition)} />
      <QualityFact label={tx('仓库', 'Warehouse')} value={optionalText(storage?.warehouse)} />
      <QualityFact label={tx('库位', 'Location')} value={optionalText(storage?.location)} />
      <QualityFact label={tx('实物证书类型', 'Physical certificate type')} value={optionalText(physical?.certificateType)} />
      <QualityFact label={tx('实物证书编号', 'Physical certificate number')} value={optionalText(physical?.certificateNumber)} />
    </dl>

    <div className="space-y-2">
      <p className="font-medium">{tx('客户/需求质量要求', 'Customer quality requirements')}</p>
      <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <QualityFact label={tx('要求件号', 'Required part number')} value={optionalText(requirement?.partNumber)} />
        <QualityFact label={tx('要求单位', 'Required UOM')} value={optionalText(requirement?.uom)} />
        <QualityFact label={tx('要求状态代码', 'Required condition code')} value={optionalText(requirement?.conditionCode)} />
        <QualityFact label={tx('要求序号', 'Required serial number')} value={optionalText(requirement?.serialNumber)} />
        <QualityFact label={tx('要求批次', 'Required batch number')} value={optionalText(requirement?.batchNumber)} />
        <QualityFact label={tx('要求证书', 'Certificate required')} value={booleanText(requirement?.certificateRequired, tx)} />
        <QualityFact label={tx('要求证书类型', 'Required certificate type')} value={optionalText(requirement?.certificateType)} />
        <QualityFact label={tx('允许替代件号', 'Allowed alternate part numbers')} value={optionalText(requirement?.alternatePartNumbers)} />
        <QualityFact label={tx('订单需检验', 'Order inspection required')} value={booleanText(orderRequirement?.inspectionRequired, tx)} />
        <QualityFact label={tx('订单证书要求', 'Order certificate required')} value={booleanText(orderRequirement?.certificateRequired, tx)} />
        <QualityFact label={tx('订单证书类型', 'Order certificate type')} value={optionalText(orderRequirement?.certificateType)} />
      </dl>
    </div>

    <div className="space-y-2">
      <p className="font-medium">{tx('供应商证书当前事实', 'Current supplier certificate facts')}</p>
      {certificates.length === 0 ? <p className="text-sm text-muted-foreground">{tx('当前没有可核验的证书记录。', 'No verifiable certificate records are available.')}</p> : <div className="space-y-2">
        {certificates.map(certificate => <div key={certificate.id} className="rounded border px-2 py-2">
          <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <QualityFact label={tx('证书编号', 'Certificate number')} value={optionalText(certificate.certificateNumber)} />
            <QualityFact label={tx('证书类型', 'Certificate type')} value={optionalText(certificate.certificateType)} />
            <QualityFact label={tx('证书状态', 'Certificate status')} value={optionalText(certificate.status)} />
            <QualityFact label={tx('证书件号', 'Certificate part number')} value={optionalText(certificate.partNumber)} />
            <QualityFact label={tx('证书序号', 'Certificate serial number')} value={optionalText(certificate.serialNumber)} />
            <QualityFact label={tx('证书批次', 'Certificate batch number')} value={optionalText(certificate.batchNumber)} />
            <QualityFact label={tx('证书有效期', 'Certificate expiry')} value={displayDate(certificate.expiryDate, locale)} />
            <QualityFact label={tx('证书文件证据', 'Certificate file evidence')} value={certificate.fileHash ? tx('已绑定', 'Bound') : tx('缺失', 'Missing')} />
          </dl>
        </div>)}
      </div>}
    </div>

    <div className="space-y-2">
      <p className="font-medium">{tx('收货凭证', 'Receipt evidence')}</p>
      {evidence.length === 0 ? <p className="text-sm text-muted-foreground">{tx('当前没有可下载的收货凭证。', 'No downloadable receipt evidence is available.')}</p> : <ul className="space-y-2">
        {evidence.map((file, index) => <li key={`${file.id}:${file.version}`} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-2 text-sm">
          <span>{tx(`收货凭证 ${index + 1}`, `Receipt evidence ${index + 1}`)}</span>
          <EvidenceDownload id={file.id} label={tx('查看收货凭证', 'View receipt evidence')} />
        </li>)}
      </ul>}
    </div>
  </div>;
}

function remainingForLine(
  purchase: PurchaseCommitment,
  lineId: string,
  receipts: StockReceipt[],
  drafts: ArrivalDraft[] = [],
) {
  const line = purchase.lines.find(candidate => candidate.id === lineId);
  if (!line) return 0;
  const pending = receipts.flatMap(receipt => receipt.lines)
    .filter(receiptLine => receiptLine.purchaseCommitmentLineId === lineId && receiptLine.status === 'PENDING_REVIEW')
    .reduce((sum, receiptLine) => sum + receiptLine.quantity, 0);
  const drafted = drafts.filter(draft => draft.purchaseCommitmentLineId === lineId)
    .reduce((sum, draft) => sum + positiveInteger(draft.physical.quantity), 0);
  return Math.max(0, line.quantity - line.cancelledQuantity - line.receivedQuantity - line.directShippedQuantity - pending - drafted);
}

export interface StockReceiptPanelProps {
  orderId: string;
  purchases: PurchaseCommitment[];
  onChanged?: () => void | Promise<unknown>;
}

export function StockReceiptPanel({ orderId, purchases, onChanged }: StockReceiptPanelProps) {
  const { locale } = useTranslation();
  const tx = useCallback((zh: string, en: string) => locale === 'zh-CN' ? zh : en, [locale]);
  const can = useCapabilityStore(state => state.can);
  const canRead = can('inventory.read');
  const canManage = can('inventory.manage');
  const canReview = can('quality_review.approve');
  const command = useCommandRunner();
  const loadGeneration = useRef(0);

  const [receipts, setReceipts] = useState<StockReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedPurchaseId, setSelectedPurchaseId] = useState('');
  const [selectedPurchaseLineId, setSelectedPurchaseLineId] = useState('');
  const [arrivalLines, setArrivalLines] = useState<ArrivalDraft[]>([]);
  const [deliveryReference, setDeliveryReference] = useState('');
  const [arrivalReason, setArrivalReason] = useState('');
  const [arrivalEvidence, setArrivalEvidence] = useState<EvidenceFile[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [reviewContexts, setReviewContexts] = useState<Record<string, ReviewContext | null>>({});
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [reviewForms, setReviewForms] = useState<Record<string, ReviewForm>>({});

  const loadReceipts = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (!orderId || !canRead) {
      setReceipts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await stockReceiptApi.list(orderId);
      if (generation !== loadGeneration.current) return;
      setReceipts(data?.receipts ?? []);
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setReceipts([]);
      setError(cause instanceof Error ? cause.message : tx('收货记录加载失败', 'Failed to load stock receipts'));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [canRead, orderId, tx]);

  useEffect(() => {
    loadGeneration.current += 1;
    setReceipts([]);
    setError('');
    setSelectedPurchaseId('');
    setSelectedPurchaseLineId('');
    setArrivalLines([]);
    setDeliveryReference('');
    setArrivalReason('');
    setArrivalEvidence([]);
    setReviewContexts({});
    setReviewErrors({});
    setReviewForms({});
    void loadReceipts();
  }, [loadReceipts, orderId]);

  const eligiblePurchases = useMemo(
    () => purchases.filter(purchase => purchase.status === 'CONFIRMED'
      && purchase.lines.some(line => line.fulfillmentMode === 'STOCK_RECEIPT' && remainingForLine(purchase, line.id, receipts) > 0)),
    [purchases, receipts],
  );
  const selectedPurchase = eligiblePurchases.find(purchase => purchase.id === selectedPurchaseId) ?? null;
  const eligibleLines = selectedPurchase?.lines.filter(line => line.fulfillmentMode === 'STOCK_RECEIPT'
    && remainingForLine(selectedPurchase, line.id, receipts, arrivalLines) > 0) ?? [];
  const selectedPurchaseLine = eligibleLines.find(line => line.id === selectedPurchaseLineId) ?? null;

  useEffect(() => {
    if (selectedPurchaseId && !selectedPurchase) {
      setSelectedPurchaseId('');
      setSelectedPurchaseLineId('');
    }
    if (selectedPurchaseLineId && !selectedPurchaseLine) setSelectedPurchaseLineId('');
  }, [selectedPurchase, selectedPurchaseId, selectedPurchaseLine, selectedPurchaseLineId]);

  useEffect(() => {
    if (!canReview) {
      setReviewContexts({});
      setReviewErrors({});
      return;
    }
    const pendingLines = receipts.flatMap(receipt => receipt.lines.filter(line => line.status === 'PENDING_REVIEW'));
    let active = true;
    setReviewContexts({});
    setReviewErrors({});
    if (!pendingLines.length) return () => { active = false; };
    void Promise.all(pendingLines.map(async line => {
      try {
        const context = await stockReceiptApi.context(line.id);
        return { id: line.id, context, error: '' };
      } catch (cause) {
        return { id: line.id, context: null, error: cause instanceof Error ? cause.message : tx('质检上下文加载失败', 'Failed to load review context') };
      }
    })).then(results => {
      if (!active) return;
      setReviewContexts(Object.fromEntries(results.map(result => [result.id, result.context])));
      setReviewErrors(Object.fromEntries(results.filter(result => result.error).map(result => [result.id, result.error])));
    });
    return () => { active = false; };
  }, [canReview, receipts, tx]);

  const setReviewForm = (lineId: string, update: Partial<ReviewForm>) => {
    setReviewForms(previous => ({ ...previous, [lineId]: { ...(previous[lineId] ?? createReviewForm()), ...update } }));
  };

  const addArrivalLine = () => {
    if (!selectedPurchase || !selectedPurchaseLine) return;
    const remaining = remainingForLine(selectedPurchase, selectedPurchaseLine.id, receipts, arrivalLines);
    if (remaining < 1) return;
    setArrivalLines(previous => [...previous, {
      key: newDraftKey(),
      purchaseCommitmentLineId: selectedPurchaseLine.id,
      physical: { ...emptyPhysical(selectedPurchaseLine.partNumber, selectedPurchaseLine.uom), quantity: 1 },
      storage: { location: '', warehouse: '', shelf: null },
    }]);
  };

  const updateArrivalLine = (key: string, update: Partial<ArrivalDraft>) => {
    setArrivalLines(previous => previous.map(line => line.key === key ? { ...line, ...update } : line));
  };

  const validateArrival = () => {
    if (!selectedPurchase || selectedPurchase.status !== 'CONFIRMED') return tx('请选择已确认的采购承诺', 'Select a confirmed purchase commitment');
    if (!deliveryReference.trim() || deliveryReference.trim().length > 200) return tx('请填写有效的供应商送货单号', 'Enter a valid supplier delivery reference');
    if (arrivalReason.trim().length < 3) return tx('收货说明至少需要 3 个字符', 'Receipt reason must be at least 3 characters');
    if (!arrivalEvidence.length) return tx('请上传至少一个收货证据', 'Upload at least one receipt evidence file');
    if (!arrivalLines.length) return tx('请至少添加一条到货实物行', 'Add at least one arrival line');
    const draftTotals = new Map<string, number>();
    for (const line of arrivalLines) {
      draftTotals.set(line.purchaseCommitmentLineId, (draftTotals.get(line.purchaseCommitmentLineId) ?? 0) + positiveInteger(line.physical.quantity));
    }
    for (const line of arrivalLines) {
      const purchaseLine = selectedPurchase.lines.find(candidate => candidate.id === line.purchaseCommitmentLineId);
      const quantity = positiveInteger(line.physical.quantity);
      if (!purchaseLine || purchaseLine.fulfillmentMode !== 'STOCK_RECEIPT') return tx('到货行必须来自库存收货采购行', 'Each arrival line must use a stock-receipt purchase line');
      if (quantity < 1 || (draftTotals.get(line.purchaseCommitmentLineId) ?? 0) > remainingForLine(selectedPurchase, line.purchaseCommitmentLineId, receipts)) return tx('到货数量超过采购行可收数量', 'Arrival quantity exceeds the purchase line remaining quantity');
      if (!line.physical.partNumber.trim() || !line.physical.uom.trim() || !line.physical.conditionCode.trim()) return tx('请补齐实物件号、单位和状态', 'Complete the physical part number, unit and condition');
      if (line.physical.trackingType === 'SERIAL' && (quantity !== 1 || !line.physical.serialNumber?.trim())) return tx('序号件必须为数量 1 且填写序号', 'Serial items require quantity 1 and a serial number');
      if (line.physical.trackingType === 'BATCH' && !line.physical.batchNumber?.trim()) return tx('批次件必须填写批次号', 'Batch items require a batch number');
      if (!line.storage.location.trim() || !line.storage.warehouse.trim()) return tx('请填写仓库和库位', 'Complete warehouse and location');
    }
    return '';
  };

  const submitArrival = async () => {
    const validationError = validateArrival();
    if (validationError || !selectedPurchase) {
      setError(validationError);
      return;
    }
    const payload = {
      purchaseCommitmentId: selectedPurchase.id,
      purchaseVersion: selectedPurchase.version,
      supplierDeliveryReference: deliveryReference.trim(),
      reason: arrivalReason.trim(),
      evidenceIds: arrivalEvidence.map(file => file.id),
      lines: arrivalLines.map(line => ({
        purchaseCommitmentLineId: line.purchaseCommitmentLineId,
        physical: line.physical,
        storage: line.storage,
      })),
    };
    const signature = `stock-receipt:create:${JSON.stringify(payload)}`;
    setError('');
    try {
      await command.run(signature, key => stockReceiptApi.create(payload, key));
      setArrivalLines([]);
      setSelectedPurchaseLineId('');
      setDeliveryReference('');
      setArrivalReason('');
      setArrivalEvidence([]);
      await onChanged?.();
      await loadReceipts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tx('创建收货记录失败', 'Failed to create receipt'));
    }
  };

  const submitReview = async (receiptLine: ReceiptLine, decision: 'ACCEPTED' | 'REJECTED') => {
    const context = reviewContexts[receiptLine.id];
    const form = reviewForms[receiptLine.id] ?? createReviewForm();
    if (!context) return;
    if (form.reason.trim().length < 3) {
      setReviewErrors(previous => ({ ...previous, [receiptLine.id]: tx('审核说明至少需要 3 个字符', 'Review reason must be at least 3 characters') }));
      return;
    }
    if (decision === 'ACCEPTED' && (!context.canAccept || !Object.values(form.checks).every(Boolean))) {
      setReviewErrors(previous => ({ ...previous, [receiptLine.id]: tx('通过审核前必须完成全部质量检查', 'All quality checks are required before acceptance') }));
      return;
    }
    const payload = { version: context.version, snapshotHash: context.snapshotHash, decision, reason: form.reason.trim(), checks: form.checks };
    const signature = `stock-receipt:review:${receiptLine.id}:${JSON.stringify(payload)}`;
    setReviewErrors(previous => ({ ...previous, [receiptLine.id]: '' }));
    try {
      await command.run(signature, key => stockReceiptApi.review(receiptLine.id, payload, key));
      setReviewForms(previous => ({ ...previous, [receiptLine.id]: createReviewForm() }));
      await onChanged?.();
      await loadReceipts();
    } catch (cause) {
      setReviewErrors(previous => ({ ...previous, [receiptLine.id]: cause instanceof Error ? cause.message : tx('审核失败', 'Review failed') }));
    }
  };

  const title = tx('采购收货与质检', 'Procurement receipt and quality review');
  if (!canRead) {
    return <section aria-label={title} className="rounded-lg border p-4"><p className="text-sm text-muted-foreground">{tx('当前账号没有库存读取权限。', 'This account cannot read inventory receipts.')}</p></section>;
  }

  return <section aria-label={title} className="space-y-5 rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{tx('收货先进入待检隔离；逐行质量审核通过后才进入可用库存。', 'Receipts remain quarantined until each line passes independent quality review.')}</p>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={() => void loadReceipts()} disabled={loading || command.busy} aria-label={tx('刷新收货', 'Refresh receipts')}>
        <RefreshCw className="mr-1 h-4 w-4" />{tx('刷新', 'Refresh')}
      </Button>
    </div>

    {loading && <p role="status">{tx('正在加载收货记录…', 'Loading receipt records…')}</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

    {!loading && !receipts.length && <p className="text-sm text-muted-foreground">{tx('该订单还没有收货记录。', 'No stock receipts for this order yet.')}</p>}
    {receipts.length > 0 && <div className="space-y-3" aria-label={tx('收货记录列表', 'Receipt records')}>
      {receipts.map(receipt => <article key={receipt.id} className="rounded border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><h4 className="font-medium">{receipt.receiptNumber}</h4><p className="text-xs text-muted-foreground">{displayDate(receipt.receivedAt, locale)} · {receipt.supplierDeliveryReference}</p></div>
          <Badge variant="outline">{tx('到货', 'Arrival')}</Badge>
        </div>
        {receipt.reason && <p className="mt-1 text-sm">{receipt.reason}</p>}
        <div className="mt-2 space-y-2">
          {receipt.lines.map(line => <div key={line.id} className="rounded bg-muted/30 p-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><span>{tx('第', 'Line ')}{line.lineNo} · {physicalSummary(line.qualitySnapshot.physical, locale)}</span><Badge variant="secondary">{statusText(line.status, locale)}</Badge></div>
            <p className="text-xs text-muted-foreground">{storageSummary(line.qualitySnapshot.storage, locale)}</p>
            {line.status === 'PENDING_REVIEW' && canReview && <ReviewBlock
              line={line}
              context={reviewContexts[line.id]}
              contextError={reviewErrors[line.id]}
              form={reviewForms[line.id] ?? createReviewForm()}
              busy={command.busy}
              locale={locale}
              tx={tx}
              onFormChange={update => setReviewForm(line.id, update)}
              onSubmit={decision => void submitReview(line, decision)}
            />}
            {line.status === 'PENDING_REVIEW' && !canReview && <p className="mt-2 text-xs text-muted-foreground">{tx('等待有授权的质量人员审核。', 'Awaiting an authorized quality reviewer.')}</p>}
          </div>)}
        </div>
      </article>)}
    </div>}

    {canManage && <div className="space-y-4 border-t pt-4">
      <div><h4 className="font-semibold">{tx('登记采购到货', 'Record procurement arrival')}</h4><p className="text-sm text-muted-foreground">{tx('仅可选择已确认且履约方式为库存收货的采购行。', 'Only confirmed stock-receipt purchase lines are available.')}</p></div>
      {!eligiblePurchases.length && <p className="text-sm text-muted-foreground">{tx('没有可登记的已确认库存收货采购行。', 'No confirmed stock-receipt purchase line is available.')}</p>}
      {eligiblePurchases.length > 0 && <>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label>{tx('采购承诺', 'Purchase commitment')}<select aria-label={tx('选择采购承诺', 'Select purchase commitment')} className="h-9 w-full rounded border bg-background px-2" value={selectedPurchaseId} onChange={event => { setSelectedPurchaseId(event.target.value); setSelectedPurchaseLineId(''); }} disabled={command.busy || uploadBusy}>
            <option value="">{tx('请选择', 'Select')}</option>
            {eligiblePurchases.map(purchase => <option key={purchase.id} value={purchase.id}>{purchase.commitmentNumber} · {purchase.supplierName}</option>)}
          </select></Label>
          <Label>{tx('采购行', 'Purchase line')}<select aria-label={tx('选择采购行', 'Select purchase line')} className="h-9 w-full rounded border bg-background px-2" value={selectedPurchaseLineId} onChange={event => setSelectedPurchaseLineId(event.target.value)} disabled={!selectedPurchase || command.busy || uploadBusy}>
            <option value="">{tx('请选择到货行', 'Select an arrival line')}</option>
            {eligibleLines.map(line => <option key={line.id} value={line.id}>{tx('第', 'Line ')}{line.lineNo} · {line.partNumber} · {tx('剩余', 'Remaining ')}{remainingForLine(selectedPurchase!, line.id, receipts, arrivalLines)}</option>)}
          </select></Label>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addArrivalLine} disabled={!selectedPurchaseLine || command.busy || uploadBusy}><Plus className="mr-1 h-4 w-4" />{tx('添加到货批次', 'Add arrival batch')}</Button>
        {arrivalLines.length > 0 && <div className="space-y-4">
          {arrivalLines.map((line, index) => <div key={line.key} className="space-y-3 rounded border p-3">
            <div className="flex items-center justify-between gap-2"><h5 className="font-medium">{tx('到货实物行', 'Arrival line')} {index + 1}</h5><Button type="button" variant="ghost" size="sm" onClick={() => setArrivalLines(previous => previous.filter(candidate => candidate.key !== line.key))} disabled={command.busy || uploadBusy} aria-label={tx(`移除到货行 ${index + 1}`, `Remove arrival line ${index + 1}`)}><Trash2 className="h-4 w-4" /></Button></div>
            <p className="text-sm text-muted-foreground">{selectedPurchase?.lines.find(candidate => candidate.id === line.purchaseCommitmentLineId)?.partNumber}</p>
            <PhysicalFields value={line.physical} supplierId={selectedPurchase?.supplierId} disabled={command.busy || uploadBusy} onChange={physical => updateArrivalLine(line.key, { physical })} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Label>{tx('仓库', 'Warehouse')}<Input value={line.storage.warehouse} disabled={command.busy || uploadBusy} onChange={event => updateArrivalLine(line.key, { storage: { ...line.storage, warehouse: event.target.value } })} /></Label>
              <Label>{tx('库位', 'Location')}<Input value={line.storage.location} disabled={command.busy || uploadBusy} onChange={event => updateArrivalLine(line.key, { storage: { ...line.storage, location: event.target.value } })} /></Label>
              <Label>{tx('货架（可选）', 'Shelf (optional)')}<Input value={line.storage.shelf || ''} disabled={command.busy || uploadBusy} onChange={event => updateArrivalLine(line.key, { storage: { ...line.storage, shelf: event.target.value || null } })} /></Label>
            </div>
          </div>)}
        </div>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Label>{tx('供应商送货单号', 'Supplier delivery reference')}<Input value={deliveryReference} maxLength={200} disabled={command.busy || uploadBusy} onChange={event => setDeliveryReference(event.target.value)} /></Label>
          <Label>{tx('收货说明', 'Receipt reason')}<Textarea value={arrivalReason} maxLength={4000} disabled={command.busy || uploadBusy} onChange={event => setArrivalReason(event.target.value)} /></Label>
        </div>
        <EvidenceUpload value={arrivalEvidence} onChange={setArrivalEvidence} onBusyChange={setUploadBusy} disabled={command.busy} label={tx('收货附件证据（至少 1 个）', 'Receipt evidence (at least 1 file)')} />
        <Button type="button" onClick={() => void submitArrival()} disabled={command.busy || uploadBusy || !selectedPurchase || !arrivalLines.length}>{tx('建立待检收货', 'Create receipt for review')}</Button>
      </>}
    </div>}
  </section>;
}

function ReviewBlock({
  line,
  context,
  contextError,
  form,
  busy,
  locale,
  tx,
  onFormChange,
  onSubmit,
}: {
  line: ReceiptLine;
  context: ReviewContext | null | undefined;
  contextError?: string;
  form: ReviewForm;
  busy: boolean;
  locale: string;
  tx: (zh: string, en: string) => string;
  onFormChange: (update: Partial<ReviewForm>) => void;
  onSubmit: (decision: 'ACCEPTED' | 'REJECTED') => void;
}) {
  const updateCheck = (key: keyof ReviewChecks, value: boolean) => onFormChange({ checks: { ...form.checks, [key]: value } });
  const checkLabels: Array<[keyof ReviewChecks, string, string]> = [
    ['identity', '已核对实物身份与件号', 'Physical identity checked'],
    ['documents', '已核对文件与实物一致', 'Documents match the physical item'],
    ['conditionAndLife', '已核对状态与寿命要求', 'Condition and life checked'],
    ['customerRequirements', '已满足客户质量要求', 'Customer requirements met'],
  ];
  return <div className="mt-3 space-y-3 rounded border border-amber-300 bg-amber-50/40 p-3">
    <h5 className="font-medium">{tx('逐行质量审核', 'Line quality review')}</h5>
    {!context && !contextError && <p role="status" className="text-sm">{tx('正在加载审核上下文…', 'Loading review context…')}</p>}
    {contextError && <p role="alert" className="text-sm text-red-600">{contextError}</p>}
    {context && <>
      <ReceiptQualityFacts context={context} locale={locale} tx={tx} />
      {context.issues.length > 0 && <ul className="list-disc pl-5 text-red-700">{context.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>}
      <div className="grid gap-2 text-sm sm:grid-cols-2">{checkLabels.map(([key, zh, en]) => <label key={key} className="flex items-start gap-2"><input type="checkbox" checked={form.checks[key]} disabled={busy} onChange={event => updateCheck(key, event.target.checked)} />{tx(zh, en)}</label>)}</div>
      <Label>{tx('审核依据/拒收原因', 'Review basis or rejection reason')}<Textarea value={form.reason} disabled={busy} maxLength={4000} onChange={event => onFormChange({ reason: event.target.value })} /></Label>
      <div className="flex flex-wrap gap-2"><Button type="button" onClick={() => onSubmit('ACCEPTED')} disabled={busy || !context.canAccept || !Object.values(form.checks).every(Boolean) || form.reason.trim().length < 3}>{tx('审核通过', 'Accept line')}</Button><Button type="button" variant="outline" onClick={() => onSubmit('REJECTED')} disabled={busy || form.reason.trim().length < 3}>{tx('拒收并隔离', 'Reject line')}</Button></div>
    </>}
    {line.reviewReason && <p className="text-xs text-muted-foreground">{line.reviewReason}</p>}
  </div>;
}
