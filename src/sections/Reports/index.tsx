import { useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Calendar,
  Download,
  Filter,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import { EmptyState } from '@/components/EmptyState';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import {
  useReportSummary,
  useSalesTrend,
  useConversionAnalysis,
  useCustomerContribution,
  useInventoryTurnover,
} from '@/hooks/useApi';
import type { AnalyticsDataAvailability } from '@/api/client';

const COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#6b7280', '#22c55e', '#8b5cf6'];

function TrendIcon({ value }: { value: number | null }) {
  if (value === null) return null;
  return value >= 0 ? (
    <TrendingUp className="w-4 h-4" />
  ) : (
    <TrendingDown className="w-4 h-4" />
  );
}

function getTrendColor(value: number | null) {
  if (value === null) return 'text-gray-500';
  return value >= 0 ? 'text-green-500' : 'text-red-500';
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

function NullableMetric({ value, suffix = '' }: { value: number | null; suffix?: string }) {
  return value === null ? '—' : `${value.toFixed(1)}${suffix}`;
}

function ReportDataBoundary({
  metadata,
  tx,
}: {
  metadata: AnalyticsDataAvailability;
  tx: (zh: string, en: string) => string;
}) {
  return (
    <Alert className="border-slate-200 bg-slate-50 text-slate-700">
      <ShieldAlert className="h-4 w-4" />
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

export function Reports() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [activeTab, setActiveTab] = useState('sales');

  const {
    data: summary,
    loading: summaryLoading,
    error: summaryError,
  } = useReportSummary();

  const {
    data: salesTrend,
    loading: salesLoading,
    error: salesError,
  } = useSalesTrend(6);

  const {
    data: conversion,
    loading: conversionLoading,
    error: conversionError,
  } = useConversionAnalysis();

  const {
    data: customerContribution,
    loading: customerLoading,
    error: customerError,
  } = useCustomerContribution();

  const {
    data: inventoryTurnover,
    loading: inventoryLoading,
    error: inventoryError,
  } = useInventoryTurnover();

  const formatCurrency = (value: number) => {
    if (locale === 'zh-CN') {
      return `¥${(value / 10000).toFixed(1)}${tx('万', '万')}`;
    }
    return `$${(value / 1000).toFixed(0)}K`;
  };

  const formatTrend = (value: number | null) => {
    if (value === null) return tx('上期为零，无法计算', 'No comparable prior-period baseline');
    const prefix = value >= 0 ? '+' : '';
    return `${prefix}${value}%`;
  };

  const turnoverItems = inventoryTurnover?.items.filter((item) => item.days !== null) ?? [];
  const conversionTrend = salesTrend?.flatMap((item) => (
    item.rfqs > 0
      ? [{ ...item, conversionRate: Math.round((item.orders / item.rfqs) * 1000) / 10 }]
      : []
  )) ?? [];

  return (
    <div className="space-y-6">
      {/* Top action bar */}
      <div className="flex justify-end items-center gap-2">
        <Button variant="outline" size="sm">
          <Calendar className="w-4 h-4 mr-1" />
          {tx('选择日期', 'Select Date')}
        </Button>
        <Button variant="outline" size="sm">
          <Filter className="w-4 h-4 mr-1" />
          {tx('筛选', 'Filter')}
        </Button>
        <Button variant="outline" size="sm">
          <Download className="w-4 h-4 mr-1" />
          {tx('导出', 'Export')}
        </Button>
      </div>

      {/* Report tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="sales">{tx('销售分析', 'Sales Analysis')}</TabsTrigger>
          <TabsTrigger value="conversion">{tx('转化分析', 'Conversion Analysis')}</TabsTrigger>
          <TabsTrigger value="customers">{tx('客户分析', 'Customer Analysis')}</TabsTrigger>
          <TabsTrigger value="inventory">{tx('库存分析', 'Inventory Analysis')}</TabsTrigger>
        </TabsList>

        {/* Sales analysis */}
        <TabsContent value="sales" className="space-y-6">
          {summary && <ReportDataBoundary metadata={summary.metadata} tx={tx} />}
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
                    <p className="text-sm text-gray-500">{tx('本月需求单', 'RFQs This Month')}</p>
                    <p className="text-2xl font-bold">{summary.rfqsThisMonth}</p>
                    <p className={`text-sm flex items-center gap-1 ${getTrendColor(summary.rfqTrend)}`}>
                      <TrendIcon value={summary.rfqTrend} />
                      {tx('较上月 ', 'vs last month ')}{formatTrend(summary.rfqTrend)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('本月报价单', 'Quotes This Month')}</p>
                    <p className="text-2xl font-bold">{summary.quotesThisMonth}</p>
                    <p className={`text-sm flex items-center gap-1 ${getTrendColor(summary.quoteTrend)}`}>
                      <TrendIcon value={summary.quoteTrend} />
                      {tx('较上月 ', 'vs last month ')}{formatTrend(summary.quoteTrend)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('本月订单', 'Orders This Month')}</p>
                    <p className="text-2xl font-bold">{summary.ordersThisMonth}</p>
                    <p className={`text-sm flex items-center gap-1 ${getTrendColor(summary.orderTrend)}`}>
                      <TrendIcon value={summary.orderTrend} />
                      {tx('较上月 ', 'vs last month ')}{formatTrend(summary.orderTrend)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('本月营收', 'Revenue This Month')}</p>
                    <p className="text-2xl font-bold">{formatCurrency(summary.revenueThisMonth)}</p>
                    <p className={`text-sm flex items-center gap-1 ${getTrendColor(summary.revenueTrend)}`}>
                      <TrendIcon value={summary.revenueTrend} />
                      {tx('较上月 ', 'vs last month ')}{formatTrend(summary.revenueTrend)}
                    </p>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                {tx('销售趋势（近6个月）', 'Sales Trend (Last 6 Months)')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {salesLoading ? (
                <div className="flex items-center justify-center h-[300px]">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : salesError ? (
                <p className="text-sm text-red-500">{salesError}</p>
              ) : salesTrend && salesTrend.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={salesTrend}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis yAxisId="left" />
                    <YAxis yAxisId="right" orientation="right" />
                    <Tooltip />
                    <Legend />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="rfqs"
                      name={tx('需求单', 'RFQs')}
                      stroke="hsl(var(--brand-primary))"
                      strokeWidth={2}
                    />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="quotes"
                      name={tx('报价单', 'Quotes')}
                      stroke="#22c55e"
                      strokeWidth={2}
                    />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="orders"
                      name={tx('订单', 'Orders')}
                      stroke="#f59e0b"
                      strokeWidth={2}
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="revenue"
                      name={tx('营收', 'Revenue')}
                      stroke="#8b5cf6"
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState
                  title={tx('暂无数据', 'No data available')}
                  description={tx('当前没有可用的数据，请稍后重试', 'No data available at the moment')}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Conversion analysis */}
        <TabsContent value="conversion" className="space-y-6">
          {conversion && <ReportDataBoundary metadata={conversion.metadata} tx={tx} />}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  {tx('丢单原因分析', 'Lost Deal Reasons')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {conversionLoading ? (
                  <div className="flex items-center justify-center h-[300px]">
                    <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                  </div>
                ) : conversionError ? (
                  <p className="text-sm text-red-500">{conversionError}</p>
                ) : conversion && conversion.lostReasons.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={conversion.lostReasons}
                        cx="50%"
                        cy="50%"
                        labelLine={false}
                        label={({ name, percent }) =>
                          `${name} ${(percent * 100).toFixed(0)}%`
                        }
                        outerRadius={100}
                        fill="#8884d8"
                        dataKey="value"
                      >
                        {conversion.lostReasons.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={entry.color || COLORS[index % COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState
                    title={tx('暂无可归因丢单数据', 'No attributable lost-deal data')}
                    description={conversion?.metadata.reason || tx('当前没有可用的数据，请稍后重试', 'No data available at the moment')}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  {tx('转化趋势', 'Conversion Trend')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {salesLoading ? (
                  <div className="flex items-center justify-center h-[300px]">
                    <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                  </div>
                ) : salesError ? (
                  <p className="text-sm text-red-500">{salesError}</p>
                ) : conversionTrend.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={conversionTrend}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" />
                      <YAxis />
                      <Tooltip
                        formatter={(value: number) =>
                          `${(value as number).toFixed(1)}%`
                        }
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="conversionRate"
                        name={tx('转化率', 'Conversion Rate')}
                        stroke="#22c55e"
                        strokeWidth={2}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState
                    title={tx('暂无数据', 'No data available')}
                    description={tx('当前没有可用的数据，请稍后重试', 'No data available at the moment')}
                  />
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{tx('关键指标', 'Key Metrics')}</CardTitle>
            </CardHeader>
            <CardContent>
              {conversionLoading ? (
                <div className="flex items-center justify-center h-24">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : conversionError ? (
                <p className="text-sm text-red-500">{conversionError}</p>
              ) : conversion ? (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="p-4 bg-green-50 rounded-lg text-center">
                    <p className="text-3xl font-bold text-green-600">
                      <NullableMetric value={conversion.overallRate} suffix="%" />
                    </p>
                    <p className="text-sm text-gray-600">
                      {tx('整体转化率', 'Overall Conversion Rate')}
                    </p>
                  </div>
                  <div className="p-4 bg-blue-50 rounded-lg text-center">
                    <p className="text-3xl font-bold text-blue-600">
                      {conversion.avgOrderValue === null
                        ? '—'
                        : locale === 'zh-CN'
                        ? `¥${conversion.avgOrderValue.toLocaleString()}`
                        : `$${conversion.avgOrderValue.toLocaleString()}`}
                    </p>
                    <p className="text-sm text-gray-600">
                      {tx('平均订单金额', 'Average Order Value')}
                    </p>
                  </div>
                  <div className="p-4 bg-yellow-50 rounded-lg text-center">
                    <p className="text-3xl font-bold text-yellow-600">
                      <NullableMetric value={conversion.avgMargin} suffix="%" />
                    </p>
                    <p className="text-sm text-gray-600">
                      {tx('平均利润率', 'Average Margin')}
                    </p>
                  </div>
                  <div className="p-4 bg-purple-50 rounded-lg text-center">
                    <p className="text-3xl font-bold text-purple-600">
                      <NullableMetric value={conversion.avgResponseTime} suffix={tx('天', ' days')} />
                    </p>
                    <p className="text-sm text-gray-600">
                      {tx('平均响应时间', 'Average Response Time')}
                    </p>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Customer analysis */}
        <TabsContent value="customers" className="space-y-6">
          {summary && <ReportDataBoundary metadata={summary.metadata} tx={tx} />}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                {tx('已记录客户年收入', 'Recorded Customer Annual Revenue')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {customerLoading ? (
                <div className="flex items-center justify-center h-[300px]">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : customerError ? (
                <p className="text-sm text-red-500">{customerError}</p>
              ) : customerContribution && customerContribution.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={customerContribution} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" />
                    <YAxis dataKey="name" type="category" width={100} />
                    <Tooltip
                      formatter={(value: number) =>
                        locale === 'zh-CN'
                          ? `¥${value.toLocaleString()}`
                          : `$${value.toLocaleString()}`
                      }
                    />
                    <Bar
                      dataKey="value"
                      name={tx('已记录年收入', 'Recorded Annual Revenue')}
                      fill="hsl(var(--brand-primary))"
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState
                  title={tx('暂无数据', 'No data available')}
                  description={tx('当前没有可用的数据，请稍后重试', 'No data available at the moment')}
                />
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {summaryLoading ? (
              <>
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
                    <p className="text-sm text-gray-500">
                      {tx('活跃客户', 'Active Customers')}
                    </p>
                    <p className="text-2xl font-bold">{summary.activeCustomers}</p>
                    <p className="text-sm text-muted-foreground">
                      {tx('客户留存率', 'Retention')}: {summary.customerRetention === null ? '—' : `${summary.customerRetention}%`}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">
                      {tx('客户留存率', 'Customer Retention')}
                    </p>
                    <p className="text-2xl font-bold">{summary.customerRetention === null ? '—' : `${summary.customerRetention}%`}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">
                      {tx('平均客户价值', 'Average Customer Value')}
                    </p>
                    <p className="text-2xl font-bold">
                      {summary.avgCustomerValue === null ? '—' : formatCurrency(summary.avgCustomerValue)}
                    </p>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>
        </TabsContent>

        {/* Inventory analysis */}
        <TabsContent value="inventory" className="space-y-6">
          {inventoryTurnover && <ReportDataBoundary metadata={inventoryTurnover.metadata} tx={tx} />}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                {tx('库存周转天数', 'Inventory Turnover Days')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {inventoryLoading ? (
                <div className="flex items-center justify-center h-[300px]">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : inventoryError ? (
                <p className="text-sm text-red-500">{inventoryError}</p>
              ) : turnoverItems.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={turnoverItems}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="category" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar
                      dataKey="days"
                      name={tx('当前周转天数', 'Current Turnover Days')}
                      fill="hsl(var(--brand-primary))"
                    />
                    <Bar
                      dataKey="target"
                      name={tx('目标天数', 'Target Days')}
                      fill="#22c55e"
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                  <EmptyState
                    title={tx('暂无可计算的周转天数', 'No computable turnover days')}
                    description={inventoryTurnover?.metadata.reason || tx('当前没有可用的数据，请稍后重试', 'No data available at the moment')}
                />
              )}
            </CardContent>
          </Card>

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
                    <p className="text-sm text-gray-500">
                      {tx('库存总价值', 'Total Inventory Value')}
                    </p>
                    <p className="text-2xl font-bold">
                      {formatCurrency(summary.totalInventoryValue)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">
                      {tx('平均周转天数', 'Average Turnover Days')}
                    </p>
                    <p className="text-2xl font-bold">{summary.avgTurnoverDays === null ? '—' : `${summary.avgTurnoverDays}${tx('天', ' days')}`}</p>
                    <p className="text-sm text-muted-foreground">
                      {tx('未配置经批准的周转目标', 'No approved turnover target configured')}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">
                      {tx('呆滞库存', 'Slow-moving Inventory')}
                    </p>
                    <p className="text-2xl font-bold text-yellow-600">
                      {summary.slowMovingValue === null ? '—' : formatCurrency(summary.slowMovingValue)}
                    </p>
                    <p className="text-sm text-gray-500">
                      {tx('占比', 'Share')}: {summary.slowMovingShare === null ? '—' : `${summary.slowMovingShare.toFixed(1)}%`}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">
                      {tx('库存预警', 'Inventory Alerts')}
                    </p>
                    <p className="text-2xl font-bold text-red-600">
                      {summary.inventoryAlerts}{tx('项', ' items')}
                    </p>
                    <p className="text-sm text-gray-500">
                      {tx('低于安全库存', 'Below safety stock')}
                    </p>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
