import { useState } from 'react';
import {
  Truck,
  CheckCircle,
  Clock,
  AlertTriangle,
  MapPin,
  Search,
  Bell,
  FileText,
  Shield,
  ArrowRight,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useOrders, useShipmentTrackings, useCustomsRisks, useShipmentAlerts } from '@/hooks/useApi';
import type { ShipmentTracking } from '@/api/client';

export function OrderTracking() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [activeTab, setActiveTab] = useState('tracking');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTracking, setSelectedTracking] = useState<ShipmentTracking | null>(null);
  const [isTrackingDetailOpen, setIsTrackingDetailOpen] = useState(false);

  const { data: orders, loading: ordersLoading, error: ordersError } = useOrders();
  const { data: trackings, loading: trackingsLoading, error: trackingsError } = useShipmentTrackings();
  const { data: customsRisks, loading: customsLoading, error: customsError } = useCustomsRisks();
  const { data: alerts, loading: alertsLoading, error: alertsError } = useShipmentAlerts();

  // Filter orders
  const filteredOrders = orders?.filter(
    (o) =>
      o.orderNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (o.partNumber && o.partNumber.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (o.trackingNumber && o.trackingNumber.toLowerCase().includes(searchQuery.toLowerCase()))
  ) ?? [];

  const getTrackingForOrder = (orderId: string) => {
    return trackings?.find((t) => t.orderId === orderId) ?? null;
  };

  const getAlertStats = () => {
    if (!alerts) return { delay: 0, customs: 0, resolved: 0 };
    return {
      delay: alerts.filter((a) => a.type === 'delay' && a.status !== 'resolved').length,
      customs: alerts.filter((a) => a.type === 'customs' && a.status !== 'resolved').length,
      resolved: alerts.filter((a) => a.status === 'resolved').length,
    };
  };

  const alertStats = getAlertStats();

  const getAlertBadgeClass = (status: string) => {
    switch (status) {
      case 'open':
        return 'bg-red-100 text-red-700';
      case 'in_progress':
        return 'bg-yellow-100 text-yellow-700';
      case 'resolved':
        return 'bg-green-100 text-green-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  const getAlertBadgeText = (status: string) => {
    switch (status) {
      case 'open':
        return tx('待处理', 'Open');
      case 'in_progress':
        return tx('处理中', 'In Progress');
      case 'resolved':
        return tx('已解决', 'Resolved');
      default:
        return status;
    }
  };

  const getAlertIcon = (type: string, status: string) => {
    if (status === 'resolved') return <CheckCircle className="w-5 h-5 text-green-600 mt-0.5" />;
    if (type === 'delay') return <Clock className="w-5 h-5 text-yellow-600 mt-0.5" />;
    if (type === 'customs') return <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5" />;
    return <Bell className="w-5 h-5 text-gray-600 mt-0.5" />;
  };

  const getAlertBgClass = (type: string, status: string) => {
    if (status === 'resolved') return 'bg-green-50 border-green-200';
    if (type === 'delay') return 'bg-yellow-50 border-yellow-200';
    if (type === 'customs') return 'bg-red-50 border-red-200';
    return 'bg-gray-50 border-gray-200';
  };

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="tracking">{tx('物流追踪', 'Tracking')}</TabsTrigger>
          <TabsTrigger value="customs">{tx('清关风险', 'Customs Risk')}</TabsTrigger>
          <TabsTrigger value="exceptions">{tx('预警', 'Alerts')}</TabsTrigger>
        </TabsList>

        {/* Tracking */}
        <TabsContent value="tracking" className="space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder={tx('搜索订单号、件号或运单号...', 'Search order number, part number, or tracking number...')}
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

          {ordersLoading || trackingsLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : ordersError || trackingsError ? (
            <p className="text-sm text-red-500">{ordersError || trackingsError}</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredOrders.map((order) => {
                const tracking = getTrackingForOrder(order.id);
                const latestEvent = tracking?.events?.[(tracking.events?.length || 0) - 1];

                return (
                  <Card key={order.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold">{order.orderNumber}</span>
                            <Badge variant="outline">{tracking?.carrier || tx('待分配', 'Pending')}</Badge>
                          </div>
                          <p className="text-sm text-gray-500 mt-1">{order.customerName}</p>
                          <p className="font-mono text-sm">{order.partNumber || '-'}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-gray-500">{order.quantity} EA</p>
                          <p className="font-semibold">
                            {locale === 'zh-CN' ? `¥${order.totalAmount.toLocaleString()}` : `$${order.totalAmount.toLocaleString()}`}
                          </p>
                        </div>
                      </div>

                      {tracking && (
                        <>
                          <div className="mt-4 p-3 bg-gray-50 rounded-lg">
                            <div className="flex items-center gap-2">
                              <Truck className="w-4 h-4 text-brand-primary" />
                              <span className="font-medium">{tracking.trackingNumber}</span>
                            </div>
                            {latestEvent && (
                              <div className="mt-2 text-sm">
                                <p className="text-gray-700">{latestEvent.status}</p>
                                <p className="text-gray-500">
                                  {latestEvent.location} · {new Date(latestEvent.timestamp).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                                </p>
                              </div>
                            )}
                          </div>

                          {/* 进度条 */}
                          <div className="mt-4">
                            <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                              <span>{tracking.origin}</span>
                              <span>{tx('预计到达', 'ETA')} {tracking.estimatedDelivery}</span>
                              <span>{tracking.destination}</span>
                            </div>
                            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-brand-primary rounded-full"
                                style={{ width: `${((tracking.events?.length || 0) / 8) * 100}%` }}
                              />
                            </div>
                          </div>

                          <Button
                            variant="outline"
                            className="w-full mt-4"
                            onClick={() => {
                              setSelectedTracking(tracking);
                              setIsTrackingDetailOpen(true);
                            }}
                          >
                            {tx('查看详情', 'View Details')}
                          </Button>
                        </>
                      )}

                      {!tracking && (
                        <div className="mt-4 p-3 bg-yellow-50 rounded-lg text-center">
                          <Clock className="w-5 h-5 mx-auto mb-1 text-yellow-600" />
                          <p className="text-sm text-yellow-700">{tx('待发货', 'Awaiting shipment')}</p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* Customs risk */}
        <TabsContent value="customs" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Shield className="w-5 h-5 text-brand-primary" />
                {tx('清关风险评估', 'Customs Risk Assessment')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {customsLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : customsError ? (
                <p className="text-sm text-red-500">{customsError}</p>
              ) : customsRisks && customsRisks.length > 0 ? (
                <div className="space-y-4">
                  {customsRisks.map((risk) => (
                    <div
                      key={risk.partNumber}
                      className={cn(
                        'p-4 rounded-lg border',
                        risk.riskLevel === 'high' && 'bg-red-50 border-red-200',
                        risk.riskLevel === 'medium' && 'bg-yellow-50 border-yellow-200',
                        risk.riskLevel === 'low' && 'bg-green-50 border-green-200'
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold">{risk.partNumber}</span>
                            <Badge
                              className={cn(
                                risk.riskLevel === 'high' && 'bg-red-100 text-red-700',
                                risk.riskLevel === 'medium' && 'bg-yellow-100 text-yellow-700',
                                risk.riskLevel === 'low' && 'bg-green-100 text-green-700'
                              )}
                            >
                              {risk.riskLevel === 'high' && <AlertTriangle className="w-3 h-3 mr-1" />}
                              {risk.riskLevel === 'high' && tx('高风险', 'High Risk')}
                              {risk.riskLevel === 'medium' && tx('中风险', 'Medium Risk')}
                              {risk.riskLevel === 'low' && tx('低风险', 'Low Risk')}
                            </Badge>
                          </div>
                          <p className="text-sm text-gray-500 mt-1">HS Code: {risk.hsCode}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-gray-500">{tx('查验率', 'Inspection Rate')}</p>
                          <p
                            className={cn(
                              'font-semibold',
                              risk.inspectionRate > 20 ? 'text-red-600' : risk.inspectionRate > 10 ? 'text-yellow-600' : 'text-green-600'
                            )}
                          >
                            {risk.inspectionRate}%
                          </p>
                        </div>
                      </div>

                      <div className="mt-3">
                        <p className="text-sm font-medium">{tx('所需单证', 'Required Documents')}</p>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {risk.requiredDocs?.map((doc) => (
                            <Badge key={doc} variant="outline" className="text-xs">
                              <FileText className="w-3 h-3 mr-1" />
                              {doc}
                            </Badge>
                          ))}
                        </div>
                      </div>

                      <div className="mt-3">
                        <p className="text-sm font-medium">{tx('建议措施', 'Recommendations')}</p>
                        <ul className="mt-1 space-y-1">
                          {risk.recommendations?.map((rec, index) => (
                            <li key={index} className="text-sm text-gray-600">
                              · {rec}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title={tx('暂无清关风险数据', 'No customs risk data available')}
                  description={tx('当前没有可用的清关风险数据', 'No customs risk data available at the moment')}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Alerts */}
        <TabsContent value="exceptions" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-gray-500">{tx('延误预警', 'Delay Alerts')}</p>
                <p className="text-2xl font-bold text-yellow-600">{alertStats.delay}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-gray-500">{tx('清关异常', 'Customs Exceptions')}</p>
                <p className="text-2xl font-bold text-red-600">{alertStats.customs}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-gray-500">{tx('已解决', 'Resolved')}</p>
                <p className="text-2xl font-bold text-green-600">{alertStats.resolved}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Bell className="w-5 h-5 text-yellow-500" />
                {tx('预警列表', 'Alert List')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {alertsLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : alertsError ? (
                <p className="text-sm text-red-500">{alertsError}</p>
              ) : alerts && alerts.length > 0 ? (
                <div className="space-y-3">
                  {alerts.map((alert) => (
                    <div
                      key={alert.id}
                      className={cn(
                        'p-4 border rounded-lg',
                        getAlertBgClass(alert.type, alert.status)
                      )}
                    >
                      <div className="flex items-start gap-3">
                        {getAlertIcon(alert.type, alert.status)}
                        <div className="flex-1">
                          <div className="flex items-center justify-between">
                            <p className="font-medium">{alert.title}</p>
                            <Badge className={getAlertBadgeClass(alert.status)}>
                              {getAlertBadgeText(alert.status)}
                            </Badge>
                          </div>
                          <p className="text-sm text-gray-600 mt-1">{alert.description}</p>
                          {alert.status !== 'resolved' && (
                            <div className="flex gap-2 mt-2">
                              <Button size="sm" variant="outline">
                                {tx('查看详情', 'View Details')}
                              </Button>
                              <Button size="sm">
                                {tx('处理', 'Handle')}
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500 text-center py-12">
                  {tx('暂无预警', 'No alerts')}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Tracking detail dialog */}
      <Dialog open={isTrackingDetailOpen} onOpenChange={setIsTrackingDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="w-5 h-5" />
              {tx('物流详情', 'Logistics Details')}
            </DialogTitle>
          </DialogHeader>
          {selectedTracking && (
            <div className="space-y-4 py-4">
              <div className="p-4 bg-gray-50 rounded-lg">
                <p className="font-mono font-semibold">{selectedTracking.trackingNumber}</p>
                <p className="text-sm text-gray-500">{selectedTracking.carrier}</p>
                <div className="flex items-center gap-2 mt-2 text-sm">
                  <MapPin className="w-4 h-4 text-gray-400" />
                  <span>{selectedTracking.origin}</span>
                  <ArrowRight className="w-4 h-4 text-gray-400" />
                  <span>{selectedTracking.destination}</span>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  {tx('预计到达', 'ETA')}: {selectedTracking.estimatedDelivery}
                </p>
              </div>

              <div className="relative">
                <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />
                <div className="space-y-4">
                  {selectedTracking.events?.map((event, index) => (
                    <div key={index} className="relative flex items-start gap-4">
                      <div
                        className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center z-10',
                          index === (selectedTracking.events?.length || 0) - 1
                            ? 'bg-brand-primary text-white'
                            : 'bg-green-500 text-white'
                        )}
                      >
                        {index === (selectedTracking.events?.length || 0) - 1 ? (
                          <Truck className="w-4 h-4" />
                        ) : (
                          <CheckCircle className="w-4 h-4" />
                        )}
                      </div>
                      <div>
                        <p className="font-medium">{event.status}</p>
                        <p className="text-sm text-gray-500">{event.description}</p>
                        <p className="text-xs text-gray-400 mt-1">
                          {event.location} · {new Date(event.timestamp).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsTrackingDetailOpen(false)}>
              {tx('关闭', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
