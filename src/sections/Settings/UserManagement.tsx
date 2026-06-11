import { useState } from 'react';
import { Edit3, Key, Loader2, Plus, Trash2, User } from 'lucide-react';
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
import { useUsers, useCreateUser, useUpdateUser, useDeleteUser } from '@/hooks/useApi';
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
        await createUser.mutate(formData);
        toast.success(tx('用户已创建', 'User created'));
      } else if (selectedUser) {
        await updateUser.mutate({ id: selectedUser.id, data: formData });
        toast.success(tx('用户已更新', 'User updated'));
      }
      setIsFormOpen(false);
      await refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : tx('操作失败', 'Operation failed');
      toast.error(message);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleteTargetId(id);
  };

  const confirmDelete = async () => {
    if (!deleteTargetId) return;
    try {
      await deleteUser.mutate(deleteTargetId);
      toast.success(tx('用户已删除', 'User deleted'));
      await refetch();
    } catch (error) {
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
                        <span className="font-medium">{user.name}</span>
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
                        <Button variant="ghost" size="icon" disabled>
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
    </div>
  );
}
