import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  Package,
  Truck,
  Star,
  CheckCircle,
  AlertTriangle,
  Send,
  FileText,
  Mail,
  Phone,
  MapPin,
  Loader2,
  Search,
  SortAsc,
  Filter,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Clock3,
  Eye,
  RefreshCw,
  Download,
  Sparkles,
  Save,
  BadgeCheck,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { downloadBlob } from '@/lib/downloadBlob';
import { useTranslation } from '@/i18n';
import { toast } from 'sonner';
import {
  useRFQs,
  useSuppliers,
  useInventoryItems,
  useCreateInquiry,
  useInquiries,
  useSendInquiry,
  useCompareSupplierQuotes,
  useInquiryEmails,
  useEmails,
} from '@/hooks/useApi';
import { emailApi, fileApi, sourcingAiTaskApi, supplierQuoteDraftApi } from '@/api/client';
import type { Email, RFQ, Supplier, InventoryItem } from '@/types';
import type {
  Inquiry,
  InquiryDeliveryStatus,
  SupplierQuoteCompareResult,
  SupplierQuoteDraftPayload,
  SupplierQuoteDraftRecord,
  SourcingAiTaskRecord,
} from '@/api/client';

type InquiryProgressState = 'draft' | 'queued' | 'sent' | 'failed' | 'skipped' | 'pending' | 'responded' | 'closed';

interface SourcingDemandLine {
  key: string;
  rfqLineId: string | null;
  lineNo: number;
  partNumber: string;
  quantity: number;
  uom: string;
  requiredDate: string;
  certificateRequired: boolean;
}

interface LineCompareState {
  loading: boolean;
  result?: SupplierQuoteCompareResult;
  error?: string;
}

function getInquiryProgressState(inquiry: Inquiry): InquiryProgressState {
  const rawDeliveryStatus = inquiry.deliveryStatus
    ?? inquiry.latestOutboundEmail?.status
    ?? null;
  const deliveryStatus = typeof rawDeliveryStatus === 'string' ? rawDeliveryStatus.toLowerCase() : '';
  const recognizedDeliveryStatuses: InquiryDeliveryStatus[] = ['pending', 'queued', 'sent', 'failed', 'skipped'];
  if (recognizedDeliveryStatuses.includes(deliveryStatus as InquiryDeliveryStatus)) {
    return deliveryStatus as InquiryProgressState;
  }

  const inquiryStatus = String(inquiry.status).toLowerCase();
  if (inquiryStatus === 'queued') return 'queued';
  if (inquiryStatus === 'sent') return 'sent';
  if (inquiryStatus === 'responded') return 'responded';
  if (inquiryStatus === 'closed') return 'closed';
  return 'draft';
}

function getInquiryStateLabel(state: InquiryProgressState, tx: (zh: string, en: string) => string) {
  const labels: Record<InquiryProgressState, [string, string]> = {
    draft: ['草稿', 'Draft'],
    queued: ['排队中', 'Queued'],
    sent: ['已发送', 'Sent'],
    failed: ['发送失败', 'Failed'],
    skipped: ['未发送', 'Skipped'],
    pending: ['发送处理中', 'Pending'],
    responded: ['已回复', 'Responded'],
    closed: ['已关闭', 'Closed'],
  };
  return tx(...labels[state]);
}

function createManualQuoteDraft(inquiry: Inquiry): SupplierQuoteDraftPayload {
  return {
    items: inquiry.items.map((item, index) => ({
      itemKey: `inquiry-item:${item.id ?? item.rfqLineId ?? item.lineNo ?? index + 1}`,
      inquiryItemId: item.id ?? null,
      partNumber: item.partNumber || null,
      quantity: item.quantity ?? null,
      unitPrice: null,
      currency: null,
      leadTimeDays: null,
      validUntil: null,
      taxIncluded: null,
      freightIncluded: null,
      incoterm: null,
      evidenceText: null,
    })),
  };
}

function getQuoteDraftConfirmIssues(payload: SupplierQuoteDraftPayload | null, tx: (zh: string, en: string) => string) {
  if (!payload || payload.items.length === 0) return [tx('草稿至少需要一条报价行。', 'The draft must contain at least one quote item.')];
  const issues: string[] = [];
  payload.items.forEach((item, index) => {
    const row = tx(`第 ${index + 1} 项`, `Item ${index + 1}`);
    if (!item.itemKey.trim()) issues.push(`${row}: ${tx('缺少稳定行标识。', 'stable item key is missing.')}`);
    if (!item.inquiryItemId?.trim()) issues.push(`${row}: ${tx('缺少询价需求项。', 'inquiry item is required.')}`);
    if (!item.partNumber?.trim()) issues.push(`${row}: ${tx('缺少件号。', 'part number is required.')}`);
    if (!Number.isInteger(item.quantity) || (item.quantity ?? 0) < 1) issues.push(`${row}: ${tx('数量必须是正整数。', 'quantity must be a positive integer.')}`);
    if (typeof item.unitPrice !== 'number' || !Number.isFinite(item.unitPrice) || item.unitPrice < 0) issues.push(`${row}: ${tx('请填写有效单价。', 'enter a valid unit price.')}`);
    if (item.currency?.trim().toUpperCase() !== 'USD') issues.push(`${row}: ${tx('确认仅支持 USD 币种。', 'confirmation only supports USD.')}`);
    if (item.leadTimeMinDays != null || item.leadTimeMaxDays != null) issues.push(`${row}: ${tx('当前是交期区间，请填写单一交期。', 'lead time is a range; enter one single value.')}`);
    if (!Number.isInteger(item.leadTimeDays) || (item.leadTimeDays ?? -1) < 0) issues.push(`${row}: ${tx('请填写单一交期天数。', 'enter one lead time in days.')}`);
  });
  return issues;
}

function getThreadMatchLabel(status: string | null | undefined, tx: (zh: string, en: string) => string) {
  const normalized = status?.toUpperCase() ?? '';
  if (normalized.includes('MANUAL')) return tx('人工匹配', 'Manually matched');
  if (normalized.includes('PENDING')) return tx('待核对', 'Pending review');
  if (normalized.includes('UNMATCH') || normalized.includes('REVIEW')) return tx('未确认匹配', 'Unconfirmed match');
  if (normalized.includes('MATCH')) return tx('已匹配', 'Matched');
  return status || tx('未标记', 'Unclassified');
}

function normalizeMailboxAddress(value: string | null | undefined): string {
  if (!value) return '';
  const bracketed = value.match(/<([^<>]+)>/);
  return (bracketed?.[1] ?? value).trim().toLowerCase();
}

function formatCommercialTerm(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => formatCommercialTerm(item)).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getComparisonIssueLabel(code: string, tx: (zh: string, en: string) => string): string {
  const labels: Record<string, [string, string]> = {
    EXPIRED: ['报价已过期', 'Quote expired'],
    CURRENCY_NOT_VERIFIED_USD: ['币种不是已核验的 USD', 'Currency is not verified USD'],
    STATUS_NOT_AVAILABLE: ['报价状态不可用', 'Quote status is unavailable'],
    VALID_UNTIL_UNKNOWN: ['未提供报价有效期', 'Validity date is missing'],
    PARTIAL_QUANTITY: ['可供数量不足', 'Available quantity is insufficient'],
    CONDITION_UNKNOWN: ['未提供成色/状态', 'Condition is missing'],
    CERTIFICATE_UNKNOWN: ['未提供证书声明', 'Certificate statement is missing'],
    CERTIFICATE_REQUIRED_MISSING: ['需求要求证书，但供应商未提供', 'A certificate is required but not provided'],
    CERTIFICATE_REQUIREMENT_CONFLICT: ['证书声明与需求冲突', 'Certificate statement conflicts with the requirement'],
    CERTIFICATE_REQUIREMENT_UNKNOWN: ['无法确认是否满足证书要求', 'Certificate compliance is unknown'],
    TAX_BASIS_UNKNOWN: ['未说明是否含税', 'Tax basis is missing'],
    FREIGHT_BASIS_UNKNOWN: ['未说明是否含运费', 'Freight basis is missing'],
    INCOTERM_UNKNOWN: ['未说明贸易术语', 'Incoterm is missing'],
  };
  const label = labels[code];
  return label ? tx(...label) : code;
}

interface ReplyReviewDialogProps {
  inquiry: Inquiry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tx: (zh: string, en: string) => string;
  onConfirmed: () => Promise<void>;
}

