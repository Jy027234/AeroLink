import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { QuotationEmailAssistant } from '@/components/BusinessAiAssistants';
import {
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  Send,
  Eye,
  Download,
  Plus,
  Filter,
  Search,
  AlertTriangle,
  Calendar,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Pencil,
  History,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAcceptQuotation, useApproveQuotation, useCreateQuotation, useQuotation, useQuotations, useSendQuotation, useSubmitQuotation, useWithdrawQuotation } from '@/features/quotations';
import { useRFQ, useRFQs } from '@/features/rfqs';
import { useDispatchNotification, useDocumentTemplates } from '@/features/integrations';
import { documentApi, inventoryAllocationApi, quotationApi, type LineInventoryAvailability } from '@/api/client';
import { useCapabilityStore } from '@/store';
import { PriceRecommendationPanel } from '@/components/PriceRecommendationPanel';
import { InventoryAllocationPanel } from '@/components/InventoryAllocationPanel';
import { ControlledListExportButton } from '@/components/list/ControlledListExportButton';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { downloadBlob } from '@/lib/downloadBlob';
import { useListUrlNumberState, useListUrlStringState } from '@/lib/listUrlState';
import type { DocumentTemplate, Quotation, QuotationLine, QuoteStatus, SaleType, Incoterm } from '@/types';
import { CostSourceFields } from './CostSourceFields';
import { LineQuotationComposer, type LineQuotationDraft } from './LineQuotationComposer';
import { createLineQuotationDrafts } from './lineQuotationComposerModel';
import { buildQuotationRevisionInput, remainingRevisionQuantity, validateRevisionIdentity } from './revisionModel';

const statusConfig: Record<QuoteStatus, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  draft: { label: 'Draft', color: 'text-gray-600', bgColor: 'bg-gray-50', icon: FileText },
  pending_approval: { label: 'Pending Approval', color: 'text-yellow-600', bgColor: 'bg-yellow-50', icon: Clock },
  approved: { label: 'Approved', color: 'text-green-600', bgColor: 'bg-green-50', icon: CheckCircle },
  rejected: { label: 'Rejected', color: 'text-red-600', bgColor: 'bg-red-50', icon: XCircle },
  sent: { label: 'Sent', color: 'text-blue-600', bgColor: 'bg-blue-50', icon: Send },
  accepted: { label: 'Accepted', color: 'text-green-600', bgColor: 'bg-green-50', icon: CheckCircle },
  withdrawn: { label: 'Withdrawn', color: 'text-red-700', bgColor: 'bg-red-50', icon: XCircle },
  expired: { label: 'Expired', color: 'text-gray-500', bgColor: 'bg-gray-100', icon: Calendar },
};

function numeric(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const quoteMoneyFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function formatQuoteMoney(value: number) {
  return quoteMoneyFormatter.format(value);
}

function lineAcceptedQuantity(line: QuotationLine) {
  const accepted = numeric(line.acceptedQuantity);
  return accepted === null ? 0 : Math.max(0, accepted);
}

function lineRemainingQuantity(line: QuotationLine) {
  return Math.max(0, line.quantity - lineAcceptedQuantity(line));
}

function lineDisplayTotal(line: QuotationLine) {
  const total = numeric(line.lineTotal);
  if (total !== null) return total;
  const unitPrice = numeric(line.unitPrice);
  return unitPrice === null ? null : unitPrice * line.quantity;
}

function lineDisplayUnitPrice(line: QuotationLine) {
  return numeric(line.unitPrice);
}

function isModernQuotation(quote: Quotation) {
  // The explicit mode flag is the protocol switch. Legacy quotations may
  // include a single compatibility line in detail responses, so line count
  // alone must never route them through line-level acceptance.
  return quote.lineItemsMode === true;
}

function QuoteStatusBadge({ status }: { status: QuoteStatus }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  const { locale } = useTranslation();
  const labelMap: Record<QuoteStatus, string> = {
    draft: locale === 'zh-CN' ? '草稿' : 'Draft',
    pending_approval: locale === 'zh-CN' ? '待审批' : 'Pending Approval',
    approved: locale === 'zh-CN' ? '已审批' : 'Approved',
    rejected: locale === 'zh-CN' ? '已驳回' : 'Rejected',
    sent: locale === 'zh-CN' ? '已发送' : 'Sent',
    accepted: locale === 'zh-CN' ? '已接受' : 'Accepted',
    withdrawn: locale === 'zh-CN' ? '已撤回' : 'Withdrawn',
    expired: locale === 'zh-CN' ? '已过期' : 'Expired',
  };
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      <Icon className="w-3 h-3 mr-1" />
      {labelMap[status] || config.label}
    </Badge>
  );
}

