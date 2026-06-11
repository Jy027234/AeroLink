import { useEffect, useState } from 'react';
import { Check, Edit3, Loader2, Mail, Plus, RefreshCw, Save, Trash2, X, Inbox } from 'lucide-react';
import { emailAccountApi } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTranslation } from '@/i18n';
import { toast } from 'sonner';
import type { EmailAccount, EmailAccountFormData } from './types';

export function EmailSettings() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EmailAccount | null>(null);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  useEffect(() => {
    void loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      const data = await emailAccountApi.getAll();
      setAccounts(Array.isArray(data) ? (data as EmailAccount[]) : []);
    } catch (error) {
      console.error('Failed to load email accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (formData: EmailAccountFormData) => {
    try {
      if (editingAccount) {
        await emailAccountApi.update(editingAccount.id, formData);
      } else {
        await emailAccountApi.create(formData);
      }
      toast.success(editingAccount ? tx('邮箱账户已更新。', 'Account updated.') : tx('邮箱账户已添加。', 'Account added.'));
      setIsDialogOpen(false);
      setEditingAccount(null);
      await loadAccounts();
    } catch (error) {
      console.error('Save failed:', error);
      toast.error(tx('保存失败。', 'Save failed.'));
    }
  };

  const handleDelete = async (id: string) => {
    setDeleteTargetId(id);
  };

  const confirmDelete = async () => {
    if (!deleteTargetId) return;
    try {
      await emailAccountApi.delete(deleteTargetId);
      toast.success(tx('邮箱账户已删除。', 'Account deleted.'));
      await loadAccounts();
    } catch (error) {
      console.error('Delete failed:', error);
    } finally {
      setDeleteTargetId(null);
    }
  };

  const handleSync = async (id: string) => {
    setSyncingIds((previous) => new Set(previous).add(id));
    try {
      await emailAccountApi.sync(id);
      toast.info(tx('已触发同步。', 'Sync triggered.'));
      await loadAccounts();
    } catch (error) {
      console.error('Sync failed:', error);
    } finally {
      setSyncingIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await emailAccountApi.update(id, { isDefault: true });
      await loadAccounts();
    } catch (error) {
      console.error('Failed to set default account:', error);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{tx('邮箱账户管理', 'Email Account Management')}</CardTitle>
          <CardDescription>{tx('配置多个邮箱用于需求接收与报价发送', 'Configure multiple inboxes for demand intake and outbound quotations')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg mb-4">
            <p className="text-sm text-blue-800">
              <strong>{tx('提示：', 'Tip:')}</strong> {tx('支持配置多个邮箱账户。采购邮箱可接收供应商报价，销售邮箱可发送对外报价。163/126/yeah.net 使用相同配置方式。', 'You can configure multiple email accounts. Purchasing inboxes can receive supplier quotes, and sales inboxes can send outbound quotations. 163/126/yeah.net accounts use the same setup method.')}
            </p>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tx('邮箱地址', 'Email Address')}</TableHead>
                  <TableHead>{tx('类型', 'Type')}</TableHead>
                  <TableHead>{tx('状态', 'Status')}</TableHead>
                  <TableHead>{tx('默认', 'Default')}</TableHead>
                  <TableHead>{tx('最近同步', 'Last Sync')}</TableHead>
                  <TableHead>{tx('操作', 'Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12 text-gray-500">
                    <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                      {tx('暂无邮箱账户，请点击上方按钮添加。', 'No email accounts yet. Click the button above to add one.')}
                    </TableCell>
                  </TableRow>
                ) : (
                  accounts.map((account) => (
                    <TableRow key={account.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Mail className="w-4 h-4 text-gray-400" />
                          <div>
                            <p className="font-medium">{account.email}</p>
                            <p className="text-xs text-gray-500">{account.displayName}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {account.accountType === '163' ? tx('网易邮箱', 'NetEase Email') : account.accountType}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {account.isActive ? (
                          <span className="flex items-center gap-1 text-green-600">
                            <Check className="w-4 h-4" /> {tx('启用', 'Enabled')}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-gray-400">
                            <X className="w-4 h-4" /> {tx('禁用', 'Disabled')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {account.isDefault ? (
                          <Badge className="bg-blue-100 text-blue-700">{tx('默认', 'Default')}</Badge>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => handleSetDefault(account.id)}>
                            {tx('设为默认', 'Set Default')}
                          </Button>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-gray-500">
                        {account.lastSyncAt
                          ? new Date(account.lastSyncAt).toLocaleString('en-US')
                          : tx('从未同步', 'Never synced')}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setEditingAccount(account);
                              setIsDialogOpen(true);
                            }}
                          >
                            <Edit3 className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleSync(account.id)}
                            disabled={syncingIds.has(account.id)}
                          >
                            <RefreshCw className={`w-4 h-4 ${syncingIds.has(account.id) ? 'animate-spin' : ''}`} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(account.id)}
                          >
                            <Trash2 className="w-4 h-4 text-red-500" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}

          <Button
            className="mt-4 bg-brand-primary hover:bg-brand-primary-hover"
            onClick={() => {
              setEditingAccount(null);
              setIsDialogOpen(true);
            }}
          >
            <Plus className="w-4 h-4 mr-1" />
            {tx('添加邮箱账户', 'Add Email Account')}
          </Button>
        </CardContent>
      </Card>

      <EmailAccountDialog
        key={editingAccount?.id || 'new-email-account'}
        open={isDialogOpen}
        onClose={() => {
          setIsDialogOpen(false);
          setEditingAccount(null);
        }}
        onSave={handleSave}
        account={editingAccount}
      />

      <AlertDialog open={!!deleteTargetId} onOpenChange={(open) => { if (!open) setDeleteTargetId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tx('确认删除', 'Confirm Delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tx('确定要删除此邮箱账户吗？此操作不可撤销。', 'Are you sure you want to delete this email account? This action cannot be undone.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTargetId(null)}>{tx('取消', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{tx('删除', 'Delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmailAccountDialog({
  open,
  onClose,
  onSave,
  account,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (data: EmailAccountFormData) => Promise<void>;
  account: EmailAccount | null;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const getInitialFormData = () => ({
    email: account?.email || '',
    displayName: account?.displayName || '',
    imapServer: account?.imapServer || 'imap.163.com',
    imapPort: account?.imapPort || '993',
    smtpServer: account?.smtpServer || 'smtp.163.com',
    smtpPort: account?.smtpPort || '465',
    authCode: account?.authCode || '',
    accountType: account?.accountType || '163',
    isDefault: account?.isDefault || false,
    syncInterval: account?.syncInterval || 5,
  });

  const [formData, setFormData] = useState(getInitialFormData);
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async () => {
    if (!formData.email || !formData.authCode) {
      toast.error(tx('请填写邮箱地址和授权码。', 'Please fill in email address and authorization code.'));
      return;
    }
    setIsSaving(true);
    await onSave(formData);
    setIsSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{account ? tx('编辑邮箱账户', 'Edit Email Account') : tx('添加邮箱账户', 'Add Email Account')}</DialogTitle>
          <DialogDescription className="sr-only">{tx('配置邮箱账户信息', 'Configure email account')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-sm text-yellow-800">
              <strong>{tx('如何获取授权码？', 'How to get authorization code?')}</strong><br />
              {tx(`登录 ${formData.email.split('@')[1] || '邮箱服务商'}，在设置中开启 POP3/SMTP/IMAP 服务后获取授权码。`, `Sign in to ${formData.email.split('@')[1] || 'email provider'}, open Settings, enable POP3/SMTP/IMAP services, then get the authorization code.`)}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{tx('邮箱类型', 'Email Type')}</Label>
            <Select
              value={formData.accountType}
              onValueChange={(type) => {
                if (type === '163') {
                  setFormData({
                    ...formData,
                    accountType: type,
                    imapServer: 'imap.163.com',
                    smtpServer: 'smtp.163.com',
                  });
                } else if (type === 'qq') {
                  setFormData({
                    ...formData,
                    accountType: type,
                    imapServer: 'imap.qq.com',
                    smtpServer: 'smtp.qq.com',
                  });
                } else {
                  setFormData({ ...formData, accountType: type });
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tx('请选择邮箱类型', 'Select email type')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="163">{tx('网易邮箱 (163/126/yeah.net)', 'NetEase (163/126/yeah.net)')}</SelectItem>
                <SelectItem value="qq">{tx('QQ邮箱', 'QQ Mail')}</SelectItem>
                <SelectItem value="gmail">Gmail</SelectItem>
                <SelectItem value="outlook">Outlook</SelectItem>
                <SelectItem value="custom">{tx('自定义', 'Custom')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{tx('邮箱地址 *', 'Email Address *')}</Label>
            <Input
              type="email"
              value={formData.email}
              onChange={(event) => setFormData({ ...formData, email: event.target.value })}
              placeholder="yourname@163.com"
            />
          </div>

          <div className="space-y-2">
            <Label>{tx('显示名称', 'Display Name')}</Label>
            <Input
              value={formData.displayName}
              onChange={(event) => setFormData({ ...formData, displayName: event.target.value })}
              placeholder={tx('例如：航材采购邮箱', 'e.g. Aero Parts Purchasing')}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('IMAP服务器', 'IMAP Server')}</Label>
              <Input
                value={formData.imapServer}
                onChange={(event) => setFormData({ ...formData, imapServer: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('IMAP端口', 'IMAP Port')}</Label>
              <Input
                value={formData.imapPort}
                onChange={(event) => setFormData({ ...formData, imapPort: event.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('SMTP服务器', 'SMTP Server')}</Label>
              <Input
                value={formData.smtpServer}
                onChange={(event) => setFormData({ ...formData, smtpServer: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('SMTP端口', 'SMTP Port')}</Label>
              <Input
                value={formData.smtpPort}
                onChange={(event) => setFormData({ ...formData, smtpPort: event.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tx('授权码 *', 'Authorization Code *')}</Label>
            <Input
              type="password"
              value={formData.authCode}
              onChange={(event) => setFormData({ ...formData, authCode: event.target.value })}
              placeholder={tx('输入邮箱授权码（非登录密码）', 'Enter email authorization code (not login password)')}
            />
          </div>

          <div className="flex items-center justify-between p-3 border rounded-lg">
            <div>
              <p className="font-medium">{tx('设为默认账户', 'Set as default account')}</p>
              <p className="text-sm text-gray-500">{tx('发送报价时优先使用此账户', 'Use this account first when sending quotations')}</p>
            </div>
            <Switch
              checked={formData.isDefault}
              onCheckedChange={(checked) => setFormData({ ...formData, isDefault: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label>{tx('同步间隔（分钟）', 'Sync Interval (minutes)')}</Label>
            <Input
              type="number"
              min={1}
              max={60}
              value={formData.syncInterval}
              onChange={(event) => setFormData({ ...formData, syncInterval: parseInt(event.target.value, 10) || 5 })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button
            className="bg-brand-primary hover:bg-brand-primary-hover"
            onClick={handleSubmit}
            disabled={isSaving}
          >
            {isSaving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            {tx('保存', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}