import {
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
  Percent,
  Award,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { usePriceRecommendation } from '@/hooks/useApi';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

interface PriceRecommendationPanelProps {
  partNumber: string;
  quantity: number;
  customerId?: string;
  proposedPrice?: number;
  onApplyPrice?: (price: number) => void;
  className?: string;
}

export function PriceRecommendationPanel({
  partNumber,
  quantity,
  customerId,
  proposedPrice,
  onApplyPrice,
  className,
}: PriceRecommendationPanelProps) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: recommendation, loading, error } = usePriceRecommendation({
    partNumber,
    quantity,
    customerId,
    proposedPrice,
  });

  if (loading) {
    return (
      <Card className={cn('bg-muted/30', className)}>
        <CardContent className="py-6 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">{tx('分析价格数据中...', 'Analyzing price data...')}</span>
        </CardContent>
      </Card>
    );
  }

  if (error || !recommendation) {
    return (
      <Card className={cn('bg-muted/30', className)}>
        <CardContent className="py-4 flex items-center gap-2 text-muted-foreground">
          <AlertCircle className="w-4 h-4" />
          <span className="text-sm">{tx('暂无价格推荐数据', 'No price recommendation available')}</span>
        </CardContent>
      </Card>
    );
  }

  const { historicalStats, recommendedPrice, priceRange, discountAnalysis, winProbability, winProbabilityFactors } = recommendation;
  const hasHistory = historicalStats.transactionCount > 0;

  return (
    <Card className={cn('border-blue-200/50 bg-blue-50/30', className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Target className="w-4 h-4 text-blue-500" />
            {tx('AI 价格推荐', 'AI Price Recommendation')}
          </CardTitle>
          {hasHistory && (
            <Badge variant="outline" className="text-xs">
              {historicalStats.transactionCount} {tx('笔历史交易', 'historical transactions')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 推荐价格 */}
        {hasHistory && (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">{tx('推荐单价', 'Recommended Unit Price')}</div>
              <div className="text-2xl font-bold text-blue-600">
                ${recommendedPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            {onApplyPrice && (
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => onApplyPrice(recommendedPrice)}
              >
                {tx('应用推荐价', 'Apply')}
              </Button>
            )}
          </div>
        )}

        {/* 历史价格区间 */}
        {hasHistory && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">{tx('历史价格区间', 'Historical Price Range')}</div>
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium">${priceRange.low.toLocaleString()}</div>
              <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-400 rounded-full"
                  style={{
                    width: `${Math.min(100, ((recommendedPrice - priceRange.low) / (priceRange.high - priceRange.low || 1)) * 100)}%`,
                  }}
                />
              </div>
              <div className="text-sm font-medium">${priceRange.high.toLocaleString()}</div>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{tx('均价', 'Avg')}: ${historicalStats.avgPrice.toLocaleString()}</span>
              <span>{tx('中位数', 'Median')}: ${historicalStats.medianPrice.toLocaleString()}</span>
            </div>
          </div>
        )}

        {/* 价格趋势 */}
        {hasHistory && (
          <div className="flex items-center gap-2 text-xs">
            {historicalStats.priceTrend === 'up' && (
              <>
                <TrendingUp className="w-3 h-3 text-red-500" />
                <span className="text-red-600">{tx('价格上行', 'Price trending up')} +{historicalStats.trendPercent}%</span>
              </>
            )}
            {historicalStats.priceTrend === 'down' && (
              <>
                <TrendingDown className="w-3 h-3 text-green-500" />
                <span className="text-green-600">{tx('价格下行', 'Price trending down')} {historicalStats.trendPercent}%</span>
              </>
            )}
            {historicalStats.priceTrend === 'stable' && (
              <>
                <Minus className="w-3 h-3 text-gray-500" />
                <span className="text-gray-600">{tx('价格平稳', 'Price stable')}</span>
              </>
            )}
          </div>
        )}

        {/* 折扣分析 */}
        {discountAnalysis.totalDiscount > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Percent className="w-3 h-3" />
              {tx('折扣分析', 'Discount Analysis')}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {discountAnalysis.customerTierDiscount > 0 && (
                <div className="flex justify-between">
                  <span>{tx('客户等级', 'Customer Tier')}</span>
                  <span className="text-green-600">-{discountAnalysis.customerTierDiscount}%</span>
                </div>
              )}
              {discountAnalysis.volumeDiscount > 0 && (
                <div className="flex justify-between">
                  <span>{tx('批量折扣', 'Volume')}</span>
                  <span className="text-green-600">-{discountAnalysis.volumeDiscount}%</span>
                </div>
              )}
              {discountAnalysis.paymentTermDiscount > 0 && (
                <div className="flex justify-between">
                  <span>{tx('账期折扣', 'Payment Term')}</span>
                  <span className="text-green-600">-{discountAnalysis.paymentTermDiscount}%</span>
                </div>
              )}
              <div className="flex justify-between font-medium col-span-2 border-t pt-1">
                <span>{tx('总折扣', 'Total Discount')}</span>
                <span className="text-green-600">-{discountAnalysis.totalDiscount}%</span>
              </div>
            </div>
          </div>
        )}

        {/* 胜率预测 */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <Award className="w-3 h-3" />
            {tx('赢单概率预测', 'Win Probability')}
          </div>
          <div className="flex items-center gap-3">
            <div className={cn(
              'text-lg font-bold',
              winProbability >= 70 ? 'text-green-600' : winProbability >= 40 ? 'text-yellow-600' : 'text-red-600'
            )}>
              {winProbability}%
            </div>
            <div className="flex-1">
              <Progress value={winProbability} className="h-2" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1 text-xs text-muted-foreground">
            <div className="text-center">
              <div className="font-medium">{winProbabilityFactors.priceFactor}%</div>
              <div>{tx('价格', 'Price')}</div>
            </div>
            <div className="text-center">
              <div className="font-medium">{winProbabilityFactors.customerFactor}%</div>
              <div>{tx('客户', 'Customer')}</div>
            </div>
            <div className="text-center">
              <div className="font-medium">{winProbabilityFactors.marketFactor}%</div>
              <div>{tx('市场', 'Market')}</div>
            </div>
          </div>
        </div>

        {/* 无历史数据提示 */}
        {!hasHistory && (
          <div className="text-xs text-muted-foreground bg-yellow-50 p-2 rounded">
            <AlertCircle className="w-3 h-3 inline mr-1" />
            {tx('该件号暂无历史交易数据，推荐价格基于成本加成计算。', 'No historical data for this part number. Recommended price is based on cost markup.')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
