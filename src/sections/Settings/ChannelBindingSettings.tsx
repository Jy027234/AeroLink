import { useState, useEffect } from 'react';
import {
  MessageCircle,
  Plus,
  Trash2,
  CheckCircle,
  XCircle,
  Loader2,
  Link,
  Smartphone,
  Bell,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  useChannelBindings,
  useCreateChannelBinding,
  useUpdateChannelBinding,
  useDeleteChannelBinding,
  useVapidPublicKey,
  usePushSubscribe,
  usePushUnsubscribe,
} from '@/hooks/useApi';
import {
  isPushSupported,
  registerServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
  isPushSubscribed,
} from '@/lib/pushNotification';

const channelConfig: Record<string, { label: string; icon: React.ElementType; color: string; bgColor: string; fields: { key: string; label: string; placeholder: string }[] }> = {
  WECHAT: {
    label: '企业微信',
    icon: MessageCircle,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
    fields: [
      { key: 'openId', label: 'OpenID', placeholder: '企业微信用户 OpenID' },
      { key: 'corpId', label: '企业ID', placeholder: '企业微信 CorpID' },
    ],
  },
  DINGTALK: {
    label: '钉钉',
    icon: MessageCircle,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
    fields: [
      { key: 'openId', label: 'OpenID', placeholder: '钉钉用户 OpenID' },
      { key: 'corpId', label: '企业ID', placeholder: '钉钉 CorpID' },
    ],
  },
  LARK: {
    label: '飞书',
    icon: MessageCircle,
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
    fields: [
      { key: 'openId', label: 'OpenID', placeholder: '飞书用户 OpenID' },
      { key: 'unionId', label: 'UnionID', placeholder: '飞书 UnionID' },
    ],
  },
  SMS: {
    label: '短信',
    icon: Smartphone,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
    fields: [
      { key: 'phone', label: '手机号', placeholder: '+86 13800138000' },
    ],
  },
  SLACK: {
    label: 'Slack',
    icon: MessageCircle,
    color: 'text-pink-600',
    bgColor: 'bg-pink-50',
    fields: [
      { key: 'userId', label: 'User ID', placeholder: 'Slack User ID (U12345678)' },
      { key: 'workspace', label: 'Workspace', placeholder: 'Slack Workspace URL' },
    ],
  },
  TEAMS: {
    label: 'Microsoft Teams',
    icon: MessageCircle,
    color: 'text-indigo-600',
    bgColor: 'bg-indigo-50',
    fields: [
      { key: 'userId', label: 'User ID', placeholder: 'Teams User ID / Email' },
      { key: 'tenantId', label: 'Tenant ID', placeholder: 'Microsoft Tenant ID' },
    ],
  },
};

