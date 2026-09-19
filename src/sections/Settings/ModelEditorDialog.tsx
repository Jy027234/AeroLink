import { useEffect, useState } from 'react';
import { AlertCircle, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import type { ClientAIModel } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

export const SUPPORTED_MODEL_PROVIDERS = ['openai', 'deepseek', 'ollama', 'custom'] as const;
export type SupportedModelProvider = typeof SUPPORTED_MODEL_PROVIDERS[number];

const providerLabels: Record<SupportedModelProvider, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  ollama: 'Ollama（本地）',
  custom: 'Custom（OpenAI 协议兼容）',
};

function isSupportedProvider(provider: string): provider is SupportedModelProvider {
  return SUPPORTED_MODEL_PROVIDERS.includes(provider as SupportedModelProvider);
}

export function ModelEditorDialog({
  model,
  open,
  onOpenChange,
  onSubmit,
  busy,
  error,
  tx,
}: {
  model: ClientAIModel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  busy: boolean;
  error?: string | null;
  tx: (zh: string, en: string) => string;
}) {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<SupportedModelProvider>('openai');
  const [modelId, setModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [capabilities, setCapabilities] = useState('chat');
  const [omitTemperature, setOmitTemperature] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const existingProvider = model?.provider || 'openai';
    setName(model?.name || '');
    setProvider(isSupportedProvider(existingProvider) ? existingProvider : 'custom');
    setModelId(model?.modelId || '');
    setApiKey('');
    setBaseUrl(model?.baseUrl || '');
    setIsActive(model?.isActive ?? true);
    setIsDefault(model?.isDefault ?? false);
    setCapabilities(model?.capabilities?.join(', ') || 'chat');
    setOmitTemperature(model?.config?.omitTemperature === true);
    setShowApiKey(false);
    setValidationError(null);
  }, [model, open]);

  const handleSubmit = async () => {
    if (!name.trim() || !modelId.trim()) {
      setValidationError(tx('名称和模型 ID 为必填项。', 'Name and model ID are required.'));
      return;
    }
    if (!provider) {
      setValidationError(tx('请选择受支持的提供商。', 'Choose a supported provider.'));
      return;
    }
    setValidationError(null);
    const payload: Record<string, unknown> = {
      name: name.trim(),
      provider,
      modelId: modelId.trim(),
      baseUrl: baseUrl.trim() || undefined,
      isActive,
      isDefault,
      config: { ...(model?.config || {}), omitTemperature },
      capabilities: capabilities.split(',').map((item) => item.trim()).filter(Boolean),
    };
    // An existing secret is intentionally represented only by hasApiKey. Empty
    // input leaves it unchanged, so the secret can never be read back into form state.
    if (apiKey.trim()) payload.apiKey = apiKey.trim();
    await onSubmit(payload);
  };

  const existingProviderUnsupported = Boolean(model?.provider && !isSupportedProvider(model.provider));
  const baseUrlPlaceholder = provider === 'ollama'
    ? 'http://localhost:11434/v1'
    : provider === 'openai'
      ? 'https://api.openai.com/v1'
      : provider === 'deepseek'
        ? 'https://api.deepseek.com'
        : 'https://api.example.com/v1';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{model ? tx('编辑模型', 'Edit model') : tx('添加模型', 'Add model')}</DialogTitle>
          <DialogDescription>{tx('API Key 只写入服务端加密存储，页面不会回显已保存的密钥。', 'API keys are encrypted on the server and are never shown again.')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {error && <Alert variant="destructive"><AlertCircle /><AlertTitle>{tx('保存失败', 'Save failed')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="model-name">{tx('名称', 'Name')} *</Label><Input id="model-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={tx('例如：生产 OpenAI', 'e.g. Production OpenAI')} /></div>
            <div className="space-y-2"><Label htmlFor="model-provider">{tx('提供商', 'Provider')} *</Label><Select value={provider} onValueChange={(value: SupportedModelProvider) => setProvider(value)}><SelectTrigger id="model-provider"><SelectValue /></SelectTrigger><SelectContent>{SUPPORTED_MODEL_PROVIDERS.map((item) => <SelectItem key={item} value={item}>{providerLabels[item]}</SelectItem>)}</SelectContent></Select>{existingProviderUnsupported && <p className="text-xs text-amber-700">{tx(`当前提供商 ${model?.provider} 不在首期支持范围，请选择 openai、deepseek、ollama 或 custom。`, `Current provider ${model?.provider} is unsupported; choose openai, deepseek, ollama, or custom.`)}</p>}</div>
          </div>
          <div className="space-y-2"><Label htmlFor="model-id">{tx('模型 ID', 'Model ID')} *</Label><Input id="model-id" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={tx('可手动填写，例如 gpt-4o-mini', 'Enter a model ID, e.g. gpt-4o-mini')} /><p className="text-xs text-gray-500">{tx('模型 ID 支持手动填写，不由前端固定列表限制。', 'Model IDs are free-form and can be entered manually.')}</p></div>
          <div className="space-y-2"><Label htmlFor="model-api-key">API Key</Label><div className="relative"><Input id="model-api-key" type={showApiKey ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={model?.hasApiKey ? tx('已保存，留空保持不变', 'Saved; leave blank to keep it') : tx('请输入 API Key', 'Enter API key')} autoComplete="new-password" className="pr-10" /><button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500" aria-label={showApiKey ? tx('隐藏 API Key', 'Hide API key') : tx('显示 API Key', 'Show API key')} onClick={() => setShowApiKey((visible) => !visible)}>{showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>{model?.hasApiKey && <p className="flex items-center gap-1 text-xs text-green-700"><KeyRound className="h-3 w-3" />{tx('已保存（不会回显）', 'Saved (not shown)')}</p>}</div>
          <div className="space-y-2"><Label htmlFor="model-base-url">{tx('基础 URL', 'Base URL')}</Label><Input id="model-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={baseUrlPlaceholder} /><p className="text-xs text-gray-500">{tx('OpenAI 和 DeepSeek 可留空使用服务端官方地址；Ollama 和 custom 必须填写。localhost 指运行 API 服务的服务器或容器，不是访问页面的电脑。远程服务使用 HTTPS。', 'OpenAI and DeepSeek may use the server default when blank; Ollama and custom require a URL. localhost means the API server or container, not the computer viewing this page. Remote services must use HTTPS.')}</p></div>
          <div className="space-y-2"><Label htmlFor="model-capabilities">{tx('能力标签', 'Capabilities')}</Label><Input id="model-capabilities" value={capabilities} onChange={(event) => setCapabilities(event.target.value)} placeholder="chat, extraction" /><p className="text-xs text-gray-500">{tx('使用逗号分隔，例如 chat, extraction, analysis。', 'Comma-separated, e.g. chat, extraction, analysis.')}</p></div>
          <div className="rounded-md border bg-slate-50 p-3"><div className="flex items-center gap-2"><Switch id="model-omit-temperature" checked={omitTemperature} onCheckedChange={setOmitTemperature} /><Label htmlFor="model-omit-temperature">{tx('不向提供商发送 temperature', 'Omit temperature from provider request')}</Label></div><p className="mt-1 text-xs text-gray-500">{tx('仅部分 OpenAI 协议兼容服务需要此选项；其他高级传输参数暂不在页面配置。', 'Use this only for providers that reject temperature; other advanced transport parameters are not configured here.')}</p></div>
          <div className="flex flex-wrap gap-5"><div className="flex items-center gap-2"><Switch id="model-active" checked={isActive} onCheckedChange={setIsActive} /><Label htmlFor="model-active">{tx('启用模型', 'Model enabled')}</Label></div><div className="flex items-center gap-2"><Switch id="model-default" checked={isDefault} onCheckedChange={setIsDefault} /><Label htmlFor="model-default">{tx('设为默认模型', 'Set as default')}</Label></div></div>
          {validationError && <p className="text-sm text-red-600" role="alert">{validationError}</p>}
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tx('取消', 'Cancel')}</Button><Button type="button" onClick={() => void handleSubmit()} disabled={busy || !name.trim() || !modelId.trim()}>{busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{tx('保存', 'Save')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