function ReplyReviewDialog({ inquiry, open, onOpenChange, tx, onConfirmed }: ReplyReviewDialogProps) {
  const { data: emails, loading: emailsLoading, error: emailsError } = useInquiryEmails(open ? inquiry?.id : null);
  const [selectedEmailId, setSelectedEmailId] = useState('');
  const [draft, setDraft] = useState<SupplierQuoteDraftRecord | null>(null);
  const [draftPayload, setDraftPayload] = useState<SupplierQuoteDraftPayload | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [isDraftDirty, setIsDraftDirty] = useState(false);
  const [busyAction, setBusyAction] = useState<'extract' | 'create' | 'save' | 'confirm' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmedQuoteIds, setConfirmedQuoteIds] = useState<string[]>([]);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);
  const [extractionTask, setExtractionTask] = useState<SourcingAiTaskRecord | null>(null);
  const extractionKeyBySource = useRef<Record<string, string>>({});
  const txRef = useRef(tx);
  txRef.current = tx;

  const selectedEmail = emails?.find((email) => email.id === selectedEmailId) ?? null;
  const confirmIssues = useMemo(() => getQuoteDraftConfirmIssues(draftPayload, tx), [draftPayload, tx]);
  const isBusy = busyAction !== null;

  const applyExtractionTask = useCallback(async (task: SourcingAiTaskRecord) => {
    setExtractionTask(task);
    if (task.status === 'COMPLETED' && task.draftId) {
      const extracted = await supplierQuoteDraftApi.getById(task.draftId);
      setDraft(extracted);
      setDraftPayload(extracted.payload);
      setIsDraftDirty(false);
      setConfirmedQuoteIds([]);
      setActionError(null);
      return;
    }
    if (task.status === 'FAILED') {
      setActionError(task.errorSummary || txRef.current('AI 提取失败，请重试或改用手工草稿。', 'AI extraction failed. Retry or create a manual draft.'));
      return;
    }
    if (task.status === 'CANCELLED') {
      setActionError(txRef.current('AI 提取任务已取消，可改用手工草稿。', 'The AI extraction task was cancelled. You can create a manual draft.'));
      return;
    }
    setActionError(null);
  }, []);

  useEffect(() => {
    setSelectedEmailId('');
    setDraft(null);
    setDraftPayload(null);
    setIsDraftDirty(false);
    setActionError(null);
    setConfirmedQuoteIds([]);
    setExtractionTask(null);
  }, [inquiry?.id]);

  useEffect(() => {
    if (!selectedEmailId && emails?.length) setSelectedEmailId(emails[0].id);
    if (selectedEmailId && emails && !emails.some((email) => email.id === selectedEmailId)) setSelectedEmailId('');
  }, [emails, selectedEmailId]);

  useEffect(() => {
    if (!open || !inquiry?.id || !selectedEmailId) return;
    let active = true;
    setDraftLoading(true);
    setActionError(null);
    setExtractionTask(null);
    void Promise.all([
      supplierQuoteDraftApi.getLatest(selectedEmailId, inquiry.id),
      sourcingAiTaskApi.list({ limit: 1, emailId: selectedEmailId, inquiryId: inquiry.id }).catch(() => []),
    ])
      .then(async ([latest, tasks]) => {
        if (!active) return;
        setDraft(latest);
        setDraftPayload(latest?.payload ?? null);
        setIsDraftDirty(false);
        setConfirmedQuoteIds(latest?.status === 'CONFIRMED'
          ? latest.supplierQuotes.map((quote) => quote.id)
          : []);
        const recoveredTask = tasks.find((task) => task.emailId === selectedEmailId && task.inquiryId === inquiry.id) ?? null;
        if (!latest && recoveredTask) await applyExtractionTask(recoveredTask);
        else setExtractionTask(recoveredTask);
      })
      .catch((error) => {
        if (!active) return;
        setDraft(null);
        setDraftPayload(null);
        setActionError(error instanceof Error ? error.message : '报价草稿恢复失败。');
      })
      .finally(() => {
        if (active) setDraftLoading(false);
      });
    return () => { active = false; };
  }, [applyExtractionTask, inquiry?.id, open, selectedEmailId]);

  useEffect(() => {
    if (!open || !extractionTask || !['PENDING', 'RUNNING'].includes(extractionTask.status)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void sourcingAiTaskApi.getById(extractionTask.id)
        .then((task) => {
          if (active) return applyExtractionTask(task);
        })
        .catch((error) => {
          if (active) setActionError(error instanceof Error ? error.message : txRef.current('AI 任务状态刷新失败。', 'Could not refresh the AI task status.'));
        });
    }, 1_000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [applyExtractionTask, extractionTask, open]);

  const handleCreateDraft = async () => {
    if (!inquiry || !selectedEmail) return;
    setBusyAction('create');
    setActionError(null);
    try {
      const created = await supplierQuoteDraftApi.create({ emailId: selectedEmail.id, inquiryId: inquiry.id, payload: createManualQuoteDraft(inquiry) });
      setDraft(created);
      setDraftPayload(created.payload);
      setIsDraftDirty(false);
      setConfirmedQuoteIds([]);
      setExtractionTask(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tx('手工草稿创建失败。', 'Could not create the manual draft.'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleExtractDraft = async () => {
    if (!inquiry || !selectedEmail) return;
    setBusyAction('extract');
    setActionError(null);
    try {
      const sourceKey = `${selectedEmail.id}:${inquiry.id}`;
      const idempotencyKey = extractionKeyBySource.current[sourceKey]
        ?? globalThis.crypto?.randomUUID?.()
        ?? `quote-extraction-${Date.now()}`;
      extractionKeyBySource.current[sourceKey] = idempotencyKey;
      const task = await sourcingAiTaskApi.create({
        type: 'supplier_quote_extraction',
        emailId: selectedEmail.id,
        inquiryId: inquiry.id,
        idempotencyKey,
      });
      await applyExtractionTask(task);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tx('AI 提取失败，请改用手工草稿。', 'AI extraction failed. You can create a manual draft instead.'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRetryExtraction = async () => {
    if (!extractionTask || extractionTask.status !== 'FAILED') return;
    setBusyAction('extract');
    setActionError(null);
    try {
      await applyExtractionTask(await sourcingAiTaskApi.retry(extractionTask.id));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tx('AI 任务重试失败。', 'Could not retry the AI task.'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelExtraction = async () => {
    if (!extractionTask || !selectedEmail || !inquiry || !['PENDING', 'RUNNING', 'FAILED'].includes(extractionTask.status)) return;
    setBusyAction('extract');
    try {
      await applyExtractionTask(await sourcingAiTaskApi.cancel(extractionTask.id));
      delete extractionKeyBySource.current[`${selectedEmail.id}:${inquiry.id}`];
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tx('AI 任务取消失败。', 'Could not cancel the AI task.'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveDraft = async () => {
    if (!draft || !draftPayload) return;
    setBusyAction('save');
    setActionError(null);
    try {
      const updated = await supplierQuoteDraftApi.update(draft.id, { expectedVersion: draft.version, payload: draftPayload });
      setDraft(updated);
      setDraftPayload(updated.payload);
      setIsDraftDirty(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tx('保存失败，请检查草稿版本后重试。', 'Save failed. Check the draft version and try again.'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmDraft = async () => {
    if (!draft || !draftPayload || isDraftDirty || confirmIssues.length > 0) return;
    setBusyAction('confirm');
    setActionError(null);
    try {
      const result = await supplierQuoteDraftApi.confirm(draft.id, { expectedVersion: draft.version });
      if (result.draftId !== draft.id || !Array.isArray(result.supplierQuoteIds) || result.supplierQuoteIds.length === 0) {
        throw new Error(tx('服务端未返回正式报价 ID，暂不能确认成功。', 'The server did not return supplier quote IDs, so confirmation cannot be reported as successful.'));
      }
      setDraft((current) => current ? {
        ...current,
        status: result.status,
        version: result.version,
        supplierQuotes: result.supplierQuotes,
      } : current);
      setConfirmedQuoteIds(result.supplierQuoteIds);
      void onConfirmed();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tx('确认报价失败。', 'Could not confirm the quote.'));
      setConfirmedQuoteIds([]);
    } finally {
      setBusyAction(null);
    }
  };

  const handleAttachmentDownload = async (attachment: NonNullable<Email['attachmentRecords']>[number]) => {
    setDownloadingAttachmentId(attachment.id);
    setActionError(null);
    try {
      downloadBlob(await fileApi.download(attachment.storedObjectId), attachment.filename);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : tx('附件下载失败。', 'Could not download the attachment.'));
    } finally {
      setDownloadingAttachmentId(null);
    }
  };

  const updateDraftItem = (itemKey: string, updater: (item: SupplierQuoteDraftPayload['items'][number]) => SupplierQuoteDraftPayload['items'][number]) => {
    setDraftPayload((current) => current ? ({ ...current, items: current.items.map((item) => item.itemKey === itemKey ? updater(item) : item) }) : current);
    setIsDraftDirty(true);
    setConfirmedQuoteIds([]);
  };
  const numericValue = (value: string) => value.trim() === '' ? null : Number(value);
  const selectedInquiryLink = selectedEmail?.inquiryLinks?.find((link) => link.inquiryId === inquiry?.id);
  const hasLeadTimeRange = draftPayload?.items.some((item) => item.leadTimeMinDays != null || item.leadTimeMaxDays != null) ?? false;
  const hasNonUsd = draftPayload?.items.some((item) => item.currency?.trim().toUpperCase() !== 'USD') ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tx('回邮核对', 'Reply review')} · {inquiry?.supplierName ?? ''}</DialogTitle>
          <DialogDescription>{inquiry?.inquiryNumber} · {tx('核对邮件与附件后，将报价整理为版本化草稿并确认入比价。', 'Review the message and attachments, then save a versioned quote draft and confirm it into comparison.')}</DialogDescription>
        </DialogHeader>

        {!inquiry ? null : <div className="space-y-5 py-2">
          {emailsLoading && <p className="text-sm text-gray-500" role="status">{tx('正在加载关联邮件…', 'Loading linked emails…')}</p>}
          {emailsError && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{tx('邮件加载失败', 'Could not load emails')}: {emailsError}</p>}
          {!emailsLoading && !emailsError && (emails?.length ?? 0) === 0 && <p className="rounded border border-dashed p-4 text-sm text-gray-500">{tx('此询价暂时没有已关联的回邮。', 'No replies are linked to this inquiry yet.')}</p>}

          {(emails?.length ?? 0) > 0 && selectedEmail && <section className="space-y-3 rounded-lg border p-4" aria-label={tx('邮件内容', 'Email contents')}>
            {emails!.length > 1 && <div className="space-y-1">
              <Label htmlFor="reply-email-select">{tx('选择回邮', 'Select reply')}</Label>
              <select id="reply-email-select" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={selectedEmailId} onChange={(event) => {
                setSelectedEmailId(event.target.value); setDraft(null); setDraftPayload(null); setIsDraftDirty(false); setActionError(null); setConfirmedQuoteIds([]); setExtractionTask(null);
              }}>
                {emails!.map((email) => <option key={email.id} value={email.id}>{email.fromName || email.from} · {email.subject}</option>)}
              </select>
            </div>}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <p><span className="text-sm text-gray-500">{tx('发件人', 'From')}:</span> {selectedEmail.fromName ? `${selectedEmail.fromName} <${selectedEmail.from}>` : selectedEmail.from}</p>
                <p><span className="text-sm text-gray-500">{tx('主题', 'Subject')}:</span> {selectedEmail.subject || '—'}</p>
                <p className="text-sm text-gray-500"><span>{tx('时间', 'Received')}:</span> {selectedEmail.receivedAt}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{tx('线程匹配', 'Thread match')}: {getThreadMatchLabel(selectedEmail.threadMatchStatus, tx)}</Badge>
                {selectedInquiryLink && <Badge variant="secondary">{tx('询价关联', 'Inquiry link')}: {selectedInquiryLink.confirmationStatus}</Badge>}
              </div>
            </div>
            {(selectedEmail.threadMatchReason || selectedEmail.reason) && <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">{selectedEmail.threadMatchReason || selectedEmail.reason}</p>}
            <div>
              <p className="mb-1 text-sm font-medium">{tx('正文', 'Message')}</p>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-3 text-sm font-sans">{selectedEmail.body || tx('（无正文）', '(No message body)')}</pre>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">{tx('附件', 'Attachments')} ({selectedEmail.attachmentRecords?.length ?? 0})</p>
              {(selectedEmail.attachmentStatus === 'PARTIAL' || selectedEmail.attachmentStatus === 'REJECTED') && <p className="mb-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" role="alert">{selectedEmail.attachmentError || tx('部分或全部附件未能安全保存，请人工核对原始邮件。', 'Some or all attachments could not be stored safely. Review the original email.')}</p>}
              {(selectedEmail.attachmentRecords?.length ?? 0) === 0 ? <p className="text-sm text-gray-500">{tx('无附件', 'No attachments')}</p> : <ul className="space-y-1">
                {selectedEmail.attachmentRecords?.map((attachment) => <li key={attachment.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-sm">
                  <span>{attachment.filename} <span className="text-gray-500">({Math.ceil(attachment.sizeBytes / 1024)} KB)</span></span>
                  {attachment.downloadUrl ? <Button type="button" variant="ghost" size="sm" onClick={() => void handleAttachmentDownload(attachment)} disabled={downloadingAttachmentId === attachment.id}><Download className="mr-1 h-4 w-4" />{downloadingAttachmentId === attachment.id ? tx('下载中…', 'Downloading…') : tx('下载', 'Download')}</Button> : <span className="text-gray-500">{tx('暂不可下载', 'Unavailable')}</span>}
                </li>)}
              </ul>}
            </div>
          </section>}

          {draftLoading && <p className="text-sm text-gray-500" role="status">{tx('正在恢复已有报价草稿…', 'Restoring the existing quote draft…')}</p>}
          {selectedEmail && !draft && !draftLoading && <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void handleExtractDraft()} disabled={isBusy || ['PENDING', 'RUNNING'].includes(extractionTask?.status ?? '')}><Sparkles className="mr-1 h-4 w-4" />{busyAction === 'extract' ? tx('提交中…', 'Submitting…') : tx('AI 提取草稿', 'Extract draft with AI')}</Button>
            <Button type="button" onClick={() => void handleCreateDraft()} disabled={isBusy}>{busyAction === 'create' ? tx('创建中…', 'Creating…') : tx('新建手工草稿', 'Create manual draft')}</Button>
          </div>}
          {actionError && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{actionError}</p>}
          {extractionTask && ['PENDING', 'RUNNING'].includes(extractionTask.status) && !draft && <div className="flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900" role="status">
            <Loader2 className="h-4 w-4 animate-spin" /><span>{extractionTask.status === 'PENDING' ? tx('AI 提取任务已排队，页面将自动刷新结果。', 'AI extraction is queued. This page will refresh automatically.') : tx('AI 正在后台提取报价，页面将自动刷新结果。', 'AI is extracting the quote in the background. This page will refresh automatically.')}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => void handleCancelExtraction()} disabled={isBusy}>{tx('取消任务', 'Cancel task')}</Button>
          </div>}
          {extractionTask?.status === 'FAILED' && !draft && <div className="flex flex-wrap items-center gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <span>{tx(`AI 任务失败（第 ${extractionTask.attempt}/${extractionTask.maxAttempts} 次）。`, `AI task failed (attempt ${extractionTask.attempt}/${extractionTask.maxAttempts}).`)}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void handleRetryExtraction()} disabled={isBusy || extractionTask.attempt >= extractionTask.maxAttempts}>{tx('重试任务', 'Retry task')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void handleCancelExtraction()} disabled={isBusy}>{tx('取消任务', 'Cancel task')}</Button>
          </div>}

          {draft && draftPayload && <section className="space-y-4 rounded-lg border p-4" aria-label={tx('报价草稿编辑', 'Quote draft editor')}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h3 className="font-semibold">{tx('报价草稿', 'Quote draft')} · v{draft.version}</h3><p className="text-xs text-gray-500">{tx('状态', 'Status')}: {draft.status}</p></div>
              {confirmedQuoteIds.length > 0 && <Badge className="bg-green-100 text-green-800"><BadgeCheck className="mr-1 h-4 w-4" />{tx('已确认', 'Confirmed')}</Badge>}
            </div>
            {hasNonUsd && <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{tx('草稿中有非 USD 或未填写币种的行，需改为 USD 才能确认。', 'At least one item is not USD or has no currency. Set it to USD before confirmation.')}</p>}
            {hasLeadTimeRange && <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{tx('草稿中包含交期区间。确认报价前请为每项填写单一交期天数。', 'The draft contains a lead-time range. Enter one lead-time value for each item before confirmation.')}</p>}
            <div className="space-y-4">
              {draftPayload.items.map((item, index) => <fieldset key={item.itemKey} className="space-y-3 rounded border p-3">
                <legend className="px-1 text-sm font-medium">{tx(`报价项 ${index + 1}`, `Quote item ${index + 1}`)}</legend>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="space-y-1"><Label htmlFor={`draft-item-${index}`}>{tx('询价需求项', 'Inquiry item')} {index + 1}</Label><Input id={`draft-item-${index}`} value={item.inquiryItemId ?? ''} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, inquiryItemId: event.target.value || null }))} /></div>
                  <div className="space-y-1"><Label htmlFor={`draft-part-${index}`}>{tx('件号', 'Part number')} {index + 1}</Label><Input id={`draft-part-${index}`} value={item.partNumber ?? ''} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, partNumber: event.target.value || null }))} /></div>
                  <div className="space-y-1"><Label htmlFor={`draft-qty-${index}`}>{tx('数量', 'Quantity')} {index + 1}</Label><Input id={`draft-qty-${index}`} type="number" min="1" step="1" value={item.quantity ?? ''} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, quantity: numericValue(event.target.value) }))} /></div>
                  <div className="space-y-1"><Label htmlFor={`draft-price-${index}`}>{tx('单价', 'Unit price')} {index + 1}</Label><Input id={`draft-price-${index}`} type="number" min="0" step="any" value={item.unitPrice ?? ''} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, unitPrice: numericValue(event.target.value) }))} /></div>
                  <div className="space-y-1"><Label htmlFor={`draft-currency-${index}`}>{tx('币种', 'Currency')} {index + 1}</Label><Input id={`draft-currency-${index}`} maxLength={3} value={item.currency ?? ''} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, currency: event.target.value.toUpperCase() || null }))} /></div>
                  <div className="space-y-1"><Label htmlFor={`draft-lead-${index}`}>{tx('交期（天，单值）', 'Lead time (days, single value)')} {index + 1}</Label><Input id={`draft-lead-${index}`} type="number" min="0" step="1" value={item.leadTimeDays ?? ''} onChange={(event) => updateDraftItem(item.itemKey, (current) => {
                    const next = { ...current, leadTimeDays: numericValue(event.target.value) };
                    delete next.leadTimeMinDays;
                    delete next.leadTimeMaxDays;
                    return next;
                  })} />{(item.leadTimeMinDays != null || item.leadTimeMaxDays != null) && <span className="text-xs text-amber-700">{tx('原提取交期区间', 'Extracted range')}: {item.leadTimeMinDays ?? '—'}–{item.leadTimeMaxDays ?? '—'} {tx('天', 'days')}</span>}</div>
                  <div className="space-y-1"><Label htmlFor={`draft-valid-${index}`}>{tx('有效期至', 'Valid until')} {index + 1}</Label><Input id={`draft-valid-${index}`} type="date" value={item.validUntil ?? ''} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, validUntil: event.target.value || null }))} /></div>
                  <div className="space-y-1"><Label htmlFor={`draft-tax-${index}`}>{tx('税费口径', 'Tax basis')} {index + 1}</Label><select id={`draft-tax-${index}`} className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={item.taxIncluded == null ? 'unknown' : item.taxIncluded ? 'included' : 'excluded'} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, taxIncluded: event.target.value === 'unknown' ? null : event.target.value === 'included' }))}><option value="unknown">{tx('未说明', 'Unknown')}</option><option value="included">{tx('含税', 'Tax included')}</option><option value="excluded">{tx('未含税', 'Tax excluded')}</option></select></div>
                  <div className="space-y-1"><Label htmlFor={`draft-freight-${index}`}>{tx('运费口径', 'Freight basis')} {index + 1}</Label><select id={`draft-freight-${index}`} className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={item.freightIncluded == null ? 'unknown' : item.freightIncluded ? 'included' : 'excluded'} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, freightIncluded: event.target.value === 'unknown' ? null : event.target.value === 'included' }))}><option value="unknown">{tx('未说明', 'Unknown')}</option><option value="included">{tx('含运费', 'Freight included')}</option><option value="excluded">{tx('未含运费', 'Freight excluded')}</option></select></div>
                  <div className="space-y-1"><Label htmlFor={`draft-incoterm-${index}`}>{tx('贸易术语', 'Incoterm')} {index + 1}</Label><Input id={`draft-incoterm-${index}`} minLength={2} maxLength={20} value={item.incoterm ?? ''} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, incoterm: event.target.value.toUpperCase() || null }))} placeholder="EXW / FCA / DDP" /></div>
                </div>
                <div className="space-y-1"><Label htmlFor={`draft-evidence-${index}`}>{tx('报价依据', 'Evidence')} {index + 1}</Label><Textarea id={`draft-evidence-${index}`} value={item.evidenceText ?? ''} maxLength={10000} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, evidenceText: event.target.value || null }))} placeholder={tx('摘录邮件中的报价依据或相关说明', 'Quote evidence or supporting text from the email')} /></div>
              </fieldset>)}
            </div>
            {confirmIssues.length > 0 && <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="mb-1 font-medium">{tx('以下缺项或格式不符合确认要求：', 'Complete or correct these fields before confirming:')}</p><ul className="list-inside list-disc">{confirmIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
            {isDraftDirty && <p className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">{tx('草稿有未保存的修改，请先保存后再确认。', 'The draft has unsaved edits. Save it before confirming.')}</p>}
            {confirmedQuoteIds.length > 0 && <p className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900" role="status">{tx('已创建正式报价并刷新逐行比价。报价 ID：', 'Supplier quotes created and line comparison refreshed. Quote IDs:')} {confirmedQuoteIds.join(', ')}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => void handleSaveDraft()} disabled={isBusy || confirmedQuoteIds.length > 0}><Save className="mr-1 h-4 w-4" />{busyAction === 'save' ? tx('保存中…', 'Saving…') : tx('保存草稿', 'Save draft')}</Button>
              <Button type="button" onClick={() => void handleConfirmDraft()} disabled={isBusy || isDraftDirty || confirmIssues.length > 0 || confirmedQuoteIds.length > 0}>{busyAction === 'confirm' ? tx('确认中…', 'Confirming…') : tx('确认并录入比价', 'Confirm into comparison')}</Button>
            </DialogFooter>
          </section>}
        </div>}
      </DialogContent>
    </Dialog>
  );
}