function QuoteDetailDialog({
  quote,
  isOpen,
  onClose,
  onConfirmCustomer,
  onWithdraw,
  onDownloadContract,
  onRevise,
  onOpenHistory,
}: {
  quote: Quotation | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmCustomer: (quote: Quotation) => void;
  onWithdraw: (quote: Quotation) => void;
  onDownloadContract: (quote: Quotation) => void;
  onRevise: (quote: Quotation) => void;
  onOpenHistory: (id: string) => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const detailQuery = useQuotation(isOpen && quote ? quote.id : '');
  const detailQuote = detailQuery.data;
  const detailLoading = detailQuery.loading;
  const detailLoadFailed = Boolean(detailQuery.error);
  const can = useCapabilityStore((state) => state.can);
  const [revisionHistory, setRevisionHistory] = useState<NonNullable<Quotation['revisionHistory']>>([]);
  const quoteId = quote?.id;

  useEffect(() => {
    let active = true;
    if (!isOpen || !quoteId) {
      setRevisionHistory([]);
      return () => {
        active = false;
      };
    }
    void quotationApi.getRevisions(quoteId)
      .then((revisions) => {
        if (active) setRevisionHistory(revisions);
      })
      .catch(() => {
        // Revision history is an auxiliary view. The main quotation detail
        // remains usable when an older deployment has no history endpoint.
        if (active) setRevisionHistory([]);
      });
    return () => {
      active = false;
    };
  }, [isOpen, quoteId]);

  if (!quote) return null;

  const activeQuote = detailQuote?.id === quote.id ? detailQuote : quote;

  const handleDialogOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };

  const canViewCost = can('quotation.view_cost');
  const isSuperseded = Boolean(activeQuote.supersededAt);
  const canConfirmCustomer = !isSuperseded && (activeQuote.status === 'sent' || activeQuote.status === 'approved') && can('quotation.accept');
  const canWithdraw = !isSuperseded && activeQuote.status === 'sent' && can('quotation.withdraw');
  const canDownloadContract = !!activeQuote.contractDocumentId && (activeQuote.status === 'accepted' || !!activeQuote.orderId);
  const canRevise = can('quotation.create') && can('quotation.update')
    && !activeQuote.supersededAt
    && activeQuote.status !== 'accepted'
    && !(activeQuote.lineItemsMode !== true && !!activeQuote.orderId);
  const previousRevisionId = activeQuote.revisionOfId ?? activeQuote.revisionOf?.id ?? null;
  const nextRevisionId = activeQuote.supersededById ?? activeQuote.supersededBy?.id ?? null;

  return (
    <Dialog open={isOpen} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            {tx('报价详情 - ', 'Quote Details - ')}{activeQuote.quoteNumber}
          </DialogTitle>
          <DialogDescription className="sr-only">{tx('查看报价单详细信息', 'View quote details')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {detailLoadFailed && !detailLoading && (
            <div role="alert" className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 md:flex-row md:items-center md:justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="font-medium">{tx('报价详情加载失败', 'Failed to load quote details')}</p>
                  <p className="text-sm text-amber-800">{tx('当前展示的报价详情可能不是最新，请重试。', 'The quote details may be stale. Please retry.')}</p>
                </div>
              </div>
              <Button variant="outline" onClick={() => void detailQuery.refetch()}>
                {tx('重试加载', 'Retry Loading')}
              </Button>
            </div>
          )}

          {detailLoading && (
            <div className="flex items-center justify-center py-2 text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin text-brand-primary" />
              <span className="ml-2 text-sm">{tx('加载详情中...', 'Loading details...')}</span>
            </div>
          )}

          <div className="flex justify-between items-start p-4 bg-gray-50 rounded-lg">
            <div>
              <p className="font-mono font-semibold text-lg">{activeQuote.quoteNumber}</p>
              <p className="text-sm text-gray-500">{activeQuote.customerName}</p>
              {activeQuote.customerEmail && <p className="text-sm text-gray-400">{activeQuote.customerEmail}</p>}
              {(activeQuote.commercialRevision !== undefined || previousRevisionId || nextRevisionId) && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span className="inline-flex items-center gap-1 rounded border bg-white px-2 py-1">
                    <History className="h-3 w-3" />
                    {tx('商务版次', 'Commercial revision')} v{activeQuote.commercialRevision ?? 1}
                  </span>
                  {previousRevisionId && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => onOpenHistory(previousRevisionId)}
                    >
                      {tx('查看上一版', 'View previous revision')}
                    </Button>
                  )}
                  {nextRevisionId && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => onOpenHistory(nextRevisionId)}
                    >
                      {tx('查看下一版', 'View next revision')}
                    </Button>
                  )}
                  {revisionHistory.length > 1 && revisionHistory.map((revision) => (
                    <Button
                      key={revision.id}
                      type="button"
                      variant={revision.id === activeQuote.id ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-auto px-2 py-1 text-xs"
                      onClick={() => onOpenHistory(revision.id)}
                    >
                      v{revision.commercialRevision}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <QuoteStatusBadge status={activeQuote.status} />
          </div>

          {isModernQuotation(activeQuote) ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{tx('报价明细行', 'Quotation Lines')}</h3>
                <span className="text-sm text-gray-500">{activeQuote.lines?.length ?? 0} {tx('行', 'lines')}</span>
              </div>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tx('件号', 'Part Number')}</TableHead>
                      <TableHead>{tx('报价数量', 'Quoted')}</TableHead>
                      <TableHead>{tx('已成交', 'Accepted')}</TableHead>
                      <TableHead>{tx('剩余', 'Remaining')}</TableHead>
                      <TableHead>{tx('单价', 'Unit Price')}</TableHead>
                      <TableHead>{tx('行合计', 'Line Total')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(activeQuote.lines ?? []).map((line) => {
                      const unitPrice = lineDisplayUnitPrice(line);
                      const total = lineDisplayTotal(line);
                      return (
                        <TableRow key={line.id}>
                          <TableCell>
                            <div className="font-mono font-medium">#{line.lineNo} · {line.partNumber}</div>
                          </TableCell>
                          <TableCell>{line.quantity} {line.uom || 'EA'}</TableCell>
                          <TableCell>{lineAcceptedQuantity(line)} {line.uom || 'EA'}</TableCell>
                          <TableCell>{lineRemainingQuantity(line)} {line.uom || 'EA'}</TableCell>
                          <TableCell>{unitPrice === null ? '—' : `$${formatQuoteMoney(unitPrice)}`}</TableCell>
                          <TableCell>{total === null ? '—' : `$${formatQuoteMoney(total)}`}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-blue-50 p-4">
                <span className="text-gray-600">{tx('报价总价', 'Quote Total')}</span>
                <span className="text-xl font-bold text-blue-600">${formatQuoteMoney(activeQuote.totalPrice)}</span>
              </div>
              <div className="space-y-3">
                {(activeQuote.lines ?? []).map((line) => (
                  <InventoryAllocationPanel
                    key={`allocation-${line.id}`}
                    mode="quotation"
                    quotationLineId={line.id}
                    partNumber={line.partNumber}
                    quantity={line.quantity}
                    onChanged={detailQuery.refetch}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 border rounded-lg">
                <p className="text-xs text-gray-400">{tx('料号', 'Part Number')}</p>
                <p className="font-mono font-semibold text-lg">{activeQuote.partNumber}</p>
              </div>
              <div className="p-4 border rounded-lg">
                <p className="text-xs text-gray-400">{tx('数量', 'Quantity')}</p>
                <p className="font-semibold text-lg">{activeQuote.quantity} EA</p>
              </div>
              <div className="p-4 border rounded-lg">
                <p className="text-xs text-gray-400">{tx('单价', 'Unit Price')}</p>
                <p className="font-semibold text-lg">${activeQuote.unitPrice.toLocaleString()}</p>
              </div>
              <div className="p-4 border rounded-lg bg-blue-50">
                <p className="text-xs text-gray-400">{tx('总价', 'Total Price')}</p>
                <p className="font-bold text-xl text-blue-600">${activeQuote.totalPrice.toLocaleString()}</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
            {canViewCost && !isModernQuotation(activeQuote) && (
              <>
                <div className="flex justify-between">
                  <span className="text-sm text-gray-500">{tx('成本价', 'Cost Price')}</span>
                  <span className="font-mono">${((activeQuote.costPrice || 0) * activeQuote.quantity).toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-gray-500">{tx('利润率', 'Margin')}</span>
                  <span className={cn(
                    'font-semibold',
                    (activeQuote.margin || 0) >= 20 ? 'text-green-600' : (activeQuote.margin || 0) >= 15 ? 'text-yellow-600' : 'text-red-600'
                  )}>
                    {(activeQuote.margin || 0).toFixed(1)}%
                  </span>
                </div>
              </>
            )}
            <div className="flex justify-between">
              <span className="text-sm text-gray-500">{tx('销售类型', 'Sale Type')}</span>
              <span>{activeQuote.saleType || tx('销售', 'Sale')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-500">{tx('贸易条款', 'Incoterm')}</span>
              <span>{activeQuote.incoterm || '-'}{activeQuote.incotermLocation ? ` (${activeQuote.incotermLocation})` : ''}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-500">{tx('交货期', 'Lead Time')}</span>
              <span>{activeQuote.leadTimeDays ? `${activeQuote.leadTimeDays} ${tx('天', 'days')}${activeQuote.leadTimeBasis ? ` (${activeQuote.leadTimeBasis})` : ''}` : '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-500">{tx('最小起订量 / 最小包装量', 'MOQ / MPQ')}</span>
              <span>{activeQuote.moq || '-'} / {activeQuote.mpq || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-500">{tx('税务', 'Tax')}</span>
              <span>{activeQuote.taxIncluded ? `${tx('含税', 'Included')}${activeQuote.taxRate ? ` (${activeQuote.taxRate}%)` : ''}` : tx('不含税', 'Excluded')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-500">{tx('质保', 'Warranty')}</span>
              <span>{activeQuote.warrantyDays || 90} {tx('天', 'days')}{activeQuote.warrantyTerms ? ` (${activeQuote.warrantyTerms})` : ''}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-500">{tx('有效期', 'Validity')}</span>
              <span>{activeQuote.validityDays} {tx('天', 'days')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-500">{tx('到期日', 'Expiry Date')}</span>
              <span>{new Date(activeQuote.expiryDate).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</span>
            </div>
            {activeQuote.packagingRequirement && (
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">{tx('包装要求', 'Packaging')}</span>
                <span>{activeQuote.packagingRequirement}</span>
              </div>
            )}
            {activeQuote.shippingMethod && (
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">{tx('运输方式', 'Shipping')}</span>
                <span>{activeQuote.shippingMethod}</span>
              </div>
            )}
            {activeQuote.ccRecipients && activeQuote.ccRecipients.length > 0 && (
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">{tx('抄送', 'CC')}</span>
                <span>{activeQuote.ccRecipients.join(', ')}</span>
              </div>
            )}
            {activeQuote.eSignatureStatus && (
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">{tx('电子签名', 'E-Signature')}</span>
                <span>{activeQuote.eSignatureStatus === 'Unsigned' ? tx('未签署', 'Unsigned') : activeQuote.eSignatureStatus === 'Signed' ? tx('已签署', 'Signed') : activeQuote.eSignatureStatus === 'Rejected' ? tx('已拒绝', 'Rejected') : activeQuote.eSignatureStatus}</span>
              </div>
            )}
            {activeQuote.countryOfOrigin && (
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">{tx('原产国', 'Country of Origin')}</span>
                <span>{activeQuote.countryOfOrigin}</span>
              </div>
            )}
            {activeQuote.hsCode && (
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">{tx('HS编码', 'HS Code')}</span>
                <span className="font-mono">{activeQuote.hsCode}</span>
              </div>
            )}
            {activeQuote.eccn && (
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">{tx('出口管制分类', 'ECCN')}</span>
                <span className="font-mono">{activeQuote.eccn}</span>
              </div>
            )}
            {activeQuote.dualUse && (
              <div className="flex justify-between">
                <span className="text-sm text-gray-500">{tx('军民两用物项', 'Dual Use')}</span>
                <span className="text-amber-600 font-medium">{tx('是 — 出口需许可证', 'Yes — License Required')}</span>
              </div>
            )}
          </div>
          {activeQuote.commonNote && (
            <div className="p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-500 mb-1">{tx('通用备注', 'Common Note')}</p>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{activeQuote.commonNote}</p>
            </div>
          )}
          {activeQuote.revisionReason && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <p className="mb-1 text-sm font-medium text-blue-900">{tx('修订原因', 'Revision reason')}</p>
              <p className="whitespace-pre-wrap text-sm text-blue-800">{activeQuote.revisionReason}</p>
            </div>
          )}

          {activeQuote.certificateFiles && activeQuote.certificateFiles.length > 0 && (
            <div>
              <h4 className="font-medium mb-2">{tx('证书文件', 'Certificate Files')}</h4>
              <div className="flex flex-wrap gap-2">
                {activeQuote.certificateFiles.map((file, index) => (
                  <Badge key={index} variant="secondary">{file}</Badge>
                ))}
              </div>
            </div>
          )}

          {(activeQuote.customerConfirmationNote || activeQuote.withdrawalReason || activeQuote.contractDocumentTitle) && (
            <div className="space-y-3 rounded-lg border p-4">
              {activeQuote.customerConfirmationNote && (
                <div>
                  <p className="text-sm font-medium text-gray-700">{tx('客户确认', 'Customer Confirmation')}</p>
                  <p className="text-sm text-gray-500">{activeQuote.customerConfirmationNote}</p>
                </div>
              )}
              {activeQuote.withdrawalReason && (
                <div>
                  <p className="text-sm font-medium text-red-700">{tx('撤回原因', 'Withdrawal Reason')}</p>
                  <p className="text-sm text-red-600">{activeQuote.withdrawalReason}</p>
                </div>
              )}
              {activeQuote.contractDocumentTitle && (
                <div>
                  <p className="text-sm font-medium text-gray-700">{tx('已生成合同', 'Generated Contract')}</p>
                  <p className="text-sm text-gray-500">{activeQuote.contractDocumentTitle}</p>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {tx('关闭', 'Close')}
          </Button>
          {canWithdraw && (
            <Button
              variant="destructive"
              onClick={() => {
                onClose();
                onWithdraw(activeQuote);
              }}
            >
              <XCircle className="w-4 h-4 mr-1" />
              {tx('撤回报价', 'Withdraw Quote')}
            </Button>
          )}
          {canDownloadContract && (
            <Button
              variant="outline"
              onClick={() => onDownloadContract(activeQuote)}
            >
              <Download className="w-4 h-4 mr-1" />
              {tx('下载合同', 'Download Contract')}
            </Button>
          )}
          {canRevise && (
            <Button
              variant="outline"
              onClick={() => {
                onClose();
                onRevise(activeQuote);
              }}
            >
              <Pencil className="w-4 h-4 mr-1" />
              {tx('修订报价', 'Revise Quote')}
            </Button>
          )}
          {canConfirmCustomer && (
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() => {
                onClose();
                onConfirmCustomer(activeQuote);
              }}
            >
              <FileText className="w-4 h-4 mr-1" />
              {tx('确认客户并生成合同', 'Confirm Customer & Generate Contract')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateQuoteDialog({
  isOpen,
  onClose,
  onCreated,
  initialQuote = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (quote?: Quotation) => void;
  initialQuote?: Quotation | null;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: rfqs } = useRFQs();
  const { mutate: createQuotation } = useCreateQuotation();
  const revisionDetail = useQuotation(isOpen && initialQuote ? initialQuote.id : '');
  const revisionRfqDetail = useRFQ(isOpen && initialQuote ? initialQuote.rfqId : '');
  const revisionQuote = revisionDetail.data?.id === initialQuote?.id ? revisionDetail.data : initialQuote;
  const isRevision = Boolean(initialQuote);
  const [revisionReason, setRevisionReason] = useState('');
  const [revisionValidityDays, setRevisionValidityDays] = useState(0);
  const [formData, setFormData] = useState({
    rfqId: '',
    customerId: '',
    customerName: '',
    partNumber: '',
    quantity: 1,
    unitPrice: 0,
    costPrice: 0,
    costSourceType: 'MANUAL' as 'SUPPLIER_QUOTE' | 'INVENTORY_DETAIL' | 'MANUAL',
    costSourceId: '',
    costSourceReason: '',
    validityDays: 30,
    saleType: 'Sale' as SaleType,
    incoterm: '' as Incoterm | '',
    incotermLocation: '',
    leadTimeDays: 14,
    leadTimeBasis: '',
    moq: 1,
    mpq: 1,
    priceBasis: '',
    taxIncluded: true,
    taxRate: 13,
    warrantyDays: 90,
    warrantyTerms: '',
    packagingRequirement: '',
    shippingMethod: '',
    countryOfOrigin: '',
    hsCode: '',
    eccn: '',
    dualUse: false,
    ccRecipients: '',
    commonNote: '',
  });
  const [lineDrafts, setLineDrafts] = useState<LineQuotationDraft[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [revisionLegacyCostTouched, setRevisionLegacyCostTouched] = useState(false);

  const selectedRfq = isRevision
    ? (revisionRfqDetail.data ?? rfqs?.find((r) => r.id === formData.rfqId))
    : rfqs?.find((r) => r.id === formData.rfqId);
  const isAog = selectedRfq?.urgency === 'aog';
  const isModernRfq = isRevision
    ? revisionQuote?.lineItemsMode === true
    : selectedRfq?.lineItemsMode === true;
  const revisionQuoteId = revisionQuote?.id;
  const revisionQuoteVersion = revisionQuote?.version;
  const revisionQuoteLineCount = revisionQuote?.lines?.length;
  const hasRevisionDetail = Boolean(revisionDetail.data);
  const revisionCustomerName = revisionQuote?.customerName || revisionRfqDetail.data?.customerName || '';

  useEffect(() => {
    if (!isOpen || !revisionQuote) return;
    const costPrice = numeric(revisionQuote.costPrice);
    const sourceCostMissing = costPrice === null;
    setRevisionReason('');
    setRevisionValidityDays(revisionQuote.rfqUrgency === 'aog' ? 1 : 0);
    setRevisionLegacyCostTouched(!sourceCostMissing);
    setFormData((previous) => ({
      ...previous,
      rfqId: revisionQuote.rfqId,
      customerId: revisionQuote.customerId,
      customerName: revisionCustomerName,
      partNumber: revisionQuote.partNumber,
      quantity: revisionQuote.quantity,
      unitPrice: numeric(revisionQuote.unitPrice) ?? 0,
      costPrice: costPrice ?? 0,
      // A policy-redacted cost must be re-entered with a fresh source or
      // reason. Do not carry a hidden value forward as an implicit zero.
      costSourceType: sourceCostMissing ? 'MANUAL' : (revisionQuote.costSourceType ?? 'MANUAL'),
      costSourceId: sourceCostMissing ? '' : (revisionQuote.costSourceId ?? ''),
      costSourceReason: sourceCostMissing ? '' : (revisionQuote.costSourceReason ?? ''),
      validityDays: revisionQuote.validityDays || previous.validityDays,
      saleType: revisionQuote.saleType || previous.saleType,
      incoterm: revisionQuote.incoterm || '',
      incotermLocation: revisionQuote.incotermLocation ?? '',
      leadTimeDays: revisionQuote.leadTimeDays ?? 0,
      leadTimeBasis: revisionQuote.leadTimeBasis ?? '',
      moq: revisionQuote.moq ?? 0,
      mpq: revisionQuote.mpq ?? 0,
      priceBasis: revisionQuote.priceBasis ?? '',
      taxIncluded: revisionQuote.taxIncluded,
      taxRate: revisionQuote.taxRate ?? 0,
      warrantyDays: revisionQuote.warrantyDays ?? 0,
      warrantyTerms: revisionQuote.warrantyTerms ?? '',
      packagingRequirement: revisionQuote.packagingRequirement ?? '',
      shippingMethod: revisionQuote.shippingMethod ?? '',
      countryOfOrigin: revisionQuote.countryOfOrigin ?? '',
      hsCode: revisionQuote.hsCode ?? '',
      eccn: revisionQuote.eccn ?? '',
      dualUse: revisionQuote.dualUse ?? false,
      ccRecipients: revisionQuote.ccRecipients?.join(', ') ?? '',
      commonNote: revisionQuote.commonNote ?? '',
    }));
    if (revisionQuote.lineItemsMode === true) {
      setLineDrafts((revisionQuote.lines ?? []).filter((line) => remainingRevisionQuantity(line) > 0).map((line) => {
        const lineCost = numeric(line.costPrice);
        const lineCostMissing = lineCost === null;
        return {
          rfqLineId: line.rfqLineId,
          partNumber: line.partNumber,
          // A partially accepted quotation can only revise the unaccepted
          // quantity. Existing order quantities remain attached to the old
          // revision and are never re-submitted here.
          quantity: remainingRevisionQuantity(line),
          unitPrice: numeric(line.unitPrice) ?? 0,
          costPrice: lineCost ?? 0,
          costPriceRedacted: lineCostMissing,
          costSourceType: lineCostMissing ? 'MANUAL' : (line.costSourceType ?? 'MANUAL'),
          costSourceId: lineCostMissing ? '' : (line.costSourceId ?? ''),
          costSourceReason: lineCostMissing ? '' : (line.costSourceReason ?? ''),
        };
      }));
    } else {
      setLineDrafts([]);
    }
  }, [isOpen, revisionQuote, revisionQuoteId, revisionQuoteVersion, revisionQuoteLineCount, hasRevisionDetail, revisionCustomerName]);

  useEffect(() => {
    if (!isOpen || initialQuote) return;
    setRevisionReason('');
    setRevisionValidityDays(0);
  }, [initialQuote, isOpen]);

  const totalPrice = formData.quantity * formData.unitPrice;
  const displayTotal = isModernRfq
    ? lineDrafts.reduce((sum, line) => sum + Math.max(0, line.quantity) * Math.max(0, line.unitPrice), 0)
    : totalPrice;
  const revisionCostNeedsReverification = isRevision && (
    isModernRfq
      ? lineDrafts.some((line) => line.costPriceRedacted === true || (line.costSourceType === 'MANUAL'
        ? !line.costSourceReason.trim()
        : !line.costSourceId.trim()))
      : (numeric(revisionQuote?.costPrice) === null && !revisionLegacyCostTouched)
        || (formData.costSourceType === 'MANUAL'
          ? !formData.costSourceReason.trim()
          : !formData.costSourceId.trim())
  );

  const handleRfqChange = (rfqId: string) => {
    if (isRevision) return;
    const rfq = rfqs?.find((r) => r.id === rfqId);
    if (rfq) {
      setFormData((prev) => ({
        ...prev,
        rfqId,
        customerId: rfq.customerId || prev.customerId,
        customerName: rfq.customerName || prev.customerName,
        partNumber: rfq.partNumber || prev.partNumber,
        quantity: rfq.quantity || prev.quantity,
        costSourceId: '',
        costSourceReason: '',
        validityDays: rfq.urgency === 'aog' ? 1 : prev.validityDays,
      }));
      setLineDrafts(createLineQuotationDrafts(rfq));
    } else {
      setFormData((prev) => ({ ...prev, rfqId }));
      setLineDrafts([]);
    }
  };

  const handleSubmit = async () => {
    const validityDays = isRevision ? (isAog ? 1 : revisionValidityDays) : formData.validityDays;
    const revisionIdentityError = isRevision && revisionQuote
      ? validateRevisionIdentity(revisionQuote, {
        rfqId: formData.rfqId,
        customerId: formData.customerId,
        lineItemsMode: isModernRfq,
      })
      : null;
    if (isRevision && (!revisionQuote || revisionIdentityError)) {
      toast.error(tx('修订必须保留原 RFQ、客户和交易模式。', 'A revision must keep the original RFQ, customer, and transaction mode.'));
      return;
    }
    if (isRevision && !revisionReason.trim()) {
      toast.error(tx('请填写修订原因。', 'Please provide a revision reason.'));
      return;
    }
    if (validityDays <= 0) {
      toast.error(tx('请明确填写新版有效期。', 'Enter a new validity period for the revised quotation.'));
      return;
    }
    const invalidModernLine = lineDrafts.some((draft) => {
      const rfqLine = selectedRfq?.lines?.find((line) => line.id === draft.rfqLineId);
      if (!rfqLine || rfqLine.status !== 'OPEN') return true;
      return draft.partNumber !== rfqLine.partNumber
        || draft.quantity <= 0
        || draft.quantity > rfqLine.quantity
        || draft.unitPrice <= 0
        || draft.costPrice < 0
        || draft.costPriceRedacted === true
        || (draft.costSourceType === 'MANUAL' ? !draft.costSourceReason.trim() : !draft.costSourceId.trim());
    });
    const invalidForm = isModernRfq
      ? !selectedRfq?.customerId || !formData.customerName || lineDrafts.length === 0 || invalidModernLine
      : !formData.rfqId || !formData.customerId || !formData.customerName || !formData.partNumber || formData.quantity <= 0 || formData.unitPrice <= 0 || formData.costPrice < 0
        || (formData.costSourceType === 'MANUAL' && !formData.costSourceReason.trim())
        || (formData.costSourceType !== 'MANUAL' && !formData.costSourceId.trim());
    if (invalidForm) {
      toast.error(isModernRfq
        ? tx('请至少选择一条可报价明细，并完整填写每行的数量、单价和成本来源。', 'Select at least one open RFQ line and complete its quantity, price, and cost source.')
        : tx('请填写所有必填字段（RFQ、客户、件号、数量、单价）。', 'Please fill in all required fields (RFQ, Customer, Part Number, Quantity, Unit Price).'));
      return;
    }
    setIsSubmitting(true);
    try {
      let createdQuote: Quotation | undefined;
      if (isModernRfq && selectedRfq) {
        const modernPayload = {
          rfqId: selectedRfq.id,
          customerId: selectedRfq.customerId,
          lines: lineDrafts.map((line) => ({
            rfqLineId: line.rfqLineId,
            partNumber: line.partNumber,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            costPrice: line.costPrice,
            costSourceType: line.costSourceType,
            ...(line.costSourceType === 'MANUAL'
              ? { costSourceReason: line.costSourceReason.trim() }
              : { costSourceId: line.costSourceId.trim() }),
          })),
          currency: 'USD' as const,
          validityDays,
          saleType: 'Sale' as const,
          incoterm: formData.incoterm || undefined,
          incotermLocation: formData.incotermLocation || undefined,
          leadTimeDays: formData.leadTimeDays || undefined,
          leadTimeBasis: formData.leadTimeBasis || undefined,
          moq: formData.moq || undefined,
          mpq: formData.mpq || undefined,
          priceBasis: formData.priceBasis || undefined,
          taxIncluded: formData.taxIncluded,
          taxRate: formData.taxRate || undefined,
          warrantyDays: formData.warrantyDays || undefined,
          warrantyTerms: formData.warrantyTerms || undefined,
          packagingRequirement: formData.packagingRequirement || undefined,
          shippingMethod: formData.shippingMethod || undefined,
          countryOfOrigin: formData.countryOfOrigin || undefined,
          hsCode: formData.hsCode || undefined,
          eccn: formData.eccn || undefined,
          dualUse: formData.dualUse,
          ccRecipients: formData.ccRecipients ? formData.ccRecipients.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
          commonNote: formData.commonNote || undefined,
          ...(isRevision && revisionQuote ? {
            certificateFiles: revisionQuote.certificateFiles,
            template: revisionQuote.template,
            shipToId: revisionQuote.shipToId ?? undefined,
            shipForId: revisionQuote.shipForId ?? undefined,
            // A revised commercial offer must not inherit the prior
            // signature; the new draft always starts unsigned.
            eSignatureStatus: 'Unsigned',
          } : {}),
        };
        createdQuote = isRevision && revisionQuote
          ? await quotationApi.revise(revisionQuote.id, {
            ...buildQuotationRevisionInput(revisionQuote, revisionReason, modernPayload),
          })
          : await quotationApi.createMultiLine(modernPayload);
      } else {
        const legacyPayload = {
          rfqId: formData.rfqId,
          customerId: formData.customerId,
          partNumber: formData.partNumber,
          quantity: formData.quantity,
          unitPrice: formData.unitPrice,
          costPrice: formData.costPrice,
          currency: 'USD' as const,
          costSourceType: formData.costSourceType,
          costSourceId: formData.costSourceType === 'MANUAL' ? undefined : formData.costSourceId.trim(),
          costSourceReason: formData.costSourceType === 'MANUAL' ? formData.costSourceReason.trim() : undefined,
          validityDays,
          saleType: 'Sale' as const,
          incoterm: formData.incoterm || undefined,
          incotermLocation: formData.incotermLocation || undefined,
          leadTimeDays: formData.leadTimeDays || undefined,
          leadTimeBasis: formData.leadTimeBasis || undefined,
          moq: formData.moq || undefined,
          mpq: formData.mpq || undefined,
          priceBasis: formData.priceBasis || undefined,
          taxIncluded: formData.taxIncluded,
          taxRate: formData.taxRate || undefined,
          warrantyDays: formData.warrantyDays || undefined,
          warrantyTerms: formData.warrantyTerms || undefined,
          packagingRequirement: formData.packagingRequirement || undefined,
          shippingMethod: formData.shippingMethod || undefined,
          countryOfOrigin: formData.countryOfOrigin || undefined,
          hsCode: formData.hsCode || undefined,
          eccn: formData.eccn || undefined,
          dualUse: formData.dualUse,
          ccRecipients: formData.ccRecipients ? formData.ccRecipients.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
          commonNote: formData.commonNote || undefined,
          ...(isRevision && revisionQuote ? {
            certificateFiles: revisionQuote.certificateFiles,
            template: revisionQuote.template,
            shipToId: revisionQuote.shipToId ?? undefined,
            shipForId: revisionQuote.shipForId ?? undefined,
            // A revised commercial offer must not inherit the prior
            // signature; the new draft always starts unsigned.
            eSignatureStatus: 'Unsigned',
          } : {}),
        };
        createdQuote = isRevision && revisionQuote
          ? await quotationApi.revise(revisionQuote.id, {
            ...buildQuotationRevisionInput(revisionQuote, revisionReason, legacyPayload),
          })
          : await createQuotation({
            ...legacyPayload,
            customerName: formData.customerName,
            description: `Part ${formData.partNumber}`,
            totalPrice,
            margin: formData.costPrice > 0 ? ((formData.unitPrice - formData.costPrice) / formData.unitPrice) * 100 : 0,
            status: 'draft',
          });
      }
      toast.success(isRevision
        ? tx('报价修订已创建为新草稿，请重新提交审批。', 'The quotation revision was created as a new draft and must be submitted for approval.')
        : isModernRfq
          ? tx('多行报价草稿已创建，请从列表提交审批。', 'Multi-line quote draft created. Submit it for approval from the list.')
          : tx('报价单创建成功。', 'Quote created successfully.'));
      onClose();
      onCreated(createdQuote);
    } catch (error) {
      console.error('Failed to create quotation:', error);
      toast.error(tx(isRevision ? '修订报价单失败。' : '创建报价单失败。', isRevision ? 'Failed to create the quotation revision.' : 'Failed to create quote.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isRevision ? <Pencil className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
            {tx(
              isRevision ? '修订报价单' : (isModernRfq ? '创建报价草稿' : '创建报价单'),
              isRevision ? 'Revise Quote' : (isModernRfq ? 'Create Quote Draft' : 'Create Quote'),
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">{tx(isRevision ? '基于现有报价创建新版报价单' : '创建新的报价单', isRevision ? 'Create a new revision from this quotation' : 'Create a new quote')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {isRevision && revisionQuote && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {revisionQuote.quoteNumber} · {tx('当前版次', 'Current revision')} v{revisionQuote.commercialRevision ?? 1}
                </span>
                <span>{tx('新版创建后为草稿，需重新提交审批；既有订单保持不变。', 'The new version starts as a draft and must be re-submitted for approval; existing orders remain unchanged.')}</span>
              </div>
            </div>
          )}
          {isRevision && (
            <div className="grid grid-cols-1 gap-4 rounded-lg border border-amber-200 bg-amber-50 p-4 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="quotation-revision-reason">{tx('修订原因 *', 'Revision reason *')}</Label>
                <Textarea
                  id="quotation-revision-reason"
                  value={revisionReason}
                  onChange={(e) => setRevisionReason(e.target.value)}
                  placeholder={tx('请说明价格、交期、成本来源或商务条款的变更原因。', 'Explain why the price, lead time, cost source, or commercial terms changed.')}
                  className="min-h-[96px]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="quotation-revision-validity">{tx('新版有效期（天） *', 'New validity (days) *')}</Label>
                <Input
                  id="quotation-revision-validity"
                  type="number"
                  min={1}
                  value={isAog ? 1 : revisionValidityDays}
                  onChange={(e) => setRevisionValidityDays(parseInt(e.target.value, 10) || 0)}
                  disabled={isAog}
                  className={isAog ? 'bg-red-50 border-red-200' : ''}
                />
                <p className="text-xs text-amber-800">
                  {isAog ? tx('AOG 修订有效期固定为 1 天。', 'AOG revisions are fixed to 1 day.') : tx('必须重新确认新版有效期，不会沿用旧版。', 'Confirm a new validity period; the old period is not reused.')}
                </p>
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label>{tx('关联 RFQ *', 'Associated RFQ *')}</Label>
            <Select value={formData.rfqId} onValueChange={handleRfqChange} disabled={isRevision}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tx('请选择 RFQ', 'Select RFQ...')} />
              </SelectTrigger>
              <SelectContent>
                {rfqs?.map((rfq) => (
                  <SelectItem key={rfq.id} value={rfq.id}>
                    {rfq.rfqNumber} · {rfq.lines?.length ? `${rfq.lines.length} lines` : rfq.partNumber} · {rfq.customerName} {rfq.urgency === 'aog' ? '(AOG)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isAog && (
            <div className="flex items-start gap-2 rounded-md bg-red-50 border border-red-200 p-3 text-red-800 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">{tx('AOG 快速通道', 'AOG Fast Track')}</p>
                <p>{tx('有效期自动设为 1 天；审批按报价总额分级，创建者不能自批。', 'Validity auto-set to 1 day; approval is tiered by quote total and the creator cannot self-approve.')}</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('客户名称 *', 'Customer Name *')}</Label>
              <Input
                value={formData.customerName}
                onChange={(e) => setFormData({ ...formData, customerName: e.target.value })}
                placeholder={tx('输入客户名称', 'Enter customer name')}
                readOnly={isModernRfq || isRevision}
              />
            </div>
          </div>

          {isModernRfq ? (
            <LineQuotationComposer
              rfq={selectedRfq}
              value={lineDrafts}
              onChange={setLineDrafts}
              disabled={isSubmitting}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{tx('件号 *', 'Part Number *')}</Label>
                  <Input
                    value={formData.partNumber}
                    onChange={(e) => setFormData({ ...formData, partNumber: e.target.value, costSourceId: '' })}
                    placeholder={tx('输入件号', 'Enter part number')}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{tx('数量 *', 'Quantity *')}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={formData.quantity}
                    onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) || 0, costSourceId: '' })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{tx('单价 *', 'Unit Price *')}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={formData.unitPrice}
                    onChange={(e) => setFormData({ ...formData, unitPrice: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{tx('成本价', 'Cost Price')}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={isRevision && numeric(revisionQuote?.costPrice) === null && !revisionLegacyCostTouched ? '' : formData.costPrice}
                    readOnly={formData.costSourceType !== 'MANUAL'}
                    onChange={(e) => {
                      if (isRevision) setRevisionLegacyCostTouched(true);
                      setFormData({ ...formData, costPrice: parseFloat(e.target.value) || 0 });
                    }}
                  />
                </div>
              </div>

              <CostSourceFields
                active={isOpen}
                value={formData}
                rfqId={formData.rfqId}
                partNumber={formData.partNumber}
                quantity={formData.quantity}
                onChange={(source, unitCost) => {
                  if (isRevision) setRevisionLegacyCostTouched(true);
                  setFormData(previous => ({ ...previous, ...source, ...(unitCost !== undefined ? { costPrice: unitCost } : {}) }));
                }}
              />

              {/* AI 价格推荐 */}
              {formData.partNumber && formData.quantity > 0 && (
                <PriceRecommendationPanel
                  partNumber={formData.partNumber}
                  quantity={formData.quantity}
                  customerId={formData.customerId}
                  proposedPrice={formData.unitPrice > 0 ? formData.unitPrice : undefined}
                  onApplyPrice={(price) => setFormData((prev) => ({ ...prev, unitPrice: price }))}
                />
              )}
            </>
          )}

          {isRevision && revisionCostNeedsReverification && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{tx('旧版成本字段不可见或来源不完整。请重新核实成本并填写来源/原因后再提交，系统不会按 0 成本静默修订。', 'The prior cost is unavailable or its source is incomplete. Re-verify the cost and enter a source or reason before submitting; the revision will not silently use zero cost.')}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('有效期（天）', 'Validity (days)')}</Label>
              <Input
                type="number"
                min={1}
                value={isRevision ? (isAog ? 1 : revisionValidityDays) : formData.validityDays}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10) || 0;
                  if (isRevision) setRevisionValidityDays(value);
                  else setFormData({ ...formData, validityDays: value || 30 });
                }}
                disabled={isAog}
                className={isAog ? 'bg-red-50 border-red-200' : ''}
              />
              {isAog && <p className="text-xs text-red-600">{tx('AOG 强制 1 天', 'AOG forced to 1 day')}</p>}
            </div>
            <div className="space-y-2">
              <Label>{tx('销售类型', 'Sale Type')}</Label>
              <Select
                value={formData.saleType}
                onValueChange={(v) => setFormData({ ...formData, saleType: v as SaleType })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Sale">{tx('销售', 'Sale')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('贸易条款', 'Incoterm')}</Label>
              <Select
                value={formData.incoterm}
                onValueChange={(v) => setFormData({ ...formData, incoterm: v as Incoterm })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={tx('请选择...', 'Select...')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EXW">EXW</SelectItem>
                  <SelectItem value="FCA">FCA</SelectItem>
                  <SelectItem value="CPT">CPT</SelectItem>
                  <SelectItem value="CIP">CIP</SelectItem>
                  <SelectItem value="DAP">DAP</SelectItem>
                  <SelectItem value="DPU">DPU</SelectItem>
                  <SelectItem value="DDP">DDP</SelectItem>
                  <SelectItem value="FAS">FAS</SelectItem>
                  <SelectItem value="FOB">FOB</SelectItem>
                  <SelectItem value="CFR">CFR</SelectItem>
                  <SelectItem value="CIF">CIF</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{tx('贸易条款地点', 'Incoterm Location')}</Label>
              <Input
                value={formData.incotermLocation}
                onChange={(e) => setFormData({ ...formData, incotermLocation: e.target.value })}
                placeholder={tx('例如：北京', 'e.g. Beijing')}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>{tx('交货期（天）', 'Lead Time (days)')}</Label>
              <Input
                type="number"
                min={0}
                value={formData.leadTimeDays}
                onChange={(e) => setFormData({ ...formData, leadTimeDays: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('交货期基准', 'Lead Time Basis')}</Label>
              <Input
                value={formData.leadTimeBasis}
                onChange={(e) => setFormData({ ...formData, leadTimeBasis: e.target.value })}
                placeholder={tx('例如：出厂价', 'e.g. Ex-works')}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('价格基准', 'Price Basis')}</Label>
              <Input
                value={formData.priceBasis}
                onChange={(e) => setFormData({ ...formData, priceBasis: e.target.value })}
                placeholder={tx('例如：USD', 'e.g. USD')}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>{tx('最小起订量', 'MOQ')}</Label>
              <Input
                type="number"
                min={1}
                value={formData.moq}
                onChange={(e) => setFormData({ ...formData, moq: parseInt(e.target.value) || 1 })}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('最小包装量', 'MPQ')}</Label>
              <Input
                type="number"
                min={1}
                value={formData.mpq}
                onChange={(e) => setFormData({ ...formData, mpq: parseInt(e.target.value) || 1 })}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('质保（天）', 'Warranty (days)')}</Label>
              <Input
                type="number"
                min={0}
                value={formData.warrantyDays}
                onChange={(e) => setFormData({ ...formData, warrantyDays: parseInt(e.target.value) || 90 })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('含税', 'Tax Included')}</Label>
              <div className="flex items-center h-10 gap-2">
                <Switch
                  checked={formData.taxIncluded}
                  onCheckedChange={(checked) => setFormData({ ...formData, taxIncluded: checked })}
                />
                <span className="text-sm text-gray-600">{formData.taxIncluded ? tx('是', 'Yes') : tx('否', 'No')}</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{tx('税率（%）', 'Tax Rate (%)')}</Label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={formData.taxRate}
                onChange={(e) => setFormData({ ...formData, taxRate: parseFloat(e.target.value) || 0 })}
                disabled={!formData.taxIncluded}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('包装要求', 'Packaging Requirement')}</Label>
              <Input
                value={formData.packagingRequirement}
                onChange={(e) => setFormData({ ...formData, packagingRequirement: e.target.value })}
                placeholder={tx('例: ATA300', 'e.g. ATA300')}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('运输方式', 'Shipping Method')}</Label>
              <Input
                value={formData.shippingMethod}
                onChange={(e) => setFormData({ ...formData, shippingMethod: e.target.value })}
                placeholder={tx('例: DHL', 'e.g. DHL')}
              />
            </div>
          </div>

          <div className="rounded-lg border p-4 space-y-4">
            <p className="text-sm font-medium text-gray-700">{tx('进出口合规', 'Import / Export Compliance')}</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('原产国', 'Country of Origin')}</Label>
                <Select
                  value={formData.countryOfOrigin}
                  onValueChange={(v) => setFormData({ ...formData, countryOfOrigin: v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={tx('请选择', 'Select...')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="US">US</SelectItem>
                    <SelectItem value="CN">CN</SelectItem>
                    <SelectItem value="DE">DE</SelectItem>
                    <SelectItem value="UK">UK</SelectItem>
                    <SelectItem value="FR">FR</SelectItem>
                    <SelectItem value="JP">JP</SelectItem>
                    <SelectItem value="Other">{tx('其他', 'Other')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tx('HS编码', 'HS Code')}</Label>
                <Input
                  value={formData.hsCode}
                  onChange={(e) => setFormData({ ...formData, hsCode: e.target.value })}
                  placeholder={tx('例: 8803.30', 'e.g. 8803.30')}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('出口管制分类号', 'ECCN')}</Label>
                <Input
                  value={formData.eccn}
                  onChange={(e) => setFormData({ ...formData, eccn: e.target.value })}
                  placeholder={tx('例: 9A991', 'e.g. 9A991')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('军民两用物项', 'Dual Use')}</Label>
                <div className="flex items-center h-10 gap-2">
                  <Switch
                    checked={formData.dualUse}
                    onCheckedChange={(checked) => setFormData({ ...formData, dualUse: checked })}
                  />
                  <span className="text-sm text-gray-600">{formData.dualUse ? tx('是', 'Yes') : tx('否', 'No')}</span>
                </div>
              </div>
            </div>
            {formData.dualUse && (
              <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 p-3 text-amber-800 text-sm">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{tx('此件号为军民两用物项，出口需申请许可证。', 'This part is a dual-use item, export license required.')}</span>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>{tx('抄送人（逗号分隔）', 'CC Recipients (comma separated)')}</Label>
            <Input
              value={formData.ccRecipients}
              onChange={(e) => setFormData({ ...formData, ccRecipients: e.target.value })}
              placeholder="email1@example.com, email2@example.com"
            />
          </div>

          <div className="space-y-2">
            <Label>{tx('质保条款', 'Warranty Terms')}</Label>
            <Input
              value={formData.warrantyTerms}
              onChange={(e) => setFormData({ ...formData, warrantyTerms: e.target.value })}
              placeholder={tx('输入质保条款...', 'Enter warranty terms...')}
            />
          </div>

          <div className="space-y-2">
            <Label>{tx('通用备注', 'Common Note')}</Label>
            <Textarea
              value={formData.commonNote}
              onChange={(e) => setFormData({ ...formData, commonNote: e.target.value })}
              placeholder={tx('输入通用备注...', 'Enter common note...')}
            />
          </div>

          <div className="p-4 bg-blue-50 rounded-lg">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{tx(isModernRfq ? '展示合计（USD）' : '报价合计', isModernRfq ? 'Display Total (USD)' : 'Quote Total')}</span>
              <span className="text-2xl font-bold text-blue-600">${isModernRfq ? formatQuoteMoney(displayTotal) : displayTotal.toLocaleString()}</span>
            </div>
            {!isModernRfq && formData.costPrice > 0 && (
              <div className="flex justify-between items-center mt-2">
                <span className="text-gray-600">{tx('预估毛利率', 'Estimated Margin')}</span>
                <span className={cn(
                  'font-semibold',
                  ((formData.unitPrice - formData.costPrice) / formData.unitPrice * 100) >= 20 ? 'text-green-600' :
                  ((formData.unitPrice - formData.costPrice) / formData.unitPrice * 100) >= 15 ? 'text-yellow-600' : 'text-red-600'
                )}>
                  {((formData.unitPrice - formData.costPrice) / formData.unitPrice * 100).toFixed(1)}%
                </span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button
            className="bg-brand-primary hover:bg-brand-primary-hover"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : (isRevision ? <Pencil className="w-4 h-4 mr-1" /> : <Plus className="w-4 h-4 mr-1" />)}
            {tx(isRevision ? '创建新版报价草稿' : '创建报价单', isRevision ? 'Create Revised Quote Draft' : 'Create Quote')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalDialog({
  quote,
  isOpen,
  onClose,
  onApprove,
  onReject,
}: {
  quote: Quotation | null;
  isOpen: boolean;
  onClose: () => void;
  onApprove: (comment: string, costSource?: { costSourceType: 'SUPPLIER_QUOTE' | 'INVENTORY_DETAIL' | 'MANUAL'; costSourceId?: string; costSourceReason?: string }) => void;
  onReject: (comment: string) => void;
}) {
  const [comment, setComment] = useState('');
  const [costSourceType, setCostSourceType] = useState<'SUPPLIER_QUOTE' | 'INVENTORY_DETAIL' | 'MANUAL'>('MANUAL');
  const [costSourceId, setCostSourceId] = useState('');
  const [costSourceReason, setCostSourceReason] = useState('');
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  useEffect(() => {
    setComment('');
    setCostSourceType('MANUAL');
    setCostSourceId('');
    setCostSourceReason('');
  }, [isOpen, quote?.id]);

  if (!quote) return null;

  const isAog = quote.rfqUrgency === 'aog';
  const isReapproval = quote.status === 'approved' && quote.requiresReapproval === true;
  const needsSourceRepair = !isModernQuotation(quote) && !quote.costSourceType;
  const sourceRepairReady = costSourceType === 'MANUAL'
    ? costSourceReason.trim().length > 0
    : costSourceId.trim().length > 0;

  const getApprovalLevel = () => {
    if (quote.totalPrice > 50000) return { level: tx('总经理', 'General Manager'), color: 'text-red-600' };
    if (quote.totalPrice > 5000) return { level: tx('财务+经理', 'Finance + Manager'), color: 'text-yellow-600' };
    return { level: tx('销售经理', 'Sales Manager'), color: 'text-green-600' };
  };

  const approvalLevel = getApprovalLevel();

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isReapproval ? tx('重新审核报价单', 'Re-review Quote') : tx('审批报价单', 'Approve Quote')}</DialogTitle>
          <DialogDescription className="sr-only">{isReapproval ? tx('该报价的历史审批记录无法验证，请重新审核', 'The historical approval cannot be verified; review this quote again') : tx('审批报价单意见', 'Approve or reject quote')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="bg-gray-50 p-4 rounded-lg">
            <div className="flex justify-between items-start">
              <div>
                <p className="font-mono font-semibold">{quote.quoteNumber}</p>
                <p className="text-sm text-gray-500">{quote.customerName}</p>
              </div>
              <QuoteStatusBadge status={quote.status} />
            </div>
            {isModernQuotation(quote) ? (
              <div className="mt-4 space-y-2 border-t pt-4">
                <p className="text-sm font-medium">{tx('报价明细行（按总额审批）', 'Quotation lines (approval is based on total)')}</p>
                {(quote.lines ?? []).map((line) => {
                  const total = lineDisplayTotal(line);
                  return (
                    <div key={line.id} className="flex items-center justify-between text-sm">
                      <span className="font-mono">{line.partNumber} × {line.quantity}</span>
                      <span>{total === null ? '—' : `$${formatQuoteMoney(total)}`}</span>
                    </div>
                  );
                })}
                <div className="flex justify-between border-t pt-2 font-semibold">
                  <span>{tx('总价', 'Total Price')}</span>
                  <span>${formatQuoteMoney(quote.totalPrice)}</span>
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div>
                    <p className="text-xs text-gray-400">{tx('料号', 'Part Number')}</p>
                    <p className="font-mono">{quote.partNumber}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">{tx('数量', 'Quantity')}</p>
                    <p>{quote.quantity} EA</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">{tx('单价', 'Unit Price')}</p>
                    <p className="font-semibold">${quote.unitPrice.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">{tx('总价', 'Total Price')}</p>
                    <p className="font-semibold text-lg">${quote.totalPrice.toLocaleString()}</p>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">{tx('成本价', 'Cost Price')}</span>
                    <span className="font-mono">${quote.costPrice.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-sm text-gray-500">{tx('利润率', 'Margin')}</span>
                    <span className={cn(
                      'font-semibold',
                      quote.margin >= 20 ? 'text-green-600' : quote.margin >= 15 ? 'text-yellow-600' : 'text-red-600'
                    )}>
                      {quote.margin.toFixed(1)}%
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className={cn(
            'flex items-center gap-2 p-3 border rounded-lg',
            isAog ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'
          )}>
            <AlertTriangle className={cn('w-5 h-5', isAog ? 'text-red-600' : 'text-yellow-600')} />
            <div>
              <p className={cn('text-sm font-medium', isAog ? 'text-red-800' : 'text-yellow-800')}>
                {tx('审批级别', 'Approval Level')}
              </p>
              <p className={cn('text-sm', approvalLevel.color)}>
                {approvalLevel.level} ({tx('金额', 'Amount')}: ${quote.totalPrice.toLocaleString()})
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tx('审批意见', 'Approval Comment')}</Label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={tx('输入审批意见（可选）...', 'Enter an approval comment (optional)...')}
            />
          </div>

          {needsSourceRepair && (
            <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3">
              <div>
                <p className="text-sm font-medium text-amber-900">{tx('历史成本来源待补录', 'Historical cost source required')}</p>
                <p className="text-xs text-amber-800">{tx('该历史报价没有可复核来源。补录后才可在当前版本重新审核。', 'This historical quote has no verifiable source. Add one before re-reviewing it.')}</p>
              </div>
              <CostSourceFields
                active={isOpen}
                rfqId={quote.rfqId}
                partNumber={quote.partNumber}
                quantity={quote.quantity}
                expectedCost={quote.costPrice}
                value={{ costSourceType, costSourceId, costSourceReason }}
                onChange={source => {
                  setCostSourceType(source.costSourceType);
                  setCostSourceId(source.costSourceId);
                  setCostSourceReason(source.costSourceReason);
                }}
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onReject(comment);
              setComment('');
            }}
          >
            <XCircle className="w-4 h-4 mr-1" />
            {tx('驳回', 'Reject')}
          </Button>
          <Button
            className="bg-green-600 hover:bg-green-700"
            disabled={needsSourceRepair && !sourceRepairReady}
            onClick={() => {
              onApprove(comment, needsSourceRepair ? {
                costSourceType,
                costSourceId: costSourceType === 'MANUAL' ? undefined : costSourceId.trim(),
                costSourceReason: costSourceType === 'MANUAL' ? costSourceReason.trim() : undefined,
              } : undefined);
              setComment('');
            }}
          >
            <CheckCircle className="w-4 h-4 mr-1" />
            {isReapproval ? tx('确认重新审核', 'Confirm Re-review') : tx('通过', 'Approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConvertToOrderDialog({
  quote: initialQuote,
  isOpen,
  onClose,
  templates,
  onConfirmed,
}: {
  quote: Quotation | null;
  isOpen: boolean;
  onClose: () => void;
  templates: DocumentTemplate[];
  onConfirmed: () => Promise<void>;
}) {
  const defaultTemplateId = templates.find((item) => item.isDefault)?.id || templates[0]?.id || '';
  const [poNumber, setPoNumber] = useState('');
  const [deliveryDate, setDeliveryDate] = useState(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
  const [confirmationNote, setConfirmationNote] = useState('');
  const [templateId, setTemplateId] = useState(defaultTemplateId);
  const [acceptedQuantities, setAcceptedQuantities] = useState<Record<string, number>>({});
  const [allocationViews, setAllocationViews] = useState<Record<string, LineInventoryAvailability | null>>({});
  const [allocationSelections, setAllocationSelections] = useState<Record<string, Record<string, number>>>({});
  const [allocationLoadError, setAllocationLoadError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { accept } = useAcceptQuotation();
  const can = useCapabilityStore((state) => state.can);
  const detailQuery = useQuotation(isOpen && initialQuote ? initialQuote.id : '');
  const quote = detailQuery.data?.id === initialQuote?.id ? detailQuery.data : initialQuote;
  const { locale } = useTranslation();
  const tx = useCallback((zh: string, en: string) => (locale === 'zh-CN' ? zh : en), [locale]);

  useEffect(() => {
    setTemplateId(defaultTemplateId);
  }, [defaultTemplateId]);

  useEffect(() => {
    if (!quote || !isModernQuotation(quote)) {
      setAcceptedQuantities({});
      setAllocationViews({});
      setAllocationSelections({});
      setAllocationLoadError('');
      return;
    }
    setAcceptedQuantities(Object.fromEntries((quote.lines ?? []).map((line) => [line.id, lineRemainingQuantity(line)])));
    setAllocationSelections({});
  }, [quote]);

  useEffect(() => {
    let active = true;
    if (!isOpen || !quote || !isModernQuotation(quote)) {
      setAllocationViews({});
      setAllocationSelections({});
      setAllocationLoadError('');
      return () => { active = false; };
    }
    setAllocationLoadError('');
    const lines = quote.lines ?? [];
    void Promise.all(lines.map(async (line) => {
      try {
        return [line.id, await inventoryAllocationApi.getQuotationLine(line.id)] as const;
      } catch {
        return [line.id, null] as const;
      }
    })).then((entries) => {
      if (!active) return;
      const next = Object.fromEntries(entries) as Record<string, LineInventoryAvailability | null>;
      setAllocationViews(next);
      if (entries.length > 0 && entries.every(([, value]) => value === null)) {
        setAllocationLoadError(tx('无法读取行级库存预留；如仍需处理请刷新。', 'Line allocation data could not be loaded; refresh before continuing.'));
      }
    });
    return () => { active = false; };
  }, [isOpen, quote?.id, quote?.version, quote?.lines, tx]);

  if (!quote) return null;

  const modernQuote = isModernQuotation(quote);
  const quoteLines = quote.lines ?? [];
  const selectedLineAcceptances = quoteLines
    .map((line) => {
      const allocations = (allocationViews[line.id]?.allocations ?? [])
        .map((allocation) => ({
          allocationId: allocation.id,
          quantity: Math.max(0, Math.min(allocation.unassignedQuantity, allocationSelections[line.id]?.[allocation.id] ?? 0)),
        }))
        .filter((allocation) => allocation.quantity > 0);
      return {
        quotationLineId: line.id,
        quantity: Math.max(0, Math.min(lineRemainingQuantity(line), acceptedQuantities[line.id] ?? 0)),
        ...(allocations.length > 0 ? { allocations } : {}),
      };
    })
    .filter((line) => line.quantity > 0);
  const allocationRequirement = quoteLines.map((line) => {
    const selectedQuantity = Math.max(0, Math.min(lineRemainingQuantity(line), acceptedQuantities[line.id] ?? 0));
    const selectedAllocations = (allocationViews[line.id]?.allocations ?? []).reduce((sum, allocation) => sum + Math.max(0, Math.min(allocation.unassignedQuantity, allocationSelections[line.id]?.[allocation.id] ?? 0)), 0);
    const reserved = allocationViews[line.id]?.reservedQuantity ?? line.reservedQuantity;
    const required = Math.max(0, reserved - (lineRemainingQuantity(line) - selectedQuantity));
    return { line, selectedQuantity, selectedAllocations, required, missingView: reserved > 0 && !allocationViews[line.id] };
  });
  const allocationIssue = allocationRequirement.find((item) => item.selectedQuantity > 0 && (item.missingView || item.selectedAllocations < item.required));
  const selectedAmount = quoteLines.reduce((sum, line) => {
    const unitPrice = lineDisplayUnitPrice(line);
    const quantity = Math.max(0, Math.min(lineRemainingQuantity(line), acceptedQuantities[line.id] ?? 0));
    return unitPrice === null ? sum : sum + unitPrice * quantity;
  }, 0);

  const handleSubmit = async () => {
    if (modernQuote && (quoteLines.length === 0 || selectedLineAcceptances.length === 0)) {
      toast.error(tx('请至少填写一条剩余数量大于 0 的报价行。', 'Enter an acceptance quantity for at least one quotation line with remaining quantity.'));
      return;
    }
    if (modernQuote && allocationIssue) {
      toast.error(can('inventory.manage')
        ? tx(`第 ${allocationIssue.line.lineNo} 行需要明确选择至少 ${allocationIssue.required} EA 的未分配库存。`, `Line ${allocationIssue.line.lineNo} requires explicit selection of at least ${allocationIssue.required} unassigned inventory.`)
        : tx('该报价已有库存预留，需要库存管理员明确选择分配后才能成交。', 'This quote has reserved inventory. An inventory manager must explicitly assign it before acceptance.'));
      return;
    }
    setIsSubmitting(true);
    try {
      const result = modernQuote
        ? await quotationApi.acceptLines(quote.id, {
          lines: selectedLineAcceptances,
          version: quote.version,
          poNumber,
          deliveryDate,
          templateId: templateId || undefined,
          confirmationNote: confirmationNote || undefined,
        })
        : await accept(quote.id, {
          poNumber,
          deliveryDate,
          templateId: templateId || undefined,
          confirmationNote: confirmationNote || undefined,
          version: quote.version,
        });

      if ((result as { contractDocumentId?: string }).contractDocumentId) {
        const blob = await documentApi.getPdfBlob((result as { contractDocumentId: string }).contractDocumentId);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${quote.quoteNumber}-contract.pdf`;
        link.click();
        URL.revokeObjectURL(url);
      }

      toast.success(tx(`客户确认已记录，合同已生成：${quote.quoteNumber}。`, `Customer confirmation recorded. Contract generated for ${quote.quoteNumber}.`));
      onClose();
      await onConfirmed();
    } catch (error) {
      console.error('Failed to confirm quote:', error);
      toast.error(tx('确认报价失败，请重试。', 'Failed to confirm quote. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            {tx('客户确认并生成合同', 'Customer Confirmation & Contract Generation')}
          </DialogTitle>
          <DialogDescription className="sr-only">{tx('确认客户并生成合同', 'Confirm customer and generate contract')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="p-4 bg-blue-50 rounded-lg">
            <p className="font-mono font-semibold">{quote.quoteNumber}</p>
            {modernQuote ? (
              <div className="mt-2 space-y-2 text-sm text-gray-600">
                {quoteLines.map((line) => {
                  const remaining = lineRemainingQuantity(line);
                  const selected = Math.max(0, Math.min(remaining, acceptedQuantities[line.id] ?? 0));
                  const view = allocationViews[line.id];
                  const requirement = allocationRequirement.find((item) => item.line.id === line.id);
                  return (
                    <div key={line.id} className="space-y-2">
                      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3">
                        <span className="font-mono">{line.partNumber}</span>
                        <span>{tx('剩余', 'Remaining')}: {remaining}</span>
                        <Input
                          aria-label={`${line.partNumber} ${tx('接受数量', 'Acceptance quantity')}`}
                          className="h-8 w-24 bg-white"
                          type="number"
                          min={0}
                          max={remaining}
                          step={1}
                          value={selected}
                          onChange={(event) => {
                            const parsed = Number.parseInt(event.target.value, 10);
                            const accepted = Number.isFinite(parsed) ? Math.min(remaining, Math.max(0, parsed)) : 0;
                            setAcceptedQuantities((previous) => ({ ...previous, [line.id]: accepted }));
                          }}
                        />
                      </div>
                      {view?.allocations && view.allocations.length > 0 && <div className="space-y-1 rounded border border-blue-100 bg-white p-2 text-xs">
                        <p className="font-medium text-blue-900">{tx('已预留库存：请明确选择转入本次订单的父分配', 'Reserved inventory: explicitly select parent allocations for this order')}</p>
                        {view.allocations.map((allocation, index) => {
                          const selectedAllocationQuantity = allocationSelections[line.id]?.[allocation.id] ?? 0;
                          return <div key={allocation.id} className="grid grid-cols-[1fr_6rem] items-center gap-2">
                            <span>{tx(`父分配 ${index + 1}`, `Parent allocation ${index + 1}`)} · <span className="font-mono">{allocation.id.slice(-8)}</span> · {tx('未分配', 'Unassigned')} {allocation.unassignedQuantity}</span>
                            <Input
                              aria-label={`${line.partNumber} ${tx('父分配', 'Parent allocation')} ${index + 1}`}
                              className="h-7 bg-white"
                              type="number"
                              min={0}
                              max={allocation.unassignedQuantity}
                              step={1}
                              value={selectedAllocationQuantity}
                              disabled={!can('inventory.manage')}
                              onChange={(event) => {
                                const parsed = Number.parseInt(event.target.value, 10);
                                const selectedAmount = Number.isFinite(parsed) ? Math.min(allocation.unassignedQuantity, Math.max(0, parsed)) : 0;
                                setAllocationSelections((previous) => ({
                                  ...previous,
                                  [line.id]: { ...(previous[line.id] ?? {}), [allocation.id]: selectedAmount },
                                }));
                              }}
                            />
                          </div>;
                        })}
                        {requirement && requirement.required > 0 && <p className="text-amber-700">{can('inventory.manage') ? tx(`本行至少需要选择 ${requirement.required} EA。`, `Select at least ${requirement.required} EA for this line.`) : tx('需要库存管理员明确分配；当前用户无 inventory.manage 权限。', 'An inventory manager must assign the reserved stock; the current user lacks inventory.manage.')}</p>}
                      </div>}
                      {requirement?.missingView && <p className="text-xs text-amber-700">{allocationLoadError || tx('无法确认本行预留是否需要转入，请刷新后再提交。', 'The line reservation state could not be confirmed. Refresh before submitting.')}</p>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-gray-500">
                {quote.customerName} · {quote.partNumber} · {quote.quantity} EA
              </p>
            )}
            <p className="text-lg font-bold text-blue-600 mt-2">
              {tx('确认金额', 'Confirmed Amount')}: ${modernQuote ? formatQuoteMoney(selectedAmount) : quote.totalPrice.toLocaleString()}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('客户采购单号', 'Customer PO Number')}</Label>
              <Input
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                placeholder={tx('可选采购单号', 'Optional PO number')}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('交货日期', 'Delivery Date')}</Label>
              <Input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tx('合同模板', 'Contract Template')}</Label>
            <Select value={templateId} onValueChange={(v) => setTemplateId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tx('选择模板', 'Select template')} />
              </SelectTrigger>
              <SelectContent>
                {templates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name}{template.isDefault ? tx('（默认）', ' (Default)') : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{tx('客户确认备注', 'Customer Confirmation Note')}</Label>
            <Textarea
              value={confirmationNote}
              onChange={(e) => setConfirmationNote(e.target.value)}
              placeholder={tx('记录客户确认报价的方式...', 'Record how the customer confirmed the quotation...')}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button
            className="bg-green-600 hover:bg-green-700"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <FileText className="w-4 h-4 mr-1" />}
            {tx('确认并生成合同', 'Confirm & Generate Contract')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SendQuoteDialog({
  quote,
  isOpen,
  onClose,
}: {
  quote: Quotation | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { send } = useSendQuotation();
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  useEffect(() => {
    if (!quote) return;
    setSubject(`Quotation ${quote.quoteNumber} - ${quote.partNumber}`);
    setMessage([
      `${quote.customerContactName || quote.customerName} 您好，`,
      '',
      `附件为报价单 ${quote.quoteNumber}，请查收。`,
      `件号：${quote.partNumber}`,
      `数量：${quote.quantity}`,
      `总价：USD ${quote.totalPrice.toLocaleString()}`,
      `销售类型：${quote.saleType || 'Sale'}`,
      `贸易术语：${quote.incoterm || '-'} ${quote.incotermLocation || ''}`,
      `交货期：${quote.leadTimeDays || '-'} 天`,
      `含税：${quote.taxIncluded ? '是' : '否'}${quote.taxRate ? ` (税率 ${quote.taxRate}%)` : ''}`,
      `质保：${quote.warrantyDays || 90} 天`,
      '',
      '如需确认报价，请回复或在系统中登记客户确认。',
      '',
      'AeroLink 销售团队',
    ].join('\n'));
  }, [quote]);

  if (!quote) return null;

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const result = await send(quote.id, { subject, message, version: quote.version });
      if (result.emailDeliveryStatus === 'queued') {
        toast.success(`Quote ${quote.quoteNumber} email queued for ${quote.customerEmail || quote.customerName}.`);
      } else {
        toast.success(`Quote ${quote.quoteNumber} sent to ${quote.customerEmail || quote.customerName}.`);
      }
      onClose();
    } catch (error) {
      console.error('Failed to send quote:', error);
      toast.error('Failed to send quote. Please verify the default outbound email account.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="w-5 h-5" />
            {tx('发送报价邮件', 'Send Quote Email')}
          </DialogTitle>
          <DialogDescription className="sr-only">{tx('发送报价邮件给客户', 'Send quote email to customer')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="rounded-lg border bg-gray-50 p-4">
            <p className="font-medium">{quote.customerName}</p>
            <p className="text-sm text-gray-500">{quote.customerEmail || tx('无邮箱记录', 'No email on file')}</p>
            <p className="text-sm text-gray-500 mt-2">{quote.quoteNumber} · {quote.partNumber}</p>
          </div>
          <div className="space-y-2">
            <Label>{tx('邮件主题', 'Email Subject')}</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>{tx('邮件内容', 'Email Message')}</Label>
            {isOpen && <QuotationEmailAssistant key={`${quote.id}-${quote.version}`} quotationId={quote.id} onApply={setMessage} disabled={isSubmitting} />}
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} className="min-h-[220px]" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tx('取消', 'Cancel')}</Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !quote.customerEmail}>
            {isSubmitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
            {tx('发送并附 PDF', 'Send with PDF')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WithdrawQuoteDialog({
  quote,
  isOpen,
  onClose,
  onWithdrawn,
}: {
  quote: Quotation | null;
  isOpen: boolean;
  onClose: () => void;
  onWithdrawn: () => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [sendNotice, setSendNotice] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { withdraw } = useWithdrawQuotation();
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  useEffect(() => {
    setReason('');
    setSendNotice(true);
  }, [quote, isOpen]);

  if (!quote) return null;

  const handleSubmit = async () => {
    if (!reason.trim()) {
      toast.error('Please provide a withdrawal reason.');
      return;
    }

    setIsSubmitting(true);
    try {
      await withdraw(quote.id, {
        reason,
        sendWithdrawalNotice: sendNotice,
        version: quote.version,
      });
      toast.success(`Quote ${quote.quoteNumber} has been withdrawn.`);
      onClose();
      await onWithdrawn();
    } catch (error) {
      console.error('Failed to withdraw quote:', error);
      toast.error('Failed to withdraw quote.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <XCircle className="w-5 h-5" />
            {tx('撤回报价', 'Withdraw Quote')}
          </DialogTitle>
          <DialogDescription className="sr-only">{tx('撤回已发送的报价单', 'Withdraw sent quote')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="rounded-lg border bg-red-50 p-4 text-sm text-red-700">
            {quote.customerName} · {quote.quoteNumber}
          </div>
          <div className="space-y-2">
            <Label>{tx('撤回原因', 'Withdrawal Reason')}</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-[160px]" />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="font-medium">{tx('发送撤回通知', 'Send withdrawal notice')}</p>
              <p className="text-sm text-gray-500">{tx('通知客户忽略此前的报价单。', 'Notify the customer that the previous quotation should be ignored.')}</p>
            </div>
            <Switch checked={sendNotice} onCheckedChange={setSendNotice} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tx('取消', 'Cancel')}</Button>
          <Button variant="destructive" onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <XCircle className="w-4 h-4 mr-2" />}
            {tx('撤回报价', 'Withdraw Quote')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Quotations() {
  const { locale } = useTranslation();
  const can = useCapabilityStore((state) => state.can);
  const canViewCost = can('quotation.view_cost');
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [activeTab, setActiveTab] = useListUrlStringState('status', 'all');
  const [searchQuery, setSearchQuery] = useListUrlStringState('search', '');
  const [currentPage, setCurrentPage] = useListUrlNumberState('page', 1);
  const [sort, setSort] = useListUrlStringState('sort', 'createdAt');
  const [direction, setDirection] = useListUrlStringState('direction', 'desc');
  const pageSize = 10;
  const {
    data: quotations,
    pagination: quotationPagination,
    summary: quotationSummary,
    loading: quotesLoading,
    error: quotesError,
    refetch: refetchQuotes,
  } = useQuotations({
    status: activeTab === 'all' ? undefined : activeTab,
    search: searchQuery,
    page: currentPage,
    limit: pageSize,
    sort,
    direction: direction === 'asc' ? 'asc' : 'desc',
  });
  const { data: contractTemplates } = useDocumentTemplates('ORDER_CONTRACT');
  const { approve: approveQuote } = useApproveQuotation();
  const { submit: submitQuotation, loading: submittingQuotation } = useSubmitQuotation();
  const { mutate: dispatchNotification } = useDispatchNotification();
  const [selectedQuote, setSelectedQuote] = useState<Quotation | null>(null);
  const [isApprovalOpen, setIsApprovalOpen] = useState(false);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isRevisionOpen, setIsRevisionOpen] = useState(false);
  const [isConvertOpen, setIsConvertOpen] = useState(false);
  const [isSendOpen, setIsSendOpen] = useState(false);
  const [isWithdrawOpen, setIsWithdrawOpen] = useState(false);

  const quotesList = quotations || [];
  const availableTemplates = contractTemplates || [];

  const filteredQuotes = quotesList.filter((quote) => {
    const normalizedSearch = searchQuery.toLowerCase();
    const matchesLinePartNumber = quote.lines?.some((line) => line.partNumber.toLowerCase().includes(normalizedSearch)) ?? false;
    if (searchQuery && !quote.quoteNumber.toLowerCase().includes(normalizedSearch) &&
        !quote.partNumber.toLowerCase().includes(normalizedSearch) &&
        !quote.customerName.toLowerCase().includes(normalizedSearch) &&
        !matchesLinePartNumber) {
      return false;
    }
    if (activeTab === 'all') return true;
    return quote.status === activeTab;
  });

  const totalPages = Math.max(1, quotationPagination?.totalPages ?? 1);
  const safePage = Math.min(currentPage, totalPages);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, setCurrentPage, totalPages]);

  const stats = quotationSummary ?? {
    total: quotesList.length,
    pending: quotesList.filter((q) => q.status === 'pending_approval').length,
    approved: quotesList.filter((q) => q.status === 'approved').length,
    sent: quotesList.filter((q) => q.status === 'sent').length,
    accepted: quotesList.filter((q) => q.status === 'accepted').length,
    withdrawn: quotesList.filter((q) => q.status === 'withdrawn').length,
    totalValue: quotesList.filter((q) => q.status === 'accepted').reduce((sum, q) => sum + q.totalPrice, 0),
  };

  const handleViewDetail = (quote: Quotation) => {
    setSelectedQuote(quote);
    setIsDetailOpen(true);
  };

  const handleRevise = (quote: Quotation) => {
    setSelectedQuote(quote);
    setIsRevisionOpen(true);
  };

  const handleOpenRevisionHistory = async (id: string) => {
    try {
      const historyQuote = await quotationApi.getById(id);
      setSelectedQuote(historyQuote);
      setIsDetailOpen(true);
    } catch (error) {
      console.error('Failed to load quotation revision history item:', error);
      toast.error(tx('加载历史报价版本失败。', 'Failed to load the quotation revision.'));
    }
  };

  const handleApprove = async (comment: string, costSource?: { costSourceType: 'SUPPLIER_QUOTE' | 'INVENTORY_DETAIL' | 'MANUAL'; costSourceId?: string; costSourceReason?: string }) => {
    if (!selectedQuote) return;
    const result = await approveQuote(selectedQuote.id, 'approve', selectedQuote.version, comment, costSource);
    if (result) {
      setIsApprovalOpen(false);
      setSelectedQuote(null);
      refetchQuotes();
      toast.success(tx('报价已通过。', 'Quote approved.'));
      // AOG 通知触发
      if (selectedQuote.rfqUrgency === 'aog') {
        void dispatchNotification({
          event: 'AOG_QUOTE_APPROVED',
          payload: {
            quoteNumber: selectedQuote.quoteNumber || '',
            partNumber: selectedQuote.partNumber || '',
            customerName: selectedQuote.customerName || '',
            totalPrice: String(selectedQuote.totalPrice || ''),
          },
        }).catch(() => undefined);
      }
    }
  };

  const handleReject = async (comment: string) => {
    if (!selectedQuote) return;
    const result = await approveQuote(selectedQuote.id, 'reject', selectedQuote.version, comment);
    if (result) {
      setIsApprovalOpen(false);
      setSelectedQuote(null);
      refetchQuotes();
      toast.success(tx('报价已驳回。', 'Quote rejected.'));
    }
  };

  const handleSend = async (quote: Quotation) => {
    setSelectedQuote(quote);
    setIsSendOpen(true);
  };

  const handleSubmitForApproval = async (quote: Quotation) => {
    try {
      await submitQuotation(quote.id, quote.version);
      toast.success(tx('报价已提交审批。', 'Quote submitted for approval.'));
      await refetchQuotes();
    } catch (error) {
      console.error('Failed to submit quote for approval:', error);
      toast.error(tx('提交审批失败，报价仍保留为草稿。', 'Failed to submit for approval; the quote remains a draft.'));
    }
  };

  const handleConvertToOrder = (quote: Quotation) => {
    setSelectedQuote(quote);
    setIsConvertOpen(true);
  };

  const handleWithdraw = (quote: Quotation) => {
    setSelectedQuote(quote);
    setIsWithdrawOpen(true);
  };

  const handleDownloadContract = async (quote: Quotation) => {
    if (!quote.contractDocumentId) {
      toast.info(tx('该报价暂无已生成合同。', 'No generated contract is attached to this quotation yet.'));
      return;
    }

    try {
      const blob = await documentApi.getPdfBlob(quote.contractDocumentId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${quote.quoteNumber}-contract.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download contract:', error);
      toast.error(tx('下载合同失败。', 'Failed to download contract.'));
    }
  };

  const handleDownload = (quote: Quotation) => {
    void (async () => {
      try {
        const blob = await quotationApi.getPdfBlob(quote.id);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${quote.quoteNumber}.pdf`;
        link.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        console.error('Failed to download quotation PDF:', error);
        toast.error(tx('下载报价 PDF 失败。', 'Failed to download quotation PDF.'));
      }
    })();
  };

  const handleExport = async (scope: 'page' | 'filtered') => {
    const blob = await quotationApi.exportCsv({
      status: activeTab === 'all' ? undefined : activeTab,
      search: searchQuery,
      page: currentPage,
      limit: pageSize,
      sort,
      direction: direction === 'asc' ? 'asc' : 'desc',
      scope,
      ...(scope === 'filtered' ? { confirm: 'full' as const, maxRows: 5000 } : {}),
    });
    downloadBlob(blob, `quotations-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  if (quotesLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-primary" />
        <span className="ml-2 text-gray-500">{tx('加载中...', 'Loading...')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3" data-quotation-stat-grid>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('报价总数', 'Total Quotes')}</p>
              <p className="text-xl font-bold">{stats.total}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('待审批', 'Pending Approval')}</p>
              <p className="text-xl font-bold text-yellow-600">{stats.pending}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('已审批', 'Approved')}</p>
              <p className="text-xl font-bold text-green-600">{stats.approved}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('已发送', 'Sent')}</p>
              <p className="text-xl font-bold text-blue-600">{stats.sent}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('已接受', 'Accepted')}</p>
              <p className="text-xl font-bold text-green-600">{stats.accepted}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('成交金额', 'Accepted Value')}</p>
              <p className="text-xl font-bold">${stats.totalValue.toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {quotesError && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div>
              <p className="font-medium">{tx('报价列表刷新失败', 'Failed to refresh quotations')}</p>
              <p className="text-sm text-amber-800">{tx('当前显示的数据可能不是最新，请重试。', 'The list may be stale. Please retry.')}</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => void refetchQuotes()}>
            {tx('重试刷新', 'Retry Refresh')}
          </Button>
        </div>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-4" data-quotation-toolbar>
        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
              placeholder={tx('搜索报价单号、件号或客户...', 'Search quote number, part number, or customer...')}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-10"
            />
          </div>
          <Select value={sort} onValueChange={(value) => { setSort(value); setCurrentPage(1); }}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder={tx('排序字段', 'Sort')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="createdAt">{tx('创建时间', 'Created')}</SelectItem>
              <SelectItem value="expiryDate">{tx('到期日期', 'Expiry')}</SelectItem>
              <SelectItem value="validityDeadline">{tx('有效期截止', 'Validity deadline')}</SelectItem>
              <SelectItem value="totalPrice">{tx('总价', 'Total price')}</SelectItem>
              <SelectItem value="quoteNumber">{tx('报价单号', 'Quote number')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={direction} onValueChange={(value) => { setDirection(value); setCurrentPage(1); }}>
            <SelectTrigger className="w-28">
              <SelectValue placeholder={tx('顺序', 'Order')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">{tx('降序', 'Desc')}</SelectItem>
              <SelectItem value="asc">{tx('升序', 'Asc')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-0 flex-wrap gap-2" data-quotation-actions>
          <Button variant="outline" size="sm" disabled>
            <Filter className="w-4 h-4 mr-1" />
            {tx('筛选', 'Filters')}
          </Button>
          {can('quotation.export') && <ControlledListExportButton locale={locale} onExport={handleExport} />}
          {can('quotation.create') && (
            <Button className="bg-brand-primary hover:bg-brand-primary-hover" onClick={() => setIsCreateOpen(true)}>
              <Plus className="w-4 h-4 mr-1" />
              {tx('创建报价', 'Create Quote')}
            </Button>
          )}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => {
        setActiveTab(value);
        setCurrentPage(1);
      }}>
        <TabsList className="flex h-auto w-full max-w-full flex-wrap justify-start">
          <TabsTrigger value="all">{tx('全部', 'All')}</TabsTrigger>
          <TabsTrigger value="pending_approval">{tx('待审批', 'Pending')}</TabsTrigger>
          <TabsTrigger value="approved">{tx('已审批', 'Approved')}</TabsTrigger>
          <TabsTrigger value="sent">{tx('已发送', 'Sent')}</TabsTrigger>
          <TabsTrigger value="accepted">{tx('已接受', 'Accepted')}</TabsTrigger>
          <TabsTrigger value="withdrawn">{tx('已撤回', 'Withdrawn')}</TabsTrigger>
          <TabsTrigger value="rejected">{tx('已驳回', 'Rejected')}</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('报价单号', 'Quote Number')}</TableHead>
                    <TableHead>{tx('客户', 'Customer')}</TableHead>
                    <TableHead>{tx('件号', 'Part Number')}</TableHead>
                    <TableHead>{tx('销售类型', 'Sale Type')}</TableHead>
                    <TableHead>{tx('贸易术语', 'Incoterm')}</TableHead>
                    <TableHead>{tx('原产国', 'Origin')}</TableHead>
                    <TableHead>{tx('数量', 'Quantity')}</TableHead>
                    <TableHead>{tx('总价', 'Total Price')}</TableHead>
                    {canViewCost && <TableHead>{tx('毛利率', 'Margin')}</TableHead>}
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('有效期', 'Validity')}</TableHead>
                    <TableHead>{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredQuotes.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} className="text-center py-12 text-gray-500">
                        <FileText className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                        <p>{tx('未找到报价单', 'No quotes found')}</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredQuotes.map((quote) => {
                      const isAogRow = quote.rfqUrgency === 'aog';
                      return (
                        <TableRow key={quote.id} className={cn('hover:bg-gray-50', isAogRow && 'bg-red-50/40 border-l-4 border-l-red-500')}>
                          <TableCell className="font-mono font-medium">
                            <div className="flex items-center gap-2">
                              {quote.quoteNumber}
                              {isAogRow && (
                                <Badge variant="outline" className="text-red-600 border-red-300 bg-red-50 text-xs">
                                  AOG
                                </Badge>
                              )}
                              {quote.commercialRevision !== undefined && quote.commercialRevision > 1 && (
                                <Badge variant="outline" className="text-indigo-700 border-indigo-300 bg-indigo-50 text-xs">
                                  R{quote.commercialRevision}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>{quote.customerName}</TableCell>
                          <TableCell className="font-mono">{quote.partNumber}</TableCell>
                          <TableCell>{quote.saleType || tx('销售', 'Sale')}</TableCell>
                          <TableCell>{quote.incoterm || '-'}{quote.incotermLocation ? ` (${quote.incotermLocation})` : ''}</TableCell>
                          <TableCell>{quote.countryOfOrigin || '-'}</TableCell>
                          <TableCell>{quote.quantity}</TableCell>
                          <TableCell className="font-semibold">
                            ${quote.totalPrice.toLocaleString()}
                          </TableCell>
                          {canViewCost && (
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Progress value={quote.margin || 0} className="w-16 h-2" />
                                <span className={cn(
                                  'text-sm',
                                  (quote.margin || 0) >= 20 ? 'text-green-600' : (quote.margin || 0) >= 15 ? 'text-yellow-600' : 'text-red-600'
                                )}>
                                  {(quote.margin || 0).toFixed(1)}%
                                </span>
                              </div>
                            </TableCell>
                          )}
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <QuoteStatusBadge status={quote.status} />
                              {isAogRow && (
                                <Badge variant="outline" className="text-red-600 border-red-300 bg-red-50 text-xs">
                                  AOG
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {new Date(quote.expiryDate).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title={tx('查看报价详情', 'View quote details')}
                                aria-label={tx('查看报价详情', 'View quote details')}
                                onClick={() => handleViewDetail(quote)}
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                              {can('quotation.create') && can('quotation.update')
                                && !quote.supersededAt
                                && quote.status !== 'accepted'
                                && !(quote.lineItemsMode !== true && !!quote.orderId) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  title={tx('修订报价', 'Revise quote')}
                                  aria-label={tx('修订报价', 'Revise quote')}
                                  onClick={() => handleRevise(quote)}
                                >
                                  <Pencil className="w-4 h-4 text-indigo-600" />
                                </Button>
                              )}
                              {!quote.supersededAt && (quote.status === 'draft' || quote.status === 'rejected') && can('quotation.transition') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  title={tx('提交审批', 'Submit for approval')}
                                  aria-label={tx('提交审批', 'Submit for approval')}
                                  disabled={submittingQuotation}
                                  onClick={() => void handleSubmitForApproval(quote)}
                                >
                                  <Send className="w-4 h-4 text-blue-600" />
                                </Button>
                              )}
                              {!quote.supersededAt && (quote.status === 'pending_approval' || (quote.status === 'approved' && quote.requiresReapproval === true)) && can('quotation.approve') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  title={quote.requiresReapproval ? tx('重新审核报价', 'Re-review quote') : tx('审批报价', 'Approve quote')}
                                  aria-label={quote.requiresReapproval ? tx('重新审核报价', 'Re-review quote') : tx('审批报价', 'Approve quote')}
                                  onClick={() => {
                                    setSelectedQuote(quote);
                                    setIsApprovalOpen(true);
                                  }}
                                >
                                  <CheckCircle className="w-4 h-4 text-green-600" />
                                </Button>
                              )}
                              {!quote.supersededAt && quote.status === 'approved' && can('quotation.send') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={tx('发送报价邮件', 'Send Quote Email')}
                                  title={tx('发送报价邮件', 'Send Quote Email')}
                                  onClick={() => handleSend(quote)}
                                >
                                  <Send className="w-4 h-4 text-blue-600" />
                                </Button>
                              )}
                              {!quote.supersededAt && (quote.status === 'sent' || quote.status === 'approved') && can('quotation.accept') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleConvertToOrder(quote)}
                                >
                                  <CheckCircle className="w-4 h-4 text-green-600" />
                                </Button>
                              )}
                              {!quote.supersededAt && quote.status === 'sent' && can('quotation.withdraw') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleWithdraw(quote)}
                                >
                                  <XCircle className="w-4 h-4 text-red-600" />
                                </Button>
                              )}
                              {quote.status === 'accepted' && quote.contractDocumentId && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleDownloadContract(quote)}
                                >
                                  <FileText className="w-4 h-4 text-green-700" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => handleDownload(quote)}
                              >
                                <Download className="w-4 h-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
              {totalPages > 1 && (
                <div className="flex items-center justify-between border-t px-4 py-3">
                  <span className="text-sm text-gray-500">
                    {tx('第', 'Page')} {safePage} / {totalPages} {tx('页', '')}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage <= 1}
                      onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage >= totalPages}
                      onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <QuoteDetailDialog
        quote={selectedQuote}
        isOpen={isDetailOpen}
        onClose={() => {
          setIsDetailOpen(false);
          setSelectedQuote(null);
        }}
        onConfirmCustomer={handleConvertToOrder}
        onWithdraw={handleWithdraw}
        onDownloadContract={handleDownloadContract}
        onRevise={handleRevise}
        onOpenHistory={handleOpenRevisionHistory}
      />

      <ConvertToOrderDialog
        quote={selectedQuote}
        isOpen={isConvertOpen}
        templates={availableTemplates}
        onClose={() => {
          setIsConvertOpen(false);
          setSelectedQuote(null);
        }}
        onConfirmed={async () => {
          await refetchQuotes();
          // AOG 订单确认通知
          if (selectedQuote?.rfqUrgency === 'aog') {
            void dispatchNotification({
              event: 'AOG_ORDER_CONFIRMED',
              payload: {
                quoteNumber: selectedQuote.quoteNumber || '',
                partNumber: selectedQuote.partNumber || '',
                customerName: selectedQuote.customerName || '',
                totalPrice: String(selectedQuote.totalPrice || ''),
              },
            }).catch(() => undefined);
          }
        }}
      />

      <SendQuoteDialog
        quote={selectedQuote}
        isOpen={isSendOpen}
        onClose={() => {
          setIsSendOpen(false);
          setSelectedQuote(null);
        }}
      />

      <WithdrawQuoteDialog
        quote={selectedQuote}
        isOpen={isWithdrawOpen}
        onClose={() => {
          setIsWithdrawOpen(false);
          setSelectedQuote(null);
        }}
        onWithdrawn={async () => {
          await refetchQuotes();
        }}
      />

      <ApprovalDialog
        quote={selectedQuote}
        isOpen={isApprovalOpen}
        onClose={() => {
          setIsApprovalOpen(false);
          setSelectedQuote(null);
        }}
        onApprove={handleApprove}
        onReject={handleReject}
      />

      <CreateQuoteDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={() => {
          void refetchQuotes();
        }}
      />

      <CreateQuoteDialog
        isOpen={isRevisionOpen}
        initialQuote={selectedQuote}
        onClose={() => {
          setIsRevisionOpen(false);
          setSelectedQuote(null);
        }}
        onCreated={(revisedQuote) => {
          setIsRevisionOpen(false);
          void refetchQuotes();
          if (revisedQuote) {
            setSelectedQuote(revisedQuote);
            setIsDetailOpen(true);
          }
        }}
      />
    </div>
  );
}
