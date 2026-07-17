import { useState, useEffect } from 'react';
import {
  Truck,
  Star,
  Mail,
  Phone,
  MapPin,
  Plus,
  Search,
  Eye,
  Edit3,
  BarChart3,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Wrench,
  FlaskConical,
  ShieldCheck,
  Thermometer,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useSuppliers } from '@/hooks/useApi';
import { supplierApi } from '@/api/client';
import { ControlledListExportButton } from '@/components/list/ControlledListExportButton';
import { useTranslation } from '@/i18n';
import { getSupplierCapabilityProfile } from '@/lib/supplierCapability';
import { useCapabilityStore, useSupplierFollowUpStore } from '@/store';
import { cn } from '@/lib/utils';
import { downloadBlob } from '@/lib/downloadBlob';
import { useListUrlNumberState, useListUrlStringState } from '@/lib/listUrlState';
import { toast } from 'sonner';
import type { Supplier, SupplierFollowUpLog, SupplierFollowUpOutcome, SupplierType } from '@/types';

const levelConfig: Record<Supplier['level'], { label: string; color: string; bgColor: string; stars: number }> = {
  S: { label: 'Strategic Partner', color: 'text-purple-600', bgColor: 'bg-purple-50', stars: 5 },
  A: { label: 'Qualified Supplier', color: 'text-green-600', bgColor: 'bg-green-50', stars: 4 },
  B: { label: 'Use with Caution', color: 'text-yellow-600', bgColor: 'bg-yellow-50', stars: 3 },
  C: { label: 'Blacklisted', color: 'text-red-600', bgColor: 'bg-red-50', stars: 1 },
};

const supplierTypeConfig: Record<SupplierType, { label: string; color: string; bgColor: string }> = {
  OEM: { label: 'OEM', color: 'text-blue-600', bgColor: 'bg-blue-50' },
  MRO: { label: 'MRO', color: 'text-indigo-600', bgColor: 'bg-indigo-50' },
  Distributor: { label: 'Distributor', color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  Broker: { label: 'Broker', color: 'text-amber-600', bgColor: 'bg-amber-50' },
  '145RepairStation': { label: '145 Station', color: 'text-cyan-600', bgColor: 'bg-cyan-50' },
};

function SupplierLevelBadge({ level }: { level: Supplier['level'] }) {
  const config = levelConfig[level];
  const { locale } = useTranslation();
  const labelMap: Record<Supplier['level'], string> = {
    S: locale === 'zh-CN' ? '战略合作' : 'Strategic Partner',
    A: locale === 'zh-CN' ? '合格供应商' : 'Qualified Supplier',
    B: locale === 'zh-CN' ? '谨慎使用' : 'Use with Caution',
    C: locale === 'zh-CN' ? '黑名单' : 'Blacklisted',
  };
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      {labelMap[level] || config.label}
    </Badge>
  );
}

function SupplierTypeBadge({ type }: { type: SupplierType }) {
  const config = supplierTypeConfig[type] || supplierTypeConfig.Distributor;
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      {config.label}
    </Badge>
  );
}

function getExpiryWarningColor(expiryDate?: string): { color: string; label: string } | null {
  if (!expiryDate) return null;
  const now = new Date();
  const expiry = new Date(expiryDate);
  const diffDays = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return { color: 'text-red-600', label: '已过期' };
  if (diffDays <= 30) return { color: 'text-red-500', label: `${diffDays}天后到期` };
  if (diffDays <= 90) return { color: 'text-amber-500', label: `${diffDays}天后到期` };
  return { color: 'text-green-500', label: `${diffDays}天后到期` };
}

function getCapabilityBadgeClass(mode: 'auto' | 'manual' | 'blocked') {
  if (mode === 'auto') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (mode === 'manual') return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-red-50 text-red-700 border-red-200';
}

function getCapabilityLabel(mode: 'auto' | 'manual' | 'blocked', tx: (zh: string, en: string) => string) {
  if (mode === 'auto') return tx('自动询价', 'Auto inquiry');
  if (mode === 'manual') return tx('人工跟进', 'Manual follow-up');
  return tx('待补资料', 'Profile incomplete');
}

function getNextActionText(action: string, tx: (zh: string, en: string) => string) {
  switch (action) {
    case 'auto_inquiry_ready':
      return tx('可直接进入自动询价', 'Ready for automated inquiry');
    case 'activate_and_send':
      return tx('激活后可自动询价', 'Activate before automated inquiry');
    case 'portal_follow_up':
      return tx('建议通过供应商门户催报', 'Follow up through the supplier portal');
    case 'wechat_follow_up':
      return tx('建议通过微信催报', 'Follow up through WeChat');
    case 'whatsapp_follow_up':
      return tx('建议通过 WhatsApp 跟进', 'Follow up through WhatsApp');
    case 'phone_follow_up':
      return tx('建议电话催报', 'Follow up by phone');
    case 'contact_missing':
      return tx('需补齐人工跟进联系方式', 'Add a reachable contact channel first');
    case 'manual_follow_up':
      return tx('请电话或微信跟进', 'Reach out by phone or chat');
    case 'reactivate_supplier':
      return tx('需恢复供应商状态', 'Re-enable supplier status');
    default:
      return tx('请补充邮箱或电话', 'Add email or phone to continue');
  }
}

function getManualActionText(
  action: string | undefined,
  tx: (zh: string, en: string) => string
) {
  switch (action) {
    case 'portal_follow_up':
      return tx('门户催报', 'Portal follow-up');
    case 'wechat_follow_up':
      return tx('微信催报', 'WeChat follow-up');
    case 'whatsapp_follow_up':
      return tx('WhatsApp 跟进', 'WhatsApp follow-up');
    case 'phone_follow_up':
      return tx('电话跟进', 'Phone follow-up');
    case 'contact_missing':
      return tx('联系方式待补', 'Contact details required');
    default:
      return tx('人工跟进', 'Manual follow-up');
  }
}

function getFollowUpOutcomeText(
  outcome: SupplierFollowUpOutcome,
  tx: (zh: string, en: string) => string
) {
  switch (outcome) {
    case 'contacted_waiting_quote':
      return tx('已联系，待报价', 'Contacted, waiting for quote');
    case 'quote_promised':
      return tx('对方承诺回传报价', 'Quote promised');
    case 'portal_message_sent':
      return tx('已发送门户提醒', 'Portal reminder sent');
    case 'contact_invalid':
      return tx('联系方式失效', 'Contact invalid');
    default:
      return outcome;
  }
}

function getChannelText(channel: 'email' | 'phone' | 'manual', tx: (zh: string, en: string) => string) {
  if (channel === 'email') return tx('邮箱', 'Email');
  if (channel === 'phone') return tx('电话', 'Phone');
  return tx('人工处理', 'Manual handling');
}

