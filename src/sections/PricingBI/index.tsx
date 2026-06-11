import { useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  PieChart,
  AlertTriangle,
  Target,
  Lightbulb,
  Search,
  RefreshCw,
  Minus,
  Globe,
  Loader2,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import {
  mockPricingSummary,
  mockMarketIntelligence,
  mockPricingSuggestions,
  mockLostOrderAnalysis,
  mockPricingFactorWeights,
} from '@/data/mockData';

export function PricingBI() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [activeTab, setActiveTab] = useState('pricing');
  const [searchQuery, setSearchQuery] = useState('');

  const summary = mockPricingSummary;
  const marketData = mockMarketIntelligence;
  const suggestions = mockPricingSuggestions;
  const lostOrders = mockLostOrderAnalysis;
  const factorWeights = mockPricingFactorWeights;
  const summaryLoading = false;
  const marketLoading = false;
  const suggestionsLoading = false;
  const lostLoading = false;
  const weightsLoading = false;
  const summaryError = null;
  const marketError = null;
  const suggestionsError = null;
  const lostError = null;
  const weightsError = null;

  const filteredMarketData = marketData?.filter(
    (m) => m.partNumber.toLowerCase().includes(searchQuery.toLowerCase())
  ) ?? [];

  const lostOrderStats = lostOrders ? {
    total: lostOrders.length,
    byReason: {
      price: lostOrders.filter((l) => l.reason === 'price').length,
      delivery: lostOrders.filter((l) => l.reason === 'delivery').length,
      certificate: lostOrders.filter((l) => l.reason === 'certificate').length,
      noDemand: lostOrders.filter((l) => l.reason === 'no_demand').length,
    },
  } : null;

  const formatCurrency = (value: number) => {
    if (locale === 'zh-CN') {
      return `¥${value.toLocaleString()}`;
    }
    return `$${value.toLocaleString()}`;
  };

  const formatTrend = (value: number) => {
    const prefix = value >= 0 ? '+' : '';
    return `${prefix}${value}`;
  };

  const TrendIcon = ({ value }: { value: number }) =>
    value >= 0 ? (
      <TrendingUp className="w-4 h-4" />
    ) : (
      <TrendingDown className="w-4 h-4" />
    );

  const trendColor = (value: number) =>
    value >= 0 ? 'text-green-500' : 'text-red-500';

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="pricing">{tx('动态定价', 'Dynamic Pricing')}</TabsTrigger>
          <TabsTrigger value="market">{tx('市场情报', 'Market Intelligence')}</TabsTrigger>
          <TabsTrigger value="analysis">{tx('成交分析', 'Deal Analysis')}</TabsTrigger>
        </TabsList>

        {/* Dynamic pricing */}
        <TabsContent value="pricing" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {summaryLoading ? (
              <>
                <LoadingCard />
                <LoadingCard />
                <LoadingCard />
                <LoadingCard />
              </>
            ) : summaryError ? (
              <ErrorCard message={summaryError} />
            ) : summary ? (
              <>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('平均毛利率', 'Average Margin')}</p>
                    <p className="text-2xl font-bold">{summary.avgMargin.toFixed(1)}%</p>
                    <p className={`text-sm flex items-center gap-1 ${trendColor(summary.marginTrend)}`}>
                      <TrendIcon value={summary.marginTrend} />
                      {tx('较上月 ', 'vs last month ')}{formatTrend(summary.marginTrend)}%
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('价格竞争力', 'Price Competitiveness')}</p>
                    <p className="text-2xl font-bold">{summary.priceCompetitiveness}/100</p>
                    <p className={`text-sm flex items-center gap-1 ${trendColor(summary.competitivenessTrend)}`}>
                      <TrendIcon value={summary.competitivenessTrend} />
                      {tx('较上月 ', 'vs last month ')}{formatTrend(summary.competitivenessTrend)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('定价建议', 'Pricing Suggestions')}</p>
                    <p className="text-2xl font-bold text-yellow-600">{summary.pendingSuggestions}</p>
                    <p className="text-sm text-gray-500">{tx('待处理', 'Pending')}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('潜在增益', 'Potential Upside')}</p>
                    <p className="text-2xl font-bold text-green-600">{formatCurrency(summary.potentialUpside)}</p>
                    <p className="text-sm text-gray-500">{tx('本月预计', 'Projected this month')}</p>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>

          {/* Pricing suggestions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Lightbulb className="w-5 h-5 text-yellow-500" />
                {tx('AI定价建议', 'AI Pricing Suggestions')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {suggestionsLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : suggestionsError ? (
                <p className="text-sm text-red-500">{suggestionsError}</p>
              ) : suggestions && suggestions.length > 0 ? (
                <div className="space-y-3">
                  {suggestions.map((item) => (
                    <div
                      key={item.id}
                      className="p-4 border rounded-lg flex items-center justify-between"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold">{item.partNumber}</span>
                          <Badge
                            className={cn(
                              item.demandTrend === 'up' && 'bg-green-100 text-green-700',
                              item.demandTrend === 'down' && 'bg-red-100 text-red-700',
                              item.demandTrend === 'stable' && 'bg-gray-100 text-gray-700'
                            )}
                          >
                            {item.demandTrend === 'up' && <TrendingUp className="w-3 h-3 mr-1" />}
                            {item.demandTrend === 'down' && <TrendingDown className="w-3 h-3 mr-1" />}
                            {item.demandTrend === 'stable' && <Minus className="w-3 h-3 mr-1" />}
                            {tx('需求', 'Demand')} {item.demandTrend === 'up' ? tx('上升', 'Rising') : item.demandTrend === 'down' ? tx('下降', 'Falling') : tx('平稳', 'Stable')}
                          </Badge>
                        </div>
                        <p className="text-sm text-gray-500">{item.description}</p>
                        <div className="flex items-center gap-4 mt-2 text-sm">
                          <span className="text-gray-500">
                            {tx('当前', 'Current')}: <span className="font-semibold">{formatCurrency(item.currentPrice)}</span>
                          </span>
                          <span className="text-green-600">
                            {tx('建议', 'Suggested')}: <span className="font-semibold">{formatCurrency(item.suggestedPrice)}</span>
                            {item.priceDiff > 0 && <span className="text-xs ml-1">(+{item.priceDiff.toFixed(1)}%)</span>}
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-gray-500">{tx('库存天数', 'Days of Stock')}</p>
                        <p className={cn(
                          'font-semibold',
                          item.daysOfStock > 60 ? 'text-green-600' : item.daysOfStock > 30 ? 'text-yellow-600' : 'text-red-600'
                        )}>
                          {item.daysOfStock} {tx('天', 'days')}
                        </p>
                        <Button size="sm" className="mt-2 bg-brand-primary hover:bg-brand-primary-hover">
                          {tx('应用建议', 'Apply Suggestion')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500 text-center py-12">
                  {tx('暂无定价建议', 'No pricing suggestions available')}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Pricing factors */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{tx('定价因素权重', 'Pricing Factor Weights')}</CardTitle>
            </CardHeader>
            <CardContent>
              {weightsLoading ? (
                <div className="flex items-center justify-center h-24">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : weightsError ? (
                <p className="text-sm text-red-500">{weightsError}</p>
              ) : factorWeights && factorWeights.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {factorWeights.map((factor) => (
                    <div key={factor.name}>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{factor.name}</span>
                        <span className="font-medium">{factor.weight}%</span>
                      </div>
                      <Progress value={factor.weight} className="h-2" />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500 text-center py-8">
                  {tx('暂无数据', 'No data available')}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Market intelligence */}
        <TabsContent value="market" className="space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder={tx('搜索件号...', 'Search part number...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <Button variant="outline">
              <RefreshCw className="w-4 h-4 mr-1" />
              {tx('刷新', 'Refresh')}
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Globe className="w-5 h-5 text-brand-primary" />
                {tx('市场情报', 'Market Intelligence')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {marketLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : marketError ? (
                <p className="text-sm text-red-500">{marketError}</p>
              ) : marketData && marketData.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tx('件号', 'Part Number')}</TableHead>
                      <TableHead>{tx('市场均价', 'Avg Market Price')}</TableHead>
                      <TableHead>{tx('价格区间', 'Price Range')}</TableHead>
                      <TableHead>{tx('市场需求', 'Market Demand')}</TableHead>
                      <TableHead>{tx('30天询价', '30-Day Inquiries')}</TableHead>
                      <TableHead>{tx('趋势', 'Trend')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(searchQuery ? filteredMarketData : (marketData || [])).map((market) => (
                      <TableRow key={market.partNumber}>
                        <TableCell className="font-mono font-medium">{market.partNumber}</TableCell>
                        <TableCell>{formatCurrency(market.avgMarketPrice)}</TableCell>
                        <TableCell>
                          {formatCurrency(market.priceRange.min)} - {formatCurrency(market.priceRange.max)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={cn(
                              market.marketDemand === 'high' && 'bg-red-100 text-red-700',
                              market.marketDemand === 'medium' && 'bg-yellow-100 text-yellow-700',
                              market.marketDemand === 'low' && 'bg-green-100 text-green-700'
                            )}
                          >
                            {market.marketDemand === 'high' && tx('高', 'High')}
                            {market.marketDemand === 'medium' && tx('中', 'Medium')}
                            {market.marketDemand === 'low' && tx('低', 'Low')}
                          </Badge>
                        </TableCell>
                        <TableCell>{market.inquiryCount30d}</TableCell>
                        <TableCell>
                          {market.demandTrend === 'up' && (
                            <span className="flex items-center gap-1 text-green-600">
                              <TrendingUp className="w-4 h-4" />
                              {tx('上升', 'Rising')}
                            </span>
                          )}
                          {market.demandTrend === 'down' && (
                            <span className="flex items-center gap-1 text-red-600">
                              <TrendingDown className="w-4 h-4" />
                              {tx('下降', 'Falling')}
                            </span>
                          )}
                          {market.demandTrend === 'stable' && (
                            <span className="flex items-center gap-1 text-gray-500">
                              <Minus className="w-4 h-4" />
                              {tx('平稳', 'Stable')}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-gray-500 text-center py-12">
                  {tx('暂无市场情报数据', 'No market intelligence data available')}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Market heat insights */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="bg-red-50 border-red-200">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-red-700">
                  <TrendingUp className="w-5 h-5" />
                  <span className="font-medium">{tx('高需求件号', 'High Demand Part')}</span>
                </div>
                <p className="text-sm text-red-600 mt-2">
                  {tx('件号 2341-123-050 近30天询价量上涨40%，建议备货。', 'PN 2341-123-050 inquiry volume rose 40% in the last 30 days. Stock-up recommended.')}
                </p>
              </CardContent>
            </Card>
            <Card className="bg-yellow-50 border-yellow-200">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-yellow-700">
                  <AlertTriangle className="w-5 h-5" />
                  <span className="font-medium">{tx('价格预警', 'Price Alert')}</span>
                </div>
                <p className="text-sm text-yellow-600 mt-2">
                  {tx('PN 4567-890-001 市场价格下跌15%，建议调整定价。', 'PN 4567-890-001 market price dropped 15%. Pricing adjustment recommended.')}
                </p>
              </CardContent>
            </Card>
            <Card className="bg-green-50 border-green-200">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-green-700">
                  <Target className="w-5 h-5" />
                  <span className="font-medium">{tx('机会', 'Opportunity')}</span>
                </div>
                <p className="text-sm text-green-600 mt-2">
                  {tx('PN 3214-567-100 需求保持稳定，维持库存。', 'PN 3214-567-100 demand remains stable. Maintain inventory.')}
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Deal analysis */}
        <TabsContent value="analysis" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {summaryLoading ? (
              <>
                <LoadingCard />
                <LoadingCard />
                <LoadingCard />
                <LoadingCard />
              </>
            ) : summaryError ? (
              <ErrorCard message={summaryError} />
            ) : summary ? (
              <>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('总报价', 'Total Quotes')}</p>
                    <p className="text-2xl font-bold">{summary.totalQuotes}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('成交', 'Won Deals')}</p>
                    <p className="text-2xl font-bold text-green-600">{summary.wonDeals}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('丢单', 'Lost Deals')}</p>
                    <p className="text-2xl font-bold text-red-600">{summary.lostDeals}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('成交率', 'Win Rate')}</p>
                    <p className="text-2xl font-bold">{summary.winRate.toFixed(1)}%</p>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>

          {/* Lost deal reason analysis */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <PieChart className="w-5 h-5 text-brand-primary" />
                {tx('丢单原因分析', 'Lost Deal Reasons')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {lostLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : lostError ? (
                <p className="text-sm text-red-500">{lostError}</p>
              ) : lostOrderStats && lostOrderStats.total > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{tx('价格', 'Price')}</span>
                        <span className="font-medium">{lostOrderStats.byReason.price} ({Math.round((lostOrderStats.byReason.price / lostOrderStats.total) * 100)}%)</span>
                      </div>
                      <Progress value={(lostOrderStats.byReason.price / lostOrderStats.total) * 100} className="h-3 bg-red-200" />
                    </div>
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{tx('交期', 'Lead Time')}</span>
                        <span className="font-medium">{lostOrderStats.byReason.delivery} ({Math.round((lostOrderStats.byReason.delivery / lostOrderStats.total) * 100)}%)</span>
                      </div>
                      <Progress value={(lostOrderStats.byReason.delivery / lostOrderStats.total) * 100} className="h-3 bg-yellow-200" />
                    </div>
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{tx('证书', 'Certificate')}</span>
                        <span className="font-medium">{lostOrderStats.byReason.certificate} ({Math.round((lostOrderStats.byReason.certificate / lostOrderStats.total) * 100)}%)</span>
                      </div>
                      <Progress value={(lostOrderStats.byReason.certificate / lostOrderStats.total) * 100} className="h-3 bg-blue-200" />
                    </div>
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span>{tx('无需求', 'No Demand')}</span>
                        <span className="font-medium">{lostOrderStats.byReason.noDemand} ({Math.round((lostOrderStats.byReason.noDemand / lostOrderStats.total) * 100)}%)</span>
                      </div>
                      <Progress value={(lostOrderStats.byReason.noDemand / lostOrderStats.total) * 100} className="h-3 bg-gray-200" />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <p className="font-medium">{tx('改进建议', 'Improvement Suggestions')}</p>
                    <div className="p-3 bg-red-50 rounded-lg">
                      <p className="text-sm text-red-700">
                        <span className="font-medium">{tx('价格驱动丢单', 'Price-driven losses')}:</span> {tx('开发二级供应商降低成本，或谈判长期合同价格。', 'Develop tier-2 suppliers to reduce cost, or negotiate long-term contract pricing.')}
                      </p>
                    </div>
                    <div className="p-3 bg-yellow-50 rounded-lg">
                      <p className="text-sm text-yellow-700">
                        <span className="font-medium">{tx('交期驱动丢单', 'Lead-time losses')}:</span> {tx('增加AOG供应商并优化物流路线。', 'Add more AOG suppliers and optimize logistics routes.')}
                      </p>
                    </div>
                    <div className="p-3 bg-blue-50 rounded-lg">
                      <p className="text-sm text-blue-700">
                        <span className="font-medium">{tx('证书驱动丢单', 'Certificate-driven losses')}:</span> {tx('提前准备完整的可追溯性文件。', 'Prepare complete traceability documentation in advance.')}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-500 text-center py-12">
                  {tx('暂无丢单数据', 'No lost order data available')}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Lost deal details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{tx('丢单明细', 'Lost Deal Details')}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {lostLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : lostError ? (
                <p className="text-sm text-red-500">{lostError}</p>
              ) : lostOrders && lostOrders.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tx('件号', 'Part Number')}</TableHead>
                      <TableHead>{tx('客户', 'Customer')}</TableHead>
                      <TableHead>{tx('原因', 'Reason')}</TableHead>
                      <TableHead>{tx('详情', 'Detail')}</TableHead>
                      <TableHead>{tx('日期', 'Date')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lostOrders.map((lost) => (
                      <TableRow key={lost.quotationId}>
                        <TableCell className="font-mono">{lost.partNumber}</TableCell>
                        <TableCell>{lost.customerId}</TableCell>
                        <TableCell>
                          <Badge
                            className={cn(
                              lost.reason === 'price' && 'bg-red-100 text-red-700',
                              lost.reason === 'delivery' && 'bg-yellow-100 text-yellow-700',
                              lost.reason === 'certificate' && 'bg-blue-100 text-blue-700',
                              lost.reason === 'no_demand' && 'bg-gray-100 text-gray-700'
                            )}
                          >
                            {lost.reason === 'price' && tx('价格', 'Price')}
                            {lost.reason === 'delivery' && tx('交期', 'Lead Time')}
                            {lost.reason === 'certificate' && tx('证书', 'Certificate')}
                            {lost.reason === 'no_demand' && tx('无需求', 'No Demand')}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{lost.reasonDetail}</TableCell>
                        <TableCell>
                          {new Date(lost.createdAt).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-gray-500 text-center py-12">
                  {tx('暂无丢单明细', 'No lost deal details available')}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LoadingCard() {
  return (
    <Card>
      <CardContent className="p-4 flex items-center justify-center h-24">
        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
      </CardContent>
    </Card>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="p-4 text-sm text-red-500">{message}</CardContent>
    </Card>
  );
}
