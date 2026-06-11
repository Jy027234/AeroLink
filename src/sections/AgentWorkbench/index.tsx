import { useState, useEffect, useMemo } from 'react';
import {
  Bot,
  Activity,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Loader2,
  Play,
  RefreshCw,
  Mail,
  Phone,
  FileText,
  DollarSign,
  Package,
  Truck,
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Search,
  Filter,
  Inbox,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { agentApi, type AgentAuditLog } from '@/api/client';
import { agentOrchestrator } from '@/lib/agentOrchestrator';
import { useTranslation } from '@/i18n';
import type { AgentTask, ConfirmationNode, ConfirmationOption, AgentDashboard, QuoteCandidate, ConfirmationAuditEntry } from '@/types/agent';
import type { SupplierFollowUpLog, SupplierFollowUpOutcome } from '@/types';
import { useSupplierFollowUpStore } from '@/store';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const statusConfig = {
  pending: { label: 'Pending', color: 'text-gray-600', bg: 'bg-gray-50' },
  running: { label: 'Running', color: 'text-blue-600', bg: 'bg-blue-50' },
  waiting_confirmation: { label: 'Awaiting Confirmation', color: 'text-yellow-600', bg: 'bg-yellow-50' },
  completed: { label: 'Completed', color: 'text-green-600', bg: 'bg-green-50' },
  failed: { label: 'Failed', color: 'text-red-600', bg: 'bg-red-50' },
  cancelled: { label: 'Cancelled', color: 'text-gray-500', bg: 'bg-gray-100' },
};

const taskTypeConfig: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  email_received: { label: 'Email Received', icon: Mail, color: 'text-purple-600' },
  rfq_created: { label: 'RFQ Created', icon: FileText, color: 'text-blue-600' },
  manual_follow_up: { label: 'Manual Follow-up', icon: Phone, color: 'text-amber-600' },
  sourcing_started: { label: 'Sourcing Started', icon: Truck, color: 'text-cyan-600' },
  quotes_collected: { label: 'Quotes Collected', icon: DollarSign, color: 'text-green-600' },
  quotes_compared: { label: 'Quotes Compared', icon: Brain, color: 'text-indigo-600' },
  quotation_created: { label: 'Quotation Created', icon: FileText, color: 'text-emerald-600' },
  quotation_sent: { label: 'Quotation Sent', icon: Mail, color: 'text-teal-600' },
  approval_requested: { label: 'Approval Requested', icon: CheckCircle, color: 'text-orange-600' },
  approval_completed: { label: 'Approval Completed', icon: CheckCircle, color: 'text-green-600' },
  order_created: { label: 'Order Created', icon: Package, color: 'text-pink-600' },
  order_tracking: { label: 'Order Tracking', icon: Truck, color: 'text-amber-600' },
  order_completed: { label: 'Order Completed', icon: CheckCircle, color: 'text-green-600' },
};

const supplierSelectionReasons = [
  { code: 'best_value', labelZh: '综合性价比最佳', labelEn: 'Best overall value' },
  { code: 'fastest_delivery', labelZh: '交期最优', labelEn: 'Fastest delivery' },
  { code: 'preferred_partner', labelZh: '优先合作供应商', labelEn: 'Preferred partner' },
  { code: 'highest_confidence', labelZh: 'AI 置信度最高', labelEn: 'Highest AI confidence' },
];

const supplierSkipReasons = [
  { code: 'need_more_quotes', labelZh: '需要更多报价对比', labelEn: 'Need more quotes' },
  { code: 'quote_risk_high', labelZh: '当前报价条件风险较高', labelEn: 'Quote terms are too risky' },
  { code: 'customer_reconfirm', labelZh: '需先回确认客户需求', labelEn: 'Need customer reconfirmation first' },
  { code: 'manual_negotiation', labelZh: '需先人工议价或沟通', labelEn: 'Manual negotiation required first' },
];

const quotationHoldReasons = [
  { code: 'margin_too_low', labelZh: '利润率过低，暂不发送', labelEn: 'Margin too low to send now' },
  { code: 'await_cost_refresh', labelZh: '需等待成本或汇率刷新', labelEn: 'Waiting for cost or FX refresh' },
  { code: 'need_manager_review', labelZh: '需经理复核后再发送', labelEn: 'Manager review required before sending' },
  { code: 'customer_terms_unclear', labelZh: '客户条件未确认，暂缓发送', labelEn: 'Customer terms unclear, hold sending' },
];

const rfqCancelReasons = [
  { code: 'need_customer_reconfirm', labelZh: '客户需求待回确认', labelEn: 'Customer demand needs reconfirmation' },
  { code: 'pricing_basis_unclear', labelZh: '价格依据不足，暂不建单', labelEn: 'Pricing basis is not ready for RFQ creation' },
  { code: 'sourcing_strategy_hold', labelZh: '寻源策略待调整后再建单', labelEn: 'Sourcing strategy needs adjustment before RFQ' },
  { code: 'manual_review_required', labelZh: '需人工复核后再建单', labelEn: 'Manual review required before creating RFQ' },
];

function getManualActionText(action: string | undefined) {
  switch (action) {
    case 'portal_follow_up':
      return '门户催报';
    case 'wechat_follow_up':
      return '微信催报';
    case 'whatsapp_follow_up':
      return 'WhatsApp 跟进';
    case 'phone_follow_up':
      return '电话跟进';
    case 'contact_missing':
      return '联系方式待补';
    default:
      return '人工跟进';
  }
}

function TaskStatusBadge({ status }: { status: keyof typeof statusConfig }) {
  const config = statusConfig[status];
  const { locale } = useTranslation();
  const labelMap: Record<keyof typeof statusConfig, string> = {
    pending: locale === 'zh-CN' ? '待处理' : 'Pending',
    running: locale === 'zh-CN' ? '执行中' : 'Running',
    waiting_confirmation: locale === 'zh-CN' ? '待确认' : 'Awaiting Confirmation',
    completed: locale === 'zh-CN' ? '已完成' : 'Completed',
    failed: locale === 'zh-CN' ? '失败' : 'Failed',
    cancelled: locale === 'zh-CN' ? '已取消' : 'Cancelled',
  };
  return (
    <Badge variant="outline" className={cn(config.bg, config.color, 'border')}>
      {labelMap[status] || config.label}
    </Badge>
  );
}

