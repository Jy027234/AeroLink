import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Activity, Clock3, RefreshCw } from 'lucide-react';
import { agentApi, type AgentAuditLog, type ClientAIAgent } from '@/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

type LogMetadata = {
  actorId?: string;
  promptVersion?: number;
  model?: string;
};

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseMetadata(log: AgentAuditLog): LogMetadata {
  const input = parseObject(log.input);
  const output = parseObject(log.output);
  const actorId = typeof input.actorId === 'string' ? input.actorId : undefined;
  const promptVersion = typeof output.promptVersion === 'number'
    ? output.promptVersion
    : typeof input.promptVersion === 'number' ? input.promptVersion : undefined;
  const model = typeof output.model === 'string' ? output.model : undefined;
  return { actorId, promptVersion, model };
}

function statusClass(status: string): string {
  if (status === 'SUCCESS') return 'border-green-300 bg-green-50 text-green-700';
  if (status === 'RUNNING') return 'border-blue-300 bg-blue-50 text-blue-700';
  if (status === 'ERROR') return 'border-red-300 bg-red-50 text-red-700';
  return 'border-gray-300 bg-gray-100 text-gray-600';
}

function statusLabel(status: string, tx: (zh: string, en: string) => string): string {
  if (status === 'SUCCESS') return tx('成功', 'Success');
  if (status === 'RUNNING') return tx('运行中', 'Running');
  if (status === 'ERROR') return tx('失败', 'Error');
  return status;
}

function formatDate(value: string, locale: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US');
}

export function AgentCallLogs({
  agents,
  tx,
  locale,
}: {
  agents: ClientAIAgent[];
  tx: (zh: string, en: string) => string;
  locale: string;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [logs, setLogs] = useState<AgentAuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId('');
      setLogs([]);
      return;
    }
    if (!agents.some((agent) => agent.id === selectedAgentId)) setSelectedAgentId(agents[0].id);
  }, [agents, selectedAgentId]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId),
    [agents, selectedAgentId],
  );

  const loadLogs = async (agentId: string) => {
    setLoading(true);
    setError(null);
    try {
      setLogs(await agentApi.getLogs(agentId));
    } catch (loadError) {
      setLogs([]);
      setError(loadError instanceof Error && loadError.message ? loadError.message : tx('加载调用记录失败', 'Failed to load call logs'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedAgentId) void loadLogs(selectedAgentId);
  // The selected agent is the only fetch key; tx is used for the error fallback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId]);

  if (agents.length === 0) {
    return <div className="rounded-lg border border-dashed px-6 py-14 text-center text-gray-500"><Activity className="mx-auto mb-3 h-12 w-12 text-gray-300" /><p className="font-medium text-gray-700">{tx('暂无智能体，无法查看调用记录', 'No agents available for call logs')}</p></div>;
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><CardTitle>{tx('调用记录', 'Call logs')}</CardTitle><CardDescription>{tx('仅展示服务端记录的执行元数据，不展示业务输入和模型输出内容。', 'Shows server recorded execution metadata without business input or model output.')}</CardDescription></div>
        <div className="w-full sm:w-72"><Select value={selectedAgentId} onValueChange={setSelectedAgentId}><SelectTrigger aria-label={tx('选择智能体', 'Select agent')}><SelectValue placeholder={tx('选择智能体', 'Select agent')} /></SelectTrigger><SelectContent>{agents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.workflow?.label || agent.name}</SelectItem>)}</SelectContent></Select></div>
      </CardHeader>
      <CardContent>
        {error && <Alert variant="destructive" className="mb-4"><AlertCircle /><AlertTitle>{tx('调用记录加载失败', 'Unable to load call logs')}</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-3"><span>{error}</span>{selectedAgentId && <Button size="sm" variant="outline" onClick={() => void loadLogs(selectedAgentId)}><RefreshCw className="mr-1.5 h-4 w-4" />{tx('重试', 'Retry')}</Button>}</AlertDescription></Alert>}
        {loading ? <div className="space-y-3" aria-busy="true"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div> : logs.length === 0 ? <div className="rounded-lg border border-dashed px-6 py-14 text-center text-gray-500"><Activity className="mx-auto mb-3 h-10 w-10 text-gray-300" /><p className="font-medium text-gray-700">{tx('暂无调用记录', 'No call logs')}</p><p className="mt-1 text-sm">{selectedAgent ? tx(`“${selectedAgent.workflow?.label || selectedAgent.name}”尚未产生服务端调用记录。`, `“${selectedAgent.workflow?.label || selectedAgent.name}” has no server call logs yet.`) : tx('请选择智能体。', 'Select an agent.')}</p></div> : <div className="space-y-2">{logs.map((log) => { const metadata = parseMetadata(log); return <div key={log.id} className="rounded-lg border p-3"><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm"><span className="inline-flex items-center gap-1 text-gray-600"><Clock3 className="h-3.5 w-3.5" />{formatDate(log.createdAt, locale)}</span><Badge variant="outline">{log.action}</Badge><Badge className={statusClass(log.status)}>{statusLabel(log.status, tx)}</Badge></div><div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500"><span>{tx('耗时', 'Duration')}: {typeof log.duration === 'number' ? `${log.duration} ms` : '—'}</span><span>{tx('执行人', 'Actor')}: {metadata.actorId || '—'}</span><span>{tx('提示词版本', 'Prompt version')}: {typeof metadata.promptVersion === 'number' ? `v${metadata.promptVersion}` : '—'}</span><span>{tx('模型', 'Model')}: {metadata.model || '—'}</span></div></div>{log.status === 'ERROR' && log.error && <p className="mt-2 text-xs text-red-700">{log.error}</p>}</div>; })}</div>}
      </CardContent>
    </Card>
  );
}
