import {
  Package,
  AlertTriangle,
  TrendingDown,
  Loader2,
  FlaskConical,
  Wrench,
  Cog,
  Puzzle,
  Hammer,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useInventoryHealthSummary } from '@/hooks/useApi';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

const categoryConfig: Record<string, { icon: React.ReactNode; labelZh: string; labelEn: string; color: string }> = {
  ROTABLE: { icon: <Wrench className="w-3 h-3" />, labelZh: '周转件', labelEn: 'Rotable', color: 'text-purple-600 bg-purple-50' },
  REPAIRABLE: { icon: <Hammer className="w-3 h-3" />, labelZh: '可修件', labelEn: 'Repairable', color: 'text-indigo-600 bg-indigo-50' },
  CHEMICAL: { icon: <FlaskConical className="w-3 h-3" />, labelZh: '化工品', labelEn: 'Chemical', color: 'text-amber-600 bg-amber-50' },
  STANDARD_PART: { icon: <Cog className="w-3 h-3" />, labelZh: '标准件', labelEn: 'Standard', color: 'text-cyan-600 bg-cyan-50' },
  RAW_MATERIAL: { icon: <Puzzle className="w-3 h-3" />, labelZh: '原材料', labelEn: 'Raw Mat', color: 'text-gray-600 bg-gray-50' },
  CONSUMABLE: { icon: <Package className="w-3 h-3" />, labelZh: '消耗件', labelEn: 'Consumable', color: 'text-green-600 bg-green-50' },
};

export function InventoryHealthCard() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: health, loading, error } = useInventoryHealthSummary();

  if (loading) {
    return (
      <Card>
        <CardContent className="py-6 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">{tx('加载库存健康度...', 'Loading inventory health...')}</span>
        </CardContent>
      </Card>
    );
  }

  if (error || !health) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          {tx('暂无库存健康度数据', 'No inventory health data')}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Package className="w-4 h-4 text-blue-500" />
            {tx('库存健康度', 'Inventory Health')}
          </CardTitle>
          <Badge variant="outline" className="text-xs">
            {health.totalItems} {tx('件号', 'items')}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 状态统计 */}
        <div className="grid grid-cols-4 gap-2">
          <div className="text-center p-2 bg-green-50 rounded">
            <div className="text-lg font-bold text-green-600">{health.adequateItems}</div>
            <div className="text-xs text-green-700">{tx('充足', 'Adequate')}</div>
          </div>
          <div className="text-center p-2 bg-yellow-50 rounded">
            <div className="text-lg font-bold text-yellow-600">{health.lowItems}</div>
            <div className="text-xs text-yellow-700">{tx('偏低', 'Low')}</div>
          </div>
          <div className="text-center p-2 bg-red-50 rounded">
            <div className="text-lg font-bold text-red-600">{health.criticalItems}</div>
            <div className="text-xs text-red-700">{tx('紧急', 'Critical')}</div>
          </div>
          <div className="text-center p-2 bg-blue-50 rounded">
            <div className="text-lg font-bold text-blue-600">{health.excessItems}</div>
            <div className="text-xs text-blue-700">{tx('过剩', 'Excess')}</div>
          </div>
        </div>

        {/* 按分类健康度 */}
        {health.byCategory && Object.keys(health.byCategory).length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              {tx('按分类健康度', 'Health by Category')}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(health.byCategory).map(([category, stats]) => {
                const config = categoryConfig[category] || categoryConfig['CONSUMABLE'];
                return (
                  <div key={category} className={cn('rounded p-2 text-xs', config.color)}>
                    <div className="flex items-center gap-1 font-medium">
                      {config.icon}
                      {locale === 'zh-CN' ? config.labelZh : config.labelEn}
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <span className="font-bold">{stats.critical}</span>
                      <span className="opacity-70">{tx('紧急', 'crit')}</span>
                      <span className="mx-1">·</span>
                      <span className="font-bold">{stats.low}</span>
                      <span className="opacity-70">{tx('偏低', 'low')}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 库存总值 */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{tx('库存总值', 'Total Value')}</span>
          <span className="font-medium">${health.totalInventoryValue.toLocaleString()}</span>
        </div>

        {/* 紧急补货建议 */}
        {health.recommendations.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              {tx('需关注件号', 'Items to Watch')} ({health.recommendations.length})
            </div>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {health.recommendations.slice(0, 5).map((rec) => (
                <div
                  key={rec.partNumber}
                  className={cn(
                    'flex items-center justify-between text-xs p-1.5 rounded',
                    rec.stockStatus === 'critical' ? 'bg-red-50' : 'bg-yellow-50'
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {rec.stockStatus === 'critical' ? (
                      <AlertTriangle className="w-3 h-3 text-red-500" />
                    ) : (
                      <TrendingDown className="w-3 h-3 text-yellow-500" />
                    )}
                    <span className="font-mono">{rec.partNumber}</span>
                    {rec.partCategory && (
                      <Badge variant="outline" className="text-[10px] px-1 py-0">
                        {locale === 'zh-CN'
                          ? (categoryConfig[rec.partCategory]?.labelZh || rec.partCategory)
                          : (categoryConfig[rec.partCategory]?.labelEn || rec.partCategory)}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      rec.stockStatus === 'critical' ? 'text-red-600' : 'text-yellow-600'
                    )}>
                      {rec.currentStock} / {rec.safetyStockLevel}
                    </span>
                    <span className="text-muted-foreground">
                      {rec.daysOfSupply}d
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
