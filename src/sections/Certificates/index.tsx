import { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Plus,
  Eye,
  ShieldCheck,
  ShieldX,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  X,
  Loader2,
  FileCheck,
  FileText,
  History,
  Stamp,
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
import { Textarea } from '@/components/ui/textarea';
import { useCertificateStore } from '@/store';
import {
  useCertificates,
  useCreateCertificate,
  useVerifyCertificate,
  useRevokeCertificate,
  useRenewCertificate,
} from '@/hooks/useApi';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { Certificate, CertificateStatus, CertificateType } from '@/types';

const statusConfig: Record<CertificateStatus, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  ISSUED: { label: 'Issued', color: 'text-green-600', bgColor: 'bg-green-50', icon: CheckCircle },
  REVOKED: { label: 'Revoked', color: 'text-red-600', bgColor: 'bg-red-50', icon: ShieldX },
  EXPIRED: { label: 'Expired', color: 'text-gray-600', bgColor: 'bg-gray-50', icon: AlertCircle },
  RENEWED: { label: 'Renewed', color: 'text-blue-600', bgColor: 'bg-blue-50', icon: RefreshCw },
};

const certTypeConfig: Record<CertificateType, { label: string; color: string }> = {
  'AAC-038': { label: 'AAC-038', color: 'text-green-600' },
  'FAA-8130-3': { label: 'FAA 8130-3', color: 'text-green-600' },
  'EASA-Form-1': { label: 'EASA Form 1', color: 'text-green-600' },
  COC: { label: 'COC', color: 'text-blue-600' },
  NONE: { label: 'None', color: 'text-red-600' },
};

function getExpiryStatus(expiryDate: string, locale: string): { label: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' | null | undefined; className: string } | null {
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const now = new Date();
  const expiry = new Date(expiryDate);
  const diffMs = expiry.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return { label: tx('已过期', 'Expired'), variant: 'destructive', className: 'bg-red-100 text-red-700 hover:bg-red-100' };
  }
  if (diffDays <= 30) {
    return { label: locale === 'zh-CN' ? `${diffDays}天后到期` : `Expiring in ${diffDays}d`, variant: 'secondary', className: 'bg-yellow-100 text-yellow-700 hover:bg-yellow-100' };
  }
  return null;
}

function CertificateStatusBadge({ status }: { status: CertificateStatus }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  const { locale } = useTranslation();
  const labelMap: Record<CertificateStatus, string> = {
    ISSUED: locale === 'zh-CN' ? '已签发' : 'Issued',
    REVOKED: locale === 'zh-CN' ? '已撤销' : 'Revoked',
    EXPIRED: locale === 'zh-CN' ? '已过期' : 'Expired',
    RENEWED: locale === 'zh-CN' ? '已续期' : 'Renewed',
  };
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      <Icon className="w-3 h-3 mr-1" />
      {labelMap[status] || config.label}
    </Badge>
  );
}

