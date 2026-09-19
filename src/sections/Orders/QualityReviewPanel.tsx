import { useEffect, useState } from 'react';
import { qualityReviewApi, type QualityReviewContext } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCapabilityStore } from '@/store';
import { useTranslation } from '@/i18n';

const initialChecks = { identity: false, documents: false, conditionAndLife: false, customerRequirements: false };

export function QualityReviewPanel({ orderId, remaining }: { orderId: string; remaining: number }) {
  const can = useCapabilityStore((state) => state.can);
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const [quantity, setQuantity] = useState(remaining);
  const [context, setContext] = useState<QualityReviewContext | null>(null);
  const [checks, setChecks] = useState(initialChecks);
  const [serial, setSerial] = useState('');
  const [batch, setBatch] = useState('');
  const [reason, setReason] = useState('');
  const [files, setFiles] = useState<Array<{ id: string; originalName: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const allowed = can('quality_review.approve');

  useEffect(() => {
    let active = true;
    setContext(null);
    setChecks(initialChecks);
    setMessage('');
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > remaining) return;
    qualityReviewApi.preview(orderId, quantity).then((value) => { if (active) setContext(value); })
      .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : '加载失败'); });
    return () => { active = false; };
  }, [orderId, quantity, remaining, reload]);

  const review = context?.review;
  const approved = Boolean(review?.approved && !review.consumedAt && review.snapshotHash === context?.snapshotHash && review.quantity === quantity);
  const inventory = context?.snapshot.inventory;
  const labels = {
    identity: tx('已核对实物件号、状态及序号/批次', 'Physical identity and condition checked'),
    documents: tx('已核对本次交付文件与实物一致', 'Delivery documents checked against the item'),
    conditionAndLife: tx('已核对适用的寿命、货架期及保存条件', 'Applicable life, shelf life and storage checked'),
    customerRequirements: tx('已满足客户质量要求，不适用项已说明', 'Customer requirements met; exclusions documented'),
  };

  return <section className="rounded-lg border p-4 space-y-3" aria-label={tx('交付质量审核', 'Delivery quality review')}>
    <h4 className="font-medium">{tx('交付质量审核', 'Delivery quality review')}</h4>
    <p className="text-sm text-gray-600">{approved ? tx('本次数量已审核；出库时将再次核对资料版本。', 'This quantity is reviewed; evidence is checked again at outbound.') : tx('本次出库需要质量人员核对。资料或数量变化后需要重新审核。', 'Quality review is required for this outbound quantity. Changes require a new review.')}</p>
    <Label className="block">{tx('本次计划出库数量', 'Planned outbound quantity')}<Input type="number" min={1} max={remaining} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} disabled={busy} /></Label>
    {inventory && <div className="text-sm space-y-1">
      <p>{inventory.partNumber} · {inventory.conditionCode} · {tx('序号', 'Serial')}: {inventory.serialNumber || '—'} · {tx('批次', 'Batch')}: {inventory.batchNumber || '—'}</p>
      <p>{tx('货架期截止', 'Shelf life expires')}: {inventory.shelfLifeDate || '—'} · {tx('检修截止', 'Overhaul due')}: {inventory.nextOverhaulDue || '—'}</p>
      <p>{tx('寿命限制', 'Life limited')}: {inventory.lifeLimited ? tx('是', 'Yes') : tx('否', 'No')} · {tx('剩余小时/循环', 'Remaining hours/cycles')}: {inventory.remainingHours ?? '—'} / {inventory.remainingCycles ?? '—'}</p>
      <p>{tx('客户要求', 'Customer requirement')}: {context?.snapshot.requirements.conditionCode} · {context?.snapshot.requirements.certificateType || context?.snapshot.order.certificateType || tx('按客户资料核对', 'Check customer documents')} · {context?.snapshot.requirements.inspectionStandard || '—'}</p>
    </div>}
    {allowed && <>
      <div className="grid grid-cols-2 gap-3">
        <Label>{tx('文件上的序号（无则留空）', 'Document serial (blank if none)')}<Input value={serial} onChange={(event) => setSerial(event.target.value)} disabled={busy} /></Label>
        <Label>{tx('文件上的批次（无则留空）', 'Document batch (blank if none)')}<Input value={batch} onChange={(event) => setBatch(event.target.value)} disabled={busy} /></Label>
      </div>
      <Label className="block">{tx('上传已核对的交付证据', 'Upload reviewed delivery evidence')}<Input type="file" multiple disabled={busy} onChange={async (event) => {
        const selected = Array.from(event.target.files || []);
        event.target.value = '';
        setBusy(true);
        try {
          // Keep each successful upload if a later file fails.
          for (const file of selected) {
            const result = await qualityReviewApi.uploadEvidence(file);
            setFiles((previous) => [...previous, result]);
          }
        } catch (error) { setMessage(error instanceof Error ? error.message : '上传失败'); }
        finally { setBusy(false); }
      }} /></Label>
      {files.map((file) => <p key={file.id} className="text-sm">{file.originalName} <Button variant="ghost" size="sm" disabled={busy} onClick={() => setFiles((previous) => previous.filter((candidate) => candidate.id !== file.id))}>{tx('移除', 'Remove')}</Button></p>)}
      {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => <label key={key} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={checks[key]} disabled={busy} onChange={(event) => setChecks((previous) => ({ ...previous, [key]: event.target.checked }))} />{labels[key]}</label>)}
      <Label className="block">{tx('审核依据及不适用项说明', 'Review basis and inapplicable items')}<textarea className="w-full rounded border p-2" value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></Label>
      <div className="flex gap-2">{[true, false].map((approve) => <Button key={String(approve)} variant={approve ? 'default' : 'outline'} disabled={busy || !context || reason.trim().length < 3 || (approve && Object.values(checks).some((checked) => !checked))} onClick={async () => {
        if (!context) return;
        setBusy(true);
        try {
          await qualityReviewApi.create({ orderId, quantity, snapshotHash: context.snapshotHash, approved: approve, evidenceIds: files.map((file) => file.id), verifiedSerialNumber: serial, verifiedBatchNumber: batch, checks, reason });
          setFiles([]); setSerial(''); setBatch(''); setReason(''); setReload((value) => value + 1);
        } catch (error) { setMessage(error instanceof Error ? error.message : '审核失败'); }
        finally { setBusy(false); }
      }}>{approve ? tx('确认审核通过', 'Approve review') : tx('记录不通过', 'Reject review')}</Button>)}</div>
    </>}
    {message && <p role="alert" className="text-sm text-red-600">{message}</p>}
  </section>;
}
