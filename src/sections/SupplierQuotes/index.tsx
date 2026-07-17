import { useState, useEffect } from 'react';
import {
  Search,
  CheckCircle,
  Trophy,
  Brain,
  Loader2,
  TrendingUp,
  ChevronLeft,
  ChevronRight,
  Inbox,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { supplierQuoteApi } from '@/api/client';
import { useCapabilityStore } from '@/store';
import { useTranslation } from '@/i18n';
import { toast } from 'sonner';

interface SupplierQuote {
  id: string;
  rfqId: string | null;
  inquiryId: string | null;
  partNumber: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  leadTimeDays: number;
  validUntil: string | null;
  notes: string | null;
  status: string;
  isWinner: boolean;
  aiScore: number | null;
  aiRecommendation: string | null;
  createdAt: string;
  supplier: {
    id: string;
    name: string;
    level: string;
    performanceScore: number;
    contactName: string | null;
    contactEmail: string | null;
  };
}

interface ComparedQuote {
  id: string;
  partNumber: string;
  supplier: {
    id: string;
    name: string;
    level: string;
    performanceScore: number;
  };
  unitPrice: number;
  totalPrice: number;
  quantity: number;
  leadTimeDays: number;
  priceDiff: string;
  isLowestPrice: boolean;
  scores: {
    price: number;
    leadTime: number;
    supplier: number;
    quality: number;
    response: number;
  };
  aiScore: number;
  aiRecommendation: string;
  status: string;
  isWinner: boolean;
}

export function SupplierQuotes() {
  const { locale } = useTranslation();
  const can = useCapabilityStore((state) => state.can);
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [quotes, setQuotes] = useState<SupplierQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [rfqFilter, setRfqFilter] = useState<string>('all');
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const [compareData, setCompareData] = useState<{
    quotes: ComparedQuote[];
    bestMatch: ComparedQuote;
    summary: {
      totalQuotes: number;
      lowestPrice: number;
      highestPrice: number;
      averagePrice: number;
    };
  } | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, rfqFilter]);

  useEffect(() => {
    loadQuotes();
  }, []);

  const loadQuotes = async () => {
    try {
      const data = await supplierQuoteApi.getAll();
      setQuotes(data);
    } catch (error) {
      console.error('Failed to load supplier quotes:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCompare = async (rfqId?: string) => {
    setIsComparing(true);
    try {
      const data = await supplierQuoteApi.compare({ rfqId: rfqId || undefined });
      setCompareData(data);
      setIsCompareOpen(true);
    } catch (error) {
      console.error('Comparison failed:', error);
      toast.error(tx('比价失败，请重试。', 'Comparison failed. Please try again.'));
    } finally {
      setIsComparing(false);
    }
  };

  const handleSelectWinner = async (quoteId: string) => {
    try {
      await supplierQuoteApi.selectWinner(quoteId);
      toast.success(tx('已选择最优供应商。', 'Best supplier selected.'));
      loadQuotes();
      setIsCompareOpen(false);
    } catch (error) {
      console.error('Failed to select supplier:', error);
      toast.error(tx('选择供应商失败。', 'Failed to select supplier.'));
    }
  };

  const filteredQuotes = quotes.filter((quote) => {
    if (searchQuery && !quote.partNumber.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !quote.supplier.name.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (rfqFilter !== 'all' && quote.rfqId !== rfqFilter) {
      return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredQuotes.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedQuotes = filteredQuotes.slice((safePage - 1) * pageSize, safePage * pageSize);

  const stats = {
    total: quotes.length,
    pending: quotes.filter((q) => q.status === 'pending').length,
    compared: quotes.filter((q) => q.aiScore !== null).length,
    winners: quotes.filter((q) => q.isWinner).length,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-primary" />
        <span className="ml-2 text-gray-500">{tx('加载中...', 'Loading...')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('全部报价', 'All Quotes')}</p>
              <p className="text-xl font-bold">{stats.total}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('待处理报价', 'Pending Quotes')}</p>
              <p className="text-xl font-bold text-yellow-600">{stats.pending}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('已比价', 'Compared')}</p>
              <p className="text-xl font-bold text-blue-600">{stats.compared}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('已中选', 'Selected')}</p>
              <p className="text-xl font-bold text-green-600">{stats.winners}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 flex-1">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder={tx('搜索件号或供应商...', 'Search part number or supplier...')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={rfqFilter} onValueChange={setRfqFilter}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tx('全部需求单', 'All RFQs')}</SelectItem>
                  {[...new Set(quotes.filter(q => q.rfqId).map(q => q.rfqId))].map((rfqId) => (
                    <SelectItem key={rfqId} value={rfqId!}>{rfqId}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {can('supplier_quote.update') && (
              <Button
                className="bg-purple-600 hover:bg-purple-700"
                onClick={() => handleCompare()}
                disabled={isComparing || quotes.length === 0}
              >
                {isComparing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Brain className="w-4 h-4 mr-1" />}
                {tx('AI 比价', 'AI Comparison')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx('件号', 'Part Number')}</TableHead>
                <TableHead>{tx('供应商', 'Supplier')}</TableHead>
                <TableHead>{tx('等级', 'Level')}</TableHead>
                <TableHead>{tx('单价', 'Unit Price')}</TableHead>
                <TableHead>{tx('交期', 'Lead Time')}</TableHead>
                <TableHead>{tx('AI评分', 'AI Score')}</TableHead>
                <TableHead>{tx('推荐结论', 'Recommendation')}</TableHead>
                <TableHead>{tx('状态', 'Status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredQuotes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-gray-500">
                    <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    {tx('暂无供应商报价', 'No supplier quotes')}
                  </TableCell>
                </TableRow>
              ) : (
                paginatedQuotes.map((quote) => (
                  <TableRow key={quote.id} className={cn(quote.isWinner && 'bg-green-50')}>
                    <TableCell>
                      <div>
                        <p className="font-mono font-medium">{quote.partNumber}</p>
                        <p className="text-xs text-gray-500">{quote.quantity} {tx('件', 'EA')}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">{quote.supplier.name}</p>
                        <p className="text-xs text-gray-500">{quote.supplier.contactName}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={cn(
                          quote.supplier.level === 'S' && 'bg-purple-100 text-purple-700',
                          quote.supplier.level === 'A' && 'bg-green-100 text-green-700',
                          quote.supplier.level === 'B' && 'bg-yellow-100 text-yellow-700',
                          quote.supplier.level === 'C' && 'bg-red-100 text-red-700'
                        )}
                      >
                        {quote.supplier.level} {tx('级', 'Level')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="font-semibold text-green-600">${quote.unitPrice.toLocaleString()}</span>
                    </TableCell>
                    <TableCell>
                      <span className={cn(quote.leadTimeDays <= 7 ? 'text-green-600' : 'text-yellow-600')}>
                        {quote.leadTimeDays} {tx('天', 'days')}
                      </span>
                    </TableCell>
                    <TableCell>
                      {quote.aiScore !== null ? (
                        <div className="flex items-center gap-2">
                          <Progress value={quote.aiScore} className="w-16 h-2" />
                          <span className="text-sm font-medium">{quote.aiScore.toFixed(0)}</span>
                        </div>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {quote.aiRecommendation ? (
                        <span className={cn(
                          'text-xs',
                          (quote.aiRecommendation.includes('强烈推荐') || quote.aiRecommendation.toLowerCase().includes('strongly recommend')) && 'text-green-600 font-medium',
                          (quote.aiRecommendation.includes('推荐') || quote.aiRecommendation.toLowerCase().includes('recommend')) && 'text-blue-600',
                          (quote.aiRecommendation.includes('考虑') || quote.aiRecommendation.toLowerCase().includes('consider')) && 'text-yellow-600',
                          (quote.aiRecommendation.includes('不推荐') || quote.aiRecommendation.toLowerCase().includes('not recommend')) && 'text-red-600'
                        )}>
                          {quote.aiRecommendation}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {quote.isWinner ? (
                        <Badge className="bg-green-100 text-green-700">
                          <Trophy className="w-3 h-3 mr-1" />
                          {tx('已中选', 'Selected')}
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          {quote.status === 'pending' ? tx('待处理报价', 'Pending Quote') : quote.status}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {filteredQuotes.length > pageSize && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-sm text-gray-500">
                {tx('第', 'Page')} {safePage} / {totalPages} {tx('页', '')}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isCompareOpen} onOpenChange={setIsCompareOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-purple-600" />
              {tx('AI 比价分析', 'AI Comparison Analysis')}
            </DialogTitle>
          </DialogHeader>

          {compareData && (
            <div className="space-y-6 py-4">
              <div className="grid grid-cols-3 gap-4">
                <Card className="bg-blue-50">
                  <CardContent className="p-4 text-center">
                    <p className="text-sm text-gray-500">{tx('最低报价', 'Lowest Price')}</p>
                    <p className="text-2xl font-bold text-blue-600">${compareData.summary.lowestPrice.toLocaleString()}</p>
                  </CardContent>
                </Card>
                <Card className="bg-green-50">
                  <CardContent className="p-4 text-center">
                    <p className="text-sm text-gray-500">{tx('平均报价', 'Average Price')}</p>
                    <p className="text-2xl font-bold text-green-600">${compareData.summary.averagePrice.toLocaleString()}</p>
                  </CardContent>
                </Card>
                <Card className="bg-purple-50">
                  <CardContent className="p-4 text-center">
                    <p className="text-sm text-gray-500">{tx('最优推荐', 'Top Recommendation')}</p>
                    <p className="text-lg font-bold text-purple-600">{compareData.bestMatch.supplier.name}</p>
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-3">
                <h4 className="font-medium flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" />
                  {tx('供应商排名', 'Supplier Ranking')}
                </h4>
                {compareData.quotes.map((quote, index) => (
                  <Card
                    key={quote.id}
                    className={cn(
                      quote.isWinner && 'border-green-500 bg-green-50',
                      index === 0 && !quote.isWinner && 'border-purple-500'
                    )}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className={cn(
                            'w-8 h-8 rounded-full flex items-center justify-center font-bold',
                            index === 0 && 'bg-purple-100 text-purple-700',
                            index === 1 && 'bg-gray-100 text-gray-700',
                            index === 2 && 'bg-yellow-100 text-yellow-700',
                            index > 2 && 'bg-gray-50 text-gray-500'
                          )}>
                            {index + 1}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{quote.supplier.name}</p>
                              {quote.isWinner && <Trophy className="w-4 h-4 text-green-600" />}
                              {quote.isLowestPrice && <Badge variant="outline" className="text-green-600">{tx('最低价', 'Lowest Price')}</Badge>}
                            </div>
                            <div className="flex items-center gap-4 text-sm text-gray-500">
                              <span>{quote.supplier.level} {tx('级供应商', 'Level Supplier')}</span>
                              <span>·</span>
                              <span>${quote.unitPrice} x {quote.quantity}</span>
                              <span>·</span>
                              <span className={cn(quote.leadTimeDays <= 7 ? 'text-green-600' : 'text-yellow-600')}>
                                {quote.leadTimeDays} {tx('天', 'days')}
                              </span>
                              {quote.priceDiff !== '0.0' && (
                                <>
                                  <span>·</span>
                                  <span className="text-red-500">{tx(`较最低价高 ${quote.priceDiff}%`, `${quote.priceDiff}% above lowest price`)}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right">
                            <p className="text-2xl font-bold text-purple-600">{quote.aiScore}</p>
                            <p className="text-xs text-gray-500">{tx('AI综合评分', 'AI Composite Score')}</p>
                          </div>
                          {!quote.isWinner && can('supplier_quote.update') && (
                            <Button
                              size="sm"
                              className="bg-green-600 hover:bg-green-700"
                              onClick={() => handleSelectWinner(quote.id)}
                            >
                              <CheckCircle className="w-4 h-4 mr-1" />
                              {tx('选择该供应商', 'Select this supplier')}
                            </Button>
                          )}
                        </div>
                      </div>

                      <div className="mt-4 grid grid-cols-5 gap-2">
                        <div className="text-center">
                          <p className="text-xs text-gray-500">{tx('价格', 'Price')}</p>
                          <Progress value={quote.scores.price} className="h-1 mt-1" />
                          <p className="text-xs font-medium mt-1">{quote.scores.price}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-gray-500">{tx('交期', 'Lead Time')}</p>
                          <Progress value={quote.scores.leadTime} className="h-1 mt-1" />
                          <p className="text-xs font-medium mt-1">{quote.scores.leadTime}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-gray-500">{tx('供应商', 'Supplier')}</p>
                          <Progress value={quote.scores.supplier} className="h-1 mt-1" />
                          <p className="text-xs font-medium mt-1">{quote.scores.supplier}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-gray-500">{tx('质量', 'Quality')}</p>
                          <Progress value={quote.scores.quality} className="h-1 mt-1" />
                          <p className="text-xs font-medium mt-1">{quote.scores.quality}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-gray-500">{tx('响应', 'Response')}</p>
                          <Progress value={quote.scores.response} className="h-1 mt-1" />
                          <p className="text-xs font-medium mt-1">{quote.scores.response}</p>
                        </div>
                      </div>

                      <div className="mt-3 p-2 bg-gray-50 rounded text-sm">
                        <p className={cn(
                          (quote.aiRecommendation?.includes('强烈推荐') || quote.aiRecommendation?.toLowerCase().includes('strongly recommend')) && 'text-green-600 font-medium',
                          (quote.aiRecommendation?.includes('推荐') || quote.aiRecommendation?.toLowerCase().includes('recommend')) && 'text-blue-600',
                          (quote.aiRecommendation?.includes('考虑') || quote.aiRecommendation?.toLowerCase().includes('consider')) && 'text-yellow-600',
                          (quote.aiRecommendation?.includes('不推荐') || quote.aiRecommendation?.toLowerCase().includes('not recommend')) && 'text-red-600'
                        )}>
                          {quote.aiRecommendation}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCompareOpen(false)}>
              {tx('关闭', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