export function ChannelBindingSettings() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState<string>('');
  const [formValues, setFormValues] = useState<Record<string, string>>({});

  // Push subscription state
  const [pushSupported, setPushSupported] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const { data: bindings, loading: bindingsLoading, error: bindingsError, refetch } = useChannelBindings();
  const { mutate: createBinding, loading: createLoading } = useCreateChannelBinding();
  const { mutate: updateBinding } = useUpdateChannelBinding();
  const { mutate: deleteBinding } = useDeleteChannelBinding();
  const { data: vapidKey } = useVapidPublicKey();
  const { mutate: pushSubscribeApi } = usePushSubscribe();
  const { mutate: pushUnsubscribeApi } = usePushUnsubscribe();

  useEffect(() => {
    setPushSupported(isPushSupported());
    if (isPushSupported()) {
      void checkPushStatus();
    }
  }, []);

  const checkPushStatus = async () => {
    const subscribed = await isPushSubscribed();
    setPushSubscribed(subscribed);
  };

  const handleCreate = async () => {
    if (!selectedChannel) return;
    const config: Record<string, string> = {};
    channelConfig[selectedChannel].fields.forEach((f) => {
      if (formValues[f.key]) config[f.key] = formValues[f.key];
    });
    if (Object.keys(config).length === 0) return;

    const res = await createBinding({ channel: selectedChannel, config });
    if (res) {
      setIsCreateOpen(false);
      setSelectedChannel('');
      setFormValues({});
      void refetch();
    }
  };

  const handleToggle = async (id: string, currentActive: boolean) => {
    const res = await updateBinding({ id, isActive: !currentActive });
    if (res) {
      void refetch();
    }
  };

  const handleDelete = async (id: string) => {
    setDeleteTargetId(id);
  };

  const confirmDelete = async () => {
    if (!deleteTargetId) return;
    const res = await deleteBinding(deleteTargetId);
    if (res) {
      void refetch();
    }
    setDeleteTargetId(null);
  };

  const handlePushSubscribe = async () => {
    if (!vapidKey?.publicKey) {
      toast.error(tx('VAPID 公钥未配置，请联系管理员。', 'VAPID public key not configured. Please contact admin.'));
      return;
    }
    setPushLoading(true);
    try {
      await registerServiceWorker();
      const subscription = await subscribeToPush(vapidKey.publicKey);
      if (subscription) {
        await pushSubscribeApi(subscription);
        setPushSubscribed(true);
        toast.success(tx('浏览器推送订阅成功！', 'Browser push subscription successful!'));
      }
    } catch (error) {
      console.error('Push subscription failed:', error);
      toast.error(tx('订阅失败：', 'Subscription failed: ') + (error instanceof Error ? error.message : String(error)));
    } finally {
      setPushLoading(false);
    }
  };

  const handlePushUnsubscribe = async () => {
    setPushLoading(true);
    try {
      await unsubscribeFromPush();
      await pushUnsubscribeApi();
      setPushSubscribed(false);
      toast.info(tx('已取消浏览器推送订阅。', 'Browser push subscription cancelled.'));
    } catch (error) {
      console.error('Push unsubscribe failed:', error);
    } finally {
      setPushLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{tx('通知渠道绑定', 'Notification Channel Bindings')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {tx('绑定企业微信、钉钉、飞书等即时通讯账号，接收系统通知', 'Bind WeChat Work, DingTalk, Lark and other IM accounts to receive system notifications')}
          </p>
        </div>
        <Button className="bg-brand-primary hover:bg-brand-primary-hover" onClick={() => setIsCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-1" />
          {tx('绑定新渠道', 'Bind New Channel')}
        </Button>
      </div>

      {/* Browser Push Card */}
      {pushSupported && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                  <Bell className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{tx('浏览器推送', 'Browser Push')}</span>
                    {pushSubscribed ? (
                      <Badge className="bg-green-100 text-green-700 border-0">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        {tx('已订阅', 'Subscribed')}
                      </Badge>
                    ) : (
                      <Badge className="bg-gray-100 text-gray-700 border-0">
                        <XCircle className="w-3 h-3 mr-1" />
                        {tx('未订阅', 'Not Subscribed')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    {tx('通过浏览器桌面通知接收系统提醒，即使应用未打开也能收到。', 'Receive system alerts via browser desktop notifications, even when the app is closed.')}
                  </p>
                </div>
              </div>
              <div>
                {pushSubscribed ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handlePushUnsubscribe}
                    disabled={pushLoading}
                  >
                    {pushLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                    {tx('取消订阅', 'Unsubscribe')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="bg-brand-primary hover:bg-brand-primary-hover"
                    onClick={handlePushSubscribe}
                    disabled={pushLoading || !vapidKey}
                  >
                    {pushLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
                    {tx('订阅推送', 'Subscribe')}
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Channel cards */}
      {bindingsLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : bindingsError ? (
        <p className="text-sm text-red-500">{bindingsError}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {bindings && bindings.length > 0 ? (
            bindings.map((binding) => {
              const config = channelConfig[binding.channel];
              const ChannelIcon = config?.icon || MessageCircle;
              return (
                <Card key={binding.id} className={cn(binding.isActive ? '' : 'opacity-60')}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center', config?.bgColor || 'bg-gray-50')}>
                          <ChannelIcon className={cn('w-5 h-5', config?.color || 'text-gray-500')} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{config?.label || binding.channel}</span>
                            {binding.isActive ? (
                              <Badge className="bg-green-100 text-green-700 border-0">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                {tx('已启用', 'Active')}
                              </Badge>
                            ) : (
                              <Badge className="bg-gray-100 text-gray-700 border-0">
                                <XCircle className="w-3 h-3 mr-1" />
                                {tx('已停用', 'Inactive')}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-2 space-y-1 text-sm text-gray-500">
                            {Object.entries(binding.config).map(([key, value]) => (
                              <p key={key}>
                                <span className="text-gray-400">{key}:</span> {value}
                              </p>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleToggle(binding.id, binding.isActive)}
                        >
                          {binding.isActive ? (
                            <XCircle className="w-4 h-4 text-gray-400" />
                          ) : (
                            <CheckCircle className="w-4 h-4 text-green-500" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(binding.id)}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          ) : (
            <Card className="col-span-2">
              <CardContent className="p-8 text-center text-gray-500">
                <Link className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                <p>{tx('暂无渠道绑定', 'No channel bindings yet')}</p>
                <p className="text-sm mt-1">{tx('点击右上角绑定企业微信、钉钉或飞书账号', 'Click the button above to bind WeChat Work, DingTalk or Lark')}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tx('绑定通知渠道', 'Bind Notification Channel')}</DialogTitle>
            <DialogDescription className="sr-only">{tx('绑定用户通知渠道', 'Bind user notification channel')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{tx('选择渠道', 'Select Channel')}</Label>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(channelConfig).map(([key, config]) => {
                  const ChannelIcon = config.icon;
                  return (
                    <button
                      key={key}
                      className={cn(
                        'flex items-center gap-2 p-3 rounded-lg border transition-all',
                        selectedChannel === key
                          ? 'border-brand-primary bg-blue-50'
                          : 'border-gray-200 hover:border-gray-300'
                      )}
                      onClick={() => {
                        setSelectedChannel(key);
                        setFormValues({});
                      }}
                    >
                      <ChannelIcon className={cn('w-5 h-5', config.color)} />
                      <span className="text-sm font-medium">{config.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {selectedChannel && (
              <div className="space-y-3">
                <Label>{tx('配置信息', 'Configuration')}</Label>
                {channelConfig[selectedChannel].fields.map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label className="text-sm">{field.label}</Label>
                    <Input
                      placeholder={field.placeholder}
                      value={formValues[field.key] || ''}
                      onChange={(e) => setFormValues({ ...formValues, [field.key]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsCreateOpen(false); setSelectedChannel(''); setFormValues({}); }}>
              {tx('取消', 'Cancel')}
            </Button>
            <Button
              className="bg-brand-primary hover:bg-brand-primary-hover"
              onClick={handleCreate}
              disabled={createLoading || !selectedChannel}
            >
              {createLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              {tx('绑定', 'Bind')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTargetId} onOpenChange={(open) => { if (!open) setDeleteTargetId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tx('确认删除', 'Confirm Delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tx('确定要删除此渠道绑定吗？此操作不可撤销。', 'Are you sure you want to delete this channel binding? This action cannot be undone.')}
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
