import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
  FileText,
  Search,
  Eye,
  Send,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Plane,
  AlertTriangle,
  Plus,
  Pencil,
  Store,
  FlaskConical,
  Wrench,
  Thermometer,
  ShieldCheck,
  Inbox,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRFQStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useCustomers, useCreateRFQ, useUpdateRFQ, useSuppliers, useDispatchNotification } from '@/hooks/useApi';
import { ipcApi } from '@/api/client';
import type { RFQ, RFQStatus, UrgencyLevel, ConditionCode, CertificateType } from '@/types';

const statusConfig: Record<RFQStatus, { label: string; color: string; bgColor: string }> = {
  pending: { label: 'Pending', color: 'text-yellow-600', bgColor: 'bg-yellow-50' },
  sourcing: { label: 'Sourcing', color: 'text-blue-600', bgColor: 'bg-blue-50' },
  quoting: { label: 'Quoting', color: 'text-purple-600', bgColor: 'bg-purple-50' },
  approved: { label: 'Approved', color: 'text-green-600', bgColor: 'bg-green-50' },
  sent: { label: 'Sent', color: 'text-cyan-600', bgColor: 'bg-cyan-50' },
  won: { label: 'Won', color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  lost: { label: 'Lost', color: 'text-red-600', bgColor: 'bg-red-50' },
};

const urgencyConfig: Record<UrgencyLevel, { label: string; color: string; bgColor: string }> = {
  aog: { label: 'AOG Urgent', color: 'text-red-600', bgColor: 'bg-red-50' },
  urgent: { label: 'Urgent', color: 'text-orange-600', bgColor: 'bg-orange-50' },
  standard: { label: 'Standard', color: 'text-gray-600', bgColor: 'bg-gray-50' },
};

function RFQStatusBadge({ status }: { status: RFQStatus }) {
  const config = statusConfig[status];
  const { locale } = useTranslation();
  const labelMap: Record<RFQStatus, string> = {
    pending: locale === 'zh-CN' ? '待处理' : 'Pending',
    sourcing: locale === 'zh-CN' ? '寻源中' : 'Sourcing',
    quoting: locale === 'zh-CN' ? '报价中' : 'Quoting',
    approved: locale === 'zh-CN' ? '已审批' : 'Approved',
    sent: locale === 'zh-CN' ? '已发送' : 'Sent',
    won: locale === 'zh-CN' ? '已赢单' : 'Won',
    lost: locale === 'zh-CN' ? '已失单' : 'Lost',
  };
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      {labelMap[status] || config.label}
    </Badge>
  );
}

function UrgencyBadge({ urgency }: { urgency: UrgencyLevel }) {
  const config = urgencyConfig[urgency];
  const { locale } = useTranslation();
  const labelMap: Record<UrgencyLevel, string> = {
    aog: locale === 'zh-CN' ? 'AOG紧急' : 'AOG Urgent',
    urgent: locale === 'zh-CN' ? '紧急' : 'Urgent',
    standard: locale === 'zh-CN' ? '标准' : 'Standard',
  };
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      {urgency === 'aog' && <AlertTriangle className="w-3 h-3 mr-1" />}
      {labelMap[urgency] || config.label}
    </Badge>
  );
}

