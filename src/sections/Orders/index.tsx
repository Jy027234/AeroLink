import { useEffect, useState, useCallback } from 'react';
import {
  ClipboardList,
  Download,
  Package,
  Truck,
  Plane,
  CheckCircle,
  Clock,
  Search,
  Filter,
  AlertTriangle,
  Eye,
  FileText,
  Loader2,
  PenLine,
  Save,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Shield,
  FileCheck,
  Container,
  Stamp,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useOrders, useUpdateOrder, useInventoryTransactionsByOrder, useCreateOutbound } from '@/hooks/useApi';
import { documentApi, orderApi } from '@/api/client';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { Order, OrderStatus } from '@/types';

const statusConfig: Record<OrderStatus, { label: string; color: string; bgColor: string; icon: React.ElementType; step: number }> = {
  so_created: { label: 'Sales Order', color: 'text-blue-600', bgColor: 'bg-blue-50', icon: FileText, step: 1 },
  po_created: { label: 'Purchase Order', color: 'text-purple-600', bgColor: 'bg-purple-50', icon: ClipboardList, step: 2 },
  shipped: { label: 'Shipped', color: 'text-yellow-600', bgColor: 'bg-yellow-50', icon: Truck, step: 3 },
  in_transit: { label: 'In Transit', color: 'text-orange-600', bgColor: 'bg-orange-50', icon: Plane, step: 4 },
  customs: { label: 'Customs', color: 'text-indigo-600', bgColor: 'bg-indigo-50', icon: Clock, step: 5 },
  inspection: { label: 'Inspection', color: 'text-pink-600', bgColor: 'bg-pink-50', icon: CheckCircle, step: 6 },
  delivered: { label: 'Delivered', color: 'text-green-600', bgColor: 'bg-green-50', icon: Package, step: 7 },
  completed: { label: 'Completed', color: 'text-gray-600', bgColor: 'bg-gray-50', icon: CheckCircle, step: 8 },
};

function calculateEstimatedCosts(totalAmount: number, incoterm?: string) {
  const incotermUpper = (incoterm || '').toUpperCase();
  let estimatedShipping = 0;
  let estimatedInsurance = 0;

  // Shipping estimation based on Incoterms
  if (incotermUpper === 'EXW') {
    estimatedShipping = totalAmount * 0.08;
  } else if (incotermUpper === 'FOB' || incotermUpper === 'FCA') {
    estimatedShipping = totalAmount * 0.05;
  } else if (incotermUpper === 'CIF') {
    estimatedShipping = totalAmount * 0.03;
    estimatedInsurance = 0; // included in CIF shipping
  } else if (incotermUpper === 'DDP' || incotermUpper === 'DAP') {
    estimatedShipping = 0;
  } else {
    estimatedShipping = totalAmount * 0.05;
  }

  // Insurance estimation
  if (incotermUpper === 'CIP' || incotermUpper === 'CIF') {
    estimatedInsurance = 0; // already included
  } else {
    estimatedInsurance = totalAmount * 0.01;
  }

  return { estimatedShipping, estimatedInsurance };
}

function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  const { locale } = useTranslation();
  const labelMap: Record<OrderStatus, string> = {
    so_created: locale === 'zh-CN' ? '销售订单' : 'Sales Order',
    po_created: locale === 'zh-CN' ? '采购订单' : 'Purchase Order',
    shipped: locale === 'zh-CN' ? '已发货' : 'Shipped',
    in_transit: locale === 'zh-CN' ? '运输中' : 'In Transit',
    customs: locale === 'zh-CN' ? '清关中' : 'Customs',
    inspection: locale === 'zh-CN' ? '检验中' : 'Inspection',
    delivered: locale === 'zh-CN' ? '已交付' : 'Delivered',
    completed: locale === 'zh-CN' ? '已完成' : 'Completed',
  };
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      <Icon className="w-3 h-3 mr-1" />
      {labelMap[status] || config.label}
    </Badge>
  );
}

