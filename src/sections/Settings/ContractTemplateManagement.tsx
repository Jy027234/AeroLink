import { useMemo, useState } from 'react';
import { AlertTriangle, FileText, Loader2, Plus, Save, Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useDocumentTemplates, useSaveDocumentTemplate } from '@/hooks/useApi';
import type { DocumentTemplate } from '@/types';
import { useTranslation } from '@/i18n';

const ORDER_CONTRACT_TEMPLATE_VARIABLES = [
  'customer.name',
  'customer.contactName',
  'customer.email',
  'customer.phone',
  'customer.address',
  'quotation.quoteNumber',
  'quotation.partNumber',
  'quotation.quantity',
  'quotation.unitPrice',
  'quotation.totalPrice',
  'quotation.saleType',
  'quotation.incoterm',
  'quotation.incotermLocation',
  'quotation.leadTimeDays',
  'quotation.warrantyDays',
  'quotation.taxIncluded',
  'quotation.taxRate',
  'quotation.packagingRequirement',
  'quotation.shippingMethod',
  'quotation.expiryDate',
  'quotation.customerConfirmationNote',
  'order.orderNumber',
  'order.soNumber',
  'order.poNumber',
  'order.deliveryDate',
  'system.generatedAt',
] as const;

function ContractTemplateDialog({
  open,
  onClose,
  template,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  template: DocumentTemplate | null;
  onSave: (id: string | undefined, data: Partial<DocumentTemplate>) => Promise<void>;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [formData, setFormData] = useState<Partial<DocumentTemplate>>(() => ({
    name: template?.name || '',
    code: template?.code || '',
    documentType: template?.documentType || 'ORDER_CONTRACT',
    description: template?.description || '',
    bodyTemplate: template?.bodyTemplate || '',
    headerTemplate: template?.headerTemplate || '',
    footerTemplate: template?.footerTemplate || '',
    isActive: template?.isActive ?? true,
    isDefault: template?.isDefault ?? false,
  }));
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async () => {
    if (!formData.name || !formData.code || !formData.bodyTemplate) {
      alert(tx('请填写模板名称、模板编码和模板正文。', 'Please fill in template name, code, and body.'));
      return;
    }

    setIsSaving(true);
    try {
      await onSave(template?.id, formData);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template ? tx('编辑合同模板', 'Edit Contract Template') : tx('新建合同模板', 'Create Contract Template')}</DialogTitle>
          <DialogDescription className="sr-only">{tx('管理合同模板内容', 'Manage contract template content')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('模板名称', 'Template Name')}</Label>
              <Input value={formData.name || ''} onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{tx('模板编码', 'Template Code')}</Label>
              <Input value={formData.code || ''} onChange={(e) => setFormData({ ...formData, code: e.target.value })} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tx('模板说明', 'Description')}</Label>
            <Input value={formData.description || ''} onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="font-medium">{tx('启用模板', 'Enable Template')}</p>
                <p className="text-sm text-gray-500">{tx('停用后不参与自动生成', 'Disabled templates are excluded from auto-generation')}</p>
              </div>
              <Switch checked={!!formData.isActive} onCheckedChange={(value) => setFormData({ ...formData, isActive: value })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="font-medium">{tx('设为默认', 'Set as Default')}</p>
                <p className="text-sm text-gray-500">{tx('客户确认报价时默认使用该模板', 'Used by default when a customer confirms a quote')}</p>
              </div>
              <Switch checked={!!formData.isDefault} onCheckedChange={(value) => setFormData({ ...formData, isDefault: value })} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tx('合同正文 HTML 模板', 'Contract Body HTML Template')}</Label>
            <Textarea
              value={formData.bodyTemplate || ''}
              onChange={(e) => setFormData({ ...formData, bodyTemplate: e.target.value })}
              className="min-h-[360px] font-mono text-sm"
            />
          </div>

          <div className="rounded-lg border bg-gray-50 p-4">
            <p className="mb-2 font-medium flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-500" />
              {tx('可用占位变量', 'Available Variables')}
            </p>
            <div className="flex flex-wrap gap-2">
              {ORDER_CONTRACT_TEMPLATE_VARIABLES.map((token) => (
                <Badge key={token} variant="outline" className="font-mono">
                  {`{{${token}}}`}
                </Badge>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tx('取消', 'Cancel')}</Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            {tx('保存模板', 'Save Template')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ContractTemplateManagement() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data, loading, error, refetch } = useDocumentTemplates('ORDER_CONTRACT');
  const { mutate: saveTemplate, loading: savingTemplate } = useSaveDocumentTemplate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<DocumentTemplate | null>(null);

  const templates = useMemo(() => data || [], [data]);
  const activeTemplate = useMemo(() => templates.find((item) => item.isDefault) || templates[0], [templates]);

  const handleSave = async (id: string | undefined, template: Partial<DocumentTemplate>) => {
    const result = await saveTemplate({ id, data: template });
    if (result) {
      alert(id ? tx('合同模板已更新。', 'Contract template updated.') : tx('合同模板已创建。', 'Contract template created.'));
      setDialogOpen(false);
      setEditingTemplate(null);
      refetch();
    } else {
      alert(tx('保存失败，请检查模板内容。', 'Save failed. Please check the template body.'));
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            {tx('订单合同模板管理', 'Order Contract Template Management')}
          </CardTitle>
          <CardDescription>
            {tx('维护销售合同预制内容。客户确认报价后，系统会自动按默认模板填充客户、报价和订单信息并生成合同。', 'Maintain prebuilt sales contract content. Once a customer confirms a quote, the system fills customer, quotation, and order data into the default template automatically.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && !loading && (
            <div role="alert" className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 md:flex-row md:items-center md:justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="font-medium">{tx('合同模板加载失败', 'Failed to load contract templates')}</p>
                  <p className="text-sm text-amber-800">{tx('当前模板列表可能不是最新，请重试。', 'The template list may be stale. Please retry.')}</p>
                </div>
              </div>
              <Button variant="outline" onClick={() => void refetch()}>
                {tx('重试加载', 'Retry Loading')}
              </Button>
            </div>
          )}

          <div className="flex justify-between gap-4 rounded-lg border bg-blue-50 p-4">
            <div>
              <p className="font-medium text-blue-900">{tx('当前默认模板', 'Current Default Template')}</p>
              <p className="text-sm text-blue-800">
                {activeTemplate ? `${activeTemplate.name} · v${activeTemplate.version}` : tx('暂无可用默认模板，建议先创建一份标准合同模板。', 'No default template is available. Create a standard contract template first.')}
              </p>
            </div>
            <Button
              className="bg-[#64b5f6] hover:bg-[#42a5f5]"
              onClick={() => {
                setEditingTemplate(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="w-4 h-4 mr-1" />
              {tx('新建模板', 'New Template')}
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tx('模板名称', 'Template')}</TableHead>
                  <TableHead>{tx('编码', 'Code')}</TableHead>
                  <TableHead>{tx('版本', 'Version')}</TableHead>
                  <TableHead>{tx('状态', 'Status')}</TableHead>
                  <TableHead>{tx('默认', 'Default')}</TableHead>
                  <TableHead>{tx('最近更新', 'Updated')}</TableHead>
                  <TableHead>{tx('操作', 'Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-gray-500">
                      {tx('暂无合同模板。', 'No contract templates yet.')}
                    </TableCell>
                  </TableRow>
                ) : (
                  templates.map((template) => (
                    <TableRow key={template.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium">{template.name}</p>
                          <p className="text-xs text-gray-500">{template.description || tx('无说明', 'No description')}</p>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{template.code}</TableCell>
                      <TableCell>v{template.version}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={template.isActive ? 'text-green-700 border-green-300' : 'text-gray-500'}>
                          {template.isActive ? tx('启用', 'Active') : tx('停用', 'Inactive')}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {template.isDefault ? <Badge className="bg-blue-100 text-blue-700">{tx('默认', 'Default')}</Badge> : '-'}
                      </TableCell>
                      <TableCell>{new Date(template.updatedAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditingTemplate(template);
                            setDialogOpen(true);
                          }}
                        >
                          {tx('编辑', 'Edit')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}

          <div className="rounded-lg border p-4">
            <p className="mb-2 font-medium">{tx('设计建议', 'Design Notes')}</p>
            <ul className="space-y-1 text-sm text-gray-600">
              <li>{tx('使用 HTML 表格预留货物明细区，系统会自动填入件号、数量、单价和总价。', 'Use HTML tables for the goods section; the system fills part number, quantity, unit price, and total automatically.')}</li>
              <li>{tx('客户信息和订单字段统一通过 {{...}} 占位符注入，避免手工复制。', 'Customer and order fields are injected with {{...}} placeholders to avoid manual copy-paste.')}</li>
              <li>{tx('默认模板会在“客户确认报价”时自动生成合同文档，可随时在报价详情或订单链路下载。', 'The default template is used when a customer confirms a quote, and the generated contract can be downloaded from the quotation/order flow.')}</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <ContractTemplateDialog
        open={dialogOpen}
        onClose={() => {
          if (!savingTemplate) {
            setDialogOpen(false);
            setEditingTemplate(null);
          }
        }}
        template={editingTemplate}
        onSave={handleSave}
      />
    </div>
  );
}