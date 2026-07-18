import { useState } from 'react';
import {
  Building2,
  Bell,
  Users,
  Package,
  DollarSign,
  Send,
  Loader2,
  TrendingUp,
  Award,
  ChevronLeft,
  ChevronRight,
  Inbox,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
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
  DialogFooter,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { toast } from 'sonner';
import {
  useSuppliers,
  useSupplierQuotes,
  useCreateSupplierQuote,
  useCompareSupplierQuotes,
  useSelectWinner,
} from '@/hooks/useApi';

interface QuoteFormData {
  unitPrice: number;
  leadTime: number | null;
  validUntil: string;
  notes: string;
  quantity: number;
}

interface SupplierSummary {
  id: string;
  name: string;
  level?: 'S' | 'A' | 'B' | 'C' | string;
  contactName?: string;
  email?: string;
  phone?: string;
  status?: string;
  performanceScore?: number | null;
  leadTime?: number | null;
}

interface SupplierQuoteRecord {
  id: string;
  rfqId: string;
  supplierId?: string;
  partNumber?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  leadTimeDays?: number;
  status?: 'pending' | 'quoted' | 'accepted' | 'rejected' | string;
  supplier?: {
    id?: string;
    name?: string;
    level?: string;
  };
  ruleScore?: number | null;
  scoreComponents?: {
    price?: number | null;
    leadTime?: number | null;
    supplierPerformance?: number | null;
  };
  isLowestPrice?: boolean;
  priceDiff?: number | null;
  rfqNumber?: string;
}

interface QuoteSubmitPayload extends Record<string, unknown> {
  rfqId: string;
  supplierId?: string;
  partNumber?: string;
  description?: string;
  quantity?: number;
  unitPrice: number;
  leadTimeDays: number;
  validUntil: string;
  notes: string;
}

interface CompareResult {
  summary: {
    totalQuotes: number;
    lowestPrice: number | null;
    averagePrice: number | null;
  };
  quotes: SupplierQuoteRecord[];
  topRanked?: SupplierQuoteRecord | null;
  metadata?: {
    status: 'available' | 'insufficient_data' | 'unavailable';
    reason?: string;
    decisionBoundary?: string;
  };
}

function getSupplierStatusPresentation(
  status: string | undefined,
  tx: (zh: string, en: string) => string
) {
  switch (status?.toLowerCase()) {
    case 'active':
      return { label: tx('启用', 'Active'), className: 'bg-green-50 text-green-700 border-green-200' };
    case 'pending':
      return { label: tx('待完善', 'Needs completion'), className: 'bg-amber-50 text-amber-700 border-amber-200' };
    case 'inactive':
      return { label: tx('停用', 'Inactive'), className: 'bg-gray-100 text-gray-700 border-gray-200' };
    case 'blocked':
      return { label: tx('已阻止', 'Blocked'), className: 'bg-red-50 text-red-700 border-red-200' };
    default:
      return { label: tx('未记录', 'Not recorded'), className: 'bg-gray-100 text-gray-600 border-gray-200' };
  }
}

function SubmitQuoteDialog({
  open,
  onClose,
  rfq,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  rfq: SupplierQuoteRecord | null;
  onSubmit: (data: QuoteSubmitPayload) => Promise<void>;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [formData, setFormData] = useState<QuoteFormData>({
    unitPrice: 0,
    leadTime: null,
    validUntil: '',
    notes: '',
    quantity: 0,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!rfq) return null;

  const handleSubmit = async () => {
    if (formData.unitPrice <= 0) {
      toast.error(tx('请输入有效报价。', 'Please enter a valid quote.'));
      return;
    }
    const leadTime = formData.leadTime;
    if (leadTime === null || !Number.isInteger(leadTime) || leadTime < 0) {
      toast.error(tx('请录入有效交期（天）。', 'Please enter a valid lead time in days.'));
      return;
    }
    setIsSubmitting(true);
    try {
      await onSubmit({
        rfqId: rfq.rfqId || rfq.id,
        supplierId: rfq.supplierId,
        partNumber: rfq.partNumber,
        description: rfq.description,
        quantity: rfq.quantity,
        unitPrice: formData.unitPrice,
        leadTimeDays: leadTime,
        validUntil: formData.validUntil,
        notes: formData.notes,
      });
      onClose();
    } catch (err) {
      toast.error(tx('录入失败：', 'Recording failed: ') + (err instanceof Error ? err.message : tx('未知错误', 'Unknown error')));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="w-5 h-5" />
            {tx('录入报价', 'Record Quote')} - {rfq.rfqNumber || rfq.rfqId}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="p-4 bg-gray-50 rounded-lg">
            <p className="font-mono font-semibold">{rfq.partNumber}</p>
            <p className="text-sm text-gray-500">{rfq.description}</p>
            <p className="text-sm mt-1">{tx('需求数量', 'Requested Quantity')}: {rfq.quantity} {tx('件', 'EA')}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('单价 ($) *', 'Unit Price ($) *')}</Label>
              <Input
                type="number"
                min={0}
                value={formData.unitPrice}
                onChange={(e) => setFormData({ ...formData, unitPrice: parseFloat(e.target.value) || 0 })}
                placeholder={tx('输入单价', 'Enter unit price')}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('交期（天）*', 'Lead Time (days) *')}</Label>
              <Input
                type="number"
                min={0}
                value={formData.leadTime ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  setFormData({ ...formData, leadTime: value === '' ? null : Number(value) });
                }}
                placeholder={tx('输入交期天数', 'Delivery days')}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tx('有效期至', 'Valid Until')}</Label>
            <Input
              type="date"
              value={formData.validUntil}
              onChange={(e) => setFormData({ ...formData, validUntil: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label>{tx('备注', 'Notes')}</Label>
            <textarea
              className="w-full p-2 border rounded-md h-20"
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder={tx('补充说明...', 'Additional notes...')}
            />
          </div>

          <div className="p-4 bg-blue-50 rounded-lg">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{tx('报价合计', 'Quote Total')}</span>
              <span className="text-xl font-bold text-blue-600">
                ${(formData.unitPrice * (rfq.quantity ?? 0)).toLocaleString()}
              </span>
            </div>
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
            {isSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
            {tx('保存报价', 'Save Quote')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompareDialog({
  open,
  onClose,
  rfqId,
}: {
  open: boolean;
  onClose: () => void;
  rfqId: string;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { compare, loading } = useCompareSupplierQuotes();
  const { select } = useSelectWinner();
  const [result, setResult] = useState<CompareResult | null>(null);

  const handleCompare = async () => {
    const data = await compare({ rfqId });
    if (data) setResult(data as unknown as CompareResult);
  };

  const handleSelectWinner = async (quoteId: string) => {
    await select(quoteId);
    toast.success(tx('已将该供应商标记为中选。', 'Supplier marked as selected.'));
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5" />
            {tx('供应商报价对比', 'Supplier Quote Comparison')}
          </DialogTitle>
        </DialogHeader>

        {!result && (
          <div className="py-8 text-center">
            <Button onClick={handleCompare} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <TrendingUp className="w-4 h-4 mr-1" />}
              {tx('开始规则比对', 'Start Rule Comparison')}
            </Button>
          </div>
        )}

        {result && (
          <div className="space-y-6 py-4">
            <div className="grid grid-cols-3 gap-4">
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-sm text-gray-500">{tx('报价总数', 'Total Quotes')}</p>
                  <p className="text-2xl font-bold">{result.summary.totalQuotes}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-sm text-gray-500">{tx('最低单价', 'Lowest Unit Price')}</p>
                  <p className="text-2xl font-bold text-green-600">{result.summary.lowestPrice === null ? '—' : `$${result.summary.lowestPrice}`}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-sm text-gray-500">{tx('平均单价', 'Average Unit Price')}</p>
                  <p className="text-2xl font-bold">{result.summary.averagePrice === null ? '—' : `$${result.summary.averagePrice}`}</p>
                </CardContent>
              </Card>
            </div>

            {result.metadata && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-1">
                <p>{result.metadata.reason || tx('未生成规则排序。', 'No rule ranking was generated.')}</p>
                <p className="text-xs">{result.metadata.decisionBoundary || tx('规则比对仅供人工复核，不构成中选建议。', 'Rule comparison is for manual review only and is not a selection recommendation.')}</p>
              </div>
            )}

            <div className="space-y-4">
              {result.quotes?.map((quote: SupplierQuoteRecord) => {
                const isTopRanked = result.topRanked?.id === quote.id;
                return (
                <Card key={quote.id} className={cn(isTopRanked && 'border-green-500 border-2')}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        {isTopRanked && <Award className="w-5 h-5 text-yellow-500" />}
                        <span className="font-semibold">{quote.supplier?.name || '-'}</span>
                        <Badge>{quote.supplier?.level || '-'} {tx('级', 'Level')}</Badge>
                      </div>
                      <span className="text-xl font-bold text-blue-600">${quote.unitPrice}</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <p className="text-gray-500">{tx('交期', 'Lead Time')}</p>
                        <p className="font-medium">{quote.leadTimeDays} {tx('天', 'days')}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">{tx('价差', 'Price Difference')}</p>
                        <p className={cn('font-medium', quote.isLowestPrice ? 'text-green-600' : 'text-red-600')}>
                          {quote.isLowestPrice ? tx('最低价', 'Lowest') : quote.priceDiff === null ? '—' : `+${quote.priceDiff}%`}
                        </p>
                      </div>
                      <div>
                        <p className="text-gray-500">{tx('规则得分', 'Rule Score')}</p>
                        <p className="font-medium">{quote.ruleScore ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">{tx('排序状态', 'Ranking status')}</p>
                        <p className="font-medium text-xs">{isTopRanked ? tx('规则首位，仍需人工复核', 'Top rule rank; manual review required') : tx('未作推荐结论', 'No recommendation generated')}</p>
                      </div>
                    </div>
                    {quote.ruleScore !== null && quote.ruleScore !== undefined ? (
                      <div className="mt-3">
                        <div className="flex justify-between text-xs mb-1">
                          <span>{tx('价格', 'Price')} {quote.scoreComponents?.price ?? '-'}</span>
                          <span>{tx('交期', 'Lead Time')} {quote.scoreComponents?.leadTime ?? '-'}</span>
                          <span>{tx('供应商绩效', 'Supplier performance')} {quote.scoreComponents?.supplierPerformance ?? '-'}</span>
                        </div>
                        <Progress value={quote.ruleScore} className="h-2" />
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-gray-500">{tx('样本不足，未生成规则评分。', 'Insufficient data; no rule score was generated.')}</p>
                    )}
                    {isTopRanked && (
                      <Button
                        size="sm"
                        className="mt-3 bg-green-600 hover:bg-green-700"
                        onClick={() => handleSelectWinner(quote.id)}
                      >
                        <Award className="w-4 h-4 mr-1" />
                        {tx('标记为中选供应商', 'Mark as Selected Supplier')}
                      </Button>
                    )}
                  </CardContent>
                </Card>
                );
              })}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SupplierInformationManagement() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [activeTab, setActiveTab] = useState('overview');
  const [isQuoteDialogOpen, setIsQuoteDialogOpen] = useState(false);
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const [selectedRFQId, setSelectedRFQId] = useState('');
  const [selectedQuote, setSelectedQuote] = useState<SupplierQuoteRecord | null>(null);

  // Pagination state
  const [supplierPage, setSupplierPage] = useState(1);
  const [quotePage, setQuotePage] = useState(1);
  const pageSize = 10;

  const { data: suppliers, loading: suppliersLoading } = useSuppliers({ limit: 100 });
  const { data: quotes, loading: quotesLoading, refetch: refetchQuotes } = useSupplierQuotes();
  const { mutate: createQuote } = useCreateSupplierQuote();

  const suppliersList: SupplierSummary[] = (suppliers as SupplierSummary[] | undefined) || [];
  const quotesList: SupplierQuoteRecord[] = (quotes as SupplierQuoteRecord[] | undefined) || [];

  // Pagination calculations
  const supplierTotalPages = Math.max(1, Math.ceil(suppliersList.length / pageSize));
  const safeSupplierPage = Math.min(supplierPage, supplierTotalPages);
  const paginatedSuppliers = suppliersList.slice((safeSupplierPage - 1) * pageSize, safeSupplierPage * pageSize);

  const quoteTotalPages = Math.max(1, Math.ceil(quotesList.length / pageSize));
  const safeQuotePage = Math.min(quotePage, quoteTotalPages);
  const paginatedQuotes = quotesList.slice((safeQuotePage - 1) * pageSize, safeQuotePage * pageSize);

  const stats = {
    totalSuppliers: suppliersList.length,
    completeContacts: suppliersList.filter((supplier) =>
      Boolean(supplier.contactName?.trim()) && Boolean(supplier.email?.trim() || supplier.phone?.trim())
    ).length,
    totalQuotes: quotesList.length,
    pendingQuotes: quotesList.filter((q: SupplierQuoteRecord) => q.status === 'pending').length,
  };

  const handleSubmitQuote = async (data: QuoteSubmitPayload) => {
    await createQuote(data);
    await refetchQuotes();
  };

  const handleOpenCompare = (rfqId: string) => {
    setSelectedRFQId(rfqId);
    setIsCompareOpen(true);
  };

  return (
    <div className="space-y-6">
      <Card className="border-blue-100 bg-blue-50/50">
        <CardContent className="flex gap-3 p-4">
          <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-brand-primary" />
          <div>
            <p className="font-medium text-gray-900">{tx('内部供应商信息管理', 'Internal Supplier Information Management')}</p>
            <p className="mt-1 text-sm text-gray-600">
              {tx(
                '仅供平台内部人员维护供应商档案、联系人、资质、报价与跟进记录；不会创建供应商账号或发送注册邀请。',
                'For internal teams to maintain supplier profiles, contacts, qualifications, quotes, and follow-up records. It does not create supplier accounts or send registration invitations.'
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{tx('供应商档案', 'Supplier Profiles')}</p>
              <p className="text-2xl font-bold">{stats.totalSuppliers}</p>
            </div>
            <Building2 className="w-8 h-8 text-brand-primary" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{tx('联系人信息完整', 'Complete Contact Details')}</p>
              <p className="text-2xl font-bold">{stats.completeContacts}</p>
            </div>
            <Users className="w-8 h-8 text-green-500" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{tx('报价总数', 'Total Quotes')}</p>
              <p className="text-2xl font-bold">{stats.totalQuotes}</p>
            </div>
            <DollarSign className="w-8 h-8 text-yellow-500" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{tx('待处理报价', 'Pending Quotes')}</p>
              <p className="text-2xl font-bold">{stats.pendingQuotes}</p>
            </div>
            <Package className="w-8 h-8 text-purple-500" />
          </CardContent>
        </Card>
      </div>

      {/* Main content */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview">{tx('供应商档案', 'Supplier Profiles')}</TabsTrigger>
          <TabsTrigger value="quotes">{tx('报价记录', 'Quote Records')}</TabsTrigger>
          <TabsTrigger value="performance">{tx('资料完整度', 'Record Completeness')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{tx('供应商档案', 'Supplier Profiles')}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {suppliersLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tx('供应商', 'Supplier')}</TableHead>
                      <TableHead>{tx('等级', 'Level')}</TableHead>
                      <TableHead>{tx('联系人 / 联系方式', 'Contact / Channel')}</TableHead>
                      <TableHead>{tx('已记录绩效', 'Recorded Performance')}</TableHead>
                      <TableHead>{tx('交期', 'Lead Time')}</TableHead>
                      <TableHead>{tx('状态', 'Status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {suppliersList.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-gray-500">
                    <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                          {tx('暂无供应商数据', 'No supplier data')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      paginatedSuppliers.map((supplier: SupplierSummary) => {
                        const supplierStatus = getSupplierStatusPresentation(supplier.status, tx);
                        return (
                        <TableRow key={supplier.id}>
                          <TableCell className="font-medium">{supplier.name}</TableCell>
                          <TableCell>
                            <Badge
                              className={cn(
                                supplier.level === 'S' && 'bg-purple-100 text-purple-700',
                                supplier.level === 'A' && 'bg-green-100 text-green-700',
                                supplier.level === 'B' && 'bg-yellow-100 text-yellow-700',
                                supplier.level === 'C' && 'bg-red-100 text-red-700'
                              )}
                            >
                              {supplier.level} {tx('级', 'Level')}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <p>{supplier.contactName || tx('未记录', 'Not recorded')}</p>
                            <p className="mt-1 text-xs text-gray-500">
                              {[supplier.email, supplier.phone].filter(Boolean).join(' · ') || tx('未记录', 'Not recorded')}
                            </p>
                          </TableCell>
                          <TableCell>
                            {typeof supplier.performanceScore === 'number' ? (
                              <div className="flex items-center gap-2">
                                <Progress value={supplier.performanceScore} className="w-16 h-2" />
                                <span className="text-sm">{supplier.performanceScore}</span>
                              </div>
                            ) : (
                              <span className="text-sm text-gray-500">{tx('未记录', 'Not recorded')}</span>
                            )}
                          </TableCell>
                          <TableCell>{typeof supplier.leadTime === 'number' ? `${supplier.leadTime} ${tx('天', 'days')}` : tx('未记录', 'Not recorded')}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={supplierStatus.className}>
                              {supplierStatus.label}
                            </Badge>
                          </TableCell>
                        </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              )}
              {suppliersList.length > pageSize && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-sm text-gray-500">
                    {tx('第', 'Page')} {safeSupplierPage} / {supplierTotalPages} {tx('页', '')}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safeSupplierPage <= 1}
                      onClick={() => setSupplierPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safeSupplierPage >= supplierTotalPages}
                      onClick={() => setSupplierPage((p) => Math.min(supplierTotalPages, p + 1))}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="quotes" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-lg">{tx('供应商报价管理', 'Supplier Quote Management')}</CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => refetchQuotes()}>
                  <Bell className="w-4 h-4 mr-1" />
                  {tx('刷新', 'Refresh')}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {quotesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tx('件号', 'Part Number')}</TableHead>
                      <TableHead>{tx('供应商', 'Supplier')}</TableHead>
                      <TableHead>{tx('单价', 'Unit Price')}</TableHead>
                      <TableHead>{tx('交期', 'Lead Time')}</TableHead>
                      <TableHead>{tx('规则得分', 'Rule Score')}</TableHead>
                      <TableHead>{tx('状态', 'Status')}</TableHead>
                      <TableHead>{tx('操作', 'Actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {quotesList.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-8 text-gray-500">
                          {tx('暂无供应商报价', 'No supplier quotes')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      paginatedQuotes.map((quote: SupplierQuoteRecord) => (
                        <TableRow key={quote.id}>
                          <TableCell className="font-mono font-medium">{quote.partNumber}</TableCell>
                          <TableCell>{quote.supplier?.name || '-'}</TableCell>
                          <TableCell className="font-semibold">
                            {typeof quote.unitPrice === 'number' ? `$${quote.unitPrice.toLocaleString()}` : '—'}
                          </TableCell>
                          <TableCell>{typeof quote.leadTimeDays === 'number' ? `${quote.leadTimeDays} ${tx('天', 'days')}` : '—'}</TableCell>
                          <TableCell>
                            {quote.ruleScore !== null && quote.ruleScore !== undefined ? (
                              <div className="flex items-center gap-2">
                                <Progress value={quote.ruleScore} className="w-16 h-2" />
                                <span className="text-sm">{quote.ruleScore}</span>
                              </div>
                            ) : (
                              '-'
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={cn(
                                quote.status === 'pending' && 'bg-yellow-50 text-yellow-700 border-yellow-200',
                                quote.status === 'quoted' && 'bg-blue-50 text-blue-700 border-blue-200',
                                quote.status === 'accepted' && 'bg-green-50 text-green-700 border-green-200',
                                quote.status === 'rejected' && 'bg-red-50 text-red-700 border-red-200'
                              )}
                            >
                              {quote.status === 'pending' && tx('待处理', 'Pending')}
                              {quote.status === 'quoted' && tx('已报价', 'Quoted')}
                              {quote.status === 'accepted' && tx('已接受', 'Accepted')}
                              {quote.status === 'rejected' && tx('已拒绝', 'Rejected')}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-2">
                              {quote.status === 'pending' && (
                                <Button
                                  size="sm"
                                  className="bg-brand-primary hover:bg-brand-primary-hover"
                                  onClick={() => {
                                    setSelectedQuote(quote);
                                    setIsQuoteDialogOpen(true);
                                  }}
                                >
                                  <DollarSign className="w-4 h-4 mr-1" />
                                  {tx('录入报价', 'Record Quote')}
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleOpenCompare(quote.rfqId)}
                              >
                                <TrendingUp className="w-4 h-4 mr-1" />
                                {tx('比价', 'Compare')}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
              {quotesList.length > pageSize && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-sm text-gray-500">
                    {tx('第', 'Page')} {safeQuotePage} / {quoteTotalPages} {tx('页', '')}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safeQuotePage <= 1}
                      onClick={() => setQuotePage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safeQuotePage >= quoteTotalPages}
                      onClick={() => setQuotePage((p) => Math.min(quoteTotalPages, p + 1))}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="performance">
          <p className="mb-4 text-sm text-gray-500">{tx('仅展示供应商主数据中已录入的绩效、交期和等级；不会填充缺失记录或推算综合评分。', 'Only recorded supplier performance, lead time, and level are shown. Missing records and composite scores are not inferred.')}</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tx('已记录绩效', 'Recorded Performance')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {suppliersList.map((supplier: SupplierSummary) => (
                    <div key={supplier.id}>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{supplier.name}</span>
                        <span className="font-medium">{typeof supplier.performanceScore === 'number' ? `${supplier.performanceScore}/100` : tx('未记录', 'Not recorded')}</span>
                      </div>
                      {typeof supplier.performanceScore === 'number' && <Progress value={supplier.performanceScore} className="h-2" />}
                    </div>
                  ))}
                  {suppliersList.length === 0 && (
                    <p className="text-center text-gray-500 py-4">{tx('暂无数据', 'No data')}</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tx('已录入交期', 'Recorded Lead Time')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {suppliersList.map((supplier: SupplierSummary) => (
                    <div key={supplier.id} className="flex justify-between text-sm">
                      <span>{supplier.name}</span>
                      <span className="font-medium">{typeof supplier.leadTime === 'number' ? `${supplier.leadTime} ${tx('天', 'days')}` : tx('未记录', 'Not recorded')}</span>
                    </div>
                  ))}
                  {suppliersList.length === 0 && (
                    <p className="text-center text-gray-500 py-4">{tx('暂无数据', 'No data')}</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tx('供应商等级', 'Supplier Level')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {suppliersList.map((supplier: SupplierSummary) => (
                    <div key={supplier.id} className="flex justify-between text-sm">
                      <span>{supplier.name}</span>
                      <span className="font-medium">{supplier.level ? `${supplier.level} ${tx('级', 'Level')}` : tx('未记录', 'Not recorded')}</span>
                    </div>
                  ))}
                  {suppliersList.length === 0 && (
                    <p className="text-center text-gray-500 py-4">{tx('暂无数据', 'No data')}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <SubmitQuoteDialog
        open={isQuoteDialogOpen}
        onClose={() => {
          setIsQuoteDialogOpen(false);
          setSelectedQuote(null);
        }}
        rfq={selectedQuote}
        onSubmit={handleSubmitQuote}
      />

      <CompareDialog
        open={isCompareOpen}
        onClose={() => {
          setIsCompareOpen(false);
          setSelectedRFQId('');
        }}
        rfqId={selectedRFQId}
      />
    </div>
  );
}