function RFQDetailDialog({
  rfq,
  isOpen,
  onClose,
}: {
  rfq: RFQ | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: suppliers } = useSuppliers();

  if (!rfq) return null;

  // 按 RFQ 分类过滤推荐供应商
  const recommendedSuppliers = suppliers?.filter((s) => {
    if (rfq.partCategory === 'ROTABLE' && s.canSupplyRotable) return true;
    if (rfq.partCategory === 'CHEMICAL' && s.canSupplyChemical) return true;
    // 标准件/原材料/消耗件：所有活跃供应商均可
    if (rfq.partCategory && ['STANDARD_PART', 'RAW_MATERIAL', 'CONSUMABLE', 'REPAIRABLE'].includes(rfq.partCategory)) {
      return s.status === 'active' || s.status === undefined;
    }
    return false;
  }) || [];

  const categoryLabelMap: Record<string, { zh: string; en: string; icon: React.ReactNode }> = {
    ROTABLE: { zh: '周转件', en: 'Rotable', icon: <Wrench className="w-4 h-4" /> },
    REPAIRABLE: { zh: '可修件', en: 'Repairable', icon: <Wrench className="w-4 h-4" /> },
    CHEMICAL: { zh: '化工品', en: 'Chemical', icon: <FlaskConical className="w-4 h-4" /> },
    STANDARD_PART: { zh: '标准件', en: 'Standard', icon: <Store className="w-4 h-4" /> },
    RAW_MATERIAL: { zh: '原材料', en: 'Raw Material', icon: <Store className="w-4 h-4" /> },
    CONSUMABLE: { zh: '消耗件', en: 'Consumable', icon: <Store className="w-4 h-4" /> },
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            {tx('需求单详情', 'RFQ Details')} - {rfq.rfqNumber}
          </DialogTitle>
          <DialogDescription className="sr-only">{tx('查看需求单详细信息', 'View RFQ details')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="flex justify-between items-start p-4 bg-gray-50 rounded-lg">
            <div className="flex gap-2">
              <RFQStatusBadge status={rfq.status} />
              <UrgencyBadge urgency={rfq.urgency} />
            </div>
            <span className="text-sm text-gray-500">
              {tx('创建于', 'Created on')} {new Date(rfq.createdAt).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('客户', 'Customer')}</p>
              <p className="font-semibold">{rfq.customerName}</p>
            </div>
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('件号', 'Part Number')}</p>
              <p className="font-mono font-semibold text-lg">{rfq.partNumber}</p>
            </div>
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('数量', 'Quantity')}</p>
              <p className="font-semibold text-lg">{rfq.quantity} {rfq.uom || 'EA'}</p>
            </div>
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('状态码', 'Condition Code')}</p>
              <p className="font-semibold">{rfq.conditionCode || 'NE'}</p>
            </div>
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('需求日期', 'Required Date')}</p>
              <p className="font-semibold">{rfq.requiredDate}</p>
            </div>
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('响应截止', 'Response Deadline')}</p>
              <p className="font-semibold">{rfq.responseDeadline || '-'}</p>
            </div>
          </div>

          {/* 分类信息 */}
          <div className="p-4 border rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              {categoryLabelMap[rfq.partCategory || '']?.icon || <Store className="w-4 h-4" />}
              <span className="font-medium">{tx('航材分类', 'Part Category')}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {locale === 'zh-CN'
                  ? (categoryLabelMap[rfq.partCategory || '']?.zh || rfq.partCategory || '-')
                  : (categoryLabelMap[rfq.partCategory || '']?.en || rfq.partCategory || '-')}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {rfq.trackingType === 'SERIAL' ? tx('序列号追踪', 'Serial Tracked') : tx('批次追踪', 'Batch Tracked')}
              </Badge>
            </div>
          </div>

          {rfq.description && (
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400 mb-1">{tx('描述', 'Description')}</p>
              <p className="text-sm">{rfq.description}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            {rfq.serialNumber && (
              <div className="p-4 border rounded-lg">
                <p className="text-xs text-gray-400">{tx('序列号', 'Serial Number')}</p>
                <p className="font-mono font-semibold">{rfq.serialNumber}</p>
              </div>
            )}
            {rfq.batchNumber && (
              <div className="p-4 border rounded-lg">
                <p className="text-xs text-gray-400">{tx('批次号', 'Batch Number')}</p>
                <p className="font-mono font-semibold">{rfq.batchNumber}</p>
              </div>
            )}
            {rfq.ataChapter && (
              <div className="p-4 border rounded-lg">
                <p className="text-xs text-gray-400">{tx('ATA章节', 'ATA Chapter')}</p>
                <p className="font-semibold">{rfq.ataChapter}</p>
              </div>
            )}
            {rfq.aircraftModel && (
              <div className="p-4 border rounded-lg">
                <p className="text-xs text-gray-400">{tx('机型', 'Aircraft Model')}</p>
                <p className="font-semibold">{rfq.aircraftModel}</p>
              </div>
            )}
          </div>

          {rfq.alternatePartNumbers && rfq.alternatePartNumbers.length > 0 && (
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400 mb-1">{tx('替代件号', 'Alternate Part Numbers')}</p>
              <p className="font-mono text-sm">{rfq.alternatePartNumbers.join(', ')}</p>
            </div>
          )}

          {rfq.targetPrice && (
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('目标价', 'Target Price')}</p>
              <p className="font-semibold text-lg text-green-600">
                {rfq.targetPriceCurrency || 'USD'} {rfq.targetPrice.toLocaleString()}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400">{tx('需要证书', 'Certificate Required')}</p>
              <p className="font-semibold">{rfq.certificateRequired ? tx('是', 'Yes') : tx('否', 'No')}</p>
            </div>
            {rfq.certificateType && (
              <div className="p-4 border rounded-lg">
                <p className="text-xs text-gray-400">{tx('证书类型', 'Certificate Type')}</p>
                <p className="font-semibold">{rfq.certificateType}</p>
              </div>
            )}
            {rfq.leadTimeDays && (
              <div className="p-4 border rounded-lg">
                <p className="text-xs text-gray-400">{tx('交期(天)', 'Lead Time (Days)')}</p>
                <p className="font-semibold">{rfq.leadTimeDays}</p>
              </div>
            )}
          </div>

          {rfq.aircraftType && (
            <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg">
              <Plane className="w-5 h-5 text-blue-500" />
              <span className="text-sm">{tx('机型', 'Aircraft Type')}: <strong>{rfq.aircraftType}</strong></span>
            </div>
          )}

          {rfq.urgencyJustification && (
            <div className="p-4 border rounded-lg bg-red-50">
              <p className="text-xs text-gray-400 mb-1">{tx('紧急原因', 'Urgency Justification')}</p>
              <p className="text-sm text-red-700">{rfq.urgencyJustification}</p>
            </div>
          )}

          {rfq.notes && (
            <div className="p-4 border rounded-lg">
              <p className="text-xs text-gray-400 mb-1">{tx('备注', 'Notes')}</p>
              <p className="text-sm">{rfq.notes}</p>
            </div>
          )}

          {/* 推荐供应商 - Phase 4 */}
          {(rfq.status === 'sourcing' || rfq.status === 'quoting' || rfq.status === 'approved') && (
            <div className="p-4 border rounded-lg space-y-3">
              <h4 className="font-medium flex items-center gap-2">
                <Store className="w-4 h-4 text-blue-500" />
                {tx('推荐供应商', 'Recommended Suppliers')}
                <Badge variant="outline" className="text-xs ml-2">
                  {recommendedSuppliers.length}
                </Badge>
              </h4>
              {recommendedSuppliers.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {tx('暂无匹配该分类的供应商', 'No suppliers match this category')}
                </p>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {recommendedSuppliers.slice(0, 5).map((s) => (
                    <div key={s.id} className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{s.name}</span>
                        <Badge variant="outline" className="text-[10px]">{s.level}</Badge>
                        {s.canSupplyRotable && (
                          <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-600">
                            <Wrench className="w-3 h-3 mr-1" />
                            {tx('周转件', 'Rotable')}
                          </Badge>
                        )}
                        {s.canSupplyChemical && (
                          <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-600">
                            <FlaskConical className="w-3 h-3 mr-1" />
                            {tx('化工品', 'Chemical')}
                          </Badge>
                        )}
                        {s.hasDangerousGoodsLicense && (
                          <Badge variant="outline" className="text-[10px] bg-red-50 text-red-600">
                            <ShieldCheck className="w-3 h-3 mr-1" />
                            {tx('危险品', 'DG')}
                          </Badge>
                        )}
                        {s.hasColdChain && (
                          <Badge variant="outline" className="text-[10px] bg-cyan-50 text-cyan-600">
                            <Thermometer className="w-3 h-3 mr-1" />
                            {tx('冷链', 'Cold')}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">
                        {s.leadTimeAverage && `${s.leadTimeAverage}d`}
                        {s.onTimeDeliveryRate && ` · ${(s.onTimeDeliveryRate * 100).toFixed(0)}%`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {tx('关闭', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RFQFormDialog({
  rfq,
  isOpen,
  onClose,
  onSave,
}: {
  rfq: RFQ | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: customers } = useCustomers();

  const [form, setForm] = useState({
    customerId: '',
    partNumber: '',
    quantity: 1,
    uom: 'EA',
    conditionCode: 'NE',
    description: '',
    serialNumber: '',
    batchNumber: '',
    ataChapter: '',
    aircraftType: '',
    aircraftModel: '',
    alternatePartNumbers: '',
    targetPrice: '',
    targetPriceCurrency: 'USD',
    certificateRequired: true,
    certificateType: '',
    requiredDate: '',
    responseDeadline: '',
    leadTimeDays: '',
    urgency: 'standard' as UrgencyLevel,
    urgencyJustification: '',
    notes: '',
  });

  const [ipcFilled, setIpcFilled] = useState(false);
  const [ipcWarning, setIpcWarning] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userEditedFields = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!form.partNumber || form.partNumber.length < 3) {
      setIpcFilled(false);
      setIpcWarning('');
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const data = await ipcApi.getByPartNumber(form.partNumber);
        if (data) {
          setForm((prev) => {
            const next = { ...prev };
            if (!userEditedFields.current.has('description') && data.description) {
              next.description = data.description;
            }
            if (!userEditedFields.current.has('ataChapter') && data.ataChapter) {
              next.ataChapter = data.ataChapter;
            }
            if (!userEditedFields.current.has('aircraftModel') && data.aircraftTypes?.length) {
              next.aircraftModel = data.aircraftTypes[0];
            }
            if (!userEditedFields.current.has('aircraftType') && data.aircraftTypes?.length) {
              next.aircraftType = data.aircraftTypes[0];
            }
            if (!userEditedFields.current.has('alternatePartNumbers') && data.alternateParts?.length) {
              next.alternatePartNumbers = data.alternateParts.join(', ');
            }
            return next;
          });
          setIpcFilled(true);
          if (data.supersededBy) {
            setIpcWarning(
              locale === 'zh-CN'
                ? `该件号已被 ${data.supersededBy} 替代，请核实`
                : `This part number has been superseded by ${data.supersededBy}. Please verify.`
            );
          } else {
            setIpcWarning('');
          }
        }
      } catch {
        setIpcFilled(false);
        setIpcWarning('');
      }
    }, 500);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [form.partNumber, locale]);

  useEffect(() => {
    if (rfq) {
      setForm({
        customerId: rfq.customerId,
        partNumber: rfq.partNumber,
        quantity: rfq.quantity,
        uom: rfq.uom || 'EA',
        conditionCode: rfq.conditionCode || 'NE',
        description: rfq.description || '',
        serialNumber: rfq.serialNumber || '',
        batchNumber: rfq.batchNumber || '',
        ataChapter: rfq.ataChapter || '',
        aircraftType: rfq.aircraftType || '',
        aircraftModel: rfq.aircraftModel || '',
        alternatePartNumbers: rfq.alternatePartNumbers ? rfq.alternatePartNumbers.join(', ') : '',
        targetPrice: rfq.targetPrice ? String(rfq.targetPrice) : '',
        targetPriceCurrency: rfq.targetPriceCurrency || 'USD',
        certificateRequired: rfq.certificateRequired ?? true,
        certificateType: rfq.certificateType || '',
        requiredDate: rfq.requiredDate,
        responseDeadline: rfq.responseDeadline || '',
        leadTimeDays: rfq.leadTimeDays ? String(rfq.leadTimeDays) : '',
        urgency: rfq.urgency,
        urgencyJustification: rfq.urgencyJustification || '',
        notes: rfq.notes || '',
      });
      userEditedFields.current.clear();
      setIpcFilled(false);
      setIpcWarning('');
    } else {
      setForm({
        customerId: '',
        partNumber: '',
        quantity: 1,
        uom: 'EA',
        conditionCode: 'NE',
        description: '',
        serialNumber: '',
        batchNumber: '',
        ataChapter: '',
        aircraftType: '',
        aircraftModel: '',
        alternatePartNumbers: '',
        targetPrice: '',
        targetPriceCurrency: 'USD',
        certificateRequired: true,
        certificateType: '',
        requiredDate: '',
        responseDeadline: '',
        leadTimeDays: '',
        urgency: 'standard',
        urgencyJustification: '',
        notes: '',
      });
      userEditedFields.current.clear();
      setIpcFilled(false);
      setIpcWarning('');
    }
  }, [rfq]);

  const updateField = <K extends keyof typeof form>(field: K, value: typeof form[K]) => {
    userEditedFields.current.add(field as string);
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = () => {
    const payload: Record<string, unknown> = {
      customerId: form.customerId,
      partNumber: form.partNumber,
      quantity: Number(form.quantity),
      uom: form.uom,
      conditionCode: form.conditionCode,
      description: form.description || undefined,
      serialNumber: form.serialNumber || undefined,
      batchNumber: form.batchNumber || undefined,
      ataChapter: form.ataChapter || undefined,
      aircraftType: form.aircraftType || undefined,
      aircraftModel: form.aircraftModel || undefined,
      alternatePartNumbers: form.alternatePartNumbers
        ? form.alternatePartNumbers.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
      targetPrice: form.targetPrice ? Number(form.targetPrice) : undefined,
      targetPriceCurrency: form.targetPriceCurrency,
      certificateRequired: form.certificateRequired,
      certificateType: form.certificateType || undefined,
      requiredDate: form.requiredDate,
      responseDeadline: form.responseDeadline || undefined,
      leadTimeDays: form.leadTimeDays ? Number(form.leadTimeDays) : undefined,
      urgency: form.urgency.toUpperCase(),
      urgencyJustification: form.urgencyJustification || undefined,
      notes: form.notes || undefined,
    };
    onSave(payload);
  };

  const isAOG = form.urgency === 'aog';
  const canSubmit = form.customerId && form.partNumber && form.quantity > 0 && form.requiredDate && (!isAOG || form.urgencyJustification.trim());

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {rfq ? tx('编辑需求单', 'Edit RFQ') : tx('新建需求单', 'Create RFQ')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('客户', 'Customer')} *</Label>
              <Select value={form.customerId} onValueChange={(v) => updateField('customerId', v)}>
                <SelectTrigger>
                  <SelectValue placeholder={tx('选择客户', 'Select Customer')} />
                </SelectTrigger>
                <SelectContent>
                  {customers?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{tx('件号', 'Part Number')} *</Label>
              <Input
                value={form.partNumber}
                onChange={(e) => updateField('partNumber', e.target.value)}
                placeholder="PN-123-456"
              />
              {ipcFilled && !ipcWarning && (
                <p className="text-xs text-green-600 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" />
                  {tx('IPC 数据已自动填充', 'IPC data auto-filled')}
                </p>
              )}
              {ipcWarning && (
                <p className="text-xs text-red-600 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {ipcWarning}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>{tx('数量', 'Quantity')} *</Label>
              <Input
                type="number"
                min={1}
                value={form.quantity}
                onChange={(e) => updateField('quantity', Number(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('计量单位', 'UOM')}</Label>
              <Select value={form.uom} onValueChange={(v) => updateField('uom', v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EA">EA</SelectItem>
                  <SelectItem value="PCS">PCS</SelectItem>
                  <SelectItem value="SET">SET</SelectItem>
                  <SelectItem value="KG">KG</SelectItem>
                  <SelectItem value="LB">LB</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{tx('状态代码', 'Condition Code')}</Label>
              <Select value={form.conditionCode} onValueChange={(v) => updateField('conditionCode', v as ConditionCode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NE">NE</SelectItem>
                  <SelectItem value="NS">NS</SelectItem>
                  <SelectItem value="OH">OH</SelectItem>
                  <SelectItem value="SV">SV</SelectItem>
                  <SelectItem value="AR">AR</SelectItem>
                  <SelectItem value="FN">FN</SelectItem>
                  <SelectItem value="RP">RP</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tx('航材描述', 'Description')}</Label>
            <Textarea
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('序号', 'Serial Number')}</Label>
              <Input
                value={form.serialNumber}
                onChange={(e) => updateField('serialNumber', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('批次号', 'Batch Number')}</Label>
              <Input
                value={form.batchNumber}
                onChange={(e) => updateField('batchNumber', e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('ATA章节', 'ATA Chapter')}</Label>
              <Input
                value={form.ataChapter}
                onChange={(e) => updateField('ataChapter', e.target.value)}
                placeholder="29-00-00"
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('具体机型', 'Aircraft Model')}</Label>
              <Input
                value={form.aircraftModel}
                onChange={(e) => updateField('aircraftModel', e.target.value)}
                placeholder="B737-800"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('机型', 'Aircraft Type')}</Label>
              <Input
                value={form.aircraftType}
                onChange={(e) => updateField('aircraftType', e.target.value)}
                placeholder="B737"
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('可互换件号', 'Alternate Part Numbers')}</Label>
              <Input
                value={form.alternatePartNumbers}
                onChange={(e) => updateField('alternatePartNumbers', e.target.value)}
                placeholder="PN-123, PN-456"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>{tx('目标价格', 'Target Price')}</Label>
              <Input
                type="number"
                min={0}
                value={form.targetPrice}
                onChange={(e) => updateField('targetPrice', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('货币', 'Currency')}</Label>
              <Select value={form.targetPriceCurrency} onValueChange={(v) => updateField('targetPriceCurrency', v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                  <SelectItem value="CNY">CNY</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{tx('期望交货天数', 'Lead Time (Days)')}</Label>
              <Input
                type="number"
                min={0}
                value={form.leadTimeDays}
                onChange={(e) => updateField('leadTimeDays', e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Checkbox
                id="certRequired"
                checked={form.certificateRequired}
                onCheckedChange={(v) => updateField('certificateRequired', !!v)}
              />
              <Label htmlFor="certRequired" className="cursor-pointer">
                {tx('需要证书', 'Certificate Required')}
              </Label>
            </div>
            {form.certificateRequired && (
              <div className="flex-1 space-y-2">
                <Label>{tx('证书类型', 'Certificate Type')}</Label>
                <Select value={form.certificateType} onValueChange={(v) => updateField('certificateType', v as CertificateType)}>
                  <SelectTrigger>
                    <SelectValue placeholder={tx('选择证书类型', 'Select Type')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AAC-038">AAC-038</SelectItem>
                    <SelectItem value="FAA-8130-3">FAA-8130-3</SelectItem>
                    <SelectItem value="EASA-Form-1">EASA-Form-1</SelectItem>
                    <SelectItem value="COC">COC</SelectItem>
                    <SelectItem value="NONE">NONE</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('需求日期', 'Required Date')} *</Label>
              <Input
                type="date"
                value={form.requiredDate}
                onChange={(e) => updateField('requiredDate', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('报价截止日期', 'Response Deadline')}</Label>
              <Input
                type="date"
                value={form.responseDeadline}
                onChange={(e) => updateField('responseDeadline', e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('紧急度', 'Urgency')}</Label>
              <Select value={form.urgency} onValueChange={(v) => updateField('urgency', v as UrgencyLevel)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">{tx('标准', 'Standard')}</SelectItem>
                  <SelectItem value="urgent">{tx('紧急', 'Urgent')}</SelectItem>
                  <SelectItem value="aog">{tx('AOG紧急', 'AOG Urgent')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {isAOG && (
            <div className="space-y-2">
              <Label>{tx('紧急理由', 'Urgency Justification')} *</Label>
              <Textarea
                value={form.urgencyJustification}
                onChange={(e) => updateField('urgencyJustification', e.target.value)}
                rows={2}
                placeholder={tx('AOG时必须填写', 'Required for AOG')}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label>{tx('备注', 'Notes')}</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => updateField('notes', e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {rfq ? tx('保存', 'Save') : tx('创建', 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RFQManagement() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { rfqs, addRFQ, updateRFQ } = useRFQStore();
  const { mutate: createRFQ } = useCreateRFQ();
  const { mutate: updateRFQApi } = useUpdateRFQ();
  const { mutate: dispatchNotification } = useDispatchNotification();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [urgencyFilter, setUrgencyFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;
  const [selectedRFQ, setSelectedRFQ] = useState<RFQ | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingRFQ, setEditingRFQ] = useState<RFQ | null>(null);

  const filteredRFQs = rfqs.filter((rfq: RFQ) => {
    if (statusFilter !== 'all' && rfq.status !== statusFilter) return false;
    if (urgencyFilter !== 'all' && rfq.urgency !== urgencyFilter) return false;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        rfq.rfqNumber.toLowerCase().includes(query) ||
        rfq.partNumber.toLowerCase().includes(query) ||
        rfq.customerName.toLowerCase().includes(query)
      );
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredRFQs.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedRFQs = filteredRFQs.slice((safePage - 1) * pageSize, safePage * pageSize);

  const stats = {
    total: rfqs.length,
    pending: rfqs.filter((r: RFQ) => r.status === 'pending').length,
    sourcing: rfqs.filter((r: RFQ) => r.status === 'sourcing').length,
    quoting: rfqs.filter((r: RFQ) => r.status === 'quoting').length,
    won: rfqs.filter((r: RFQ) => r.status === 'won').length,
    lost: rfqs.filter((r: RFQ) => r.status === 'lost').length,
  };

  const handleViewDetail = (rfq: RFQ) => {
    setSelectedRFQ(rfq);
    setIsDetailOpen(true);
  };

  const handleStatusChange = (rfqId: string, newStatus: RFQStatus) => {
    const rfq = rfqs.find((r: RFQ) => r.id === rfqId);
    if (rfq) {
      updateRFQ({ ...rfq, status: newStatus });
    }
  };

  const handleConvertToQuote = (rfq: RFQ) => {
    toast.info(tx(`需求单 ${rfq.rfqNumber} 已转入报价阶段，请前往报价管理完成处理。`, `RFQ ${rfq.rfqNumber} has been moved to quoting. Please go to the Quotations page to complete it.`));
    updateRFQ({ ...rfq, status: 'quoting' });
  };

  const handleCreate = () => {
    setEditingRFQ(null);
    setIsFormOpen(true);
  };

  const handleEdit = (rfq: RFQ) => {
    setEditingRFQ(rfq);
    setIsFormOpen(true);
  };

  const handleFormSave = async (data: Record<string, unknown>) => {
    if (editingRFQ) {
      const result = await updateRFQApi({ id: editingRFQ.id, data });
      if (result) {
        updateRFQ(result);
        setIsFormOpen(false);
        setEditingRFQ(null);
      }
    } else {
      const result = await createRFQ(data);
      if (result) {
        addRFQ(result);
        setIsFormOpen(false);
        // AOG 通知触发
        if ((data.urgency as string)?.toLowerCase() === 'aog') {
          void dispatchNotification({
            event: 'AOG_RFQ_CREATED',
            payload: {
              rfqNumber: result.rfqNumber || '',
              partNumber: (data.partNumber as string) || '',
              customerName: (data.customerName as string) || '',
              requiredDate: (data.requiredDate as string) || '',
            },
          });
        }
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Card className="cursor-pointer hover:shadow-sm transition-shadow" onClick={() => { setStatusFilter('all'); setCurrentPage(1); }}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('全部', 'All')}</p>
              <p className="text-xl font-bold">{stats.total}</p>
            </div>
          </CardContent>
        </Card>
        <Card className={cn('cursor-pointer hover:shadow-sm transition-shadow', statusFilter === 'pending' && 'ring-2 ring-yellow-500')} onClick={() => { setStatusFilter('pending'); setCurrentPage(1); }}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('待处理', 'Pending')}</p>
              <p className="text-xl font-bold text-yellow-600">{stats.pending}</p>
            </div>
          </CardContent>
        </Card>
        <Card className={cn('cursor-pointer hover:shadow-sm transition-shadow', statusFilter === 'sourcing' && 'ring-2 ring-blue-500')} onClick={() => { setStatusFilter('sourcing'); setCurrentPage(1); }}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('寻源中', 'Sourcing')}</p>
              <p className="text-xl font-bold text-blue-600">{stats.sourcing}</p>
            </div>
          </CardContent>
        </Card>
        <Card className={cn('cursor-pointer hover:shadow-sm transition-shadow', statusFilter === 'quoting' && 'ring-2 ring-purple-500')} onClick={() => { setStatusFilter('quoting'); setCurrentPage(1); }}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('报价中', 'Quoting')}</p>
              <p className="text-xl font-bold text-purple-600">{stats.quoting}</p>
            </div>
          </CardContent>
        </Card>
        <Card className={cn('cursor-pointer hover:shadow-sm transition-shadow', statusFilter === 'won' && 'ring-2 ring-green-500')} onClick={() => { setStatusFilter('won'); setCurrentPage(1); }}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('已赢单', 'Won')}</p>
              <p className="text-xl font-bold text-emerald-600">{stats.won}</p>
            </div>
          </CardContent>
        </Card>
        <Card className={cn('cursor-pointer hover:shadow-sm transition-shadow', statusFilter === 'lost' && 'ring-2 ring-red-500')} onClick={() => { setStatusFilter('lost'); setCurrentPage(1); }}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('已失单', 'Lost')}</p>
              <p className="text-xl font-bold text-red-600">{stats.lost}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 flex-1">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder={tx('搜索需求单...', 'Search RFQs...')}
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                  className="pl-10"
                />
              </div>
              <Select value={urgencyFilter} onValueChange={(v) => { setUrgencyFilter(v); setCurrentPage(1); }}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder={tx('紧急度', 'Urgency')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tx('全部紧急度', 'All Urgencies')}</SelectItem>
                  <SelectItem value="aog">{tx('AOG紧急', 'AOG Urgent')}</SelectItem>
                  <SelectItem value="urgent">{tx('紧急', 'Urgent')}</SelectItem>
                  <SelectItem value="standard">{tx('标准', 'Standard')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              {(statusFilter !== 'all' || urgencyFilter !== 'all') && (
                <Button variant="ghost" onClick={() => { setStatusFilter('all'); setUrgencyFilter('all'); setCurrentPage(1); }}>
                  {tx('清空筛选', 'Clear Filters')}
                </Button>
              )}
              <Button onClick={handleCreate}>
                <Plus className="w-4 h-4 mr-1" />
                {tx('新建需求单', 'Create RFQ')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx('需求单号', 'RFQ Number')}</TableHead>
                <TableHead>{tx('客户', 'Customer')}</TableHead>
                <TableHead>{tx('件号', 'Part Number')}</TableHead>
                <TableHead>{tx('数量', 'Quantity')}</TableHead>
                <TableHead>{tx('状态', 'Condition')}</TableHead>
                <TableHead>{tx('紧急度', 'Urgency')}</TableHead>
                <TableHead>{tx('状态', 'Status')}</TableHead>
                <TableHead>{tx('创建时间', 'Created')}</TableHead>
                <TableHead>{tx('操作', 'Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRFQs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-gray-500">
                    <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    {tx('未找到需求单', 'No RFQs found')}
                  </TableCell>
                </TableRow>
              ) : (
                paginatedRFQs.map((rfq: RFQ) => (
                  <TableRow key={rfq.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-gray-400" />
                        <span className="font-mono font-medium">{rfq.rfqNumber}</span>
                      </div>
                    </TableCell>
                    <TableCell>{rfq.customerName}</TableCell>
                    <TableCell>
                      <span className="font-mono">{rfq.partNumber}</span>
                    </TableCell>
                    <TableCell>{rfq.quantity} {rfq.uom || 'EA'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono">
                        {rfq.conditionCode || 'NE'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <UrgencyBadge urgency={rfq.urgency} />
                    </TableCell>
                    <TableCell>
                      <RFQStatusBadge status={rfq.status} />
                    </TableCell>
                    <TableCell className="text-sm text-gray-500">
                      {new Date(rfq.createdAt).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => handleViewDetail(rfq)}>
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleEdit(rfq)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <ChevronDown className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleEdit(rfq)}>
                              <Pencil className="w-4 h-4 mr-2" />
                              {tx('编辑', 'Edit')}
                            </DropdownMenuItem>
                            {rfq.status === 'pending' && (
                              <DropdownMenuItem onClick={() => handleStatusChange(rfq.id, 'sourcing')}>
                                <ChevronRight className="w-4 h-4 mr-2" />
                                {tx('开始寻源', 'Start Sourcing')}
                              </DropdownMenuItem>
                            )}
                            {(rfq.status === 'pending' || rfq.status === 'sourcing') && (
                              <DropdownMenuItem onClick={() => handleConvertToQuote(rfq)}>
                                <Send className="w-4 h-4 mr-2" />
                                Create Quotation
                              </DropdownMenuItem>
                            )}
                            {rfq.status === 'quoting' && (
                              <>
                                <DropdownMenuItem onClick={() => handleStatusChange(rfq.id, 'won')}>
                                  <CheckCircle className="w-4 h-4 mr-2 text-green-500" />
                                  Mark as Won
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleStatusChange(rfq.id, 'lost')}>
                                  <XCircle className="w-4 h-4 mr-2 text-red-500" />
                                  Mark as Lost
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {filteredRFQs.length > pageSize && (
            <div className="flex items-center justify-between pt-2">
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

      <RFQDetailDialog
        rfq={selectedRFQ}
        isOpen={isDetailOpen}
        onClose={() => setIsDetailOpen(false)}
      />

      <RFQFormDialog
        rfq={editingRFQ}
        isOpen={isFormOpen}
        onClose={() => {
          setIsFormOpen(false);
          setEditingRFQ(null);
        }}
        onSave={handleFormSave}
      />
    </div>
  );
}
