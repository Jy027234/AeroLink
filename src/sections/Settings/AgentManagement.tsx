import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Activity,
  Bot,
  ChevronRight,
  Cpu,
  Loader2,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslation } from '@/i18n';
import { agentApi, modelApi, type ClientAIAgent, type ClientAIModel } from '@/api/client';
import { toast } from 'sonner';
import { AgentEditor } from './AgentEditor';
import { AgentCallLogs } from './AgentCallLogs';
import { ModelManagement } from './ModelManagement';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function getModelReference(agent: ClientAIAgent): string | null {
  const modelId = agent.config?.modelId;
  return typeof modelId === 'string' && modelId.trim() ? modelId : null;
}

function getModelForAgent(agent: ClientAIAgent, models: ClientAIModel[]): ClientAIModel | undefined {
  const modelReference = getModelReference(agent);
  if (!modelReference) return models.find((model) => model.isDefault && model.isActive);
  return models.find((model) => model.id === modelReference || model.modelId === modelReference);
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

function getAgentStatus(agent: ClientAIAgent, tx: (zh: string, en: string) => string) {
  if (!agent.isActive) {
    return { label: tx('已禁用', 'Disabled'), className: 'border-gray-300 bg-gray-100 text-gray-600' };
  }
  if (agent.publishedVersion === null) {
    return { label: tx('未发布', 'Unpublished'), className: 'border-blue-300 bg-blue-50 text-blue-700' };
  }
  return { label: tx(`已发布 v${agent.publishedVersion}`, `Published v${agent.publishedVersion}`), className: 'border-green-300 bg-green-50 text-green-700' };
}

function getDraftModelReadiness(
  agent: ClientAIAgent,
  models: ClientAIModel[],
  tx: (zh: string, en: string) => string,
) {
  const configuredReference = getModelReference(agent);
  const model = getModelForAgent(agent, models);
  if (!model) {
    return { label: configuredReference ? tx('模型不存在', 'Model unavailable') : tx('未配置默认模型', 'No default model configured'), className: 'text-amber-700' };
  }
  if (!model.isActive) return { label: tx('模型已停用', 'Model disabled'), className: 'text-amber-700' };
  if (!hasRequiredModelCredential(model)) return { label: tx('缺少模型密钥', 'Missing model key'), className: 'text-amber-700' };
  return { label: tx('已配置，未测试', 'Configured, not tested'), className: 'text-gray-500' };
}

function AgentList({
  agents,
  models,
  onEdit,
  onToggle,
  busyAgentId,
  tx,
}: {
  agents: ClientAIAgent[];
  models: ClientAIModel[];
  onEdit: (agent: ClientAIAgent) => void;
  onToggle: (agent: ClientAIAgent, isActive: boolean) => void;
  busyAgentId: string | null;
  tx: (zh: string, en: string) => string;
}) {
  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-6 py-14 text-center text-gray-500">
        <Bot className="mx-auto mb-3 h-12 w-12 text-gray-300" />
        <p className="font-medium text-gray-700">{tx('暂无可管理的智能体', 'No agents available')}</p>
        <p className="mt-1 text-sm">{tx('内置目录将在服务端初始化后显示。', 'The built-in catalog appears after server initialization.')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {agents.map((agent) => {
        const status = getAgentStatus(agent, tx);
        const model = getModelForAgent(agent, models);
        const draftReadiness = getDraftModelReadiness(agent, models, tx);
        const workflow = agent.workflow;
        return (
          <div key={agent.id} className="rounded-lg border bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex min-w-0 gap-3">
                <div className="mt-0.5 rounded-lg bg-brand-primary/10 p-2 text-brand-primary">
                  <Bot className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-semibold text-gray-900">{workflow?.label || agent.name}</h3>
                    {agent.builtinKey && <Badge variant="outline">{tx('内置目录', 'Built-in')}</Badge>}
                    <Badge className={status.className}>{status.label}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-gray-600">{workflow?.description || agent.description || tx('暂无业务说明', 'No business description')}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                    <span>
                      {tx('草稿模型', 'Draft model')}: {model ? `${model.name} (${model.modelId})` : tx('未选择', 'Not selected')}
                    </span>
                    <span className={draftReadiness.className}>{tx('草稿就绪度', 'Draft readiness')}: {draftReadiness.label}</span>
                    <span>{tx('草稿修订', 'Draft revision')}: {agent.draftRevision}</span>
                    <span>{tx('发布版本', 'Published')}: {agent.publishedVersion === null ? tx('无', 'None') : `v${agent.publishedVersion}`}</span>
                  </div>
                  {workflow?.variables && workflow.variables.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {workflow.variables.map((variable) => (
                        <Badge key={variable} variant="secondary" className="font-mono text-[11px]">{`{{${variable}}}`}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                  {busyAgentId === agent.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
                  <Switch
                    checked={agent.isActive}
                    disabled={busyAgentId === agent.id}
                    aria-label={tx(`切换 ${workflow?.label || agent.name}`, `Toggle ${workflow?.label || agent.name}`)}
                    onCheckedChange={(checked) => onToggle(agent, checked)}
                  />
                  <span className={agent.isActive ? 'text-sm text-green-700' : 'text-sm text-gray-500'}>
                    {agent.isActive ? tx('启用', 'Enabled') : tx('禁用', 'Disabled')}
                  </span>
                </div>
                <Button variant="outline" size="sm" onClick={() => onEdit(agent)}>
                  <Settings2 className="mr-1.5 h-4 w-4" />
                  {tx('编辑配置', 'Edit configuration')}
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AgentManagement() {
  const { locale } = useTranslation();
  const tx = useCallback((zh: string, en: string) => (locale === 'zh-CN' ? zh : en), [locale]);
  const [agents, setAgents] = useState<ClientAIAgent[]>([]);
  const [models, setModels] = useState<ClientAIModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('agents');
  const [editingAgent, setEditingAgent] = useState<ClientAIAgent | null>(null);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextAgents, nextModels] = await Promise.all([agentApi.getAll(), modelApi.getAll()]);
      setAgents(nextAgents);
      setModels(nextModels);
    } catch (loadError) {
      const message = getErrorMessage(loadError, tx('加载 AI 配置失败', 'Failed to load AI configuration'));
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [tx]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const modelCountLabel = useMemo(() => {
    const activeCount = models.filter((model) => model.isActive).length;
    return tx(`${activeCount}/${models.length} 个模型已启用`, `${activeCount}/${models.length} models enabled`);
  }, [models, tx]);

  const handleToggleAgent = async (agent: ClientAIAgent, isActive: boolean) => {
    setBusyAgentId(agent.id);
    setError(null);
    try {
      const updated = await agentApi.update(agent.id, {
        expectedRevision: agent.draftRevision,
        isActive,
      });
      setAgents((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (editingAgent?.id === updated.id) setEditingAgent(updated);
    } catch (toggleError) {
      const message = getErrorMessage(toggleError, tx('更新智能体状态失败', 'Failed to update agent status'));
      setError(message);
      toast.error(message);
    } finally {
      setBusyAgentId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        </div>
        <Card>
          <CardHeader><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-72" /></CardHeader>
          <CardContent className="space-y-3"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Bot className="h-7 w-7" />
            {tx('AI 智能体管理', 'AI Agent Management')}
          </h1>
          <p className="mt-1 text-gray-500">{tx('管理内置业务智能体的提示词、模型参数和发布版本。', 'Manage built-in agent prompts, model parameters, and published versions.')}</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-500"><Cpu className="h-4 w-4" />{modelCountLabel}</div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{tx('请求失败', 'Request failed')}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void loadData()}>
              <RefreshCw className="mr-1.5 h-4 w-4" />{tx('重试', 'Retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="agents" className="gap-2"><Bot className="h-4 w-4" />{tx('智能体配置', 'Agents')}</TabsTrigger>
          <TabsTrigger value="models" className="gap-2"><SlidersHorizontal className="h-4 w-4" />{tx('模型管理', 'Models')}</TabsTrigger>
          <TabsTrigger value="logs" className="gap-2"><Activity className="h-4 w-4" />{tx('调用记录', 'Call logs')}</TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>{tx('内置智能体目录', 'Built-in agent catalog')}</CardTitle>
              <CardDescription>{tx('每个业务智能体都必须先保存草稿，再显式发布后才会用于运行。', 'Save a draft first, then explicitly publish it before the agent can run.')}</CardDescription>
            </CardHeader>
            <CardContent>
              <AgentList agents={agents} models={models} onEdit={setEditingAgent} onToggle={handleToggleAgent} busyAgentId={busyAgentId} tx={tx} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="models" className="mt-4">
          <ModelManagement models={models} onModelsChange={setModels} tx={tx} />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <AgentCallLogs agents={agents} tx={tx} locale={locale} />
        </TabsContent>
      </Tabs>

      <AgentEditor
        agent={editingAgent}
        models={models}
        open={editingAgent !== null}
        onOpenChange={(open) => { if (!open) setEditingAgent(null); }}
        onSaved={(updated) => {
          setAgents((current) => current.map((item) => item.id === updated.id ? updated : item));
          setEditingAgent(updated);
        }}
      />
    </div>
  );
}
