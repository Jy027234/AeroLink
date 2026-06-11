import { useEffect, useState } from 'react';
import { toast } from 'sonner';
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
import { useQuotations, useApproveQuotation, quotationApi, useDocumentTemplates, useRFQs, useDispatchNotification } from '@/hooks/useApi';
import { documentApi } from '@/api/client';
import { PriceRecommendationPanel } from '@/components/PriceRecommendationPanel';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { DocumentTemplate, Quotation, QuoteStatus, SaleType, Incoterm } from '@/types';

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
}: {
  quote: Quotation | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmCustomer: (quote: Quotation) => void;
  onWithdraw: (quote: Quotation) => void;
  onDownloadContract: (quote: Quotation) => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [detailQuote, setDetailQuote] = useState<Quotation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailLoadFailed, setDetailLoadFailed] = useState(false);
  const [detailRequestVersion, setDetailRequestVersion] = useState(0);

  useEffect(() => {
    if (!quote || !isOpen) {
      return;
    }

    let cancelled = false;

    const loadQuoteDetails = async () => {
      setDetailLoading(true);
      setDetailLoadFailed(false);

      try {
        const result = await quotationApi.getById(quote.id);
        if (!cancelled) {
          setDetailQuote(result);
        }
      } catch {
        if (!cancelled) {
          setDetailQuote(quote);
          setDetailLoadFailed(true);
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
        }
      }
    };

    void loadQuoteDetails();

    return () => {
      cancelled = true;
    };
  }, [isOpen, quote, detailRequestVersion]);

  if (!quote) return null;

  const activeQuote = detailQuote?.id === quote.id ? detailQuote : quote;

  const handleDialogOpenChange = (open: boolean) => {
    if (!open) {
      setDetailQuote(null);
      setDetailLoading(false);
      setDetailLoadFailed(false);
      onClose();
    }
  };

  const canConfirmCustomer = activeQuote.status === 'sent' || activeQuote.status === 'approved';
  const canWithdraw = activeQuote.status === 'sent';
  const canDownloadContract = activeQuote.status === 'accepted' && !!activeQuote.contractDocumentId;

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
              <Button variant="outline" onClick={() => setDetailRequestVersion((version) => version + 1)}>
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
            </div>
            <QuoteStatusBadge status={activeQuote.status} />
          </div>

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

          <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
            <div className="flex justify-between">
              <span className="text-sm text-gray-500">{tx('成本价', 'Cost Price')}</span>
              <span className="font-mono">${(activeQuote.costPrice * activeQuote.quantity).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-gray-500">{tx('利润率', 'Margin')}</span>
              <span className={cn(
                'font-semibold',
                activeQuote.margin >= 20 ? 'text-green-600' : activeQuote.margin >= 15 ? 'text-yellow-600' : 'text-red-600'
              )}>
                {activeQuote.margin.toFixed(1)}%
              </span>
            </div>
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
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: rfqs } = useRFQs();
  const [formData, setFormData] = useState({
    rfqId: '',
    customerId: '',
    customerName: '',
    partNumber: '',
    quantity: 1,
    unitPrice: 0,
    costPrice: 0,
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
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedRfq = rfqs?.find((r) => r.id === formData.rfqId);
  const isAog = selectedRfq?.urgency === 'aog';

  const totalPrice = formData.quantity * formData.unitPrice;

  const handleRfqChange = (rfqId: string) => {
    const rfq = rfqs?.find((r) => r.id === rfqId);
    if (rfq) {
      setFormData((prev) => ({
        ...prev,
        rfqId,
        customerId: rfq.customerId || prev.customerId,
        customerName: rfq.customerName || prev.customerName,
        partNumber: rfq.partNumber || prev.partNumber,
        quantity: rfq.quantity || prev.quantity,
        validityDays: rfq.urgency === 'aog' ? 1 : prev.validityDays,
      }));
    } else {
      setFormData((prev) => ({ ...prev, rfqId }));
    }
  };

  const handleSubmit = async () => {
    if (!formData.rfqId || !formData.customerName || !formData.partNumber || formData.quantity <= 0 || formData.unitPrice <= 0) {
      toast.error(tx('请填写所有必填字段（RFQ、客户、件号、数量、单价）。', 'Please fill in all required fields (RFQ, Customer, Part Number, Quantity, Unit Price).'));
      return;
    }
    setIsSubmitting(true);
    try {
      await quotationApi.create({
        rfqId: formData.rfqId,
        customerId: formData.customerId || 'c001',
        customerName: formData.customerName,
        partNumber: formData.partNumber,
        description: `Part ${formData.partNumber}`,
        quantity: formData.quantity,
        unitPrice: formData.unitPrice,
        costPrice: formData.costPrice,
        totalPrice,
        margin: formData.costPrice > 0 ? ((formData.unitPrice - formData.costPrice) / formData.unitPrice) * 100 : 0,
        status: 'draft',
        validityDays: formData.validityDays,
        saleType: formData.saleType,
        incoterm: formData.incoterm || undefined,
        incotermLocation: formData.incotermLocation || undefined,
        leadTimeDays: formData.leadTimeDays || undefined,
        leadTimeBasis: formData.leadTimeBasis || undefined,
        moq: formData.moq || undefined,
        mpq: formData.mpq || undefined,
        priceBasis: formData.priceBasis || undefined,
        taxIncluded: formData.taxIncluded,
        taxRate: formData.taxRate || undefined,
        warrantyDays: formData.warrantyDays,
        warrantyTerms: formData.warrantyTerms || undefined,
        packagingRequirement: formData.packagingRequirement || undefined,
        shippingMethod: formData.shippingMethod || undefined,
        countryOfOrigin: formData.countryOfOrigin || undefined,
        hsCode: formData.hsCode || undefined,
        eccn: formData.eccn || undefined,
        dualUse: formData.dualUse,
        ccRecipients: formData.ccRecipients ? formData.ccRecipients.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
        commonNote: formData.commonNote || undefined,
      });
      toast.success(tx('报价单创建成功。', 'Quote created successfully.'));
      onClose();
      onCreated();
    } catch (error) {
      console.error('Failed to create quote:', error);
      toast.error(tx('创建报价单失败。', 'Failed to create quote.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="w-5 h-5" />
            {tx('创建报价单', 'Create Quote')}
          </DialogTitle>
          <DialogDescription className="sr-only">{tx('创建新的报价单', 'Create a new quote')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>{tx('关联 RFQ *', 'Associated RFQ *')}</Label>
            <Select value={formData.rfqId} onValueChange={handleRfqChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tx('请选择 RFQ', 'Select RFQ...')} />
              </SelectTrigger>
              <SelectContent>
                {rfqs?.map((rfq) => (
                  <SelectItem key={rfq.id} value={rfq.id}>
                    {rfq.rfqNumber} · {rfq.partNumber} · {rfq.customerName} {rfq.urgency === 'aog' ? '(AOG)' : ''}
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
                <p>{tx('有效期自动设为 1 天，并行审批 manager + gm', 'Validity auto-set to 1 day, parallel approval by manager + gm')}</p>
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
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('件号 *', 'Part Number *')}</Label>
              <Input
                value={formData.partNumber}
                onChange={(e) => setFormData({ ...formData, partNumber: e.target.value })}
                placeholder={tx('输入件号', 'Enter part number')}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>{tx('数量 *', 'Quantity *')}</Label>
              <Input
                type="number"
                min={1}
                value={formData.quantity}
                onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) || 0 })}
              />
            </div>
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
                value={formData.costPrice}
                onChange={(e) => setFormData({ ...formData, costPrice: parseFloat(e.target.value) || 0 })}
              />
            </div>
          </div>

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

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('有效期（天）', 'Validity (days)')}</Label>
              <Input
                type="number"
                min={1}
                value={formData.validityDays}
                onChange={(e) => setFormData({ ...formData, validityDays: parseInt(e.target.value) || 30 })}
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
                  <SelectItem value="Exchange">{tx('交换', 'Exchange')}</SelectItem>
                  <SelectItem value="Loan">{tx('借贷', 'Loan')}</SelectItem>
                  <SelectItem value="Consign">{tx('寄售', 'Consign')}</SelectItem>
                  <SelectItem value="Repair">{tx('维修', 'Repair')}</SelectItem>
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
              <span className="text-gray-600">{tx('报价合计', 'Quote Total')}</span>
              <span className="text-2xl font-bold text-blue-600">${totalPrice.toLocaleString()}</span>
            </div>
            {formData.costPrice > 0 && (
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
            {isSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
            {tx('创建报价单', 'Create Quote')}
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
  onApprove: (comment: string) => void;
  onReject: (comment: string) => void;
}) {
  const [comment, setComment] = useState('');
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  if (!quote) return null;

  const isAog = quote.rfqUrgency === 'aog';

  const getApprovalLevel = () => {
    if (isAog) return { level: tx('AOG 快速审批（manager / gm 任一通过）', 'AOG Fast Track (manager or gm)'), color: 'text-red-600' };
    if (quote.totalPrice > 50000) return { level: tx('总经理', 'General Manager'), color: 'text-red-600' };
    if (quote.totalPrice > 5000) return { level: tx('财务+经理', 'Finance + Manager'), color: 'text-yellow-600' };
    return { level: tx('销售经理', 'Sales Manager'), color: 'text-green-600' };
  };

  const approvalLevel = getApprovalLevel();

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{tx('审批报价单', 'Approve Quote')}</DialogTitle>
          <DialogDescription className="sr-only">{tx('审批报价单意见', 'Approve or reject quote')}</DialogDescription>
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
            onClick={() => {
              onApprove(comment);
              setComment('');
            }}
          >
            <CheckCircle className="w-4 h-4 mr-1" />
            {tx('通过', 'Approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConvertToOrderDialog({
  quote,
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  useEffect(() => {
    setTemplateId(defaultTemplateId);
  }, [defaultTemplateId]);

  if (!quote) return null;

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const result = await quotationApi.accept(quote.id, {
        poNumber,
        deliveryDate,
        templateId: templateId || undefined,
        confirmationNote: confirmationNote || undefined,
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
            <p className="text-sm text-gray-500">
              {quote.customerName} · {quote.partNumber} · {quote.quantity} EA
            </p>
            <p className="text-lg font-bold text-blue-600 mt-2">
              {tx('确认金额', 'Confirmed Amount')}: ${quote.totalPrice.toLocaleString()}
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
  onSent,
}: {
  quote: Quotation | null;
  isOpen: boolean;
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
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
      await quotationApi.send(quote.id, { subject, message });
      toast.success(`Quote ${quote.quoteNumber} sent to ${quote.customerEmail || quote.customerName}.`);
      onClose();
      await onSent();
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
      await quotationApi.withdraw(quote.id, {
        reason,
        sendWithdrawalNotice: sendNotice,
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
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: quotations, loading: quotesLoading, error: quotesError, refetch: refetchQuotes } = useQuotations();
  const { data: contractTemplates } = useDocumentTemplates('ORDER_CONTRACT');
  const { approve: approveQuote } = useApproveQuotation();
  const { mutate: dispatchNotification } = useDispatchNotification();
  const [activeTab, setActiveTab] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedQuote, setSelectedQuote] = useState<Quotation | null>(null);
  const [isApprovalOpen, setIsApprovalOpen] = useState(false);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isConvertOpen, setIsConvertOpen] = useState(false);
  const [isSendOpen, setIsSendOpen] = useState(false);
  const [isWithdrawOpen, setIsWithdrawOpen] = useState(false);

  const quotesList = quotations || [];
  const availableTemplates = contractTemplates || [];

  const filteredQuotes = quotesList.filter((quote) => {
    if (searchQuery && !quote.quoteNumber.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !quote.partNumber.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !quote.customerName.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (activeTab === 'all') return true;
    return quote.status === activeTab;
  }).sort((a, b) => {
    // AOG quotations pinned to top
    const aAog = a.rfqUrgency === 'aog' ? 1 : 0;
    const bAog = b.rfqUrgency === 'aog' ? 1 : 0;
    if (aAog !== bAog) return bAog - aAog;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const stats = {
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

  const handleApprove = async (comment: string) => {
    void comment;
    if (!selectedQuote) return;
    const result = await approveQuote(selectedQuote.id, 'approve');
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
        });
      }
    }
  };

  const handleReject = async (comment: string) => {
    void comment;
    if (!selectedQuote) return;
    const result = await approveQuote(selectedQuote.id, 'reject');
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
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
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

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[300px] flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder={tx('搜索报价单号、件号或客户...', 'Search quote number, part number, or customer...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled>
            <Filter className="w-4 h-4 mr-1" />
            {tx('筛选', 'Filters')}
          </Button>
          <Button className="bg-brand-primary hover:bg-brand-primary-hover" onClick={() => setIsCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" />
            {tx('创建报价', 'Create Quote')}
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
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
                    <TableHead>{tx('毛利率', 'Margin')}</TableHead>
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
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Progress
                                value={quote.margin}
                                className="w-16 h-2"
                              />
                              <span className={cn(
                                'text-sm',
                                quote.margin >= 20 ? 'text-green-600' : quote.margin >= 15 ? 'text-yellow-600' : 'text-red-600'
                              )}>
                                {quote.margin.toFixed(1)}%
                              </span>
                            </div>
                          </TableCell>
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
                                onClick={() => handleViewDetail(quote)}
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                              {quote.status === 'pending_approval' && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => {
                                    setSelectedQuote(quote);
                                    setIsApprovalOpen(true);
                                  }}
                                >
                                  <CheckCircle className="w-4 h-4 text-green-600" />
                                </Button>
                              )}
                              {quote.status === 'approved' && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleSend(quote)}
                                >
                                  <Send className="w-4 h-4 text-blue-600" />
                                </Button>
                              )}
                              {(quote.status === 'sent' || quote.status === 'approved') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleConvertToOrder(quote)}
                                >
                                  <CheckCircle className="w-4 h-4 text-green-600" />
                                </Button>
                              )}
                              {quote.status === 'sent' && (
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
            });
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
        onSent={async () => {
          await refetchQuotes();
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
    </div>
  );
}