function formatArrayField(value?: string[]): string {
  if (!value || value.length === 0) return '';
  return value.join(', ');
}

function parseArrayField(value: string): string[] {
  return value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

function SupplierDetailDialog({ supplier, isOpen, onClose }: { supplier: Supplier | null; isOpen: boolean; onClose: () => void }) {
  const { locale } = useTranslation();
  const allSupplierFollowUpLogs = useSupplierFollowUpStore((state) => state.logs);

  if (!supplier) return null;

  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const paymentTermsMap: Record<string, string> = {
    'Net 30': '月结30天',
    'Net 45': '月结45天',
    'Net 60': '月结60天',
  };
  const displayPaymentTerms = (paymentTerms?: string) => {
    if (!paymentTerms) return '-';
    if (locale !== 'zh-CN') return paymentTerms;
    return paymentTermsMap[paymentTerms] || paymentTerms;
  };
  const config = levelConfig[supplier.level];
  const capability = getSupplierCapabilityProfile(supplier);
  const supplierFollowUpLogs = allSupplierFollowUpLogs.filter((log) => log.supplierId === supplier.id);
  const supplierFollowUpTimeline = [...supplierFollowUpLogs].sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  );
  const expiryWarning = getExpiryWarningColor(supplier.qualityApprovalExpiry);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="w-5 h-5" />
            {supplier.name}
            <SupplierTypeBadge type={supplier.supplierType} />
          </DialogTitle>
          <DialogDescription>
            {tx('查看供应商资质、绩效与商务信息。', 'Review supplier qualifications, performance, and business terms.')}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="basic" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="basic">{tx('基本信息', 'Basic Info')}</TabsTrigger>
            <TabsTrigger value="qualification">{tx('资质认证', 'Qualifications')}</TabsTrigger>
            <TabsTrigger value="performance">{tx('绩效与商务', 'Performance')}</TabsTrigger>
            <TabsTrigger value="followup">{tx('跟进记录', 'Follow-up')}</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="space-y-4 py-4">
            <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
              <div>
                <p className="text-sm text-gray-500">Supplier Level</p>
                <div className="flex items-center gap-2 mt-1">
                  <SupplierLevelBadge level={supplier.level} />
                  <div className="flex items-center gap-1">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star
                        key={i}
                        className={cn(
                          'w-4 h-4',
                          i < config.stars ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'
                        )}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm text-gray-500">Performance Score</p>
                <p className="text-3xl font-bold text-brand-primary">{supplier.performanceScore}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-gray-400" />
                  <span>{supplier.email || tx('未填写邮箱', 'No email provided')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-gray-400" />
                  <span>{supplier.phone || tx('未填写电话', 'No phone provided')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-gray-400" />
                  <span>{supplier.address || '-'}</span>
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-400">Payment Terms</p>
                  <p className="font-semibold">{displayPaymentTerms(supplier.paymentTerms)}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">Standard Lead Time</p>
                  <p className="font-semibold">{supplier.leadTime} {tx('天', 'days')}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">Last Order</p>
                  <p className="font-semibold">
                    {supplier.lastOrderDate
                      ? new Date(supplier.lastOrderDate).toLocaleDateString('en-US')
                      : '-'}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-gray-500">{tx('智能询价能力', 'Inquiry automation readiness')}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <Badge variant="outline" className={getCapabilityBadgeClass(capability.automationMode)}>
                      {getCapabilityLabel(capability.automationMode, tx)}
                    </Badge>
                    <span className="text-sm text-gray-500">
                      {tx('首选渠道', 'Preferred channel')}: {getChannelText(capability.preferredChannel, tx)}
                    </span>
                  </div>
                  {capability.automationMode === 'manual' && (
                    <p className="mt-2 text-sm text-amber-700">
                      {tx('人工动作', 'Manual action')}: {getManualActionText(capability.manualActionType, tx)}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-500">{tx('资料完整度', 'Profile completeness')}</p>
                  <p className="text-3xl font-bold text-brand-primary">{capability.profileCompleteness}%</p>
                </div>
              </div>
              <p className="mt-3 text-sm text-slate-600">{getNextActionText(capability.nextAction, tx)}</p>
              <Progress value={capability.profileCompleteness} className="mt-3 h-2" />
            </div>
          </TabsContent>

          <TabsContent value="qualification" className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-500">CAGE Code</span>
                  <span className="font-medium">{supplier.cageCode || '-'}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-500">CCAR-145 证号</span>
                  <span className="font-medium">{supplier.caac145CertificateNo || '-'}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-500">Quality Approval Expiry</span>
                  <span className={cn('font-medium', expiryWarning?.color)}>
                    {supplier.qualityApprovalExpiry
                      ? new Date(supplier.qualityApprovalExpiry).toLocaleDateString()
                      : '-'}
                    {expiryWarning && ` (${expiryWarning.label})`}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-500">Last Audit Date</span>
                  <span className="font-medium">
                    {supplier.lastAuditDate ? new Date(supplier.lastAuditDate).toLocaleDateString() : '-'}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-500">Next Audit Due</span>
                  <span className="font-medium">
                    {supplier.nextAuditDue ? new Date(supplier.nextAuditDue).toLocaleDateString() : '-'}
                  </span>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-500">PMA Holder</span>
                  {supplier.pmaHolder ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  ) : (
                    <XCircle className="w-4 h-4 text-gray-300" />
                  )}
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-500">CTSOA Holder</span>
                  {supplier.ctsoaHolder ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  ) : (
                    <XCircle className="w-4 h-4 text-gray-300" />
                  )}
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-500">OEM Authorized</span>
                  {supplier.oemAuthorized ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  ) : (
                    <XCircle className="w-4 h-4 text-gray-300" />
                  )}
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500 mb-1">Approved Part Categories</p>
                  <div className="flex flex-wrap gap-1">
                    {supplier.approvedPartCategories && supplier.approvedPartCategories.length > 0 ? (
                      supplier.approvedPartCategories.map((cat) => (
                        <Badge key={cat} variant="outline" className="text-xs">{cat}</Badge>
                      ))
                    ) : (
                      <span className="text-sm text-gray-400">-</span>
                    )}
                  </div>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500 mb-1">Specializes In Aircraft</p>
                  <div className="flex flex-wrap gap-1">
                    {supplier.specializesInAircraft && supplier.specializesInAircraft.length > 0 ? (
                      supplier.specializesInAircraft.map((ac) => (
                        <Badge key={ac} variant="outline" className="text-xs">{ac}</Badge>
                      ))
                    ) : (
                      <span className="text-sm text-gray-400">-</span>
                    )}
                  </div>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500 mb-1">Incoterms Offered</p>
                  <div className="flex flex-wrap gap-1">
                    {supplier.incotermsOffered && supplier.incotermsOffered.length > 0 ? (
                      supplier.incotermsOffered.map((inc) => (
                        <Badge key={inc} variant="outline" className="text-xs">{inc}</Badge>
                      ))
                    ) : (
                      <span className="text-sm text-gray-400">-</span>
                    )}
                  </div>
                </div>
                {/* Phase 4: 供应能力标签 */}
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500 mb-2">{tx('供应能力', 'Supply Capabilities')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {supplier.canSupplyRotable && (
                      <Badge variant="outline" className="text-xs bg-purple-50 text-purple-600 border-purple-200">
                        <Wrench className="w-3 h-3 mr-1" />
                        {tx('周转件', 'Rotable')}
                      </Badge>
                    )}
                    {supplier.canSupplyChemical && (
                      <Badge variant="outline" className="text-xs bg-amber-50 text-amber-600 border-amber-200">
                        <FlaskConical className="w-3 h-3 mr-1" />
                        {tx('化工品', 'Chemical')}
                      </Badge>
                    )}
                    {supplier.hasDangerousGoodsLicense && (
                      <Badge variant="outline" className="text-xs bg-red-50 text-red-600 border-red-200">
                        <ShieldCheck className="w-3 h-3 mr-1" />
                        {tx('危险品许可', 'DG License')}
                      </Badge>
                    )}
                    {supplier.hasColdChain && (
                      <Badge variant="outline" className="text-xs bg-cyan-50 text-cyan-600 border-cyan-200">
                        <Thermometer className="w-3 h-3 mr-1" />
                        {tx('冷链能力', 'Cold Chain')}
                      </Badge>
                    )}
                    {!supplier.canSupplyRotable && !supplier.canSupplyChemical && !supplier.hasDangerousGoodsLicense && !supplier.hasColdChain && (
                      <span className="text-sm text-gray-400">-</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="performance" className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-500">Avg Lead Time</span>
                  <span className="font-medium">{supplier.leadTimeAverage ?? '-'} {tx('天', 'days')}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-500">On-Time Delivery Rate</span>
                  <span className="font-medium">{supplier.onTimeDeliveryRate != null ? `${supplier.onTimeDeliveryRate}%` : '-'}</span>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500 mb-1">Certificate Types Provided</p>
                  <div className="flex flex-wrap gap-1">
                    {supplier.certificateTypesProvided && supplier.certificateTypesProvided.length > 0 ? (
                      supplier.certificateTypesProvided.map((cert) => (
                        <Badge key={cert} variant="outline" className="text-xs">{cert}</Badge>
                      ))
                    ) : (
                      <span className="text-sm text-gray-400">-</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500 mb-1">MOQ Policy</p>
                  <p className="text-sm">{supplier.moqPolicy || '-'}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500 mb-1">Warranty Policy</p>
                  <p className="text-sm">{supplier.warrantyPolicy || '-'}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500 mb-1">Return Policy</p>
                  <p className="text-sm">{supplier.returnPolicy || '-'}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500 mb-1">Bank Account Info</p>
                  <p className="text-sm whitespace-pre-wrap">{supplier.bankAccountInfo || '-'}</p>
                </div>
              </div>
            </div>

            <div>
              <h4 className="font-medium mb-3 flex items-center gap-2">
                <BarChart3 className="w-4 h-4" />
                Performance Scorecard
              </h4>
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Price Competitiveness</span>
                    <span className="font-medium">85/100</span>
                  </div>
                  <Progress value={85} className="h-2" />
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Delivery Reliability</span>
                    <span className="font-medium">92/100</span>
                  </div>
                  <Progress value={92} className="h-2" />
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Quality Compliance</span>
                    <span className="font-medium">88/100</span>
                  </div>
                  <Progress value={88} className="h-2" />
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Responsiveness</span>
                    <span className="font-medium">90/100</span>
                  </div>
                  <Progress value={90} className="h-2" />
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="followup" className="space-y-4 py-4">
            <div>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="font-medium">{tx('人工跟进审计时间线', 'Manual follow-up audit timeline')}</h4>
                {supplierFollowUpTimeline.length > 0 && (
                  <Badge variant="outline" className="border-slate-300 bg-white text-slate-700">
                    {supplierFollowUpTimeline.length} {tx('条', 'entries')}
                  </Badge>
                )}
              </div>
              {supplierFollowUpTimeline.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  {tx('暂无人工跟进记录。销售在 AGENT 工作台完成联系后会自动沉淀到这里。', 'No manual follow-up records yet. Completed follow-ups from the agent workbench will appear here.')}
                </div>
              ) : (
                <div className="space-y-3">
                  {supplierFollowUpTimeline.map((log: SupplierFollowUpLog) => (
                    <div key={log.id} className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                          {tx('已记录', 'Logged')}
                        </Badge>
                        <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                          {getManualActionText(log.actionType, tx)}
                        </Badge>
                        <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                          {getFollowUpOutcomeText(log.outcome, tx)}
                        </Badge>
                        <span className="text-xs text-slate-500">
                          {new Date(log.createdAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-slate-600">
                        {log.rfqNumber || tx('未绑定RFQ', 'No RFQ linked')} · {tx('记录人', 'By')} {log.createdBy}
                      </p>
                      {log.notes && <p className="mt-2 text-sm text-slate-700">{log.notes}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

const emptyForm = {
  name: '',
  contactName: '',
  email: '',
  phone: '',
  address: '',
  level: 'A' as Supplier['level'],
  paymentTerms: '',
  leadTime: '',
  supplierType: 'Distributor' as SupplierType,
  cageCode: '',
  caac145CertificateNo: '',
  caac145CertificateUrl: '',
  pmaHolder: false,
  ctsoaHolder: false,
  oemAuthorized: false,
  oemAuthorizationUrl: '',
  qualityApprovalExpiry: '',
  lastAuditDate: '',
  nextAuditDue: '',
  approvedPartCategories: '',
  specializesInAircraft: '',
  incotermsOffered: '',
  // Phase 4: 供应能力标签
  canSupplyRotable: false,
  canSupplyChemical: false,
  hasDangerousGoodsLicense: false,
  hasColdChain: false,
  leadTimeAverage: '',
  onTimeDeliveryRate: '',
  certificateTypesProvided: '',
  moqPolicy: '',
  warrantyPolicy: '',
  returnPolicy: '',
  bankAccountInfo: '',
};

function supplierToForm(supplier: Supplier): typeof emptyForm {
  return {
    name: supplier.name || '',
    contactName: supplier.contactName || '',
    email: supplier.email || '',
    phone: supplier.phone || '',
    address: supplier.address || '',
    level: supplier.level || 'A',
    paymentTerms: supplier.paymentTerms || '',
    leadTime: supplier.leadTime != null ? String(supplier.leadTime) : '',
    supplierType: supplier.supplierType || 'Distributor',
    cageCode: supplier.cageCode || '',
    caac145CertificateNo: supplier.caac145CertificateNo || '',
    caac145CertificateUrl: supplier.caac145CertificateUrl || '',
    pmaHolder: supplier.pmaHolder || false,
    ctsoaHolder: supplier.ctsoaHolder || false,
    oemAuthorized: supplier.oemAuthorized || false,
    oemAuthorizationUrl: supplier.oemAuthorizationUrl || '',
    qualityApprovalExpiry: supplier.qualityApprovalExpiry ? supplier.qualityApprovalExpiry.slice(0, 10) : '',
    lastAuditDate: supplier.lastAuditDate ? supplier.lastAuditDate.slice(0, 10) : '',
    nextAuditDue: supplier.nextAuditDue ? supplier.nextAuditDue.slice(0, 10) : '',
    approvedPartCategories: formatArrayField(supplier.approvedPartCategories),
    specializesInAircraft: formatArrayField(supplier.specializesInAircraft),
    incotermsOffered: formatArrayField(supplier.incotermsOffered),
    // Phase 4: 供应能力标签
    canSupplyRotable: supplier.canSupplyRotable || false,
    canSupplyChemical: supplier.canSupplyChemical || false,
    hasDangerousGoodsLicense: supplier.hasDangerousGoodsLicense || false,
    hasColdChain: supplier.hasColdChain || false,
    leadTimeAverage: supplier.leadTimeAverage != null ? String(supplier.leadTimeAverage) : '',
    onTimeDeliveryRate: supplier.onTimeDeliveryRate != null ? String(supplier.onTimeDeliveryRate) : '',
    certificateTypesProvided: formatArrayField(supplier.certificateTypesProvided),
    moqPolicy: supplier.moqPolicy || '',
    warrantyPolicy: supplier.warrantyPolicy || '',
    returnPolicy: supplier.returnPolicy || '',
    bankAccountInfo: supplier.bankAccountInfo || '',
  };
}

function formToPayload(form: typeof emptyForm): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (form.name) payload.name = form.name;
  if (form.contactName) payload.contactName = form.contactName;
  if (form.email) payload.email = form.email;
  if (form.phone) payload.phone = form.phone;
  if (form.address) payload.address = form.address;
  if (form.level) payload.level = form.level;
  if (form.paymentTerms) payload.paymentTerms = form.paymentTerms;
  if (form.leadTime) payload.leadTime = parseInt(form.leadTime, 10);
  if (form.supplierType) payload.supplierType = form.supplierType;
  if (form.cageCode) payload.cageCode = form.cageCode;
  if (form.caac145CertificateNo) payload.caac145CertificateNo = form.caac145CertificateNo;
  if (form.caac145CertificateUrl) payload.caac145CertificateUrl = form.caac145CertificateUrl;
  payload.pmaHolder = form.pmaHolder;
  payload.ctsoaHolder = form.ctsoaHolder;
  payload.oemAuthorized = form.oemAuthorized;
  if (form.oemAuthorizationUrl) payload.oemAuthorizationUrl = form.oemAuthorizationUrl;
  if (form.qualityApprovalExpiry) payload.qualityApprovalExpiry = form.qualityApprovalExpiry;
  if (form.lastAuditDate) payload.lastAuditDate = form.lastAuditDate;
  if (form.nextAuditDue) payload.nextAuditDue = form.nextAuditDue;
  if (form.approvedPartCategories) payload.approvedPartCategories = parseArrayField(form.approvedPartCategories);
  if (form.specializesInAircraft) payload.specializesInAircraft = parseArrayField(form.specializesInAircraft);
  if (form.incotermsOffered) payload.incotermsOffered = parseArrayField(form.incotermsOffered);
  // Phase 4: 供应能力标签
  payload.canSupplyRotable = form.canSupplyRotable;
  payload.canSupplyChemical = form.canSupplyChemical;
  payload.hasDangerousGoodsLicense = form.hasDangerousGoodsLicense;
  payload.hasColdChain = form.hasColdChain;
  if (form.leadTimeAverage) payload.leadTimeAverage = parseInt(form.leadTimeAverage, 10);
  if (form.onTimeDeliveryRate) payload.onTimeDeliveryRate = parseFloat(form.onTimeDeliveryRate);
  if (form.certificateTypesProvided) payload.certificateTypesProvided = parseArrayField(form.certificateTypesProvided);
  if (form.moqPolicy) payload.moqPolicy = form.moqPolicy;
  if (form.warrantyPolicy) payload.warrantyPolicy = form.warrantyPolicy;
  if (form.returnPolicy) payload.returnPolicy = form.returnPolicy;
  if (form.bankAccountInfo) payload.bankAccountInfo = form.bankAccountInfo;
  return payload;
}

export function Suppliers() {
  const { locale } = useTranslation();
  const can = useCapabilityStore((state) => state.can);
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const paymentTermsMap: Record<string, string> = {
    'Net 30': '月结30天',
    'Net 45': '月结45天',
    'Net 60': '月结60天',
  };
  const allSupplierFollowUpLogs = useSupplierFollowUpStore((state) => state.logs);
  const [searchQuery, setSearchQuery] = useListUrlStringState('search', '');
  const [activeTab, setActiveTab] = useListUrlStringState('level', 'all');
  const [followUpFilter, setFollowUpFilter] = useListUrlStringState('followUpFilter', 'all');
  const [showMoreStats, setShowMoreStats] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [formLoading, setFormLoading] = useState(false);
  const [formTab, setFormTab] = useState('basic');
  const [createForm, setCreateForm] = useState({ ...emptyForm });
  const [currentPage, setCurrentPage] = useListUrlNumberState('page', 1);
  const [sort, setSort] = useListUrlStringState('sort', 'name');
  const [direction, setDirection] = useListUrlStringState('direction', 'asc');
  const pageSize = 10;
  const {
    data: suppliers,
    loading: suppliersLoading,
    pagination: suppliersPagination,
    summary: suppliersSummary,
    refetch,
  } = useSuppliers({
    level: activeTab === 'all' ? undefined : activeTab,
    search: searchQuery,
    followUpFilter,
    page: currentPage,
    limit: pageSize,
    sort,
    direction: direction === 'desc' ? 'desc' : 'asc',
  });

  const suppliersList = suppliers || [];
  const capabilityProfiles = suppliersList.map(getSupplierCapabilityProfile);
  const latestFollowUpBySupplierId = allSupplierFollowUpLogs.reduce<Record<string, SupplierFollowUpLog>>((accumulator, log) => {
    const currentLatest = accumulator[log.supplierId];
    if (!currentLatest || new Date(log.createdAt).getTime() > new Date(currentLatest.createdAt).getTime()) {
      accumulator[log.supplierId] = log;
    }
    return accumulator;
  }, {});
  const toggleFollowUpFilter = (nextFilter: 'with-follow-up' | 'waiting_quote' | 'quote_promised') => {
    setFollowUpFilter((current) => (current === nextFilter ? 'all' : nextFilter));
    setCurrentPage(1);
  };

  // Filter suppliers
  const filteredSuppliers = suppliersList.filter((supplier) => {
    if (searchQuery && !supplier.name.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (activeTab === 'all') return true;
    return supplier.level === activeTab;
  });

  const totalRecords = suppliersPagination?.total ?? filteredSuppliers.length;
  const totalPages = Math.max(1, suppliersPagination?.totalPages ?? Math.ceil(totalRecords / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedSuppliers = filteredSuppliers;

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  // Stats
  const stats = {
    total: suppliersSummary?.total ?? suppliersList.length,
    s: suppliersSummary?.s ?? suppliersList.filter((s) => s.level === 'S').length,
    a: suppliersSummary?.a ?? suppliersList.filter((s) => s.level === 'A').length,
    b: suppliersSummary?.b ?? suppliersList.filter((s) => s.level === 'B').length,
    c: suppliersSummary?.c ?? suppliersList.filter((s) => s.level === 'C').length,
    avgScore: suppliersSummary?.avgScore ?? Math.round(suppliersList.reduce((sum, s) => sum + (s.performanceScore || 0), 0) / (suppliersList.length || 1)),
    autoReady: capabilityProfiles.filter((profile) => profile.automationMode === 'auto').length,
    manualOnly: capabilityProfiles.filter((profile) => profile.automationMode === 'manual').length,
    profileGap: capabilityProfiles.filter((profile) => profile.automationMode === 'blocked').length,
  };

  const handleViewDetail = (supplier: Supplier) => {
    setSelectedSupplier(supplier);
    setIsDetailOpen(true);
  };

  const handleOpenCreate = () => {
    setFormMode('create');
    setCreateForm({ ...emptyForm });
    setFormTab('basic');
    setIsFormOpen(true);
  };

  const handleOpenEdit = (supplier: Supplier) => {
    setFormMode('edit');
    setSelectedSupplier(supplier);
    setCreateForm(supplierToForm(supplier));
    setFormTab('basic');
    setIsFormOpen(true);
  };

  const handleSubmitForm = async () => {
    if (!createForm.name || !createForm.contactName || (!createForm.email && !createForm.phone)) {
      toast.warning(tx('请填写名称、联系人，且邮箱和电话至少填写一项', 'Please provide name, contact, and either email or phone'));
      return;
    }

    setFormLoading(true);
    try {
      const payload = formToPayload(createForm);
      if (formMode === 'create') {
        await supplierApi.create(payload as Parameters<typeof supplierApi.create>[0]);
        toast.success(tx('供应商已新增', 'Supplier created'));
      } else if (selectedSupplier) {
        await supplierApi.update(selectedSupplier.id, payload as Parameters<typeof supplierApi.update>[1]);
        toast.success(tx('供应商已更新', 'Supplier updated'));
      }
      setIsFormOpen(false);
      setCreateForm({ ...emptyForm });
      await refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : tx('操作失败', 'Operation failed');
      toast.error(message);
    } finally {
      setFormLoading(false);
    }
  };

  const handleExport = async (scope: 'page' | 'filtered') => {
    const blob = await supplierApi.exportCsv({
      level: activeTab === 'all' ? undefined : activeTab,
      search: searchQuery,
      followUpFilter,
      page: currentPage,
      limit: pageSize,
      sort,
      direction: direction === 'desc' ? 'desc' : 'asc',
      scope,
      ...(scope === 'filtered' ? { confirm: 'full' as const, maxRows: 5000 } : {}),
    });
    downloadBlob(blob, `suppliers-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const updateForm = (field: keyof typeof createForm, value: string | boolean) => {
    setCreateForm((prev) => ({ ...prev, [field]: value }));
  };

  if (suppliersLoading) {
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
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('供应商总数', 'Total Suppliers')}</p>
              <p className="text-xl font-bold">{stats.total}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('战略合作', 'Strategic Partners')}</p>
              <p className="text-xl font-bold text-purple-600">{stats.s}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('合格供应商', 'Qualified Suppliers')}</p>
              <p className="text-xl font-bold text-green-600">{stats.a}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('谨慎使用', 'Use with Caution')}</p>
              <p className="text-xl font-bold text-yellow-600">{stats.b}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('黑名单', 'Blacklisted')}</p>
              <p className="text-xl font-bold text-red-600">{stats.c}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="hover:shadow-sm transition-shadow">
          <CardContent className="p-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-500">{tx('平均评分', 'Average Score')}</p>
              <p className="text-xl font-bold text-brand-primary">{stats.avgScore}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Collapsible open={showMoreStats} onOpenChange={setShowMoreStats}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-full h-8 text-xs text-gray-500 hover:text-gray-700">
            {showMoreStats ? (
              <>
                <ChevronDown className="w-3 h-3 mr-1" />
                {tx('收起更多指标', 'Collapse more metrics')}
              </>
            ) : (
              <>
                <ChevronRight className="w-3 h-3 mr-1" />
                {tx('查看更多指标', 'View more metrics')}
              </>
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
            <Card className="hover:shadow-sm transition-shadow">
              <CardContent className="p-3 flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500">{tx('自动询价就绪', 'Auto inquiry ready')}</p>
                  <p className="text-xl font-bold text-emerald-600">{stats.autoReady}</p>
                </div>
              </CardContent>
            </Card>
            <Card className="hover:shadow-sm transition-shadow">
              <CardContent className="p-3 flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500">{tx('需人工跟进', 'Manual follow-up')}</p>
                  <p className="text-xl font-bold text-amber-600">{stats.manualOnly}</p>
                </div>
              </CardContent>
            </Card>
            <Card className="hover:shadow-sm transition-shadow">
              <CardContent className="p-3 flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500">{tx('资料待补', 'Profile gaps')}</p>
                  <p className="text-xl font-bold text-red-600">{stats.profileGap}</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Search and actions */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[300px] flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder={tx('搜索供应商名称...', 'Search supplier name...')}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              className="pl-10"
            />
          </div>
          <Select value={sort} onValueChange={(value) => { setSort(value); setCurrentPage(1); }}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder={tx('排序字段', 'Sort')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">{tx('供应商名称', 'Supplier name')}</SelectItem>
              <SelectItem value="createdAt">{tx('创建时间', 'Created')}</SelectItem>
              <SelectItem value="performanceScore">{tx('绩效评分', 'Performance score')}</SelectItem>
              <SelectItem value="leadTime">{tx('交期', 'Lead time')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={direction} onValueChange={(value) => { setDirection(value); setCurrentPage(1); }}>
            <SelectTrigger className="w-28">
              <SelectValue placeholder={tx('顺序', 'Order')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="asc">{tx('升序', 'Asc')}</SelectItem>
              <SelectItem value="desc">{tx('降序', 'Desc')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className={cn(
              'border-slate-200 text-slate-600',
              followUpFilter === 'with-follow-up' && 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
            )}
            onClick={() => toggleFollowUpFilter('with-follow-up')}
          >
            {tx('仅看最近有跟进', 'Followed suppliers only')}
          </Button>
          <Button
            variant="outline"
            className={cn(
              'border-slate-200 text-slate-600',
              followUpFilter === 'waiting_quote' && 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
            )}
            onClick={() => toggleFollowUpFilter('waiting_quote')}
          >
            {tx('待报价中', 'Waiting for quote')}
          </Button>
          <Button
            variant="outline"
            className={cn(
              'border-slate-200 text-slate-600',
              followUpFilter === 'quote_promised' && 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
            )}
            onClick={() => toggleFollowUpFilter('quote_promised')}
          >
            {tx('已承诺报价', 'Quote promised')}
          </Button>
        </div>
        {can('supplier.export') && <ControlledListExportButton locale={locale} onExport={handleExport} />}
        {can('supplier.create') && (
          <Button className="bg-brand-primary hover:bg-brand-primary-hover" onClick={() => handleOpenCreate()}>
            <Plus className="w-4 h-4 mr-1" />
            {tx('新增供应商', 'Add Supplier')}
          </Button>
        )}
      </div>

      {/* 供应商列表 */}
      <Tabs value={activeTab} onValueChange={(value) => { setActiveTab(value); setCurrentPage(1); }}>
        <TabsList>
          <TabsTrigger value="all">{tx('全部', 'All')}</TabsTrigger>
          <TabsTrigger value="S">{tx('战略', 'Strategic')}</TabsTrigger>
          <TabsTrigger value="A">{tx('合格', 'Qualified')}</TabsTrigger>
          <TabsTrigger value="B">{tx('谨慎', 'Caution')}</TabsTrigger>
          <TabsTrigger value="C">{tx('黑名单', 'Blacklisted')}</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('供应商名称', 'Supplier Name')}</TableHead>
                    <TableHead>{tx('类型', 'Type')}</TableHead>
                    <TableHead>{tx('联系人', 'Contact')}</TableHead>
                    <TableHead>{tx('等级', 'Level')}</TableHead>
                    <TableHead>{tx('评分', 'Score')}</TableHead>
                    <TableHead>{tx('资质预警', 'Qualification Alert')}</TableHead>
                    <TableHead>{tx('供应能力', 'Capabilities')}</TableHead>
                    <TableHead>{tx('询价链路', 'Inquiry flow')}</TableHead>
                    <TableHead>{tx('付款条款', 'Payment Terms')}</TableHead>
                    <TableHead>{tx('交期', 'Lead Time')}</TableHead>
                    <TableHead>{tx('最近跟进', 'Latest follow-up')}</TableHead>
                    <TableHead>{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSuppliers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={12} className="text-center py-12 text-gray-500">
                        <Truck className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                        <p>{tx('未找到供应商', 'No suppliers found')}</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    paginatedSuppliers.map((supplier) => {
                      const capability = getSupplierCapabilityProfile(supplier);
                      const latestFollowUpLog = latestFollowUpBySupplierId[supplier.id];
                      const expiryWarning = getExpiryWarningColor(supplier.qualityApprovalExpiry);
                      return (
                        <TableRow key={supplier.id} className="hover:bg-gray-50">
                          <TableCell className="font-medium">{supplier.name}</TableCell>
                          <TableCell>
                            <SupplierTypeBadge type={supplier.supplierType} />
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <p className="font-medium">{supplier.contactName || '-'}</p>
                              <div className="space-y-1 text-xs text-gray-500">
                                <div className="flex items-center gap-1">
                                  <Mail className="h-3.5 w-3.5" />
                                  <span>{supplier.email || tx('未填邮箱', 'No email')}</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <Phone className="h-3.5 w-3.5" />
                                  <span>{supplier.phone || tx('未填电话', 'No phone')}</span>
                                </div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <SupplierLevelBadge level={supplier.level} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Progress value={supplier.performanceScore} className="w-16 h-2" />
                              <span className="text-sm">{supplier.performanceScore}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            {expiryWarning ? (
                              <div className={cn('flex items-center gap-1 text-xs', expiryWarning.color)}>
                                <AlertTriangle className="w-3.5 h-3.5" />
                                <span>{expiryWarning.label}</span>
                              </div>
                            ) : (
                              <span className="text-xs text-gray-400">-</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {supplier.canSupplyRotable && (
                                <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-600">
                                  <Wrench className="w-3 h-3 mr-0.5" />
                                  {tx('周转件', 'Rotable')}
                                </Badge>
                              )}
                              {supplier.canSupplyChemical && (
                                <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-600">
                                  <FlaskConical className="w-3 h-3 mr-0.5" />
                                  {tx('化工品', 'Chemical')}
                                </Badge>
                              )}
                              {supplier.hasDangerousGoodsLicense && (
                                <Badge variant="outline" className="text-[10px] bg-red-50 text-red-600">
                                  <ShieldCheck className="w-3 h-3 mr-0.5" />
                                  {tx('危险品', 'DG')}
                                </Badge>
                              )}
                              {supplier.hasColdChain && (
                                <Badge variant="outline" className="text-[10px] bg-cyan-50 text-cyan-600">
                                  <Thermometer className="w-3 h-3 mr-0.5" />
                                  {tx('冷链', 'Cold')}
                                </Badge>
                              )}
                              {!supplier.canSupplyRotable && !supplier.canSupplyChemical && !supplier.hasDangerousGoodsLicense && !supplier.hasColdChain && (
                                <span className="text-xs text-gray-400">-</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <Badge variant="outline" className={getCapabilityBadgeClass(capability.automationMode)}>
                                {getCapabilityLabel(capability.automationMode, tx)}
                              </Badge>
                              {capability.automationMode === 'manual' && (
                                <p className="text-xs text-amber-700">{getManualActionText(capability.manualActionType, tx)}</p>
                              )}
                              <p className="text-xs text-gray-500">
                                {tx('完整度', 'Completeness')} {capability.profileCompleteness}%
                              </p>
                              <p className="text-xs text-gray-500">{getNextActionText(capability.nextAction, tx)}</p>
                            </div>
                          </TableCell>
                          <TableCell>{supplier.paymentTerms ? (locale === 'zh-CN' ? (paymentTermsMap[supplier.paymentTerms] || supplier.paymentTerms) : supplier.paymentTerms) : '-'}</TableCell>
                          <TableCell>{supplier.leadTime} {tx('天', 'days')}</TableCell>
                          <TableCell>
                            {latestFollowUpLog ? (
                              <div className="min-w-[220px] space-y-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                                    {getFollowUpOutcomeText(latestFollowUpLog.outcome, tx)}
                                  </Badge>
                                  <span className="text-xs text-gray-500">
                                    {new Date(latestFollowUpLog.createdAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                                  </span>
                                </div>
                                <p className="text-xs text-gray-600">
                                  {getManualActionText(latestFollowUpLog.actionType, tx)} · {tx('记录人', 'By')} {latestFollowUpLog.createdBy}
                                </p>
                                {latestFollowUpLog.notes && (
                                  <p className="line-clamp-2 text-xs text-gray-500">{latestFollowUpLog.notes}</p>
                                )}
                              </div>
                            ) : (
                              <span className="text-sm text-gray-400">{tx('暂无人工跟进记录', 'No manual follow-up yet')}</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => handleViewDetail(supplier)}
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                              {can('supplier.update') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleOpenEdit(supplier)}
                                >
                                  <Edit3 className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-2 px-4 pb-2">
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

      {/* 供应商详情弹窗 */}
      <SupplierDetailDialog
        supplier={selectedSupplier}
        isOpen={isDetailOpen}
        onClose={() => {
          setIsDetailOpen(false);
          setSelectedSupplier(null);
        }}
      />

      {/* 新增/编辑供应商弹窗 */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {formMode === 'create' ? tx('新增供应商', 'Add Supplier') : tx('编辑供应商', 'Edit Supplier')}
            </DialogTitle>
            <DialogDescription>
              {tx('录入供应商主数据；邮箱和电话至少填写一项。', 'Create or edit a supplier profile. Provide at least one reachable contact channel.')}
            </DialogDescription>
          </DialogHeader>

          <Tabs value={formTab} onValueChange={setFormTab} className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="basic">{tx('基本信息', 'Basic Info')}</TabsTrigger>
              <TabsTrigger value="qualification">{tx('资质认证', 'Qualifications')}</TabsTrigger>
              <TabsTrigger value="performance">{tx('绩效与商务', 'Performance')}</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{tx('供应商名称', 'Supplier name')} *</Label>
                  <Input
                    placeholder={tx('供应商名称', 'Supplier name')}
                    value={createForm.name}
                    onChange={(e) => updateForm('name', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{tx('联系人', 'Contact name')} *</Label>
                  <Input
                    placeholder={tx('联系人', 'Contact name')}
                    value={createForm.contactName}
                    onChange={(e) => updateForm('contactName', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{tx('邮箱', 'Email')}</Label>
                  <Input
                    placeholder={tx('邮箱（可选，填后可自动询价）', 'Email (optional, enables automation)')}
                    type="email"
                    value={createForm.email}
                    onChange={(e) => updateForm('email', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{tx('电话', 'Phone')}</Label>
                  <Input
                    placeholder={tx('电话（可选）', 'Phone (optional)')}
                    value={createForm.phone}
                    onChange={(e) => updateForm('phone', e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>{tx('地址', 'Address')}</Label>
                <Input
                  placeholder={tx('地址', 'Address')}
                  value={createForm.address}
                  onChange={(e) => updateForm('address', e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{tx('供应商等级', 'Supplier level')}</Label>
                  <Select
                    value={createForm.level}
                    onValueChange={(value) => updateForm('level', value as Supplier['level'])}
                  >
                    <SelectTrigger className="h-10 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="S">{tx('战略合作', 'Strategic')}</SelectItem>
                      <SelectItem value="A">{tx('合格供应商', 'Qualified')}</SelectItem>
                      <SelectItem value="B">{tx('谨慎使用', 'Caution')}</SelectItem>
                      <SelectItem value="C">{tx('黑名单', 'Blacklisted')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>{tx('供应商类型', 'Supplier type')}</Label>
                  <Select
                    value={createForm.supplierType}
                    onValueChange={(value) => updateForm('supplierType', value as SupplierType)}
                  >
                    <SelectTrigger className="h-10 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OEM">OEM</SelectItem>
                      <SelectItem value="MRO">MRO</SelectItem>
                      <SelectItem value="Distributor">Distributor</SelectItem>
                      <SelectItem value="Broker">Broker</SelectItem>
                      <SelectItem value="145RepairStation">145 Repair Station</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{tx('付款条款', 'Payment terms')}</Label>
                  <Input
                    placeholder="Net 30"
                    value={createForm.paymentTerms}
                    onChange={(e) => updateForm('paymentTerms', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{tx('标准交期（天）', 'Standard lead time (days)')}</Label>
                  <Input
                    type="number"
                    placeholder="14"
                    value={createForm.leadTime}
                    onChange={(e) => updateForm('leadTime', e.target.value)}
                  />
                </div>
              </div>
              <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-amber-500" />
                  <p>{tx('邮箱和电话至少填写一项；有邮箱的供应商可直接进入agent自动询价链路。', 'Provide either email or phone. Suppliers with email can enter the agent auto-inquiry flow directly.')}</p>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="qualification" className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{tx('CAGE Code', 'CAGE Code')}</Label>
                  <Input
                    placeholder="CAGE12345"
                    value={createForm.cageCode}
                    onChange={(e) => updateForm('cageCode', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{tx('CCAR-145 维修许可证号', 'CCAR-145 Certificate No')}</Label>
                  <Input
                    placeholder="D.200027"
                    value={createForm.caac145CertificateNo}
                    onChange={(e) => updateForm('caac145CertificateNo', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{tx('145 证扫描件 URL', '145 Certificate URL')}</Label>
                  <Input
                    placeholder="https://..."
                    value={createForm.caac145CertificateUrl}
                    onChange={(e) => updateForm('caac145CertificateUrl', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{tx('OEM 授权书 URL', 'OEM Authorization URL')}</Label>
                  <Input
                    placeholder="https://..."
                    value={createForm.oemAuthorizationUrl}
                    onChange={(e) => updateForm('oemAuthorizationUrl', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="flex items-center gap-2 p-2 border rounded-md">
                  <Checkbox
                    id="pmaHolder"
                    checked={createForm.pmaHolder}
                    onCheckedChange={(v) => updateForm('pmaHolder', Boolean(v))}
                  />
                  <Label htmlFor="pmaHolder" className="text-sm cursor-pointer">PMA {tx('持有人', 'Holder')}</Label>
                </div>
                <div className="flex items-center gap-2 p-2 border rounded-md">
                  <Checkbox
                    id="ctsoaHolder"
                    checked={createForm.ctsoaHolder}
                    onCheckedChange={(v) => updateForm('ctsoaHolder', Boolean(v))}
                  />
                  <Label htmlFor="ctsoaHolder" className="text-sm cursor-pointer">CTSOA {tx('持有人', 'Holder')}</Label>
                </div>
                <div className="flex items-center gap-2 p-2 border rounded-md">
                  <Checkbox
                    id="oemAuthorized"
                    checked={createForm.oemAuthorized}
                    onCheckedChange={(v) => updateForm('oemAuthorized', Boolean(v))}
                  />
                  <Label htmlFor="oemAuthorized" className="text-sm cursor-pointer">OEM {tx('授权', 'Authorized')}</Label>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label>{tx('质量审批到期日', 'Quality Approval Expiry')}</Label>
                  <Input
                    type="date"
                    value={createForm.qualityApprovalExpiry}
                    onChange={(e) => updateForm('qualityApprovalExpiry', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{tx('上次现场审核', 'Last Audit Date')}</Label>
                  <Input
                    type="date"
                    value={createForm.lastAuditDate}
                    onChange={(e) => updateForm('lastAuditDate', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{tx('下次审核到期', 'Next Audit Due')}</Label>
                  <Input
                    type="date"
                    value={createForm.nextAuditDue}
                    onChange={(e) => updateForm('nextAuditDue', e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>{tx('经批准的航材经营范畴（逗号分隔）', 'Approved Part Categories (comma separated)')}</Label>
                <Input
                  placeholder="ATA21, ATA28, ATA32"
                  value={createForm.approvedPartCategories}
                  onChange={(e) => updateForm('approvedPartCategories', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>{tx('专长机型（逗号分隔）', 'Specializes In Aircraft (comma separated)')}</Label>
                <Input
                  placeholder="B737, A320, A350"
                  value={createForm.specializesInAircraft}
                  onChange={(e) => updateForm('specializesInAircraft', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>{tx('可提供的贸易术语（逗号分隔）', 'Incoterms Offered (comma separated)')}</Label>
                <Input
                  placeholder="EXW, FOB, CIF"
                  value={createForm.incotermsOffered}
                  onChange={(e) => updateForm('incotermsOffered', e.target.value)}
                />
              </div>
              {/* Phase 4: 供应能力标签 */}
              <div className="space-y-2">
                <Label>{tx('供应能力标签', 'Supply Capability Tags')}</Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2 p-2 border rounded-md">
                    <Checkbox
                      id="canSupplyRotable"
                      checked={createForm.canSupplyRotable}
                      onCheckedChange={(v) => updateForm('canSupplyRotable', Boolean(v))}
                    />
                    <Label htmlFor="canSupplyRotable" className="text-sm cursor-pointer flex items-center gap-1">
                      <Wrench className="w-3.5 h-3.5 text-purple-500" />
                      {tx('可供应周转件', 'Can Supply Rotable')}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2 p-2 border rounded-md">
                    <Checkbox
                      id="canSupplyChemical"
                      checked={createForm.canSupplyChemical}
                      onCheckedChange={(v) => updateForm('canSupplyChemical', Boolean(v))}
                    />
                    <Label htmlFor="canSupplyChemical" className="text-sm cursor-pointer flex items-center gap-1">
                      <FlaskConical className="w-3.5 h-3.5 text-amber-500" />
                      {tx('可供应化工品', 'Can Supply Chemical')}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2 p-2 border rounded-md">
                    <Checkbox
                      id="hasDangerousGoodsLicense"
                      checked={createForm.hasDangerousGoodsLicense}
                      onCheckedChange={(v) => updateForm('hasDangerousGoodsLicense', Boolean(v))}
                    />
                    <Label htmlFor="hasDangerousGoodsLicense" className="text-sm cursor-pointer flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-red-500" />
                      {tx('危险品运输许可', 'Has DG License')}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2 p-2 border rounded-md">
                    <Checkbox
                      id="hasColdChain"
                      checked={createForm.hasColdChain}
                      onCheckedChange={(v) => updateForm('hasColdChain', Boolean(v))}
                    />
                    <Label htmlFor="hasColdChain" className="text-sm cursor-pointer flex items-center gap-1">
                      <Thermometer className="w-3.5 h-3.5 text-cyan-500" />
                      {tx('冷链运输能力', 'Has Cold Chain')}
                    </Label>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="performance" className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{tx('平均交货周期（天）', 'Avg Lead Time (days)')}</Label>
                  <Input
                    type="number"
                    placeholder="12"
                    value={createForm.leadTimeAverage}
                    onChange={(e) => updateForm('leadTimeAverage', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{tx('准时交付率（%）', 'On-Time Delivery Rate (%)')}</Label>
                  <Input
                    type="number"
                    placeholder="95"
                    value={createForm.onTimeDeliveryRate}
                    onChange={(e) => updateForm('onTimeDeliveryRate', e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>{tx('可提供的证书类型（逗号分隔）', 'Certificate Types (comma separated)')}</Label>
                <Input
                  placeholder="FAA-8130-3, EASA-Form-1, CAAC-038"
                  value={createForm.certificateTypesProvided}
                  onChange={(e) => updateForm('certificateTypesProvided', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>{tx('最小起订量政策', 'MOQ Policy')}</Label>
                <Textarea
                  placeholder={tx('描述最小起订量政策', 'Describe MOQ policy')}
                  value={createForm.moqPolicy}
                  onChange={(e) => updateForm('moqPolicy', e.target.value)}
                  rows={2}
                />
              </div>
              <div className="space-y-1">
                <Label>{tx('质保政策', 'Warranty Policy')}</Label>
                <Textarea
                  placeholder={tx('描述质保政策', 'Describe warranty policy')}
                  value={createForm.warrantyPolicy}
                  onChange={(e) => updateForm('warrantyPolicy', e.target.value)}
                  rows={2}
                />
              </div>
              <div className="space-y-1">
                <Label>{tx('退换货政策', 'Return Policy')}</Label>
                <Textarea
                  placeholder={tx('描述退换货政策', 'Describe return policy')}
                  value={createForm.returnPolicy}
                  onChange={(e) => updateForm('returnPolicy', e.target.value)}
                  rows={2}
                />
              </div>
              <div className="space-y-1">
                <Label>{tx('银行账户信息', 'Bank Account Info')}</Label>
                <Textarea
                  placeholder={tx('JSON 格式或文本描述', 'JSON format or text description')}
                  value={createForm.bankAccountInfo}
                  onChange={(e) => updateForm('bankAccountInfo', e.target.value)}
                  rows={3}
                />
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>{tx('取消', 'Cancel')}</Button>
            <Button onClick={() => void handleSubmitForm()} disabled={formLoading}>
              {formLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : (formMode === 'create' ? tx('确认新增', 'Create') : tx('确认更新', 'Update'))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
