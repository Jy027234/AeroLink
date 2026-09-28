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
  useCompareSupplierQuotes,
  useInquiryEmails,
  useEmails,
} from '@/hooks/useApi';
import { emailApi, fileApi, inquiryApi, rfqApi, sourcingActionTaskApi, sourcingAiTaskApi, supplierQuoteApi, supplierQuoteDraftApi } from '@/api/client';
import type { Email, RFQ, Supplier, InventoryItem } from '@/types';
import type {
  Inquiry,
  InquiryDeliveryStatus,
  RfqSourcingCandidates,
  RfqSourcingTimeline,
  RfqSourcingTimelineEvent,
  RfqSourcingPendingQuoteRow,
  RfqSourcingWorkflowState,
  SupplierQuoteCompareResult,
  SupplierQuoteDraftPayload,
  SupplierQuoteDraftRecord,
  SourcingAiTaskRecord,
  SourcingActionTaskRecord,
} from '@/api/client';
import { useCapabilityStore } from '@/store';
import { QuoteAnalysisAssistant } from '@/components/BusinessAiAssistants';

type InquiryProgressState = 'draft' | 'queued' | 'processing' | 'retrying' | 'smtp_accepted' | 'needs_verification' | 'sent' | 'failed' | 'cancelled' | 'skipped' | 'pending' | 'responded' | 'closed';

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
  const recognizedDeliveryStatuses: InquiryDeliveryStatus[] = [
    'pending', 'queued', 'processing', 'retrying', 'smtp_accepted', 'needs_verification', 'sent', 'failed', 'cancelled', 'skipped',
  ];
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
    queued: ['排队中（Worker 尚未领取）', 'Queued (not claimed by worker)'],
    processing: ['投递处理中', 'Delivery in progress'],
    retrying: ['系统自动重试中', 'Automatic retry in progress'],
    smtp_accepted: ['SMTP 已接受，未确认收件方收到', 'SMTP accepted; recipient delivery unconfirmed'],
    sent: ['SMTP 已接受，未确认收件方收到', 'SMTP accepted; recipient delivery unconfirmed'],
    failed: ['发送失败，请检查配置后再确认是否重发', 'Send failed; review configuration before retrying'],
    needs_verification: ['需人工核实投递结果', 'Verify delivery manually'],
    cancelled: ['已安全取消（Worker 未领取）', 'Cancelled before worker claim'],
    skipped: ['未发送', 'Skipped'],
    pending: ['发送处理中', 'Pending'],
    responded: ['已回复', 'Responded'],
    closed: ['已关闭', 'Closed'],
  };
  return tx(...labels[state]);
}

function getSourcingWorkflowStatusLabel(status: RfqSourcingWorkflowState['status'], tx: (zh: string, en: string) => string) {
  const labels: Record<RfqSourcingWorkflowState['status'], [string, string]> = {
    WAITING_REPLY: ['待供应商回邮', 'Waiting for supplier reply'],
    WAITING_HUMAN: ['待人工处理', 'Waiting for human review'],
    PROCESSING: ['处理中', 'Processing'],
    FAILED: ['处理失败', 'Failed'],
    CANCELLED: ['已停止后续寻源', 'Further sourcing stopped'],
    NEEDS_VERIFICATION: ['待核实', 'Needs verification'],
    COMPLETED: ['需求项均有正式报价', 'Formal quotes recorded for all items'],
  };
  return tx(...labels[status]);
}

function getSourcingWorkflowActionLabel(action: RfqSourcingWorkflowState['nextAction'], tx: (zh: string, en: string) => string) {
  const labels: Record<RfqSourcingWorkflowState['nextAction'], [string, string]> = {
    VERIFY_DELIVERY: ['核实邮件投递结果后再决定后续操作', 'Verify delivery before deciding what to do next'],
    VERIFY_REPLY_LINK: ['人工核对并确认回邮关联', 'Review and confirm the reply link'],
    VERIFY_RECORD: ['核查询价、回邮和正式报价的关联及时间', 'Check inquiry, reply and formal-quote links and timestamps'],
    REVIEW_DRAFT_BINDING: ['检查草稿报价行与询价需求项的绑定', 'Review draft-to-inquiry-item bindings'],
    REVIEW_QUOTE_DRAFT: ['人工审核报价草稿，再确认录入正式报价', 'Review the quote draft, then confirm it as a formal quote'],
    CREATE_MANUAL_DRAFT: ['人工录入或修正报价草稿', 'Create or correct the quote draft manually'],
    WAIT_FOR_PROCESSING: ['等待发送或 AI 处理完成', 'Wait for sending or AI processing to finish'],
    FOLLOW_UP_SUPPLIER: ['人工跟进供应商是否已回复', 'Follow up with the supplier about a reply'],
    REVIEW_MISSING_ITEMS: ['核对尚未形成正式报价的需求项', 'Review items without a formal quote'],
    REVIEW_COMPARISON: ['比较正式报价并人工决定下一步', 'Compare formal quotes and decide the next step'],
    REVIEW_BEFORE_RESEND: ['检查失败原因后再决定是否重发', 'Review the failure before deciding whether to resend'],
    STOP_CANCELLED_RFQ: ['需求已取消：仅停止后续寻源，既发邮件不可撤回', 'RFQ cancelled: future sourcing stops; already-sent email cannot be recalled'],
    SEND_INQUIRY: ['审核询价内容后发送', 'Review the inquiry before sending'],
    NO_ACTION: ['无需操作', 'No action required'],
  };
  return tx(...labels[action]);
}

