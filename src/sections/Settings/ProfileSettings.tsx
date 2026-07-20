import { useState } from 'react';
import { Save, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useTranslation } from '@/i18n';
import { useUpdateProfile } from '@/hooks/useApi';
import { toast } from 'sonner';
import type { CurrentUserProfile } from './types';

export function ProfileSettings({ user }: { user: CurrentUserProfile | null }) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const updateProfile = useUpdateProfile();

  const [formData, setFormData] = useState({
    name: user?.name || '',
    email: user?.email || '',
    phone: '',
    department: user?.department || '',
  });

  const handleSubmit = async () => {
    try {
      const updatedUser = await updateProfile.mutate(formData);
      if (updatedUser) {
        const currentStored = localStorage.getItem('aerolink_user');
        const currentUser = currentStored ? (JSON.parse(currentStored) as Record<string, unknown>) : {};
        localStorage.setItem('aerolink_user', JSON.stringify({ ...currentUser, ...updatedUser }));
      }
      toast.success(tx('资料已更新', 'Profile updated'));
    } catch (_error) {
      toast.error(tx('更新失败', 'Update failed'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" data-settings-profile-grid>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{tx('个人资料', 'Profile')}</CardTitle>
            <CardDescription>{tx('管理您的账户信息和个人档案', 'Manage your account information and personal profile')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4 pb-4 border-b">
              <div className="w-20 h-20 bg-brand-primary rounded-full flex items-center justify-center">
                <User className="w-10 h-10 text-white" />
              </div>
              <div>
                <Button variant="outline" size="sm" disabled>{tx('更换头像', 'Change Avatar')}</Button>
                <p className="text-xs text-gray-500 mt-1">{tx('支持 JPG/PNG，最大 2MB', 'Supports JPG/PNG, up to 2MB')}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="settings-profile-name">{tx('姓名', 'Name')}</Label>
                <Input
                  id="settings-profile-name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="settings-profile-email">{tx('邮箱', 'Email')}</Label>
                <Input
                  id="settings-profile-email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="settings-profile-phone">{tx('电话', 'Phone')}</Label>
                <Input
                  id="settings-profile-phone"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder={tx('例如：+86-138-0000-0001', 'e.g. +86-138-0000-0001')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="settings-profile-department">{tx('部门', 'Department')}</Label>
                <Input
                  id="settings-profile-department"
                  value={formData.department}
                  onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                />
              </div>
            </div>

            <div className="pt-4">
              <Button
                onClick={handleSubmit}
                disabled={updateProfile.loading}
                className="bg-brand-primary text-slate-900 hover:bg-brand-primary-hover hover:text-slate-900"
              >
                <Save className="w-4 h-4 mr-2" />
                {tx('保存', 'Save')}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tx('账号信息', 'Account Info')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex min-w-0 flex-wrap justify-between gap-2 text-sm">
              <span className="text-gray-500">{tx('用户ID', 'User ID')}</span>
              <span className="min-w-0 break-all font-mono text-right">{user?.id || '-'}</span>
            </div>
            <div className="flex min-w-0 flex-wrap justify-between gap-2 text-sm">
              <span className="text-gray-500">{tx('角色', 'Role')}</span>
              <Badge variant="outline" className="min-w-0 max-w-full whitespace-normal break-words text-right">
                {user?.role === 'manager' ? tx('销售经理', 'Sales Manager')
                  : user?.role === 'sales' ? tx('销售', 'Sales')
                  : user?.role === 'finance' ? tx('财务', 'Finance')
                  : user?.role === 'gm' ? tx('总经理', 'General Manager')
                  : user?.role || '-'}
              </Badge>
            </div>
            <div className="flex min-w-0 flex-wrap justify-between gap-2 text-sm">
              <span className="text-gray-500">{tx('部门', 'Department')}</span>
              <span className="min-w-0 break-words text-right">{user?.department || '-'}</span>
            </div>
            <Separator />
            <div className="flex min-w-0 flex-wrap justify-between gap-2 text-sm">
              <span className="text-gray-500">{tx('最近登录', 'Last Login')}</span>
              <span className="min-w-0 break-words text-right">{new Date().toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