function inquiryIncludesLine(inquiry: Inquiry, line: SourcingDemandLine, samePartNumberLineCount: number) {
  return inquiry.items.some((item) => {
    if (item.rfqLineId) return item.rfqLineId === line.rfqLineId;
    if (item.partNumber !== line.partNumber) return false;
    return !line.rfqLineId || samePartNumberLineCount === 1;
  });
}

function createInquiryEmail(inquiry: Inquiry, rfq: RFQ, lines: SourcingDemandLine[], locale: string) {
  const isChinese = locale === 'zh-CN';
  const uniquePartNumbers = [...new Set(inquiry.items.map((item) => item.partNumber))];
  const subject = isChinese
    ? `航材询价 ${inquiry.inquiryNumber} / ${rfq.rfqNumber}：${uniquePartNumbers.join(', ')}`
    : `Quotation request ${inquiry.inquiryNumber} / ${rfq.rfqNumber}: ${uniquePartNumbers.join(', ')}`;
  const itemText = inquiry.items.map((item) => {
    const line = item.rfqLineId
      ? lines.find((candidate) => candidate.rfqLineId === item.rfqLineId)
      : lines.find((candidate) => candidate.partNumber === item.partNumber);
    const lineLabel = item.lineNo ?? line?.lineNo;
    const date = item.requiredDate || line?.requiredDate || '—';
    if (isChinese) {
      return `- ${lineLabel ? `行 ${lineLabel} · ` : ''}${item.partNumber}，数量 ${item.quantity}，要求日期 ${date}，${item.certificateRequired ? '需要' : '不需要'}合格证`;
    }
    return `- ${lineLabel ? `Line ${lineLabel} · ` : ''}${item.partNumber}, quantity ${item.quantity}, required by ${date}, certificate ${item.certificateRequired ? 'required' : 'not required'}`;
  }).join('\n');
  const body = isChinese
    ? `您好，${inquiry.supplierName}：\n\n询价单号：${inquiry.inquiryNumber}\n需求单号：${rfq.rfqNumber}\n\n请针对以下需求提供报价：\n${itemText}\n\n${inquiry.isAOG ? '此询价为 AOG 紧急需求。\n\n' : ''}${inquiry.notes ? `备注：${inquiry.notes}\n\n` : ''}请回复单价、币种、交期、报价有效期及可提供的证书。\n\n谢谢。`
    : `Hello ${inquiry.supplierName},\n\nInquiry: ${inquiry.inquiryNumber}\nRequirement: ${rfq.rfqNumber}\n\nPlease provide a quotation for the following requirements:\n${itemText}\n\n${inquiry.isAOG ? 'This is an AOG urgent request.\n\n' : ''}${inquiry.notes ? `Notes: ${inquiry.notes}\n\n` : ''}Please include unit price, currency, lead time, quote validity, and available certificates.\n\nThank you.`;
  return { subject, textBody: body };
}

