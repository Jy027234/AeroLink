import { useState } from 'react';
import {
  Search,
  TrendingUp,
  BarChart3,
  Loader2,
  CheckCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useFMVCalculate } from '@/hooks/useApi';

const conditionColors: Record<string, string> = {
  NE: 'bg-green-100 text-green-700',
  NS: 'bg-blue-100 text-blue-700',
  SV: 'bg-purple-100 text-purple-700',
  OH: 'bg-yellow-100 text-yellow-700',
  AR: 'bg-orange-100 text-orange-700',
  US: 'bg-red-100 text-red-700',
};

export function FMVPlatform() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [partNumber, setPartNumber] = useState('');
  const [conditionCode, setConditionCode] = useState('SV');
  const [result, setResult] = useState<{
    partNumber: string;
    manufacturer?: string;
    conditionCode: string;
    fmvs: Array<{
      stage: number;
      stageName: string;
      fmv: number;
      currency: string;
      confidence: number;
      dataPoints: number;
      method: string;
    }>;
    selectedFMV: number;
    selectedStage: number;
    selectedConfidence: number;
    currency: string;
    calculatedAt: string;
  } | null>(null);

  const { mutate: calculate, loading, error } = useFMVCalculate();

  const handleSearch = async () => {
    if (!partNumber.trim()) return;
    const res = await calculate({ partNumber: partNumber.trim(), conditionCode });
    if (res) {
      setResult(res);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{tx('FMV 公正市场价值', 'Fair Market Value')}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {tx('基于历史交易数据的分层统计模型，为航材件号提供公正的市场价值参考', 'Hierarchical statistical model based on historical transaction data, providing fair market value reference for aviation parts')}
        </p>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="py-6">
          <div className="flex items-end gap-4">
            <div className="flex-1 space-y-2">
              <div className="text-sm font-medium">{tx('件号 *', 'Part Number *')}</div>
              <Input
                value={partNumber}
                onChange={(e) => setPartNumber(e.target.value)}
                placeholder={tx('输入件号', 'Enter part number')}
              />
            </div>
            <div className="w-40 space-y-2">
              <div className="text-sm font-medium">Condition</div>
              <Select value={conditionCode} onValueChange={(v) => setConditionCode(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Condition" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NE">NE (New)</SelectItem>
                  <SelectItem value="NS">NS (New Surplus)</SelectItem>
                  <SelectItem value="SV">SV (Serviceable)</SelectItem>
                  <SelectItem value="OH">OH (Overhauled)</SelectItem>
                  <SelectItem value="AR">AR (As Removed)</SelectItem>
                  <SelectItem value="US">US (Unserviceable)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              className="bg-brand-primary hover:bg-brand-primary-hover h-10"
              onClick={handleSearch}
              disabled={loading}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              {tx('查询 FMV', 'Query FMV')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-red-200 bg-red-50/30">
          <CardContent className="py-4 text-sm text-red-600">
            {tx('查询失败', 'Query failed')}: {error}
          </CardContent>
        </Card>
      )}

      {/* Result */}
      {result && (
        <div className="space-y-4">
          {/* Summary Card */}
          <Card className="border-blue-200 bg-blue-50/30">
            <CardContent className="py-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-muted-foreground">{tx('推荐 FMV', 'Recommended FMV')}</div>
                  <div className="text-3xl font-bold text-blue-600">
                    ${result.selectedFMV.toLocaleString()}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge className={conditionColors[result.conditionCode]}>
                      {result.conditionCode}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {tx('置信度', 'Confidence')}: {result.selectedConfidence}%
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-muted-foreground">{tx('件号', 'Part Number')}</div>
                  <div className="font-mono font-medium">{result.partNumber}</div>
                  {result.manufacturer && (
                    <div className="text-xs text-muted-foreground">{result.manufacturer}</div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Stage Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-brand-primary" />
                {tx('分层计算详情', 'Stage Details')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {result.fmvs?.map((stage) => (
                <div
                  key={stage.stage}
                  className={cn(
                    'p-4 rounded-lg border',
                    stage.stage === result.selectedStage
                      ? 'border-blue-200 bg-blue-50'
                      : 'border-gray-200'
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        Stage {stage.stage}: {stage.stageName}
                      </span>
                      {stage.stage === result.selectedStage && (
                        <Badge className="bg-green-100 text-green-700 border-0">
                          <CheckCircle className="w-3 h-3 mr-1" />
                          {tx('已选用', 'Selected')}
                        </Badge>
                      )}
                    </div>
                    <div className="text-lg font-bold">
                      ${stage.fmv.toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <TrendingUp className="w-3 h-3" />
                      {tx('置信度', 'Confidence')}: {stage.confidence}%
                    </div>
                    <div>
                      {tx('数据点', 'Data Points')}: {stage.dataPoints}
                    </div>
                    <div>
                      {tx('方法', 'Method')}: {stage.method}
                    </div>
                  </div>
                  <div className="mt-2">
                    <Progress value={stage.confidence} className="h-1.5" />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
