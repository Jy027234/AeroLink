import { useEffect, useState } from 'react';
import {
  Search,
  Plus,
  Eye,
  Edit3,
  Copy,
  Trash2,
  Loader2,
  FileText,
  CheckCircle,
  X,
  Save,
  Stamp,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
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
import { Textarea } from '@/components/ui/textarea';
import { useCertificateStore } from '@/store';
import {
  useCertificateTemplates,
  useSaveCertificateTemplate,
  useDuplicateCertificateTemplate,
  useDeleteCertificateTemplate,
} from '@/hooks/useApi';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import type { CertificateTemplate, CertificateType } from '@/types';

const certTypeConfig: Record<CertificateType, { label: string; color: string }> = {
  'AAC-038': { label: 'AAC-038', color: 'text-green-600' },
  'FAA-8130-3': { label: 'FAA 8130-3', color: 'text-green-600' },
  'EASA-Form-1': { label: 'EASA Form 1', color: 'text-green-600' },
  COC: { label: 'COC', color: 'text-blue-600' },
  NONE: { label: 'None', color: 'text-red-600' },
};

function TemplateFormDialog({
  template,
  isOpen,
  onClose,
  onSuccess,
}: {
  template: CertificateTemplate | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { mutate: saveTemplate, loading } = useSaveCertificateTemplate();
  const [formData, setFormData] = useState({
    name: '',
    code: '',
    certificateType: 'AAC-038' as CertificateType,
    bodyTemplate: '',
    headerTemplate: '',
    footerTemplate: '',
    isActive: true,
    isDefault: false,
    description: '',
  });
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (template) {
      setFormData({
        name: template.name,
        code: template.code,
        certificateType: template.certificateType,
        bodyTemplate: template.bodyTemplate || '',
        headerTemplate: template.headerTemplate || '',
        footerTemplate: template.footerTemplate || '',
        isActive: template.isActive,
        isDefault: template.isDefault,
        description: template.description || '',
      });
    } else {
      setFormData({
        name: '',
        code: '',
        certificateType: 'AAC-038',
        bodyTemplate: '',
        headerTemplate: '',
        footerTemplate: '',
        isActive: true,
        isDefault: false,
        description: '',
      });
    }
  }, [template, isOpen]);

  const handleSubmit = async () => {
    if (!formData.name || !formData.code) {
      toast.warning(tx('名称和代码不能为空', 'Name and code are required'));
      return;
    }
    try {
      await saveTemplate({
        id: template?.id,
        data: { ...formData },
      });
      toast.success(template ? tx('模板已更新', 'Template updated') : tx('模板已创建', 'Template created'));
      onSuccess();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tx('保存失败', 'Save failed'));
    }
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Stamp className="w-5 h-5" />
              {template ? tx('编辑模板', 'Edit Template') : tx('创建模板', 'Create Template')} - {formData.name || tx('新模板', 'New Template')}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('模板名称 *', 'Template Name *')}</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder={tx('输入模板名称', 'Enter template name')}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('模板代码 *', 'Template Code *')}</Label>
                <Input
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                  placeholder={tx('输入模板代码', 'Enter template code')}
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
                <Label>{tx('描述', 'Description')}</Label>
                <Input
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder={tx('输入描述', 'Enter description')}
                />
              </div>
            </div>

            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch
                  id="isActive"
                  checked={formData.isActive}
                  onCheckedChange={(v) => setFormData({ ...formData, isActive: v })}
                />
                <Label htmlFor="isActive" className="cursor-pointer">{tx('启用', 'Active')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="isDefault"
                  checked={formData.isDefault}
                  onCheckedChange={(v) => setFormData({ ...formData, isDefault: v })}
                />
                <Label htmlFor="isDefault" className="cursor-pointer">{tx('默认模板', 'Default')}</Label>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{tx('页眉模板', 'Header Template')}</Label>
              <Textarea
                value={formData.headerTemplate}
                onChange={(e) => setFormData({ ...formData, headerTemplate: e.target.value })}
                placeholder={tx('输入页眉模板 HTML', 'Enter header template HTML')}
                rows={4}
              />
            </div>

            <div className="space-y-2">
              <Label>{tx('正文模板 *', 'Body Template *')}</Label>
              <Textarea
                value={formData.bodyTemplate}
                onChange={(e) => setFormData({ ...formData, bodyTemplate: e.target.value })}
                placeholder={tx('输入正文模板 HTML', 'Enter body template HTML')}
                rows={8}
              />
            </div>

            <div className="space-y-2">
              <Label>{tx('页脚模板', 'Footer Template')}</Label>
              <Textarea
                value={formData.footerTemplate}
                onChange={(e) => setFormData({ ...formData, footerTemplate: e.target.value })}
                placeholder={tx('输入页脚模板 HTML', 'Enter footer template HTML')}
                rows={4}
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPreviewOpen(true)}>
              <Eye className="w-4 h-4 mr-2" />
              {tx('预览', 'Preview')}
            </Button>
            <Button variant="outline" onClick={onClose}>
              <X className="w-4 h-4 mr-2" />
              {tx('取消', 'Cancel')}
            </Button>
            <Button onClick={handleSubmit} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              {tx('保存', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{tx('模板预览', 'Template Preview')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {formData.headerTemplate && (
              <div className="border rounded-lg p-4 bg-gray-50">
                <p className="text-xs text-gray-400 mb-2">{tx('页眉', 'Header')}</p>
                <div dangerouslySetInnerHTML={{ __html: formData.headerTemplate }} />
              </div>
            )}
            <div className="border rounded-lg p-4">
              <p className="text-xs text-gray-400 mb-2">{tx('正文', 'Body')}</p>
              <div dangerouslySetInnerHTML={{ __html: formData.bodyTemplate || `<p class="text-gray-400">${tx('暂无内容', 'No content')}</p>` }} />
            </div>
            {formData.footerTemplate && (
              <div className="border rounded-lg p-4 bg-gray-50">
                <p className="text-xs text-gray-400 mb-2">{tx('页脚', 'Footer')}</p>
                <div dangerouslySetInnerHTML={{ __html: formData.footerTemplate }} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              {tx('关闭', 'Close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CertificateTemplates() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [activeOnly, setActiveOnly] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<CertificateTemplate | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CertificateTemplate | null>(null);

  const { data: templates, loading, refetch } = useCertificateTemplates({
    certificateType: typeFilter === 'all' ? undefined : typeFilter,
    isActive: activeOnly || undefined,
  });

  const { duplicate, loading: duplicateLoading } = useDuplicateCertificateTemplate();
  const { deleteTemplate, loading: deleteLoading } = useDeleteCertificateTemplate();

  const setTemplates = useCertificateStore((state) => state.setTemplates);

  useEffect(() => {
    if (templates) {
      setTemplates(templates);
    }
  }, [templates, setTemplates]);

  const filteredTemplates = (templates || []).filter((t) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        t.name.toLowerCase().includes(q) ||
        t.code.toLowerCase().includes(q) ||
        t.certificateType.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const stats = {
    total: templates?.length || 0,
    active: templates?.filter((t) => t.isActive).length || 0,
    default: templates?.filter((t) => t.isDefault).length || 0,
  };

  const handleDuplicate = async (template: CertificateTemplate) => {
    try {
      await duplicate(template.id);
      toast.success(tx('模板已复制', 'Template duplicated'));
      refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tx('复制失败', 'Duplicate failed'));
    }
  };

  const handleDelete = (template: CertificateTemplate) => {
    setDeleteTarget(template);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteTemplate(deleteTarget.id);
      toast.success(tx('模板已删除', 'Template deleted'));
      refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tx('删除失败', 'Delete failed'));
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleEdit = (template: CertificateTemplate) => {
    setSelectedTemplate(template);
    setIsFormOpen(true);
  };

  const handleCreate = () => {
    setSelectedTemplate(null);
    setIsFormOpen(true);
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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('模板总数', 'Total Templates')}</p>
            <p className="text-2xl font-bold">{stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('已启用', 'Active')}</p>
            <p className="text-2xl font-bold text-green-600">{stats.active}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-gray-500">{tx('默认模板', 'Default')}</p>
            <p className="text-2xl font-bold text-blue-600">{stats.default}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[300px] flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder={tx('搜索模板名称、代码或类型...', 'Search name, code, or type...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
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
            id="activeOnly"
            checked={activeOnly}
            onCheckedChange={(v) => setActiveOnly(v === true)}
          />
          <Label htmlFor="activeOnly" className="text-sm cursor-pointer">
            {tx('仅显示启用', 'Active Only')}
          </Label>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="w-4 h-4 mr-1" />
          {tx('创建模板', 'Create Template')}
        </Button>
      </div>

      {/* Template list */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx('模板名称', 'Name')}</TableHead>
                <TableHead>{tx('代码', 'Code')}</TableHead>
                <TableHead>{tx('证书类型', 'Certificate Type')}</TableHead>
                <TableHead>{tx('版本', 'Version')}</TableHead>
                <TableHead>{tx('状态', 'Status')}</TableHead>
                <TableHead>{tx('默认', 'Default')}</TableHead>
                <TableHead>{tx('操作', 'Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTemplates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-gray-500">
                    <FileText className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                    <p>{tx('未找到模板', 'No templates found')}</p>
                  </TableCell>
                </TableRow>
              ) : (
                filteredTemplates.map((template) => (
                  <TableRow key={template.id} className="hover:bg-gray-50">
                    <TableCell className="font-medium">{template.name}</TableCell>
                    <TableCell className="font-mono text-sm">{template.code}</TableCell>
                    <TableCell>
                      <span className={cn('text-sm font-medium', certTypeConfig[template.certificateType].color)}>
                        {certTypeConfig[template.certificateType].label}
                      </span>
                    </TableCell>
                    <TableCell>v{template.version}</TableCell>
                    <TableCell>
                      {template.isActive ? (
                        <Badge variant="outline" className="bg-green-50 text-green-600 border-green-200">
                          <CheckCircle className="w-3 h-3 mr-1" />
                          {tx('启用', 'Active')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-gray-50 text-gray-600 border-gray-200">
                          {tx('禁用', 'Inactive')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {template.isDefault ? (
                        <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">
                          {tx('默认', 'Default')}
                        </Badge>
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
                          onClick={() => handleEdit(template)}
                        >
                          <Edit3 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleDuplicate(template)}
                          disabled={duplicateLoading}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-600 hover:text-red-700"
                          onClick={() => handleDelete(template)}
                          disabled={deleteLoading}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tx('确认删除', 'Confirm Delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && tx(`确定要删除模板 "${deleteTarget.name}" 吗？此操作不可撤销。`, `Are you sure you want to delete template "${deleteTarget.name}"? This action cannot be undone.`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>
              {tx('取消', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deleteLoading} className="bg-red-600 hover:bg-red-700">
              {tx('删除', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Form Dialog */}
      <TemplateFormDialog
        template={selectedTemplate}
        isOpen={isFormOpen}
        onClose={() => {
          setIsFormOpen(false);
          setSelectedTemplate(null);
        }}
        onSuccess={() => refetch()}
      />
    </div>
  );
}