const levelConfig: Record<Supplier['level'], { label: string; color: string; bgColor: string; stars: number }> = {
  S: { label: 'Strategic Partner', color: 'text-purple-600', bgColor: 'bg-purple-50', stars: 5 },
  A: { label: 'Qualified Supplier', color: 'text-green-600', bgColor: 'bg-green-50', stars: 4 },
  B: { label: 'Use with Caution', color: 'text-yellow-600', bgColor: 'bg-yellow-50', stars: 3 },
  C: { label: 'Blacklisted', color: 'text-red-600', bgColor: 'bg-red-50', stars: 1 },
};

function SupplierCard({ supplier, isSelected, onSelect }: { supplier: Supplier; isSelected: boolean; onSelect: () => void }) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const config = levelConfig[supplier.level];

  return (
    <Card
      className={cn(
        'cursor-pointer transition-all duration-200 hover:shadow-md',
        isSelected && 'ring-2 ring-brand-primary'
      )}
      onClick={onSelect}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <Checkbox checked={isSelected} onClick={(e) => e.stopPropagation()} />
            <div>
              <p className="font-semibold">{supplier.name}</p>
              <p className="text-sm text-gray-500">{supplier.contactName}</p>
            </div>
          </div>
          <Badge className={cn(config.bgColor, config.color)}>
            {supplier.level} {tx('级供应商', 'Level Supplier')}
          </Badge>
        </div>

        <div className="flex items-center gap-1 mt-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              className={cn(
                'w-4 h-4',
                i < config.stars ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'
              )}
            />
          ))}
          <span className="text-sm text-gray-500 ml-2">{tx('评分', 'Score')}: {supplier.performanceScore}</span>
        </div>

        <div className="space-y-1 mt-3 text-sm">
          <p className="flex items-center gap-2 text-gray-600">
            <Mail className="w-4 h-4" />
            {supplier.email}
          </p>
          <p className="flex items-center gap-2 text-gray-600">
            <Phone className="w-4 h-4" />
            {supplier.phone}
          </p>
          <p className="flex items-center gap-2 text-gray-600">
            <MapPin className="w-4 h-4" />
            {supplier.address}
          </p>
        </div>

        <div className="flex items-center justify-between mt-3 pt-3 border-t text-sm">
          <span className="text-gray-500">{tx('付款条款', 'Payment terms')}: {supplier.paymentTerms}</span>
          <span className="text-gray-500">{tx('交期', 'Lead time')}: {supplier.leadTime} {tx('天', 'days')}</span>
        </div>

        {supplier.lastOrderDate && (
          <p className="text-xs text-gray-400 mt-2">
            {tx('最近下单', 'Last order')}: {new Date(supplier.lastOrderDate).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function InventoryMatchCard({ item, rfq }: { item: InventoryItem; rfq: RFQ | null }) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const isMatch = rfq && item.partNumber === rfq.partNumber;
  const isAlternative = rfq?.alternatePartNumbers?.includes(item.partNumber) ?? false;
  const firstDetail = item.details?.[0];

  return (
    <Card className={cn(
      'transition-all duration-200',
      isMatch && 'ring-2 ring-green-500 bg-green-50/30',
      isAlternative && !isMatch && 'ring-2 ring-yellow-500 bg-yellow-50/30'
    )}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <p className="font-mono font-semibold">{item.partNumber}</p>
              {isMatch && (
                <Badge className="bg-green-100 text-green-700">
                  <CheckCircle className="w-3 h-3 mr-1" />
                  {tx('精准匹配', 'Exact Match')}
                </Badge>
              )}
              {isAlternative && !isMatch && (
                <Badge className="bg-yellow-100 text-yellow-700">
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  {tx('需求列明的替代件号', 'Alternate listed in RFQ')}
                </Badge>
              )}
            </div>
            <p className="text-sm text-gray-500">{item.description}</p>
          </div>
          {firstDetail && (
            <Badge variant={firstDetail.conditionCode === 'NE' ? 'default' : 'secondary'}>
              {firstDetail.conditionCode}
            </Badge>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4 mt-4">
          <div>
            <p className="text-xs text-gray-400">{tx('库存', 'Stock')}</p>
            <p className="font-semibold">{item.totalQuantity ?? 0} {tx('件', 'EA')}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">{tx('库位', 'Location')}</p>
            <p className="text-sm">{firstDetail?.location || '-'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400">{tx('成本', 'Cost')}</p>
            <p className="font-semibold">{firstDetail?.unitCost == null ? '—' : `$${firstDetail.unitCost.toLocaleString()}`}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function Sourcing() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const supplierLevelLabel = (level: Supplier['level']) => {
    const labels: Record<Supplier['level'], string> = {
      S: tx('战略伙伴', 'Strategic Partner'),
      A: tx('合格供应商', 'Qualified Supplier'),
      B: tx('谨慎使用', 'Use with Caution'),
      C: tx('黑名单', 'Blacklisted'),
    };
    return labels[level];
  };

  const { data: rfqs, loading: rfqsLoading, error: rfqsError } = useRFQs();
  const { data: suppliers, loading: suppliersLoading, error: suppliersError } = useSuppliers();
  const { data: inventoryItems, loading: inventoryLoading, error: inventoryError } = useInventoryItems();
  const { mutate: createInquiry, loading: inquiryLoading } = useCreateInquiry();
  const { data: inquiries, loading: inquiriesLoading, error: inquiriesError, refetch: refetchInquiries } = useInquiries();
  const {
    data: pendingMatchEmailResult,
    loading: pendingMatchEmailsLoading,
    error: pendingMatchEmailsError,
    refetch: refetchPendingMatchEmails,
  } = useEmails({ needsInquiryMatch: true, page: 1, limit: 100 });
  const { mutate: sendInquiry, loading: sendLoading, error: sendError } = useSendInquiry();
  const { compare } = useCompareSupplierQuotes();

  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  const [selectedRFQs, setSelectedRFQs] = useState<string[]>([]);
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);
  const [isInquiryDialogOpen, setIsInquiryDialogOpen] = useState(false);
  const [inquiryNote, setInquiryNote] = useState('');
  const [isAOG, setIsAOG] = useState(false);
  const [comparisonByLine, setComparisonByLine] = useState<Record<string, LineCompareState>>({});
  const [inquiryUpdates, setInquiryUpdates] = useState<Record<string, Inquiry>>({});
  const [previewInquiryId, setPreviewInquiryId] = useState<string | null>(null);
  const [reviewInquiryId, setReviewInquiryId] = useState<string | null>(null);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [progressRefreshVersion, setProgressRefreshVersion] = useState(0);
  const [pendingMatchInquirySelections, setPendingMatchInquirySelections] = useState<Record<string, string>>({});
  const [pendingMatchReasons, setPendingMatchReasons] = useState<Record<string, string>>({});
  const [pendingMatchLinkErrors, setPendingMatchLinkErrors] = useState<Record<string, string>>({});
  const [linkingEmailId, setLinkingEmailId] = useState<string | null>(null);

  // Filter / sort state
  const [rfqSearch, setRfqSearch] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState<'all' | 'aog' | 'urgent' | 'standard'>('all');
  const [sortBy, setSortBy] = useState<'requiredDate' | 'urgency' | 'createdAt'>('requiredDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [currentPage, setCurrentPage] = useState(1);
  const [supplierSearch, setSupplierSearch] = useState('');
  const pageSize = 10;

  // Pending RFQs
  const pendingRFQs = useMemo(
    () => rfqs?.filter((r) => r.status === 'pending' || r.status === 'sourcing') ?? [],
    [rfqs]
  );

  // Filtered + sorted RFQs
  const filteredRFQs = useMemo(() => {
    let result = pendingRFQs;

    // Search
    if (rfqSearch.trim()) {
      const q = rfqSearch.toLowerCase();
      result = result.filter((r) =>
        r.rfqNumber.toLowerCase().includes(q) ||
        r.partNumber.toLowerCase().includes(q) ||
        r.lines?.some((line) => line.status !== 'CANCELLED' && line.partNumber.toLowerCase().includes(q)) ||
        r.customerName.toLowerCase().includes(q)
      );
    }

    // Urgency filter
    if (urgencyFilter !== 'all') {
      result = result.filter((r) => r.urgency === urgencyFilter);
    }

    // Sort
    const urgencyOrder = { aog: 0, urgent: 1, standard: 2 };
    result = [...result].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'urgency') {
        cmp = (urgencyOrder[a.urgency] ?? 2) - (urgencyOrder[b.urgency] ?? 2);
      } else if (sortBy === 'requiredDate') {
        cmp = new Date(a.requiredDate).getTime() - new Date(b.requiredDate).getTime();
      } else {
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return result;
  }, [pendingRFQs, rfqSearch, urgencyFilter, sortBy, sortDir]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredRFQs.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedRFQs = filteredRFQs.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Active RFQ (first selected)
  const selectedRFQ = useMemo(
    () => selectedRFQs.length > 0 ? pendingRFQs.find((r) => r.id === selectedRFQs[0]) ?? null : null,
    [pendingRFQs, selectedRFQs]
  );
  const selectedLines = useMemo(
    () => selectedRFQ?.lines?.filter((line) => line.status !== 'CANCELLED') ?? [],
    [selectedRFQ]
  );
  const progressLines = useMemo<SourcingDemandLine[]>(() => {
    if (!selectedRFQ) return [];
    if (selectedLines.length > 0) {
      return selectedLines.map((line) => ({
        key: line.id,
        rfqLineId: line.id,
        lineNo: line.lineNo,
        partNumber: line.partNumber,
        quantity: line.quantity,
        uom: line.uom || 'EA',
        requiredDate: line.requiredDate,
        certificateRequired: line.certificateRequired,
      }));
    }
    return [{
      key: `rfq:${selectedRFQ.id}`,
      rfqLineId: null,
      lineNo: 1,
      partNumber: selectedRFQ.partNumber,
      quantity: selectedRFQ.quantity,
      uom: selectedRFQ.uom || 'EA',
      requiredDate: selectedRFQ.requiredDate,
      certificateRequired: selectedRFQ.certificateRequired,
    }];
  }, [selectedLines, selectedRFQ]);
  const inquiryLineIds = selectedLineIds.length > 0
    ? selectedLineIds
    : selectedLines.length === 1
      ? [selectedLines[0].id]
      : [];

  const resolvedInquiries = useMemo(
    () => (inquiries ?? []).map((inquiry) => inquiryUpdates[inquiry.id] ?? inquiry),
    [inquiries, inquiryUpdates]
  );
  const previewInquiry = previewInquiryId
    ? resolvedInquiries.find((inquiry) => inquiry.id === previewInquiryId) ?? null
    : null;
  const reviewInquiry = reviewInquiryId
    ? resolvedInquiries.find((inquiry) => inquiry.id === reviewInquiryId) ?? null
    : null;
  const selectedRfqId = selectedRFQ?.id;

  useEffect(() => {
    if (!selectedRfqId || progressLines.length === 0) {
      setComparisonByLine({});
      return;
    }

    let cancelled = false;
    setComparisonByLine(Object.fromEntries(progressLines.map((line) => [line.key, { loading: true }])));
    for (const line of progressLines) {
      void compare({
        rfqId: selectedRfqId,
        ...(line.rfqLineId ? { rfqLineId: line.rfqLineId } : {}),
      }).then((result) => {
        if (!cancelled) setComparisonByLine((previous) => ({ ...previous, [line.key]: { loading: false, result } }));
      }).catch((error: unknown) => {
        if (!cancelled) {
          setComparisonByLine((previous) => ({
            ...previous,
            [line.key]: { loading: false, error: error instanceof Error ? error.message : 'Comparison request failed' },
          }));
        }
      });
    }
    return () => { cancelled = true; };
  }, [compare, progressLines, progressRefreshVersion, selectedRfqId]);

  // Filtered suppliers
  const filteredSuppliers = useMemo(() => {
    if (!suppliers) return [];
    if (!supplierSearch.trim()) return suppliers;
    const q = supplierSearch.toLowerCase();
    return suppliers.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      (s.contactName || '').toLowerCase().includes(q)
    );
  }, [suppliers, supplierSearch]);

  const selectedRFQInquiries = useMemo(() => {
    if (!selectedRFQ) return [];
    return resolvedInquiries.filter((inquiry) => inquiry.rfqId === selectedRFQ.id || (
      !inquiry.rfqId && inquiry.items.some((item) =>
        item.rfqLineId && progressLines.some((line) => line.rfqLineId === item.rfqLineId)
      )
    ));
  }, [progressLines, resolvedInquiries, selectedRFQ]);

  const toggleRFQ = (rfqId: string) => {
    const nextRfq = pendingRFQs.find((rfq) => rfq.id === rfqId);
    setSelectedRFQs((prev) =>
      prev.includes(rfqId)
        ? prev.filter((id) => id !== rfqId)
        : [rfqId] // single-select for now, can extend to multi
    );
    setSelectedLineIds(nextRfq?.lines?.length === 1 && nextRfq.lines[0].status !== 'CANCELLED' ? [nextRfq.lines[0].id] : []);
    setSelectedSuppliers([]);
    setReviewInquiryId(null);
  };

  const toggleSupplier = (supplierId: string) => {
    setSelectedSuppliers((prev) =>
      prev.includes(supplierId)
        ? prev.filter((id) => id !== supplierId)
        : [...prev, supplierId]
    );
  };

  const handleCreateInquiry = async () => {
    if (selectedSuppliers.length === 0 || !selectedRFQ || inquiryLineIds.length === 0) return;

    const result = await createInquiry({
      rfqId: selectedRFQ.id,
      lineIds: inquiryLineIds,
      supplierIds: selectedSuppliers,
      isAOG: isAOG || selectedRFQ.urgency === 'aog',
      notes: inquiryNote || undefined,
    });

    if (result) {
      await refetchInquiries();
      setIsInquiryDialogOpen(false);
      setSelectedSuppliers([]);
      setSelectedLineIds([]);
      setInquiryNote('');
      setIsAOG(false);
      toast.success(tx(`已建立 ${result.length} 份待发送询价，请核对邮件后确认发送。`, `${result.length} inquiry drafts created. Review each email before sending.`));
    }
  };

  const openInquiryEmailPreview = (inquiry: Inquiry) => {
    if (!selectedRFQ) return;
    const email = createInquiryEmail(inquiry, selectedRFQ, progressLines, locale);
    setEmailSubject(email.subject);
    setEmailBody(email.textBody);
    setPreviewInquiryId(inquiry.id);
  };

  const handleSendInquiry = async () => {
    if (!previewInquiry) return;
    const updatedInquiry = await sendInquiry({
      id: previewInquiry.id,
      payload: { subject: emailSubject, textBody: emailBody },
    });
    if (!updatedInquiry) return;

    setInquiryUpdates((previous) => ({ ...previous, [updatedInquiry.id]: updatedInquiry }));
    await refetchInquiries();

    const state = getInquiryProgressState(updatedInquiry);
    if (state === 'queued' || state === 'pending') {
      toast.success(tx('询价已进入发送队列；确认送达前仍显示为排队中。', 'Inquiry queued for delivery; it remains queued until delivery is confirmed.'));
    } else if (state === 'sent') {
      toast.success(tx('询价邮件已发送。', 'Inquiry email sent.'));
    } else if (state === 'failed') {
      toast.error(tx('邮件发送失败，请查看失败原因并人工跟进。', 'Email delivery failed. Review the delivery error and follow up manually.'));
    } else {
      toast.success(tx('发送请求已提交。', 'Send request submitted.'));
    }
    setPreviewInquiryId(null);
  };

  const handleRefreshProgress = async () => {
    await refetchInquiries();
    setInquiryUpdates({});
    setProgressRefreshVersion((version) => version + 1);
  };

  const handleLinkPendingMatchEmail = async (emailId: string, inquiryId: string, manualReason: string, reasonRequired: boolean) => {
    const trimmedReason = manualReason.trim();
    if (reasonRequired && trimmedReason.length < 5) {
      setPendingMatchLinkErrors((previous) => ({ ...previous, [emailId]: tx('人工说明至少需要 5 个字符。', 'The manual reason must be at least 5 characters.') }));
      return;
    }

    setLinkingEmailId(emailId);
    setPendingMatchLinkErrors((previous) => ({ ...previous, [emailId]: '' }));
    try {
      await emailApi.linkToInquiry(emailId, {
        inquiryId,
        ...(trimmedReason ? { manualReason: trimmedReason } : {}),
      });
      await Promise.all([refetchPendingMatchEmails(), refetchInquiries()]);
      setInquiryUpdates({});
      setProgressRefreshVersion((version) => version + 1);
      setPendingMatchInquirySelections((previous) => { const next = { ...previous }; delete next[emailId]; return next; });
      setPendingMatchReasons((previous) => { const next = { ...previous }; delete next[emailId]; return next; });
      toast.success(tx('回邮已关联到询价。', 'Reply linked to the inquiry.'));
    } catch (error) {
      setPendingMatchLinkErrors((previous) => ({
        ...previous,
        [emailId]: error instanceof Error ? error.message : tx('关联回邮失败。', 'Could not link the reply.'),
      }));
    } finally {
      setLinkingEmailId(null);
    }
  };

  const urgencyLabel = (u: string) => {
    if (u === 'aog') return tx('AOG 紧急', 'AOG Urgent');
    if (u === 'urgent') return tx('紧急', 'Urgent');
    return tx('标准', 'Standard');
  };

  const urgencyBadge = (u: string) => {
    if (u === 'aog') return <Badge variant="destructive">AOG</Badge>;
    if (u === 'urgent') return <Badge className="bg-orange-100 text-orange-700">{tx('紧急', 'Urgent')}</Badge>;
    return <Badge variant="secondary">{tx('标准', 'Standard')}</Badge>;
  };

  const isLoading = rfqsLoading || suppliersLoading || inventoryLoading;
  const hasError = rfqsError || suppliersError || inventoryError;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="p-4 text-red-500">
        {tx('加载失败', 'Failed to load')}: {hasError}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* RFQ Selection - Table View */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="w-5 h-5 text-brand-primary" />
            {tx('选择待寻源需求单', 'Select RFQ for Sourcing')}
            <span className="text-sm font-normal text-gray-500 ml-2">({filteredRFQs.length} {tx('条', 'items')})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Search + Filter Bar */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                className="pl-10"
                placeholder={tx('搜索需求单号、件号或客户...', 'Search RFQ, part or customer...')}
                value={rfqSearch}
                onChange={(e) => { setRfqSearch(e.target.value); setCurrentPage(1); }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-500" />
              {(['all', 'aog', 'urgent', 'standard'] as const).map((u) => (
                <Button
                  key={u}
                  variant={urgencyFilter === u ? 'default' : 'outline'}
                  size="sm"
                  className={cn(urgencyFilter === u && u === 'aog' && 'bg-red-600 hover:bg-red-700')}
                  onClick={() => { setUrgencyFilter(u); setCurrentPage(1); }}
                >
                  {u === 'all' ? tx('全部', 'All') : urgencyLabel(u)}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <SortAsc className="w-4 h-4 text-gray-500" />
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="h-9 w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="requiredDate">{tx('需求日期', 'Required Date')}</SelectItem>
                  <SelectItem value="urgency">{tx('紧急程度', 'Urgency')}</SelectItem>
                  <SelectItem value="createdAt">{tx('创建时间', 'Created Date')}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')}
              >
                {sortDir === 'asc' ? '↑' : '↓'}
              </Button>
            </div>
          </div>

          {/* RFQ Table */}
          {filteredRFQs.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
            <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <CheckCircle className="w-12 h-12 mx-auto mb-2 text-green-500" />
              <p>{rfqSearch || urgencyFilter !== 'all' ? tx('没有匹配的需求单', 'No matching RFQs') : tx('暂无待处理需求单', 'No pending RFQs')}</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead>{tx('需求单号', 'RFQ Number')}</TableHead>
                      <TableHead>{tx('客户', 'Customer')}</TableHead>
                      <TableHead>{tx('件号', 'Part Number')}</TableHead>
                      <TableHead>{tx('需求行', 'Lines')}</TableHead>
                      <TableHead>{tx('数量', 'Qty')}</TableHead>
                      <TableHead>{tx('紧急程度', 'Urgency')}</TableHead>
                      <TableHead>{tx('需求日期', 'Required Date')}</TableHead>
                      <TableHead>{tx('状态', 'Status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedRFQs.map((rfq) => (
                      <TableRow
                        key={rfq.id}
                        className={cn(
                          'cursor-pointer transition-colors',
                          selectedRFQs.includes(rfq.id) && 'bg-blue-50'
                        )}
                        onClick={() => toggleRFQ(rfq.id)}
                      >
                        <TableCell>
                          <Checkbox
                            checked={selectedRFQs.includes(rfq.id)}
                            onClick={(e) => e.stopPropagation()}
                            onCheckedChange={() => toggleRFQ(rfq.id)}
                          />
                        </TableCell>
                        <TableCell className="font-mono font-medium">{rfq.rfqNumber}</TableCell>
                        <TableCell>{rfq.customerName}</TableCell>
                        <TableCell className="font-mono">{rfq.partNumber}</TableCell>
                        <TableCell>{rfq.lines && rfq.lines.length > 1 ? <Badge variant="outline">{rfq.lines.length}</Badge> : '1'}</TableCell>
                        <TableCell>{rfq.quantity}</TableCell>
                        <TableCell>{urgencyBadge(rfq.urgency)}</TableCell>
                        <TableCell>{rfq.requiredDate}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{rfq.status === 'pending' ? tx('待处理', 'Pending') : tx('寻源中', 'Sourcing')}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {filteredRFQs.length > pageSize && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-sm text-gray-500">
                    {tx('第', 'Page')} {safePage} / {totalPages} {tx('页', '')}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage <= 1}
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage >= totalPages}
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Global mailbox queue for replies that still need an inquiry match */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Inbox className="h-5 w-5 text-brand-primary" />
              {tx('待匹配回邮', 'Replies needing inquiry match')}
              <Badge variant="secondary">{pendingMatchEmailResult?.pagination.total ?? pendingMatchEmailResult?.data.length ?? 0}</Badge>
            </CardTitle>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetchPendingMatchEmails()} disabled={pendingMatchEmailsLoading}>
              <RefreshCw className="mr-1 h-4 w-4" />
              {tx('刷新回邮', 'Refresh replies')}
            </Button>
          </div>
          <p className="text-sm text-gray-500">
            {tx('从全邮箱列出尚未关联询价的回邮；选择目标询价并确认后，队列会自动刷新。', 'Replies across the mailbox without an inquiry link are listed here. Choose a target inquiry and confirm to refresh the queue.')}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {pendingMatchEmailsLoading && <p className="text-sm text-gray-500" role="status">{tx('正在加载待匹配回邮…', 'Loading unmatched replies…')}</p>}
          {pendingMatchEmailsError && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{tx('待匹配回邮加载失败', 'Could not load unmatched replies')}: {pendingMatchEmailsError}</p>}
          {!pendingMatchEmailsLoading && !pendingMatchEmailsError && (pendingMatchEmailResult?.data.length ?? 0) === 0 && (
            <p className="rounded border border-dashed p-4 text-sm text-gray-500">{tx('当前没有待匹配回邮。', 'There are no replies waiting for a match.')}</p>
          )}
          {(pendingMatchEmailResult?.data ?? []).map((email) => {
            const selectedInquiryId = pendingMatchInquirySelections[email.id] ?? '';
            const targetInquiry = resolvedInquiries.find((inquiry) => inquiry.id === selectedInquiryId);
            const supplierEmail = targetInquiry
              ? normalizeMailboxAddress(suppliers?.find((supplier) => supplier.id === targetInquiry.supplierId)?.email)
              : '';
            const senderEmail = normalizeMailboxAddress(email.from);
            const reasonRequired = Boolean(targetInquiry && (!supplierEmail || senderEmail !== supplierEmail));
            const manualReason = pendingMatchReasons[email.id] ?? '';
            const attachmentStatus = email.attachmentStatus ?? ((email.attachmentRecords?.length ?? 0) > 0 ? 'STORED' : 'NONE');
            const attachmentStatusLabel: Record<string, string> = {
              NONE: tx('无附件', 'No attachments'),
              STORED: tx('附件已保存', 'Attachments stored'),
              PARTIAL: tx('附件部分保存', 'Attachments partly stored'),
              REJECTED: tx('附件未保存', 'Attachments rejected'),
            };

            return (
              <article key={email.id} className="space-y-3 rounded-lg border p-4" aria-label={tx(`待匹配回邮 ${email.subject || email.id}`, `Unmatched reply ${email.subject || email.id}`)}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{email.fromName ? `${email.fromName} <${email.from}>` : email.from}</p>
                    <p className="break-words text-sm">{tx('主题', 'Subject')}: {email.subject || '—'}</p>
                    <p className="text-xs text-gray-500"><time dateTime={email.receivedAt}>{tx('收到时间', 'Received')}: {email.receivedAt}</time></p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{tx('线程匹配', 'Thread match')}: {getThreadMatchLabel(email.threadMatchStatus, tx)}</Badge>
                    <Badge variant={attachmentStatus === 'PARTIAL' || attachmentStatus === 'REJECTED' ? 'destructive' : 'secondary'}>
                      {attachmentStatusLabel[attachmentStatus] ?? `${tx('附件状态', 'Attachment status')}: ${attachmentStatus}`}
                      {(email.attachmentRecords?.length ?? 0) > 0 && ` · ${email.attachmentRecords!.length}`}
                    </Badge>
                  </div>
                </div>
                {(email.threadMatchReason || email.reason) && <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">{email.threadMatchReason || email.reason}</p>}
                {email.attachmentError && <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">{email.attachmentError}</p>}
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
                  <div className="space-y-1">
                    <Label htmlFor={`pending-match-inquiry-${email.id}`}>{tx('目标询价', 'Target inquiry')}</Label>
                    <select
                      id={`pending-match-inquiry-${email.id}`}
                      aria-label={tx(`目标询价 ${email.subject || email.id}`, `Target inquiry for ${email.subject || email.id}`)}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      value={selectedInquiryId}
                      onChange={(event) => {
                        setPendingMatchInquirySelections((previous) => ({ ...previous, [email.id]: event.target.value }));
                        setPendingMatchLinkErrors((previous) => ({ ...previous, [email.id]: '' }));
                      }}
                    >
                      <option value="">{tx('选择已有询价…', 'Choose an existing inquiry…')}</option>
                      {resolvedInquiries.map((inquiry) => <option key={inquiry.id} value={inquiry.id}>{inquiry.inquiryNumber} · {inquiry.supplierName}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`pending-match-reason-${email.id}`}>
                      {tx('人工匹配原因', 'Manual match reason')}{reasonRequired ? ` · ${tx('必填，至少 5 字符', 'required, at least 5 characters')}` : ` · ${tx('选填', 'optional')}`}
                    </Label>
                    <Textarea
                      id={`pending-match-reason-${email.id}`}
                      value={manualReason}
                      rows={1}
                      placeholder={tx('说明此回邮为何属于所选询价…', 'Explain why this reply belongs to the selected inquiry…')}
                      onChange={(event) => {
                        setPendingMatchReasons((previous) => ({ ...previous, [email.id]: event.target.value }));
                        setPendingMatchLinkErrors((previous) => ({ ...previous, [email.id]: '' }));
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    onClick={() => targetInquiry && void handleLinkPendingMatchEmail(email.id, targetInquiry.id, manualReason, reasonRequired)}
                    disabled={!targetInquiry || linkingEmailId === email.id || (reasonRequired && manualReason.trim().length < 5)}
                    aria-label={tx(`关联 ${email.subject || email.id} 到询价`, `Link ${email.subject || email.id} to inquiry`)}
                  >
                    {linkingEmailId === email.id && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    {tx('关联到询价', 'Link to inquiry')}
                  </Button>
                </div>
                {targetInquiry && reasonRequired && <p className="text-xs text-amber-700">{tx(`发件邮箱与 ${targetInquiry.supplierName} 的供应商邮箱不一致${supplierEmail ? `（${supplierEmail}）` : '（未配置）'}，需要填写人工原因。`, `The sender does not match ${targetInquiry.supplierName}'s supplier email${supplierEmail ? ` (${supplierEmail})` : ' (not configured)'}; enter a manual reason.`)}</p>}
                {pendingMatchLinkErrors[email.id] && <p className="text-sm text-red-700" role="alert">{pendingMatchLinkErrors[email.id]}</p>}
              </article>
            );
          })}
        </CardContent>
      </Card>

      {/* Demand line selection */}
      {selectedRFQ && selectedLines.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="w-5 h-5 text-brand-primary" />
              {tx('选择需求行', 'Select demand lines')}
              <span className="text-sm font-normal text-gray-500">({inquiryLineIds.length} {tx('已选', 'selected')})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {selectedLines.map((line) => {
              const checked = inquiryLineIds.includes(line.id);
              return (
                <label key={line.id} className={cn('flex cursor-pointer items-center justify-between rounded border p-3', checked && 'border-brand-primary bg-blue-50')}>
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(value) => setSelectedLineIds((previous) => value ? [...new Set([...previous, line.id])] : previous.filter((id) => id !== line.id))}
                    />
                    <span className="font-medium">{tx(`行 ${line.lineNo}`, `Line ${line.lineNo}`)}</span>
                    <span className="font-mono">{line.partNumber}</span>
                    <span className="text-sm text-gray-500">{line.quantity} {line.uom || 'EA'}</span>
                  </div>
                  <span className="text-sm text-gray-500">{line.requiredDate}</span>
                </label>
              );
            })}
            {selectedLines.length > 1 && inquiryLineIds.length === 0 && (
              <p className="text-sm text-amber-700">{tx('请选择至少一条需求行后建立询价草稿。', 'Select at least one demand line before creating inquiry drafts.')}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Inquiry, reply and line-scoped quote comparison progress */}
      {selectedRFQ && (
        <section aria-label={tx('询价与回复 / 比价进度', 'Inquiry, reply and comparison progress')}>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Clock3 className="w-5 h-5 text-brand-primary" />
                  {tx('询价与回复 / 比价进度', 'Inquiry, reply and comparison progress')}
                </CardTitle>
                <Button type="button" variant="outline" size="sm" onClick={() => void handleRefreshProgress()} disabled={inquiriesLoading}>
                  <RefreshCw className="mr-1 h-4 w-4" />
                  {tx('刷新状态与报价', 'Refresh statuses and quotes')}
                </Button>
              </div>
              <p className="text-sm text-gray-500">
                {tx('按当前需求单的每条需求行分别展示询价状态和报价；每行独立比较。', 'Inquiry status and quotes are shown and compared separately for each demand line.')}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {inquiriesLoading && (
                <p className="text-sm text-gray-500" role="status">{tx('正在加载询价记录…', 'Loading inquiries…')}</p>
              )}
              {inquiriesError && (
                <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
                  {tx('询价记录加载失败', 'Failed to load inquiries')}: {inquiriesError}
                </p>
              )}
              <div className="space-y-4">
                {progressLines.map((line) => {
                  const samePartNumberLineCount = progressLines.filter((candidate) => candidate.partNumber === line.partNumber).length;
                  const lineInquiries = selectedRFQInquiries.filter((inquiry) => inquiryIncludesLine(inquiry, line, samePartNumberLineCount));
                  const comparison = comparisonByLine[line.key];
                  const quotes = comparison?.result?.quotes ?? [];
                  const comparisonSummary = comparison?.result?.summary;
                  const quoteCount = comparisonSummary?.totalQuotes ?? quotes.length;
                  const states = lineInquiries.map(getInquiryProgressState);
                  const hasFailedInquiry = states.includes('failed');
                  const hasUnsentDraft = lineInquiries.some((inquiry) => inquiry.status === 'draft');
                  const hasQueuedInquiry = states.some((state) => state === 'queued' || state === 'pending');
                  const hasSentInquiry = states.some((state) => state === 'sent' || state === 'responded');
                  const hasSkippedInquiry = states.includes('skipped');
                  const nextAction = hasFailedInquiry
                    ? tx('检查发送失败原因并跟进投递状态。', 'Review the delivery error and follow up on delivery status.')
                    : hasUnsentDraft
                      ? tx('预览询价邮件并确认发送。', 'Preview the inquiry email and confirm sending.')
                      : hasQueuedInquiry
                        ? tx('等待邮件投递结果。', 'Wait for the email delivery result.')
                        : hasSkippedInquiry
                          ? tx('检查邮箱配置或联系供应商。', 'Check the email configuration or contact the supplier.')
                        : quoteCount > 0
                          ? tx('核对本需求行的报价与规则分。', 'Review quotes and rule scores for this line.')
                          : hasSentInquiry
                            ? tx('等待供应商报价，必要时跟进。', 'Await the supplier quote and follow up if needed.')
                            : tx('选择供应商并创建询价草稿。', 'Select suppliers and create inquiry drafts.');

                  return (
                    <Card key={line.key} role="region" aria-label={tx(`需求行 ${line.lineNo} · ${line.partNumber}`, `Demand line ${line.lineNo} · ${line.partNumber}`)} className="border-gray-200">
                      <CardHeader className="pb-3">
                        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                          <span>{tx(`行 ${line.lineNo}`, `Line ${line.lineNo}`)} · <span className="font-mono">{line.partNumber}</span></span>
                          <Badge variant="outline">{tx('数量', 'Qty')}: {line.quantity} {line.uom}</Badge>
                        </CardTitle>
                        <p className="text-sm text-gray-500">
                          {tx('需求日期', 'Required date')}: {line.requiredDate || '—'}
                          {line.certificateRequired && ` · ${tx('需要合格证', 'Certificate required')}`}
                        </p>
                      </CardHeader>
                      <CardContent className="grid gap-5 lg:grid-cols-2">
                        <section aria-label={tx('询价发送状态', 'Inquiry delivery status')} className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="font-semibold">{tx('询价与发送状态', 'Inquiry and delivery status')}</h4>
                            <span className="text-sm text-gray-500">{lineInquiries.length} {tx('份询价', 'inquiries')}</span>
                          </div>
                          {lineInquiries.length === 0 ? (
                            <p className="rounded border border-dashed p-3 text-sm text-gray-500">
                              {tx('此需求行尚无询价草稿。', 'No inquiry draft exists for this line yet.')}
                            </p>
                          ) : (
                            <ul className="space-y-2">
                              {lineInquiries.map((inquiry) => {
                                const state = getInquiryProgressState(inquiry);
                                const canSend = inquiry.status === 'draft';
                                const stateColor = state === 'sent' || state === 'responded'
                                  ? 'bg-green-100 text-green-800'
                                  : state === 'queued' || state === 'pending'
                                    ? 'bg-amber-100 text-amber-800'
                                    : state === 'failed'
                                      ? 'bg-red-100 text-red-800'
                                      : 'bg-gray-100 text-gray-700';
                                const deliveryError = inquiry.latestOutboundEmail?.error;
                                return (
                                  <li key={inquiry.id} className="rounded border p-3">
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                      <div>
                                        <p className="font-medium">{inquiry.supplierName}</p>
                                        <p className="text-xs text-gray-500">{inquiry.inquiryNumber}</p>
                                      </div>
                                      <Badge className={stateColor} aria-live="polite">
                                        {getInquiryStateLabel(state, tx)}
                                      </Badge>
                                    </div>
                                    {deliveryError && state === 'failed' && (
                                      <p className="mt-2 text-sm text-red-700">{deliveryError}</p>
                                    )}
                                    {canSend && (
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="mt-3"
                                        onClick={() => openInquiryEmailPreview(inquiry)}
                                        aria-label={tx(`预览 ${inquiry.supplierName} 的询价邮件`, `Preview inquiry email for ${inquiry.supplierName}`)}
                                      >
                                        <Eye className="mr-1 h-4 w-4" />
                                        {tx('预览并发送', 'Preview and send')}
                                      </Button>
                                    )}
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="mt-3 ml-2"
                                      onClick={() => setReviewInquiryId(inquiry.id)}
                                      aria-label={tx(`核对 ${inquiry.supplierName} 的回邮`, `Review replies for ${inquiry.supplierName}`)}
                                    >
                                      <Mail className="mr-1 h-4 w-4" />
                                      {tx('回邮核对', 'Review replies')}
                                    </Button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                          <div className="rounded bg-blue-50 p-3 text-sm">
                            <span className="font-medium">{tx('下一步', 'Next action')}:</span> {nextAction}
                          </div>
                        </section>

                        <section aria-label={tx('需求行报价比较', 'Demand line quote comparison')} className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="font-semibold">{tx('供应商报价比较', 'Supplier quote comparison')}</h4>
                            <span className="text-sm text-gray-500">
                              {comparison?.loading ? '—' : quoteCount} {tx('份报价', 'quotes')}
                            </span>
                          </div>
                          {!comparison?.loading && comparisonSummary && (
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                              {comparisonSummary.comparableQuoteCount !== undefined && <span>{tx('可比报价', 'Comparable')}: {comparisonSummary.comparableQuoteCount}</span>}
                              {comparisonSummary.expiredQuoteCount !== undefined && <span>{tx('已过期', 'Expired')}: {comparisonSummary.expiredQuoteCount}</span>}
                              {comparisonSummary.requiredQuantity !== undefined && <span>{tx('需求数量', 'Required qty')}: {comparisonSummary.requiredQuantity}</span>}
                              {comparisonSummary.bestAvailableQuantity !== undefined && <span>{tx('最大可供数量', 'Best available qty')}: {comparisonSummary.bestAvailableQuantity}</span>}
                              {comparisonSummary.remainingQuantityGap !== undefined && <span>{tx('剩余数量缺口', 'Remaining quantity gap')}: {comparisonSummary.remainingQuantityGap}</span>}
                            </div>
                          )}
                          {comparison?.loading ? (
                            <p className="text-sm text-gray-500" role="status">{tx('正在加载本行报价…', 'Loading quotes for this line…')}</p>
                          ) : comparison?.error ? (
                            <p className="text-sm text-red-700" role="alert">{tx('比价数据加载失败', 'Failed to load comparison')}: {comparison.error}</p>
                          ) : (
                            <>
                              {comparison?.result?.metadata.reason && (
                                <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                                  {comparison.result.metadata.status === 'insufficient_data'
                                    ? tx('数据不足原因', 'Reason for insufficient data')
                                    : tx('数据说明', 'Data note')}: {comparison.result.metadata.reason}
                                </p>
                              )}
                              {quotes.length === 0 ? (
                                <p className="rounded border border-dashed p-3 text-sm text-gray-500">
                                  {tx('此需求行尚无录入报价。', 'No supplier quotes have been recorded for this line.')}
                                </p>
                              ) : (
                                <div className="overflow-x-auto rounded border">
                                  <Table>
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead>{tx('供应商', 'Supplier')}</TableHead>
                                        <TableHead>{tx('实际单价', 'Unit price')}</TableHead>
                                        <TableHead>{tx('可供数量', 'Available qty')}</TableHead>
                                        <TableHead>{tx('交期', 'Lead time')}</TableHead>
                                        <TableHead>{tx('有效期', 'Valid until')}</TableHead>
                                        <TableHead>{tx('条件 / 证书', 'Condition / certificate')}</TableHead>
                                        <TableHead>{tx('规则分', 'Rule score')}</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {quotes.map((quote) => (
                                        <TableRow key={quote.id}>
                                          <TableCell className="font-medium">
                                            <div className="flex flex-wrap items-center gap-2">
                                              <span>{quote.supplier.name}</span>
                                              {quote.isWinner && <Badge variant="secondary">{tx('当前中选', 'Current winner')}</Badge>}
                                              {quote.isLowestPrice && <Badge variant="outline">{tx('最低价', 'Lowest price')}</Badge>}
                                              {quote.comparisonEligibility && (
                                                <Badge variant={quote.comparisonEligibility.eligible ? 'secondary' : 'destructive'}>
                                                  {quote.comparisonEligibility.eligible ? tx('可比', 'Comparable') : tx('不参与比价', 'Excluded from comparison')}
                                                </Badge>
                                              )}
                                              {quote.isExpired && <Badge variant="destructive">{tx('已过期', 'Expired')}</Badge>}
                                              {quote.coversRequiredQuantity === false && <Badge variant="destructive">{tx('数量不足', 'Insufficient quantity')}</Badge>}
                                            </div>
                                            {(quote.comparisonEligibility?.reasons?.length ?? 0) > 0 && (
                                              <ul className="mt-1 space-y-0.5 text-xs text-red-700" aria-label={tx('不参与比价原因', 'Comparison exclusion reasons')}>
                                                {quote.comparisonEligibility!.reasons.map((reason, index) => <li key={`${quote.id}-reason-${index}`}>{tx('原因', 'Reason')}: {getComparisonIssueLabel(reason, tx)}</li>)}
                                              </ul>
                                            )}
                                            {(quote.comparisonEligibility?.warnings?.length ?? 0) > 0 && (
                                              <ul className="mt-1 space-y-0.5 text-xs text-amber-700" aria-label={tx('报价警告', 'Quote warnings')}>
                                                {quote.comparisonEligibility!.warnings.map((warning, index) => <li key={`${quote.id}-warning-${index}`}>{tx('提示', 'Warning')}: {getComparisonIssueLabel(warning, tx)}</li>)}
                                              </ul>
                                            )}
                                          </TableCell>
                                          <TableCell>
                                            {quote.currency ? `${quote.currency} ` : ''}{quote.unitPrice.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                                            {quote.currencyStatus === 'HISTORICAL_UNVERIFIED' && (
                                              <span className="ml-1 text-xs text-amber-700">{tx('币种未核实', 'Currency unverified')}</span>
                                            )}
                                          </TableCell>
                                          <TableCell>
                                            {quote.quantity} {line.uom}
                                            {quote.quantityShortfall != null && quote.quantityShortfall > 0 && (
                                              <p className="text-xs text-amber-700">{tx('缺口', 'Shortfall')}: {quote.quantityShortfall} {line.uom}</p>
                                            )}
                                          </TableCell>
                                          <TableCell>{quote.leadTimeDays} {tx('天', 'days')}</TableCell>
                                          <TableCell>{quote.validUntil || '—'}</TableCell>
                                          <TableCell className="text-sm">
                                            <div>{tx('条件', 'Condition')}: {formatCommercialTerm(quote.commercialTerms?.condition)}</div>
                                            <div>{tx('证书', 'Certificate')}: {formatCommercialTerm(quote.commercialTerms?.certificate)}</div>
                                            <div>{tx('税费', 'Tax')}: {quote.commercialTerms?.taxIncluded == null ? tx('未说明', 'Unknown') : quote.commercialTerms.taxIncluded ? tx('含税', 'Included') : tx('未含税', 'Excluded')}</div>
                                            <div>{tx('运费', 'Freight')}: {quote.commercialTerms?.freightIncluded == null ? tx('未说明', 'Unknown') : quote.commercialTerms.freightIncluded ? tx('含运费', 'Included') : tx('未含运费', 'Excluded')}</div>
                                            <div>{tx('贸易术语', 'Incoterm')}: {quote.commercialTerms?.incoterm || '—'}</div>
                                            {quote.commercialBasisLabel && <div className="mt-1 text-xs text-gray-500">{tx('比较口径', 'Comparison basis')}: {quote.commercialBasisLabel}</div>}
                                          </TableCell>
                                          <TableCell>{quote.ruleScore ?? '—'}</TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              )}
                            </>
                          )}
                        </section>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {/* Inventory match results */}
      {selectedRFQ && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="w-5 h-5 text-brand-primary" />
              {tx('库存匹配结果', 'Inventory Match Results')} - {selectedRFQ.partNumber}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {inventoryLoading ? (
              <div className="flex items-center justify-center h-48">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : inventoryError ? (
              <p className="text-sm text-red-500">{inventoryError}</p>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {inventoryItems
                    ?.filter((item) =>
                      item.partNumber === selectedRFQ.partNumber ||
                      selectedRFQ.alternatePartNumbers?.includes(item.partNumber)
                    )
                    .map((item) => (
                      <InventoryMatchCard key={item.id} item={item} rfq={selectedRFQ} />
                    )) ?? []}
                </div>

                {(inventoryItems?.filter((item) => item.partNumber === selectedRFQ.partNumber).length ?? 0) === 0 && (
                  <div className="text-center py-12 text-gray-500">
            <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    <AlertTriangle className="w-12 h-12 mx-auto mb-2 text-yellow-500" />
                    <p>{tx('未找到精准库存匹配，建议发起供应商询价。', 'No exact inventory match found. Supplier inquiry is recommended.')}</p>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Supplier selection */}
      {selectedRFQ && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Truck className="w-5 h-5 text-brand-primary" />
              {tx('选择询价供应商', 'Select Suppliers for Inquiry')}
            </CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">{selectedSuppliers.length} {tx('已选', 'selected')}</span>
              {selectedSuppliers.length > 0 && (
                <Button
                  onClick={() => setIsInquiryDialogOpen(true)}
                  disabled={inquiryLineIds.length === 0}
                  className="bg-brand-primary hover:bg-brand-primary-hover"
                >
                  <Send className="w-4 h-4 mr-1" />
                  {tx('建立询价草稿', 'Create Inquiry Drafts')}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                className="pl-10"
                placeholder={tx('搜索供应商...', 'Search suppliers...')}
                value={supplierSearch}
                onChange={(e) => setSupplierSearch(e.target.value)}
              />
            </div>
            {suppliersLoading ? (
              <div className="flex items-center justify-center h-48">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : suppliersError ? (
              <p className="text-sm text-red-500">{suppliersError}</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredSuppliers.map((supplier) => (
                  <SupplierCard
                    key={supplier.id}
                    supplier={supplier}
                    isSelected={selectedSuppliers.includes(supplier.id)}
                    onSelect={() => toggleSupplier(supplier.id)}
                  />
                ))}
                {filteredSuppliers.length === 0 && (
                  <p className="text-sm text-gray-500 col-span-full text-center py-4">{tx('没有匹配的供应商', 'No matching suppliers')}</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Inquiry confirmation dialog */}
      <Dialog open={isInquiryDialogOpen} onOpenChange={setIsInquiryDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tx('建立询价草稿', 'Create Inquiry Drafts')}</DialogTitle>
            <DialogDescription>{tx('保存已选供应商的询价草稿。请核对后人工联系供应商，草稿尚未发送。', 'Save drafts for the selected suppliers. Review the drafts and contact suppliers; these drafts have not been sent.')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="bg-gray-50 p-4 rounded-lg">
              <p className="font-medium">{tx('需求信息', 'RFQ Information')}</p>
              <div className="mt-2 space-y-1 text-sm">
                <p><span className="text-gray-500">{tx('件号', 'Part number')}:</span> {selectedRFQ?.partNumber}</p>
                <p><span className="text-gray-500">{tx('数量', 'Quantity')}:</span> {selectedRFQ?.quantity} {tx('件', 'EA')}</p>
                <p><span className="text-gray-500">{tx('需求日期', 'Required date')}:</span> {selectedRFQ?.requiredDate}</p>
              </div>
              {selectedLines.length > 0 && (
                <div className="mt-3 border-t pt-2 text-sm">
                  <p className="font-medium">{tx('将询价的需求行', 'Demand lines included')}</p>
                  <ul className="mt-1 list-inside list-disc text-gray-600">
                    {selectedLines.filter((line) => inquiryLineIds.includes(line.id)).map((line) => <li key={line.id}>{tx(`行 ${line.lineNo}`, `Line ${line.lineNo}`)} · {line.partNumber} · {line.quantity} {line.uom || 'EA'}</li>)}
                  </ul>
                </div>
              )}
            </div>

            <div>
              <p className="font-medium mb-2">{tx('已选供应商', 'Selected suppliers')} ({selectedSuppliers.length})</p>
              <div className="space-y-1">
                {suppliers
                  ?.filter((s) => selectedSuppliers.includes(s.id))
                  .map((s) => (
                    <div key={s.id} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                      <span>{s.name}</span>
                      <Badge className={levelConfig[s.level].bgColor + ' ' + levelConfig[s.level].color}>
                        {supplierLevelLabel(s.level)}
                      </Badge>
                    </div>
                  )) ?? []}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="aog"
                checked={isAOG}
                onCheckedChange={(checked) => setIsAOG(checked as boolean)}
              />
              <Label htmlFor="aog" className="flex items-center gap-2 cursor-pointer">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                {tx('标记为 AOG 紧急询价', 'Mark as AOG urgent inquiry')}
              </Label>
            </div>

            <div className="space-y-2">
              <Label>{tx('备注', 'Notes')}</Label>
              <Textarea
                value={inquiryNote}
                onChange={(e) => setInquiryNote(e.target.value)}
                placeholder={tx('填写询价备注...', 'Add inquiry notes...')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsInquiryDialogOpen(false)}>
              {tx('取消', 'Cancel')}
            </Button>
            <Button
              onClick={handleCreateInquiry}
              disabled={inquiryLoading}
              className="bg-brand-primary hover:bg-brand-primary-hover"
            >
              {inquiryLoading ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Send className="w-4 h-4 mr-1" />
              )}
              {tx('保存草稿', 'Save Drafts')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(previewInquiry && previewInquiry.status === 'draft')} onOpenChange={(open) => { if (!open) setPreviewInquiryId(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tx('询价邮件预览', 'Inquiry email preview')}</DialogTitle>
            <DialogDescription>
              {tx('请核对收件人、主题和正文。点击“确认并发送”会提交发送请求；若邮件仍在队列中，状态会继续显示为排队中。', 'Review the recipient, subject and body. “Confirm and send” submits the delivery request; queued mail will remain marked as queued.')}
            </DialogDescription>
          </DialogHeader>
          {previewInquiry && (
            <div className="space-y-4 py-2">
              <div className="rounded border bg-gray-50 p-3 text-sm">
                <span className="font-medium">{tx('收件人', 'To')}:</span>{' '}
                {suppliers?.find((supplier) => supplier.id === previewInquiry.supplierId)?.email
                  || tx('供应商邮箱未提供，将由服务端校验。', 'Supplier email not available; the server will validate delivery.')}
              </div>
              <div className="space-y-2">
                <Label htmlFor="inquiry-email-subject">{tx('主题', 'Subject')}</Label>
                <Input
                  id="inquiry-email-subject"
                  value={emailSubject}
                  onChange={(event) => setEmailSubject(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inquiry-email-body">{tx('邮件正文', 'Email body')}</Label>
                <Textarea
                  id="inquiry-email-body"
                  className="min-h-[240px] font-mono text-sm"
                  value={emailBody}
                  onChange={(event) => setEmailBody(event.target.value)}
                />
              </div>
              {sendError && (
                <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {tx('发送失败', 'Send failed')}: {sendError}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreviewInquiryId(null)} disabled={sendLoading}>
              {tx('返回', 'Back')}
            </Button>
            {previewInquiry?.status === 'draft' && (
              <Button
                type="button"
                onClick={() => void handleSendInquiry()}
                disabled={sendLoading || !emailSubject.trim() || !emailBody.trim()}
                className="bg-brand-primary hover:bg-brand-primary-hover"
              >
                {sendLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
                {tx('确认并发送', 'Confirm and send')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReplyReviewDialog
        inquiry={reviewInquiry}
        open={Boolean(reviewInquiryId)}
        onOpenChange={(open) => { if (!open) setReviewInquiryId(null); }}
        tx={tx}
        onConfirmed={handleRefreshProgress}
      />
    </div>
  );
}
