import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, LogOut, Monitor, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n';
import { useChangePassword } from '@/hooks/useApi';
import { authApi, type ManagedSession, type SecurityEvent } from '@/api/client';
import { useAuthStore } from '@/store';
import { toast } from 'sonner';

export function SecuritySettings() {
  const { locale } = useTranslation();
  const tx = useCallback((zh: string, en: string) => (locale === 'zh-CN' ? zh : en), [locale]);
  const changePassword = useChangePassword();
  const logout = useAuthStore((state) => state.logout);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [securityEvents, setSecurityEvents] = useState<SecurityEvent[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionActionId, setSessionActionId] = useState<string | null>(null);

  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  const formatDate = (value: string | null) => value
    ? new Date(value).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')
    : '-';

  const loadSecurityData = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const [nextSessions, eventEnvelope] = await Promise.all([
        authApi.getSessions(),
        authApi.getSecurityEvents(20),
      ]);
      setSessions(nextSessions);
      setSecurityEvents(eventEnvelope.data || []);
    } catch (_error) {
      toast.error(tx('无法加载设备会话', 'Unable to load device sessions'));
    } finally {
      setSessionsLoading(false);
    }
  }, [tx]);

  useEffect(() => {
    void loadSecurityData();
  }, [loadSecurityData]);

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

  const handleRevokeSession = async (session: ManagedSession) => {
    setSessionActionId(session.id);
    try {
      await authApi.revokeSession(session.id);
      toast.success(tx('设备会话已撤销', 'Device session revoked'));
      if (session.isCurrent) {
        logout();
        return;
      }
      await loadSecurityData();
    } catch (_error) {
      toast.error(tx('撤销设备会话失败', 'Unable to revoke device session'));
    } finally {
      setSessionActionId(null);
    }
  };

  const handleRevokeAllSessions = async () => {
    if (!window.confirm(tx('这会退出所有设备（包括当前设备）。是否继续？', 'This signs out every device, including this one. Continue?'))) {
      return;
    }
    setSessionActionId('all');
    try {
      await authApi.revokeAllSessions();
      toast.success(tx('已撤销全部设备会话', 'All device sessions were revoked'));
      logout();
    } catch (_error) {
      toast.error(tx('撤销全部设备会话失败', 'Unable to revoke all device sessions'));
    } finally {
      setSessionActionId(null);
    }
  };

  const handleAcknowledgeEvent = async (eventId: string) => {
    setSessionActionId(eventId);
    try {
      await authApi.acknowledgeSecurityEvent(eventId);
      await loadSecurityData();
    } catch (_error) {
      toast.error(tx('确认安全事件失败', 'Unable to acknowledge security event'));
    } finally {
      setSessionActionId(null);
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
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="font-medium">{tx('设备会话', 'Device Sessions')}</h4>
                <p className="text-sm text-gray-500">
                  {tx('查看登录设备并在发现异常时立即撤销访问。', 'Review signed-in devices and revoke access immediately if anything looks unfamiliar.')}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void loadSecurityData()} disabled={sessionsLoading}>
                <RefreshCw className={sessionsLoading ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'} />
                {tx('刷新', 'Refresh')}
              </Button>
            </div>

            {sessionsLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {tx('正在加载设备会话…', 'Loading device sessions…')}
              </div>
            ) : sessions.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-gray-500">
                {tx('暂无可用的设备会话。下次登录后会在这里显示。', 'No managed device sessions yet. Your next login will appear here.')}
              </p>
            ) : (
              <div className="space-y-2">
                {sessions.map((session) => (
                  <div key={session.id} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex items-start gap-3">
                      <Monitor className="mt-0.5 h-5 w-5 shrink-0 text-gray-500" />
                      <div className="min-w-0">
                        <p className="font-medium">
                          {session.deviceName}
                          {session.isCurrent && <span className="ml-2 text-xs font-normal text-green-600">{tx('当前设备', 'Current device')}</span>}
                          {!session.isActive && <span className="ml-2 text-xs font-normal text-gray-500">{tx('已撤销', 'Revoked')}</span>}
                        </p>
                        <p className="truncate text-xs text-gray-500">
                          {session.ipAddress || tx('未知 IP', 'Unknown IP')} · {tx('最近活动：', 'Last active: ')}{formatDate(session.lastSeenAt)}
                        </p>
                        {session.revokedReason && <p className="text-xs text-amber-700">{session.revokedReason}</p>}
                      </div>
                    </div>
                    {session.isActive && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => void handleRevokeSession(session)}
                        disabled={sessionActionId === session.id}
                      >
                        {sessionActionId === session.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogOut className="mr-2 h-4 w-4" />}
                        {session.isCurrent ? tx('退出此设备', 'Sign out') : tx('撤销', 'Revoke')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <Button variant="destructive" size="sm" onClick={() => void handleRevokeAllSessions()} disabled={sessionActionId === 'all'}>
              {sessionActionId === 'all' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogOut className="mr-2 h-4 w-4" />}
              {tx('退出所有设备', 'Sign out all devices')}
            </Button>
          </div>
          <Separator />
          <div className="space-y-4">
            <div>
              <h4 className="font-medium">{tx('安全事件', 'Security Events')}</h4>
              <p className="text-sm text-gray-500">{tx('登录、撤销和令牌异常会记录在这里。', 'Sign-ins, revocations, and token anomalies are recorded here.')}</p>
            </div>
            {securityEvents.length === 0 ? (
              <p className="text-sm text-gray-500">{tx('暂无安全事件。', 'No security events yet.')}</p>
            ) : (
              <div className="space-y-2">
                {securityEvents.slice(0, 8).map((event) => (
                  <div key={event.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <ShieldAlert className={event.severity === 'WARNING' ? 'mt-0.5 h-5 w-5 shrink-0 text-amber-600' : 'mt-0.5 h-5 w-5 shrink-0 text-blue-600'} />
                      <div>
                        <p className="text-sm font-medium">{event.message}</p>
                        <p className="text-xs text-gray-500">{formatDate(event.createdAt)} · {event.ipAddress || tx('未知 IP', 'Unknown IP')}</p>
                      </div>
                    </div>
                    {event.status === 'OPEN' && (
                      <Button variant="outline" size="sm" onClick={() => void handleAcknowledgeEvent(event.id)} disabled={sessionActionId === event.id}>
                        {sessionActionId === event.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                        {tx('确认', 'Acknowledge')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
