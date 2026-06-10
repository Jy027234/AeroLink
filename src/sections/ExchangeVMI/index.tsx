import { useState } from 'react';
import {
  Truck,
  CheckCircle,
  Clock,
  AlertTriangle,
  TrendingDown,
  BarChart3,
  ArrowRight,
  Loader2,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  useExchangeQuotes,
  useVMIAgreements,
  useRestockSuggestions,
  useExchangeVMIStats,
} from '@/hooks/useApi';

export function ExchangeVMI() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [activeTab, setActiveTab] = useState('exchange');
  const [selectedExchange, setSelectedExchange] = useState<{
    id: string;
    quoteId: string;
    coreCharge: number;
    coreReturned: boolean;
    returnDeadline: number;
    coreEvaluationCriteria: string;
    acceptableDamageRange: string;
  } | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  const { data: stats, loading: statsLoading, error: statsError } = useExchangeVMIStats();
  const { data: exchanges, loading: exchangesLoading, error: exchangesError } = useExchangeQuotes();
  const { data: vmiAgreements, loading: vmiLoading, error: vmiError } = useVMIAgreements();
  const { data: restockSuggestions, loading: restockLoading, error: restockError } = useRestockSuggestions();

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="exchange">{tx('换件管理', 'Exchange Management')}</TabsTrigger>
          <TabsTrigger value="vmi">{tx('VMI智能补货', 'VMI Smart Restocking')}</TabsTrigger>
        </TabsList>

        {/* Exchange management */}
        <TabsContent value="exchange" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {statsLoading ? (
              <>
                <LoadingCard />
                <LoadingCard />
                <LoadingCard />
                <LoadingCard />
              </>
            ) : statsError ? (
              <ErrorCard message={statsError} />
            ) : stats ? (
              <>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('进行中换件', 'Active Exchanges')}</p>
                    <p className="text-2xl font-bold">{stats.activeExchanges}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('待返还旧件', 'Pending Core Returns')}</p>
                    <p className="text-2xl font-bold text-yellow-600">{stats.pendingCoreReturns}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('旧件押金总额', 'Total Core Deposit')}</p>
                    <p className="text-2xl font-bold">${stats.totalCoreDeposit.toLocaleString()}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('本月结算', 'This Month Settlement')}</p>
                    <p className="text-2xl font-bold text-green-600">${stats.monthlySettlement.toLocaleString()}</p>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{tx('换件订单', 'Exchange Orders')}</CardTitle>
            </CardHeader>
            <CardContent>
              {exchangesLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : exchangesError ? (
                <p className="text-sm text-red-500">{exchangesError}</p>
              ) : exchanges && exchanges.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tx('报价编号', 'Quote Number')}</TableHead>
                      <TableHead>{tx('件号', 'Part Number')}</TableHead>
                      <TableHead>{tx('核心件押金', 'Core Deposit')}</TableHead>
                      <TableHead>{tx('归还期限', 'Return Deadline')}</TableHead>
                      <TableHead>{tx('核心件状态', 'Core Status')}</TableHead>
                      <TableHead>{tx('操作', 'Actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {exchanges.map((exchange) => (
                      <TableRow key={exchange.id}>
                        <TableCell className="font-mono">{exchange.quoteId}</TableCell>
                        <TableCell className="font-mono">2341-123-050</TableCell>
                        <TableCell>${exchange.coreCharge.toLocaleString()}</TableCell>
                        <TableCell>{exchange.returnDeadline} {tx('天', 'days')}</TableCell>
                        <TableCell>
                          {exchange.coreReturned ? (
                            <Badge className="bg-green-100 text-green-700">
                              <CheckCircle className="w-3 h-3 mr-1" />
                              {tx('已归还', 'Returned')}
                            </Badge>
                          ) : (
                            <Badge className="bg-yellow-100 text-yellow-700">
                              <Clock className="w-3 h-3 mr-1" />
                              {tx('待返还', 'Pending Return')}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setSelectedExchange(exchange);
                              setIsDetailOpen(true);
                            }}
                          >
                            {tx('详情', 'Details')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-gray-500 text-center py-12">
                  {tx('暂无换件订单', 'No exchange orders')}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Core evaluation criteria */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{tx('旧件评估标准', 'Core Evaluation Criteria')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="font-medium flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-green-500" />
                    {tx('可接受标准', 'Acceptable Criteria')}
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-gray-600">
                    <li>· TSN {'<'} 20,000 cycles</li>
                    <li>· {tx('无FOD损伤', 'No FOD damage')}</li>
                    <li>· {tx('表面划痕深度', 'Surface scratch depth')} {'<'} 0.5mm</li>
                    <li>· {tx('铭牌信息完整', 'Nameplate info complete')}</li>
                  </ul>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="font-medium flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-500" />
                    {tx('拒收标准', 'Rejection Criteria')}
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-gray-600">
                    <li>· {tx('结构性损伤', 'Structural damage')}</li>
                    <li>· {tx('腐蚀超限', 'Corrosion beyond limit')}</li>
                    <li>· {tx('铭牌缺失', 'Missing nameplate')}</li>
                    <li>· {tx('非OEM维修', 'Non-OEM repair')}</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* VMI smart restocking */}
        <TabsContent value="vmi" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {statsLoading ? (
              <>
                <LoadingCard />
                <LoadingCard />
                <LoadingCard />
                <LoadingCard />
              </>
            ) : statsError ? (
              <ErrorCard message={statsError} />
            ) : stats ? (
              <>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">VMI Customers</p>
                    <p className="text-2xl font-bold">{stats.vmiCustomers}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('VMI件号数', 'VMI Part Numbers')}</p>
                    <p className="text-2xl font-bold">{stats.vmiPartNumbers}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('待补货', 'Pending Restock')}</p>
                    <p className="text-2xl font-bold text-yellow-600">{stats.pendingRestock}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-gray-500">{tx('VMI库存总值', 'Total VMI Inventory Value')}</p>
                    <p className="text-2xl font-bold">${stats.totalVmiInventoryValue.toLocaleString()}</p>
                  </CardContent>
                </Card>
              </>
            ) : null}
          </div>

          {/* VMI agreement list */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{tx('VMI协议', 'VMI Agreements')}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {vmiLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : vmiError ? (
                <p className="text-sm text-red-500">{vmiError}</p>
              ) : vmiAgreements && vmiAgreements.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tx('客户', 'Customer')}</TableHead>
                      <TableHead>{tx('件号', 'Part Number')}</TableHead>
                      <TableHead>{tx('库存范围', 'Stock Range')}</TableHead>
                      <TableHead>{tx('补货点', 'Reorder Point')}</TableHead>
                      <TableHead>{tx('90天消耗', '90-Day Consumption')}</TableHead>
                      <TableHead>{tx('状态', 'Status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vmiAgreements.map((vmi) => {
                      const totalConsumption = vmi.consumptionData.reduce((sum, c) => sum + c.quantity, 0);
                      return (
                        <TableRow key={vmi.id}>
                          <TableCell>{vmi.customerName}</TableCell>
                          <TableCell className="font-mono">{vmi.partNumber}</TableCell>
                          <TableCell>
                            {vmi.minStock} - {vmi.maxStock} EA
                          </TableCell>
                          <TableCell>{vmi.reorderPoint} EA</TableCell>
                          <TableCell>{totalConsumption} EA</TableCell>
                          <TableCell>
                            <Badge className="bg-green-100 text-green-700">{tx('正常', 'Normal')}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-gray-500 text-center py-12">
                  {tx('暂无VMI协议', 'No VMI agreements')}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Restock suggestions */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <TrendingDown className="w-5 h-5 text-yellow-500" />
                {tx('智能补货建议', 'Smart Restock Suggestions')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {restockLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : restockError ? (
                <p className="text-sm text-red-500">{restockError}</p>
              ) : restockSuggestions && restockSuggestions.length > 0 ? (
                <div className="space-y-3">
                  {restockSuggestions.map((suggestion) => (
                    <div
                      key={suggestion.id}
                      className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-mono font-semibold">{suggestion.partNumber}</p>
                            <Badge variant="outline">{suggestion.customerName}</Badge>
                          </div>
                          <p className="text-sm text-gray-600 mt-1">{suggestion.reason}</p>
                          <div className="flex items-center gap-4 mt-2 text-sm">
                            <span className="text-gray-500">
                              {tx('当前库存', 'Current stock')}: <span className="font-semibold">{suggestion.currentStock}</span> EA
                            </span>
                            <ArrowRight className="w-4 h-4 text-gray-400" />
                            <span className="text-green-600">
                              {tx('建议补货', 'Suggested restock')}: <span className="font-semibold">{suggestion.suggestedQty}</span> EA
                            </span>
                          </div>
                          <p className="text-sm text-gray-500 mt-1">
                            {tx('预计到货', 'Expected arrival')}: {suggestion.expectedDeliveryDate}
                          </p>
                        </div>
                        <Button size="sm" className="bg-[#64b5f6] hover:bg-[#42a5f5]">
                          {tx('创建订单', 'Create Order')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  <CheckCircle className="w-12 h-12 mx-auto mb-2 text-green-500" />
                  <p>{tx('所有VMI库存充足，无需补货。', 'All VMI stocks are sufficient. No restocking needed.')}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Consumption trend */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-[#64b5f6]" />
                {tx('消耗趋势分析', 'Consumption Trend Analysis')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {vmiLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : vmiError ? (
                <p className="text-sm text-red-500">{vmiError}</p>
              ) : vmiAgreements && vmiAgreements.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {vmiAgreements.map((vmi) => (
                    <div key={vmi.id} className="p-4 border rounded-lg">
                      <div className="flex items-center justify-between mb-3">
                        <span className="font-medium">{vmi.customerName}</span>
                        <span className="font-mono text-sm">{vmi.partNumber}</span>
                      </div>
                      <div className="flex items-end gap-1 h-24">
                        {vmi.consumptionData.map((data, index) => (
                          <div key={index} className="flex-1 flex flex-col items-center">
                            <div
                              className="w-full bg-[#64b5f6] rounded-t"
                              style={{ height: `${(data.quantity / 20) * 100}%` }}
                            />
                            <span className="text-xs text-gray-500 mt-1">{data.month.slice(5)}</span>
                          </div>
                        ))}
                      </div>
                      <p className="text-sm text-gray-500 mt-2 text-center">
                        Monthly avg consumption: {(vmi.consumptionData.reduce((sum, c) => sum + c.quantity, 0) / 3).toFixed(1)} EA
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500 text-center py-12">
                  {tx('暂无消费数据', 'No consumption data')}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Exchange details dialog */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tx('换件详情', 'Exchange Details')}</DialogTitle>
            <DialogDescription className="sr-only">{tx('查看换件详细信息', 'View exchange details')}</DialogDescription>
          </DialogHeader>
          {selectedExchange && (
            <div className="space-y-4 py-4">
              <div className="p-4 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-500">{tx('核心件押金', 'Core Deposit')}</p>
                <p className="text-2xl font-bold">${selectedExchange.coreCharge.toLocaleString()}</p>
              </div>
              <div>
                <p className="font-medium">{tx('旧件评估标准', 'Core Evaluation Criteria')}</p>
                <p className="text-sm text-gray-600 mt-1">{selectedExchange.coreEvaluationCriteria}</p>
              </div>
              <div>
                <p className="font-medium">{tx('可接受损伤范围', 'Acceptable Damage Range')}</p>
                <p className="text-sm text-gray-600 mt-1">{selectedExchange.acceptableDamageRange}</p>
              </div>
              <div>
                <p className="font-medium">{tx('归还期限', 'Return Deadline')}</p>
                <p className="text-sm text-gray-600 mt-1">{selectedExchange.returnDeadline} {tx('天', 'days')}</p>
              </div>
              {!selectedExchange.coreReturned && (
                <div className="p-4 bg-yellow-50 rounded-lg">
                  <p className="font-medium text-yellow-800 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    {tx('待归还核心件', 'Pending Core Return')}
                  </p>
                  <p className="text-sm text-yellow-700 mt-1">
                    {tx('请生成退运标签并安排物流。', 'Please generate a return shipping label and arrange logistics.')}
                  </p>
                  <Button className="mt-2" size="sm">
                    <Truck className="w-4 h-4 mr-1" />
                    {tx('生成退运标签', 'Generate Return Label')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LoadingCard() {
  return (
    <Card>
      <CardContent className="p-4 flex items-center justify-center h-16">
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
