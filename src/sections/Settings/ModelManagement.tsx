import { useState } from 'react';
import { AlertCircle, Check, Cpu, Edit3, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { modelApi, type ClientAIModel } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { ModelEditorDialog, SUPPORTED_MODEL_PROVIDERS } from './ModelEditorDialog';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const providerLabels: Record<string, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  ollama: 'Ollama（本地）',
  custom: 'Custom',
};

function providerLabel(provider: string, tx: (zh: string, en: string) => string): string {
  if (providerLabels[provider]) return providerLabels[provider];
  return `${provider}（${tx('当前不支持', 'unsupported')}）`;
}

export function ModelManagement({
  models,
  onModelsChange,
  tx,
}: {
  models: ClientAIModel[];
  onModelsChange: (models: ClientAIModel[]) => void;
  tx: (zh: string, en: string) => string;
}) {
  const [editingModel, setEditingModel] = useState<ClientAIModel | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ClientAIModel | null>(null);
  const [busyModelId, setBusyModelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async (model: ClientAIModel, isActive: boolean) => {
    setBusyModelId(model.id);
    setError(null);
    try {
      const updated = await modelApi.update(model.id, { isActive });
      onModelsChange(models.map((item) => item.id === updated.id ? updated : item));
    } catch (toggleError) {
      const message = getErrorMessage(toggleError, tx('更新模型状态失败', 'Failed to update model status'));
      setError(message);
    } finally {
      setBusyModelId(null);
    }
  };

  const handleSetDefault = async (model: ClientAIModel) => {
    setBusyModelId(model.id);
    setError(null);
    try {
      await modelApi.setDefault(model.id);
      const refreshed = await modelApi.getAll();
      onModelsChange(refreshed);
    } catch (defaultError) {
      const message = getErrorMessage(defaultError, tx('设置默认模型失败', 'Failed to set default model'));
      setError(message);
    } finally {
      setBusyModelId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setBusyModelId(deleteTarget.id);
    setError(null);
    try {
      await modelApi.delete(deleteTarget.id);
      onModelsChange(models.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (deleteError) {
      const message = getErrorMessage(deleteError, tx('删除模型失败', 'Failed to delete model'));
      setError(message);
    } finally {
      setBusyModelId(null);
    }
  };

  const handleSubmit = async (payload: Record<string, unknown>) => {
    setError(null);
    const isEditing = Boolean(editingModel);
    setBusyModelId(editingModel?.id || 'new');
    try {
      const saved = editingModel
        ? await modelApi.update(editingModel.id, payload)
        : await modelApi.create(payload);
      onModelsChange(isEditing ? models.map((item) => item.id === saved.id ? saved : item) : [saved, ...models]);
      setEditorOpen(false);
      setEditingModel(null);
    } catch (saveError) {
      const message = getErrorMessage(saveError, tx('保存模型失败', 'Failed to save model'));
      setError(message);
    } finally {
      setBusyModelId(null);
    }
  };

  const openNew = () => { setEditingModel(null); setEditorOpen(true); };
  const openEdit = (model: ClientAIModel) => { setEditingModel(model); setEditorOpen(true); };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div><CardTitle>{tx('实际模型配置', 'Configured models')}</CardTitle><CardDescription>{tx('提供商只支持 OpenAI 协议兼容的 openai、deepseek、ollama、custom。模型 ID 可手动填写。', 'Supported providers are OpenAI-compatible openai, deepseek, ollama, and custom. Model IDs are free-form.')}</CardDescription></div>
          <Button onClick={openNew}><Plus className="mr-1.5 h-4 w-4" />{tx('添加模型', 'Add model')}</Button>
        </CardHeader>
        <CardContent>
          {error && <Alert variant="destructive" className="mb-4"><AlertCircle /><AlertTitle>{tx('请求失败', 'Request failed')}</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-3"><span>{error}</span><Button size="sm" variant="outline" onClick={() => setError(null)}><RefreshCw className="mr-1.5 h-4 w-4" />{tx('关闭提示', 'Dismiss')}</Button></AlertDescription></Alert>}
          {models.length === 0 ? <div className="rounded-lg border border-dashed px-6 py-14 text-center text-gray-500"><Cpu className="mx-auto mb-3 h-12 w-12 text-gray-300" /><p className="font-medium text-gray-700">{tx('暂无模型', 'No models configured')}</p><p className="mt-1 text-sm">{tx('先添加一个真实模型，智能体才能发布并试运行。', 'Add a real model before publishing or testing an agent.')}</p><Button className="mt-4" variant="outline" onClick={openNew}><Plus className="mr-1.5 h-4 w-4" />{tx('添加模型', 'Add model')}</Button></div> : <div className="space-y-3">{models.map((model) => { const supported = SUPPORTED_MODEL_PROVIDERS.includes(model.provider as typeof SUPPORTED_MODEL_PROVIDERS[number]); return <div key={model.id} className="rounded-lg border p-4"><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="flex min-w-0 gap-3"><div className="rounded-lg bg-slate-100 p-2 text-slate-600"><Cpu className="h-5 w-5" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{model.name}</h3>{model.isDefault && <Badge className="border-blue-300 bg-blue-50 text-blue-700"><Check className="mr-1 h-3 w-3" />{tx('默认', 'Default')}</Badge>}{!supported && <Badge variant="destructive">{tx('不支持', 'Unsupported')}</Badge>}</div><p className="mt-1 text-sm text-gray-600">{providerLabel(model.provider, tx)} · <span className="font-mono">{model.modelId}</span></p><div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500"><span className="inline-flex items-center gap-1">{model.hasApiKey ? <><KeyRound className="h-3 w-3 text-green-600" />{tx('密钥已保存', 'API key saved')}</> : tx('未配置密钥', 'No API key')}</span>{model.baseUrl && <span className="font-mono">{model.baseUrl}</span>}{model.capabilities.map((capability) => <Badge key={capability} variant="secondary" className="text-[11px]">{capability}</Badge>)}</div></div></div><div className="flex flex-wrap items-center gap-2"><div className="flex items-center gap-2 rounded-md border px-2 py-1.5"><Switch checked={model.isActive} disabled={busyModelId === model.id} aria-label={tx(`切换 ${model.name}`, `Toggle ${model.name}`)} onCheckedChange={(checked) => void handleToggle(model, checked)} /><span className={model.isActive ? 'text-sm text-green-700' : 'text-sm text-gray-500'}>{model.isActive ? tx('启用', 'Enabled') : tx('禁用', 'Disabled')}</span></div>{!model.isDefault && <Button variant="outline" size="sm" disabled={!model.isActive || busyModelId === model.id} onClick={() => void handleSetDefault(model)}>{busyModelId === model.id && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}{tx('设为默认', 'Set default')}</Button>}<Button variant="ghost" size="icon" aria-label={tx(`编辑 ${model.name}`, `Edit ${model.name}`)} onClick={() => openEdit(model)}><Edit3 className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label={tx(`删除 ${model.name}`, `Delete ${model.name}`)} disabled={model.isDefault || busyModelId === model.id} onClick={() => setDeleteTarget(model)}><Trash2 className="h-4 w-4 text-red-500" /></Button></div></div></div>; })}</div>}
        </CardContent>
      </Card>

      <ModelEditorDialog model={editingModel} open={editorOpen} onOpenChange={(open) => { setEditorOpen(open); if (!open) setEditingModel(null); }} onSubmit={handleSubmit} busy={busyModelId !== null} tx={tx} />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{tx('确认删除模型', 'Delete model?')}</AlertDialogTitle><AlertDialogDescription>{tx(`确定要删除“${deleteTarget?.name || ''}”吗？使用它的智能体将变为未配置模型。`, `Delete “${deleteTarget?.name || ''}”? Agents using it will have no available model.`)}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{tx('取消', 'Cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => void handleDelete()}>{tx('删除', 'Delete')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </>
  );
}
