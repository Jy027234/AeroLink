import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n';
import { useChangePassword } from '@/hooks/useApi';
import { toast } from 'sonner';

export function SecuritySettings() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const changePassword = useChangePassword();

  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  const handleChangePassword = async () => {
    if (!passwordForm.currentPassword || !passwordForm.newPassword) {
      toast.warning(tx('请填写当前密码和新密码', 'Please fill in current and new password'));
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast.warning(tx('两次输入的新密码不一致', 'New passwords do not match'));
      return;
    }
    try {
      await changePassword.mutate({
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      });
      toast.success(tx('密码已更新', 'Password updated'));
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (_error) {
      toast.error(tx('密码更新失败', 'Password update failed'));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{tx('安全设置', 'Security Settings')}</CardTitle>
          <CardDescription>{tx('管理账户安全与访问控制', 'Manage account security and access control')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <h4 className="font-medium">{tx('修改密码', 'Change Password')}</h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx('当前密码', 'Current Password')}</Label>
                <Input
                  type="password"
                  value={passwordForm.currentPassword}
                  onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{tx('新密码', 'New Password')}</Label>
                <Input
                  type="password"
                  value={passwordForm.newPassword}
                  onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                />
              </div>
              <div className="space-y-2 col-span-2">
                <Label>{tx('确认新密码', 'Confirm New Password')}</Label>
                <Input
                  type="password"
                  value={passwordForm.confirmPassword}
                  onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                />
              </div>
            </div>
            <Button
              onClick={handleChangePassword}
              disabled={changePassword.loading}
            >
              {tx('更新密码', 'Update Password')}
            </Button>
          </div>
          <Separator />
          <div className="space-y-4">
            <h4 className="font-medium">{tx('双重认证', 'Two-factor Authentication')}</h4>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div>
                <p className="font-medium">{tx('启用双重认证', 'Enable Two-factor Authentication')}</p>
                <p className="text-sm text-gray-500">{tx('增强账户安全', 'Enhance account security')}</p>
              </div>
              <Switch disabled />
            </div>
          </div>
          <Separator />
          <div className="space-y-4">
            <h4 className="font-medium">{tx('登录日志', 'Login Log')}</h4>
            <div className="text-sm text-gray-500">
              <p>{tx('上次登录：', 'Last login: ')}{new Date().toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</p>
              <p className="text-xs mt-1">{tx('当前会话正常', 'Current session is normal')}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
