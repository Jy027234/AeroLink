import { BarChart3, CircleOff, Lightbulb, Loader2, PieChart, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/i18n';
import {
  useLostOrders,
  useMarketIntelligence,
  usePricingFactorWeights,
  usePricingSuggestions,
  usePricingSummary,
} from '@/hooks/useApi';
import type { AnalyticsDataAvailability } from '@/api/client';

function MetricValue({ value, suffix = '' }: { value: number | null; suffix?: string }) {
  if (value === null) {
    return <span className="text-2xl font-bold text-muted-foreground">—</span>;
  }

  return <span className="text-2xl font-bold">{value.toLocaleString()}{suffix}</span>;
}

function DataBoundary({
  metadata,
  tx,
}: {
  metadata: AnalyticsDataAvailability;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <Alert className="border-slate-200 bg-slate-50 text-slate-700">
      <ShieldAlert className="w-4 h-4" />
      <AlertDescription className="space-y-1 text-sm">
        <p>{metadata.reason || tx('当前数据可用。', 'Data is currently available.')}</p>
        <p className="text-xs text-muted-foreground">
          {tx('来源', 'Source')}: {metadata.source} · {tx('样本量', 'Sample size')}: {metadata.sampleSize}
          {metadata.algorithmVersion ? ` · ${tx('算法版本', 'Algorithm')}: ${metadata.algorithmVersion}` : ''}
        </p>
        <p className="text-xs text-muted-foreground">{metadata.decisionBoundary}</p>
      </AlertDescription>
    </Alert>
  );
}

function DatasetPanel({
  metadata,
  title,
  tx,
}: {
  metadata?: AnalyticsDataAvailability;
  title: string;
  tx: (zh: string, en: string) => string;
}) {
  if (!metadata) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <CircleOff className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>
      <DataBoundary metadata={metadata} tx={tx} />
    </div>
  );
}

export function PricingBI() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: summary, loading: summaryLoading, error: summaryError } = usePricingSummary();
  const { data: marketData } = useMarketIntelligence();
  const { data: suggestions } = usePricingSuggestions();
  const { data: lostOrders } = useLostOrders();
  const { data: factorWeights } = usePricingFactorWeights();

  if (summaryLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (summaryError || !summary) {
    return (
      <Alert className="border-red-200 bg-red-50 text-red-700">
        <ShieldAlert className="w-4 h-4" />
        <AlertDescription>{summaryError || tx('无法读取定价分析状态。', 'Unable to load pricing analysis status.')}</AlertDescription>
      </Alert>
    );
  }

  if (!summary.feature.enabled) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="h-7 w-7 text-brand-primary" />
            {tx('定价分析（实验功能）', 'Pricing Analysis (Experimental)')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tx('该能力由服务端开关控制，默认不提供市场价格、竞品或预测数据。', 'This capability is server-flagged and does not default to market, competitor, or forecast data.')}
          </p>
        </div>
        <DataBoundary metadata={summary.metadata} tx={tx} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-7 w-7 text-brand-primary" />
          {tx('定价分析（实验功能）', 'Pricing Analysis (Experimental)')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tx('仅展示可追溯的内部交易记录；外部市场、竞品和价格建议在未接入可信数据源前保持为空。', 'Only traceable internal transaction records are shown. Market, competitor, and price recommendations remain empty until a trusted source is connected.')}
        </p>
      </div>

      <DataBoundary metadata={summary.metadata} tx={tx} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{tx('平均毛利率', 'Average Margin')}</p>
            <MetricValue value={summary.avgMargin} suffix="%" />
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.marginTrend === null
                ? tx('上月样本不足，未计算环比', 'Insufficient prior-month sample for trend')
                : `${tx('较上月毛利率变化', 'Margin change vs last month')} ${summary.marginTrend >= 0 ? '+' : ''}${summary.marginTrend}${tx(' 个百分点', ' pp')}`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{tx('报价样本', 'Quotation Sample')}</p>
            <MetricValue value={summary.totalQuotes} />
            <p className="mt-1 text-xs text-muted-foreground">{tx('内部报价记录', 'Internal quotation records')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{tx('已建订单', 'Orders Created')}</p>
            <MetricValue value={summary.wonDeals} />
            <p className="mt-1 text-xs text-muted-foreground">{tx('按已创建订单计', 'Counted from created orders')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{tx('内部成交率', 'Internal Win Rate')}</p>
            <MetricValue value={summary.winRate} suffix="%" />
            <p className="mt-1 text-xs text-muted-foreground">{tx('订单数 ÷ 报价数', 'Orders ÷ quotations')}</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="market">
        <TabsList>
          <TabsTrigger value="market">{tx('市场数据', 'Market Data')}</TabsTrigger>
          <TabsTrigger value="suggestions">{tx('价格建议', 'Price Suggestions')}</TabsTrigger>
          <TabsTrigger value="losses">{tx('丢单归因', 'Loss Attribution')}</TabsTrigger>
          <TabsTrigger value="rules">{tx('模型规则', 'Model Rules')}</TabsTrigger>
        </TabsList>

        <TabsContent value="market" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{tx('市场情报', 'Market Intelligence')}</CardTitle>
            </CardHeader>
            <CardContent>
              <DatasetPanel metadata={marketData?.metadata} title={tx('未展示估算市场价格或需求趋势', 'No estimated market prices or demand trends are shown')} tx={tx} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="suggestions" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Lightbulb className="h-5 w-5 text-amber-500" />
                {tx('价格建议', 'Pricing Suggestions')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DatasetPanel metadata={suggestions?.metadata} title={tx('未生成未经批准的价格建议', 'No unapproved price suggestions are generated')} tx={tx} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="losses" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <PieChart className="h-5 w-5 text-brand-primary" />
                {tx('丢单归因', 'Loss Attribution')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {lostOrders && lostOrders.unclassifiedCount > 0 && (
                <p className="text-sm text-muted-foreground">
                  {tx('存在未归因的丢失/撤回报价：', 'Unattributed lost/withdrawn quotations: ')}{lostOrders.unclassifiedCount}
                </p>
              )}
              <DatasetPanel metadata={lostOrders?.metadata} title={tx('不以推测竞品价格或原因填充丢单分析', 'Loss analysis is not filled with inferred competitor prices or causes')} tx={tx} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{tx('定价模型规则', 'Pricing Model Rules')}</CardTitle>
            </CardHeader>
            <CardContent>
              <DatasetPanel metadata={factorWeights?.metadata} title={tx('未展示未经版本化和批准的因素权重', 'No unversioned or unapproved factor weights are shown')} tx={tx} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