function OrderOutboundHistory({ orderId }: { orderId?: string }) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: transactions, loading } = useInventoryTransactionsByOrder(orderId || '');

  if (!orderId) return null;
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        {tx('加载出库记录...', 'Loading outbound records...')}
      </div>
    );
  }
  if (!transactions || transactions.length === 0) {
    return (
      <p className="text-sm text-gray-400 py-1">
        {tx('暂无出库记录', 'No outbound records yet')}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-gray-500">{tx('出库记录', 'Outbound Records')}</p>
      <div className="space-y-1 max-h-32 overflow-y-auto">
        {transactions
          .filter((t) => t.type === 'OUTBOUND')
          .map((t) => (
            <div key={t.id} className="flex items-center justify-between p-2 bg-gray-50 rounded text-xs">
              <div className="flex items-center gap-2">
                <Package className="w-3 h-3 text-blue-500" />
                <span className="font-medium">{Math.abs(t.quantity)} EA</span>
                <span className="text-gray-400">
                  {t.beforeQuantity} → {t.afterQuantity}
                </span>
              </div>
              <div className="flex items-center gap-2 text-gray-400">
                <span>{new Date(t.createdAt).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</span>
                {t.referenceNo && <span className="font-mono">{t.referenceNo}</span>}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function OrderTimeline({ order }: { order: Order }) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const currentStep = statusConfig[order.status].step;
  const steps = [
    { key: 'so_created', label: tx('销售订单', 'Sales Order') },
    { key: 'po_created', label: tx('采购订单', 'Purchase Order') },
    { key: 'shipped', label: tx('供应商发货', 'Supplier Shipped') },
    { key: 'in_transit', label: tx('国际运输中', 'International Transit') },
    { key: 'customs', label: tx('清关中', 'Customs Clearance') },
    { key: 'inspection', label: tx('入库检验', 'Inbound Inspection') },
    { key: 'delivered', label: tx('已交付客户', 'Delivered to Customer') },
    { key: 'completed', label: tx('已完成', 'Completed') },
  ];

  return (
    <div className="space-y-4">
      <div className="relative">
        <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />
        {steps.map((step, index) => {
          const stepConfig = statusConfig[step.key as OrderStatus];
          const isCompleted = index < currentStep - 1;
          const isCurrent = index === currentStep - 1;
          const StepIcon = stepConfig.icon;

          return (
            <div key={step.key} className="relative flex items-start gap-4 pb-6">
              <div
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center z-10 border-2',
                  isCompleted && 'bg-green-500 border-green-500 text-white',
                  isCurrent && 'bg-brand-primary border-brand-primary text-white',
                  !isCompleted && !isCurrent && 'bg-white border-gray-300 text-gray-400'
                )}
              >
                {isCompleted ? (
                  <CheckCircle className="w-4 h-4" />
                ) : (
                  <StepIcon className="w-4 h-4" />
                )}
              </div>
              <div className="flex-1">
                <p
                  className={cn(
                    'font-medium',
                    isCompleted && 'text-green-600',
                    isCurrent && 'text-brand-primary',
                    !isCompleted && !isCurrent && 'text-gray-400'
                  )}
                >
                  {step.label}
                </p>
                {isCurrent && (
                  <p className="text-sm text-gray-500 mt-1">
                    {tx('当前状态 · 预计', 'Current status · Expected')} {order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US') : tx('待定', 'TBD')}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===== Phase 5: 出库对话框 =====
function OutboundDialog({
  order,
  isOpen,
  onClose,
  onSuccess,
}: {
  order: Order | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const createOutbound = useCreateOutbound();

  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');

  if (!order) return null;

  const remainingQty = order.quantity - (order.outboundQuantity || 0);
  const parsedQty = parseInt(quantity, 10);
  const isValid = parsedQty > 0 && parsedQty <= remainingQty;

  const handleSubmit = async () => {
    if (!isValid || !order.inventoryDetailId) return;
    try {
      await createOutbound.mutate({
        inventoryDetailId: order.inventoryDetailId,
        orderId: order.id,
        quantity: parsedQty,
        notes: notes || undefined,
      });
      toast.success(tx('出库成功', 'Outbound completed'));
      setQuantity('');
      setNotes('');
      onSuccess();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : tx('出库失败', 'Outbound failed');
      toast.error(message);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5 text-blue-500" />
            {tx('执行出库', 'Execute Outbound')}
          </DialogTitle>
          <DialogDescription className="sr-only">{tx('执行库存出库操作', 'Execute inventory outbound')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="p-3 bg-gray-50 rounded-lg text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('件号', 'Part Number')}</span>
              <span className="font-mono font-medium">{order.partNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('订单数量', 'Order Quantity')}</span>
              <span className="font-medium">{order.quantity} EA</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('已出库', 'Outbound')}</span>
              <span className="font-medium">{order.outboundQuantity || 0} EA</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{tx('待出库', 'Remaining')}</span>
              <span className="font-medium text-blue-600">{remainingQty} EA</span>
            </div>
            {order.batchNumber && (
              <div className="flex justify-between">
                <span className="text-gray-500">{tx('批次号', 'Batch')}</span>
                <span className="font-mono">{order.batchNumber}</span>
              </div>
            )}
            {order.serialNumber && (
              <div className="flex justify-between">
                <span className="text-gray-500">{tx('序号', 'Serial')}</span>
                <span className="font-mono">{order.serialNumber}</span>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>{tx('本次出库数量', 'Outbound Quantity')} *</Label>
            <Input
              type="number"
              min={1}
              max={remainingQty}
              placeholder={tx(`最多 ${remainingQty} EA`, `Max ${remainingQty} EA`)}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            {parsedQty > remainingQty && (
              <p className="text-xs text-red-600">
                {tx('出库数量不能超过待出库数量', 'Cannot exceed remaining quantity')}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>{tx('备注', 'Notes')}</Label>
            <Input
              placeholder={tx('可选：出库备注', 'Optional: outbound notes')}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || createOutbound.loading}>
            {createOutbound.loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {tx('确认出库', 'Confirm Outbound')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OrderDetailDialog({ order, isOpen, onClose, onDownloadContract }: { order: Order | null; isOpen: boolean; onClose: () => void; onDownloadContract: (order: Order) => void }) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailLoadFailed, setDetailLoadFailed] = useState(false);
  const [detailRequestVersion, setDetailRequestVersion] = useState(0);

  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<Partial<Order>>({});
  const [customsOpen, setCustomsOpen] = useState(false);
  const [outboundDialogOpen, setOutboundDialogOpen] = useState(false);
  const { mutate: updateOrder, loading: updateLoading } = useUpdateOrder();

  if (!order) return null;

  const activeOrder = detailOrder?.id === order.id ? detailOrder : order;

  useEffect(() => {
    if (!order || !isOpen) {
      return;
    }

    let cancelled = false;

    const loadOrderDetails = async () => {
      setDetailLoading(true);
      setDetailLoadFailed(false);

      try {
        const result = await orderApi.getById(order.id);
        if (!cancelled) {
          setDetailOrder(result);
        }
      } catch {
        if (!cancelled) {
          setDetailOrder(order);
          setDetailLoadFailed(true);
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
        }
      }
    };

    void loadOrderDetails();

    return () => {
      cancelled = true;
    };
  }, [isOpen, order, detailRequestVersion]);

  useEffect(() => {
    if (isEditing && activeOrder) {
      setFormData({ ...activeOrder });
    }
  }, [isEditing, activeOrder]);

  useEffect(() => {
    if (!isEditing) return;
    const duty = Number(formData.importDuty) || 0;
    const vat = Number(formData.vatAmount) || 0;
    const totalAmount = activeOrder?.totalAmount || 0;
    const { estimatedShipping, estimatedInsurance } = calculateEstimatedCosts(totalAmount, formData.incoterm);
    const total = totalAmount + duty + vat + estimatedShipping + estimatedInsurance;
    setFormData((prev) => ({ ...prev, totalLandCost: total, estimatedShipping, estimatedInsurance }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.importDuty, formData.vatAmount, formData.incoterm, isEditing, activeOrder?.totalAmount]);

  const handleDialogOpenChange = (open: boolean) => {
    if (!open) {
      setDetailOrder(null);
      setDetailLoading(false);
      setDetailLoadFailed(false);
      setIsEditing(false);
      onClose();
    }
  };

  const handleFieldChange = useCallback((field: keyof Order, value: unknown) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleSave = async () => {
    if (!activeOrder) return;
    const result = await updateOrder({ id: activeOrder.id, data: formData });
    if (result) {
      setDetailOrder(result);
      setIsEditing(false);
    }
  };

  const isExchange = (isEditing ? formData.saleType : activeOrder?.saleType) === 'Exchange';

  const renderField = (label: string, field: keyof Order, type: 'text' | 'number' | 'date' = 'text') => {
    const value = formData[field];
    return (
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">{label}</Label>
        <Input
          type={type}
          value={type === 'number' ? (value === undefined || value === null ? '' : String(value)) : (value as string) || ''}
          onChange={(e) => {
            const val = type === 'number' ? (e.target.value === '' ? undefined : parseFloat(e.target.value)) : e.target.value;
            handleFieldChange(field, val);
          }}
          className="h-8"
        />
      </div>
    );
  };

  const renderSelect = (label: string, field: keyof Order, options: { value: string; label: string }[]) => {
    const value = formData[field] as string | undefined;
    return (
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">{label}</Label>
        <Select value={value || ''} onValueChange={(v) => handleFieldChange(field, v)}>
          <SelectTrigger className="h-8">
            <SelectValue placeholder="-" />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  };

  const renderSwitch = (label: string, field: keyof Order) => {
    const value = formData[field] as boolean | undefined;
    return (
      <div className="flex items-center justify-between py-1">
        <Label className="text-xs text-gray-500">{label}</Label>
        <Switch
          checked={!!value}
          onCheckedChange={(v) => handleFieldChange(field, v)}
        />
      </div>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleDialogOpenChange}>
      <DialogContent className={cn('max-h-[80vh] overflow-y-auto', isEditing ? 'max-w-4xl' : 'max-w-2xl')}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="w-5 h-5" />
            {isEditing ? tx('编辑订单', 'Edit Order') : tx('订单详情', 'Order Details')} - {activeOrder?.orderNumber}
          </DialogTitle>
          <DialogDescription className="sr-only">{tx('查看和编辑订单详细信息', 'View and edit order details')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {detailLoadFailed && !detailLoading && (
            <div role="alert" className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 md:flex-row md:items-center md:justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="font-medium">{tx('订单详情加载失败', 'Failed to load order details')}</p>
                  <p className="text-sm text-amber-800">{tx('当前展示的订单详情可能不是最新，请重试。', 'The order details may be stale. Please retry.')}</p>
                </div>
              </div>
              <Button variant="outline" onClick={() => setDetailRequestVersion((version) => version + 1)}>
                {tx('重试加载', 'Retry Loading')}
              </Button>
            </div>
          )}

          {detailLoading && (
            <div className="flex items-center justify-center py-2 text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin text-brand-primary" />
              <span className="ml-2 text-sm">{tx('加载详情...', 'Loading details...')}</span>
            </div>
          )}

          {/* Basic information */}
          <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
            <div>
              <p className="text-sm text-gray-500">{tx('销售订单号', 'Sales Order Number')}</p>
              <p className="font-mono font-semibold">{activeOrder?.soNumber}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">{tx('采购订单号', 'Purchase Order Number')}</p>
              <p className="font-mono">{activeOrder?.poNumber || '-'}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">{tx('客户', 'Customer')}</p>
              <p className="font-semibold">{activeOrder?.customerName}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">{tx('金额', 'Amount')}</p>
              <p className="font-semibold text-lg">${(activeOrder?.totalAmount ?? 0).toLocaleString()}</p>
            </div>
          </div>

          {/* Part information */}
          <div className="p-4 border rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">{tx('件号', 'Part Number')}</p>
                <p className="font-mono font-semibold text-lg">{activeOrder?.partNumber}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-gray-500">{tx('数量', 'Quantity')}</p>
                <p className="font-semibold">{activeOrder?.quantity} EA</p>
              </div>
            </div>
          </div>

          {/* Inventory Binding - Phase 4 + Phase 5 Outbound Management */}
          {(activeOrder?.inventoryDetailId || activeOrder?.serialNumber || activeOrder?.batchNumber) && (
            <div className="p-4 border rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-medium flex items-center gap-2">
                  <Package className="w-4 h-4 text-blue-500" />
                  {tx('库存与出库', 'Inventory & Outbound')}
                </h4>
                {activeOrder?.outboundStatus && (
                  <Badge
                    variant="outline"
                    className={cn(
                      activeOrder.outboundStatus === 'COMPLETED' && 'bg-green-50 text-green-600',
                      activeOrder.outboundStatus === 'PARTIAL' && 'bg-yellow-50 text-yellow-600',
                      activeOrder.outboundStatus === 'PENDING' && 'bg-gray-50 text-gray-600'
                    )}
                  >
                    {activeOrder.outboundStatus === 'COMPLETED' && tx('出库完成', 'Completed')}
                    {activeOrder.outboundStatus === 'PARTIAL' && tx('部分出库', 'Partial')}
                    {activeOrder.outboundStatus === 'PENDING' && tx('待出库', 'Pending')}
                  </Badge>
                )}
              </div>

              {/* 库存绑定信息 */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                {activeOrder?.inventoryDetailId && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">{tx('库存明细 ID', 'Inventory Detail ID')}</span>
                    <span className="font-mono text-xs">{activeOrder.inventoryDetailId}</span>
                  </div>
                )}
                {activeOrder?.serialNumber && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">{tx('序列号', 'Serial Number')}</span>
                    <span className="font-mono">{activeOrder.serialNumber}</span>
                  </div>
                )}
                {activeOrder?.batchNumber && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">{tx('批次号', 'Batch Number')}</span>
                    <span className="font-mono">{activeOrder.batchNumber}</span>
                  </div>
                )}
              </div>

              {/* 出库进度 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">{tx('出库进度', 'Outbound Progress')}</span>
                  <span className="font-medium">
                    {activeOrder?.outboundQuantity || 0} / {activeOrder?.quantity} EA
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={cn(
                      'h-2 rounded-full transition-all',
                      (activeOrder?.outboundQuantity || 0) >= (activeOrder?.quantity || 0)
                        ? 'bg-green-500'
                        : 'bg-blue-500'
                    )}
                    style={{
                      width: `${Math.min(100, ((activeOrder?.outboundQuantity || 0) / (activeOrder?.quantity || 1)) * 100)}%`,
                    }}
                  />
                </div>
              </div>

              {/* 出库操作按钮 */}
              {activeOrder && (activeOrder.outboundQuantity || 0) < activeOrder.quantity && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setOutboundDialogOpen(true)}
                >
                  <Package className="w-4 h-4 mr-2" />
                  {tx('执行出库', 'Execute Outbound')}
                  <span className="ml-1 text-xs text-gray-500">
                    ({tx('待出', 'Remaining')} {activeOrder.quantity - (activeOrder.outboundQuantity || 0)} EA)
                  </span>
                </Button>
              )}

              {/* 出库历史 */}
              <OrderOutboundHistory orderId={activeOrder?.id} />
            </div>
          )}

          {isEditing ? (
            <Tabs defaultValue="basic" className="w-full">
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="basic">{tx('基本', 'Basic')}</TabsTrigger>
                <TabsTrigger value="warranty">{tx('质保/证书', 'Warranty')}</TabsTrigger>
                <TabsTrigger value="logistics">{tx('物流', 'Logistics')}</TabsTrigger>
                <TabsTrigger value="customs">{tx('清关', 'Customs')}</TabsTrigger>
                <TabsTrigger value="exchange">{tx('交换', 'Exchange')}</TabsTrigger>
              </TabsList>

              <TabsContent value="basic" className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  {renderSelect(tx('销售类型', 'Sale Type'), 'saleType', [
                    { value: 'Sale', label: tx('销售', 'Sale') },
                    { value: 'Exchange', label: tx('交换', 'Exchange') },
                    { value: 'Loan', label: tx('借用', 'Loan') },
                    { value: 'Consign', label: tx('寄售', 'Consign') },
                    { value: 'Repair', label: tx('维修', 'Repair') },
                  ])}
                  {renderSelect('Incoterm', 'incoterm', [
                    { value: 'EXW', label: 'EXW' },
                    { value: 'FCA', label: 'FCA' },
                    { value: 'CPT', label: 'CPT' },
                    { value: 'CIP', label: 'CIP' },
                    { value: 'DAP', label: 'DAP' },
                    { value: 'DPU', label: 'DPU' },
                    { value: 'DDP', label: 'DDP' },
                    { value: 'FAS', label: 'FAS' },
                    { value: 'FOB', label: 'FOB' },
                    { value: 'CFR', label: 'CFR' },
                    { value: 'CIF', label: 'CIF' },
                  ])}
                  {renderField(tx('贸易条款地点', 'Incoterm Location'), 'incotermLocation')}
                  {renderField(tx('收货方 ID', 'Ship To ID'), 'shipToId')}
                  {renderField(tx('最终用户 ID', 'Ship For ID'), 'shipForId')}
                  {renderField(tx('质保天数', 'Warranty Days'), 'warrantyDays', 'number')}
                  {renderField(tx('质保开始日期', 'Warranty Start Date'), 'warrantyStartDate', 'date')}
                </div>
              </TabsContent>

              <TabsContent value="warranty" className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  {renderSwitch(tx('需要证书', 'Certificate Required'), 'certificateRequired')}
                  {renderSelect(tx('证书类型', 'Certificate Type'), 'certificateType', [
                    { value: 'AAC-038', label: 'AAC-038' },
                    { value: 'FAA-8130-3', label: 'FAA-8130-3' },
                    { value: 'EASA-Form-1', label: 'EASA-Form-1' },
                    { value: 'COC', label: 'COC' },
                    { value: 'NONE', label: 'NONE' },
                  ])}
                  {renderSwitch(tx('证书已交付', 'Certificate Delivered'), 'certificateDelivered')}
                  {renderSwitch(tx('需要检验', 'Inspection Required'), 'inspectionRequired')}
                  {renderSwitch(tx('检验通过', 'Inspection Passed'), 'inspectionPassed')}
                  {renderField(tx('检验日期', 'Inspection Date'), 'inspectionDate', 'date')}
                </div>
              </TabsContent>

              <TabsContent value="logistics" className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  {renderSelect(tx('包装标准', 'Packaging Standard'), 'packagingStandard', [
                    { value: 'Standard', label: 'Standard' },
                    { value: 'ATA300', label: 'ATA300' },
                    { value: 'AOG', label: 'AOG' },
                  ])}
                  {renderSelect(tx('运输方式', 'Shipping Method'), 'shippingMethod', [
                    { value: 'DHL', label: 'DHL' },
                    { value: 'FedEx', label: 'FedEx' },
                    { value: 'UPS', label: 'UPS' },
                    { value: 'Air Freight', label: tx('空运', 'Air Freight') },
                    { value: 'Sea Freight', label: tx('海运', 'Sea Freight') },
                    { value: 'Courier', label: tx('快递', 'Courier') },
                    { value: 'AOG Courier', label: 'AOG ' + tx('快递', 'Courier') },
                  ])}
                  {renderField(tx('承运人账号', 'Carrier Account'), 'carrierAccount')}
                  {renderField(tx('运单号', 'Tracking Number'), 'trackingNumber')}
                  {renderField(tx('承运人', 'Carrier'), 'carrier')}
                </div>
              </TabsContent>

              <TabsContent value="customs" className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  {renderSwitch(tx('需要清关', 'Customs Clearance Required'), 'customsClearanceRequired')}
                  {renderField(tx('报关单号', 'Customs Declaration No'), 'customsDeclarationNo')}
                  {renderField(tx('进口关税', 'Import Duty'), 'importDuty', 'number')}
                  {renderField(tx('增值税', 'VAT Amount'), 'vatAmount', 'number')}
                </div>

                <div className="rounded-lg border p-4 space-y-3 bg-blue-50/50">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-gray-700">{tx('到岸成本估算明细', 'Landed Cost Breakdown')}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const totalAmount = activeOrder?.totalAmount || 0;
                        const duty = Number(formData.importDuty) || 0;
                        const vat = Number(formData.vatAmount) || 0;
                        const { estimatedShipping, estimatedInsurance } = calculateEstimatedCosts(totalAmount, formData.incoterm);
                        const total = totalAmount + duty + vat + estimatedShipping + estimatedInsurance;
                        setFormData((prev) => ({
                          ...prev,
                          totalLandCost: total,
                          estimatedShipping,
                          estimatedInsurance,
                        }));
                      }}
                    >
                      {tx('自动计算到岸成本', 'Auto Calculate Landed Cost')}
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('货值', 'Order Amount')}</span>
                      <span className="font-mono">${(activeOrder?.totalAmount || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('关税', 'Import Duty')}</span>
                      <span className="font-mono">${(Number(formData.importDuty) || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('增值税', 'VAT')}</span>
                      <span className="font-mono">${(Number(formData.vatAmount) || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('运费（估算）', 'Shipping (Est.)')}</span>
                      <span className="font-mono">${(Number(formData.estimatedShipping) || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('保险（估算）', 'Insurance (Est.)')}</span>
                      <span className="font-mono">${(Number(formData.estimatedInsurance) || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between col-span-2 pt-2 border-t">
                      <span className="font-medium text-gray-700">{tx('到岸总成本', 'Total Land Cost')}</span>
                      <span className="font-bold text-blue-600 font-mono text-lg">
                        ${(Number(formData.totalLandCost) || 0).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <p className="text-xs text-amber-600">
                    {tx('* 运费与保险为根据 Incoterms 的估算值，仅供参考', '* Shipping and insurance are estimates based on Incoterms, for reference only')}
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="exchange" className="space-y-4 mt-4">
                {!isExchange ? (
                  <p className="text-sm text-gray-500">{tx('仅 Exchange 类型订单可编辑交换件信息', 'Exchange info only available for Exchange sale type')}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-4">
                    {renderField(tx('核心件费用', 'Core Charge'), 'exchangeCoreCharge', 'number')}
                    {renderField(tx('核心件归还日期', 'Core Due Date'), 'exchangeCoreDueDate', 'date')}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          ) : (
            <>
              {/* Sale & Delivery */}
              <div className="p-4 border rounded-lg space-y-3">
                <h4 className="font-medium flex items-center gap-2">
                  <Truck className="w-4 h-4" />
                  {tx('销售与交付', 'Sale & Delivery')}
                </h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">{tx('销售类型', 'Sale Type')}</span>
                    <span>{activeOrder?.saleType || 'Sale'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Incoterm</span>
                    <span>{activeOrder?.incoterm || '-'}{activeOrder?.incotermLocation ? ` (${activeOrder.incotermLocation})` : ''}</span>
                  </div>
                  {activeOrder?.shipToId && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('收货方', 'Ship To')}</span>
                      <span>{activeOrder.shipToId}</span>
                    </div>
                  )}
                  {activeOrder?.shipForId && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('最终用户', 'Ship For')}</span>
                      <span>{activeOrder.shipForId}</span>
                    </div>
                  )}
                  {activeOrder?.warrantyDays && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('质保', 'Warranty')}</span>
                      <span>{activeOrder.warrantyDays} {tx('天', 'days')}</span>
                    </div>
                  )}
                  {activeOrder?.warrantyStartDate && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('质保开始', 'Warranty Start')}</span>
                      <span>{new Date(activeOrder.warrantyStartDate).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Certificate */}
              <div className="p-4 border rounded-lg space-y-3">
                <h4 className="font-medium flex items-center gap-2">
                  <FileCheck className="w-4 h-4" />
                  {tx('证书与合规', 'Certificate & Compliance')}
                </h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">{tx('需要证书', 'Certificate Required')}</span>
                    <span>{activeOrder?.certificateRequired ? tx('是', 'Yes') : tx('否', 'No')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">{tx('证书类型', 'Certificate Type')}</span>
                    <span>{activeOrder?.certificateType || '-'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">{tx('证书已交付', 'Certificate Delivered')}</span>
                    <span>{activeOrder?.certificateDelivered ? tx('是', 'Yes') : tx('否', 'No')}</span>
                  </div>
                </div>
              </div>

              {/* Logistics */}
              {(activeOrder?.trackingNumber || activeOrder?.carrier || activeOrder?.packagingStandard || activeOrder?.shippingMethod) && (
                <div className="p-4 bg-blue-50 rounded-lg space-y-3">
                  <h4 className="font-medium flex items-center gap-2">
                    <Container className="w-4 h-4" />
                    {tx('物流与包装', 'Logistics & Packaging')}
                  </h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    {activeOrder?.carrier && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">{tx('承运人', 'Carrier')}</span>
                        <span>{activeOrder.carrier}</span>
                      </div>
                    )}
                    {activeOrder?.trackingNumber && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">{tx('运单号', 'Tracking Number')}</span>
                        <span className="font-mono">{activeOrder.trackingNumber}</span>
                      </div>
                    )}
                    {activeOrder?.packagingStandard && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">{tx('包装', 'Packaging')}</span>
                        <span>{activeOrder.packagingStandard}</span>
                      </div>
                    )}
                    {activeOrder?.shippingMethod && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">{tx('运输方式', 'Shipping Method')}</span>
                        <span>{activeOrder.shippingMethod}</span>
                      </div>
                    )}
                    {activeOrder?.carrierAccount && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">{tx('承运人账号', 'Carrier Account')}</span>
                        <span className="font-mono">{activeOrder.carrierAccount}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Inspection */}
              {(activeOrder?.inspectionRequired || activeOrder?.inspectionPassed !== undefined || activeOrder?.inspectionDate) && (
                <div className="p-4 border rounded-lg space-y-3">
                  <h4 className="font-medium flex items-center gap-2">
                    <Shield className="w-4 h-4" />
                    {tx('入库检验', 'Inbound Inspection')}
                  </h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('需要检验', 'Inspection Required')}</span>
                      <span>{activeOrder?.inspectionRequired ? tx('是', 'Yes') : tx('否', 'No')}</span>
                    </div>
                    {activeOrder?.inspectionPassed !== undefined && activeOrder?.inspectionPassed !== null && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">{tx('检验通过', 'Inspection Passed')}</span>
                        <span>{activeOrder.inspectionPassed ? tx('是', 'Yes') : tx('否', 'No')}</span>
                      </div>
                    )}
                    {activeOrder?.inspectionDate && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">{tx('检验日期', 'Inspection Date')}</span>
                        <span>{new Date(activeOrder.inspectionDate).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Customs - Collapsible */}
              <Collapsible open={customsOpen} onOpenChange={setCustomsOpen}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" className="w-full justify-between p-4 h-auto border rounded-lg hover:bg-gray-50">
                    <span className="font-medium flex items-center gap-2">
                      <Stamp className="w-4 h-4" />
                      {tx('清关与到岸成本', 'Customs & Landed Cost')}
                    </span>
                    <ChevronDown className={cn('w-4 h-4 transition-transform', customsOpen && 'rotate-180')} />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="p-4 border border-t-0 rounded-b-lg space-y-3">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-500">{tx('需要清关', 'Customs Clearance Required')}</span>
                        <span>{activeOrder?.customsClearanceRequired ? tx('是', 'Yes') : tx('否', 'No')}</span>
                      </div>
                      {activeOrder?.customsDeclarationNo && (
                        <div className="flex justify-between">
                          <span className="text-gray-500">{tx('报关单号', 'Declaration No')}</span>
                          <span className="font-mono">{activeOrder.customsDeclarationNo}</span>
                        </div>
                      )}
                      {activeOrder?.importDuty !== undefined && activeOrder?.importDuty !== null && (
                        <div className="flex justify-between">
                          <span className="text-gray-500">{tx('进口关税', 'Import Duty')}</span>
                          <span>${activeOrder.importDuty.toLocaleString()}</span>
                        </div>
                      )}
                      {activeOrder?.vatAmount !== undefined && activeOrder?.vatAmount !== null && (
                        <div className="flex justify-between">
                          <span className="text-gray-500">VAT</span>
                          <span>${activeOrder.vatAmount.toLocaleString()}</span>
                        </div>
                      )}
                      {activeOrder?.totalLandCost !== undefined && activeOrder?.totalLandCost !== null && (
                        <div className="flex justify-between col-span-2">
                          <span className="text-gray-500 font-semibold">{tx('到岸总成本', 'Total Land Cost')}</span>
                          <span className="font-semibold text-blue-600">${activeOrder.totalLandCost.toLocaleString()}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>

              {/* Exchange - conditional */}
              {activeOrder?.saleType === 'Exchange' && (
                <div className="p-4 border rounded-lg space-y-3">
                  <h4 className="font-medium flex items-center gap-2">
                    <Package className="w-4 h-4" />
                    {tx('交换件', 'Exchange')}
                  </h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    {activeOrder?.exchangeCoreCharge !== undefined && activeOrder?.exchangeCoreCharge !== null && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">{tx('核心件费用', 'Core Charge')}</span>
                        <span>${activeOrder.exchangeCoreCharge.toLocaleString()}</span>
                      </div>
                    )}
                    {activeOrder?.exchangeCoreDueDate && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">{tx('核心件归还日期', 'Core Due Date')}</span>
                        <span>{new Date(activeOrder.exchangeCoreDueDate).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Signatures */}
              {(activeOrder?.eSignatureCustomer || activeOrder?.eSignatureSupplier) && (
                <div className="p-4 border rounded-lg space-y-3">
                  <h4 className="font-medium flex items-center gap-2">
                    <FileText className="w-4 h-4" />
                    {tx('电子签名', 'E-Signatures')}
                  </h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('客户', 'Customer')}</span>
                      <Badge variant={activeOrder?.eSignatureCustomer ? 'default' : 'secondary'}>
                        {activeOrder?.eSignatureCustomer ? tx('已签署', 'Signed') : tx('未签署', 'Unsigned')}
                      </Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">{tx('供应商', 'Supplier')}</span>
                      <Badge variant={activeOrder?.eSignatureSupplier ? 'default' : 'secondary'}>
                        {activeOrder?.eSignatureSupplier ? tx('已签署', 'Signed') : tx('未签署', 'Unsigned')}
                      </Badge>
                    </div>
                  </div>
                </div>
              )}

              {/* Order progress */}
              <div>
                <h4 className="font-medium mb-4">{tx('订单进度', 'Order Progress')}</h4>
                <OrderTimeline order={activeOrder} />
              </div>
            </>
          )}
        </div>

        <DialogFooter className="gap-2">
          {isEditing ? (
            <>
              <Button variant="outline" onClick={() => setIsEditing(false)} disabled={updateLoading}>
                {tx('取消', 'Cancel')}
              </Button>
              <Button onClick={handleSave} disabled={updateLoading}>
                {updateLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                {tx('保存', 'Save')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>{tx('关闭', 'Close')}</Button>
              <Button variant="outline" onClick={() => setIsEditing(true)}>
                <PenLine className="w-4 h-4 mr-2" />
                {tx('编辑', 'Edit')}
              </Button>
              {activeOrder?.contractDocumentId && (
                <Button onClick={() => onDownloadContract(activeOrder)}>
                  <Download className="w-4 h-4 mr-2" />
                  {tx('下载合同', 'Download Contract')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
      {/* Phase 5: 出库对话?*/}
      <OutboundDialog
        order={order}
        isOpen={outboundDialogOpen}
        onClose={() => setOutboundDialogOpen(false)}
        onSuccess={() => {
          // 刷新订单详情
          setDetailRequestVersion((v) => v + 1);
        }}
      />
    </Dialog>
  );
}

export function Orders() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: orders, loading: ordersLoading } = useOrders();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  const ordersList = orders || [];

  // Filter orders
  const filteredOrders = ordersList.filter((order) => {
    if (searchQuery && !order.orderNumber.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !order.partNumber.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !order.customerName.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (activeTab === 'all') return true;
    if (activeTab === 'in_progress') {
      return order.status !== 'completed' && order.status !== 'delivered';
    }
    if (activeTab === 'completed') {
      return order.status === 'completed' || order.status === 'delivered';
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedOrders = filteredOrders.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Stats
  const stats = {
    total: ordersList.length,
    inProgress: ordersList.filter((o) => o.status !== 'completed' && o.status !== 'delivered').length,
    completed: ordersList.filter((o) => o.status === 'completed' || o.status === 'delivered').length,
    totalValue: ordersList.reduce((sum, o) => sum + o.totalAmount, 0),
  };

  const handleViewDetail = (order: Order) => {
    setSelectedOrder(order);
    setIsDetailOpen(true);
  };

  const handleDownloadContract = async (order: Order) => {
    if (!order.contractDocumentId) return;

    try {
      const blob = await documentApi.getPdfBlob(order.contractDocumentId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${order.orderNumber}-contract.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download order contract:', error);
      toast.error(tx('下载合同失败。', 'Failed to download contract.'));
    }
  };

  if (ordersLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-primary" />
        <span className="ml-2 text-gray-500">{tx('加载中...', 'Loading...')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('订单总数', 'Total Orders')}</p>
              <p className="text-xl font-bold">{stats.total}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('进行中', 'In Progress')}</p>
              <p className="text-xl font-bold text-blue-600">{stats.inProgress}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('已完成', 'Completed')}</p>
              <p className="text-xl font-bold text-green-600">{stats.completed}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('订单总金额', 'Total Order Value')}</p>
              <p className="text-xl font-bold">${stats.totalValue.toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search bar */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[300px] flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder={tx('搜索订单号、件号或客户...', 'Search order number, part number, or customer...')}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              className="pl-10"
            />
          </div>
        </div>
        <Button variant="outline" size="sm">
          <Filter className="w-4 h-4 mr-1" />
          {tx('筛选', 'Filter')}
        </Button>
      </div>

      {/* Order list */}
      <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); setCurrentPage(1); }}>
        <TabsList>
          <TabsTrigger value="all">{tx('全部', 'All')}</TabsTrigger>
          <TabsTrigger value="in_progress">{tx('进行中', 'In Progress')}</TabsTrigger>
          <TabsTrigger value="completed">{tx('已完成', 'Completed')}</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('订单号', 'Order Number')}</TableHead>
                    <TableHead>{tx('客户', 'Customer')}</TableHead>
                    <TableHead>{tx('件号', 'Part Number')}</TableHead>
                    <TableHead>{tx('销售类型', 'Sale Type')}</TableHead>
                    <TableHead>{tx('数量', 'Quantity')}</TableHead>
                    <TableHead>{tx('金额', 'Amount')}</TableHead>
                    <TableHead>{tx('到岸成本', 'Land Cost')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('预计交付', 'Estimated Delivery')}</TableHead>
                    <TableHead>{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredOrders.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-12 text-gray-500">
                        <ClipboardList className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                        <p>{tx('未找到订单', 'No orders found')}</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    paginatedOrders.map((order) => (
                      <TableRow key={order.id} className="hover:bg-gray-50">
                        <TableCell className="font-mono font-medium">{order.orderNumber}</TableCell>
                        <TableCell>{order.customerName}</TableCell>
                        <TableCell className="font-mono">{order.partNumber}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{order.saleType ? tx(order.saleType === 'Sale' ? '销售' : order.saleType === 'Exchange' ? '交换' : order.saleType === 'Loan' ? '借用' : order.saleType === 'Consign' ? '寄售' : order.saleType === 'Repair' ? '维修' : order.saleType, order.saleType) : tx('销售', 'Sale')}</Badge>
                        </TableCell>
                        <TableCell>{order.quantity}</TableCell>
                        <TableCell className="font-semibold">
                          ${order.totalAmount.toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {order.totalLandCost !== undefined && order.totalLandCost !== null ? (
                            <span className="font-semibold text-blue-600">${order.totalLandCost.toLocaleString()}</span>
                          ) : (
                            '-'
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <OrderStatusBadge status={order.status} />
                            {order.customsClearanceRequired && (
                              <Badge variant="secondary" className="text-xs">
                                {tx('清关', 'Customs')}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {order.deliveryDate
                            ? new Date(order.deliveryDate).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')
                            : '-'}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleViewDetail(order)}
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                            {order.contractDocumentId && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => handleDownloadContract(order)}
                              >
                                <Download className="w-4 h-4 text-green-700" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              {filteredOrders.length > pageSize && (
                <div className="flex items-center justify-between p-4">
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
        </TabsContent>
      </Tabs>

      {/* 订单详情弹窗 */}
      <OrderDetailDialog
        order={selectedOrder}
        isOpen={isDetailOpen}
        onDownloadContract={handleDownloadContract}
        onClose={() => {
          setIsDetailOpen(false);
          setSelectedOrder(null);
        }}
      />
    </div>
  );
}
