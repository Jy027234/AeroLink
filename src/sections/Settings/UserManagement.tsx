import { useState } from 'react';
import { Copy, Edit3, Inbox, Key, Loader2, Plus, Trash2, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { useUsers, useCreateUser, useUpdateUser, useDeleteUser, useRegenerateUserActivationLink } from '@/hooks/useApi';
import type { AuthEmailDeliveryStatus, UserOnboardingResponse } from '@/api/client';
import { setSettingsTabInUrl } from './tabUrlState';
import { toast } from 'sonner';
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
import type { User as UserType } from '@/types';

export function UserManagement() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: users, loading, refetch } = useUsers();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const regenerateActivationLink = useRegenerateUserActivationLink();

  const [selectedUser, setSelectedUser] = useState<UserType | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    role: 'sales',
    department: '',
    phone: '',
  });
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [onboardingDialogOpen, setOnboardingDialogOpen] = useState(false);
  const [onboardingName, setOnboardingName] = useState('');
  const [onboardingLink, setOnboardingLink] = useState('');
  const [onboardingExpiresAt, setOnboardingExpiresAt] = useState('');
  const [onboardingDeliveryStatus, setOnboardingDeliveryStatus] = useState<AuthEmailDeliveryStatus>('sent');
  const [onboardingDeliveryError, setOnboardingDeliveryError] = useState('');

  const openOnboardingDialog = (payload: UserOnboardingResponse) => {
    setOnboardingName(payload.user.name);
    setOnboardingLink(payload.activationLink);
    setOnboardingExpiresAt(payload.activationExpiresAt);
    setOnboardingDeliveryStatus(payload.emailDeliveryStatus);
    setOnboardingDeliveryError(payload.emailDeliveryError || '');
    setOnboardingDialogOpen(true);
  };

  const getOnboardingNotice = (status: AuthEmailDeliveryStatus) => {
    if (status === 'sent') {
      return tx('激活邮件已自动发送给该用户。', 'The activation email has been sent automatically.');
    }

    return tx(
      '系统未能自动发送激活邮件，请复制下方链接并手动发送给该用户。',
      'Automatic email delivery was unavailable. Please copy the link below and share it manually.'
    );
  };

  const getRoleBadge = (role: string) => {
    const config: Record<string, { label: string; color: string }> = {
      gm: { label: tx('总经理', 'General Manager'), color: 'bg-red-100 text-red-700' },
      manager: { label: tx('销售经理', 'Sales Manager'), color: 'bg-blue-100 text-blue-700' },
      finance: { label: tx('财务', 'Finance'), color: 'bg-green-100 text-green-700' },
      sales: { label: tx('销售', 'Sales'), color: 'bg-gray-100 text-gray-700' },
      admin: { label: tx('管理员', 'Admin'), color: 'bg-purple-100 text-purple-700' },
    };
    const current = config[role] || { label: role, color: 'bg-gray-100' };
    return <Badge className={current.color}>{current.label}</Badge>;
  };

  const handleOpenCreate = () => {
    setFormMode('create');
    setFormData({ name: '', email: '', role: 'sales', department: '', phone: '' });
    setIsFormOpen(true);
  };

  const handleOpenEdit = (user: UserType) => {
    setFormMode('edit');
    setSelectedUser(user);
    setFormData({
      name: user.name || '',
      email: user.email || '',
      role: user.role || 'sales',
      department: user.department || '',
      phone: '',
    });
    setIsFormOpen(true);
  };

  const handleSubmit = async () => {
    if (!formData.name || !formData.email) {
      toast.warning(tx('请填写姓名和邮箱', 'Please fill in name and email'));
      return;
    }
    try {
      if (formMode === 'create') {
        const result = await createUser.mutate(formData);
        if (result) {
          openOnboardingDialog(result);
          toast.success(
            result.emailDeliveryStatus === 'sent'
              ? tx('用户已创建，激活邮件已发送', 'User created and activation email sent.')
              : tx('用户已创建，请手动发送激活链接', 'User created. Please share the activation link manually.')
          );
          setIsFormOpen(false);
          await refetch();
        }
      } else if (selectedUser) {
        await updateUser.mutate({ id: selectedUser.id, data: formData });
        toast.success(tx('用户已更新', 'User updated'));
        setIsFormOpen(false);
        await refetch();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : tx('操作失败', 'Operation failed');
      toast.error(message);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleteTargetId(id);
  };

  const handleRegenerateActivationLink = async (user: UserType) => {
    const result = await regenerateActivationLink.mutate(user.id);
    if (result) {
      openOnboardingDialog(result);
      toast.success(
        result.emailDeliveryStatus === 'sent'
          ? tx('激活链接已重新生成并发送', 'Activation link regenerated and emailed.')
          : tx('激活链接已重新生成，请手动发送', 'Activation link regenerated. Please share it manually.')
      );
    } else {
      toast.error(tx('重发激活链接失败', 'Failed to regenerate activation link'));
    }
  };

  const handleCopyActivationLink = async () => {
    try {
      await navigator.clipboard.writeText(onboardingLink);
      toast.success(tx('激活链接已复制', 'Activation link copied'));
    } catch {
      toast.error(tx('复制失败', 'Copy failed'));
    }
  };

  const handleOpenEmailSettings = () => {
    setOnboardingDialogOpen(false);
    setSettingsTabInUrl('email');
  };

  const confirmDelete = async () => {
    if (!deleteTargetId) return;
    try {
      await deleteUser.mutate(deleteTargetId);
      toast.success(tx('用户已删除', 'User deleted'));
      await refetch();
    } catch (_error) {
      toast.error(tx('删除失败', 'Delete failed'));
    } finally {
      setDeleteTargetId(null);
    }
  };

  const usersList = users || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{tx('用户管理', 'User Management')}</h3>
          <p className="text-sm text-gray-500">{tx('管理用户与角色权限', 'Manage users and role permissions')}</p>
        </div>
        <Button className="bg-brand-primary hover:bg-brand-primary-hover" onClick={handleOpenCreate}>
          <Plus className="w-4 h-4 mr-1" />
          {tx('新增用户', 'Add User')}
        </Button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8 text-gray-500">
          <Loader2 className="w-6 h-6 animate-spin mr-2" />
          {tx('加载中...', 'Loading...')}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tx('用户', 'User')}</TableHead>
                <TableHead>{tx('邮箱', 'Email')}</TableHead>
                <TableHead>{tx('部门', 'Department')}</TableHead>
                <TableHead>{tx('角色', 'Role')}</TableHead>
                <TableHead>{tx('最近登录', 'Last Login')}</TableHead>
                <TableHead>{tx('操作', 'Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usersList.length === 0 && !loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-12 text-gray-500">
                    <Inbox className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    {tx('暂无用户', 'No users yet')}
                  </TableCell>
                </TableRow>
              ) : (
                usersList.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-brand-primary rounded-full flex items-center justify-center">
                          <User className="w-4 h-4 text-white" />
                        </div>
                        <div>
                          <span className="font-medium">{user.name}</span>
                          {user.activationPending && (
                            <p className="text-xs text-amber-600">{tx('待激活', 'Pending activation')}</p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-gray-500">{user.email}</TableCell>
                    <TableCell>{user.department || '-'}</TableCell>
                    <TableCell>{getRoleBadge(user.role)}</TableCell>
                    <TableCell className="text-gray-500">
                      {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US') : '-'}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(user)}>
                          <Edit3 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRegenerateActivationLink(user)}
                          disabled={!user.activationPending || regenerateActivationLink.loading}
                        >
                          <Key className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(user.id)} disabled={deleteUser.loading}>
                          <Trash2 className="w-4 h-4 text-red-500" />
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{tx('角色权限总览', 'Role Permission Overview')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { role: 'gm', label: tx('总经理', 'General Manager'), permissions: [tx('全部权限', 'Full access'), tx('审批高价值订单', 'Approve high-value orders'), tx('系统配置', 'System configuration')] },
              { role: 'manager', label: tx('销售经理', 'Sales Manager'), permissions: [tx('报价审批', 'Quote approvals'), tx('客户管理', 'Customer management'), tx('订单处理', 'Order handling')] },
              { role: 'finance', label: tx('财务', 'Finance'), permissions: [tx('财务审批', 'Financial approvals'), tx('报表查看', 'Report viewing')] },
              { role: 'sales', label: tx('销售', 'Sales'), permissions: [tx('创建RFQ', 'Create RFQ'), tx('创建报价', 'Create quotes'), tx('查看客户', 'View customers')] },
            ].map((role) => (
              <div key={role.role} className="p-3 border rounded-lg">
                <p className="font-medium mb-2">{role.label}</p>
                <ul className="text-sm text-gray-500 space-y-1">
                  {role.permissions.map((permission) => (
                    <li key={permission}>• {permission}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* User Form Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {formMode === 'create' ? tx('新增用户', 'Add User') : tx('编辑用户', 'Edit User')}
            </DialogTitle>
            <DialogDescription className="sr-only">{tx('管理用户账户信息', 'Manage user account')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{tx('姓名', 'Name')} *</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>{tx('邮箱', 'Email')} *</Label>
              <Input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('角色', 'Role')}</Label>
                <Select
                  value={formData.role}
                  onValueChange={(value) => setFormData({ ...formData, role: value })}
                >
                  <SelectTrigger className="w-full"><SelectValue placeholder={tx('请选择', 'Please select')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gm">{tx('总经理', 'General Manager')}</SelectItem>
                    <SelectItem value="manager">{tx('销售经理', 'Sales Manager')}</SelectItem>
                    <SelectItem value="finance">{tx('财务', 'Finance')}</SelectItem>
                    <SelectItem value="sales">{tx('销售', 'Sales')}</SelectItem>
                    <SelectItem value="admin">{tx('管理员', 'Admin')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tx('部门', 'Department')}</Label>
                <Input
                  value={formData.department}
                  onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>{tx('取消', 'Cancel')}</Button>
            <Button
              onClick={handleSubmit}
              disabled={createUser.loading || updateUser.loading}
            >
              {(createUser.loading || updateUser.loading) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {tx('保存', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTargetId} onOpenChange={(open) => { if (!open) setDeleteTargetId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tx('确认删除', 'Confirm Delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tx('确定要删除此用户吗？此操作不可撤销。', 'Are you sure you want to delete this user? This action cannot be undone.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTargetId(null)}>{tx('取消', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{tx('删除', 'Delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={onboardingDialogOpen} onOpenChange={setOnboardingDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tx('激活链接', 'Activation Link')}</DialogTitle>
            <DialogDescription>
              {tx(`请将下方信息发送给 ${onboardingName || '该用户'}，用于首次设置密码。`, `Share the details below with ${onboardingName || 'the user'} for first-time password setup.`)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className={`rounded-lg border px-3 py-2 text-sm ${onboardingDeliveryStatus === 'sent' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
              <p>{getOnboardingNotice(onboardingDeliveryStatus)}</p>
              {onboardingDeliveryError && (
                <p className="mt-1 text-xs opacity-90">{onboardingDeliveryError}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{tx('激活地址', 'Activation URL')}</Label>
              <Input value={onboardingLink} readOnly />
            </div>
            {onboardingExpiresAt && (
              <p className="text-sm text-gray-500">
                {tx('有效期至：', 'Valid until: ')}
                {new Date(onboardingExpiresAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
              </p>
            )}
          </div>
          <DialogFooter>
            {onboardingDeliveryStatus !== 'sent' && (
              <Button variant="outline" onClick={handleOpenEmailSettings}>
                {tx('去配置邮箱', 'Configure Email')}
              </Button>
            )}
            <Button variant="outline" onClick={() => setOnboardingDialogOpen(false)}>
              {tx('关闭', 'Close')}
            </Button>
            <Button onClick={() => void handleCopyActivationLink()}>
              <Copy className="w-4 h-4 mr-2" />
              {tx('复制链接', 'Copy Link')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
