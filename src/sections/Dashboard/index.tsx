import { useEffect, useMemo, useState } from 'react';
import {
  Inbox,
  FileText,
  CheckCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  Users,
  ArrowRight,
  Loader2,
  Clock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useDashboardStore, useUIStore } from '@/store';
import { useDashboardStats, useSalesFunnel, useInventory } from '@/hooks/useApi';
import { InventoryHealthCard } from '@/components/InventoryHealthCard';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

interface StatCardProps {
  title: string;
  value: number;
  trend: number;
  icon: React.ElementType;
  suffix?: string;
  prefix?: string;
}

function StatCard({ title, value, trend, icon: Icon, suffix = '', prefix = '' }: StatCardProps) {
  const [displayValue, setDisplayValue] = useState(0);
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  useEffect(() => {
    // 数字计数动画
    const duration = 1000;
    const steps = 30;
    const increment = value / steps;
    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= value) {
        setDisplayValue(value);
        clearInterval(timer);
      } else {
        setDisplayValue(Math.floor(current));
      }
    }, duration / steps);

    return () => clearInterval(timer);
  }, [value]);

  return (
    <Card className="hover:shadow-sm transition-all duration-200">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-500 mb-0.5">{title}</p>
            <p className="text-xl font-bold text-gray-900">
              {prefix}
              {displayValue.toLocaleString()}
              {suffix}
            </p>
            <div className="flex items-center gap-1 mt-1">
              {trend > 0 ? (
                <>
                  <TrendingUp className="w-3 h-3 text-green-500" />
                  <span className="text-xs text-green-500">+{trend}%</span>
                </>
              ) : trend < 0 ? (
                <>
                  <TrendingDown className="w-3 h-3 text-red-500" />
                  <span className="text-xs text-red-500">{trend}%</span>
                </>
              ) : (
                <>
                  <Minus className="w-3 h-3 text-gray-400" />
                  <span className="text-xs text-gray-400">0%</span>
                </>
              )}
              <span className="text-xs text-gray-400 ml-1">{tx('较上周', 'vs last week')}</span>
            </div>
          </div>
          <div className="w-8 h-8 bg-brand-primary/10 rounded-lg flex items-center justify-center">
            <Icon className="w-4 h-4 text-brand-primary" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface FunnelStageProps {
  stage: string;
  count: number;
  amount: number;
  isActive?: boolean;
  isLast?: boolean;
}

function FunnelStage({ stage, count, amount, isActive, isLast }: FunnelStageProps) {
  const { setCurrentPage } = useUIStore();
  const { t, locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  const stageLabels: Record<string, { label: string; page?: string }> = {
    'Pending RFQs': { label: t('dashboard.funnelPendingRFQs'), page: 'ingestion' },
    '待处理需求': { label: t('dashboard.funnelPendingRFQs'), page: 'ingestion' },
    'Quoted': { label: t('dashboard.funnelQuoted'), page: 'sourcing' },
    '已询价': { label: t('dashboard.funnelQuoted'), page: 'sourcing' },
    'Pending Approval': { label: t('dashboard.funnelPendingApproval'), page: 'quotations' },
    '待审批': { label: t('dashboard.funnelPendingApproval'), page: 'quotations' },
    'Quoted Done': { label: t('dashboard.funnelQuotedDone'), page: 'quotations' },
    '已报价': { label: t('dashboard.funnelQuotedDone'), page: 'quotations' },
    'Completed': { label: t('dashboard.funnelCompleted') },
    '已成交': { label: t('dashboard.funnelCompleted') },
  };

  const stageMeta = stageLabels[stage];
  const displayStage = stageMeta?.label || stage;

  return (
    <div className="flex min-w-0 items-center flex-1">
      <button
        onClick={() => {
          if (stageMeta?.page) {
            setCurrentPage(stageMeta.page as 'ingestion' | 'sourcing' | 'quotations');
          }
        }}
        className={cn(
          'min-w-0 flex-1 p-2 rounded-lg border-2 transition-all duration-200 text-left',
          isActive
            ? 'border-brand-primary bg-brand-primary/5'
            : 'border-gray-200 bg-white hover:border-gray-300'
        )}
      >
        <p className="text-sm text-gray-500">{displayStage}</p>
        <p className="text-lg font-bold text-gray-900 mt-0.5">{count} {tx('条', 'items')}</p>
        {amount > 0 && (
          <p className="text-sm text-brand-primary mt-0.5">¥{amount.toLocaleString()}</p>
        )}
      </button>
      {!isLast && (
        <ArrowRight className="w-5 h-5 text-gray-300 mx-1 flex-shrink-0" />
      )}
    </div>
  );
}

export function Dashboard() {
  const { customerAlerts, setCustomerAlerts, setInventoryAlerts } = useDashboardStore();
  const setCurrentPage = useUIStore((state) => state.setCurrentPage);
  const setInventorySearchPreset = useUIStore((state) => state.setInventorySearchPreset);
  const { data: stats, loading: statsLoading, error: statsError } = useDashboardStats();
  const { data: funnelData, loading: funnelLoading } = useSalesFunnel();
  const { data: inventory } = useInventory();
  const { t, locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  const handleRestock = (partNumber: string) => {
    setInventorySearchPreset(partNumber);
    setCurrentPage('inventory');
  };

  // 计算时寿件预警
  const lifeLimitedAlerts = useMemo(() => {
    if (!inventory) return [];
    return inventory.filter((item) => {
      if (!item.lifeLimited) return false;
      const shelfLifeWarning = item.shelfLifeDate
        ? new Date(item.shelfLifeDate) < new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
        : false;
      const hoursWarning = typeof item.remainingHours === 'number' && item.remainingHours < 500;
      const cyclesWarning = typeof item.remainingCycles === 'number' && item.remainingCycles < 100;
      return shelfLifeWarning || hoursWarning || cyclesWarning;
    });
  }, [inventory]);

  // 初始化提醒数据
  useEffect(() => {
    setCustomerAlerts([
      { customerId: 'c002', customerName: '海南航空', daysSinceQuote: 3, quoteNumber: 'QT-20260325-003' },
      { customerId: 'c004', customerName: '厦门航空', daysSinceQuote: 5, quoteNumber: 'QT-20260323-002' },
    ]);
    setInventoryAlerts([
      { partNumber: '2341-123-050', currentStock: 2, safetyStock: 5, warehouse: '北京主仓' },
      { partNumber: '5678-901-234', currentStock: 1, safetyStock: 3, warehouse: '广州分仓' },
    ]);
  }, [setCustomerAlerts, setInventoryAlerts]);

  if (statsLoading || funnelLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-primary" />
        <span className="ml-2 text-gray-500">{t('common.loading')}</span>
      </div>
    );
  }

  if (statsError || !stats) {
    return (
      <div className="p-8 text-center text-red-500">
        <AlertTriangle className="w-12 h-12 mx-auto mb-2" />
        <p>{t('dashboard.loadError')}</p>
      </div>
    );
  }

  const salesFunnel = funnelData || [];

  return (
    <div className="min-w-0 space-y-6" data-dashboard-root>
      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4" data-dashboard-stat-grid>
        <StatCard
          title={t('dashboard.todayPendingRFQs')}
          value={stats.pendingRFQs}
          trend={stats.rfqTrend}
          icon={Inbox}
        />
        <StatCard
          title={t('dashboard.inquiryAwaitingReply')}
          value={stats.pendingQuotes}
          trend={stats.quoteTrend}
          icon={FileText}
        />
        <StatCard
          title={t('dashboard.pendingApprovalQuotes')}
          value={stats.pendingApprovals}
          trend={stats.approvalTrend}
          icon={CheckCircle}
        />
        <StatCard
          title={t('dashboard.weeklyDealValue')}
          value={stats.weeklyRevenue}
          trend={stats.revenueTrend}
          icon={TrendingUp}
          prefix="¥"
        />
      </div>

      {/* 销售漏斗 */}
      <Card className="overflow-hidden">
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-base">{t('dashboard.salesFunnel')}</CardTitle>
        </CardHeader>
        <CardContent className="pb-2 px-3 pt-0">
          <div className="flex flex-wrap gap-2" data-dashboard-funnel>
            {salesFunnel.map((stage, index) => (
              <FunnelStage
                key={stage.stage}
                stage={stage.stage}
                count={stage.count}
                amount={stage.amount}
                isActive={index === 0}
                isLast={index === salesFunnel.length - 1}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 提醒区域 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" data-dashboard-alert-grid>
        {/* 客户跟进提醒 */}
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="w-5 h-5 text-brand-primary" />
              {t('dashboard.customerFollowUpAlerts')}
            </CardTitle>
            <Badge variant="secondary" className="min-w-0 max-w-full shrink whitespace-normal break-words text-right">
              {customerAlerts.length} {t('dashboard.pendingFollowUp')}
            </Badge>
          </CardHeader>
          <CardContent>
            {customerAlerts.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
              <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <CheckCircle className="w-12 h-12 mx-auto mb-2 text-green-500" />
                <p>{t('dashboard.allCustomersFollowed')}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {customerAlerts.map((alert) => (
                  <div
                    key={alert.customerId}
                    className="flex flex-wrap items-center justify-between gap-2 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    <div className="min-w-0 break-words">
                      <p className="font-medium">{alert.customerName}</p>
                      <p className="text-sm text-gray-500">
                        {t('dashboard.quotePrefix')} {alert.quoteNumber} · {alert.daysSinceQuote} {t('dashboard.daysSinceQuote')}
                      </p>
                    </div>
                    <Button size="sm" variant="outline">
                      {t('dashboard.followUp')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 库存健康度 */}
        <InventoryHealthCard />

        {/* 时寿件预警 */}
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock className="w-5 h-5 text-brand-primary" />
              {tx('时寿件预警', 'Life Limited Alerts')}
            </CardTitle>
            <Badge variant="destructive" className="min-w-0 max-w-full shrink whitespace-normal break-words text-right">
              {lifeLimitedAlerts.length} {tx('条预警', 'alerts')}
            </Badge>
          </CardHeader>
          <CardContent>
            {lifeLimitedAlerts.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
              <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <CheckCircle className="w-12 h-12 mx-auto mb-2 text-green-500" />
                <p>{tx('无时寿件预警', 'No life limited alerts')}</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {lifeLimitedAlerts.map((alert) => {
                  const warnings: string[] = [];
                  if (alert.shelfLifeDate && new Date(alert.shelfLifeDate) < new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)) {
                    warnings.push(tx('寿命到期', 'Shelf Life'));
                  }
                  if (typeof alert.remainingHours === 'number' && alert.remainingHours < 500) {
                    warnings.push(tx('小时不足', 'Hours'));
                  }
                  if (typeof alert.remainingCycles === 'number' && alert.remainingCycles < 100) {
                    warnings.push(tx('循环不足', 'Cycles'));
                  }
                  return (
                    <div
                      key={alert.id}
                      className="p-3 bg-orange-50 rounded-lg border border-orange-100 cursor-pointer hover:bg-orange-100 transition-colors"
                      onClick={() => handleRestock(alert.partNumber)}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-orange-500" />
                          <span className="font-mono font-medium text-sm">{alert.partNumber}</span>
                        </div>
                        <span className="text-xs text-orange-600">{warnings.join(', ')}</span>
                      </div>
                      <p className="text-xs text-gray-500 truncate">{alert.description}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