function ConfirmationDialog({
  confirmation,
  onConfirm,
}: {
  confirmation: ConfirmationNode;
  onConfirm: (optionId: string, additionalData?: Record<string, unknown>) => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const titleText = locale === 'zh-CN' ? confirmation.titleZh || confirmation.title : confirmation.titleEn || confirmation.title;
  const descriptionText = locale === 'zh-CN'
    ? confirmation.descriptionZh || confirmation.description
    : confirmation.descriptionEn || confirmation.description;
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmationNote, setConfirmationNote] = useState('');
  const [supplierSelectionReason, setSupplierSelectionReason] = useState('');
  const [supplierSkipReason, setSupplierSkipReason] = useState('');
  const [quotationHoldReason, setQuotationHoldReason] = useState('');
  const [rfqCancelReason, setRfqCancelReason] = useState('');
  const confirmationQuotes = (confirmation.data.quotes || []) as QuoteCandidate[];
  const requiresOptionSelection = confirmation.type === 'supplier_select';
  const cancelOption = confirmation.options?.find((option) => option.action === 'cancel' || option.id === 'cancel');
  const primaryOption = requiresOptionSelection
    ? null
    : confirmation.options?.find((option) => option.id !== cancelOption?.id);
  const selectedConfirmationOption = selectedOption
    ? confirmation.options?.find((option) => option.id === selectedOption)
    : undefined;
  const requiresSelectionReason = selectedConfirmationOption?.action === 'selectSupplier';

  useEffect(() => {
    setSelectedOption(null);
    setIsSubmitting(false);
    setConfirmationNote('');
    setSupplierSelectionReason('');
    setSupplierSkipReason('');
    setQuotationHoldReason('');
    setRfqCancelReason('');
  }, [confirmation.id]);

  const submitOption = async (optionId: string) => {
    const option = confirmation.options.find((item) => item.id === optionId);
    if (!option) return;

    const payload: Record<string, unknown> = {};
    const trimmedNote = confirmationNote.trim();
    if (trimmedNote) {
      payload.confirmationNote = trimmedNote;
    }

    if (confirmation.type === 'supplier_select' && option.action === 'selectSupplier') {
      const selectedReason = supplierSelectionReasons.find((reason) => reason.code === supplierSelectionReason);
      if (!selectedReason) {
        toast.warning(tx('请选择结构化的供应商选择理由。', 'Select a structured rationale for this supplier decision.'));
        return;
      }

      payload.confirmationReasonCode = selectedReason.code;
      payload.confirmationReasonLabel = locale === 'zh-CN' ? selectedReason.labelZh : selectedReason.labelEn;
      payload.confirmationReasonLabelZh = selectedReason.labelZh;
      payload.confirmationReasonLabelEn = selectedReason.labelEn;
    }

    if (confirmation.type === 'supplier_select' && (option.action === 'cancel' || option.id === cancelOption?.id)) {
      const selectedReason = supplierSkipReasons.find((reason) => reason.code === supplierSkipReason);
      if (!selectedReason) {
        toast.warning(tx('如需暂不选择，请先选择结构化的未选原因。', 'Select a structured reason before skipping supplier selection.'));
        return;
      }

      payload.confirmationReasonCode = selectedReason.code;
      payload.confirmationReasonLabel = locale === 'zh-CN' ? selectedReason.labelZh : selectedReason.labelEn;
      payload.confirmationReasonLabelZh = selectedReason.labelZh;
      payload.confirmationReasonLabelEn = selectedReason.labelEn;
    }

    if (confirmation.type === 'quotation_confirm' && option.action === 'cancel') {
      const selectedReason = quotationHoldReasons.find((reason) => reason.code === quotationHoldReason);
      if (!selectedReason) {
        toast.warning(tx('如需暂不发送报价，请先选择结构化原因。', 'Select a structured reason before holding the quotation.'));
        return;
      }

      payload.confirmationReasonCode = selectedReason.code;
      payload.confirmationReasonLabel = locale === 'zh-CN' ? selectedReason.labelZh : selectedReason.labelEn;
      payload.confirmationReasonLabelZh = selectedReason.labelZh;
      payload.confirmationReasonLabelEn = selectedReason.labelEn;
    }

    if (confirmation.type === 'rfq_confirm' && option.action === 'cancel') {
      const selectedReason = rfqCancelReasons.find((reason) => reason.code === rfqCancelReason);
      if (!selectedReason) {
        toast.warning(tx('如需暂不生成需求单，请先选择结构化原因。', 'Select a structured reason before cancelling RFQ creation.'));
        return;
      }

      payload.confirmationReasonCode = selectedReason.code;
      payload.confirmationReasonLabel = locale === 'zh-CN' ? selectedReason.labelZh : selectedReason.labelEn;
      payload.confirmationReasonLabelZh = selectedReason.labelZh;
      payload.confirmationReasonLabelEn = selectedReason.labelEn;
    }

    setIsSubmitting(true);
    try {
      await onConfirm(optionId, Object.keys(payload).length > 0 ? payload : undefined);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (requiresOptionSelection) {
      if (!selectedOption) return;
      await submitOption(selectedOption);
      return;
    }

    if (!primaryOption) return;
    await submitOption(primaryOption.id);
  };

  const handleCancel = async () => {
    if (!cancelOption) return;
    await submitOption(cancelOption.id);
  };

  const getOptionLabel = (option: ConfirmationOption) => (
    locale === 'zh-CN' ? option.labelZh || option.label : option.labelEn || option.label
  );

  return (
    <div data-testid="agent-confirmation-panel" className="rounded-xl border border-yellow-200 bg-white p-5 shadow-sm space-y-4">
      <div>
        <div className="flex items-center gap-2 text-yellow-900">
          <AlertTriangle className="w-5 h-5 text-yellow-500" />
          <h3 data-testid="agent-confirmation-title" className="font-semibold text-lg">{titleText}</h3>
        </div>
        <p className="mt-1 text-sm text-gray-600">{descriptionText}</p>
      </div>

      <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
        <p className="text-yellow-800">{descriptionText}</p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-slate-700">{tx('确认备注', 'Confirmation note')}</p>
        <Textarea
          rows={3}
          value={confirmationNote}
          onChange={(event) => setConfirmationNote(event.target.value)}
          placeholder={tx('可选：补充本次确认原因、风险判断或跟进要求。', 'Optional: capture rationale, risk judgment, or follow-up requirements for this confirmation.')}
        />
      </div>

      {confirmation.type === 'supplier_select' && confirmation.data?.quotes && (
        <div className="space-y-3">
          {confirmationQuotes.map((quote: QuoteCandidate, index: number) => (
            <Card
              key={quote.id || index}
              data-testid={`agent-confirm-card-${index + 1}`}
              className={cn(
                'cursor-pointer transition-all',
                selectedOption === `select_${index}` && 'ring-2 ring-blue-500 border-blue-500'
              )}
              onClick={() => setSelectedOption(`select_${index}`)}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center font-bold">
                      {index + 1}
                    </div>
                    <div>
                      <p className="font-medium">{quote.supplier?.name || 'Supplier'}</p>
                      <p className="text-sm text-gray-500">
                        ${quote.unitPrice} x {confirmation.data?.parsedData?.quantity || 1} | {quote.leadTimeDays} days
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        {quote.supplier?.automationMode === 'auto'
                          ? '自动触达'
                          : quote.supplier?.automationMode === 'manual'
                            ? getManualActionText(quote.supplier?.manualActionType)
                            : '资料待补'}
                        {' · '}
                        {quote.supplier?.preferredChannel === 'email'
                          ? '邮箱'
                          : quote.supplier?.preferredChannel === 'phone'
                            ? '电话'
                            : '人工处理'}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold text-purple-600">{quote.aiScore?.toFixed(0) || 0}</p>
                    <p className="text-xs text-gray-500">AI Score</p>
                  </div>
                </div>
                {quote.aiRecommendation && (
                  (() => {
                    const recommendation = quote.aiRecommendation || '';
                    const strong = recommendation.includes('强烈') || recommendation.toLowerCase().includes('strongly');
                    const good = recommendation.includes('推荐') || recommendation.toLowerCase().includes('recommended');
                    const warn = recommendation.includes('考虑') || recommendation.toLowerCase().includes('consider');
                    return (
                      <p className={cn(
                        'mt-2 text-sm',
                        strong && 'text-green-600 font-medium',
                        !strong && good && 'text-blue-600',
                        !strong && !good && warn && 'text-yellow-600'
                      )}>
                        {quote.aiRecommendation}
                      </p>
                    );
                  })()
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {requiresOptionSelection && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-700">{tx('选择理由', 'Selection rationale')}</p>
          <Select
            value={supplierSelectionReason}
            onValueChange={setSupplierSelectionReason}
            disabled={!requiresSelectionReason}
          >
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={
                  requiresSelectionReason
                    ? tx('请选择本次选择理由', 'Select a structured rationale')
                    : tx('请先选中一个供应商方案', 'Choose a supplier option first')
                }
              />
            </SelectTrigger>
            <SelectContent>
              {supplierSelectionReasons.map((reason) => (
                <SelectItem key={reason.code} value={reason.code}>
                  {tx(reason.labelZh, reason.labelEn)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-slate-500">
            {tx('结构化理由会跟随确认记录一起进入审批审计时间线。', 'The structured rationale is stored together with the confirmation audit trail.')}
          </p>
        </div>
      )}

      {requiresOptionSelection && cancelOption && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-700">{tx('未选原因', 'Skip reason')}</p>
          <Select value={supplierSkipReason} onValueChange={setSupplierSkipReason}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={tx('如点击“暂不选择”，请先选择原因', 'Choose a reason before clicking skip')} />
            </SelectTrigger>
            <SelectContent>
              {supplierSkipReasons.map((reason) => (
                <SelectItem key={reason.code} value={reason.code}>
                  {tx(reason.labelZh, reason.labelEn)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-slate-500">
            {tx('点击“暂不选择”时，会把该原因一并写入审批审计时间线。', 'When skipping selection, this reason is also stored in the confirmation audit timeline.')}
          </p>
        </div>
      )}

      {confirmation.type === 'rfq_confirm' && confirmation.data?.parsedData && (
        <div className="space-y-3 rounded-lg bg-gray-50 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-gray-500">Part Number</p>
              <p className="font-mono font-medium">{confirmation.data.parsedData.partNumber}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Customer</p>
              <p className="font-medium">{confirmation.data.parsedData.customerName}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Quantity</p>
              <p className="font-medium">{confirmation.data.parsedData.quantity} EA</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Urgency</p>
              <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
                {confirmation.data.parsedData.urgency === 'aog' ? '⚠️ AOG Urgent' : 'Standard'}
              </Badge>
            </div>
          </div>

          {cancelOption && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-700">{tx('暂不生成原因', 'Hold reason')}</p>
              <Select value={rfqCancelReason} onValueChange={setRfqCancelReason}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={tx('如点击取消，请先选择原因', 'Choose a reason before cancelling RFQ creation')} />
                </SelectTrigger>
                <SelectContent>
                  {rfqCancelReasons.map((reason) => (
                    <SelectItem key={reason.code} value={reason.code}>
                      {tx(reason.labelZh, reason.labelEn)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">
                {tx('点击取消时，结构化原因会进入审批审计时间线。', 'When cancelling RFQ creation, the structured reason is stored in the confirmation audit trail.')}
              </p>
            </div>
          )}
        </div>
      )}

      {confirmation.type === 'quotation_confirm' && confirmation.data && (
        <div className="space-y-3 rounded-lg bg-gray-50 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-gray-500">Unit Price</p>
              <p className="font-semibold text-lg">${confirmation.data.unitPrice}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Total Price</p>
              <p className="font-semibold text-lg text-blue-600">${confirmation.data.totalPrice}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Cost Price</p>
              <p className="font-medium">${confirmation.data.costPrice}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Margin</p>
              <p className={cn(
                'font-semibold',
                (confirmation.data.margin || 0) >= 15 ? 'text-green-600' : 'text-red-600'
              )}>
                {(confirmation.data.margin || 0).toFixed(1)}%
              </p>
            </div>
          </div>

          {cancelOption && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-700">{tx('暂不发送原因', 'Hold reason')}</p>
              <Select value={quotationHoldReason} onValueChange={setQuotationHoldReason}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={tx('如点击取消，请先选择原因', 'Choose a reason before cancelling send')} />
                </SelectTrigger>
                <SelectContent>
                  {quotationHoldReasons.map((reason) => (
                    <SelectItem key={reason.code} value={reason.code}>
                      {tx(reason.labelZh, reason.labelEn)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">
                {tx('点击取消时，结构化原因会进入审批审计时间线。', 'When cancelling send, the structured reason is stored in the confirmation audit trail.')}
              </p>
            </div>
          )}
        </div>
      )}

      {requiresOptionSelection && confirmationQuotes.length === 0 && (
        <div className="flex gap-2 flex-wrap">
          {confirmation.options?.filter((option) => option.id !== cancelOption?.id).map((option) => (
            <Button
              key={option.id}
              data-testid={`agent-confirm-option-${option.id}`}
              variant={selectedOption === option.id ? 'default' : 'outline'}
              onClick={() => setSelectedOption(option.id)}
              className={cn(selectedOption === option.id && 'bg-blue-600 hover:bg-blue-700')}
            >
              {getOptionLabel(option)}
            </Button>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {cancelOption && (
          <Button data-testid="agent-confirm-cancel" variant="outline" onClick={handleCancel} disabled={isSubmitting}>
            {getOptionLabel(cancelOption) || tx('取消', 'Cancel')}
          </Button>
        )}
        <Button
          data-testid="agent-confirm-submit"
          onClick={handleSubmit}
          disabled={isSubmitting || (requiresOptionSelection && !selectedOption) || (!requiresOptionSelection && !primaryOption)}
          className="bg-green-600 hover:bg-green-700"
        >
          {isSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
          {requiresOptionSelection ? tx('确认', 'Confirm') : (primaryOption ? getOptionLabel(primaryOption) : tx('确认', 'Confirm'))}
        </Button>
      </div>
    </div>
  );
}

function getConfirmationQueueLabel(
  confirmation: ConfirmationNode,
  tx: (zh: string, en: string) => string
) {
  switch (confirmation.type) {
    case 'rfq_confirm':
      return `${tx('需求单生成', 'RFQ creation')} · ${confirmation.data.parsedData?.partNumber || '-'}`;
    case 'supplier_select': {
      const quoteCount = Array.isArray(confirmation.data.quotes) ? confirmation.data.quotes.length : 0;
      return `${tx('供应商选择', 'Supplier selection')} · ${quoteCount}${tx('项', ' options')}`;
    }
    case 'quotation_confirm':
      return `${tx('报价确认', 'Quotation confirmation')} · ${confirmation.data.totalPrice ? `$${confirmation.data.totalPrice}` : '-'}`;
    default:
      return confirmation.title;
  }
}

function formatTime(date: Date) {
  return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(start?: Date, end?: Date) {
  if (!start || !end) return '-';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDateTime(value: Date | string | undefined, locale: 'zh-CN' | 'en') {
  if (!value) return '-';
  return new Date(value).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
}

function parseAgentLogJson(value: string | null | undefined) {
  if (!value) return {} as Record<string, unknown>;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {} as Record<string, unknown>;
  }
}

function getManualActionLabel(
  action: string | undefined,
  tx: (zh: string, en: string) => string
) {
  switch (action) {
    case 'portal_follow_up':
      return tx('门户催报', 'Portal follow-up');
    case 'wechat_follow_up':
      return tx('微信催报', 'WeChat follow-up');
    case 'whatsapp_follow_up':
      return tx('WhatsApp 跟进', 'WhatsApp follow-up');
    case 'phone_follow_up':
      return tx('电话跟进', 'Phone follow-up');
    case 'contact_missing':
      return tx('联系方式待补', 'Contact details required');
    default:
      return tx('人工跟进', 'Manual follow-up');
  }
}

function getFollowUpOutcomeLabel(
  outcome: SupplierFollowUpOutcome,
  tx: (zh: string, en: string) => string
) {
  switch (outcome) {
    case 'contacted_waiting_quote':
      return tx('已联系，待报价', 'Contacted, waiting for quote');
    case 'quote_promised':
      return tx('对方承诺回传报价', 'Quote promised');
    case 'portal_message_sent':
      return tx('已发送门户提醒', 'Portal reminder sent');
    case 'contact_invalid':
      return tx('联系方式失效', 'Contact invalid');
    default:
      return outcome;
  }
}

function getConfirmationTypeLabel(
  type: ConfirmationAuditEntry['type'],
  tx: (zh: string, en: string) => string
) {
  switch (type) {
    case 'rfq_confirm':
      return tx('需求单确认', 'RFQ confirmation');
    case 'supplier_select':
      return tx('供应商选择', 'Supplier selection');
    case 'quotation_confirm':
      return tx('报价确认', 'Quotation confirmation');
    case 'approval_confirm':
      return tx('审批确认', 'Approval confirmation');
    default:
      return type;
  }
}

function getConfirmationOptionLabel(entry: ConfirmationAuditEntry, locale: 'zh-CN' | 'en') {
  if (locale === 'zh-CN') {
    return entry.optionLabelZh || entry.optionLabel || entry.action;
  }
  return entry.optionLabelEn || entry.optionLabel || entry.action;
}

function getConfirmationReasonLabel(entry: ConfirmationAuditEntry, locale: 'zh-CN' | 'en') {
  if (locale === 'zh-CN') {
    return entry.reasonLabelZh || entry.reasonLabel || entry.reasonCode;
  }
  return entry.reasonLabelEn || entry.reasonLabel || entry.reasonCode;
}

function getBackendConfirmationType(log: AgentAuditLog): ConfirmationAuditEntry['type'] | undefined {
  const input = parseAgentLogJson(log.input);
  const type = input.type;
  if (type === 'rfq_confirm' || type === 'supplier_select' || type === 'quotation_confirm' || type === 'approval_confirm') {
    return type;
  }
  return undefined;
}

function getBackendConfirmationOptionLabel(log: AgentAuditLog, locale: 'zh-CN' | 'en') {
  const input = parseAgentLogJson(log.input);
  const output = parseAgentLogJson(log.output);
  const optionLabel = typeof output.optionLabel === 'string' ? output.optionLabel : undefined;
  const optionLabelZh = typeof output.optionLabelZh === 'string' ? output.optionLabelZh : undefined;
  const optionLabelEn = typeof output.optionLabelEn === 'string' ? output.optionLabelEn : undefined;
  const action = typeof input.action === 'string' ? input.action : log.action;

  if (locale === 'zh-CN') {
    return optionLabelZh || optionLabel || action;
  }

  return optionLabelEn || optionLabel || action;
}

function getBackendConfirmationActor(log: AgentAuditLog) {
  const input = parseAgentLogJson(log.input);
  return typeof input.confirmedBy === 'string' ? input.confirmedBy : undefined;
}

function getBackendConfirmationTime(log: AgentAuditLog) {
  const input = parseAgentLogJson(log.input);
  return typeof input.confirmedAt === 'string' ? input.confirmedAt : log.createdAt;
}

function getBackendConfirmationNote(log: AgentAuditLog) {
  const input = parseAgentLogJson(log.input);
  return typeof input.note === 'string' ? input.note : undefined;
}

function getBackendConfirmationReasonLabel(log: AgentAuditLog, locale: 'zh-CN' | 'en') {
  const input = parseAgentLogJson(log.input);
  const output = parseAgentLogJson(log.output);
  const reasonCode = typeof input.reasonCode === 'string' ? input.reasonCode : undefined;
  const reasonLabel = typeof output.reasonLabel === 'string' ? output.reasonLabel : undefined;
  const reasonLabelZh = typeof output.reasonLabelZh === 'string' ? output.reasonLabelZh : undefined;
  const reasonLabelEn = typeof output.reasonLabelEn === 'string' ? output.reasonLabelEn : undefined;

  if (locale === 'zh-CN') {
    return reasonLabelZh || reasonLabel || reasonCode;
  }

  return reasonLabelEn || reasonLabel || reasonCode;
}

type ConfirmationTimelineEntry = {
  key: string;
  type?: ConfirmationAuditEntry['type'];
  optionLabel: string;
  reasonLabel?: string;
  confirmedAt?: string;
  confirmedBy?: string;
  note?: string;
  hasLocalRecord: boolean;
  hasPersistedRecord: boolean;
};

type FollowUpTimelineEntry = {
  key: string;
  supplierName: string;
  contactText: string;
  actionLabel: string;
  outcomeLabel?: string;
  loggedAt?: string;
  createdBy?: string;
  notes?: string;
  rfqNumber?: string;
  isLogged: boolean;
};

function buildConfirmationTimelineKey(params: {
  confirmationId?: string;
  stepId?: string;
  optionId?: string;
  confirmedAt?: string;
  confirmedBy?: string;
}) {
  return [
    params.confirmationId || '',
    params.stepId || '',
    params.optionId || '',
    params.confirmedAt || '',
    params.confirmedBy || '',
  ].join('|');
}

function buildFollowUpTimelineKey(params: {
  supplierId?: string;
  supplierName?: string;
}) {
  return [params.supplierId || '', params.supplierName || ''].join('|');
}

function mergeConfirmationTimelineEntries(
  confirmationHistory: ConfirmationAuditEntry[],
  confirmationAuditLogs: AgentAuditLog[],
  locale: 'zh-CN' | 'en'
) {
  const entries = new Map<string, ConfirmationTimelineEntry>();

  for (const entry of confirmationHistory) {
    const key = buildConfirmationTimelineKey({
      confirmationId: entry.confirmationId,
      stepId: entry.stepId,
      optionId: entry.optionId,
      confirmedAt: entry.confirmedAt,
      confirmedBy: entry.confirmedBy,
    });

    entries.set(key, {
      key,
      type: entry.type,
      optionLabel: getConfirmationOptionLabel(entry, locale),
      reasonLabel: getConfirmationReasonLabel(entry, locale),
      confirmedAt: entry.confirmedAt,
      confirmedBy: entry.confirmedBy,
      note: typeof entry.note === 'string' ? entry.note : undefined,
      hasLocalRecord: true,
      hasPersistedRecord: false,
    });
  }

  for (const log of confirmationAuditLogs) {
    const input = parseAgentLogJson(log.input);
    const confirmationId = typeof input.confirmationId === 'string' ? input.confirmationId : undefined;
    const stepId = typeof input.stepId === 'string' ? input.stepId : undefined;
    const optionId = typeof input.optionId === 'string' ? input.optionId : undefined;
    const confirmedAt = getBackendConfirmationTime(log);
    const confirmedBy = getBackendConfirmationActor(log);
    const note = getBackendConfirmationNote(log);
    const key = buildConfirmationTimelineKey({
      confirmationId,
      stepId,
      optionId,
      confirmedAt,
      confirmedBy,
    });
    const existing = entries.get(key);

    entries.set(key, {
      key,
      type: existing?.type || getBackendConfirmationType(log),
      optionLabel: existing?.optionLabel || getBackendConfirmationOptionLabel(log, locale),
      reasonLabel: existing?.reasonLabel || getBackendConfirmationReasonLabel(log, locale),
      confirmedAt: existing?.confirmedAt || confirmedAt,
      confirmedBy: existing?.confirmedBy || confirmedBy,
      note: existing?.note || note,
      hasLocalRecord: existing?.hasLocalRecord || false,
      hasPersistedRecord: true,
    });
  }

  return [...entries.values()].sort((left, right) => {
    const leftTime = left.confirmedAt ? new Date(left.confirmedAt).getTime() : 0;
    const rightTime = right.confirmedAt ? new Date(right.confirmedAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function mergeFollowUpTimelineEntries(
  followUpQueue: NonNullable<AgentTask['context']['followUpQueue']>,
  followUpLogs: SupplierFollowUpLog[],
  locale: 'zh-CN' | 'en',
  tx: (zh: string, en: string) => string
) {
  const entries = new Map<string, FollowUpTimelineEntry>();

  for (const supplier of followUpQueue) {
    const key = buildFollowUpTimelineKey({
      supplierId: supplier.id,
      supplierName: supplier.name,
    });

    entries.set(key, {
      key,
      supplierName: supplier.name || tx('供应商', 'Supplier'),
      contactText: [supplier.phone, supplier.email].filter(Boolean).join(' / ') || tx('需补充联系方式', 'Contact details required'),
      actionLabel: getManualActionLabel(supplier.manualActionType, tx),
      rfqNumber: undefined,
      isLogged: false,
    });
  }

  for (const log of [...followUpLogs].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())) {
    const key = buildFollowUpTimelineKey({
      supplierId: log.supplierId,
      supplierName: log.supplierName,
    });
    const existing = entries.get(key);

    if (existing?.isLogged) {
      continue;
    }

    entries.set(key, {
      key,
      supplierName: log.supplierName || existing?.supplierName || tx('供应商', 'Supplier'),
      contactText: existing?.contactText || tx('已记录人工跟进结果', 'Manual follow-up result recorded'),
      actionLabel: existing?.actionLabel || getManualActionLabel(log.actionType, tx),
      outcomeLabel: getFollowUpOutcomeLabel(log.outcome, tx),
      loggedAt: log.createdAt,
      createdBy: log.createdBy,
      notes: log.notes,
      rfqNumber: log.rfqNumber || existing?.rfqNumber,
      isLogged: true,
    });
  }

  return [...entries.values()].sort((left, right) => {
    if (left.isLogged !== right.isLogged) {
      return Number(right.isLogged) - Number(left.isLogged);
    }

    const leftTime = left.loggedAt ? new Date(left.loggedAt).getTime() : 0;
    const rightTime = right.loggedAt ? new Date(right.loggedAt).getTime() : 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }

    return left.supplierName.localeCompare(right.supplierName, locale === 'zh-CN' ? 'zh-CN' : 'en-US');
  });
}

function getDefaultFollowUpOutcome(action: string | undefined): SupplierFollowUpOutcome {
  if (action === 'portal_follow_up') {
    return 'portal_message_sent';
  }

  if (action === 'contact_missing') {
    return 'contact_invalid';
  }

  return 'contacted_waiting_quote';
}

function TaskTimeline({ task }: { task: AgentTask }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const followUpQueue = Array.isArray(task.context.followUpQueue) ? task.context.followUpQueue : [];
  const confirmationHistory = Array.isArray(task.context.confirmationHistory)
    ? (task.context.confirmationHistory as ConfirmationAuditEntry[])
    : [];
  const defaultFollowUpOutcome = getDefaultFollowUpOutcome(followUpQueue[0]?.manualActionType);
  const [followUpOutcome, setFollowUpOutcome] = useState<SupplierFollowUpOutcome>(defaultFollowUpOutcome);
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [isSavingFollowUp, setIsSavingFollowUp] = useState(false);
  const [confirmationAuditLogs, setConfirmationAuditLogs] = useState<AgentAuditLog[]>([]);
  const [isLoadingConfirmationAuditLogs, setIsLoadingConfirmationAuditLogs] = useState(false);
  const [confirmationAuditLogsError, setConfirmationAuditLogsError] = useState<string | null>(null);
  const [hasLoadedConfirmationAuditLogs, setHasLoadedConfirmationAuditLogs] = useState(false);
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const typeConfig = taskTypeConfig[task.type] || { label: task.type, icon: Activity, color: 'text-gray-600' };
  const Icon = typeConfig.icon;
  const allFollowUpLogs = useSupplierFollowUpStore((state) => state.logs);
  const followUpLogs = allFollowUpLogs.filter((log) => log.taskId === task.id);
  const confirmationTimelineEntries = mergeConfirmationTimelineEntries(confirmationHistory, confirmationAuditLogs, locale);
  const followUpTimelineEntries = mergeFollowUpTimelineEntries(followUpQueue, followUpLogs, locale, tx);

  useEffect(() => {
    setFollowUpOutcome(defaultFollowUpOutcome);
    setFollowUpNotes('');
  }, [task.id, defaultFollowUpOutcome]);

  useEffect(() => {
    setConfirmationAuditLogs([]);
    setConfirmationAuditLogsError(null);
    setIsLoadingConfirmationAuditLogs(false);
    setHasLoadedConfirmationAuditLogs(false);
  }, [task.id]);

  useEffect(() => {
    if (!isExpanded || hasLoadedConfirmationAuditLogs) {
      return;
    }

    let cancelled = false;
    setIsLoadingConfirmationAuditLogs(true);
    setConfirmationAuditLogsError(null);

    void agentApi.getLogs(task.id)
      .then((logs) => {
        if (cancelled) return;
        setConfirmationAuditLogs(logs.filter((log) => log.action === 'CONFIRMATION_RECORDED'));
        setHasLoadedConfirmationAuditLogs(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setConfirmationAuditLogsError(error instanceof Error ? error.message : (locale === 'zh-CN' ? '加载后端审计日志失败' : 'Failed to load backend audit logs'));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingConfirmationAuditLogs(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasLoadedConfirmationAuditLogs, isExpanded, locale, task.id]);

  const getStepIcon = (step: AgentTask['steps'][0], index: number) => {
    if (step.status === 'completed') {
      return <CheckCircle className="w-4 h-4 text-green-600" />;
    }
    if (step.status === 'running') {
      return <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />;
    }
    if (step.status === 'failed') {
      return <XCircle className="w-4 h-4 text-red-600" />;
    }
    return <span className="w-4 h-4 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-xs font-medium">{index + 1}</span>;
  };

  const getStepSummary = (step: AgentTask['steps'][0]) => {
    if (task.type === 'manual_follow_up') {
      if (followUpQueue.length === 0) {
        return <span className="text-xs text-amber-700">{tx('待补联系人', 'Contact details needed')}</span>;
      }

      if (followUpQueue.length === 1) {
        return (
          <span className="text-xs text-amber-700">
            {getManualActionLabel(followUpQueue[0].manualActionType, tx)} {followUpQueue[0].name || tx('供应商', 'supplier')}
          </span>
        );
      }

      return <span className="text-xs text-amber-700">{tx('待跟进', 'Follow up')} {followUpQueue.length} {tx('家供应商', 'suppliers')}</span>;
    }

    if (step.status === 'pending') return null;

    if (step.capability === 'email' && step.action === 'parse' && step.result?.parsedData) {
      return <span className="text-xs text-purple-600">{tx('件号', 'Part Number')} {step.result.parsedData.partNumber}</span>;
    }
    if (step.capability === 'rfq' && step.action === 'create' && step.result?.rfqNumber) {
      return <span className="text-xs text-blue-600">{step.result.rfqNumber}</span>;
    }
    if (step.capability === 'sourcing' && step.action === 'selectSuppliers' && step.result?.selectedSuppliers) {
      return <span className="text-xs text-cyan-600">{tx('已选', 'Selected')} {step.result.selectedSuppliers.length} {tx('家供应商', 'suppliers')}</span>;
    }
    if (step.capability === 'sourcing' && step.action === 'sendInquiry' && step.result?.inquiryDispatch) {
      const inquiryDispatch = step.result.inquiryDispatch as Record<string, unknown>;
      const autoCount = Number(inquiryDispatch.autoDispatchCount || 0);
      const manualCount = Number(inquiryDispatch.manualFollowUpCount || 0);
      return <span className="text-xs text-cyan-600">{tx('自动', 'Auto')} {autoCount} / {tx('人工', 'Manual')} {manualCount}</span>;
    }
    if (step.capability === 'supplierQuote' && step.action === 'collect' && step.result?.quoteCollectionSummary) {
      const quoteCollectionSummary = step.result.quoteCollectionSummary as Record<string, unknown>;
      return <span className="text-xs text-green-600">{tx('已收集', 'Collected')} {Number(quoteCollectionSummary.collectedQuotes || 0)} {tx('份报价', 'quotes')}</span>;
    }
    if (step.capability === 'supplierQuote' && step.action === 'compare' && step.result?.bestMatch) {
      return <span className="text-xs text-indigo-600">{tx('推荐', 'Recommended')} {step.result.bestMatch.supplier?.name}</span>;
    }
    if (step.capability === 'quotation' && step.action === 'create' && step.result?.quotationNumber) {
      return <span className="text-xs text-emerald-600">{step.result.quotationNumber}</span>;
    }
    return null;
  };

  const completedSteps = task.steps?.filter(s => s.status === 'completed').length || 0;
  const runningStep = task.steps?.find(s => s.status === 'running');
  const isWaitingConfirmation = task.status === 'waiting_confirmation' && task.confirmationNode;

  const getCurrentStepLabel = () => {
    if (task.type === 'manual_follow_up' && task.status === 'pending') {
      return `${tx('待销售跟进', 'Awaiting sales follow-up')} ${followUpQueue.length} ${tx('家供应商', 'suppliers')}`;
    }
    if (task.type === 'manual_follow_up' && task.status === 'completed') {
      return tx('人工跟进已完成', 'Manual follow-up completed');
    }
    if (task.status === 'completed') return tx('已完成', 'All done');
    if (task.status === 'failed') return tx('执行失败', 'Execution failed');
    if (isWaitingConfirmation) return tx('等待确认...', 'Awaiting confirmation...');
    if (runningStep) return `${runningStep.capability}/${runningStep.action}`;
    if (completedSteps > 0) return `${tx('已完成', 'Completed')} ${completedSteps}/${task.steps?.length || 0}`;
    return tx('待处理', 'Pending');
  };

  return (
    <Card className={cn(
      'transition-all cursor-pointer',
      task.status === 'running' && 'border-blue-300 shadow-blue-100',
      task.status === 'completed' && 'border-green-200',
      task.type === 'manual_follow_up' && task.status === 'pending' && 'border-amber-300 bg-amber-50/60',
      task.status === 'failed' && 'border-red-200',
      task.status === 'waiting_confirmation' && 'border-yellow-300 bg-yellow-50'
    )}>
      <CardContent className="p-4">
        <div
          className="flex items-center justify-between"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex items-center gap-3 flex-1">
            <div className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center transition-transform',
              isExpanded && 'rotate-90',
              typeConfig.color.includes('purple') ? 'bg-purple-100' :
              typeConfig.color.includes('blue') ? 'bg-blue-100' :
              typeConfig.color.includes('green') ? 'bg-green-100' :
              typeConfig.color.includes('red') ? 'bg-red-100' :
              'bg-gray-100'
            )}>
              <Icon className={cn('w-4 h-4', typeConfig.color)} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-medium text-sm">{typeConfig.label}</p>
                <TaskStatusBadge status={task.status} />
                {isWaitingConfirmation && (
                  <Badge variant="outline" className="bg-yellow-100 text-yellow-800 border-yellow-300 animate-pulse text-xs">
                    ⚠️ {tx('需要确认', 'Needs confirmation')}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-xs text-gray-500">
                  {formatTime(task.createdAt)}
                  {task.trigger.source && ` · ${task.trigger.source}`}
                </span>
                <span className="text-xs text-gray-400">|</span>
                <span className={cn(
                  'text-xs',
                  task.status === 'running' && 'text-blue-600',
                  task.status === 'completed' && 'text-green-600',
                  task.status === 'failed' && 'text-red-600',
                  task.status === 'waiting_confirmation' && 'text-yellow-600',
                  !task.status.startsWith('running') && !task.status.startsWith('complete') && !task.status.startsWith('fail') && !task.status.includes('waiting') && 'text-gray-500'
                )}>
                  {getCurrentStepLabel()}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {task.completedAt && (
              <span className="text-xs text-gray-400">
                {formatDuration(task.createdAt, task.completedAt)}
              </span>
            )}
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}>
              {isExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>

        {!isExpanded && (completedSteps > 0 || task.type === 'manual_follow_up') && (
          <div className="mt-3 pl-11 flex flex-wrap gap-2">
            {task.steps?.map((step, index) => {
              const summary = getStepSummary(step);
              return (
                <div
                  key={step.id}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 rounded text-xs',
                    step.status === 'completed' && 'bg-green-50 text-green-700',
                    step.status === 'running' && 'bg-blue-50 text-blue-700',
                    task.type === 'manual_follow_up' && step.status === 'pending' && 'bg-amber-100 text-amber-800',
                    step.status === 'failed' && 'bg-red-50 text-red-700',
                    step.status === 'pending' && 'bg-gray-50 text-gray-500'
                  )}
                >
                  {getStepIcon(step, index)}
                  {summary || <span>{step.capability}/{step.action}</span>}
                </div>
              );
            })}
          </div>
        )}

        {isExpanded && (
          <div className="mt-4 pl-11 relative">
            <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />
            <div className="space-y-3">
              {task.steps?.map((step, index) => (
                <div key={step.id} className="relative flex items-start gap-3">
                  <div className={cn(
                    'relative z-10 w-6 h-6 rounded-full flex items-center justify-center',
                    step.status === 'completed' && 'bg-green-100',
                    step.status === 'running' && 'bg-blue-100',
                    step.status === 'failed' && 'bg-red-100',
                    step.status === 'pending' && 'bg-gray-100'
                  )}>
                    {getStepIcon(step, index)}
                  </div>
                  <div className={cn(
                    'flex-1 p-3 rounded-lg border transition-all',
                    step.status === 'completed' && 'bg-green-50 border-green-200',
                    step.status === 'running' && 'bg-blue-50 border-blue-200',
                    step.status === 'failed' && 'bg-red-50 border-red-200',
                    step.status === 'pending' && 'bg-gray-50 border-gray-200'
                  )}>
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-sm">
                        {step.capability} / {step.action}
                      </p>
                      {step.startedAt && (
                        <span className="text-xs text-gray-500">
                          {step.status === 'running' ? 'Running...' :
                           step.completedAt ? formatDuration(step.startedAt, step.completedAt) : ''}
                        </span>
                      )}
                    </div>
                    {step.error && (
                      <p className="text-xs text-red-600 mt-1">❌ {step.error}</p>
                    )}
                  </div>
                </div>
              ))}

              {(confirmationTimelineEntries.length > 0 || isLoadingConfirmationAuditLogs || confirmationAuditLogsError) && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-slate-900">{tx('审批审计时间线', 'Confirmation audit timeline')}</p>
                    <Badge variant="outline" className="border-slate-300 bg-white text-slate-700">
                      {confirmationTimelineEntries.length} {tx('条', 'entries')}
                    </Badge>
                  </div>

                  {isLoadingConfirmationAuditLogs && (
                    <p className="text-xs text-slate-500">{tx('正在同步后端审计状态...', 'Syncing backend audit status...')}</p>
                  )}

                  {confirmationAuditLogsError && (
                    <p className="text-xs text-red-600">{confirmationAuditLogsError}</p>
                  )}

                  {confirmationTimelineEntries.length > 0 && (
                    <div className="space-y-2">
                      {confirmationTimelineEntries.map((entry) => (
                      <div
                        key={entry.key}
                        className="rounded-md border border-slate-200 bg-white px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {entry.hasLocalRecord && (
                            <Badge variant="outline" className="border-slate-300 bg-slate-50 text-slate-700">
                              {tx('已回读', 'Hydrated')}
                            </Badge>
                          )}
                          {entry.hasPersistedRecord && (
                            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                              {tx('已入库', 'Persisted')}
                            </Badge>
                          )}
                          <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
                            {entry.optionLabel}
                          </Badge>
                          {entry.reasonLabel && (
                            <Badge variant="outline" className="border-purple-200 bg-purple-50 text-purple-700">
                              {entry.reasonLabel}
                            </Badge>
                          )}
                          {entry.type && (
                            <Badge variant="outline" className="border-slate-300 bg-slate-50 text-slate-700">
                              {getConfirmationTypeLabel(entry.type, tx)}
                            </Badge>
                          )}
                          <span className="text-xs text-slate-500">
                            {formatDateTime(entry.confirmedAt, locale)}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          {tx('确认人', 'Confirmed by')} {entry.confirmedBy || tx('系统', 'System')}
                        </p>
                        {entry.note && <p className="mt-2 text-sm text-slate-600">{entry.note}</p>}
                      </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {task.type === 'manual_follow_up' && followUpTimelineEntries.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-amber-900">
                      {tx('跟进执行时间线', 'Follow-up execution timeline')}
                    </p>
                    <Badge variant="outline" className="border-amber-300 bg-white text-amber-700">
                      {followUpTimelineEntries.length} {tx('条', 'entries')}
                    </Badge>
                  </div>

                  <div className="space-y-2">
                    {followUpTimelineEntries.map((entry) => (
                      <div
                        key={entry.key}
                        className="rounded-md border border-amber-200 bg-white px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="outline"
                            className={cn(
                              entry.isLogged
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                : 'border-amber-300 bg-amber-50 text-amber-700'
                            )}
                          >
                            {entry.isLogged ? tx('已记录', 'Logged') : tx('待执行', 'Pending')}
                          </Badge>
                          <Badge variant="outline" className="border-amber-300 bg-white text-amber-700">
                            {entry.actionLabel}
                          </Badge>
                          {entry.outcomeLabel && (
                            <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
                              {entry.outcomeLabel}
                            </Badge>
                          )}
                          {entry.loggedAt && (
                            <span className="text-xs text-slate-500">
                              {formatDateTime(entry.loggedAt, locale)}
                            </span>
                          )}
                        </div>
                        <p className="mt-2 text-sm font-medium text-slate-900">{entry.supplierName}</p>
                        <p className="mt-1 text-xs text-slate-600">{entry.contactText}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {(entry.rfqNumber || task.context.rfqNumber || tx('未绑定RFQ', 'No RFQ linked'))} · {entry.isLogged
                            ? `${tx('记录人', 'By')} ${entry.createdBy || tx('系统', 'System')}`
                            : tx('等待销售回填真实跟进结果', 'Awaiting actual sales follow-up result')}
                        </p>
                        {entry.notes && <p className="mt-2 text-sm text-slate-600">{entry.notes}</p>}
                      </div>
                    ))}
                  </div>

                  {task.status === 'pending' && (
                    <div className="rounded-md border border-amber-200 bg-white p-3 space-y-3">
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-slate-700">{tx('跟进结果', 'Follow-up outcome')}</p>
                        <Select
                          value={followUpOutcome}
                          onValueChange={(v) => setFollowUpOutcome(v as SupplierFollowUpOutcome)}
                        >
                          <SelectTrigger className="w-full" onClick={(event) => event.stopPropagation()}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="contacted_waiting_quote">{tx('已联系，待报价', 'Contacted, waiting for quote')}</SelectItem>
                            <SelectItem value="quote_promised">{tx('对方承诺回传报价', 'Quote promised')}</SelectItem>
                            <SelectItem value="portal_message_sent">{tx('已发送门户提醒', 'Portal reminder sent')}</SelectItem>
                            <SelectItem value="contact_invalid">{tx('联系方式失效', 'Contact invalid')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <p className="text-xs font-medium text-slate-700">{tx('跟进备注', 'Follow-up notes')}</p>
                        <Textarea
                          rows={3}
                          value={followUpNotes}
                          onChange={(event) => setFollowUpNotes(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          placeholder={tx('填写本次联系结果，例如已加微信、承诺今晚回报价。', 'Capture what happened, for example WeChat added or quote promised tonight.')}
                        />
                      </div>

                      <Button
                        size="sm"
                        variant="outline"
                        className="border-amber-300 text-amber-700 hover:bg-amber-100"
                        disabled={isSavingFollowUp}
                        onClick={async (event) => {
                          event.stopPropagation();
                          setIsSavingFollowUp(true);
                          try {
                            await agentOrchestrator.completeManualFollowUpTask(task.id, {
                              outcome: followUpOutcome,
                              notes: followUpNotes,
                            });
                            toast.success(tx('跟进日志已保存', 'Follow-up log saved'));
                          } catch (error) {
                            toast.error(error instanceof Error ? error.message : tx('保存跟进日志失败', 'Failed to save follow-up log'));
                          } finally {
                            setIsSavingFollowUp(false);
                          }
                        }}
                      >
                        {isSavingFollowUp ? (
                          <span className="inline-flex items-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {tx('保存中...', 'Saving...')}
                          </span>
                        ) : (
                          tx('记录并完成', 'Log and complete')
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AgentWorkbench() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [dashboard, setDashboard] = useState<AgentDashboard | null>(null);
  const [selectedConfirmationId, setSelectedConfirmationId] = useState<string | null>(null);
  const [preferredConfirmationTaskId, setPreferredConfirmationTaskId] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Filter / search / pagination state
  const [taskSearch, setTaskSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [taskPage, setTaskPage] = useState(1);
  const taskPageSize = 8;

  useEffect(() => {
    void agentOrchestrator.hydrateFromServer();
  }, []);

  useEffect(() => {
    const update = () => {
      const allTasks = agentOrchestrator.getAllTasks();
      setTasks(allTasks);
      setDashboard(agentOrchestrator.getDashboard());
    };

    update();
    const unsubscribe = agentOrchestrator.subscribe(update);

    if (autoRefresh) {
      const interval = setInterval(update, 2000);
      return () => {
        clearInterval(interval);
        unsubscribe();
      };
    }

    return unsubscribe;
  }, [autoRefresh]);

  const pendingConfirmations = tasks
    .filter((task) => task.status === 'waiting_confirmation' && task.confirmationNode)
    .map((task) => task.confirmationNode as ConfirmationNode);

  const selectedConfirmation = pendingConfirmations.find(
    (confirmation) => confirmation.id === selectedConfirmationId
  ) || pendingConfirmations[0] || null;

  useEffect(() => {
    if (isConfirming) return;

    if (pendingConfirmations.length === 0) {
      if (selectedConfirmationId !== null) {
        setSelectedConfirmationId(null);
      }
      if (preferredConfirmationTaskId !== null) {
        setPreferredConfirmationTaskId(null);
      }
      return;
    }

    if (preferredConfirmationTaskId) {
      const preferredConfirmation = pendingConfirmations.find(
        (confirmation) => confirmation.taskId === preferredConfirmationTaskId
      );

      if (preferredConfirmation) {
        if (selectedConfirmationId !== preferredConfirmation.id) {
          setSelectedConfirmationId(preferredConfirmation.id);
        }
        setPreferredConfirmationTaskId(null);
        return;
      }
    }

    const hasSelectedConfirmation = selectedConfirmationId
      ? pendingConfirmations.some((confirmation) => confirmation.id === selectedConfirmationId)
      : false;

    if (!hasSelectedConfirmation) {
      setSelectedConfirmationId(pendingConfirmations[0].id);
    }
  }, [isConfirming, pendingConfirmations, preferredConfirmationTaskId, selectedConfirmationId]);

  const handleConfirm = async (optionId: string, additionalData?: Record<string, unknown>) => {
    if (!selectedConfirmation || isConfirming) return;

    setIsConfirming(true);
    try {
      const taskId = selectedConfirmation.taskId;
      setSelectedConfirmationId(null);
      await agentOrchestrator.confirmTask(taskId, optionId, additionalData);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleStartDemo = async () => {
    const task = await agentOrchestrator.createTask(
      { type: 'email', source: 'demo@airlines.com' },
      'email_received',
      { emailId: 'demo_email_001', demoMode: true }
    );
    setPreferredConfirmationTaskId(task.id);
  };

  // Filtered + sorted tasks
  const filteredTasks = useMemo(() => {
    let result = [...tasks];

    // Search
    if (taskSearch.trim()) {
      const q = taskSearch.toLowerCase();
      result = result.filter((t) =>
        t.type.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.trigger.source?.toLowerCase().includes(q) ||
        t.steps.some((s) => s.result?.rfqNumber?.toLowerCase().includes(q))
      );
    }

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter((t) => t.status === statusFilter);
    }

    // Type filter
    if (typeFilter !== 'all') {
      result = result.filter((t) => t.type === typeFilter);
    }

    // Sort: newest first
    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return result;
  }, [tasks, taskSearch, statusFilter, typeFilter]);

  // Pagination
  const totalTaskPages = Math.max(1, Math.ceil(filteredTasks.length / taskPageSize));
  const safeTaskPage = Math.min(taskPage, totalTaskPages);
  const paginatedTasks = filteredTasks.slice((safeTaskPage - 1) * taskPageSize, safeTaskPage * taskPageSize);

  // Unique task types in current data
  const activeTaskTypes = useMemo(() => {
    const set = new Set(tasks.map((t) => t.type));
    return [...set];
  }, [tasks]);

  const statusLabelMap: Record<string, string> = {
    all: tx('全部', 'All'),
    pending: tx('待处理', 'Pending'),
    running: tx('执行中', 'Running'),
    waiting_confirmation: tx('待确认', 'Awaiting'),
    completed: tx('已完成', 'Completed'),
    failed: tx('失败', 'Failed'),
    cancelled: tx('已取消', 'Cancelled'),
  };

  return (
    <div className="space-y-4">
      {/* Header controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant={autoRefresh ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            <RefreshCw className={cn('w-4 h-4 mr-1', autoRefresh && 'animate-spin')} />
            {autoRefresh ? tx('自动刷新', 'Auto refresh') : tx('已暂停', 'Paused')}
          </Button>
          <Button
            className="bg-purple-600 hover:bg-purple-700"
            data-testid="agent-run-demo"
            onClick={handleStartDemo}
          >
            <Play className="w-4 h-4 mr-1" />
            {tx('运行演示', 'Run Demo')}
          </Button>
        </div>
      </div>

      {/* Stats cards (clickable to filter) */}
      {dashboard && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card
            className={cn('hover:shadow-md transition-shadow cursor-pointer', statusFilter === 'all' && 'ring-2 ring-blue-400')}
            onClick={() => { setStatusFilter('all'); setTaskPage(1); }}
          >
            <CardContent className="p-3">
              <p className="text-xs text-blue-600">{tx('任务总数', 'Total Tasks')}</p>
              <p className="text-xl font-bold text-blue-600">{dashboard.tasks.total}</p>
            </CardContent>
          </Card>
          <Card
            className={cn('hover:shadow-md transition-shadow cursor-pointer', statusFilter === 'waiting_confirmation' && 'ring-2 ring-yellow-400')}
            onClick={() => { setStatusFilter('waiting_confirmation'); setTaskPage(1); }}
          >
            <CardContent className="p-3">
              <p className="text-xs text-yellow-600">{tx('待确认', 'Awaiting Confirmation')}</p>
              <p className="text-xl font-bold text-yellow-600">{dashboard.tasks.waitingConfirmation}</p>
            </CardContent>
          </Card>
          <Card
            className={cn('hover:shadow-md transition-shadow cursor-pointer', statusFilter === 'completed' && 'ring-2 ring-green-400')}
            onClick={() => { setStatusFilter('completed'); setTaskPage(1); }}
          >
            <CardContent className="p-3">
              <p className="text-xs text-green-600">{tx('今日完成', 'Completed Today')}</p>
              <p className="text-xl font-bold text-green-600">{dashboard.tasks.completedToday}</p>
            </CardContent>
          </Card>
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardContent className="p-3">
              <p className="text-xs text-purple-600">{tx('完成订单', 'Orders Completed')}</p>
              <p className="text-xl font-bold text-purple-600">{dashboard.pipeline.ordersCompleted}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Confirmation queue */}
      {selectedConfirmation && (
        <Card className="border-yellow-300 bg-yellow-50">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2 text-yellow-800">
              <AlertTriangle className="w-5 h-5" />
              {tx('需要人工确认', 'Manual Confirmation Required')}
              <Badge variant="outline" className="ml-auto bg-yellow-100 border-yellow-300 text-yellow-800">
                {pendingConfirmations.length} {tx('项', 'items')}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pendingConfirmations.length > 1 && (
              <div className="flex flex-wrap gap-2 mb-3" data-testid="agent-confirmation-queue">
                {pendingConfirmations.map((confirmation, index) => {
                  const isActive = selectedConfirmation?.id === confirmation.id;
                  return (
                    <Button
                      key={confirmation.id}
                      type="button"
                      size="sm"
                      variant={isActive ? 'default' : 'outline'}
                      data-testid={`agent-confirmation-queue-item-${index + 1}`}
                      className={cn(isActive && 'bg-yellow-600 hover:bg-yellow-700')}
                      onClick={() => setSelectedConfirmationId(confirmation.id)}
                    >
                      {index + 1}. {getConfirmationQueueLabel(confirmation, tx)}
                    </Button>
                  );
                })}
              </div>
            )}
            <ConfirmationDialog
              confirmation={selectedConfirmation}
              onConfirm={handleConfirm}
            />
          </CardContent>
        </Card>
      )}

      {/* Task Execution Log with filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-purple-600" />
            {tx('任务执行日志', 'Task Execution Log')}
            <span className="text-sm font-normal text-gray-500 ml-2">({filteredTasks.length} {tx('条', 'items')})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                className="pl-10 h-9"
                placeholder={tx('搜索任务类型、来源或单号...', 'Search type, source or number...')}
                value={taskSearch}
                onChange={(e) => { setTaskSearch(e.target.value); setTaskPage(1); }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-500" />
              <Select
                value={statusFilter}
                onValueChange={(v) => { setStatusFilter(v); setTaskPage(1); }}
              >
                <SelectTrigger className="h-9 w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(statusLabelMap).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeTaskTypes.length > 1 && (
                <Select
                  value={typeFilter}
                  onValueChange={(v) => { setTypeFilter(v); setTaskPage(1); }}
                >
                  <SelectTrigger className="h-9 w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{tx('全部类型', 'All Types')}</SelectItem>
                    {activeTaskTypes.map((type) => (
                      <SelectItem key={type} value={type}>{taskTypeConfig[type]?.label || type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {/* Task list */}
          {tasks.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <Bot className="w-16 h-16 mx-auto mb-4 text-gray-300" />
              <p>{tx('暂无任务', 'No tasks yet')}</p>
              <p className="text-sm mt-1">{tx('点击“运行演示”体验Agent自动化流程', 'Click "Run Demo" to try the agent automation flow')}</p>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p>{tx('没有匹配的任务', 'No matching tasks')}</p>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {paginatedTasks.map((task) => (
                  <TaskTimeline key={task.id} task={task} />
                ))}
              </div>

              {/* Pagination */}
              {filteredTasks.length > taskPageSize && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-sm text-gray-500">
                    {tx('第', 'Page')} {safeTaskPage} / {totalTaskPages} {tx('页', '')}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safeTaskPage <= 1}
                      onClick={() => setTaskPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safeTaskPage >= totalTaskPages}
                      onClick={() => setTaskPage((p) => Math.min(totalTaskPages, p + 1))}
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
    </div>
  );
}
