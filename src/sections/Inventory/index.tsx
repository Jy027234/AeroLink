import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Package,
  MapPin,
  Upload,
  ShoppingCart,
  Loader2,
  ChevronLeft,
  ChevronRight,
  X,
  CheckSquare,
  Square,
  Plus,
  Eye,
  Edit3,
  Clock,
  Shield,
  Truck,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCapabilityStore, useInquiryStore, useUIStore } from '@/store';
import { useInventory } from '@/hooks/useApi';
import { inventoryApi, type InventoryReconciliationResult } from '@/api/client';
import { ipcApi } from '@/api/client';
import { ControlledListExportButton } from '@/components/list/ControlledListExportButton';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { downloadBlob } from '@/lib/downloadBlob';
import { useListUrlNumberState, useListUrlStringState } from '@/lib/listUrlState';
import { toast } from 'sonner';
import type { Inventory, ConditionCode, CertificateType } from '@/types';

const statusConfig: Record<ConditionCode, { label: string; color: string; bgColor: string }> = {
  NE: { label: 'New', color: 'text-green-600', bgColor: 'bg-green-50' },
  NS: { label: 'New Surplus', color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  OH: { label: 'Overhaul', color: 'text-blue-600', bgColor: 'bg-blue-50' },
  SV: { label: 'Serviceable', color: 'text-cyan-600', bgColor: 'bg-cyan-50' },
  AR: { label: 'As Removed', color: 'text-yellow-600', bgColor: 'bg-yellow-50' },
  RP: { label: 'Repairable', color: 'text-orange-600', bgColor: 'bg-orange-50' },
  US: { label: 'Unserviceable', color: 'text-red-600', bgColor: 'bg-red-50' },
  FN: { label: 'Factory New', color: 'text-purple-600', bgColor: 'bg-purple-50' },
};

const certConfig: Record<CertificateType, { label: string; color: string }> = {
  'AAC-038': { label: 'AAC-038', color: 'text-green-600' },
  'FAA-8130-3': { label: 'FAA 8130-3', color: 'text-green-600' },
  'EASA-Form-1': { label: 'EASA Form 1', color: 'text-green-600' },
  COC: { label: 'COC', color: 'text-blue-600' },
  NONE: { label: 'None', color: 'text-red-600' },
};

function InventoryDetailDialog({
  item,
  isOpen,
  onClose,
}: {
  item: Inventory | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  if (!item) return null;

  const status = statusConfig[item.conditionCode];
  const cert = certConfig[item.certificateType];

  const shelfLifeWarning = item.shelfLifeDate
    ? new Date(item.shelfLifeDate) < new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    : false;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5" />
            {item.partNumber}
            {item.lifeLimited && (
              <Badge className="bg-amber-100 text-amber-700 text-xs">
                {tx('时寿件', 'Life Limited')}
              </Badge>
            )}
            {shelfLifeWarning && (
              <Badge className="bg-red-100 text-red-700 text-xs">
                {tx('寿命预警', 'Shelf Life Warning')}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="basic" className="w-full">
          <TabsList className={cn(
            "grid w-full",
            (item.partCategory === 'ROTABLE' || item.partCategory === 'REPAIRABLE')
              ? "grid-cols-4"
              : "grid-cols-2"
          )}>
            <TabsTrigger value="basic">{tx('基本信息', 'Basic')}</TabsTrigger>
            {(item.partCategory === 'ROTABLE' || item.partCategory === 'REPAIRABLE') && (
              <>
                <TabsTrigger value="lifelimited">{tx('时寿件', 'Life Limited')}</TabsTrigger>
                <TabsTrigger value="traceability">{tx('二手件追溯', 'Traceability')}</TabsTrigger>
              </>
            )}
            <TabsTrigger value="storage">{tx('存储与包装', 'Storage')}</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="space-y-4 py-4">
            <div className="flex justify-between items-start p-4 bg-gray-50 rounded-lg">
              <div>
                <p className="font-semibold text-lg">{item.description}</p>
                <p className="text-sm text-gray-500">{item.manufacturer || tx('未知制造商', 'Unknown Manufacturer')}</p>
                <div className="flex items-center gap-2 mt-2">
                  <Badge variant="outline" className={cn('text-xs',
                    item.partCategory === 'ROTABLE' && 'text-purple-600 border-purple-300',
                    item.partCategory === 'REPAIRABLE' && 'text-indigo-600 border-indigo-300',
                    item.partCategory === 'CHEMICAL' && 'text-amber-600 border-amber-300',
                    item.partCategory === 'STANDARD_PART' && 'text-cyan-600 border-cyan-300',
                    item.partCategory === 'RAW_MATERIAL' && 'text-gray-600 border-gray-300',
                    item.partCategory === 'CONSUMABLE' && 'text-green-600 border-green-300',
                  )}>
                    {item.partCategory === 'ROTABLE' && tx('周转件', 'Rotable')}
                    {item.partCategory === 'REPAIRABLE' && tx('可修件', 'Repairable')}
                    {item.partCategory === 'CHEMICAL' && tx('化工品', 'Chemical')}
                    {item.partCategory === 'STANDARD_PART' && tx('标准件', 'Standard')}
                    {item.partCategory === 'RAW_MATERIAL' && tx('原材料', 'Raw Mat')}
                    {item.partCategory === 'CONSUMABLE' && tx('消耗件', 'Consumable')}
                  </Badge>
                  <span className="text-xs text-gray-500">
                    {item.trackingType === 'SERIAL' ? tx('序号管理', 'Serial Tracking') : tx('批次管理', 'Batch Tracking')}
                  </span>
                </div>
              </div>
              <Badge className={cn(status.bgColor, status.color, 'text-xs')}>
                {item.conditionCode}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-400">{tx('件号', 'Part Number')}</p>
                  <p className="font-semibold font-mono">{item.partNumber}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('数量', 'Quantity')}</p>
                  <p className="font-semibold">{item.quantity} {item.unitOfMeasure}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('库位', 'Location')}</p>
                  <p className="font-semibold">{item.location}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('成本', 'Unit Cost')}</p>
                  <p className="font-semibold">${item.unitCost.toLocaleString()}</p>
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-400">{tx('证书类型', 'Certificate Type')}</p>
                  <p className={cn('font-semibold', cert.color)}>{cert.label}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('证书编号', 'Certificate Number')}</p>
                  <p className="font-semibold">{item.certificateNumber || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('序号', 'Serial Number')}</p>
                  <p className="font-semibold font-mono">{item.serialNumber || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('批次号', 'Batch Number')}</p>
                  <p className="font-semibold">{item.batchNumber || '-'}</p>
                </div>
              </div>
            </div>

            {/* 化工品专用信息 */}
            {item.partCategory === 'CHEMICAL' && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
                <p className="font-medium text-amber-800">{tx('化工品信息', 'Chemical Information')}</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-gray-500">{tx('保质期到期日', 'Shelf Life Date')}</p>
                    <p className="font-semibold">{item.shelfLifeDate ? new Date(item.shelfLifeDate).toLocaleDateString() : '-'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">{tx('存储条件', 'Storage Condition')}</p>
                    <p className="font-semibold">{item.storageCondition || '-'}</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-sm text-gray-500">{tx('危险品等级', 'Hazard Class')}</p>
                    <p className="font-semibold">{item.hazardClass || tx('非危险品', 'Non-hazardous')}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">{tx('最低存储温度', 'Min Temp')}</p>
                    <p className="font-semibold">{item.storageTempMin !== undefined ? `${item.storageTempMin}℃` : '-'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">{tx('最高存储温度', 'Max Temp')}</p>
                    <p className="font-semibold">{item.storageTempMax !== undefined ? `${item.storageTempMax}℃` : '-'}</p>
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-gray-400">{tx('ATA章节', 'ATA Chapter')}</p>
                <p className="font-semibold">{item.ataChapter || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{tx('CAGE Code', 'CAGE Code')}</p>
                <p className="font-semibold">{item.manufacturerCageCode || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{tx('原产国', 'Country of Origin')}</p>
                <p className="font-semibold">{item.countryOfOrigin || '-'}</p>
              </div>
            </div>

            {item.alternatePartNumbers && (
              <div>
                <p className="text-sm text-gray-400">{tx('互换件号', 'Alternate Part Numbers')}</p>
                <p className="font-semibold">{item.alternatePartNumbers}</p>
              </div>
            )}

            {item.certificateFileUrl && (
              <div>
                <p className="text-sm text-gray-400">{tx('证书文件', 'Certificate File')}</p>
                <p className="font-semibold text-blue-600">{item.certificateFileUrl}</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="lifelimited" className="space-y-4 py-4">
            <div className="flex items-center gap-2 p-3 bg-amber-50 rounded-lg">
              <Clock className="w-4 h-4 text-amber-600" />
              <span className="text-sm font-medium text-amber-700">
                {item.lifeLimited ? tx('时寿件 - 需监控寿命', 'Life Limited Part - Monitoring Required') : tx('非时寿件', 'Not Life Limited')}
              </span>
            </div>

            {/* 预警状态汇总 */}
            {(shelfLifeWarning || (typeof item.remainingHours === 'number' && item.remainingHours < 500) || (typeof item.remainingCycles === 'number' && item.remainingCycles < 100)) && (
              <div className="p-4 bg-red-50 rounded-lg border border-red-100 space-y-2">
                <p className="text-sm font-semibold text-red-700 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  {tx('预警状态', 'Alert Status')}
                </p>
                <div className="space-y-1">
                  {shelfLifeWarning && (
                    <p className="text-xs text-red-600">
                      {tx(`库存寿命即将到期: ${item.shelfLifeDate ? new Date(item.shelfLifeDate).toLocaleDateString() : '-'}`, `Shelf life expiring: ${item.shelfLifeDate ? new Date(item.shelfLifeDate).toLocaleDateString() : '-'}`)}
                    </p>
                  )}
                  {typeof item.remainingHours === 'number' && item.remainingHours < 500 && (
                    <p className="text-xs text-red-600">
                      {tx(`剩余小时不足: ${item.remainingHours} 小时`, `Remaining hours low: ${item.remainingHours} hrs`)}
                    </p>
                  )}
                  {typeof item.remainingCycles === 'number' && item.remainingCycles < 100 && (
                    <p className="text-xs text-red-600">
                      {tx(`剩余循环不足: ${item.remainingCycles} 循环`, `Remaining cycles low: ${item.remainingCycles} cycles`)}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-400">{tx('总使用小时', 'Total Hours')}</p>
                  <p className="font-semibold">{item.totalHours ?? '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('总使用循环', 'Total Cycles')}</p>
                  <p className="font-semibold">{item.totalCycles ?? '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('制造日期', 'Manufacture Date')}</p>
                  <p className="font-semibold">{item.manufactureDate ? new Date(item.manufactureDate).toLocaleDateString() : '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('上次大修日期', 'Overhaul Date')}</p>
                  <p className="font-semibold">{item.overhaulDate ? new Date(item.overhaulDate).toLocaleDateString() : '-'}</p>
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-400">{tx('剩余小时', 'Remaining Hours')}</p>
                  <p className={cn('font-semibold', typeof item.remainingHours === 'number' && item.remainingHours < 500 && 'text-red-600')}>
                    {item.remainingHours ?? '-'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('剩余循环', 'Remaining Cycles')}</p>
                  <p className={cn('font-semibold', typeof item.remainingCycles === 'number' && item.remainingCycles < 100 && 'text-red-600')}>
                    {item.remainingCycles ?? '-'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('库存寿命到期日', 'Shelf Life Date')}</p>
                  <p className={cn('font-semibold', shelfLifeWarning && 'text-red-600')}>
                    {item.shelfLifeDate ? new Date(item.shelfLifeDate).toLocaleDateString() : '-'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('下次大修到期日', 'Next Overhaul Due')}</p>
                  <p className="font-semibold">{item.nextOverhaulDue ? new Date(item.nextOverhaulDue).toLocaleDateString() : '-'}</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-gray-400">{tx('AD状态', 'AD Status')}</p>
                <p className="font-semibold">{item.adStatus || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{tx('SB状态', 'SB Status')}</p>
                <p className="font-semibold">{item.sbStatus || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{tx('修理方案编号', 'Repair Scheme')}</p>
                <p className="font-semibold">{item.repairScheme || '-'}</p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="traceability" className="space-y-4 py-4">
            <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg">
              <Shield className="w-4 h-4 text-blue-600" />
              <span className="text-sm font-medium text-blue-700">{tx('二手件来源追溯', 'Used Part Traceability')}</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-400">{tx('前运营人', 'Previous Operator')}</p>
                  <p className="font-semibold">{item.previousOperator || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('拆下飞机注册号', 'Removal Aircraft Reg')}</p>
                  <p className="font-semibold font-mono">{item.removalAircraftReg || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('拆下日期', 'Removal Date')}</p>
                  <p className="font-semibold">{item.removalDate ? new Date(item.removalDate).toLocaleDateString() : '-'}</p>
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-400">{tx('拆下原因', 'Removal Reason')}</p>
                  <p className="font-semibold">{item.removalReason || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('无事故声明(NIS)', 'Non-Incident Statement')}</p>
                  <p className="font-semibold">{item.nonIncidentStatement ? tx('有', 'Yes') : tx('无', 'No')}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('军方来源', 'Military Source')}</p>
                  <p className="font-semibold">{item.militarySource ? tx('是', 'Yes') : tx('否', 'No')}</p>
                </div>
              </div>
            </div>

            {item.traceabilityDocs && (
              <div>
                <p className="text-sm text-gray-400">{tx('追溯文件清单', 'Traceability Documents')}</p>
                <div className="bg-gray-50 p-3 rounded-lg mt-1">
                  <pre className="text-sm font-mono whitespace-pre-wrap">
                    {Array.isArray(item.traceabilityDocs)
                      ? item.traceabilityDocs.join('\n')
                      : item.traceabilityDocs}
                  </pre>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="storage" className="space-y-4 py-4">
            <div className="flex items-center gap-2 p-3 bg-green-50 rounded-lg">
              <Truck className="w-4 h-4 text-green-600" />
              <span className="text-sm font-medium text-green-700">{tx('存储与包装条件', 'Storage & Packaging Conditions')}</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-400">{tx('存储条件', 'Storage Condition')}</p>
                <p className="font-semibold">{item.storageCondition || '-'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{tx('ATA-300包装', 'ATA-300 Packaging')}</p>
                <p className="font-semibold">{item.ata300Packaging ? tx('是', 'Yes') : tx('否', 'No')}</p>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tx('关闭', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InventoryFormDialog({
  item,
  isOpen,
  onClose,
  onSave,
}: {
  item: Inventory | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('basic');
  const [ipcFilled, setIpcFilled] = useState(false);
  const [ipcWarning, setIpcWarning] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userEditedFields = useRef<Set<string>>(new Set());

  const [formData, setFormData] = useState({
    partNumber: item?.partNumber || '',
    description: item?.description || '',
    // 航材分类体系
    partCategory: item?.partCategory || 'CONSUMABLE',
    trackingType: item?.trackingType || 'BATCH',
    quantity: item?.quantity ?? 0,
    location: item?.location || '',
    warehouse: item?.warehouse || '',
    shelf: item?.shelf || '',
    conditionCode: item?.conditionCode || 'NE',
    certificateType: item?.certificateType || 'NONE',
    certificateNumber: item?.certificateNumber || '',
    certificateFileUrl: item?.certificateFileUrl || '',
    serialNumber: item?.serialNumber || '',
    batchNumber: item?.batchNumber || '',
    manufacturer: item?.manufacturer || '',
    manufacturerCageCode: item?.manufacturerCageCode || '',
    ataChapter: item?.ataChapter || '',
    alternatePartNumbers: item?.alternatePartNumbers || '',
    unitOfMeasure: item?.unitOfMeasure || 'EA',
    countryOfOrigin: item?.countryOfOrigin || '',
    hsCode: item?.hsCode || '',
    unitCost: item?.unitCost ?? 0,
    type: item?.type || 'own',
    // 时寿件管理（P1）
    lifeLimited: item?.lifeLimited ?? false,
    totalHours: item?.totalHours ?? '',
    totalCycles: item?.totalCycles ?? '',
    remainingHours: item?.remainingHours ?? '',
    remainingCycles: item?.remainingCycles ?? '',
    manufactureDate: item?.manufactureDate ? item.manufactureDate.slice(0, 10) : '',
    shelfLifeDate: item?.shelfLifeDate ? item.shelfLifeDate.slice(0, 10) : '',
    overhaulDate: item?.overhaulDate ? item.overhaulDate.slice(0, 10) : '',
    nextOverhaulDue: item?.nextOverhaulDue ? item.nextOverhaulDue.slice(0, 10) : '',
    adStatus: item?.adStatus || '',
    sbStatus: item?.sbStatus || '',
    repairScheme: item?.repairScheme || '',
    // 二手件追溯（P2）
    previousOperator: item?.previousOperator || '',
    removalAircraftReg: item?.removalAircraftReg || '',
    removalDate: item?.removalDate ? item.removalDate.slice(0, 10) : '',
    removalReason: item?.removalReason || '',
    nonIncidentStatement: item?.nonIncidentStatement ?? false,
    militarySource: item?.militarySource ?? false,
    traceabilityDocs: item?.traceabilityDocs || '',
    // 存储与包装（P2）
    storageCondition: item?.storageCondition || '',
    ata300Packaging: item?.ata300Packaging ?? false,
    // 化工品专用字段
    shelfLifeDays: item?.shelfLifeDays ?? '',
    storageTempMin: item?.storageTempMin ?? '',
    storageTempMax: item?.storageTempMax ?? '',
    hazardClass: item?.hazardClass || '',
  });

  useEffect(() => {
    if (!formData.partNumber || formData.partNumber.length < 3) {
      setIpcFilled(false);
      setIpcWarning('');
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const data = await ipcApi.getByPartNumber(formData.partNumber);
        if (data) {
          setFormData((prev) => {
            const next = { ...prev };
            if (!userEditedFields.current.has('description') && data.description) {
              next.description = data.description;
            }
            if (!userEditedFields.current.has('ataChapter') && data.ataChapter) {
              next.ataChapter = data.ataChapter;
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
  }, [formData.partNumber, locale]);

  useEffect(() => {
    setFormData({
      partNumber: item?.partNumber || '',
      description: item?.description || '',
      partCategory: item?.partCategory || 'CONSUMABLE',
      trackingType: item?.trackingType || 'BATCH',
      quantity: item?.quantity ?? 0,
      location: item?.location || '',
      warehouse: item?.warehouse || '',
      shelf: item?.shelf || '',
      conditionCode: item?.conditionCode || 'NE',
      certificateType: item?.certificateType || 'NONE',
      certificateNumber: item?.certificateNumber || '',
      certificateFileUrl: item?.certificateFileUrl || '',
      serialNumber: item?.serialNumber || '',
      batchNumber: item?.batchNumber || '',
      manufacturer: item?.manufacturer || '',
      manufacturerCageCode: item?.manufacturerCageCode || '',
      ataChapter: item?.ataChapter || '',
      alternatePartNumbers: item?.alternatePartNumbers || '',
      unitOfMeasure: item?.unitOfMeasure || 'EA',
      countryOfOrigin: item?.countryOfOrigin || '',
      hsCode: item?.hsCode || '',
      unitCost: item?.unitCost ?? 0,
      type: item?.type || 'own',
      lifeLimited: item?.lifeLimited ?? false,
      totalHours: item?.totalHours ?? '',
      totalCycles: item?.totalCycles ?? '',
      remainingHours: item?.remainingHours ?? '',
      remainingCycles: item?.remainingCycles ?? '',
      manufactureDate: item?.manufactureDate ? item.manufactureDate.slice(0, 10) : '',
      shelfLifeDate: item?.shelfLifeDate ? item.shelfLifeDate.slice(0, 10) : '',
      overhaulDate: item?.overhaulDate ? item.overhaulDate.slice(0, 10) : '',
      nextOverhaulDue: item?.nextOverhaulDue ? item.nextOverhaulDue.slice(0, 10) : '',
      adStatus: item?.adStatus || '',
      sbStatus: item?.sbStatus || '',
      repairScheme: item?.repairScheme || '',
      previousOperator: item?.previousOperator || '',
      removalAircraftReg: item?.removalAircraftReg || '',
      removalDate: item?.removalDate ? item.removalDate.slice(0, 10) : '',
      removalReason: item?.removalReason || '',
      nonIncidentStatement: item?.nonIncidentStatement ?? false,
      militarySource: item?.militarySource ?? false,
      traceabilityDocs: item?.traceabilityDocs || '',
      storageCondition: item?.storageCondition || '',
      ata300Packaging: item?.ata300Packaging ?? false,
      shelfLifeDays: item?.shelfLifeDays ?? '',
      storageTempMin: item?.storageTempMin ?? '',
      storageTempMax: item?.storageTempMax ?? '',
      hazardClass: item?.hazardClass || '',
    });
    userEditedFields.current.clear();
    setIpcFilled(false);
    setIpcWarning('');
  }, [item]);

  const handleSubmit = async () => {
    if (!formData.partNumber || !formData.description) {
      toast.warning(tx('件号和描述不能为空', 'Part number and description are required'));
      return;
    }

    // 按分类校验必填字段
    if (formData.trackingType === 'SERIAL' && !formData.serialNumber) {
      toast.warning(tx('序号件必须填写序号', 'Serial number is required for serial-tracked items'));
      return;
    }
    if (formData.trackingType === 'BATCH' && !formData.batchNumber) {
      toast.warning(tx('批次件必须填写批次号', 'Batch number is required for batch-tracked items'));
      return;
    }
    if (formData.partCategory === 'CHEMICAL') {
      if (!formData.shelfLifeDate) {
        toast.warning(tx('化工品必须填写保质期到期日', 'Shelf life date is required for chemicals'));
        return;
      }
      // 化工品保质期校验：入库时剩余保质期必须 ≥ 30 天
      const shelfLife = new Date(formData.shelfLifeDate);
      const minRequiredDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      if (shelfLife < minRequiredDate) {
        toast.warning(tx('化工品保质期必须至少剩余 30 天，当前不满足入库要求', 'Chemical shelf life must be at least 30 days from today to be accepted into inventory'));
        return;
      }
      if (!formData.storageCondition) {
        toast.warning(tx('化工品必须填写存储条件', 'Storage condition is required for chemicals'));
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        ...formData,
        quantity: Number(formData.quantity),
        unitCost: Number(formData.unitCost),
        shelfLifeDays: formData.shelfLifeDays === '' ? undefined : Number(formData.shelfLifeDays),
        storageTempMin: formData.storageTempMin === '' ? undefined : Number(formData.storageTempMin),
        storageTempMax: formData.storageTempMax === '' ? undefined : Number(formData.storageTempMax),
        totalHours: formData.totalHours === '' ? undefined : Number(formData.totalHours),
        totalCycles: formData.totalCycles === '' ? undefined : Number(formData.totalCycles),
        remainingHours: formData.remainingHours === '' ? undefined : Number(formData.remainingHours),
        remainingCycles: formData.remainingCycles === '' ? undefined : Number(formData.remainingCycles),
      };

      if (item) {
        await inventoryApi.update(item.id, payload);
        toast.success(tx('库存已更新', 'Inventory updated'));
      } else {
        await inventoryApi.create(payload);
        toast.success(tx('库存已创建', 'Inventory created'));
      }
      onSave();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : tx('保存失败', 'Save failed');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {item ? tx('编辑库存', 'Edit Inventory') : tx('新增库存', 'Add Inventory')}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className={cn(
            "grid w-full",
            formData.partCategory === 'ROTABLE'
              ? "grid-cols-4"
              : "grid-cols-2"
          )}>
            <TabsTrigger value="basic">{tx('基本信息', 'Basic')}</TabsTrigger>
            {formData.partCategory === 'ROTABLE' && (
              <>
                <TabsTrigger value="lifelimited">{tx('时寿件', 'Life Limited')}</TabsTrigger>
                <TabsTrigger value="traceability">{tx('二手件追溯', 'Traceability')}</TabsTrigger>
              </>
            )}
            <TabsTrigger value="storage">{tx('存储与包装', 'Storage')}</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="space-y-4 py-4">
            {/* 保质期预警横幅 */}
            {formData.partCategory === 'CHEMICAL' && formData.shelfLifeDate && (() => {
              const shelfLife = new Date(formData.shelfLifeDate);
              const now = new Date();
              const daysUntilExpiry = Math.ceil((shelfLife.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
              if (daysUntilExpiry <= 30) {
                return (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-600" />
                    <span className="text-sm font-medium text-red-700">
                      {tx(`⚠️ 该化工品保质期将于 ${shelfLife.toLocaleDateString()} 到期（剩余 ${daysUntilExpiry} 天），已接近过期，请优先出库或处理。`, `⚠️ This chemical expires on ${shelfLife.toLocaleDateString()} (${daysUntilExpiry} days left). Near expiry - prioritize usage or disposal.`)}
                    </span>
                  </div>
                );
              }
              if (daysUntilExpiry <= 90) {
                return (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                    <span className="text-sm font-medium text-amber-700">
                      {tx(`🟡 该化工品保质期将于 ${shelfLife.toLocaleDateString()} 到期（剩余 ${daysUntilExpiry} 天），请关注。`, `🟡 This chemical expires on ${shelfLife.toLocaleDateString()} (${daysUntilExpiry} days left). Please monitor.`)}
                    </span>
                  </div>
                );
              }
              return null;
            })()}

            {/* 航材分类选择器 */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('航材分类 *', 'Part Category *')}</Label>
                <Select
                  value={formData.partCategory}
                  onValueChange={(v) => {
                    const category = v as Inventory['partCategory'];
                    const tracking = category === 'ROTABLE' ? 'SERIAL' : 'BATCH';
                    setFormData({
                      ...formData,
                      partCategory: category,
                      trackingType: tracking,
                      quantity: tracking === 'SERIAL' ? 1 : formData.quantity,
                      serialNumber: tracking === 'SERIAL' ? formData.serialNumber : '',
                      batchNumber: tracking === 'BATCH' ? formData.batchNumber : '',
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ROTABLE">{tx('周转件 (Rotable)', 'Rotable')}</SelectItem>
                    <SelectItem value="CONSUMABLE">{tx('一般消耗件 (Consumable)', 'Consumable')}</SelectItem>
                    <SelectItem value="CHEMICAL">{tx('化工品 (Chemical)', 'Chemical')}</SelectItem>
                    <SelectItem value="STANDARD_PART">{tx('标准件 (Standard Part)', 'Standard Part')}</SelectItem>
                    <SelectItem value="RAW_MATERIAL">{tx('原材料 (Raw Material)', 'Raw Material')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tx('追踪方式 *', 'Tracking Type *')}</Label>
                <Select
                  value={formData.trackingType}
                  onValueChange={(v) => {
                    const tracking = v as Inventory['trackingType'];
                    setFormData({
                      ...formData,
                      trackingType: tracking,
                      quantity: tracking === 'SERIAL' ? 1 : formData.quantity,
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SERIAL">{tx('序号管理 (Serial)', 'Serial Number')}</SelectItem>
                    <SelectItem value="BATCH">{tx('批次管理 (Batch)', 'Batch')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('件号 *', 'Part Number *')}</Label>
                <Input
                  value={formData.partNumber}
                  onChange={(e) => {
                    userEditedFields.current.delete('partNumber');
                    setFormData({ ...formData, partNumber: e.target.value });
                  }}
                  placeholder={tx('输入件号', 'Enter part number')}
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
              <div className="space-y-2">
                <Label>{tx('描述 *', 'Description *')}</Label>
                <Input
                  value={formData.description}
                  onChange={(e) => {
                    userEditedFields.current.add('description');
                    setFormData({ ...formData, description: e.target.value });
                  }}
                  placeholder={tx('输入描述', 'Enter description')}
                />
              </div>
            </div>

            {/* 通用标识字段 */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('制造商', 'Manufacturer')}</Label>
                <Input
                  value={formData.manufacturer}
                  onChange={(e) => setFormData({ ...formData, manufacturer: e.target.value })}
                  placeholder={tx('输入制造商', 'Enter manufacturer')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('CAGE Code', 'CAGE Code')}</Label>
                <Input
                  value={formData.manufacturerCageCode}
                  onChange={(e) => setFormData({ ...formData, manufacturerCageCode: e.target.value })}
                  placeholder={tx('输入CAGE Code', 'Enter CAGE code')}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('ATA章节', 'ATA Chapter')}</Label>
                <Input
                  value={formData.ataChapter}
                  onChange={(e) => {
                    userEditedFields.current.add('ataChapter');
                    setFormData({ ...formData, ataChapter: e.target.value });
                  }}
                  placeholder={tx('输入ATA章节', 'Enter ATA chapter')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('互换件号', 'Alternate Part Numbers')}</Label>
                <Input
                  value={formData.alternatePartNumbers}
                  onChange={(e) => {
                    userEditedFields.current.add('alternatePartNumbers');
                    setFormData({ ...formData, alternatePartNumbers: e.target.value });
                  }}
                  placeholder={tx('输入互换件号（JSON格式）', 'Enter alternate part numbers (JSON)')}
                />
              </div>
            </div>

            {/* 核心标识：按追踪方式显示序号或批次 */}
            <div className="grid grid-cols-2 gap-4">
              {formData.trackingType === 'SERIAL' ? (
                <div className="space-y-2">
                  <Label>{tx('序号 *', 'Serial Number *')}</Label>
                  <Input
                    value={formData.serialNumber}
                    onChange={(e) => setFormData({ ...formData, serialNumber: e.target.value })}
                    placeholder={tx('输入序号', 'Enter serial number')}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>{tx('批次号 *', 'Batch Number *')}</Label>
                  <Input
                    value={formData.batchNumber}
                    onChange={(e) => setFormData({ ...formData, batchNumber: e.target.value })}
                    placeholder={tx('输入批次号', 'Enter batch number')}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label>{tx('数量', 'Quantity')}</Label>
                <Input
                  type="number"
                  value={formData.quantity}
                  disabled={formData.trackingType === 'SERIAL'}
                  onChange={(e) => setFormData({ ...formData, quantity: Number(e.target.value) })}
                />
                {formData.trackingType === 'SERIAL' && (
                  <p className="text-xs text-gray-500">{tx('序号件数量固定为 1', 'Serial items quantity is fixed at 1')}</p>
                )}
              </div>
            </div>

            {/* 化工品专用字段 */}
            {formData.partCategory === 'CHEMICAL' && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-4">
                <p className="font-medium text-amber-800 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  {tx('化工品专用信息', 'Chemical-specific Information')}
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{tx('保质期到期日 *', 'Shelf Life Date *')}</Label>
                    <Input
                      type="date"
                      value={formData.shelfLifeDate}
                      onChange={(e) => setFormData({ ...formData, shelfLifeDate: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{tx('存储条件 *', 'Storage Condition *')}</Label>
                    <Select
                      value={formData.storageCondition}
                      onValueChange={(v) => setFormData({ ...formData, storageCondition: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={tx('选择存储条件', 'Select storage condition')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Ambient">{tx('常温区 (15-35℃)', 'Ambient (15-35℃)')}</SelectItem>
                        <SelectItem value="AirConditioned">{tx('空调区 (15-18℃)', 'Air Conditioned (15-18℃)')}</SelectItem>
                        <SelectItem value="LowTemp">{tx('低温区 (5-8℃)', 'Low Temp (5-8℃)')}</SelectItem>
                        <SelectItem value="UltraLowTemp">{tx('超低温区 (-18℃)', 'Ultra Low Temp (-18℃)')}</SelectItem>
                        <SelectItem value="DangerousGoods">{tx('危险品区', 'Dangerous Goods Zone')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>{tx('危险品等级', 'Hazard Class')}</Label>
                    <Select
                      value={formData.hazardClass}
                      onValueChange={(v) => setFormData({ ...formData, hazardClass: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={tx('选择等级', 'Select class')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NON_HAZARDOUS">{tx('非危险品', 'Non-hazardous')}</SelectItem>
                        <SelectItem value="CLASS_3">{tx('CLASS 3 - 易燃液体', 'Class 3 - Flammable Liquid')}</SelectItem>
                        <SelectItem value="CLASS_8">{tx('CLASS 8 - 腐蚀品', 'Class 8 - Corrosive')}</SelectItem>
                        <SelectItem value="CLASS_9">{tx('CLASS 9 - 杂项危险品', 'Class 9 - Miscellaneous')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>{tx('最低存储温度 (℃)', 'Min Storage Temp (℃)')}</Label>
                    <Input
                      type="number"
                      value={formData.storageTempMin}
                      onChange={(e) => setFormData({ ...formData, storageTempMin: e.target.value })}
                      placeholder={tx('例如：5', 'e.g. 5')}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{tx('最高存储温度 (℃)', 'Max Storage Temp (℃)')}</Label>
                    <Input
                      type="number"
                      value={formData.storageTempMax}
                      onChange={(e) => setFormData({ ...formData, storageTempMax: e.target.value })}
                      placeholder={tx('例如：35', 'e.g. 35')}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{tx('状态代码', 'Condition Code')}</Label>
                <Select
                  value={formData.conditionCode}
                  onValueChange={(v) => setFormData({ ...formData, conditionCode: v as ConditionCode })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NE">{tx('NE - 新品', 'NE - New')}</SelectItem>
                    <SelectItem value="NS">{tx('NS - 新件剩余', 'NS - New Surplus')}</SelectItem>
                    <SelectItem value="OH">{tx('OH - 翻修', 'OH - Overhaul')}</SelectItem>
                    <SelectItem value="SV">{tx('SV - 可用', 'SV - Serviceable')}</SelectItem>
                    <SelectItem value="AR">{tx('AR - 拆下件', 'AR - As Removed')}</SelectItem>
                    <SelectItem value="RP">{tx('RP - 可修', 'RP - Repairable')}</SelectItem>
                    <SelectItem value="US">{tx('US - 不可用', 'US - Unserviceable')}</SelectItem>
                    <SelectItem value="FN">{tx('FN - 全新', 'FN - Factory New')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tx('证书类型', 'Certificate Type')}</Label>
                <Select
                  value={formData.certificateType}
                  onValueChange={(v) => setFormData({ ...formData, certificateType: v as CertificateType })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AAC-038">AAC-038</SelectItem>
                    <SelectItem value="FAA-8130-3">FAA 8130-3</SelectItem>
                    <SelectItem value="EASA-Form-1">EASA Form 1</SelectItem>
                    <SelectItem value="COC">COC</SelectItem>
                    <SelectItem value="NONE">NONE</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tx('类型', 'Type')}</Label>
                <Select
                  value={formData.type}
                  onValueChange={(v) => setFormData({ ...formData, type: v as Inventory['type'] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="own">{tx('自有', 'Owned')}</SelectItem>
                    <SelectItem value="in_transit">{tx('在途', 'In Transit')}</SelectItem>
                    <SelectItem value="virtual">{tx('虚拟', 'Virtual')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('证书编号', 'Certificate Number')}</Label>
                <Input
                  value={formData.certificateNumber}
                  onChange={(e) => setFormData({ ...formData, certificateNumber: e.target.value })}
                  placeholder={tx('输入证书编号', 'Enter certificate number')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('证书文件路径', 'Certificate File URL')}</Label>
                <Input
                  value={formData.certificateFileUrl}
                  onChange={(e) => setFormData({ ...formData, certificateFileUrl: e.target.value })}
                  placeholder={tx('输入文件路径', 'Enter file URL')}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{tx('库位', 'Location')}</Label>
                <Input
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                  placeholder={tx('输入库位', 'Enter location')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('仓库', 'Warehouse')}</Label>
                <Input
                  value={formData.warehouse}
                  onChange={(e) => setFormData({ ...formData, warehouse: e.target.value })}
                  placeholder={tx('输入仓库', 'Enter warehouse')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('货架', 'Shelf')}</Label>
                <Input
                  value={formData.shelf}
                  onChange={(e) => setFormData({ ...formData, shelf: e.target.value })}
                  placeholder={tx('输入货架', 'Enter shelf')}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{tx('成本', 'Unit Cost')}</Label>
                <Input
                  type="number"
                  value={formData.unitCost}
                  onChange={(e) => setFormData({ ...formData, unitCost: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('计量单位', 'UOM')}</Label>
                <Select
                  value={formData.unitOfMeasure}
                  onValueChange={(v) => setFormData({ ...formData, unitOfMeasure: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="EA">{tx('EA (个)', 'EA (Each)')}</SelectItem>
                    <SelectItem value="SET">{tx('SET (套)', 'SET')}</SelectItem>
                    <SelectItem value="PAIR">{tx('PAIR (对)', 'PAIR')}</SelectItem>
                    <SelectItem value="KG">KG</SelectItem>
                    <SelectItem value="M">{tx('M (米)', 'M (Meter)')}</SelectItem>
                    <SelectItem value="FT">{tx('FT (英尺)', 'FT (Foot)')}</SelectItem>
                    <SelectItem value="RL">{tx('RL (卷)', 'RL (Reel)')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tx('原产国', 'Country of Origin')}</Label>
                <Input
                  value={formData.countryOfOrigin}
                  onChange={(e) => setFormData({ ...formData, countryOfOrigin: e.target.value })}
                  placeholder={tx('输入原产国', 'Enter country of origin')}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('海关编码', 'HS Code')}</Label>
                <Input
                  value={formData.hsCode}
                  onChange={(e) => setFormData({ ...formData, hsCode: e.target.value })}
                  placeholder={tx('输入HS Code', 'Enter HS code')}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="lifelimited" className="space-y-4 py-4">
            <div className="flex items-center space-x-2 p-3 bg-amber-50 rounded-lg">
              <Checkbox
                id="lifeLimited"
                checked={formData.lifeLimited}
                onCheckedChange={(v) => setFormData({ ...formData, lifeLimited: v === true })}
              />
              <Label htmlFor="lifeLimited" className="font-medium text-amber-700">
                {tx('时寿件 (Life Limited Part)', 'Life Limited Part')}
              </Label>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('总使用小时', 'Total Hours')}</Label>
                <Input
                  type="number"
                  value={formData.totalHours}
                  onChange={(e) => setFormData({ ...formData, totalHours: e.target.value })}
                  placeholder={tx('输入总使用小时', 'Enter total hours')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('剩余小时', 'Remaining Hours')}</Label>
                <Input
                  type="number"
                  value={formData.remainingHours}
                  onChange={(e) => setFormData({ ...formData, remainingHours: e.target.value })}
                  placeholder={tx('输入剩余小时', 'Enter remaining hours')}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('总使用循环', 'Total Cycles')}</Label>
                <Input
                  type="number"
                  value={formData.totalCycles}
                  onChange={(e) => setFormData({ ...formData, totalCycles: e.target.value })}
                  placeholder={tx('输入总使用循环', 'Enter total cycles')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('剩余循环', 'Remaining Cycles')}</Label>
                <Input
                  type="number"
                  value={formData.remainingCycles}
                  onChange={(e) => setFormData({ ...formData, remainingCycles: e.target.value })}
                  placeholder={tx('输入剩余循环', 'Enter remaining cycles')}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('制造日期', 'Manufacture Date')}</Label>
                <Input
                  type="date"
                  value={formData.manufactureDate}
                  onChange={(e) => setFormData({ ...formData, manufactureDate: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('库存寿命到期日', 'Shelf Life Date')}</Label>
                <Input
                  type="date"
                  value={formData.shelfLifeDate}
                  onChange={(e) => setFormData({ ...formData, shelfLifeDate: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('上次大修日期', 'Overhaul Date')}</Label>
                <Input
                  type="date"
                  value={formData.overhaulDate}
                  onChange={(e) => setFormData({ ...formData, overhaulDate: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('下次大修到期日', 'Next Overhaul Due')}</Label>
                <Input
                  type="date"
                  value={formData.nextOverhaulDue}
                  onChange={(e) => setFormData({ ...formData, nextOverhaulDue: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{tx('AD状态', 'AD Status')}</Label>
                <Input
                  value={formData.adStatus}
                  onChange={(e) => setFormData({ ...formData, adStatus: e.target.value })}
                  placeholder={tx('输入AD状态', 'Enter AD status')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('SB状态', 'SB Status')}</Label>
                <Input
                  value={formData.sbStatus}
                  onChange={(e) => setFormData({ ...formData, sbStatus: e.target.value })}
                  placeholder={tx('输入SB状态', 'Enter SB status')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('修理方案编号', 'Repair Scheme')}</Label>
                <Input
                  value={formData.repairScheme}
                  onChange={(e) => setFormData({ ...formData, repairScheme: e.target.value })}
                  placeholder={tx('输入修理方案编号', 'Enter repair scheme')}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="traceability" className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('前运营人', 'Previous Operator')}</Label>
                <Input
                  value={formData.previousOperator}
                  onChange={(e) => setFormData({ ...formData, previousOperator: e.target.value })}
                  placeholder={tx('输入前运营人', 'Enter previous operator')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('拆下飞机注册号', 'Removal Aircraft Reg')}</Label>
                <Input
                  value={formData.removalAircraftReg}
                  onChange={(e) => setFormData({ ...formData, removalAircraftReg: e.target.value })}
                  placeholder={tx('输入拆下飞机注册号', 'Enter removal aircraft reg')}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('拆下日期', 'Removal Date')}</Label>
                <Input
                  type="date"
                  value={formData.removalDate}
                  onChange={(e) => setFormData({ ...formData, removalDate: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('拆下原因', 'Removal Reason')}</Label>
                <Input
                  value={formData.removalReason}
                  onChange={(e) => setFormData({ ...formData, removalReason: e.target.value })}
                  placeholder={tx('输入拆下原因', 'Enter removal reason')}
                />
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="nonIncidentStatement"
                  checked={formData.nonIncidentStatement}
                  onCheckedChange={(v) => setFormData({ ...formData, nonIncidentStatement: v === true })}
                />
                <Label htmlFor="nonIncidentStatement">{tx('无事故声明(NIS)', 'Non-Incident Statement (NIS)')}</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="militarySource"
                  checked={formData.militarySource}
                  onCheckedChange={(v) => setFormData({ ...formData, militarySource: v === true })}
                />
                <Label htmlFor="militarySource">{tx('军方来源', 'Military Source')}</Label>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{tx('追溯文件清单', 'Traceability Documents')}</Label>
              <Input
                value={formData.traceabilityDocs}
                onChange={(e) => setFormData({ ...formData, traceabilityDocs: e.target.value })}
                placeholder={tx('输入追溯文件清单（JSON格式）', 'Enter traceability docs (JSON)')}
              />
            </div>
          </TabsContent>

          <TabsContent value="storage" className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('存储条件', 'Storage Condition')}</Label>
                <Select
                  value={formData.storageCondition}
                  onValueChange={(v) => setFormData({ ...formData, storageCondition: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={tx('选择存储条件', 'Select storage condition')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Ambient">{tx('常温 (Ambient)', 'Ambient')}</SelectItem>
                    <SelectItem value="Refrigerated">{tx('冷藏 (Refrigerated)', 'Refrigerated')}</SelectItem>
                    <SelectItem value="Climate-Controlled">{tx('恒温 (Climate-Controlled)', 'Climate-Controlled')}</SelectItem>
                    <SelectItem value="Freezer">{tx('冷冻 (Freezer)', 'Freezer')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center space-x-2 pt-6">
                <Checkbox
                  id="ata300Packaging"
                  checked={formData.ata300Packaging}
                  onCheckedChange={(v) => setFormData({ ...formData, ata300Packaging: v === true })}
                />
                <Label htmlFor="ata300Packaging">{tx('ATA-300包装', 'ATA-300 Packaging')}</Label>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !formData.partNumber || !formData.description}>
            {saving ? tx('保存中...', 'Saving...') : tx('保存', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InventoryCenter() {
  const { addInquiry } = useInquiryStore();
  const can = useCapabilityStore((state) => state.can);
  const inventorySearchPreset = useUIStore((state) => state.inventorySearchPreset);
  const clearInventorySearchPreset = useUIStore((state) => state.clearInventorySearchPreset);
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const canReconcileInventory = can('inventory.reconcile');
  const descriptionMap: Record<string, string> = {
    'Fuel Pump Assembly': '燃油泵总成',
    'Fuel Pump Assembly (Overhauled)': '燃油泵总成（大修）',
    'Hydraulic Valve': '液压阀',
    'Engine Filter': '发动机滤芯',
    'Cabin Pressure Sensor': '客舱压力传感器',
    'Landing Gear Component': '起落架组件',
    'Avionics Module': '航电模块',
  };

  // Filter state
  const [searchQuery, setSearchQuery] = useListUrlStringState('search', '');
  const [statusFilter, setStatusFilter] = useListUrlStringState('conditionCode', 'all');
  const [certFilter, setCertFilter] = useListUrlStringState('certificateType', 'all');
  const [typeFilter, setTypeFilter] = useListUrlStringState('type', 'all');
  const [categoryFilter, setCategoryFilter] = useListUrlStringState('partCategory', 'all');
  const [locationFilter, setLocationFilter] = useListUrlStringState('location', '');

  // Pagination state
  const [currentPage, setCurrentPage] = useListUrlNumberState('page', 1);
  const [pageSize, setPageSize] = useListUrlNumberState('limit', 50);
  const [sort, setSort] = useListUrlStringState('sort', 'partNumber');
  const [direction, setDirection] = useListUrlStringState('direction', 'asc');

  // Selected items
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [selectedItemMap, setSelectedItemMap] = useState<Map<string, Inventory>>(new Map());

  // Dialog state
  const [selectedItem, setSelectedItem] = useState<Inventory | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [reconciliation, setReconciliation] = useState<InventoryReconciliationResult | null>(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);

  const hasSearchPreset = Boolean(inventorySearchPreset);
  const activeSearchQuery = hasSearchPreset ? inventorySearchPreset : searchQuery;
  const activeStatusFilter = hasSearchPreset ? 'all' : statusFilter;
  const activeCertFilter = hasSearchPreset ? 'all' : certFilter;
  const activeTypeFilter = hasSearchPreset ? 'all' : typeFilter;
  const activeCategoryFilter = hasSearchPreset ? 'all' : categoryFilter;
  const activeLocationFilter = hasSearchPreset ? '' : locationFilter;
  const activeCurrentPage = hasSearchPreset ? 1 : currentPage;
  const {
    data: inventory,
    loading: inventoryLoading,
    pagination: inventoryPagination,
    summary: inventorySummary,
    refetch: refetchInventory,
  } = useInventory({
    search: activeSearchQuery,
    conditionCode: activeStatusFilter === 'all' ? undefined : activeStatusFilter,
    certificateType: activeCertFilter === 'all' ? undefined : activeCertFilter,
    type: activeTypeFilter === 'all' ? undefined : activeTypeFilter,
    partCategory: activeCategoryFilter === 'all' ? undefined : activeCategoryFilter,
    location: activeLocationFilter || undefined,
    page: activeCurrentPage,
    limit: pageSize,
    sort,
    direction: direction === 'desc' ? 'desc' : 'asc',
  });

  const consumeSearchPreset = () => {
    if (hasSearchPreset) {
      clearInventorySearchPreset();
    }
  };

  const handleViewDetail = (item: Inventory) => {
    setSelectedItem(item);
    setIsDetailOpen(true);
  };

  const handleEdit = (item: Inventory) => {
    setSelectedItem(item);
    setIsFormOpen(true);
  };

  const handleAddNew = () => {
    setSelectedItem(null);
    setIsFormOpen(true);
  };

  const handleSave = () => {
    void refetchInventory();
  };

  const runReconciliation = async () => {
    setReconciliationLoading(true);
    try {
      const result = await inventoryApi.getReconciliation();
      setReconciliation(result);
      if (result.status === 'PASS') {
        toast.success(tx('库存迁移快照对账通过', 'Inventory migration snapshot reconciled'));
      } else {
        toast.warning(tx(`发现 ${result.mismatches.length} 个件号差异`, `${result.mismatches.length} part-number mismatches found`));
      }
    } catch (error) {
      console.error('Failed to reconcile inventory:', error);
      toast.error(tx('库存对账失败，请确认权限和数据库结构', 'Inventory reconciliation failed; check permissions and schema'));
    } finally {
      setReconciliationLoading(false);
    }
  };

  const inventoryList = useMemo(() => inventory || [], [inventory]);

  // Collect unique locations for filtering
  const locations = useMemo(() => {
    if (inventorySummary?.locations?.length) {
      return inventorySummary.locations;
    }
    const locs = new Set(inventoryList.map(i => i.location).filter(Boolean));
    return Array.from(locs).sort();
  }, [inventoryList, inventorySummary?.locations]);

  // Filter inventory
  const filteredInventory = useMemo(() => {
    return inventoryList.filter((item) => {
      // Part number search (supports fuzzy search)
      if (activeSearchQuery && !item.partNumber.toLowerCase().includes(activeSearchQuery.toLowerCase())) {
        return false;
      }
      // Status filter
      if (activeStatusFilter !== 'all' && item.conditionCode !== activeStatusFilter) {
        return false;
      }
      // Certificate filter
      if (activeCertFilter !== 'all' && item.certificateType !== activeCertFilter) {
        return false;
      }
      // Type filter
      if (activeTypeFilter !== 'all' && item.type !== activeTypeFilter) {
        return false;
      }
      // Category filter
      if (activeCategoryFilter !== 'all' && item.partCategory !== activeCategoryFilter) {
        return false;
      }
      // Location filter
      if (activeLocationFilter && item.location !== activeLocationFilter) {
        return false;
      }
      return true;
    });
  }, [inventoryList, activeSearchQuery, activeStatusFilter, activeCertFilter, activeTypeFilter, activeCategoryFilter, activeLocationFilter]);

  // Pagination is performed by the server; keep the local list as a safety filter
  // for legacy responses while preserving the server total for navigation.
  const totalRecords = inventoryPagination?.total ?? filteredInventory.length;
  const totalPages = inventoryPagination?.totalPages ?? Math.ceil(totalRecords / pageSize);
  const paginatedInventory = filteredInventory;
  const rangeStart = totalRecords === 0 ? 0 : (activeCurrentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(activeCurrentPage * pageSize, totalRecords);

  useEffect(() => {
    const maxPage = Math.max(1, totalPages);
    if (!hasSearchPreset && currentPage > maxPage) {
      setCurrentPage(maxPage);
    }
  }, [currentPage, hasSearchPreset, totalPages]);

  // Stats by category
  const categoryStats = {
    total: inventorySummary?.total ?? inventoryList.length,
    rotable: inventorySummary?.rotable ?? inventoryList.filter((i) => i.partCategory === 'ROTABLE').length,
    chemical: inventorySummary?.chemical ?? inventoryList.filter((i) => i.partCategory === 'CHEMICAL').length,
    standardPart: inventorySummary?.standardPart ?? inventoryList.filter((i) => i.partCategory === 'STANDARD_PART').length,
    rawMaterial: inventorySummary?.rawMaterial ?? inventoryList.filter((i) => i.partCategory === 'RAW_MATERIAL').length,
    consumable: inventorySummary?.consumable ?? inventoryList.filter((i) => i.partCategory === 'CONSUMABLE').length,
    totalValue: inventorySummary?.totalValue ?? inventoryList.reduce((sum, i) => sum + i.unitCost * i.quantity, 0),
  };

  // Select current page
  const toggleSelectAll = () => {
    const currentPageIds = new Set(paginatedInventory.map(i => i.id));
    const allSelected = paginatedInventory.every(i => selectedItems.has(i.id));

    if (allSelected) {
      // Clear current page selection
      const newSelected = new Set(selectedItems);
      const newSelectedItemMap = new Map(selectedItemMap);
      currentPageIds.forEach(id => newSelected.delete(id));
      currentPageIds.forEach(id => newSelectedItemMap.delete(id));
      setSelectedItems(newSelected);
      setSelectedItemMap(newSelectedItemMap);
    } else {
      // Select all current page items
      const newSelected = new Set(selectedItems);
      const newSelectedItemMap = new Map(selectedItemMap);
      currentPageIds.forEach(id => newSelected.add(id));
      paginatedInventory.forEach((item) => newSelectedItemMap.set(item.id, item));
      setSelectedItems(newSelected);
      setSelectedItemMap(newSelectedItemMap);
    }
  };

  // Toggle single item
  const toggleSelection = (id: string) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(id)) {
      newSelected.delete(id);
      const newSelectedItemMap = new Map(selectedItemMap);
      newSelectedItemMap.delete(id);
      setSelectedItemMap(newSelectedItemMap);
    } else {
      newSelected.add(id);
      const selectedItem = paginatedInventory.find((item) => item.id === id);
      if (selectedItem) {
        setSelectedItemMap(new Map(selectedItemMap).set(id, selectedItem));
      }
    }
    setSelectedItems(newSelected);
  };

  // Clear filters
  const clearFilters = () => {
    consumeSearchPreset();
    setSearchQuery('');
    setStatusFilter('all');
    setCertFilter('all');
    setTypeFilter('all');
    setCategoryFilter('all');
    setLocationFilter('');
    setCurrentPage(1);
  };

  const handleExport = async (scope: 'page' | 'filtered') => {
    const blob = await inventoryApi.exportCsv({
      search: activeSearchQuery,
      conditionCode: activeStatusFilter === 'all' ? undefined : activeStatusFilter,
      certificateType: activeCertFilter === 'all' ? undefined : activeCertFilter,
      type: activeTypeFilter === 'all' ? undefined : activeTypeFilter,
      partCategory: activeCategoryFilter === 'all' ? undefined : activeCategoryFilter,
      location: activeLocationFilter || undefined,
      page: activeCurrentPage,
      limit: pageSize,
      sort,
      direction: direction === 'desc' ? 'desc' : 'asc',
      scope,
      ...(scope === 'filtered' ? { confirm: 'full' as const, maxRows: 5000 } : {}),
    });
    downloadBlob(blob, `inventory-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  // Clear selection
  const clearSelection = () => {
    setSelectedItems(new Set());
    setSelectedItemMap(new Map());
  };

  // Resolve selected item data
  const selectedItemsData = Array.from(selectedItemMap.values());

  const handleAddToInquiry = () => {
    if (selectedItemsData.length === 0) return;

    const inquirySuffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    const newInquiry = {
      id: `inq_${inquirySuffix.toLowerCase()}`,
      inquiryNumber: `INQ-${today}-${inquirySuffix}`,
      supplierId: selectedItemsData[0].supplierId || 'multiple',
      supplierName: selectedItemsData[0].supplierName || tx('多个供应商', 'Multiple Suppliers'),
      items: selectedItemsData.map((item) => ({
        partNumber: item.partNumber,
        quantity: 1,
        requiredDate: new Date().toISOString().split('T')[0],
        certificateRequired: true,
      })),
      isAOG: false,
      status: 'draft' as const,
      createdAt: new Date().toISOString(),
    };

    addInquiry(newInquiry);
    clearSelection();
    toast.success(tx(`询价单 ${newInquiry.inquiryNumber} 已创建。`, `Inquiry ${newInquiry.inquiryNumber} has been created.`));
  };

  // Any active filters
  const hasFilters = Boolean(
    activeSearchQuery ||
      activeStatusFilter !== 'all' ||
      activeCertFilter !== 'all' ||
      activeTypeFilter !== 'all' ||
      activeCategoryFilter !== 'all' ||
      activeLocationFilter
  );

  if (inventoryLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-primary" />
        <span className="ml-2 text-gray-500">{tx('加载中...', 'Loading...')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card className={cn("hover:shadow-sm transition-shadow cursor-pointer", activeCategoryFilter === 'all' && "ring-2 ring-blue-400")} onClick={() => setCategoryFilter('all')}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('全部', 'All')}</p>
              <p className="text-xl font-bold">{categoryStats.total}</p>
            </div>
          </CardContent>
        </Card>
        <Card className={cn("hover:shadow-sm transition-shadow cursor-pointer", activeCategoryFilter === 'ROTABLE' && "ring-2 ring-blue-400")} onClick={() => setCategoryFilter('ROTABLE')}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('周转件', 'Rotable')}</p>
              <p className="text-xl font-bold text-purple-600">{categoryStats.rotable}</p>
            </div>
          </CardContent>
        </Card>
        <Card className={cn("hover:shadow-sm transition-shadow cursor-pointer", activeCategoryFilter === 'CHEMICAL' && "ring-2 ring-blue-400")} onClick={() => setCategoryFilter('CHEMICAL')}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('化工品', 'Chemical')}</p>
              <p className="text-xl font-bold text-amber-600">{categoryStats.chemical}</p>
            </div>
          </CardContent>
        </Card>
        <Card className={cn("hover:shadow-sm transition-shadow cursor-pointer", activeCategoryFilter === 'STANDARD_PART' && "ring-2 ring-blue-400")} onClick={() => setCategoryFilter('STANDARD_PART')}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('标准件', 'Standard')}</p>
              <p className="text-xl font-bold text-cyan-600">{categoryStats.standardPart}</p>
            </div>
          </CardContent>
        </Card>
        <Card className={cn("hover:shadow-sm transition-shadow cursor-pointer", activeCategoryFilter === 'RAW_MATERIAL' && "ring-2 ring-blue-400")} onClick={() => setCategoryFilter('RAW_MATERIAL')}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('原材料', 'Raw Mat')}</p>
              <p className="text-xl font-bold text-gray-600">{categoryStats.rawMaterial}</p>
            </div>
          </CardContent>
        </Card>
        <Card className={cn("hover:shadow-sm transition-shadow cursor-pointer", activeCategoryFilter === 'CONSUMABLE' && "ring-2 ring-blue-400")} onClick={() => setCategoryFilter('CONSUMABLE')}>
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('消耗件', 'Consumable')}</p>
              <p className="text-xl font-bold text-green-600">{categoryStats.consumable}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Category filter tabs */}
      <div className="flex flex-wrap gap-2">
        {[
          { key: 'all', label: tx('全部', 'All'), count: categoryStats.total },
          { key: 'ROTABLE', label: tx('周转件', 'Rotable'), count: categoryStats.rotable },
          { key: 'CHEMICAL', label: tx('化工品', 'Chemical'), count: categoryStats.chemical },
          { key: 'STANDARD_PART', label: tx('标准件', 'Standard Part'), count: categoryStats.standardPart },
          { key: 'RAW_MATERIAL', label: tx('原材料', 'Raw Material'), count: categoryStats.rawMaterial },
          { key: 'CONSUMABLE', label: tx('消耗件', 'Consumable'), count: categoryStats.consumable },
        ].map((cat) => (
          <Button
            key={cat.key}
            variant={activeCategoryFilter === cat.key ? 'default' : 'outline'}
            size="sm"
            onClick={() => { consumeSearchPreset(); setCategoryFilter(cat.key); setCurrentPage(1); }}
            className={cn(
              activeCategoryFilter === cat.key && "bg-brand-primary hover:bg-brand-primary-hover"
            )}
          >
            {cat.label}
            <span className="ml-1.5 text-xs opacity-70">({cat.count})</span>
          </Button>
        ))}
      </div>

      {/* Filter bar */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder={tx('搜索件号...', 'Search part number...')}
              value={activeSearchQuery}
              onChange={(e) => {
                consumeSearchPreset();
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-10"
            />
          </div>

          {/* Status filter */}
          <Select value={activeStatusFilter} onValueChange={(v) => { consumeSearchPreset(); setStatusFilter(v); setCurrentPage(1); }}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder={tx('状态', 'Status')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tx('全部状态', 'All Statuses')}</SelectItem>
              <SelectItem value="NE">New</SelectItem>
              <SelectItem value="NS">New Surplus</SelectItem>
              <SelectItem value="OH">Overhaul</SelectItem>
              <SelectItem value="SV">Serviceable</SelectItem>
              <SelectItem value="AR">As Removed</SelectItem>
              <SelectItem value="RP">Repairable</SelectItem>
              <SelectItem value="US">Unserviceable</SelectItem>
              <SelectItem value="FN">Factory New</SelectItem>
            </SelectContent>
          </Select>

          {/* Certificate filter */}
          <Select value={activeCertFilter} onValueChange={(v) => { consumeSearchPreset(); setCertFilter(v); setCurrentPage(1); }}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder={tx('证书', 'Certificate')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tx('全部证书', 'All Certificates')}</SelectItem>
              <SelectItem value="AAC-038">AAC-038</SelectItem>
              <SelectItem value="FAA-8130-3">FAA 8130-3</SelectItem>
              <SelectItem value="EASA-Form-1">EASA Form 1</SelectItem>
              <SelectItem value="COC">COC</SelectItem>
              <SelectItem value="NONE">{tx('无证书', 'No Certificate')}</SelectItem>
            </SelectContent>
          </Select>

          {/* Type filter */}
          <Select value={activeTypeFilter} onValueChange={(v) => { consumeSearchPreset(); setTypeFilter(v); setCurrentPage(1); }}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder={tx('类型', 'Type')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tx('全部类型', 'All Types')}</SelectItem>
              <SelectItem value="own">{tx('自有', 'Owned')}</SelectItem>
              <SelectItem value="in_transit">{tx('在途', 'In Transit')}</SelectItem>
              <SelectItem value="virtual">{tx('虚拟', 'Virtual')}</SelectItem>
            </SelectContent>
          </Select>

          {/* Location filter */}
          {locations.length > 0 && (
            <Select value={activeLocationFilter || 'all'} onValueChange={(v) => { consumeSearchPreset(); setLocationFilter(v === 'all' ? '' : v); setCurrentPage(1); }}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder={tx('库位', 'Location')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tx('全部库位', 'All Locations')}</SelectItem>
                {locations.map(loc => (
                  <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={sort} onValueChange={(v) => { consumeSearchPreset(); setSort(v); setCurrentPage(1); }}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder={tx('排序字段', 'Sort')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="partNumber">{tx('件号', 'Part number')}</SelectItem>
              <SelectItem value="createdAt">{tx('创建时间', 'Created')}</SelectItem>
              <SelectItem value="quantity">{tx('数量', 'Quantity')}</SelectItem>
              <SelectItem value="unitCost">{tx('单位成本', 'Unit cost')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={direction} onValueChange={(v) => { consumeSearchPreset(); setDirection(v); setCurrentPage(1); }}>
            <SelectTrigger className="w-28">
              <SelectValue placeholder={tx('顺序', 'Order')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="asc">{tx('升序', 'Asc')}</SelectItem>
              <SelectItem value="desc">{tx('降序', 'Desc')}</SelectItem>
            </SelectContent>
          </Select>

          {/* Clear filters */}
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="w-4 h-4 mr-1" />
              {tx('清空筛选', 'Clear Filters')}
            </Button>
          )}

          <div className="flex-1" />

          {/* Actions */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleAddNew}>
              <Plus className="w-4 h-4 mr-1" />
              {tx('新增库存', 'Add Inventory')}
            </Button>
            <Button variant="outline" size="sm">
              <Upload className="w-4 h-4 mr-1" />
              {tx('导入', 'Import')}
            </Button>
            {can('inventory.export') && <ControlledListExportButton locale={locale} onExport={handleExport} />}
            {canReconcileInventory && (
              <Button variant="outline" size="sm" onClick={() => void runReconciliation()} disabled={reconciliationLoading}>
                <RefreshCw className={cn('w-4 h-4 mr-1', reconciliationLoading && 'animate-spin')} />
                {tx('运行对账', 'Run Reconciliation')}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {reconciliation && (
        <Card className={reconciliation.status === 'PASS' ? 'border-green-200 bg-green-50/50' : 'border-amber-200 bg-amber-50/50'}>
          <CardContent className="p-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {reconciliation.status === 'PASS' ? (
                  <CheckCircle className="h-5 w-5 text-green-600" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
                )}
                <span className="font-medium">
                  {reconciliation.status === 'PASS'
                    ? tx('库存迁移快照对账通过', 'Inventory migration snapshot reconciled')
                    : tx('库存迁移快照存在差异', 'Inventory migration snapshot mismatches detected')}
                </span>
              </div>
              <span className="text-sm text-gray-600">
                {tx('件号', 'Part numbers')}: {reconciliation.checkedPartNumbers} · {tx('旧模型总量', 'Legacy total')}: {reconciliation.legacyTotal} · {tx('严格比较旧量', 'Strict legacy total')}: {reconciliation.comparedLegacyTotal} · {tx('迁移映射明细量', 'Mapped detail total')}: {reconciliation.comparedDetailTotal} · {tx('明细总量', 'Detail total')}: {reconciliation.detailTotal}
              </span>
            </div>
            {reconciliation.transactionalLegacyDetails > 0 && (
              <div className="text-sm text-slate-600">
                {tx(
                  `已有流水的历史映射明细 ${reconciliation.transactionalLegacyDetails} 条（当前数量 ${reconciliation.transactionalLegacyQuantity}），其运行时变动不与冻结旧快照直接比较。`,
                  `${reconciliation.transactionalLegacyDetails} ledger-backed mapped details (${reconciliation.transactionalLegacyQuantity} units) are excluded from direct comparison with the frozen legacy snapshot.`,
                )}
              </div>
            )}
            {reconciliation.canonicalOnlyDetails > 0 && (
              <div className="text-sm text-slate-600">
                {tx(
                  `切换后新增明细 ${reconciliation.canonicalOnlyDetails} 条（数量 ${reconciliation.canonicalOnlyQuantity}），不参与旧模型快照差异判断。`,
                  `${reconciliation.canonicalOnlyDetails} post-cutover canonical details (${reconciliation.canonicalOnlyQuantity} units) are excluded from legacy snapshot comparison.`,
                )}
              </div>
            )}
            {reconciliation.mismatches.length > 0 && (
              <div className="text-sm text-amber-800">
                {reconciliation.mismatches.slice(0, 5).map((mismatch) => (
                  <div key={mismatch.partNumber}>
                    {mismatch.partNumber}: {mismatch.legacyQuantity} → {mismatch.detailQuantity} (Δ {mismatch.delta})
                  </div>
                ))}
                {reconciliation.mismatches.length > 5 && (
                  <div>{tx(`还有 ${reconciliation.mismatches.length - 5} 个差异未展开`, `${reconciliation.mismatches.length - 5} more mismatches hidden`)}</div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 数据表格 */}
      <Card>
        <div className="px-4 py-2 border-b flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">
              {tx('共', 'Total')} {totalRecords} {tx('条记录', 'records')}
              {selectedItems.size > 0 && (
                <span className="ml-2 text-blue-600">{selectedItems.size} {tx('已选', 'selected')}</span>
              )}
            </span>
            {selectedItems.size > 0 && (
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                {tx('清空选择', 'Clear Selection')}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">{tx('每页', 'Per page')}</span>
            <Select value={String(pageSize)} onValueChange={(v) => { consumeSearchPreset(); setPageSize(Number(v)); setCurrentPage(1); }}>
              <SelectTrigger className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="20">20</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-sm text-gray-500">{tx('条', 'records')}</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead className="w-12">
                  <button
                    onClick={toggleSelectAll}
                    className="flex items-center justify-center"
                  >
                    {paginatedInventory.length > 0 && paginatedInventory.every(i => selectedItems.has(i.id)) ? (
                      <CheckSquare className="w-5 h-5 text-blue-600" />
                    ) : (
                      <Square className="w-5 h-5 text-gray-400" />
                    )}
                  </button>
                </TableHead>
                <TableHead>{tx('件号', 'Part Number')}</TableHead>
                <TableHead>{tx('描述', 'Description')}</TableHead>
                {activeCategoryFilter === 'all' && (
                  <TableHead>{tx('分类', 'Category')}</TableHead>
                )}
                <TableHead className="text-center">{tx('状态', 'Status')}</TableHead>
                <TableHead className="text-right">{tx('数量', 'Quantity')}</TableHead>
                <TableHead>{tx('库位', 'Location')}</TableHead>
                <TableHead className="text-right">{tx('成本', 'Cost')}</TableHead>
                <TableHead className="text-center">{tx('证书', 'Certificate')}</TableHead>
                <TableHead>{tx('类型', 'Type')}</TableHead>
                <TableHead>{tx('制造商', 'Manufacturer')}</TableHead>
                {(activeCategoryFilter === 'all' || activeCategoryFilter === 'ROTABLE' || activeCategoryFilter === 'REPAIRABLE') && (
                  <TableHead>{tx('序号', 'Serial')}</TableHead>
                )}
                {(activeCategoryFilter === 'all' || activeCategoryFilter === 'CHEMICAL' || activeCategoryFilter === 'STANDARD_PART' || activeCategoryFilter === 'RAW_MATERIAL' || activeCategoryFilter === 'CONSUMABLE') && (
                  <TableHead>{tx('批次号', 'Batch')}</TableHead>
                )}
                {(activeCategoryFilter === 'ROTABLE' || activeCategoryFilter === 'REPAIRABLE') && (
                  <>
                    <TableHead>{tx('剩余小时', 'Rem Hrs')}</TableHead>
                    <TableHead>{tx('剩余循环', 'Rem Cyc')}</TableHead>
                  </>
                )}
                {activeCategoryFilter === 'CHEMICAL' && (
                  <>
                    <TableHead>{tx('保质期', 'Shelf Life')}</TableHead>
                    <TableHead>{tx('存储条件', 'Storage')}</TableHead>
                  </>
                )}
                <TableHead>{tx('ATA', 'ATA')}</TableHead>
                <TableHead>{tx('UOM', 'UOM')}</TableHead>
                <TableHead className="text-right">{tx('操作', 'Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedInventory.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={20} className="text-center py-12 text-gray-500">
                    <Package className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                    <p>{tx('没有匹配记录', 'No matching records')}</p>
                    {hasFilters && (
                        <Button variant="outline" className="mt-4" onClick={clearFilters}>
                        {tx('清空筛选条件', 'Clear filter conditions')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                paginatedInventory.map((item: Inventory) => {
                  const status = statusConfig[item.conditionCode];
                  const cert = certConfig[item.certificateType];
                  const isSelected = selectedItems.has(item.id);
                  const statusLabelMap: Record<ConditionCode, string> = {
                    NE: tx('新品', 'New'),
                    NS: tx('新件剩余', 'New Surplus'),
                    OH: tx('翻修件', 'Overhaul'),
                    SV: tx('可用件', 'Serviceable'),
                    AR: tx('拆下件', 'As Removed'),
                    RP: tx('可修件', 'Repairable'),
                    US: tx('不可用', 'Unserviceable'),
                    FN: tx('全新', 'Factory New'),
                  };
                  const certLabelMap: Record<CertificateType, string> = {
                    'AAC-038': 'AAC-038',
                    'FAA-8130-3': 'FAA 8130-3',
                    'EASA-Form-1': 'EASA Form 1',
                    COC: 'COC',
                    NONE: tx('无', 'None'),
                  };

                  return (
                    <TableRow
                      key={item.id}
                      className={cn(
                        'cursor-pointer hover:bg-gray-50',
                        isSelected && 'bg-blue-50'
                      )}
                      onClick={() => toggleSelection(item.id)}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => toggleSelection(item.id)}
                          className="flex items-center justify-center"
                        >
                          {isSelected ? (
                            <CheckSquare className="w-5 h-5 text-blue-600" />
                          ) : (
                            <Square className="w-5 h-5 text-gray-400" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <p className="font-mono font-medium">{item.partNumber}</p>
                          {item.lifeLimited && (
                            <Badge className="bg-amber-100 text-amber-700 text-[10px] px-1 py-0" title={tx('时寿件', 'Life Limited Part')}>
                              {tx('时寿', 'LLP')}
                            </Badge>
                          )}
                          {item.shelfLifeDate && new Date(item.shelfLifeDate) < new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) && (
                            <Badge className="bg-red-100 text-red-700 text-[10px] px-1 py-0" title={tx(`库存寿命到期日: ${new Date(item.shelfLifeDate).toLocaleDateString()}`, `Shelf life expires: ${new Date(item.shelfLifeDate).toLocaleDateString()}`)}>
                              {tx('寿命预警', 'Expiring')}
                            </Badge>
                          )}
                          {typeof item.remainingHours === 'number' && item.remainingHours < 500 && (
                            <Badge className="bg-orange-100 text-orange-700 text-[10px] px-1 py-0" title={tx(`剩余小时: ${item.remainingHours}`, `Remaining hours: ${item.remainingHours}`)}>
                              {tx('小时预警', 'Hrs')}
                            </Badge>
                          )}
                          {typeof item.remainingCycles === 'number' && item.remainingCycles < 100 && (
                            <Badge className="bg-orange-100 text-orange-700 text-[10px] px-1 py-0" title={tx(`剩余循环: ${item.remainingCycles}`, `Remaining cycles: ${item.remainingCycles}`)}>
                              {tx('循环预警', 'Cyc')}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm text-gray-600 max-w-xs truncate">
                          {locale === 'zh-CN' ? (descriptionMap[item.description] || item.description) : item.description}
                        </p>
                      </TableCell>
                      {activeCategoryFilter === 'all' && (
                        <TableCell>
                          <Badge variant="outline" className={cn('text-xs', 
                            item.partCategory === 'ROTABLE' && 'text-purple-600 border-purple-300',
                            item.partCategory === 'REPAIRABLE' && 'text-indigo-600 border-indigo-300',
                            item.partCategory === 'CHEMICAL' && 'text-amber-600 border-amber-300',
                            item.partCategory === 'STANDARD_PART' && 'text-cyan-600 border-cyan-300',
                            item.partCategory === 'RAW_MATERIAL' && 'text-gray-600 border-gray-300',
                            item.partCategory === 'CONSUMABLE' && 'text-green-600 border-green-300',
                          )}>
                            {item.partCategory === 'ROTABLE' && tx('周转件', 'Rotable')}
                            {item.partCategory === 'REPAIRABLE' && tx('可修件', 'Repairable')}
                            {item.partCategory === 'CHEMICAL' && tx('化工品', 'Chemical')}
                            {item.partCategory === 'STANDARD_PART' && tx('标准件', 'Standard')}
                            {item.partCategory === 'RAW_MATERIAL' && tx('原材料', 'Raw Mat')}
                            {item.partCategory === 'CONSUMABLE' && tx('消耗件', 'Consumable')}
                          </Badge>
                        </TableCell>
                      )}
                      <TableCell className="text-center">
                        <Badge className={cn(status.bgColor, status.color, 'text-xs')}>
                          {statusLabelMap[item.conditionCode] || status.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {item.quantity} {tx('件', 'ea')}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-sm text-gray-600">
                          <MapPin className="w-3 h-3" />
                          {locale === 'zh-CN'
                            ? (item.location === 'VIRTUAL' ? '虚拟库' : item.location === 'IN-TRANSIT' ? '在途' : item.location)
                            : item.location}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        ${item.unitCost.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-center">
                        <span className={cn('text-xs font-medium', cert.color)}>
                          {certLabelMap[item.certificateType] || cert.label}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={cn(
                          'text-xs',
                          item.type === 'own' && 'text-green-600',
                          item.type === 'in_transit' && 'text-yellow-600',
                          item.type === 'virtual' && 'text-blue-600'
                        )}>
                          {item.type === 'own' ? tx('自有', 'Owned') : item.type === 'in_transit' ? tx('在途', 'In Transit') : tx('虚拟', 'Virtual')}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-gray-600">{item.manufacturer || '-'}</span>
                      </TableCell>
                      {(activeCategoryFilter === 'all' || activeCategoryFilter === 'ROTABLE' || activeCategoryFilter === 'REPAIRABLE') && (
                        <TableCell>
                          <span className="text-xs font-mono text-gray-600">{item.serialNumber || '-'}</span>
                        </TableCell>
                      )}
                      {(activeCategoryFilter === 'all' || activeCategoryFilter === 'CHEMICAL' || activeCategoryFilter === 'STANDARD_PART' || activeCategoryFilter === 'RAW_MATERIAL' || activeCategoryFilter === 'CONSUMABLE') && (
                        <TableCell>
                          <span className="text-xs font-mono text-gray-600">{item.batchNumber || '-'}</span>
                        </TableCell>
                      )}
                      {(activeCategoryFilter === 'ROTABLE' || activeCategoryFilter === 'REPAIRABLE') && (
                        <>
                          <TableCell>
                            <span className={cn('text-xs', typeof item.remainingHours === 'number' && item.remainingHours < 500 && 'text-red-600 font-medium')}>
                              {item.remainingHours ?? '-'}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className={cn('text-xs', typeof item.remainingCycles === 'number' && item.remainingCycles < 100 && 'text-red-600 font-medium')}>
                              {item.remainingCycles ?? '-'}
                            </span>
                          </TableCell>
                        </>
                      )}
                      {activeCategoryFilter === 'CHEMICAL' && (
                        <>
                          <TableCell>
                            <span className={cn('text-xs', item.shelfLifeDate && new Date(item.shelfLifeDate) < new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) && 'text-red-600 font-medium')}>
                              {item.shelfLifeDate ? new Date(item.shelfLifeDate).toLocaleDateString() : '-'}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-gray-600">{item.storageCondition || '-'}</span>
                          </TableCell>
                        </>
                      )}
                      <TableCell>
                        <span className="text-xs text-gray-600">{item.ataChapter || '-'}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-gray-600">{item.unitOfMeasure}</span>
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => handleViewDetail(item)}
                          >
                            <Eye className="w-4 h-4 text-gray-500" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => handleEdit(item)}
                          >
                            <Edit3 className="w-4 h-4 text-gray-500" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="p-4 border-t flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-sm text-gray-500">
              {tx('显示', 'Showing')} {rangeStart}-{rangeEnd} {tx('共', 'of')} {totalRecords}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { consumeSearchPreset(); setCurrentPage(Math.max(1, activeCurrentPage - 1)); }}
                disabled={activeCurrentPage === 1}
              >
                <ChevronLeft className="w-4 h-4" />
                <span className="hidden sm:inline">{tx('上一页', 'Previous')}</span>
              </Button>
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (activeCurrentPage <= 3) {
                    pageNum = i + 1;
                  } else if (activeCurrentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = activeCurrentPage - 2 + i;
                  }
                  return (
                    <Button
                      key={pageNum}
                      variant={activeCurrentPage === pageNum ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => { consumeSearchPreset(); setCurrentPage(pageNum); }}
                      className="w-9 h-9"
                    >
                      {pageNum}
                    </Button>
                  );
                })}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { consumeSearchPreset(); setCurrentPage(Math.min(totalPages, activeCurrentPage + 1)); }}
                disabled={activeCurrentPage === totalPages}
              >
                <span className="hidden sm:inline">{tx('下一页', 'Next')}</span>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Selected item action bar */}
      {selectedItems.size > 0 && (
        <div className="fixed bottom-6 left-72 right-6 bg-white border rounded-lg shadow-lg p-4 flex items-center justify-between z-30">
          <div className="flex items-center gap-4">
            <span className="font-medium">{selectedItems.size} {tx('已选', 'selected')}</span>
            <span className="text-gray-500">
              {tx('总价值', 'Total value')}: ${selectedItemsData.reduce((sum, i) => sum + i.unitCost * i.quantity, 0).toLocaleString()}
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={clearSelection}>
              {tx('清空选择', 'Clear Selection')}
            </Button>
            <Button className="bg-brand-primary hover:bg-brand-primary-hover" onClick={handleAddToInquiry}>
              <ShoppingCart className="w-4 h-4 mr-1" />
              {tx('创建询价单', 'Create Inquiry')}
            </Button>
          </div>
        </div>
      )}
      {/* Dialogs */}
      <InventoryDetailDialog
        item={selectedItem}
        isOpen={isDetailOpen}
        onClose={() => setIsDetailOpen(false)}
      />
      <InventoryFormDialog
        item={selectedItem}
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSave={handleSave}
      />
    </div>
  );
}