function createManualQuoteDraft(inquiry: Inquiry): SupplierQuoteDraftPayload {
  return {
    items: inquiry.items.map((item, index) => ({
      itemKey: `inquiry-item:${item.id ?? item.rfqLineId ?? item.lineNo ?? index + 1}`,
      inquiryItemId: item.id ?? null,
      partNumber: item.partNumber || null,
      quantity: item.quantity ?? null,
      quantityUnit: null,
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
    if (!item.quantityUnit?.trim()) issues.push(`${row}: ${tx('请核对并填写报价数量单位。', 'confirm the quoted quantity unit.')}`);
    if (typeof item.unitPrice !== 'number' || !Number.isFinite(item.unitPrice) || item.unitPrice < 0) issues.push(`${row}: ${tx('请填写有效单价。', 'enter a valid unit price.')}`);
    if (item.currency?.trim().toUpperCase() !== 'USD') issues.push(`${row}: ${tx('确认仅支持 USD 币种。', 'confirmation only supports USD.')}`);
    if (item.leadTimeMinDays != null || item.leadTimeMaxDays != null) issues.push(`${row}: ${tx('当前是交期区间，请填写单一交期。', 'lead time is a range; enter one single value.')}`);
    if (!Number.isInteger(item.leadTimeDays) || (item.leadTimeDays ?? -1) < 0) issues.push(`${row}: ${tx('请填写单一交期天数。', 'enter one lead time in days.')}`);
  });
  return issues;
}

function getPendingQuoteIssues(row: RfqSourcingPendingQuoteRow, tx: (zh: string, en: string) => string) {
  const issues: string[] = [];
  if (row.unitPrice == null) issues.push(tx('未提供单价', 'Unit price missing'));
  if (!row.currency) issues.push(tx('币种未说明', 'Currency missing'));
  else if (row.currency.toUpperCase() !== 'USD') issues.push(tx('非 USD，不能直接参与最低价', 'Non-USD; excluded from lowest-price ranking'));
  if (row.quantity == null) issues.push(tx('可供数量待核', 'Available quantity unverified'));
  if (!row.quantityUnit) issues.push(tx('数量单位待核', 'Quantity unit unverified'));
  if (row.leadTimeMinDays != null || row.leadTimeMaxDays != null) {
    issues.push(tx('交期为区间，待确认单一交期', 'Lead time is a range; confirm a single value'));
  } else if (row.leadTimeDays == null) {
    issues.push(tx('交期未说明', 'Lead time missing'));
  }
  if (!row.condition) issues.push(tx('成色未说明', 'Condition missing'));
  if (row.certificate == null) issues.push(tx('证书未说明', 'Certificate missing'));
  if (row.taxIncluded == null) issues.push(tx('税费口径未知', 'Tax basis unknown'));
  if (row.freightIncluded == null) issues.push(tx('运费口径未知', 'Freight basis unknown'));
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
    QUANTITY_UNIT_UNKNOWN: ['报价或需求单位未知', 'Quote or demand unit is unknown'],
    QUANTITY_UNIT_MISMATCH: ['报价单位与需求单位不一致', 'Quote unit differs from demand unit'],
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
  onPersistedChange?: () => Promise<void>;
}

function ReplyReviewDialog({ inquiry, open, onOpenChange, tx, onConfirmed, onPersistedChange }: ReplyReviewDialogProps) {
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
      void onPersistedChange?.();
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
      void onPersistedChange?.();
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
      void onPersistedChange?.();
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
      void onPersistedChange?.();
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
      void onPersistedChange?.();
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
      const result = extractionTask?.status === 'COMPLETED' && extractionTask.draftId === draft.id
        ? await sourcingAiTaskApi.confirmDraft(extractionTask.id, { expectedVersion: draft.version })
        : await supplierQuoteDraftApi.confirm(draft.id, { expectedVersion: draft.version });
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
                  <div className="space-y-1"><Label htmlFor={`draft-unit-${index}`}>{tx('报价数量单位', 'Quoted unit')} {index + 1}</Label><Input id={`draft-unit-${index}`} maxLength={80} value={item.quantityUnit ?? ''} onChange={(event) => updateDraftItem(item.itemKey, (current) => ({ ...current, quantityUnit: event.target.value.trim().toUpperCase() || null }))} placeholder="EA" /></div>
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

function InventoryMatchCard({ item, partNumber, uom }: { item: InventoryItem; partNumber: string; uom: string }) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const isMatch = item.partNumber.toUpperCase() === partNumber.toUpperCase();
  const firstDetail = item.details?.[0];

  return (
    <Card className={cn(
      'transition-all duration-200',
      isMatch && 'ring-2 ring-green-500 bg-green-50/30',
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
            <p className="font-semibold">{item.totalQuantity ?? 0} {uom}</p>
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
  const can = useCapabilityStore((state) => state.can);
  const tx = useCallback((zh: string, en: string) => (locale === 'zh-CN' ? zh : en), [locale]);
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
  const { compare } = useCompareSupplierQuotes();

  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  const [selectedRFQs, setSelectedRFQs] = useState<string[]>(() => {
    const linkedId = new URLSearchParams(window.location.search).get('rfqId');
    return linkedId ? [linkedId] : [];
  });
  const [deepLinkedRfq, setDeepLinkedRfq] = useState<RFQ | null>(null);
  const [selectedLineIds, setSelectedLineIds] = useState<string[]>([]);
  const [isInquiryDialogOpen, setIsInquiryDialogOpen] = useState(false);
  const [inquiryNote, setInquiryNote] = useState('');
  const [isAOG, setIsAOG] = useState(false);
  const [comparisonByLine, setComparisonByLine] = useState<Record<string, LineCompareState>>({});
  const [candidateData, setCandidateData] = useState<RfqSourcingCandidates | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState('');
  const [inquiryUpdates, setInquiryUpdates] = useState<Record<string, Inquiry>>({});
  const [previewInquiryId, setPreviewInquiryId] = useState<string | null>(null);
  const [reviewInquiryId, setReviewInquiryId] = useState<string | null>(null);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [sendTask, setSendTask] = useState<SourcingActionTaskRecord | null>(null);
  const [sendLoading, setSendLoading] = useState(false);
  const [sendTaskLoading, setSendTaskLoading] = useState(false);
  const [sendError, setSendError] = useState('');
  const sendTaskKey = useRef<{ signature: string; key: string } | null>(null);
  const sendInFlight = useRef(false);
  const [progressRefreshVersion, setProgressRefreshVersion] = useState(0);
  const [timelineRefreshVersion, setTimelineRefreshVersion] = useState(0);
  const [pendingMatchInquirySelections, setPendingMatchInquirySelections] = useState<Record<string, string>>({});
  const [pendingMatchReasons, setPendingMatchReasons] = useState<Record<string, string>>({});
  const [pendingMatchLinkErrors, setPendingMatchLinkErrors] = useState<Record<string, string>>({});
  const [linkingEmailId, setLinkingEmailId] = useState<string | null>(null);
  const [cancellingInquiryId, setCancellingInquiryId] = useState<string | null>(null);
  const [winnerConfirmation, setWinnerConfirmation] = useState<{ quoteId: string; supplierName: string; line: SourcingDemandLine; action: 'select' | 'clear'; expectedUpdatedAt?: string } | null>(null);
  const [selectingWinnerId, setSelectingWinnerId] = useState<string | null>(null);
  const [winnerTask, setWinnerTask] = useState<SourcingActionTaskRecord | null>(null);
  const [winnerTaskLoading, setWinnerTaskLoading] = useState(false);
  const [winnerTaskError, setWinnerTaskError] = useState('');
  const winnerTaskKey = useRef<{ quoteId: string; key: string } | null>(null);
  const [sourcingTimeline, setSourcingTimeline] = useState<RfqSourcingTimeline | null>(null);
  const [sourcingTimelineLoading, setSourcingTimelineLoading] = useState(false);
  const [sourcingTimelineError, setSourcingTimelineError] = useState('');
  const [deepLinkedLineId] = useState(() => new URLSearchParams(window.location.search).get('rfqLineId'));
  const [deepLinkedQuoteId] = useState(() => new URLSearchParams(window.location.search).get('supplierQuoteId'));
  const lastScrolledContext = useRef('');

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
    () => selectedRFQs.length > 0
      ? pendingRFQs.find((r) => r.id === selectedRFQs[0])
        ?? rfqs?.find((r) => r.id === selectedRFQs[0])
        ?? (deepLinkedRfq?.id === selectedRFQs[0] ? deepLinkedRfq : null)
      : null,
    [deepLinkedRfq, pendingRFQs, rfqs, selectedRFQs]
  );
  useEffect(() => {
    const id = selectedRFQs[0];
    if (!id || rfqs?.some((rfq) => rfq.id === id)) return;
    let cancelled = false;
    void rfqApi.getById(id).then((rfq) => { if (!cancelled) setDeepLinkedRfq(rfq); }).catch(() => { if (!cancelled) setDeepLinkedRfq(null); });
    return () => { cancelled = true; };
  }, [rfqs, selectedRFQs]);
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
  const orderedSourcingTimeline = useMemo(() => [...(sourcingTimeline?.events ?? [])].sort((left, right) => {
    const leftTime = Date.parse(left.occurredAt);
    const rightTime = Date.parse(right.occurredAt);
    return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
  }), [sourcingTimeline]);
  const unassignedSourcingCounts = sourcingTimeline?.counts?.unassignedNeedsVerification;
  const hasUnassignedSourcingCounts = Boolean(unassignedSourcingCounts && (
    unassignedSourcingCounts.pendingQuoteCount > 0
    || unassignedSourcingCounts.pendingConfirmationCount > 0
    || unassignedSourcingCounts.supplierQuoteCount > 0
    || unassignedSourcingCounts.unreadableDraftCount > 0
  ));
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
    if (!previewInquiryId) {
      setSendTask(null);
      setSendTaskLoading(false);
      return;
    }
    let active = true;
    setSendTask(null);
    setSendError('');
    setSendTaskLoading(true);
    void sourcingActionTaskApi.list({ targetId: previewInquiryId, limit: 20 }).then((tasks) => {
      if (!active) return;
      const task = tasks.find((candidate) => candidate.action === 'SEND_INQUIRY'
        && ['WAITING_HUMAN', 'FAILED'].includes(candidate.status)) ?? null;
      setSendTask((current) => current?.targetId === previewInquiryId ? current : task);
      if (task?.contentSnapshot && !sendTaskKey.current) {
        setEmailSubject(task.contentSnapshot.subject);
        setEmailBody(task.contentSnapshot.textBody);
      }
    }).catch((error: unknown) => {
      if (active) setSendError(error instanceof Error ? error.message : tx('无法恢复待确认任务，请刷新后重试。', 'Could not restore the pending task. Refresh and retry.'));
    }).finally(() => { if (active) setSendTaskLoading(false); });
    return () => { active = false; };
  }, [previewInquiryId, tx]);

  useEffect(() => {
    const quoteId = winnerConfirmation?.action === 'select' ? winnerConfirmation.quoteId : null;
    if (!quoteId) {
      setWinnerTask(null);
      setWinnerTaskError('');
      setWinnerTaskLoading(false);
      return;
    }
    let active = true;
    setWinnerTask(null);
    setWinnerTaskError('');
    setWinnerTaskLoading(true);
    void sourcingActionTaskApi.list({ targetId: quoteId, limit: 20 }).then((tasks) => {
      if (!active) return;
      const task = tasks.find((candidate) => candidate.action === 'SELECT_WINNER'
        && ['WAITING_HUMAN', 'FAILED'].includes(candidate.status)) ?? null;
      setWinnerTask((current) => current?.targetId === quoteId ? current : task);
    }).catch((error: unknown) => {
      if (active) setWinnerTaskError(error instanceof Error ? error.message : tx('无法恢复待确认任务，请刷新后重试。', 'Could not restore the pending task. Refresh and retry.'));
    }).finally(() => { if (active) setWinnerTaskLoading(false); });
    return () => { active = false; };
  }, [winnerConfirmation?.action, winnerConfirmation?.quoteId, tx]);

  useEffect(() => {
    if (!selectedRfqId) {
      setCandidateData(null);
      setCandidateError('');
      setCandidateLoading(false);
      return;
    }
    let cancelled = false;
    setCandidateData(null);
    setCandidateError('');
    setCandidateLoading(true);
    void rfqApi.getSourcingCandidates(selectedRfqId).then((result) => {
      if (!cancelled) setCandidateData(result);
    }).catch((error: unknown) => {
      if (!cancelled) setCandidateError(error instanceof Error ? error.message : 'Supplier evidence request failed');
    }).finally(() => {
      if (!cancelled) setCandidateLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedRfqId]);

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

  useEffect(() => {
    if (!selectedRfqId) {
      setSourcingTimeline(null);
      setSourcingTimelineError('');
      setSourcingTimelineLoading(false);
      return;
    }
    let cancelled = false;
    setSourcingTimelineLoading(true);
    setSourcingTimelineError('');
    void rfqApi.getSourcingTimeline(selectedRfqId).then((timeline) => {
      if (!cancelled) setSourcingTimeline(timeline);
    }).catch((error: unknown) => {
      if (!cancelled) setSourcingTimelineError(error instanceof Error ? error.message : tx('寻源时间线加载失败。', 'Could not load the sourcing timeline.'));
    }).finally(() => {
      if (!cancelled) setSourcingTimelineLoading(false);
    });
    return () => { cancelled = true; };
  }, [timelineRefreshVersion, selectedRfqId, tx]);

  useEffect(() => {
    if (!selectedRFQ || (!deepLinkedLineId && !deepLinkedQuoteId)) return;
    const contextKey = `${selectedRFQ.id}:${deepLinkedLineId || ''}:${deepLinkedQuoteId || ''}`;
    const targetId = deepLinkedQuoteId
      ? `sourcing-quote-${deepLinkedQuoteId}`
      : `sourcing-line-${deepLinkedLineId}`;
    const target = document.getElementById(targetId);
    if (!target || lastScrolledContext.current === contextKey) return;
    lastScrolledContext.current = contextKey;
    target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [comparisonByLine, deepLinkedLineId, deepLinkedQuoteId, progressLines, selectedRFQ]);

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
      setProgressRefreshVersion((version) => version + 1);
      setTimelineRefreshVersion((version) => version + 1);
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
    if (!previewInquiry || sendInFlight.current || sendTaskLoading) return;
    sendInFlight.current = true;
    setSendLoading(true);
    setSendError('');
    try {
      if (sendTask?.status === 'FAILED') {
        const retried = await sourcingActionTaskApi.retry(sendTask.id);
        setSendTask(retried);
        toast.success(tx('任务已恢复待确认；请再次核对邮件内容，尚未发送。', 'The task is ready for review again; no email has been sent.'));
        setTimelineRefreshVersion((version) => version + 1);
        return;
      }
      if (!sendTask) {
        const signature = JSON.stringify([previewInquiry.id, emailSubject.trim(), emailBody.trim()]);
        if (sendTaskKey.current?.signature !== signature) {
          sendTaskKey.current = { signature, key: crypto.randomUUID() };
        }
        const staged = await sourcingActionTaskApi.create({
          action: 'SEND_INQUIRY', targetId: previewInquiry.id,
          content: { subject: emailSubject, textBody: emailBody },
          idempotencyKey: sendTaskKey.current.key,
        });
        setSendTask(staged);
        if (staged.status === 'COMPLETED') {
          if (!staged.outboundEmailId || !staged.result || !('inquiryId' in staged.result)
            || staged.result.inquiryId !== previewInquiry.id || staged.result.outboundEmailId !== staged.outboundEmailId) {
            throw new Error(tx('原发送任务结果待核实，请刷新核对实际发件记录。', 'The prior send result needs verification. Refresh the outbound record.'));
          }
          sendTaskKey.current = null;
          try {
            const updatedInquiry = await inquiryApi.getById(previewInquiry.id);
            setInquiryUpdates((previous) => ({ ...previous, [updatedInquiry.id]: updatedInquiry }));
            await refetchInquiries();
          } catch { /* A committed send remains committed when refresh fails. */ }
          setProgressRefreshVersion((version) => version + 1);
          setTimelineRefreshVersion((version) => version + 1);
          setPreviewInquiryId(null);
          toast.success(tx('此任务已有入队结果，请核对实际投递状态。', 'This task was already queued. Check its delivery status.'));
          return;
        }
        if (staged.status === 'CANCELLED') {
          sendTaskKey.current = null;
          setSendTask(null);
          throw new Error(tx('原待确认任务已取消，请重新核对后创建新任务。', 'The prior task was cancelled. Review and create a new one.'));
        }
        setEmailSubject(staged.contentSnapshot?.subject ?? emailSubject);
        setEmailBody(staged.contentSnapshot?.textBody ?? emailBody);
        if (staged.status === 'FAILED') {
          toast.error(tx('已有失败任务，请核对原因并决定重试或重新建立。', 'A prior task failed. Review it before retrying or recreating.'));
        } else {
          toast.success(tx('待确认邮件版本已保存；请再次核对后确认入队。', 'The review version is saved. Check it again before queueing.'));
        }
        setTimelineRefreshVersion((version) => version + 1);
        return;
      }
      if (sendTask.status !== 'WAITING_HUMAN' || !sendTask.contentSnapshot
        || sendTask.contentSnapshot.subject !== emailSubject.trim()
        || sendTask.contentSnapshot.textBody !== emailBody.trim()) {
        throw new Error(tx('待确认任务与当前邮件内容不一致，请取消任务后重新核对。', 'The staged task differs from the email. Cancel it and review again.'));
      }
      const completed = await sourcingActionTaskApi.confirm(sendTask.id, sendTask.version);
      if (completed.status !== 'COMPLETED' || !completed.outboundEmailId || !completed.result
        || !('inquiryId' in completed.result) || completed.result.inquiryId !== previewInquiry.id
        || completed.result.outboundEmailId !== completed.outboundEmailId) {
        throw new Error(tx('发送任务结果待核实，请刷新状态。', 'The send result needs verification. Refresh its status.'));
      }
      setSendTask(completed);
      sendTaskKey.current = null;
      try {
        const updatedInquiry = await inquiryApi.getById(previewInquiry.id);
        setInquiryUpdates((previous) => ({ ...previous, [updatedInquiry.id]: updatedInquiry }));
        await refetchInquiries();
      } catch {
        // The command is already committed. A failed refresh must not be
        // reported as a failed send or trigger a second confirmation.
      }
      setProgressRefreshVersion((version) => version + 1);
      setTimelineRefreshVersion((version) => version + 1);
      toast.success(tx('询价邮件已入队，实际投递结果请查看发送状态。', 'The email is queued. Check delivery status separately.'));
      setPreviewInquiryId(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : tx('受控发送任务失败，请刷新核实。', 'The controlled send task failed. Refresh to verify it.');
      setSendError(message);
      toast.error(message);
      if (sendTask) {
        void sourcingActionTaskApi.getById(sendTask.id).then(setSendTask).catch(() => undefined);
      }
    } finally {
      sendInFlight.current = false;
      setSendLoading(false);
    }
  };

  const handleCancelSendTask = async () => {
    if (!sendTask || sendLoading) return;
    setSendLoading(true);
    setSendError('');
    try {
      await sourcingActionTaskApi.cancel(sendTask.id);
      setSendTask(null);
      sendTaskKey.current = null;
      setTimelineRefreshVersion((version) => version + 1);
      toast.success(tx('待确认任务已取消，邮件未因此发送。', 'The pending task was cancelled; no email was sent.'));
    } catch (error) {
      setSendError(error instanceof Error ? error.message : tx('任务取消失败。', 'Could not cancel the task.'));
    } finally {
      setSendLoading(false);
    }
  };

  const handleCancelInquirySend = async (inquiry: Inquiry) => {
    setCancellingInquiryId(inquiry.id);
    try {
      const updatedInquiry = await inquiryApi.cancelSend(inquiry.id);
      setInquiryUpdates((previous) => ({ ...previous, [updatedInquiry.id]: updatedInquiry }));
      await refetchInquiries();
      setProgressRefreshVersion((version) => version + 1);
      setTimelineRefreshVersion((version) => version + 1);
      toast.success(tx('排队任务已在 Worker 领取前取消，邮件快照已保留。', 'Queued send was cancelled before worker claim; its email snapshot was retained.'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tx('无法安全取消，请刷新并核实投递状态。', 'Could not safely cancel. Refresh and verify delivery status.'));
      await refetchInquiries();
    } finally {
      setCancellingInquiryId(null);
    }
  };

  const handleRefreshProgress = async () => {
    await refetchInquiries();
    setInquiryUpdates({});
    setProgressRefreshVersion((version) => version + 1);
    setTimelineRefreshVersion((version) => version + 1);
  };

  const handleRefreshTimeline = async () => {
    setTimelineRefreshVersion((version) => version + 1);
  };

  const handleSelectWinner = async () => {
    if (!winnerConfirmation || selectingWinnerId || winnerTaskLoading) return;
    setSelectingWinnerId(winnerConfirmation.quoteId);
    setWinnerTaskError('');
    try {
      if (winnerConfirmation.action === 'clear') {
        if (!winnerConfirmation.expectedUpdatedAt) throw new Error(tx('报价版本未知，请刷新比价后重试。', 'Quote version is unknown. Refresh comparison and try again.'));
        await supplierQuoteApi.clearWinner(winnerConfirmation.quoteId, winnerConfirmation.expectedUpdatedAt);
      } else if (winnerTask?.status === 'FAILED') {
        const retried = await sourcingActionTaskApi.retry(winnerTask.id);
        setWinnerTask(retried);
        setTimelineRefreshVersion((version) => version + 1);
        toast.success(tx('中选任务已恢复待确认，尚未改变中选结果。', 'The selection task is ready for review; the winner has not changed.'));
        return;
      } else if (!winnerTask) {
        if (!winnerConfirmation.expectedUpdatedAt) throw new Error(tx('报价版本未知，请刷新比价。', 'Quote version is unknown. Refresh comparison.'));
        if (winnerTaskKey.current?.quoteId !== winnerConfirmation.quoteId) {
          winnerTaskKey.current = { quoteId: winnerConfirmation.quoteId, key: crypto.randomUUID() };
        }
        const staged = await sourcingActionTaskApi.create({
          action: 'SELECT_WINNER', targetId: winnerConfirmation.quoteId,
          expectedUpdatedAt: winnerConfirmation.expectedUpdatedAt,
          idempotencyKey: winnerTaskKey.current.key,
        });
        setWinnerTask(staged);
        setTimelineRefreshVersion((version) => version + 1);
        if (staged.status === 'COMPLETED') {
          if (!staged.result || !('supplierQuoteId' in staged.result)
            || staged.result.supplierQuoteId !== winnerConfirmation.quoteId || staged.result.isWinner !== true) {
            throw new Error(tx('原中选任务结果待核实，请刷新核对当前报价。', 'The prior selection result needs verification. Refresh the quote.'));
          }
          winnerTaskKey.current = null;
          setWinnerConfirmation(null);
          try { await handleRefreshProgress(); } catch { /* Persisted selection is still committed. */ }
          toast.success(tx('此中选任务已有结果，请核对当前报价状态。', 'This selection task already has a result. Check the current quote state.'));
          return;
        }
        if (staged.status === 'CANCELLED') {
          winnerTaskKey.current = null;
          setWinnerTask(null);
          throw new Error(tx('原待确认中选任务已取消，请重新核对后创建。', 'The prior selection task was cancelled. Review and create a new one.'));
        }
        if (staged.status === 'FAILED') {
          toast.error(tx('已有失败中选任务，请核对原因并决定重试或重新建立。', 'A prior selection task failed. Review it before retrying or recreating.'));
          return;
        }
        toast.success(tx('待确认中选任务已保存；请再次核对并确认。', 'The selection task is saved. Review it once more before confirming.'));
        return;
      } else {
        if (winnerTask.status !== 'WAITING_HUMAN') throw new Error(tx('此中选任务不可确认，请刷新。', 'This selection task cannot be confirmed. Refresh it.'));
        const completed = await sourcingActionTaskApi.confirm(winnerTask.id, winnerTask.version);
        if (completed.status !== 'COMPLETED' || !completed.result || !('supplierQuoteId' in completed.result)
          || completed.result.supplierQuoteId !== winnerConfirmation.quoteId || completed.result.isWinner !== true) {
          throw new Error(tx('中选结果待核实，请刷新后查看实际状态。', 'The selection result needs verification. Refresh the actual state.'));
        }
        setWinnerTask(completed);
        winnerTaskKey.current = null;
      }
      setWinnerConfirmation(null);
      toast.success(winnerConfirmation.action === 'clear'
        ? tx('已取消当前中选，原报价和下游引用未改动。', 'Current selection cleared; the quote and downstream references were not changed.')
        : tx('已记录人工中选，请继续核对客户报价。', 'Manual supplier selection was recorded. Review the customer quotation next.'));
      try { await handleRefreshProgress(); } catch {
        setProgressRefreshVersion((version) => version + 1);
        setTimelineRefreshVersion((version) => version + 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : tx('中选操作失败，请刷新比价后重试。', 'Selection change failed. Refresh the comparison and try again.');
      setWinnerTaskError(message);
      toast.error(message);
      if (winnerTask) void sourcingActionTaskApi.getById(winnerTask.id).then(setWinnerTask).catch(() => undefined);
    } finally {
      setSelectingWinnerId(null);
    }
  };

  const handleCancelWinnerTask = async () => {
    if (!winnerTask || selectingWinnerId || !winnerConfirmation) return;
    setSelectingWinnerId(winnerConfirmation.quoteId);
    setWinnerTaskError('');
    try {
      await sourcingActionTaskApi.cancel(winnerTask.id);
      setWinnerTask(null);
      winnerTaskKey.current = null;
      setTimelineRefreshVersion((version) => version + 1);
      toast.success(tx('待确认中选任务已取消，当前中选未改变。', 'The pending selection task was cancelled; the current winner is unchanged.'));
    } catch (error) {
      setWinnerTaskError(error instanceof Error ? error.message : tx('任务取消失败。', 'Could not cancel the task.'));
    } finally {
      setSelectingWinnerId(null);
    }
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
      setTimelineRefreshVersion((version) => version + 1);
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="w-5 h-5 text-brand-primary" />
                {tx('选择需求行', 'Select demand lines')}
                <span className="text-sm font-normal text-gray-500">({inquiryLineIds.length} {tx('已选', 'selected')})</span>
              </CardTitle>
              <QuoteAnalysisAssistant rfqId={selectedRFQ.id} />
            </div>
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
        <>
        <Card role="region" aria-label={tx('寻源业务时间线', 'Sourcing business timeline')}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Clock3 className="h-5 w-5 text-brand-primary" />
              {tx('寻源业务时间线', 'Sourcing business timeline')}
              <Badge variant="outline">{orderedSourcingTimeline.length}</Badge>
            </CardTitle>
            <p className="text-sm text-gray-500">
              {tx('按服务端已保存的业务记录排序；刷新后可从原记录恢复，未记录的操作者会明确标为“未记录”。', 'Sorted from persisted server business records and recoverable after refresh; missing actors are shown as “Not recorded”.')}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {sourcingTimelineLoading && <p className="text-sm text-gray-500" role="status">{tx('正在加载已保存的寻源事件…', 'Loading persisted sourcing events…')}</p>}
            {sourcingTimelineError && <p className="text-sm text-red-700" role="alert">{tx('时间线加载失败', 'Timeline load failed')}: {sourcingTimelineError}</p>}
            {hasUnassignedSourcingCounts && unassignedSourcingCounts && (
                <div role="status" aria-label={tx('未能精确归属的寻源记录', 'Sourcing records without a verified line binding')} className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <p className="font-medium">{tx('有记录无法精确归属，待核实', 'Some records cannot be assigned to a line and need verification')}</p>
                  <p className="mt-1">
                    {tx('待报价项', 'Pending quote items')}: {unassignedSourcingCounts.pendingQuoteCount}
                    {' · '}{tx('待人工确认项', 'Pending human confirmation items')}: {unassignedSourcingCounts.pendingConfirmationCount}
                    {' · '}{tx('正式报价归属待核实', 'Formal quotes needing line verification')}: {unassignedSourcingCounts.supplierQuoteCount}
                    {' · '}{tx('无法读取的草稿', 'Unreadable drafts')}: {unassignedSourcingCounts.unreadableDraftCount}
                  </p>
                  <p className="mt-1 text-xs">{tx('这些计数只按明确的需求行/询价需求项关联生成，不会按相同件号推测归属。', 'Counts use explicit line and inquiry-item links; matching part numbers are never used to infer ownership.')}</p>
                </div>
            )}
            {!sourcingTimelineLoading && !sourcingTimelineError && orderedSourcingTimeline.length === 0 && (
              <p className="rounded border border-dashed p-3 text-sm text-gray-500">{tx('当前需求单尚无可显示的已保存寻源事件。', 'No persisted sourcing events are available for this RFQ yet.')}</p>
            )}
            {orderedSourcingTimeline.map((event: RfqSourcingTimelineEvent) => {
              const line = progressLines.find((candidate) => candidate.rfqLineId === event.rfqLineId);
              const typeLabels: Record<string, [string, string]> = {
                RFQ_STATUS: ['需求状态', 'RFQ status'],
                INQUIRY_CREATED: ['询价已创建', 'Inquiry created'],
                INQUIRY_SEND_CONFIRMED: ['人工确认询价发送', 'Inquiry send confirmed by staff'],
                OUTBOUND_EMAIL: ['询价邮件发送', 'Outbound email'],
                INBOUND_EMAIL: ['供应商回邮', 'Inbound email'],
                INBOUND_LINK_CONFIRMED: ['回邮关联已人工确认', 'Reply link confirmed by staff'],
                AI_TASK: ['AI 处理任务', 'AI task'],
                ACTION_TASK: ['人工确认任务', 'Human-confirmed action task'],
                QUOTE_DRAFT: ['供应商报价草稿', 'Supplier quote draft'],
                QUOTE_DRAFT_REVISED: ['人工修订报价草稿', 'Quote draft revised by staff'],
                QUOTE_DRAFT_CONFIRMED: ['报价草稿已人工确认', 'Quote draft confirmed by staff'],
                SUPPLIER_QUOTE: ['供应商正式报价', 'Supplier quote'],
                WINNER_SELECTED: ['人工中选', 'Manual winner selection'],
              };
              const [typeLabelZh, typeLabelEn] = typeLabels[event.type] ?? [event.type, event.type];
              const eventTime = new Date(event.occurredAt);
              const displayTime = Number.isNaN(eventTime.getTime()) ? event.occurredAt : eventTime.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
              const artifacts = [
                event.inquiryId && [tx('询价', 'Inquiry'), event.inquiryId],
                event.outboundEmailId && [tx('发件版本', 'Outbound version'), event.outboundEmailId],
                event.emailId && [tx('邮件', 'Email'), event.emailId],
                event.draftId && [tx('草稿', 'Draft'), event.draftId],
                event.supplierQuoteId && [tx('报价', 'Quote'), event.supplierQuoteId],
                event.actionTaskId && [tx('受控任务', 'Action task'), event.actionTaskId],
              ].filter((artifact): artifact is [string, string] => Boolean(artifact));
              const originalCandidateRows = event.originalAiCandidates?.items.map((candidate, index) => {
                const leadTime = candidate.leadTimeDays !== null
                  ? `${candidate.leadTimeDays} ${tx('天', 'days')}`
                  : candidate.leadTimeMinDays !== null || candidate.leadTimeMaxDays !== null
                    ? `${candidate.leadTimeMinDays ?? '—'}–${candidate.leadTimeMaxDays ?? '—'} ${tx('天', 'days')}`
                    : null;
                const fields = [
                  candidate.partNumber && `${tx('件号', 'Part number')}: ${candidate.partNumber}`,
                  candidate.quantity !== null && `${tx('数量', 'Quantity')}: ${candidate.quantity}${candidate.quantityUnit ? ` ${candidate.quantityUnit}` : ''}`,
                  candidate.unitPrice !== null && `${tx('单价', 'Unit price')}: ${candidate.unitPrice}${candidate.currency ? ` ${candidate.currency}` : ''}`,
                  leadTime && `${tx('交期', 'Lead time')}: ${leadTime}`,
                  candidate.validUntil && `${tx('有效期至', 'Valid until')}: ${candidate.validUntil}`,
                  candidate.taxIncluded !== null && `${tx('税费', 'Tax')}: ${tx(candidate.taxIncluded ? '含税' : '未含税', candidate.taxIncluded ? 'Included' : 'Excluded')}`,
                  candidate.freightIncluded !== null && `${tx('运费', 'Freight')}: ${tx(candidate.freightIncluded ? '含运费' : '未含运费', candidate.freightIncluded ? 'Included' : 'Excluded')}`,
                  candidate.incoterm && `${tx('贸易术语', 'Incoterm')}: ${candidate.incoterm}`,
                ].filter((field): field is string => Boolean(field));
                return { key: candidate.itemKey ?? `${event.id}:${index}`, fields };
              });
              return (
                <article key={event.id} className="rounded border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{tx(typeLabelZh, typeLabelEn)}</Badge>
                    <Badge variant="outline">{event.status}</Badge>
                    {line && <span className="text-xs text-gray-600">{tx(`需求行 ${line.lineNo}`, `Demand line ${line.lineNo}`)} · {line.partNumber}</span>}
                    <time className="ml-auto text-xs text-gray-500" dateTime={event.occurredAt}>{displayTime}</time>
                  </div>
                  <p className="mt-2 text-sm">{event.summary}</p>
                  <p className="mt-1 text-xs text-gray-600">
                    {tx('操作者', 'Actor')}: {event.actor?.name || tx('未记录', 'Not recorded')}
                    {event.actor?.kind ? <> · <code>{event.actor.kind}</code>{event.actor.kind === 'external_email' && ` · ${tx('外部发件人身份未验证', 'external sender identity is unverified')}`}</> : ''}
                  </p>
                  {event.originalAiCandidates && (
                    <section className="mt-3 rounded bg-slate-50 p-3" aria-label={tx('AI 原始候选建议', 'Original AI candidate suggestions')}>
                      <p className="text-xs font-medium text-slate-700">{tx('AI 建稿时原始建议快照', 'Original suggestions saved when the AI draft was created')}</p>
                      {!event.originalAiCandidates.available ? (
                        <p className="mt-1 text-xs text-gray-600">
                          {tx(
                            event.originalAiCandidates.candidateCount === null
                              ? '此历史 AI 草稿未保存原始建议明细。'
                              : `此历史 AI 草稿只记录了 ${event.originalAiCandidates.candidateCount} 条候选数，原始建议明细不可用。`,
                            event.originalAiCandidates.candidateCount === null
                              ? 'Original suggestion details were not saved for this historical AI draft.'
                              : `This historical AI draft records ${event.originalAiCandidates.candidateCount} candidates, but the original details are unavailable.`,
                          )}
                        </p>
                      ) : (
                        <>
                          <p className="mt-1 text-xs text-gray-600">
                            {tx('候选数', 'Candidate count')}: {event.originalAiCandidates.candidateCount ?? event.originalAiCandidates.items.length}
                            {event.originalAiCandidates.truncated && ` · ${tx('快照已截断', 'Snapshot truncated')}`}
                          </p>
                          {originalCandidateRows && originalCandidateRows.length > 0 && (
                            <ol className="mt-2 space-y-1 text-xs text-slate-700">
                              {originalCandidateRows.map((candidate, index) => (
                                <li key={candidate.key}>
                                  <span className="font-medium">{tx('候选', 'Candidate')} {index + 1}</span>
                                  {candidate.fields.length > 0 && <> · {candidate.fields.join(' · ')}</>}
                                </li>
                              ))}
                            </ol>
                          )}
                        </>
                      )}
                    </section>
                  )}
                  {artifacts.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2 text-xs" aria-label={tx('时间线产物', 'Timeline artifacts')}>
                      {artifacts.map(([label, id]) => <li key={`${event.id}:${label}`} className="rounded bg-slate-100 px-2 py-1">{label}: <code>{id}</code></li>)}
                    </ul>
                  )}
                </article>
              );
            })}
          </CardContent>
        </Card>
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
                  const candidateLine = candidateData?.lines.find((item) => item.rfqLineId === line.rfqLineId && item.lineNo === line.lineNo);
                  const samePartNumberLineCount = progressLines.filter((candidate) => candidate.partNumber === line.partNumber).length;
                  const lineInquiries = selectedRFQInquiries.filter((inquiry) => inquiryIncludesLine(inquiry, line, samePartNumberLineCount));
                  const exactSourcingCounts = line.rfqLineId
                    ? sourcingTimeline?.counts?.lines.find((counts) => counts.rfqLineId === line.rfqLineId)
                    : undefined;
                  const lineWorkflowState = line.rfqLineId
                    ? sourcingTimeline?.lineWorkflowStates?.find((state) => state.rfqLineId === line.rfqLineId)
                    : undefined;
                  const comparison = comparisonByLine[line.key];
                  const pendingQuoteRows = line.rfqLineId
                    ? (sourcingTimeline?.pendingQuoteRows ?? []).filter((row) => row.rfqLineId === line.rfqLineId)
                    : [];
                  const quotes = comparison?.result?.quotes ?? [];
                  const comparisonSummary = comparison?.result?.summary;
                  const quoteCount = comparisonSummary?.totalQuotes ?? quotes.length;
                  const states = lineInquiries.map(getInquiryProgressState);
                  const hasFailedInquiry = states.includes('failed') || states.includes('needs_verification');
                  const hasUnsentDraft = lineInquiries.some((inquiry) => inquiry.status === 'draft');
                  const hasQueuedInquiry = states.some((state) => state === 'queued' || state === 'pending' || state === 'processing' || state === 'retrying');
                  const hasSentInquiry = states.some((state) => state === 'smtp_accepted' || state === 'sent' || state === 'responded');
                  const hasSkippedInquiry = states.includes('skipped');
                  const nextAction = lineWorkflowState
                    ? getSourcingWorkflowActionLabel(lineWorkflowState.nextAction, tx)
                    : hasFailedInquiry
                    ? tx('核对发件箱或联系供应商；确认结果前不要再次发送。', 'Check the sent folder or contact the supplier; do not send again until delivery is verified.')
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
                    <Card id={line.rfqLineId ? `sourcing-line-${line.rfqLineId}` : undefined} key={line.key} role="region" aria-label={tx(`需求行 ${line.lineNo} · ${line.partNumber}`, `Demand line ${line.lineNo} · ${line.partNumber}`)} className={cn('border-gray-200', deepLinkedLineId === line.rfqLineId && 'border-blue-500 ring-2 ring-blue-200')}>
                      <CardHeader className="pb-3">
                        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                          <span>{tx(`行 ${line.lineNo}`, `Line ${line.lineNo}`)} · <span className="font-mono">{line.partNumber}</span></span>
                          <Badge variant="outline">{tx('数量', 'Qty')}: {line.quantity} {line.uom}</Badge>
                        </CardTitle>
                        <p className="text-sm text-gray-500">
                          {tx('需求日期', 'Required date')}: {line.requiredDate || '—'}
                          {line.certificateRequired && ` · ${tx('需要合格证', 'Certificate required')}`}
                        </p>
                        {lineWorkflowState && (
                          <div aria-label={tx('需求行寻源阶段', 'Demand-line sourcing stage')} className="rounded border border-blue-100 bg-blue-50 p-2 text-sm text-blue-900">
                            <span className="font-medium">{getSourcingWorkflowStatusLabel(lineWorkflowState.status, tx)}</span>
                            <span> · {nextAction}</span>
                            <p className="text-xs">
                              {tx('当前正式报价覆盖询价项', 'Current formal quote coverage')}:
                              {' '}{lineWorkflowState.quoteCoverage.quotedInquiryItemCount}/{lineWorkflowState.quoteCoverage.activeInquiryItemCount}
                              {' · '}{tx('正式报价记录', 'Formal quote records')}: {lineWorkflowState.quoteCoverage.currentFormalQuoteCount}
                            </p>
                            <p className="text-xs">{tx('此阶段只表示正式报价记录覆盖；数量、商务条件与采购承诺须另行核对。', 'This stage only tracks formal quote records; verify quantity, terms and purchase commitments separately.')}</p>
                          </div>
                        )}
                        <div aria-label={tx('需求行寻源待办计数', 'Demand-line sourcing counts')} className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                          <span>{tx('待报价项', 'Pending quote items')}: {exactSourcingCounts?.pendingQuoteCount ?? tx('待核实', 'Needs verification')}</span>
                          <span>{tx('待人工确认项', 'Pending human confirmation items')}: {exactSourcingCounts?.pendingConfirmationCount ?? tx('待核实', 'Needs verification')}</span>
                          <span className="text-muted-foreground">{tx('待办项数与可比报价数不同；数量缺口以比价摘要为准。', 'Work-item counts differ from comparable quotes; use comparison summary for quantity gaps.')}</span>
                        </div>
                      </CardHeader>
                      <CardContent className="grid gap-5 lg:grid-cols-2">
                        <section aria-label={tx('供应商候选依据', 'Supplier candidate evidence')} className="space-y-2 lg:col-span-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="font-semibold">{tx('供应商候选依据', 'Supplier candidate evidence')}</h4>
                            <span className="text-xs text-muted-foreground">{tx('历史资料不代表当前有货或有效报价', 'Historical records do not verify current stock or pricing')}</span>
                          </div>
                          {candidateLoading && <p className="text-sm text-muted-foreground">{tx('正在核对历史资料…', 'Checking recorded evidence…')}</p>}
                          {candidateError && <p role="alert" className="text-sm text-red-600">{candidateError}</p>}
                          {!candidateLoading && !candidateError && candidateLine?.candidates.length === 0 && (
                            <p className="rounded border border-dashed p-2 text-sm text-amber-700">{tx('暂无可核实候选依据，请人工选择供应商询价。', 'No recorded candidate evidence; select a supplier to inquire.')}</p>
                          )}
                          {candidateLine && candidateLine.candidates.length > 0 && (
                            <div className="grid gap-2 md:grid-cols-2">
                              {candidateLine.candidates.map((candidate) => (
                                <div key={candidate.supplier.id} className="rounded border p-2 text-sm">
                                  <p className="font-medium">{candidate.supplier.name} <span className="text-xs text-muted-foreground">({candidate.supplier.status})</span></p>
                                  <p className="text-xs text-muted-foreground">{candidate.evidence.map((evidence) => evidence.type === 'HISTORICAL_SUPPLIER_QUOTE'
                                    ? tx('历史报价', 'Historical quote')
                                    : evidence.type === 'INVENTORY_SUPPLIER_ATTRIBUTION'
                                      ? tx('库存来源记录', 'Inventory source record')
                                      : tx(`供应商档案分类 ${evidence.matchedCategory || ''}`, `Supplier profile category ${evidence.matchedCategory || ''}`)).join(' · ')}</p>
                                </div>
                              ))}
                            </div>
                          )}
                          {candidateLine?.candidatesTruncated && <p className="text-xs text-amber-700">{tx('候选过多，仅展示部分记录。', 'Only some candidates are shown.')}</p>}
                        </section>
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
                                const workflowState = sourcingTimeline?.workflowStates?.find((item) => item.inquiryId === inquiry.id);
                                const canSend = inquiry.status === 'draft';
                                const canCancelSend = inquiry.latestOutboundEmail?.canCancel === true;
                                const requiresDeliveryVerification = inquiry.latestOutboundEmail?.manualVerificationRequired === true;
                                const stateColor = state === 'responded'
                                  ? 'bg-green-100 text-green-800'
                                  : state === 'smtp_accepted' || state === 'sent'
                                    ? 'bg-blue-100 text-blue-800'
                                  : state === 'queued' || state === 'pending' || state === 'processing' || state === 'retrying'
                                    ? 'bg-amber-100 text-amber-800'
                                    : state === 'failed' || state === 'needs_verification'
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
                                    {workflowState && (
                                      <p className="mt-2 text-sm" aria-label={tx('询价处理流程状态', 'Inquiry workflow state')}>
                                        <span className="font-medium">{getSourcingWorkflowStatusLabel(workflowState.status, tx)}</span>
                                        <span className="text-gray-600"> · {getSourcingWorkflowActionLabel(workflowState.nextAction, tx)}</span>
                                      </p>
                                    )}
                                    {deliveryError && (state === 'failed' || state === 'needs_verification') && (
                                      <p className="mt-2 text-sm text-red-700">{deliveryError}</p>
                                    )}
                                    {requiresDeliveryVerification && inquiry.latestOutboundEmail?.manualVerificationMessage && (
                                      <p role="alert" className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
                                        {inquiry.latestOutboundEmail.manualVerificationMessage}
                                      </p>
                                    )}
                                    {state === 'smtp_accepted' && (
                                      <p className="mt-2 text-sm text-blue-800">
                                        {tx('SMTP 接受只代表发件服务器受理，不证明供应商已收到或阅读。', 'SMTP acceptance only means the sending server accepted the message; it does not confirm supplier delivery or reading.')}
                                      </p>
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
                                    {canCancelSend && (
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="mt-3 ml-2"
                                        disabled={cancellingInquiryId === inquiry.id}
                                        onClick={() => void handleCancelInquirySend(inquiry)}
                                        aria-label={tx(`取消 ${inquiry.supplierName} 的排队询价发送`, `Cancel queued inquiry for ${inquiry.supplierName}`)}
                                      >
                                        {cancellingInquiryId === inquiry.id && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                                        {tx('取消排队发送', 'Cancel queued send')}
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

                        {pendingQuoteRows.length > 0 && (
                          <section aria-label={tx('需求行待核实报价', 'Demand line pending quotes')} className="space-y-3 lg:col-span-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <h4 className="font-semibold">{tx('待核实回邮报价', 'Pending reply quotes')}</h4>
                              <Badge variant="outline">{pendingQuoteRows.length} {tx('条草稿报价行', 'draft quote rows')}</Badge>
                            </div>
                            <p className="text-xs text-amber-800">{tx('以下为邮件提取或人工录入的原始报价信息，尚未核实，不参与正式最低价、中选或数量覆盖。库存和需求数量不能自动视为供应商承诺的可供数量。', 'These extracted or manually entered reply terms are unverified. They do not enter formal lowest-price ranking, winner selection, or quantity coverage. Stock and requested quantities are not automatically committed offer quantities.')}</p>
                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                              {pendingQuoteRows.map((row, rowIndex) => {
                                const issues = getPendingQuoteIssues(row, tx);
                                const leadTime = row.leadTimeMinDays != null || row.leadTimeMaxDays != null
                                  ? `${row.leadTimeMinDays ?? '?'}–${row.leadTimeMaxDays ?? '?'} ${tx('天', 'days')}`
                                  : row.leadTimeDays != null ? `${row.leadTimeDays} ${tx('天', 'days')}` : '—';
                                return (
                                  <article key={`${row.draftId}-${row.inquiryItemId}-${rowIndex}`} className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-sm">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <p className="font-medium">{row.supplierName}</p>
                                      <Badge variant="outline">{row.source === 'ai' ? tx('AI 起稿', 'AI originated') : tx('人工起稿', 'Manually originated')} · v{row.draftVersion}</Badge>
                                    </div>
                                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                                      <dt className="text-muted-foreground">{tx('原币单价', 'Original unit price')}</dt><dd>{row.unitPrice == null ? '—' : `${row.currency || '?'} ${row.unitPrice.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}`}</dd>
                                      <dt className="text-muted-foreground">{tx('报价数量', 'Quoted quantity')}</dt><dd>{row.quantity == null ? '—' : `${row.quantity} ${row.quantityUnit || '?'}`}</dd>
                                      <dt className="text-muted-foreground">{tx('交期', 'Lead time')}</dt><dd>{leadTime}</dd>
                                      <dt className="text-muted-foreground">{tx('成色 / 证书', 'Condition / certificate')}</dt><dd>{row.condition || '—'} / {formatCommercialTerm(row.certificate)}</dd>
                                      <dt className="text-muted-foreground">{tx('税费 / 运费', 'Tax / freight')}</dt><dd>{row.taxIncluded == null ? '—' : row.taxIncluded ? tx('含税', 'Included') : tx('未含税', 'Excluded')} / {row.freightIncluded == null ? '—' : row.freightIncluded ? tx('含运费', 'Included') : tx('未含运费', 'Excluded')}</dd>
                                      <dt className="text-muted-foreground">{tx('有效期', 'Valid until')}</dt><dd>{row.validUntil || '—'}</dd>
                                    </dl>
                                    {issues.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-900" aria-label={tx('待核实缺项', 'Pending quote issues')}>
                                      {issues.map((issue, index) => <li key={`${row.draftId}-${row.inquiryItemId}-issue-${index}`}>{issue}</li>)}
                                    </ul>}
                                    <Button size="sm" variant="outline" onClick={() => setReviewInquiryId(row.inquiryId)}>{tx('核对原邮件与草稿', 'Review email and draft')}</Button>
                                  </article>
                                );
                              })}
                            </div>
                          </section>
                        )}

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
                              {comparisonSummary.requiredQuantity !== undefined && <span>{tx('需求数量', 'Required qty')}: {comparisonSummary.requiredQuantity} {comparisonSummary.requiredQuantityUnit || line.uom}</span>}
                              {comparisonSummary.bestAvailableQuantity !== undefined && <span>{tx('最大可供数量', 'Best available qty')}: {comparisonSummary.bestAvailableQuantity} {comparisonSummary.requiredQuantityUnit || line.uom}</span>}
                              {comparisonSummary.remainingQuantityGap !== undefined && <span>{tx('剩余数量缺口', 'Remaining quantity gap')}: {comparisonSummary.remainingQuantityGap} {comparisonSummary.requiredQuantityUnit || line.uom}</span>}
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
                                  {tx('此需求行尚无正式报价；待核实草稿不参与比价。', 'No formal supplier quotes exist for this line; pending drafts are excluded from comparison.')}
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
                                        <TableHead>{tx('人工决策', 'Manual decision')}</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {quotes.map((quote) => (
                                        <TableRow id={`sourcing-quote-${quote.id}`} key={quote.id} className={deepLinkedQuoteId === quote.id ? 'bg-blue-50 outline outline-2 outline-blue-300' : undefined}>
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
                                            {quote.quantity} {quote.quantityUnit || tx('单位待核', 'Unit unknown')}
                                            {quote.quantityShortfall != null && quote.quantityShortfall > 0 && (
                                              <p className="text-xs text-amber-700">{tx('缺口', 'Shortfall')}: {quote.quantityShortfall} {comparisonSummary?.requiredQuantityUnit || line.uom}</p>
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
                                          <TableCell>
                                            <div className="flex min-w-40 flex-col items-start gap-2">
                                              {!quote.isWinner && can('supplier_quote.update') && (
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="sm"
                                                  disabled={quote.comparisonEligibility?.eligible !== true || selectingWinnerId !== null || !quote.updatedAt}
                                                  title={!quote.updatedAt ? tx('报价版本未知，请刷新比价。', 'Quote version is unknown; refresh comparison.') : quote.comparisonEligibility?.reasons?.join('；')}
                                                  onClick={() => setWinnerConfirmation({ quoteId: quote.id, supplierName: quote.supplier.name, line, action: 'select', expectedUpdatedAt: quote.updatedAt })}
                                                >
                                                  <CheckCircle className="mr-1 h-4 w-4" />
                                                  {selectingWinnerId === quote.id ? tx('处理中…', 'Saving…') : tx('选为中选供应商', 'Select as winner')}
                                                </Button>
                                              )}
                                              {quote.isWinner && can('supplier_quote.update') && (
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="sm"
                                                  disabled={selectingWinnerId !== null || !quote.updatedAt}
                                                  title={!quote.updatedAt ? tx('报价版本未知，请刷新比价。', 'Quote version is unknown; refresh comparison.') : undefined}
                                                  onClick={() => setWinnerConfirmation({ quoteId: quote.id, supplierName: quote.supplier.name, line, action: 'clear', expectedUpdatedAt: quote.updatedAt })}
                                                >
                                                  {selectingWinnerId === quote.id ? tx('处理中…', 'Saving…') : tx('取消当前中选', 'Clear current winner')}
                                                </Button>
                                              )}
                                              {quote.isWinner && line.rfqLineId && selectedRFQ.lineItemsMode === true && can('quotation.create') && (
                                                <Button asChild type="button" size="sm">
                                                  <a href={`/quotations?rfqId=${encodeURIComponent(selectedRFQ.id)}&rfqLineId=${encodeURIComponent(line.rfqLineId)}&supplierQuoteId=${encodeURIComponent(quote.id)}`}>
                                                    {tx('带入客户报价', 'Create customer quote')}
                                                  </a>
                                                </Button>
                                              )}
                                            </div>
                                          </TableCell>
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
        </>
      )}

      {/* Inventory match results */}
      {selectedRFQ && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="w-5 h-5 text-brand-primary" />
              {tx('逐需求行库存匹配', 'Inventory match by demand line')}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{tx('仅展示系统记录的件号匹配；实际可用量、成色和证书须人工核实。', 'Recorded part-number matches only; verify actual availability, condition and certificates.')}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            {inventoryLoading ? (
              <div className="flex items-center justify-center h-48">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : inventoryError ? (
              <p className="text-sm text-red-500">{inventoryError}</p>
            ) : (
              progressLines.map((line) => {
                const matches = inventoryItems?.filter((item) => item.partNumber.toUpperCase() === line.partNumber.toUpperCase()) ?? [];
                return <section key={line.key} aria-label={tx(`行 ${line.lineNo} 库存匹配`, `Line ${line.lineNo} inventory match`)} className="space-y-2 rounded border p-3">
                  <h4 className="text-sm font-semibold">{tx(`行 ${line.lineNo}`, `Line ${line.lineNo}`)} · <span className="font-mono">{line.partNumber}</span> · {line.quantity} {line.uom}</h4>
                  {matches.length > 0 ? <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {matches.map((item) => <InventoryMatchCard key={item.id} item={item} partNumber={line.partNumber} uom={line.uom} />)}
                  </div> : <p className="text-sm text-amber-700">{tx('未找到该行的件号匹配库存，请询价核实。', 'No recorded part-number match for this line; inquire to verify supply.')}</p>}
                </section>;
              })
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
            <DialogDescription>{tx('保存已选供应商的询价草稿；草稿尚未发送，可逐份预览并确认发送。', 'Save drafts for the selected suppliers. They remain unsent until each message is reviewed and confirmed.')}</DialogDescription>
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
                  disabled={Boolean(sendTask) || sendTaskLoading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="inquiry-email-body">{tx('邮件正文', 'Email body')}</Label>
                <Textarea
                  id="inquiry-email-body"
                  className="min-h-[240px] font-mono text-sm"
                  value={emailBody}
                  onChange={(event) => setEmailBody(event.target.value)}
                  disabled={Boolean(sendTask) || sendTaskLoading}
                />
              </div>
              {sendTaskLoading && <p className="text-sm text-gray-500">{tx('正在恢复待确认发送任务…', 'Restoring the pending send task…')}</p>}
              {sendTask && (
                <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm" aria-label={tx('受控发送任务', 'Controlled send task')}>
                  <p>{tx('任务', 'Task')}: <code>{sendTask.id}</code> · {sendTask.status} · v{sendTask.version}</p>
                  <p className="mt-1">{tx('邮件尚未因创建任务而发送；确认后只表示入队，投递结果另行核实。', 'Creating the task does not send email. Confirmation only queues it; delivery is verified separately.')}</p>
                  {sendTask.status === 'FAILED' && <p className="mt-1 text-red-700">{tx('失败原因', 'Failure')}: {sendTask.errorSummary || tx('待核实', 'Needs verification')}</p>}
                </div>
              )}
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
            {sendTask && ['WAITING_HUMAN', 'FAILED'].includes(sendTask.status) && (
              <Button type="button" variant="outline" disabled={sendLoading || sendTaskLoading} onClick={() => void handleCancelSendTask()}>
                {tx('取消待确认任务', 'Cancel pending task')}
              </Button>
            )}
            {sendTask?.status === 'FAILED' && (
              <Button type="button" variant="outline" disabled={sendLoading || sendTaskLoading} onClick={() => {
                setSendTask(null);
                sendTaskKey.current = null;
                setSendError('');
              }}>
                {tx('重新建立任务', 'Create a new task')}
              </Button>
            )}
            {previewInquiry?.status === 'draft' && (
              <Button
                type="button"
                onClick={() => void handleSendInquiry()}
                disabled={sendLoading || sendTaskLoading || !emailSubject.trim() || !emailBody.trim()}
                className="bg-brand-primary hover:bg-brand-primary-hover"
              >
                {sendLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
                {sendTask?.status === 'FAILED'
                  ? tx('重试待确认任务', 'Retry pending task')
                  : sendTask?.status === 'WAITING_HUMAN'
                    ? tx('确认此版本并入队', 'Confirm this version and queue')
                    : tx('保存待确认邮件版本', 'Save email for review')}
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
        onPersistedChange={handleRefreshTimeline}
      />

      <Dialog open={Boolean(winnerConfirmation)} onOpenChange={(open) => { if (!open && !selectingWinnerId) setWinnerConfirmation(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{winnerConfirmation?.action === 'clear' ? tx('确认取消中选', 'Confirm clearing the winner') : tx('确认人工中选', 'Confirm manual supplier selection')}</DialogTitle>
            <DialogDescription>
              {winnerConfirmation && (winnerConfirmation.action === 'clear' ? tx(
                `取消需求行 ${winnerConfirmation.line.lineNo}（${winnerConfirmation.line.partNumber}）中 ${winnerConfirmation.supplierName} 的当前中选。正式报价及已有下游引用保持不变。`,
                `Clear ${winnerConfirmation.supplierName} as the current winner for line ${winnerConfirmation.line.lineNo} (${winnerConfirmation.line.partNumber}). The formal quote and existing downstream references remain unchanged.`,
              ) : tx(
                `将 ${winnerConfirmation.supplierName} 记录为需求行 ${winnerConfirmation.line.lineNo}（${winnerConfirmation.line.partNumber}）的中选供应商。此操作不会自动生成客户售价。`,
                `Record ${winnerConfirmation.supplierName} as the selected supplier for demand line ${winnerConfirmation.line.lineNo} (${winnerConfirmation.line.partNumber}). This does not set a customer sale price.`,
              ))}
            </DialogDescription>
          </DialogHeader>
          {winnerConfirmation?.action === 'select' && winnerTaskLoading && (
            <p className="text-sm text-gray-500">{tx('正在恢复待确认中选任务…', 'Restoring the pending selection task…')}</p>
          )}
          {winnerConfirmation?.action === 'select' && winnerTask && (
            <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm" aria-label={tx('受控中选任务', 'Controlled selection task')}>
              <p>{tx('任务', 'Task')}: <code>{winnerTask.id}</code> · {winnerTask.status} · v{winnerTask.version}</p>
              <p className="mt-1">{tx('创建任务不会改变中选；再次确认后服务端将复核报价与需求行版本。', 'Creating the task does not change the winner. Confirmation rechecks the quote and demand-line versions.')}</p>
              {winnerTask.status === 'FAILED' && <p className="mt-1 text-red-700">{tx('失败原因', 'Failure')}: {winnerTask.errorSummary || tx('待核实', 'Needs verification')}</p>}
            </div>
          )}
          {winnerTaskError && <p role="alert" className="text-sm text-red-700">{winnerTaskError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={Boolean(selectingWinnerId)} onClick={() => setWinnerConfirmation(null)}>{tx('返回核对', 'Review')}</Button>
            {winnerConfirmation?.action === 'select' && winnerTask && ['WAITING_HUMAN', 'FAILED'].includes(winnerTask.status) && (
              <Button type="button" variant="outline" disabled={Boolean(selectingWinnerId) || winnerTaskLoading} onClick={() => void handleCancelWinnerTask()}>
                {tx('取消待确认任务', 'Cancel pending task')}
              </Button>
            )}
            {winnerConfirmation?.action === 'select' && winnerTask?.status === 'FAILED' && (
              <Button type="button" variant="outline" disabled={Boolean(selectingWinnerId) || winnerTaskLoading} onClick={() => {
                setWinnerTask(null);
                winnerTaskKey.current = null;
                setWinnerTaskError('');
              }}>
                {tx('重新建立任务', 'Create a new task')}
              </Button>
            )}
            <Button type="button" disabled={Boolean(selectingWinnerId) || winnerTaskLoading} onClick={() => void handleSelectWinner()}>
              {selectingWinnerId ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-1 h-4 w-4" />}
              {winnerConfirmation?.action === 'clear'
                ? tx('确认取消中选', 'Confirm clearing')
                : winnerTask?.status === 'FAILED'
                  ? tx('重试待确认任务', 'Retry pending task')
                  : winnerTask?.status === 'WAITING_HUMAN'
                    ? tx('确认中选', 'Confirm selection')
                    : tx('保存待确认中选任务', 'Save selection for review')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
