import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, History, Loader2, Plus, RotateCcw, Save, Send, TestTube2, Trash2 } from 'lucide-react';
import { agentApi, type AgentConfig, type AgentPrompt, type AIAgentVersion, type ClientAIAgent, type ClientAIModel } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n';
import { toast } from 'sonner';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function clonePrompts(prompts: AgentPrompt[]): AgentPrompt[] {
  return prompts.map((prompt) => ({ role: prompt.role, content: prompt.content }));
}

function getModelForReference(reference: string | null | undefined, models: ClientAIModel[]): ClientAIModel | undefined {
  if (!reference) return models.find((model) => model.isDefault && model.isActive);
  return models.find((model) => model.id === reference || model.modelId === reference);
}

function hasRequiredModelCredential(model: ClientAIModel): boolean {
  if (model.hasApiKey) return true;
  if (model.provider !== 'ollama' || !model.baseUrl) return false;
  try {
    const hostname = new URL(model.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function normalizeInputExample(value: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(value || {}, null, 2);
}

function validateDraft(prompts: AgentPrompt[], config: AgentConfig, tx: (zh: string, en: string) => string): string | null {
  if (prompts.length === 0) return tx('至少需要一条提示词。', 'At least one prompt is required.');
  if (!prompts.some((prompt) => prompt.role === 'user')) return tx('提示词至少需要一条 user 消息。', 'At least one user prompt is required.');
  if (prompts.some((prompt) => !prompt.content.trim())) return tx('提示词内容不能为空。', 'Prompt content cannot be empty.');
  if (config.temperature !== undefined && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) {
    return tx('temperature 必须在 0 到 2 之间。', 'Temperature must be between 0 and 2.');
  }
  if (config.maxTokens !== undefined && (!Number.isInteger(config.maxTokens) || config.maxTokens < 1)) {
    return tx('maxTokens 必须是正整数。', 'maxTokens must be a positive integer.');
  }
  return null;
}

function statusForAgent(
  agent: ClientAIAgent,
  model: ClientAIModel | undefined,
  tx: (zh: string, en: string) => string,
) {
  if (!agent.isActive) return { label: tx('已禁用', 'Disabled'), className: 'border-gray-300 bg-gray-100 text-gray-600' };
  if (!model) return { label: tx('模型不存在', 'Model unavailable'), className: 'border-amber-300 bg-amber-50 text-amber-700' };
  if (!model.isActive) return { label: tx('模型已停用', 'Model disabled'), className: 'border-amber-300 bg-amber-50 text-amber-700' };
  if (!hasRequiredModelCredential(model)) return { label: tx('缺少模型密钥', 'Missing model key'), className: 'border-amber-300 bg-amber-50 text-amber-700' };
  if (agent.publishedVersion === null) return { label: tx('未发布', 'Unpublished'), className: 'border-blue-300 bg-blue-50 text-blue-700' };
  return { label: tx(`已发布 v${agent.publishedVersion}`, `Published v${agent.publishedVersion}`), className: 'border-green-300 bg-green-50 text-green-700' };
}

export function AgentEditor({
  agent,
  models,
  open,
  onOpenChange,
  onSaved,
}: {
  agent: ClientAIAgent | null;
  models: ClientAIModel[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (agent: ClientAIAgent) => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [prompts, setPrompts] = useState<AgentPrompt[]>([]);
  const [config, setConfig] = useState<AgentConfig>({});
  const [isActive, setIsActive] = useState(true);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [versions, setVersions] = useState<AIAgentVersion[]>([]);
  const [publishedConfig, setPublishedConfig] = useState<AgentConfig | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'save' | 'publish' | 'restore' | 'test' | null>(null);
  const [testInput, setTestInput] = useState('{}');
  const [testOutput, setTestOutput] = useState<{ output: string; model: string; latency: number; promptVersion: number } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const snapshot = useMemo(() => JSON.stringify({ prompts, config, isActive }), [prompts, config, isActive]);
  const isDirty = Boolean(savedSnapshot) && snapshot !== savedSnapshot;
  const modelReference = typeof config.modelId === 'string' && config.modelId ? config.modelId : null;
  const model = getModelForReference(modelReference, models);
  const selectedModelValue = modelReference ? (model?.id || modelReference) : '__none__';
  const publishedModelReference = typeof publishedConfig?.modelId === 'string' && publishedConfig.modelId
    ? publishedConfig.modelId
    : null;
  const publishedModel = getModelForReference(publishedModelReference, models);
  const statusModel = publishedConfig ? publishedModel : model;
  const runtimeModel = publishedConfig ? publishedModel : model;
  const status = agent ? statusForAgent(agent, statusModel, tx) : null;
  const canTest = Boolean(
    agent
      && agent.isActive
      && agent.publishedVersion !== null
      && publishedConfig
      && publishedModel?.isActive
      && hasRequiredModelCredential(publishedModel),
  );

  useEffect(() => {
    if (!agent || !open) return;
    const nextPrompts = clonePrompts(agent.prompts || []);
    const nextConfig = { ...(agent.config || {}) };
    const configuredModelReference = typeof nextConfig.modelId === 'string' && nextConfig.modelId.trim()
      ? nextConfig.modelId
      : null;
    const configuredModel = configuredModelReference
      ? getModelForReference(configuredModelReference, models)
      : undefined;
    if (configuredModel && configuredModelReference !== configuredModel.id) nextConfig.modelId = configuredModel.id;
    const nextState = { prompts: nextPrompts, config: nextConfig, isActive: agent.isActive };
    setPrompts(nextPrompts);
    setConfig(nextConfig);
    setIsActive(agent.isActive);
    setSavedSnapshot(JSON.stringify(nextState));
    setActionError(null);
    setTestError(null);
    setTestOutput(null);
    setVersions([]);
    setPublishedConfig(null);
    setTestInput(normalizeInputExample(agent.workflow?.inputExample));
  // The draft must not be reset when a save updates the selected agent object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, open]);

  const loadVersions = async (agentForHistory: ClientAIAgent | null = agent) => {
    if (!agentForHistory) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const nextVersions = await agentApi.getVersions(agentForHistory.id);
      setVersions(nextVersions);
      const published = agentForHistory.publishedVersion === null
        ? undefined
        : nextVersions.find((version) => version.version === agentForHistory.publishedVersion);
      setPublishedConfig(published ? { ...published.config } : null);
    } catch (error) {
      setHistoryError(getErrorMessage(error, tx('加载版本历史失败', 'Failed to load version history')));
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (agent && open) void loadVersions();
  // Loading is intentionally tied to the selected agent and dialog visibility.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, open]);

  const setConfigValue = (key: keyof AgentConfig, value: unknown) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    if (!agent) return;
    const validationError = validateDraft(prompts, config, tx);
    if (validationError) {
      setActionError(validationError);
      return;
    }
    setBusyAction('save');
    setActionError(null);
    try {
      const updated = await agentApi.update(agent.id, {
        expectedRevision: agent.draftRevision,
        prompts,
        config,
        isActive,
      });
      onSaved(updated);
      setSavedSnapshot(JSON.stringify({ prompts, config, isActive }));
      toast.success(tx('草稿已保存', 'Draft saved'));
    } catch (error) {
      const message = getErrorMessage(error, tx('保存草稿失败', 'Failed to save draft'));
      setActionError(message);
      toast.error(message);
    } finally {
      setBusyAction(null);
    }
  };

  const handlePublish = async () => {
    if (!agent) return;
    if (isDirty) {
      setActionError(tx('请先保存当前草稿，再发布。', 'Save the current draft before publishing.'));
      return;
    }
    const validationError = validateDraft(prompts, config, tx);
    if (validationError) {
      setActionError(validationError);
      return;
    }
    setBusyAction('publish');
    setActionError(null);
    try {
      const updated = await agentApi.publish(agent.id, agent.draftRevision);
      onSaved(updated);
      toast.success(tx(`已发布 v${updated.publishedVersion ?? ''}`, `Published v${updated.publishedVersion ?? ''}`));
      await loadVersions(updated);
    } catch (error) {
      const message = getErrorMessage(error, tx('发布失败', 'Failed to publish'));
      setActionError(message);
      toast.error(message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestore = async (version: AIAgentVersion) => {
    if (!agent) return;
    setBusyAction('restore');
    setActionError(null);
    try {
      const updated = await agentApi.restore(agent.id, version.version, agent.draftRevision);
      onSaved(updated);
      setPrompts(clonePrompts(updated.prompts));
      setConfig({ ...(updated.config || {}) });
      setIsActive(updated.isActive);
      setSavedSnapshot(JSON.stringify({ prompts: updated.prompts, config: updated.config, isActive: updated.isActive }));
      toast.success(tx(`已恢复 v${version.version} 为草稿`, `Version ${version.version} restored as draft`));
    } catch (error) {
      const message = getErrorMessage(error, tx('恢复版本失败', 'Failed to restore version'));
      setActionError(message);
      toast.error(message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleTest = async () => {
    if (!agent) return;
    if (!canTest) {
      setTestError(tx('只有启用、已发布且已配置启用模型的智能体才能试运行。', 'Only an enabled, published agent with an active model can be tested.'));
      return;
    }
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(testInput);
    } catch {
      setTestError(tx('试运行输入必须是合法 JSON。', 'Test input must be valid JSON.'));
      return;
    }
    if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) {
      setTestError(tx('试运行输入必须是 JSON 对象。', 'Test input must be a JSON object.'));
      return;
    }
    setBusyAction('test');
    setTestError(null);
    setTestOutput(null);
    try {
      const result = await agentApi.test(agent.id, parsedInput as Record<string, unknown>);
      setTestOutput(result);
    } catch (error) {
      setTestError(getErrorMessage(error, tx('试运行失败', 'Test run failed')));
    } finally {
      setBusyAction(null);
    }
  };

  const title = agent?.workflow?.label || agent?.name || tx('编辑智能体', 'Edit agent');
  const currentModelOption = modelReference && !model ? (
    <SelectItem value={modelReference}>{tx(`当前配置（${modelReference}，不可用）`, `Current setting (${modelReference}, unavailable)`)}</SelectItem>
  ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>{title}</DialogTitle>
            {status && <Badge className={status.className}>{status.label}</Badge>}
          </div>
          <DialogDescription>{agent?.workflow?.description || agent?.description || tx('编辑提示词和运行参数。', 'Edit prompts and runtime parameters.')}</DialogDescription>
        </DialogHeader>

        {!agent ? null : (
          <div className="grid gap-6 py-2 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-6">
              {actionError && <Alert variant="destructive"><AlertCircle /><AlertTitle>{tx('无法完成操作', 'Action failed')}</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert>}

              {agent.workflow?.variables && agent.workflow.variables.length > 0 && (
                <div className="rounded-lg border bg-slate-50 p-3">
                  <p className="text-sm font-medium text-gray-800">{tx('可用模板变量', 'Available template variables')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {agent.workflow.variables.map((variable) => <Badge key={variable} variant="secondary" className="font-mono text-xs">{`{{${variable}}}`}</Badge>)}
                  </div>
                </div>
              )}

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div><h3 className="font-semibold">{tx('提示词草稿', 'Prompt draft')}</h3><p className="text-sm text-gray-500">{tx('可编辑 role 和 content；至少保留一条 user 消息。', 'Edit role and content; keep at least one user message.')}</p></div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setPrompts((current) => [...current, { role: 'user', content: '' }])}><Plus className="mr-1.5 h-4 w-4" />{tx('添加消息', 'Add message')}</Button>
                </div>
                <div className="space-y-3">
                  {prompts.map((prompt, index) => (
                    <div key={`${index}-${prompt.role}`} className="rounded-lg border p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Label htmlFor={`prompt-role-${index}`}>{tx('角色', 'Role')}</Label>
                          <Select value={prompt.role} onValueChange={(role: AgentPrompt['role']) => setPrompts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, role } : item))}>
                            <SelectTrigger id={`prompt-role-${index}`} className="h-8 w-32"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="system">system</SelectItem>
                              <SelectItem value="user">user</SelectItem>
                              <SelectItem value="assistant">assistant</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <Button type="button" variant="ghost" size="icon" aria-label={tx(`删除第 ${index + 1} 条提示词`, `Remove prompt ${index + 1}`)} onClick={() => setPrompts((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                      </div>
                      <Textarea value={prompt.content} onChange={(event) => setPrompts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.target.value } : item))} className="min-h-28 font-mono text-sm" aria-label={tx(`第 ${index + 1} 条提示词内容`, `Prompt ${index + 1} content`)} />
                    </div>
                  ))}
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <div><h3 className="font-semibold">{tx('模型与参数', 'Model and parameters')}</h3><p className="text-sm text-gray-500">{tx('草稿保存后仍需显式发布，运行时只读取已发布快照。', 'Saving a draft does not change runtime until you publish it.')}</p></div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2"><Label htmlFor="agent-model">{tx('模型', 'Model')}</Label><Select value={selectedModelValue} onValueChange={(value) => setConfigValue('modelId', value === '__none__' ? null : value)}><SelectTrigger id="agent-model"><SelectValue placeholder={tx('选择模型', 'Select a model')} /></SelectTrigger><SelectContent><SelectItem value="__none__">{tx('使用默认模型', 'Use default model')}</SelectItem>{currentModelOption}{models.map((item) => <SelectItem key={item.id} value={item.id}>{item.name} · {item.modelId}{!item.isActive ? ` (${tx('已停用', 'disabled')})` : ''}</SelectItem>)}</SelectContent></Select></div>
                  <div className="space-y-2"><Label htmlFor="agent-temperature">temperature</Label><Input id="agent-temperature" type="number" min="0" max="2" step="0.1" value={typeof config.temperature === 'number' ? config.temperature : ''} onChange={(event) => setConfigValue('temperature', event.target.value === '' ? undefined : Number(event.target.value))} placeholder="0.7" /></div>
                  <div className="space-y-2"><Label htmlFor="agent-max-tokens">maxTokens</Label><Input id="agent-max-tokens" type="number" min="1" step="1" value={typeof config.maxTokens === 'number' ? config.maxTokens : ''} onChange={(event) => setConfigValue('maxTokens', event.target.value === '' ? undefined : Number(event.target.value))} placeholder="2048" /></div>
                </div>
                <div className="flex items-center gap-2"><Switch id="agent-active" checked={isActive} onCheckedChange={setIsActive} /><Label htmlFor="agent-active">{isActive ? tx('启用智能体', 'Agent enabled') : tx('禁用智能体', 'Agent disabled')}</Label></div>
              </section>

              <Separator />

              <section className="space-y-3">
                <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{tx('已发布版本试运行', 'Test published version')}</h3><p className="text-sm text-gray-500">{tx('试运行只执行已发布提示词，不会创建业务单或发送邮件。', 'Runs the published prompt only; it does not create business records or send email.')}</p></div><TestTube2 className="h-5 w-5 text-gray-400" /></div>
                {!canTest && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{tx('试运行要求智能体已启用、已发布，并配置启用中的模型。', 'Testing requires an enabled, published agent with an active model.')}</div>}
                {canTest && isDirty && <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">{tx('当前有未保存草稿；本次试运行仍使用已发布版本。', 'There are unsaved draft changes; this test still uses the published version.')}</div>}
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2"><Label htmlFor="agent-test-input">{tx('JSON 输入', 'JSON input')}</Label><Textarea id="agent-test-input" value={testInput} onChange={(event) => setTestInput(event.target.value)} className="min-h-44 font-mono text-xs" /><Button type="button" onClick={() => void handleTest()} disabled={!canTest || busyAction === 'test'}><TestTube2 className="mr-1.5 h-4 w-4" />{busyAction === 'test' ? tx('运行中…', 'Running…') : tx('试运行', 'Run test')}</Button></div>
                  <div className="space-y-2"><Label>{tx('输出', 'Output')}</Label>{testError && <Alert variant="destructive"><AlertCircle /><AlertDescription>{testError}</AlertDescription></Alert>}{testOutput ? <div className="rounded-md border bg-slate-50 p-3 text-sm"><div className="mb-2 flex flex-wrap gap-2 text-xs text-gray-500"><span>{testOutput.model}</span><span>{testOutput.latency} ms</span><span>v{testOutput.promptVersion}</span></div><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words">{testOutput.output}</pre></div> : !testError && <div className="rounded-md border border-dashed p-6 text-sm text-gray-500">{tx('运行结果将显示在这里。', 'The test result appears here.')}</div>}</div>
                </div>
              </section>
            </div>

            <aside className="space-y-4 lg:border-l lg:pl-5">
              <div className="rounded-lg border p-4"><div className="flex items-center gap-2 font-semibold"><History className="h-4 w-4" />{tx('版本历史', 'Version history')}</div><p className="mt-1 text-xs text-gray-500">{tx('恢复只生成新的草稿，仍需再次发布。', 'Restore creates a new draft; publish it separately.')}</p>{historyError && <Alert variant="destructive" className="mt-3"><AlertCircle /><AlertDescription>{historyError}</AlertDescription></Alert>}{historyLoading ? <div className="mt-4 flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />{tx('加载中…', 'Loading…')}</div> : versions.length === 0 ? <p className="mt-4 text-sm text-gray-500">{tx('暂无已发布版本。', 'No published versions yet.')}</p> : <div className="mt-3 space-y-2">{versions.map((version) => <div key={version.version} className="rounded-md border p-3"><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><Badge variant="outline">v{version.version}</Badge>{agent.publishedVersion === version.version && <Badge className="border-green-300 bg-green-50 text-green-700">{tx('当前发布', 'Published')}</Badge>}</div><Button type="button" variant="ghost" size="sm" onClick={() => void handleRestore(version)} disabled={busyAction === 'restore'}><RotateCcw className="mr-1 h-3.5 w-3.5" />{tx('恢复草稿', 'Restore')}</Button></div><div className="mt-2 flex items-center gap-1 text-xs text-gray-500"><Clock3 className="h-3 w-3" />{new Date(version.createdAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</div><p className="mt-2 line-clamp-2 text-xs text-gray-600">{version.prompts.find((prompt) => prompt.role === 'system')?.content || version.prompts[0]?.content}</p></div>)}</div>}</div>
              <div className="rounded-lg border bg-slate-50 p-4 text-sm"><div className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-4 w-4 text-green-600" />{tx('发布状态', 'Publish status')}</div><div className="mt-3 space-y-1 text-gray-600"><div>{tx('草稿修订', 'Draft revision')}: {agent.draftRevision}</div><div>{tx('已发布版本', 'Published version')}: {agent.publishedVersion === null ? tx('无', 'None') : `v${agent.publishedVersion}`}</div><div>{tx('运行时模型', 'Runtime model')}: {runtimeModel ? runtimeModel.modelId : tx('未配置', 'Not configured')}</div></div></div>
            </aside>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="text-xs text-gray-500">{isDirty ? tx('有未保存修改', 'Unsaved changes') : tx('草稿已同步', 'Draft is saved')}</div>
          <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tx('关闭', 'Close')}</Button><Button type="button" variant="outline" onClick={() => void handleSave()} disabled={!agent || busyAction !== null || !isDirty}><Save className="mr-1.5 h-4 w-4" />{busyAction === 'save' ? tx('保存中…', 'Saving…') : tx('保存草稿', 'Save draft')}</Button><Button type="button" onClick={() => void handlePublish()} disabled={!agent || busyAction !== null || isDirty}><Send className="mr-1.5 h-4 w-4" />{busyAction === 'publish' ? tx('发布中…', 'Publishing…') : tx('显式发布', 'Publish')}</Button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
