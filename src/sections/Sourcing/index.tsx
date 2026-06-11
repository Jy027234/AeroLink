import { useState, useMemo } from 'react';
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
import { useTranslation } from '@/i18n';
import { toast } from 'sonner';
import {
  useRFQs,
  useSuppliers,
  useInventoryItems,
  useCreateInquiry,
} from '@/hooks/useApi';
import type { RFQ, Supplier, InventoryItem } from '@/types';

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
  const isAlternative = rfq && item.partNumber.includes(rfq.partNumber.replace(/-/g, '').slice(0, 8));
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
                  {tx('可替代', 'Interchangeable')}
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
            <p className="font-semibold">${firstDetail?.unitCost?.toLocaleString() || '-'}</p>
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

  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  const [selectedRFQs, setSelectedRFQs] = useState<string[]>([]);
  const [isInquiryDialogOpen, setIsInquiryDialogOpen] = useState(false);
  const [inquiryNote, setInquiryNote] = useState('');
  const [isAOG, setIsAOG] = useState(false);

  // Filter / sort state
  const [rfqSearch, setRfqSearch] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState<'all' | 'aog' | 'urgent' | 'standard'>('all');
  const [sortBy, setSortBy] = useState<'requiredDate' | 'urgency' | 'createdAt'>('requiredDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [currentPage, setCurrentPage] = useState(1);
  const [supplierSearch, setSupplierSearch] = useState('');
  const pageSize = 10;

  // Pending RFQs
  const pendingRFQs = rfqs?.filter((r) => r.status === 'pending' || r.status === 'sourcing') ?? [];

  // Filtered + sorted RFQs
  const filteredRFQs = useMemo(() => {
    let result = pendingRFQs;

    // Search
    if (rfqSearch.trim()) {
      const q = rfqSearch.toLowerCase();
      result = result.filter((r) =>
        r.rfqNumber.toLowerCase().includes(q) ||
        r.partNumber.toLowerCase().includes(q) ||
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
  const selectedRFQ = selectedRFQs.length > 0
    ? pendingRFQs.find((r) => r.id === selectedRFQs[0]) ?? null
    : null;

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

  const toggleRFQ = (rfqId: string) => {
    setSelectedRFQs((prev) =>
      prev.includes(rfqId)
        ? prev.filter((id) => id !== rfqId)
        : [rfqId] // single-select for now, can extend to multi
    );
  };

  const toggleSupplier = (supplierId: string) => {
    setSelectedSuppliers((prev) =>
      prev.includes(supplierId)
        ? prev.filter((id) => id !== supplierId)
        : [...prev, supplierId]
    );
  };

  const handleCreateInquiry = async () => {
    if (selectedSuppliers.length === 0 || !selectedRFQ) return;

    const result = await createInquiry({
      rfqId: selectedRFQ.id,
      supplierIds: selectedSuppliers,
      isAOG: isAOG || selectedRFQ.urgency === 'aog',
      notes: inquiryNote || undefined,
    });

    if (result) {
      setIsInquiryDialogOpen(false);
      setSelectedSuppliers([]);
      setInquiryNote('');
      setIsAOG(false);
      toast.success(tx(`询价已发送给 ${selectedSuppliers.length} 家供应商。`, `Inquiry has been sent to ${selectedSuppliers.length} suppliers.`));
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
                      item.partNumber.includes(selectedRFQ.partNumber.replace(/-/g, '').slice(0, 8))
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
                  className="bg-brand-primary hover:bg-brand-primary-hover"
                >
                  <Send className="w-4 h-4 mr-1" />
                  {tx('发送询价', 'Send Inquiry')}
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
            <DialogTitle>{tx('确认发送询价', 'Confirm Sending Inquiry')}</DialogTitle>
            <DialogDescription className="sr-only">{tx('确认发送询价给已选供应商', 'Confirm sending inquiry to selected suppliers')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="bg-gray-50 p-4 rounded-lg">
              <p className="font-medium">{tx('需求信息', 'RFQ Information')}</p>
              <div className="mt-2 space-y-1 text-sm">
                <p><span className="text-gray-500">{tx('件号', 'Part number')}:</span> {selectedRFQ?.partNumber}</p>
                <p><span className="text-gray-500">{tx('数量', 'Quantity')}:</span> {selectedRFQ?.quantity} {tx('件', 'EA')}</p>
                <p><span className="text-gray-500">{tx('需求日期', 'Required date')}:</span> {selectedRFQ?.requiredDate}</p>
              </div>
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
              {tx('确认发送', 'Confirm Send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
