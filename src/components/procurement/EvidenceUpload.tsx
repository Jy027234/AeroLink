import { useEffect, useRef, useState } from 'react';
import { qualityReviewApi } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import { downloadBlob } from '@/lib/downloadBlob';

export type EvidenceFile = { id: string; originalName: string };
export function EvidenceUpload({ value, onChange, disabled, label, onBusyChange }: {
  value: EvidenceFile[]; onChange: (value: EvidenceFile[]) => void; disabled?: boolean; label?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <div className="space-y-2">
    <Label className="block">{label || tx('附件证据（最多 20 个）', 'Evidence (up to 20 files)')}
      <Input type="file" multiple disabled={disabled || busy || value.length >= 20} onChange={async event => {
        const files = Array.from(event.target.files || []); event.target.value = '';
        if (files.length + value.length > 20) { setError(tx('附件不能超过 20 个', 'At most 20 files')); return; }
        setBusy(true); onBusyChange?.(true); setError('');
        const next = [...value];
        try {
          for (const file of files) {
            const uploaded = await qualityReviewApi.uploadEvidence(file);
            if (!mounted.current) return;
            next.push(uploaded); onChange([...next]);
          }
        } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : tx('上传失败', 'Upload failed')); }
        finally { if (mounted.current) { setBusy(false); onBusyChange?.(false); } }
      }} />
    </Label>
    {busy && <p role="status" className="text-sm">{tx('正在上传证据…', 'Uploading evidence…')}</p>}
    {value.map(file => <div className="flex items-center justify-between gap-2 text-sm" key={file.id}>
      <span className="break-all">{file.originalName}</span>
      <Button type="button" size="sm" variant="ghost" disabled={disabled || busy} onClick={() => onChange(value.filter(row => row.id !== file.id))}>{tx('移除', 'Remove')}</Button>
    </div>)}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </div>;
}

export function EvidenceDownload({ id, label }: { id: string; label?: string }) {
  const { locale } = useTranslation();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <span><Button type="button" size="sm" variant="link" disabled={busy} onClick={async () => {
    setBusy(true); setError('');
    try { downloadBlob(await qualityReviewApi.getEvidenceBlob(id), 'evidence'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Download failed'); }
    finally { setBusy(false); }
  }}>{label || (locale === 'zh-CN' ? '查看附件' : 'View evidence')}</Button>{error && <span role="alert" className="text-sm text-red-600">{error}</span>}</span>;
}
