import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n';
import { useNotificationPreference, useUpdateNotificationPreference } from '@/hooks/useApi';
import { toast } from 'sonner';

export function NotificationSettings() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: preference, loading, refetch } = useNotificationPreference();
  const updatePreference = useUpdateNotificationPreference();

  const [settings, setSettings] = useState({
    emailNotify: true,
    systemNotify: true,
    approvalNotify: true,
    aogAlert: true,
    weeklyReport: false,
    wechatNotify: false,
    dingtalkNotify: false,
    larkNotify: false,
    smsNotify: false,
    pushNotify: false,
  });

  useEffect(() => {
    if (preference) {
      setSettings({
        emailNotify: preference.emailNotify,
        systemNotify: preference.systemNotify,
        approvalNotify: preference.approvalNotify,
        aogAlert: preference.aogAlert,
        weeklyReport: preference.weeklyReport,
        wechatNotify: preference.wechatNotify ?? false,
        dingtalkNotify: preference.dingtalkNotify ?? false,
        larkNotify: preference.larkNotify ?? false,
        smsNotify: preference.smsNotify ?? false,
        pushNotify: preference.pushNotify ?? false,
      });
    }
  }, [preference]);

  const handleToggle = async (key: keyof typeof settings) => {
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    try {
      await updatePreference.mutate(next);
      toast.success(tx('偏好已更新', 'Preference updated'));
      await refetch();
    } catch (_error) {
      toast.error(tx('更新失败', 'Update failed'));
      setSettings(settings); // rollback
    }
  };

  const baseItems = [
    { key: 'emailNotify' as const, label: tx('邮件通知', 'Email Notifications'), desc: tx('接收系统邮件通知', 'Receive system email notifications') },
    { key: 'systemNotify' as const, label: tx('站内通知', 'System Notifications'), desc: tx('在应用内显示通知', 'Show notifications in app') },
    { key: 'approvalNotify' as const, label: tx('审批提醒', 'Approval Alerts'), desc: tx('待审批事项提醒', 'Reminders for pending approvals') },
    { key: 'aogAlert' as const, label: tx('AOG预警', 'AOG Alerts'), desc: tx('紧急需求与AOG预警', 'Alerts for urgent requests and AOG') },
    { key: 'weeklyReport' as const, label: tx('周报', 'Weekly Report'), desc: tx('接收每周业务摘要', 'Receive weekly business summary') },
  ];

  const imItems = [
    { key: 'wechatNotify' as const, label: tx('企业微信通知', 'WeChat Work Notifications'), desc: tx('通过企业微信接收通知', 'Receive notifications via WeChat Work') },
    { key: 'dingtalkNotify' as const, label: tx('钉钉通知', 'DingTalk Notifications'), desc: tx('通过钉钉接收通知', 'Receive notifications via DingTalk') },
    { key: 'larkNotify' as const, label: tx('飞书通知', 'Lark Notifications'), desc: tx('通过飞书接收通知', 'Receive notifications via Lark') },
    { key: 'smsNotify' as const, label: tx('短信通知', 'SMS Notifications'), desc: tx('通过短信接收紧急通知（仅AOG）', 'Receive urgent notifications via SMS (AOG only)') },
    { key: 'pushNotify' as const, label: tx('浏览器推送', 'Browser Push'), desc: tx('通过浏览器桌面通知接收提醒', 'Receive desktop notifications via browser push') },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{tx('通知偏好', 'Notification Preferences')}</CardTitle>
          <CardDescription>{tx('配置您希望接收的通知类型', 'Configure which notifications you want to receive')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && (
            <p className="text-sm text-gray-500">{tx('加载中...', 'Loading...')}</p>
          )}

          <div className="space-y-1">
            <p className="text-sm font-medium text-gray-500 mb-2">{tx('基础通知', 'Basic Notifications')}</p>
            {baseItems.map((item) => (
              <div key={item.key} className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="font-medium">{item.label}</p>
                  <p className="text-sm text-gray-500">{item.desc}</p>
                </div>
                <Switch
                  checked={settings[item.key]}
                  onCheckedChange={() => handleToggle(item.key)}
                  disabled={updatePreference.loading}
                />
              </div>
            ))}
          </div>

          <div className="space-y-1 pt-2 border-t">
            <p className="text-sm font-medium text-gray-500 mb-2">{tx('即时通讯通知', 'Instant Messaging Notifications')}</p>
            {imItems.map((item) => (
              <div key={item.key} className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <p className="font-medium">{item.label}</p>
                  <p className="text-sm text-gray-500">{item.desc}</p>
                </div>
                <Switch
                  checked={settings[item.key]}
                  onCheckedChange={() => handleToggle(item.key)}
                  disabled={updatePreference.loading}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