function CertificateDetailDialog({
  certificate,
  isOpen,
  onClose,
}: {
  certificate: Certificate | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { verify, loading: verifyLoading } = useVerifyCertificate();
  const { revoke, loading: revokeLoading } = useRevokeCertificate();
  const { renew, loading: renewLoading } = useRenewCertificate();
  const [revokeReason, setRevokeReason] = useState('');
  const [showRevokeInput, setShowRevokeInput] = useState(false);

  if (!certificate) return null;

  const expiryBadge = getExpiryStatus(certificate.expiryDate, locale);

  const handleVerify = async () => {
    try {
      await verify(certificate.id);
      toast.success(tx('证书验证成功', 'Certificate verified successfully'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tx('验证失败', 'Verification failed'));
    }
  };

  const handleRevoke = async () => {
    if (!revokeReason.trim()) {
      toast.warning(tx('请输入撤销原因', 'Please enter a revocation reason'));
      return;
    }
    try {
      await revoke(certificate.id, revokeReason);
      toast.success(tx('证书已撤销', 'Certificate revoked'));
      setShowRevokeInput(false);
      setRevokeReason('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tx('撤销失败', 'Revocation failed'));
    }
  };

  const handleRenew = async () => {
    try {
      await renew(certificate.id);
      toast.success(tx('证书已续期', 'Certificate renewed'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tx('续期失败', 'Renewal failed'));
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileCheck className="w-5 h-5" />
            {certificate.certificateNumber}
            {expiryBadge && (
              <Badge className={cn(expiryBadge.className)}>{expiryBadge.label}</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="basic" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="basic">{tx('基本信息', 'Basic Info')}</TabsTrigger>
            <TabsTrigger value="verification">{tx('验证', 'Verification')}</TabsTrigger>
            <TabsTrigger value="trace">{tx('追溯历史', 'Trace History')}</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="space-y-4 py-4">
            <div className="flex justify-between items-start p-4 bg-gray-50 rounded-lg">
              <div>
                <p className="font-semibold text-lg">{certificate.partNumber}</p>
                <p className="text-sm text-gray-500">{certificate.description || tx('无描述', 'No description')}</p>
              </div>
              <CertificateStatusBadge status={certificate.status} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-400">{tx('证书编号', 'Certificate Number')}</p>
                  <p className="font-semibold font-mono">{certificate.certificateNumber}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('件号', 'Part Number')}</p>
                  <p className="font-semibold font-mono">{certificate.partNumber}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('证书类型', 'Certificate Type')}</p>
                  <p className={cn('font-semibold', certTypeConfig[certificate.certificateType].color)}>
                    {certTypeConfig[certificate.certificateType].label}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('签发人', 'Issued By')}</p>
                  <p className="font-semibold">{certificate.issuedBy}</p>
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-400">{tx('签发日期', 'Issue Date')}</p>
                  <p className="font-semibold">{new Date(certificate.issueDate).toLocaleDateString()}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('到期日期', 'Expiry Date')}</p>
                  <p className={cn('font-semibold', expiryBadge && 'text-red-600')}>
                    {new Date(certificate.expiryDate).toLocaleDateString()}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('序号', 'Serial Number')}</p>
                  <p className="font-semibold font-mono">{certificate.serialNumber || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{tx('批次号', 'Batch Number')}</p>
                  <p className="font-semibold">{certificate.batchNumber || '-'}</p>
                </div>
              </div>
            </div>

            {certificate.fileUrl && (
              <div>
                <p className="text-sm text-gray-400">{tx('证书文件', 'Certificate File')}</p>
                <a href={certificate.fileUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline text-sm">
                  {certificate.fileUrl}
                </a>
              </div>
            )}

            {certificate.revokedAt && (
              <div className="p-4 bg-red-50 rounded-lg border border-red-100">
                <p className="text-sm font-semibold text-red-700 flex items-center gap-2">
                  <ShieldX className="w-4 h-4" />
                  {tx('撤销信息', 'Revocation Info')}
                </p>
                <p className="text-sm text-red-600 mt-1">
                  {tx('撤销时间', 'Revoked At')}: {new Date(certificate.revokedAt).toLocaleDateString()}
                </p>
                {certificate.revokeReason && (
                  <p className="text-sm text-red-600 mt-1">
                    {tx('撤销原因', 'Reason')}: {certificate.revokeReason}
                  </p>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="verification" className="space-y-4 py-4">
            <div className="flex items-center gap-2 p-3 bg-green-50 rounded-lg">
              <ShieldCheck className="w-4 h-4 text-green-600" />
              <span className="text-sm font-medium text-green-700">{tx('证书验证', 'Certificate Verification')}</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-400">{tx('证书编号', 'Certificate Number')}</p>
                <p className="font-semibold font-mono">{certificate.certificateNumber}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{tx('当前状态', 'Current Status')}</p>
                <CertificateStatusBadge status={certificate.status} />
              </div>
              <div>
                <p className="text-sm text-gray-400">{tx('签发人', 'Issued By')}</p>
                <p className="font-semibold">{certificate.issuedBy}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400">{tx('签发日期', 'Issue Date')}</p>
                <p className="font-semibold">{new Date(certificate.issueDate).toLocaleDateString()}</p>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button onClick={handleVerify} disabled={verifyLoading || certificate.status !== 'ISSUED'}>
                {verifyLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
                {tx('验证证书', 'Verify Certificate')}
              </Button>
              <Button variant="outline" onClick={handleRenew} disabled={renewLoading || certificate.status === 'REVOKED'}>
                {renewLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                {tx('续期', 'Renew')}
              </Button>
              {!showRevokeInput ? (
                <Button
                  variant="destructive"
                  onClick={() => setShowRevokeInput(true)}
                  disabled={certificate.status === 'REVOKED'}
                >
                  <ShieldX className="w-4 h-4 mr-2" />
                  {tx('撤销', 'Revoke')}
                </Button>
              ) : (
                <div className="flex-1 flex gap-2">
                  <Textarea
                    placeholder={tx('输入撤销原因...', 'Enter revocation reason...')}
                    value={revokeReason}
                    onChange={(e) => setRevokeReason(e.target.value)}
                    className="min-h-[40px] flex-1"
                  />
                  <Button variant="destructive" onClick={handleRevoke} disabled={revokeLoading}>
                    {revokeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : tx('确认撤销', 'Confirm')}
                  </Button>
                  <Button variant="outline" onClick={() => { setShowRevokeInput(false); setRevokeReason(''); }}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="trace" className="space-y-4 py-4">
            <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg">
              <History className="w-4 h-4 text-blue-600" />
              <span className="text-sm font-medium text-blue-700">{tx('追溯历史', 'Trace History')}</span>
            </div>

            <div className="space-y-3">
              <div className="flex items-start gap-3 p-3 border rounded-lg">
                <Stamp className="w-4 h-4 text-green-600 mt-0.5" />
                <div>
                  <p className="text-sm font-medium">{tx('证书签发', 'Certificate Issued')}</p>
                  <p className="text-xs text-gray-500">{new Date(certificate.issueDate).toLocaleString()} · {certificate.issuedBy}</p>
                </div>
              </div>
              {certificate.renewedFromId && (
                <div className="flex items-start gap-3 p-3 border rounded-lg">
                  <RefreshCw className="w-4 h-4 text-blue-600 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">{tx('证书续期', 'Certificate Renewed')}</p>
                    <p className="text-xs text-gray-500">{tx('从原证书续期', 'Renewed from previous certificate')}</p>
                  </div>
                </div>
              )}
              {certificate.revokedAt && (
                <div className="flex items-start gap-3 p-3 border rounded-lg bg-red-50">
                  <ShieldX className="w-4 h-4 text-red-600 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-red-700">{tx('证书撤销', 'Certificate Revoked')}</p>
                    <p className="text-xs text-red-600">{new Date(certificate.revokedAt).toLocaleString()}</p>
                    {certificate.revokeReason && <p className="text-xs text-red-600 mt-1">{certificate.revokeReason}</p>}
                  </div>
                </div>
              )}
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

function IssueCertificateDialog({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { mutate: createCertificate, loading } = useCreateCertificate();
  const [formData, setFormData] = useState({
    certificateNumber: '',
    partNumber: '',
    certificateType: 'AAC-038' as CertificateType,
    issueDate: new Date().toISOString().slice(0, 10),
    expiryDate: '',
    issuedBy: '',
    issuedTo: '',
    serialNumber: '',
    batchNumber: '',
    description: '',
  });

  const handleSubmit = async () => {
    if (!formData.certificateNumber || !formData.partNumber || !formData.expiryDate || !formData.issuedBy) {
      toast.warning(tx('请填写所有必填项', 'Please fill in all required fields'));
      return;
    }
    try {
      await createCertificate({
        ...formData,
        issueDate: new Date(formData.issueDate).toISOString(),
        expiryDate: new Date(formData.expiryDate).toISOString(),
      });
      toast.success(tx('证书签发成功', 'Certificate issued successfully'));
      onSuccess();
      onClose();
      setFormData({
        certificateNumber: '',
        partNumber: '',
        certificateType: 'AAC-038',
        issueDate: new Date().toISOString().slice(0, 10),
        expiryDate: '',
        issuedBy: '',
        issuedTo: '',
        serialNumber: '',
        batchNumber: '',
        description: '',
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tx('签发失败', 'Issue failed'));
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stamp className="w-5 h-5" />
            {tx('签发证书', 'Issue Certificate')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('证书编号 *', 'Certificate Number *')}</Label>
              <Input
                value={formData.certificateNumber}
                onChange={(e) => setFormData({ ...formData, certificateNumber: e.target.value })}
                placeholder={tx('输入证书编号', 'Enter certificate number')}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('件号 *', 'Part Number *')}</Label>
              <Input
                value={formData.partNumber}
                onChange={(e) => setFormData({ ...formData, partNumber: e.target.value })}
                placeholder={tx('输入件号', 'Enter part number')}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
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
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{tx('签发人 *', 'Issued By *')}</Label>
              <Input
                value={formData.issuedBy}
                onChange={(e) => setFormData({ ...formData, issuedBy: e.target.value })}
                placeholder={tx('输入签发人', 'Enter issuer')}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('签发日期 *', 'Issue Date *')}</Label>
              <Input
                type="date"
                value={formData.issueDate}
                onChange={(e) => setFormData({ ...formData, issueDate: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('到期日期 *', 'Expiry Date *')}</Label>
              <Input
                type="date"
                value={formData.expiryDate}
                onChange={(e) => setFormData({ ...formData, expiryDate: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('序号', 'Serial Number')}</Label>
              <Input
                value={formData.serialNumber}
                onChange={(e) => setFormData({ ...formData, serialNumber: e.target.value })}
                placeholder={tx('输入序号', 'Enter serial number')}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('批次号', 'Batch Number')}</Label>
              <Input
                value={formData.batchNumber}
                onChange={(e) => setFormData({ ...formData, batchNumber: e.target.value })}
                placeholder={tx('输入批次号', 'Enter batch number')}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tx('描述', 'Description')}</Label>
            <Textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder={tx('输入描述', 'Enter description')}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Stamp className="w-4 h-4 mr-2" />}
            {tx('签发', 'Issue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Certificates() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [partNumberSearch, setPartNumberSearch] = useState('');
  const [expiryWarningOnly, setExpiryWarningOnly] = useState(false);
  const [selectedCertificate, setSelectedCertificate] = useState<Certificate | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isIssueOpen, setIsIssueOpen] = useState(false);

  const { data: certificates, loading, refetch } = useCertificates({
    status: statusFilter === 'all' ? undefined : statusFilter,
    certificateType: typeFilter === 'all' ? undefined : typeFilter,
    partNumber: partNumberSearch || undefined,
  });

  const { data: expiringCerts } = useCertificates({
    expiringWithinDays: 30,
  });

  const store = useCertificateStore();

  useEffect(() => {
    if (certificates) {
      store.setCertificates(certificates);
    }
  }, [certificates]);

  const filteredCertificates = useMemo(() => {
    let list = certificates || [];
    if (expiryWarningOnly) {
      list = list.filter((c) => {
        const badge = getExpiryStatus(c.expiryDate, locale);
        return badge !== null;
      });
    }
    return list;
  }, [certificates, expiryWarningOnly]);

  const stats = {
    total: certificates?.length || 0,
    expiringSoon: expiringCerts?.length || 0,
    issued: certificates?.filter((c) => c.status === 'ISSUED').length || 0,
    revoked: certificates?.filter((c) => c.status === 'REVOKED').length || 0,
  };

  const handleViewDetail = (certificate: Certificate) => {
    setSelectedCertificate(certificate);
    setIsDetailOpen(true);
  };

  if (loading) {
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
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('证书总数', 'Total Certificates')}</p>
            <p className="text-2xl font-bold">{stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('已签发', 'Issued')}</p>
            <p className="text-2xl font-bold text-green-600">{stats.issued}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('即将到期', 'Expiring Soon')}</p>
            <p className="text-2xl font-bold text-yellow-600">{stats.expiringSoon}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('已撤销', 'Revoked')}</p>
            <p className="text-2xl font-bold text-red-600">{stats.revoked}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[300px] flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder={tx('搜索件号...', 'Search part number...')}
              value={partNumberSearch}
              onChange={(e) => setPartNumberSearch(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder={tx('状态', 'Status')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tx('全部状态', 'All Statuses')}</SelectItem>
            <SelectItem value="ISSUED">{tx('已签发', 'Issued')}</SelectItem>
            <SelectItem value="REVOKED">{tx('已撤销', 'Revoked')}</SelectItem>
            <SelectItem value="EXPIRED">{tx('已过期', 'Expired')}</SelectItem>
            <SelectItem value="RENEWED">{tx('已续期', 'Renewed')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder={tx('证书类型', 'Certificate Type')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tx('全部类型', 'All Types')}</SelectItem>
            <SelectItem value="AAC-038">AAC-038</SelectItem>
            <SelectItem value="FAA-8130-3">FAA 8130-3</SelectItem>
            <SelectItem value="EASA-Form-1">EASA Form 1</SelectItem>
            <SelectItem value="COC">COC</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Checkbox
            id="expiryWarning"
            checked={expiryWarningOnly}
            onCheckedChange={(v) => setExpiryWarningOnly(v === true)}
          />
          <Label htmlFor="expiryWarning" className="text-sm cursor-pointer">
            {tx('仅显示到期预警', 'Expiry Warning Only')}
          </Label>
        </div>
        <Button onClick={() => setIsIssueOpen(true)}>
          <Plus className="w-4 h-4 mr-1" />
          {tx('签发证书', 'Issue Certificate')}
        </Button>
      </div>

      {/* Certificate list */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx('证书编号', 'Certificate Number')}</TableHead>
                <TableHead>{tx('件号', 'Part Number')}</TableHead>
                <TableHead>{tx('证书类型', 'Certificate Type')}</TableHead>
                <TableHead>{tx('状态', 'Status')}</TableHead>
                <TableHead>{tx('签发日期', 'Issue Date')}</TableHead>
                <TableHead>{tx('到期日期', 'Expiry Date')}</TableHead>
                <TableHead>{tx('签发人', 'Issued By')}</TableHead>
                <TableHead>{tx('预警', 'Warning')}</TableHead>
                <TableHead>{tx('操作', 'Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCertificates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-gray-500">
                    <FileText className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                    <p>{tx('未找到证书', 'No certificates found')}</p>
                  </TableCell>
                </TableRow>
              ) : (
                filteredCertificates.map((certificate) => {
                  const expiryBadge = getExpiryStatus(certificate.expiryDate, locale);
                  return (
                    <TableRow key={certificate.id} className="hover:bg-gray-50">
                      <TableCell className="font-mono font-medium">{certificate.certificateNumber}</TableCell>
                      <TableCell className="font-mono">{certificate.partNumber}</TableCell>
                      <TableCell>
                        <span className={cn('text-sm font-medium', certTypeConfig[certificate.certificateType].color)}>
                          {certTypeConfig[certificate.certificateType].label}
                        </span>
                      </TableCell>
                      <TableCell>
                        <CertificateStatusBadge status={certificate.status} />
                      </TableCell>
                      <TableCell>{new Date(certificate.issueDate).toLocaleDateString()}</TableCell>
                      <TableCell className={cn(expiryBadge && 'text-red-600 font-medium')}>
                        {new Date(certificate.expiryDate).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{certificate.issuedBy}</TableCell>
                      <TableCell>
                        {expiryBadge ? (
                          <Badge className={cn(expiryBadge.className)}>{expiryBadge.label}</Badge>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleViewDetail(certificate)}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Detail Dialog */}
      <CertificateDetailDialog
        certificate={selectedCertificate}
        isOpen={isDetailOpen}
        onClose={() => {
          setIsDetailOpen(false);
          setSelectedCertificate(null);
        }}
      />

      {/* Issue Dialog */}
      <IssueCertificateDialog
        isOpen={isIssueOpen}
        onClose={() => setIsIssueOpen(false)}
        onSuccess={() => refetch()}
      />
    </div>
  );
}
