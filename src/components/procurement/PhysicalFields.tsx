import { useEffect, useState } from 'react';
import { certificateApi } from '@/api/client';
import type { ReceiptPhysical } from '@/features/orders';
import type { Certificate } from '@/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import { localDateTime } from './physicalDefaults';

type EvidenceCertificate = Certificate & { fileHash?: string | null; supplierId?: string | null; inventoryDetailId?: string | null };

export function PhysicalFields({ value, onChange, disabled, supplierId }: {
  value: ReceiptPhysical; onChange: (value: ReceiptPhysical) => void; disabled?: boolean; supplierId?: string;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const [certificates, setCertificates] = useState<EvidenceCertificate[]>([]);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true; setCertificates([]); setError('');
    if (!value.partNumber.trim()) return;
    const timer = setTimeout(() => {
      setLoading(true);
      certificateApi.list({ partNumber: value.partNumber.trim(), status: 'ISSUED' }).then(rows => {
        if (active) setCertificates((rows as EvidenceCertificate[]).filter(row => row.partNumber === value.partNumber.trim()
          && (!supplierId || row.supplierId === supplierId) && !row.inventoryDetailId));
      }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Certificate lookup failed'); })
        .finally(() => { if (active) setLoading(false); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [value.partNumber, supplierId]);
  const update = <K extends keyof ReceiptPhysical>(key: K, next: ReceiptPhysical[K]) => onChange({ ...value, [key]: next });
  const numberField = (key: 'quantity' | 'remainingHours' | 'remainingCycles' | 'shelfLifeDays', zh: string, en: string, min = 0) =>
    <Label key={key} className="grid gap-2">{tx(zh, en)}<Input type="number" min={min} step={key === 'remainingHours' ? 'any' : 1}
      value={value[key] ?? ''} disabled={disabled || (key === 'quantity' && value.trackingType === 'SERIAL')}
      onChange={event => update(key, event.target.value === '' ? (key === 'quantity' ? 0 : null) : Number(event.target.value))} /></Label>;
  return <fieldset disabled={disabled} className="min-w-0 space-y-3 rounded border p-3 [&_label]:min-w-0 [&_select]:min-w-0">
    <legend className="px-1 text-sm font-medium">{tx('实际交付实物', 'Physical delivery')}</legend>
    <div className="grid gap-3 sm:grid-cols-2">
      <Label className="grid gap-2">{tx('实物件号', 'Part number')}<Input value={value.partNumber} maxLength={200} onChange={event => onChange({ ...value, partNumber: event.target.value, certificateReferences: [] })} /></Label>
      <Label className="grid gap-2">{tx('单位', 'Unit')}<Input value={value.uom} maxLength={64} onChange={event => update('uom', event.target.value)} /></Label>
      <Label className="grid gap-2">{tx('跟踪方式', 'Tracking')}<select className="h-9 w-full rounded border bg-background px-2" value={value.trackingType} onChange={event => onChange({ ...value,
        trackingType: event.target.value as 'SERIAL' | 'BATCH', quantity: event.target.value === 'SERIAL' ? 1 : value.quantity,
        serialNumber: null, batchNumber: null })}><option value="BATCH">{tx('批次', 'Batch')}</option><option value="SERIAL">{tx('序号件', 'Serial')}</option></select></Label>
      {numberField('quantity', '实物数量', 'Quantity', 1)}
      <Label className="grid gap-2">{value.trackingType === 'SERIAL' ? tx('序号', 'Serial number') : tx('批次号', 'Batch number')}<Input
        value={(value.trackingType === 'SERIAL' ? value.serialNumber : value.batchNumber) || ''}
        onChange={event => update(value.trackingType === 'SERIAL' ? 'serialNumber' : 'batchNumber', event.target.value || null)} /></Label>
      <Label className="grid gap-2">{tx('状态代码', 'Condition code')}<Input value={value.conditionCode} maxLength={64} onChange={event => update('conditionCode', event.target.value)} /></Label>
      <Label className="grid gap-2">{tx('证书类型', 'Certificate type')}<Input value={value.certificateType || ''} onChange={event => update('certificateType', event.target.value || null)} /></Label>
      <Label className="grid gap-2">{tx('证书编号', 'Certificate number')}<Input value={value.certificateNumber || ''} onChange={event => update('certificateNumber', event.target.value || null)} /></Label>
      {numberField('remainingHours', '剩余小时', 'Remaining hours')}
      {numberField('remainingCycles', '剩余循环', 'Remaining cycles')}
      {numberField('shelfLifeDays', '货架期天数', 'Shelf life days')}
      <Label className="grid gap-2">{tx('保存条件', 'Storage conditions')}<Input value={value.storageCondition || ''} onChange={event => update('storageCondition', event.target.value || null)} /></Label>
      {(['shelfLifeDate', 'nextOverhaulDue'] as const).map(key => <Label key={key} className="grid gap-2">{key === 'shelfLifeDate' ? tx('货架期截止', 'Shelf life expiry') : tx('下次检修截止', 'Next overhaul due')}
        <Input type="datetime-local" value={value[key] ? localDateTime(value[key]) : ''} onChange={event => update(key, event.target.value ? new Date(event.target.value).toISOString() : null)} /></Label>)}
    </div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.lifeLimited ?? false} onChange={event => update('lifeLimited', event.target.checked)} />{tx('寿命限制件', 'Life limited part')}</label>
    <div className="space-y-2 text-sm"><p className="font-medium">{tx('关联已签发的实物证书', 'Link issued physical certificates')}</p>
      {loading && <p role="status">{tx('加载证书…', 'Loading certificates…')}</p>}
      {!loading && !certificates.length && !error && <p className="text-muted-foreground">{tx('没有匹配的供应商证书；如业务要求证书，请先补齐证书资料。', 'No matching supplier certificate. Add certificate evidence if required.')}</p>}
      {certificates.map(row => <label className="flex items-center gap-2" key={row.id}><input type="checkbox" disabled={!row.fileHash || disabled}
        checked={Boolean(value.certificateReferences?.some(ref => ref.id === row.id))} onChange={event => update('certificateReferences', event.target.checked && row.fileHash
          ? [...(value.certificateReferences || []), { id: row.id, fileHash: row.fileHash }]
          : (value.certificateReferences || []).filter(ref => ref.id !== row.id))} />
        {row.certificateNumber} · {row.certificateType} · {row.serialNumber || row.batchNumber || '—'}
        {!row.fileHash && <span>{tx('缺少文件证据', 'Missing file evidence')}</span>}</label>)}
      {error && <p role="alert" className="text-red-600">{error}</p>}
    </div>
  </fieldset>;
}
