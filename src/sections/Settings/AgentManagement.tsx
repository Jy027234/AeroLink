import { useState, useEffect } from 'react';
import {
  Bot,
  Plus,
  Edit3,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Activity,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { agentApi, modelApi } from '@/api/client';

interface AIAgent {
  id: string;
  name: string;
  type: string;
  description: string | null;
  isActive: boolean;
  config: Record<string, unknown>;
  prompts: Array<{ role: string; content: string }>;
}

interface AIModel {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string | null;
  baseUrl: string | null;
  isActive: boolean;
  isDefault: boolean;
  config: Record<string, unknown>;
  capabilities: string[];
}

const agentTypes = [
  { value: 'CHAT', label: 'Chat Assistant', color: 'text-blue-600 bg-blue-50' },
  { value: 'EXTRACTION', label: 'Information Extraction', color: 'text-purple-600 bg-purple-50' },
  { value: 'QUOTATION', label: 'Quotation Generation', color: 'text-green-600 bg-green-50' },
  { value: 'ANALYSIS', label: 'Data Analysis', color: 'text-orange-600 bg-orange-50' },
  { value: 'MONITORING', label: 'Monitoring & Alerts', color: 'text-red-600 bg-red-50' },
];

const providers = [
  { value: 'openai', label: 'OpenAI', icon: '🤖', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
  { value: 'anthropic', label: 'Anthropic', icon: '🧠', models: ['claude-3-5-sonnet-20240620', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'] },
  { value: 'azure', label: 'Azure OpenAI', icon: '☁️', models: ['gpt-4', 'gpt-35-turbo'] },
  { value: 'deepseek', label: 'DeepSeek', icon: '🔮', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { value: 'ollama', label: 'Ollama (Local)', icon: '🏠', models: ['llama3', 'llama3.1', 'mistral', 'codellama'] },
  { value: 'custom', label: 'Custom', icon: '⚙️', models: [] },
];

export function AgentManagement() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [models, setModels] = useState<AIModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('agents');
  const [isAgentDialogOpen, setIsAgentDialogOpen] = useState(false);
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AIAgent | null>(null);
  const [editingModel, setEditingModel] = useState<AIModel | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  useEffect(() => {
    const loadData = async () => {
      try {
        const [agentsData, modelsData] = await Promise.all([
          agentApi.getAll(),
          modelApi.getAll(),
        ]);
        setAgents(agentsData);
        setModels(modelsData);
      } catch (error) {
        console.error('Failed to fetch data:', error);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  const handleToggleAgent = async (agent: AIAgent) => {
    try {
      const data = await agentApi.toggle(agent.id);
      setAgents(agents.map(a => a.id === agent.id ? data : a));
    } catch (error) {
      console.error('Failed to toggle agent:', error);
    }
  };

  const handleDeleteAgent = async (agent: AIAgent) => {
    if (!confirm(tx('确定要删除智能体 "${agent.name}" 吗？', `Delete Agent "${agent.name}"?`))) return;
    try {
      await agentApi.delete(agent.id);
      setAgents(agents.filter(a => a.id !== agent.id));
    } catch (error) {
      console.error('Failed to delete agent:', error);
    }
  };

  const handleSaveAgent = async (agentData: Partial<AIAgent>) => {
    try {
      const data = editingAgent
        ? await agentApi.update(editingAgent.id, agentData)
        : await agentApi.create(agentData);
      if (editingAgent) {
        setAgents(agents.map(a => a.id === data.id ? data : a));
      } else {
        setAgents([data, ...agents]);
      }
      setIsAgentDialogOpen(false);
      setEditingAgent(null);
    } catch (error) {
      console.error('Failed to save agent:', error);
    }
  };

  const handleToggleModel = async (model: AIModel) => {
    try {
      const data = await modelApi.update(model.id, { isActive: !model.isActive });
      setModels(models.map(m => m.id === model.id ? data : m));
    } catch (error) {
      console.error('Failed to toggle model:', error);
    }
  };

  const handleSetDefaultModel = async (model: AIModel) => {
    try {
      await modelApi.setDefault(model.id);
      const modelsData = await modelApi.getAll();
      setModels(modelsData);
    } catch (error) {
      console.error('Failed to set default model:', error);
    }
  };

  const handleDeleteModel = async (model: AIModel) => {
    if (model.isDefault) {
      alert(tx('默认模型不能删除。', 'Default model cannot be deleted.'));
      return;
    }
    if (!confirm(tx('确定要删除模型 "${model.name}" 吗？', `Delete model "${model.name}"?`))) return;
    try {
      await modelApi.delete(model.id);
      setModels(models.filter(m => m.id !== model.id));
    } catch (error) {
      console.error('Failed to delete model:', error);
    }
  };

  const handleSaveModel = async (modelData: Partial<AIModel>) => {
    try {
      const data = editingModel
        ? await modelApi.update(editingModel.id, modelData)
        : await modelApi.create(modelData);
      if (editingModel) {
        setModels(models.map(m => m.id === data.id ? data : m));
      } else {
        setModels([data, ...models]);
      }
      setIsModelDialogOpen(false);
      setEditingModel(null);
    } catch (error) {
      console.error('Failed to save model:', error);
    }
  };

  const getAgentTypeConfig = (type: string) => {
    const config = agentTypes.find(t => t.value === type) || agentTypes[0];
    const labels: Record<string, { zh: string; en: string }> = {
      CHAT: { zh: '对话助手', en: 'Chat Assistant' },
      EXTRACTION: { zh: '信息提取', en: 'Information Extraction' },
      QUOTATION: { zh: '报价生成', en: 'Quotation Generation' },
      ANALYSIS: { zh: '数据分析', en: 'Data Analysis' },
      MONITORING: { zh: '监控告警', en: 'Monitoring & Alerts' },
    };
    const label = labels[config.value] || { zh: config.label, en: config.label };
    return { ...config, label: tx(label.zh, label.en) };
  };

  const getProviderConfig = (provider: string) => {
    const config = providers.find(p => p.value === provider) || providers[4];
    const labels: Record<string, { zh: string; en: string }> = {
      openai: { zh: 'OpenAI', en: 'OpenAI' },
      anthropic: { zh: 'Anthropic', en: 'Anthropic' },
      azure: { zh: 'Azure OpenAI', en: 'Azure OpenAI' },
      deepseek: { zh: 'DeepSeek', en: 'DeepSeek' },
      ollama: { zh: 'Ollama (本地)', en: 'Ollama (Local)' },
      custom: { zh: '自定义', en: 'Custom' },
    };
    const label = labels[config.value] || { zh: config.label, en: config.label };
    return { ...config, label: tx(label.zh, label.en) };
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-[#64b5f6]" />
        <span className="ml-2 text-gray-500">{tx('加载中...', 'Loading...')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="w-7 h-7" />
            {tx('AI 智能体管理', 'AI Agent Management')}
          </h1>
          <p className="text-gray-500 mt-1">{tx('配置和管理 AI 智能体，优化系统智能化能力。', 'Configure and manage AI agents to optimize system intelligence.')}</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="agents" className="gap-2">
            <Bot className="w-4 h-4" />
            {tx('智能体配置', 'Agent Configuration')}
          </TabsTrigger>
          <TabsTrigger value="models" className="gap-2">
            <Cpu className="w-4 h-4" />
            {tx('模型集成', 'Model Integration')}
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <Activity className="w-4 h-4" />
            {tx('运行时日志', 'Runtime Logs')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>{tx('智能体列表', 'Agent List')}</CardTitle>
                <CardDescription>{tx('管理 AI 智能体配置。', 'Manage AI agent configurations.')}</CardDescription>
              </div>
              <Button className="bg-[#64b5f6] hover:bg-[#42a5f5]" onClick={() => { setEditingAgent(null); setIsAgentDialogOpen(true); }}>
                <Plus className="w-4 h-4 mr-1" />
                {tx('新建智能体', 'New Agent')}
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12"></TableHead>
                    <TableHead>{tx('名称', 'Name')}</TableHead>
                    <TableHead>{tx('类型', 'Type')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('描述', 'Description')}</TableHead>
                    <TableHead>{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12 text-gray-500">
                        <Bot className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                        <p>{tx('暂无智能体', 'No agents found')}</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    agents.map((agent) => (
                      <>
                        <TableRow key={agent.id}>
                          <TableCell>
                            <Button variant="ghost" size="icon" onClick={() => setExpandedAgent(expandedAgent === agent.id ? null : agent.id)}>
                              {expandedAgent === agent.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </Button>
                          </TableCell>
                          <TableCell className="font-medium">{agent.name}</TableCell>
                          <TableCell>
                            <Badge className={getAgentTypeConfig(agent.type).color}>
                              {getAgentTypeConfig(agent.type).label}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Switch checked={agent.isActive} onCheckedChange={() => handleToggleAgent(agent)} />
                              <span className={agent.isActive ? 'text-green-600' : 'text-gray-400'}>
                                {agent.isActive ? tx('已启用', 'Enabled') : tx('已禁用', 'Disabled')}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-gray-500 max-w-xs truncate">{agent.description}</TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="icon" onClick={() => { setEditingAgent(agent); setIsAgentDialogOpen(true); }}>
                                <Edit3 className="w-4 h-4" />
                              </Button>
                              <Button variant="ghost" size="icon" onClick={() => handleDeleteAgent(agent)}>
                                <Trash2 className="w-4 h-4 text-red-500" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {expandedAgent === agent.id && (
                          <TableRow key={`${agent.id}-expanded`}>
                            <TableCell colSpan={6} className="bg-gray-50 p-4">
                              <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                  <h4 className="font-semibold mb-2">{tx('配置', 'Configuration')}</h4>
                                  <pre className="bg-white p-2 rounded border text-xs overflow-auto">
                                    {JSON.stringify(agent.config, null, 2)}
                                  </pre>
                                </div>
                                <div>
                                  <h4 className="font-semibold mb-2">{tx('提示词模板', 'Prompt Templates')}</h4>
                                  <div className="space-y-2">
                                    {agent.prompts.map((p, i) => (
                                      <div key={i} className="bg-white p-2 rounded border">
                                        <Badge variant="outline" className="mb-1">{p.role}</Badge>
                                        <p className="text-xs text-gray-600">{p.content}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="models" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>{tx('AI 模型列表', 'AI Model List')}</CardTitle>
                <CardDescription>{tx('配置和管理 AI 模型集成。', 'Configure and manage AI model integrations.')}</CardDescription>
              </div>
              <Button className="bg-[#64b5f6] hover:bg-[#42a5f5]" onClick={() => { setEditingModel(null); setIsModelDialogOpen(true); }}>
                <Plus className="w-4 h-4 mr-1" />
                {tx('添加模型', 'Add Model')}
              </Button>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('模型', 'Model')}</TableHead>
                    <TableHead>{tx('提供商', 'Provider')}</TableHead>
                    <TableHead>{tx('模型 ID', 'Model ID')}</TableHead>
                    <TableHead>{tx('能力', 'Capabilities')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {models.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12 text-gray-500">
                        <Cpu className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                        <p>{tx('暂无模型', 'No models found')}</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    models.map((model) => {
                      const provider = getProviderConfig(model.provider);
                      return (
                        <TableRow key={model.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="text-2xl">{provider.icon}</span>
                              <div>
                                <p className="font-medium">{model.name}</p>
                                {model.isDefault && <Badge variant="outline" className="text-xs">{tx('默认', 'Default')}</Badge>}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>{provider.label}</TableCell>
                          <TableCell className="font-mono text-sm">{model.modelId}</TableCell>
                          <TableCell>
                            <div className="flex gap-1 flex-wrap">
                              {model.capabilities.map((cap) => (
                                <Badge key={cap} variant="secondary" className="text-xs">{cap}</Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Switch checked={model.isActive} onCheckedChange={() => handleToggleModel(model)} />
                              <span className={model.isActive ? 'text-green-600' : 'text-gray-400'}>
                                {model.isActive ? tx('已启用', 'Enabled') : tx('已禁用', 'Disabled')}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              {!model.isDefault && model.isActive && (
                                <Button variant="ghost" size="sm" onClick={() => handleSetDefaultModel(model)}>
                                  {tx('设为默认', 'Set as Default')}
                                </Button>
                              )}
                              <Button variant="ghost" size="icon" onClick={() => { setEditingModel(model); setIsModelDialogOpen(true); }}>
                                <Edit3 className="w-4 h-4" />
                              </Button>
                              <Button variant="ghost" size="icon" onClick={() => handleDeleteModel(model)} disabled={model.isDefault}>
                                <Trash2 className={cn('w-4 h-4', !model.isDefault && 'text-red-500')} />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>{tx('运行时日志', 'Runtime Logs')}</CardTitle>
              <CardDescription>{tx('查看智能体运行记录和诊断信息。', 'View agent runtime records and diagnostics.')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-center py-12 text-gray-500">
                <Activity className="w-16 h-16 mx-auto mb-4 text-gray-300" />
                <p>{tx('日志功能正在开发中...', 'Logging feature is under development...')}</p>
                <p className="text-sm">{tx('即将支持实时日志查看和筛选。', 'Real-time log viewing and filtering will be supported soon.')}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AgentDialog
        agent={editingAgent}
        isOpen={isAgentDialogOpen}
        onClose={() => { setIsAgentDialogOpen(false); setEditingAgent(null); }}
        onSave={handleSaveAgent}
      />

      <ModelDialog
        model={editingModel}
        isOpen={isModelDialogOpen}
        onClose={() => { setIsModelDialogOpen(false); setEditingModel(null); }}
        onSave={handleSaveModel}
      />
    </div>
  );
}

function AgentDialog({
  agent,
  isOpen,
  onClose,
  onSave,
}: {
  agent: AIAgent | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Partial<AIAgent>) => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [formData, setFormData] = useState({
    name: agent?.name || '',
    type: agent?.type || 'CHAT',
    description: agent?.description || '',
    isActive: agent?.isActive ?? true,
    config: agent?.config || {},
    prompts: agent?.prompts || [],
  });
  const [configText, setConfigText] = useState(JSON.stringify(formData.config, null, 2));

  const handleSubmit = () => {
    try {
      const config = JSON.parse(configText);
      onSave({ ...formData, config, prompts: formData.prompts });
    } catch {
      alert(tx('配置格式错误，请检查 JSON 格式。', 'Configuration format error. Please check JSON format.'));
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{agent ? tx('编辑智能体', 'Edit Agent') : tx('新建智能体', 'New Agent')}</DialogTitle>
          <DialogDescription className="sr-only">{tx('配置AI智能体参数', 'Configure AI agent')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('名称', 'Name')} *</Label>
              <Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder={tx('请输入智能体名称', 'Enter agent name')} />
            </div>
            <div className="space-y-2">
              <Label>{tx('类型', 'Type')} *</Label>
              <select
                className="w-full h-10 px-3 border rounded-md"
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value })}
              >
                {agentTypes.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{tx('描述', 'Description')}</Label>
            <Textarea value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder={tx('请输入智能体描述', 'Enter agent description')} />
          </div>
          <div className="space-y-2">
            <Label>{tx('配置 (JSON)', 'Configuration (JSON)')}</Label>
            <Textarea value={configText} onChange={(e) => setConfigText(e.target.value)} className="font-mono text-sm h-32" />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={formData.isActive} onCheckedChange={(v) => setFormData({ ...formData, isActive: v })} />
            <Label>{tx('启用此智能体', 'Enable this agent')}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tx('取消', 'Cancel')}</Button>
          <Button onClick={handleSubmit} disabled={!formData.name || !formData.type}>{tx('保存', 'Save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelDialog({
  model,
  isOpen,
  onClose,
  onSave,
}: {
  model: AIModel | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Partial<AIModel>) => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [formData, setFormData] = useState({
    name: model?.name || '',
    provider: model?.provider || 'openai',
    modelId: model?.modelId || '',
    apiKey: model?.apiKey || '',
    baseUrl: model?.baseUrl || '',
    isActive: model?.isActive ?? true,
    isDefault: model?.isDefault ?? false,
    capabilities: model?.capabilities || [],
  });
  const [selectedProvider, setSelectedProvider] = useState(model?.provider || 'openai');

  const handleSubmit = () => {
    const providerConfig = providers.find(p => p.value === selectedProvider);
    const capabilities = providerConfig?.value === 'anthropic'
      ? ['chat', 'extraction', 'analysis']
      : providerConfig?.value === 'openai'
        ? ['chat', 'extraction', 'analysis']
        : ['chat'];

    onSave({
      ...formData,
      capabilities,
      apiKey: formData.apiKey || undefined,
      baseUrl: formData.baseUrl || undefined,
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{model ? tx('编辑模型', 'Edit Model') : tx('添加模型', 'Add Model')}</DialogTitle>
          <DialogDescription className="sr-only">{tx('管理AI模型配置', 'Manage AI model config')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tx('名称', 'Name')} *</Label>
              <Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder={tx('例如：GPT-4o', 'e.g., GPT-4o')} />
            </div>
            <div className="space-y-2">
              <Label>{tx('提供商', 'Provider')} *</Label>
              <select
                className="w-full h-10 px-3 border rounded-md"
                value={selectedProvider}
                onChange={(e) => {
                  setSelectedProvider(e.target.value);
                  const provider = providers.find(p => p.value === e.target.value);
                  if (provider && provider.models.length > 0) {
                    setFormData({ ...formData, provider: e.target.value, modelId: provider.models[0] });
                  } else {
                    setFormData({ ...formData, provider: e.target.value });
                  }
                }}
              >
                {providers.map((p) => (
                  <option key={p.value} value={p.value}>{p.icon} {p.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{tx('模型 ID', 'Model ID')} *</Label>
            {(() => {
              const provider = providers.find(p => p.value === selectedProvider);
              if (provider && provider.models.length > 0) {
                return (
                  <select
                    className="w-full h-10 px-3 border rounded-md"
                    value={formData.modelId}
                    onChange={(e) => setFormData({ ...formData, modelId: e.target.value })}
                  >
                    {provider.models.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                );
              }
              return <Input value={formData.modelId} onChange={(e) => setFormData({ ...formData, modelId: e.target.value })} placeholder={tx('请输入模型 ID', 'Enter model ID')} />;
            })()}
          </div>
          {(selectedProvider === 'openai' || selectedProvider === 'anthropic' || selectedProvider === 'deepseek') && (
            <div className="space-y-2">
              <Label>API Key</Label>
              <Input type="password" value={formData.apiKey} onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })} placeholder="sk-..." />
            </div>
          )}
          {(selectedProvider === 'ollama' || selectedProvider === 'deepseek') && (
            <div className="space-y-2">
              <Label>{tx('基础 URL', 'Base URL')}</Label>
              <Input value={formData.baseUrl} onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })} placeholder={selectedProvider === 'deepseek' ? 'https://api.deepseek.com' : 'http://localhost:11434'} />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch checked={formData.isActive} onCheckedChange={(v) => setFormData({ ...formData, isActive: v })} />
            <Label>{tx('启用此模型', 'Enable this model')}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tx('取消', 'Cancel')}</Button>
          <Button onClick={handleSubmit} disabled={!formData.name || !formData.modelId}>{tx('保存', 'Save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
