import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  inboundWebhookApi,
  webhooksPhase2Api,
  type InboundWebhookDelivery,
  type InboundWebhookEndpoint,
  type WebhookAuditLogItem,
  type WebhookDLQItem,
  type WebhookDLQStats,
  type WebhookFailureReason,
  type WebhookReplayBatch,
  type WebhookReplayDelivery,
  type WebhookReplayDeliveryStatus,
  type WebhookReplayEstimate,
} from '@/api/client';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Loader2, MoreHorizontal, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useCapabilityStore } from '@/store';
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

interface EndpointFormState {
  name: string;
  sourceSystem: string;
  urlPath: string;
  authMethod: 'HMAC' | 'API_KEY' | 'NONE';
  secret: string;
}

interface PayloadTemplate {
  id: string;
  name: string;
  payloadText: string;
  updatedAt: string;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';
const TEST_PAYLOAD_TEMPLATES_KEY = 'webhook_test_payload_templates';
const DLQ_FAILURE_REASONS: WebhookFailureReason[] = ['4xx', '5xx', 'timeout', 'connection_error', 'other'];

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const initialForm: EndpointFormState = {
  name: '',
  sourceSystem: '',
  urlPath: '',
  authMethod: 'HMAC',
  secret: '',
};

const toIsoDateFilter = (value: string) => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const toReplayEndOfDay = (value: string) => {
  if (!value) return undefined;
  const date = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export function WebhookManagementPanel() {
  const { locale } = useTranslation();
  const can = useCapabilityStore((state) => state.can);
  const tx = useCallback((zh: string, en: string) => (locale === 'zh-CN' ? zh : en), [locale]);

  const [loading, setLoading] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const [endpoints, setEndpoints] = useState<InboundWebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<InboundWebhookDelivery[]>([]);
  const [auditLogs, setAuditLogs] = useState<WebhookAuditLogItem[]>([]);
  const [dlqItems, setDlqItems] = useState<WebhookDLQItem[]>([]);
  const [dlqStats, setDlqStats] = useState<WebhookDLQStats | null>(null);

  const [form, setForm] = useState<EndpointFormState>(initialForm);
  const [editId, setEditId] = useState<string | null>(null);
  const [deliveryStatusFilter, setDeliveryStatusFilter] = useState('all');
  const [deliveryEndpointFilter, setDeliveryEndpointFilter] = useState('all');
  const [deliveryLimit] = useState(20);
  const [deliveryOffset, setDeliveryOffset] = useState(0);
  const [deliveryTotal, setDeliveryTotal] = useState(0);

  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditResourceFilter, setAuditResourceFilter] = useState('');
  const [auditStart, setAuditStart] = useState('');
  const [auditEnd, setAuditEnd] = useState('');
  const [auditLimit] = useState(20);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditTotal, setAuditTotal] = useState(0);
  const [dlqEndpointFilter, setDlqEndpointFilter] = useState('all');
  const [dlqFailureReasonFilter, setDlqFailureReasonFilter] = useState('all');
  const [dlqLimit] = useState(20);
  const [dlqOffset, setDlqOffset] = useState(0);
  const [dlqTotal, setDlqTotal] = useState(0);
  const [replayStartDate, setReplayStartDate] = useState('');
  const [replayEndDate, setReplayEndDate] = useState('');
  const [replayStatus, setReplayStatus] = useState<WebhookReplayDeliveryStatus>('delivered');
  const [replayEndpointId, setReplayEndpointId] = useState('all');
  const [replayEventTypes, setReplayEventTypes] = useState('');
  const [replayDeliveries, setReplayDeliveries] = useState<WebhookReplayDelivery[]>([]);
  const [selectedReplayDeliveryIds, setSelectedReplayDeliveryIds] = useState<Set<string>>(new Set());
  const [replayEstimate, setReplayEstimate] = useState<WebhookReplayEstimate | null>(null);
  const [replayBatches, setReplayBatches] = useState<WebhookReplayBatch[]>([]);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayExecuting, setReplayExecuting] = useState(false);

  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testTarget, setTestTarget] = useState<InboundWebhookEndpoint | null>(null);
  const [testPayloadText, setTestPayloadText] = useState('');
  const [templates, setTemplates] = useState<PayloadTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [deleteEndpointId, setDeleteEndpointId] = useState<string | null>(null);
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null);
  const selectedTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId]
  );

  const loadTemplates = useCallback(() => {
    try {
      const raw = localStorage.getItem(TEST_PAYLOAD_TEMPLATES_KEY);
      if (!raw) {
        setTemplates([]);
        return;
      }
      const parsed = JSON.parse(raw) as PayloadTemplate[];
      setTemplates(Array.isArray(parsed) ? parsed : []);
    } catch {
      setTemplates([]);
    }
  }, []);

  const persistTemplates = useCallback((next: PayloadTemplate[]) => {
    localStorage.setItem(TEST_PAYLOAD_TEMPLATES_KEY, JSON.stringify(next));
    setTemplates(next);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [endpointData, deliveryRes, auditRes, dlqRes, stats] = await Promise.all([
        inboundWebhookApi.listEndpoints(),
        inboundWebhookApi.listDeliveries({
          limit: deliveryLimit,
          offset: deliveryOffset,
          endpointId: deliveryEndpointFilter === 'all' ? undefined : deliveryEndpointFilter,
          status: deliveryStatusFilter === 'all' ? undefined : deliveryStatusFilter,
        }),
        inboundWebhookApi.listAudit({
          limit: auditLimit,
          offset: auditOffset,
          action: auditActionFilter || undefined,
          resourceType: auditResourceFilter || undefined,
          startDate: toIsoDateFilter(auditStart),
          endDate: toIsoDateFilter(auditEnd),
        }),
        webhooksPhase2Api.getDlqList({
          limit: dlqLimit,
          offset: dlqOffset,
          endpointId: dlqEndpointFilter === 'all' ? undefined : dlqEndpointFilter,
          failureReason: dlqFailureReasonFilter === 'all' ? undefined : dlqFailureReasonFilter as WebhookFailureReason,
        }),
        webhooksPhase2Api.getDlqStats(),
      ]);

      setEndpoints(endpointData);
      setDeliveries(deliveryRes.data);
      setAuditLogs(auditRes.data);
      setDeliveryTotal(deliveryRes.pagination.total);
      setAuditTotal(auditRes.pagination.total);
      setDlqItems(dlqRes.data);
      setDlqStats(stats);
      setDlqTotal(dlqRes.pagination.total);
    } catch (error) {
      console.error('Failed to load webhook management data:', error);
      toast.error(tx('加载 Webhook 管理数据失败', 'Failed to load webhook management data'));
    } finally {
      setLoading(false);
    }
  }, [
    deliveryLimit,
    deliveryOffset,
    deliveryEndpointFilter,
    deliveryStatusFilter,
    auditLimit,
    auditOffset,
    auditActionFilter,
    auditResourceFilter,
    auditStart,
    auditEnd,
    dlqLimit,
    dlqOffset,
    dlqEndpointFilter,
    dlqFailureReasonFilter,
    tx,
  ]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (dlqTotal === 0 && dlqOffset !== 0) {
      setDlqOffset(0);
      return;
    }
    if (dlqTotal > 0 && dlqOffset >= dlqTotal) {
      setDlqOffset(Math.max(0, Math.floor((dlqTotal - 1) / dlqLimit) * dlqLimit));
    }
  }, [dlqLimit, dlqOffset, dlqTotal]);

  useEffect(() => {
    if (deliveryTotal === 0 && deliveryOffset !== 0) {
      setDeliveryOffset(0);
      return;
    }
    if (deliveryTotal > 0 && deliveryOffset >= deliveryTotal) {
      setDeliveryOffset(Math.max(0, Math.floor((deliveryTotal - 1) / deliveryLimit) * deliveryLimit));
    }
  }, [deliveryLimit, deliveryOffset, deliveryTotal]);

  useEffect(() => {
    if (auditTotal === 0 && auditOffset !== 0) {
      setAuditOffset(0);
      return;
    }
    if (auditTotal > 0 && auditOffset >= auditTotal) {
      setAuditOffset(Math.max(0, Math.floor((auditTotal - 1) / auditLimit) * auditLimit));
    }
  }, [auditLimit, auditOffset, auditTotal]);

  const loadReplayBatches = useCallback(async () => {
    try {
      const result = await webhooksPhase2Api.listReplayBatches({ limit: 20, offset: 0 });
      setReplayBatches(result.data);
    } catch (error) {
      console.error('Failed to load replay batches:', error);
    }
  }, []);

  useEffect(() => {
    void loadReplayBatches();
  }, [loadReplayBatches]);

  useEffect(() => {
    if (!replayBatches.some((batch) => batch.status === 'IN_PROGRESS' || batch.status === 'PENDING')) {
      return undefined;
    }
    const timer = window.setInterval(() => { void loadReplayBatches(); }, 2000);
    return () => window.clearInterval(timer);
  }, [loadReplayBatches, replayBatches]);

  const onSubmit = async () => {
    if (!form.name || !form.sourceSystem || !form.urlPath) {
      toast.warning(tx('请填写 name/sourceSystem/urlPath', 'Please fill in name/sourceSystem/urlPath'));
      return;
    }

    try {
      if (editId) {
        await inboundWebhookApi.updateEndpoint(editId, {
          name: form.name,
          sourceSystem: form.sourceSystem,
          authMethod: form.authMethod,
          secret: form.authMethod === 'NONE' ? null : form.secret || null,
        });
      } else {
        await inboundWebhookApi.createEndpoint({
          name: form.name,
          sourceSystem: form.sourceSystem,
          urlPath: form.urlPath,
          authMethod: form.authMethod,
          secret: form.authMethod === 'NONE' ? null : form.secret || null,
          isActive: true,
        });
      }

      setForm(initialForm);
      setEditId(null);
      await loadAll();
    } catch (error) {
      console.error('Failed to submit endpoint:', error);
      toast.error(tx('保存端点失败', 'Failed to save endpoint'));
    }
  };

  const onEdit = (item: InboundWebhookEndpoint) => {
    setEditId(item.id);
    setForm({
      name: item.name,
      sourceSystem: item.sourceSystem,
      urlPath: item.urlPath,
      authMethod: (item.authMethod as 'HMAC' | 'API_KEY' | 'NONE') || 'HMAC',
      secret: item.secret ?? '',
    });
  };

  const onToggleStatus = async (item: InboundWebhookEndpoint) => {
    setActionLoadingId(item.id);
    try {
      if (item.isActive) {
        await inboundWebhookApi.disableEndpoint(item.id);
      } else {
        await inboundWebhookApi.enableEndpoint(item.id);
      }
      await loadAll();
    } catch (error) {
      console.error('Failed to toggle endpoint status:', error);
      toast.error(tx('切换端点状态失败', 'Failed to toggle endpoint status'));
    } finally {
      setActionLoadingId(null);
    }
  };

  const onDelete = async (id: string) => {
    setDeleteEndpointId(id);
  };

  const confirmDeleteEndpoint = async () => {
    if (!deleteEndpointId) return;
    setActionLoadingId(deleteEndpointId);
    try {
      await inboundWebhookApi.deleteEndpoint(deleteEndpointId);
      if (editId === deleteEndpointId) {
        setEditId(null);
        setForm(initialForm);
      }
      await loadAll();
    } catch (error) {
      console.error('Failed to delete endpoint:', error);
      toast.error(tx('删除端点失败', 'Failed to delete endpoint'));
    } finally {
      setActionLoadingId(null);
      setDeleteEndpointId(null);
    }
  };

  const openTestDialog = (item: InboundWebhookEndpoint) => {
    setTestTarget(item);
    setTestPayloadText(
      JSON.stringify(
        {
          event: 'ui_webhook_test',
          source: 'settings-panel',
          endpoint: item.urlPath,
          ts: new Date().toISOString(),
          payload: {
            sampleId: `sample-${Date.now()}`,
            priority: 'HIGH',
            note: tx('来自管理面板的测试消息', 'Test message from management panel'),
          },
        },
        null,
        2
      )
    );
    setTestDialogOpen(true);
    setSelectedTemplateId('');
    loadTemplates();
  };

  const saveAsTemplate = () => {
    const name = window
      .prompt(tx('请输入模板名称', 'Enter template name'), selectedTemplate?.name ?? '')
      ?.trim();
    if (!name) {
      toast.warning(tx('请输入模板名称', 'Please enter a template name'));
      return;
    }

    const next: PayloadTemplate[] = [
      {
        id: `tpl-${Date.now()}`,
        name,
        payloadText: testPayloadText,
        updatedAt: new Date().toISOString(),
      },
      ...templates.filter((tpl) => tpl.name !== name),
    ].slice(0, 20);

    persistTemplates(next);
    toast.success(tx('已保存为模板', 'Saved as template'));
  };

  const applyTemplate = (id: string) => {
    setSelectedTemplateId(id);
    const selected = templates.find((tpl) => tpl.id === id);
    if (selected) {
      setTestPayloadText(selected.payloadText);
    }
  };

  const deleteTemplateById = (id: string) => {
    setDeleteTemplateId(id);
  };

  const confirmDeleteTemplate = () => {
    if (!deleteTemplateId) return;
    const next = templates.filter((tpl) => tpl.id !== deleteTemplateId);
    persistTemplates(next);
    if (selectedTemplateId === deleteTemplateId) {
      setSelectedTemplateId('');
    }
    setDeleteTemplateId(null);
  };

  const onSendTest = async () => {
    if (!testTarget) {
      return;
    }

    setActionLoadingId(`test-${testTarget.id}`);
    try {
      let parsedPayload: unknown;
      try {
        parsedPayload = JSON.parse(testPayloadText);
      } catch {
        toast.error(tx('Payload 不是有效 JSON', 'Payload is not valid JSON'));
        return;
      }

      const payloadText = JSON.stringify(parsedPayload);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (testTarget.authMethod === 'API_KEY' && testTarget.secret) {
        headers['x-api-key'] = testTarget.secret;
      }

      if (testTarget.authMethod === 'HMAC' && testTarget.secret) {
        const signature = await hmacSha256Hex(testTarget.secret, payloadText);
        headers['x-signature'] = `sha256=${signature}`;
      }

      const res = await fetch(`${API_BASE_URL}/inbound-webhooks/${testTarget.urlPath}`, {
        method: 'POST',
        headers,
        body: payloadText,
      });

      const bodyText = await res.text();
      if (!res.ok) {
        throw new Error(`${res.status} ${bodyText}`);
      }

      toast.success(tx('测试发送成功', 'Test send successful'));
      setTestDialogOpen(false);
      await loadAll();
    } catch (error) {
      console.error('Test send failed:', error);
      toast.error(tx('测试发送失败，请检查密钥和端点状态', 'Test send failed, please check secret and endpoint status'));
    } finally {
      setActionLoadingId(null);
    }
  };

  const onDlqAction = async (id: string, action: 'review' | 'retry' | 'abandon') => {
    setActionLoadingId(id + action);
    try {
      if (action === 'review') {
        await webhooksPhase2Api.markReviewed(id);
      }
      if (action === 'retry') {
        await webhooksPhase2Api.retry(id, { resetAttemptCount: true });
      }
      if (action === 'abandon') {
        await webhooksPhase2Api.abandon(id, tx('前端面板手动放弃', 'Manual abandon from UI'));
      }
      await loadAll();
    } catch (error) {
      console.error('Failed to execute DLQ action:', error);
      toast.error(tx('DLQ 操作失败', 'DLQ action failed'));
    } finally {
      setActionLoadingId(null);
    }
  };

  const selectedReplayIds = useMemo(() => Array.from(selectedReplayDeliveryIds), [selectedReplayDeliveryIds]);

  const onQueryReplay = async () => {
    setReplayLoading(true);
    try {
      const eventTypes = replayEventTypes.split(',').map((value) => value.trim()).filter(Boolean);
      const result = await webhooksPhase2Api.queryReplay({
        startDate: toIsoDateFilter(replayStartDate),
        endDate: toReplayEndOfDay(replayEndDate),
        eventTypes: eventTypes.length > 0 ? eventTypes : undefined,
        endpointIds: replayEndpointId === 'all' ? undefined : [replayEndpointId],
        status: replayStatus,
        limit: 1000,
      });
      setReplayDeliveries(result.deliveries);
      setSelectedReplayDeliveryIds(new Set(result.deliveries.map((delivery) => delivery.id)));
      setReplayEstimate(null);
      toast.success(tx(`已找到 ${result.count} 条可重放投递`, `Found ${result.count} replayable deliveries`));
    } catch (error) {
      console.error('Failed to query replay deliveries:', error);
      toast.error(tx('查询可重放投递失败', 'Failed to query replayable deliveries'));
    } finally {
      setReplayLoading(false);
    }
  };

  const onEstimateReplay = async () => {
    if (selectedReplayIds.length === 0) {
      toast.warning(tx('请先选择至少一条投递记录', 'Select at least one delivery first'));
      return;
    }
    setReplayLoading(true);
    try {
      const estimate = await webhooksPhase2Api.estimateReplay(selectedReplayIds);
      setReplayEstimate(estimate);
    } catch (error) {
      console.error('Failed to estimate replay:', error);
      toast.error(tx('回放影响预估失败', 'Replay impact estimation failed'));
    } finally {
      setReplayLoading(false);
    }
  };

  const toggleReplayDelivery = (deliveryId: string, selected: boolean) => {
    setSelectedReplayDeliveryIds((current) => {
      const next = new Set(current);
      if (selected) next.add(deliveryId);
      else next.delete(deliveryId);
      return next;
    });
    setReplayEstimate(null);
  };

  const onExecuteReplay = async () => {
    if (!replayEstimate || replayEstimate.totalDeliveries !== selectedReplayIds.length) {
      toast.warning(tx('请在执行前重新预估当前选择的影响范围', 'Estimate the currently selected deliveries before executing'));
      return;
    }
    const confirmed = window.confirm(
      tx(
        `确认重放 ${selectedReplayIds.length} 条投递吗？该操作会重新触发相应 Webhook。`,
        `Replay ${selectedReplayIds.length} deliveries? This will trigger the corresponding webhooks again.`,
      ),
    );
    if (!confirmed) return;

    setReplayExecuting(true);
    try {
      const result = await webhooksPhase2Api.executeReplay({ deliveryIds: selectedReplayIds, concurrency: 3 });
      toast.success(tx(`回放批次已创建：${result.batchId.slice(0, 8)}`, `Replay batch created: ${result.batchId.slice(0, 8)}`));
      setReplayEstimate(null);
      await loadReplayBatches();
    } catch (error) {
      console.error('Failed to execute replay:', error);
      toast.error(tx('执行回放失败', 'Failed to execute replay'));
    } finally {
      setReplayExecuting(false);
    }
  };

  const onCancelReplayBatch = async (batchId: string) => {
    try {
      await webhooksPhase2Api.cancelReplayBatch(batchId);
      toast.success(tx('回放批次已取消', 'Replay batch cancelled'));
      await loadReplayBatches();
    } catch (error) {
      console.error('Failed to cancel replay batch:', error);
      toast.error(tx('取消回放批次失败', 'Failed to cancel replay batch'));
    }
  };

  const endpointMap = useMemo(() => {
    const map = new Map<string, InboundWebhookEndpoint>();
    endpoints.forEach((item) => map.set(item.id, item));
    return map;
  }, [endpoints]);

  const filteredAuditLogs = useMemo(() => {
    return auditLogs.filter((item) => {
      const ts = new Date(item.createdAt).getTime();
      if (auditStart) {
        const startTs = new Date(auditStart).getTime();
        if (ts < startTs) return false;
      }
      if (auditEnd) {
        const endTs = new Date(auditEnd).getTime();
        if (ts > endTs) return false;
      }
      return true;
    });
  }, [auditLogs, auditStart, auditEnd]);

  const exportAuditCsv = () => {
    const rows = filteredAuditLogs.map((item) => ({
      time: new Date(item.createdAt).toISOString(),
      action: item.action,
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      userId: item.userId,
      sourceIp: item.sourceIp ?? '',
      changes: item.changes ?? '',
    }));

    const headers = ['time', 'action', 'resourceType', 'resourceId', 'userId', 'sourceIp', 'changes'];
    const escapeCell = (value: string) => `"${String(value).replace(/"/g, '""')}"`;
    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => escapeCell(String(row[h as keyof typeof row]))).join(',')),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `webhook-audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportDeliveriesCsv = () => {
    const rows = deliveries.map((item) => ({
      id: item.id,
      endpointId: item.endpointId,
      endpointName: endpointMap.get(item.endpointId)?.name ?? '',
      status: item.status,
      errorMessage: item.errorMessage ?? '',
      attempts: String(item.attempts),
      receivedAt: item.receivedAt,
      processedAt: item.processedAt ?? '',
    }));

    const headers = ['id', 'endpointId', 'endpointName', 'status', 'errorMessage', 'attempts', 'receivedAt', 'processedAt'];
    const escapeCell = (value: string) => `"${String(value).replace(/"/g, '""')}"`;
    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => escapeCell(String(row[h as keyof typeof row]))).join(',')),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `webhook-deliveries-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const copyText = async (value: string, successZh: string, successEn: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(tx(successZh, successEn));
    } catch (error) {
      console.error('Copy failed:', error);
      toast.error(tx('复制失败', 'Copy failed'));
    }
  };

  const copyEndpointAddress = async (urlPath: string) => {
    const path = `/api/inbound-webhooks/${urlPath}`;
    const url = `${API_BASE_URL}/inbound-webhooks/${urlPath}`;
    await copyText(`${url}\n${path}`, '已复制 URL 与 Path', 'URL and path copied');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{tx('Webhook 管理面板', 'Webhook Management')}</h3>
          <p className="text-sm text-muted-foreground">
            {tx('统一管理入站端点、投递记录、审计日志和 Phase2 DLQ', 'Manage inbound endpoints, deliveries, audit logs and Phase2 DLQ in one place')}
          </p>
        </div>
        <Button variant="outline" onClick={() => void loadAll()} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          {tx('刷新', 'Refresh')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{editId ? tx('编辑端点', 'Edit Endpoint') : tx('新增端点', 'Create Endpoint')}</CardTitle>
          <CardDescription>{tx('支持 HMAC / API_KEY / NONE', 'Supports HMAC / API_KEY / NONE')}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <div className="space-y-1">
            <Label>{tx('名称', 'Name')}</Label>
            <Input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>{tx('来源系统', 'Source System')}</Label>
            <Input value={form.sourceSystem} onChange={(e) => setForm((prev) => ({ ...prev, sourceSystem: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>URL Path</Label>
            <Input value={form.urlPath} disabled={Boolean(editId)} onChange={(e) => setForm((prev) => ({ ...prev, urlPath: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label>{tx('认证方式', 'Auth Method')}</Label>
            <Input value={form.authMethod} onChange={(e) => setForm((prev) => ({ ...prev, authMethod: e.target.value as EndpointFormState['authMethod'] }))} placeholder="HMAC / API_KEY / NONE" />
          </div>
          <div className="space-y-1">
            <Label>{tx('密钥', 'Secret')}</Label>
            <Input value={form.secret} onChange={(e) => setForm((prev) => ({ ...prev, secret: e.target.value }))} disabled={form.authMethod === 'NONE'} />
          </div>
          <div className="md:col-span-5 flex items-center gap-2">
            <Button onClick={() => void onSubmit()}>{editId ? tx('保存修改', 'Save') : tx('创建端点', 'Create')}</Button>
            {editId ? (
              <Button
                variant="outline"
                onClick={() => {
                  setEditId(null);
                  setForm(initialForm);
                }}
              >
                {tx('取消编辑', 'Cancel')}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="endpoints" className="space-y-4">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="endpoints">{tx('入站端点', 'Inbound Endpoints')}</TabsTrigger>
          <TabsTrigger value="deliveries">{tx('投递记录', 'Deliveries')}</TabsTrigger>
          <TabsTrigger value="audit">{tx('审计日志', 'Audit')}</TabsTrigger>
          <TabsTrigger value="dlq">Phase2 DLQ</TabsTrigger>
          <TabsTrigger value="replay">{tx('批量回放', 'Bulk Replay')}</TabsTrigger>
        </TabsList>

        <TabsContent value="endpoints" className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>{tx('端点列表', 'Endpoint List')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('名称', 'Name')}</TableHead>
                    <TableHead>{tx('路径', 'Path')}</TableHead>
                    <TableHead>{tx('认证', 'Auth')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {endpoints.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{item.name}</TableCell>
                      <TableCell className="font-mono text-xs">/{item.urlPath}</TableCell>
                      <TableCell>{item.authMethod}</TableCell>
                      <TableCell>
                        <Badge variant={item.isActive ? 'default' : 'secondary'}>{item.isActive ? tx('启用', 'Enabled') : tx('禁用', 'Disabled')}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" disabled={actionLoadingId === `test-${item.id}`} onClick={() => openTestDialog(item)}>
                          {tx('测试发送', 'Test Send')}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="outline" aria-label={tx('更多操作', 'More actions')}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => void copyEndpointAddress(item.urlPath)}>
                              {tx('复制地址', 'Copy Address')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => onEdit(item)}>
                              {tx('编辑', 'Edit')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={actionLoadingId === item.id}
                              onSelect={() => void onToggleStatus(item)}
                            >
                              {item.isActive ? tx('禁用', 'Disable') : tx('启用', 'Enable')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={actionLoadingId === item.id}
                              onSelect={() => void onDelete(item.id)}
                            >
                              {tx('删除', 'Delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {endpoints.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        {tx('暂无端点', 'No endpoints')}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="deliveries" className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>{tx('投递记录', 'Delivery Records')}</CardTitle>
              <CardDescription>
                <div className="flex items-center gap-2">
                  <span>{tx('状态筛选', 'Status Filter')}</span>
                  <Select
                    value={deliveryStatusFilter}
                    onValueChange={(v) => {
                      setDeliveryOffset(0);
                      setDeliveryStatusFilter(v);
                    }}
                  >
                    <SelectTrigger className="h-8 w-40">
                      <SelectValue placeholder={tx('全部', 'All')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{tx('全部', 'All')}</SelectItem>
                      <SelectItem value="success">success</SelectItem>
                      <SelectItem value="failed">failed</SelectItem>
                    </SelectContent>
                  </Select>
                  <span>{tx('端点', 'Endpoint')}</span>
                  <Select
                    value={deliveryEndpointFilter}
                    onValueChange={(v) => {
                      setDeliveryOffset(0);
                      setDeliveryEndpointFilter(v);
                    }}
                  >
                    <SelectTrigger className="h-8 w-44">
                      <SelectValue placeholder={tx('全部端点', 'All endpoints')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{tx('全部端点', 'All endpoints')}</SelectItem>
                      {endpoints.map((endpoint) => (
                        <SelectItem key={endpoint.id} value={endpoint.id}>
                          {endpoint.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" onClick={exportDeliveriesCsv}>{tx('导出 CSV', 'Export CSV')}</Button>
                </div>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('ID', 'ID')}</TableHead>
                    <TableHead>{tx('端点', 'Endpoint')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('错误', 'Error')}</TableHead>
                    <TableHead>{tx('接收时间', 'Received At')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-mono text-xs">{item.id.slice(0, 8)}</TableCell>
                      <TableCell>{endpointMap.get(item.endpointId)?.name ?? item.endpointId.slice(0, 8)}</TableCell>
                      <TableCell><Badge variant={item.status === 'success' ? 'default' : 'secondary'}>{item.status}</Badge></TableCell>
                      <TableCell className="max-w-[260px] truncate">{item.errorMessage || '-'}</TableCell>
                      <TableCell>{new Date(item.receivedAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</TableCell>
                    </TableRow>
                  ))}
                  {deliveries.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        {tx('暂无投递记录', 'No deliveries')}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
              <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
                <span>{tx('总数', 'Total')}: {deliveryTotal}</span>
                <div className="space-x-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deliveryOffset <= 0}
                    onClick={() => setDeliveryOffset((v) => Math.max(0, v - deliveryLimit))}
                  >
                    {tx('上一页', 'Prev')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deliveryOffset + deliveryLimit >= deliveryTotal}
                    onClick={() => setDeliveryOffset((v) => v + deliveryLimit)}
                  >
                    {tx('下一页', 'Next')}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit" className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>{tx('审计日志', 'Audit Logs')}</CardTitle>
              <CardDescription>
                <div className="flex flex-wrap items-center gap-2">
                  <Input className="h-8 w-36" value={auditActionFilter} onChange={(e) => { setAuditOffset(0); setAuditActionFilter(e.target.value); }} placeholder={tx('动作筛选', 'Action')} />
                  <Input className="h-8 w-36" value={auditResourceFilter} onChange={(e) => { setAuditOffset(0); setAuditResourceFilter(e.target.value); }} placeholder={tx('资源类型', 'Resource')} />
                  <Input className="h-8 w-40" type="datetime-local" value={auditStart} onChange={(e) => { setAuditOffset(0); setAuditStart(e.target.value); }} />
                  <Input className="h-8 w-40" type="datetime-local" value={auditEnd} onChange={(e) => { setAuditOffset(0); setAuditEnd(e.target.value); }} />
                  <Button size="sm" variant="outline" onClick={() => setAuditOffset(0)}>{tx('应用', 'Apply')}</Button>
                  <Button size="sm" variant="outline" onClick={exportAuditCsv}>{tx('导出 CSV', 'Export CSV')}</Button>
                </div>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('时间', 'Time')}</TableHead>
                    <TableHead>{tx('动作', 'Action')}</TableHead>
                    <TableHead>{tx('资源类型', 'Resource')}</TableHead>
                    <TableHead>{tx('资源ID', 'Resource ID')}</TableHead>
                    <TableHead>{tx('用户', 'User')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAuditLogs.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{new Date(item.createdAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</TableCell>
                      <TableCell><Badge variant="outline">{item.action}</Badge></TableCell>
                      <TableCell>{item.resourceType}</TableCell>
                      <TableCell className="font-mono text-xs">{item.resourceId.slice(0, 8)}</TableCell>
                      <TableCell>{item.userId}</TableCell>
                    </TableRow>
                  ))}
                  {filteredAuditLogs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        {tx('暂无审计日志', 'No audit logs')}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
              <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
                <span>{tx('总数', 'Total')}: {auditTotal}</span>
                <div className="space-x-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={auditOffset <= 0}
                    onClick={() => setAuditOffset((v) => Math.max(0, v - auditLimit))}
                  >
                    {tx('上一页', 'Prev')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={auditOffset + auditLimit >= auditTotal}
                    onClick={() => setAuditOffset((v) => v + auditLimit)}
                  >
                    {tx('下一页', 'Next')}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="dlq" className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>{tx('隔离总数', 'Total Quarantined')}</CardDescription>
                <CardTitle>{dlqStats?.totalQuarantined ?? 0}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>{tx('1小时内', 'Within 1 hour')}</CardDescription>
                <CardTitle>{dlqStats?.byAge.lessThan1h ?? 0}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>{tx('1-24小时', '1-24 hours')}</CardDescription>
                <CardTitle>{dlqStats?.byAge.between1hAnd24h ?? 0}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>{tx('24小时以上', 'Over 24 hours')}</CardDescription>
                <CardTitle>{dlqStats?.byAge.moreThan24h ?? 0}</CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>{tx('DLQ 列表', 'DLQ List')}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  {tx('总数', 'Total')}: {dlqTotal}
                </span>
              </CardTitle>
              <CardDescription>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={dlqEndpointFilter}
                    onValueChange={(v) => {
                      setDlqOffset(0);
                      setDlqEndpointFilter(v);
                    }}
                  >
                    <SelectTrigger className="h-8 w-44">
                      <SelectValue placeholder={tx('全部端点', 'All endpoints')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{tx('全部端点', 'All endpoints')}</SelectItem>
                      {endpoints.map((endpoint) => (
                        <SelectItem key={endpoint.id} value={endpoint.id}>
                          {endpoint.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={dlqFailureReasonFilter}
                    onValueChange={(v) => {
                      setDlqOffset(0);
                      setDlqFailureReasonFilter(v);
                    }}
                  >
                    <SelectTrigger className="h-8 w-48">
                      <SelectValue placeholder={tx('全部失败原因', 'All failure reasons')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{tx('全部失败原因', 'All failure reasons')}</SelectItem>
                      {DLQ_FAILURE_REASONS.map((reason) => (
                        <SelectItem key={reason} value={reason}>{reason}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('ID', 'ID')}</TableHead>
                    <TableHead>{tx('端点', 'Endpoint')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('失败原因', 'Failure Reason')}</TableHead>
                    <TableHead>{tx('重试次数', 'Retry Count')}</TableHead>
                    <TableHead>{tx('隔离时间', 'Quarantined At')}</TableHead>
                    <TableHead>{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dlqItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-mono text-xs">{item.id.slice(0, 8)}</TableCell>
                      <TableCell>{endpointMap.get(item.endpointId)?.name ?? item.endpointId.slice(0, 8)}</TableCell>
                      <TableCell>quarantined</TableCell>
                      <TableCell>{item.failureReason || '-'}</TableCell>
                      <TableCell>{item.attemptCount}</TableCell>
                      <TableCell>{new Date(item.quarantineAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}</TableCell>
                      <TableCell className="space-x-2">
                        <Button size="sm" variant="outline" disabled={actionLoadingId === item.id + 'review'} onClick={() => void onDlqAction(item.id, 'review')}>
                          {tx('审核', 'Review')}
                        </Button>
                        <Button size="sm" variant="outline" disabled={actionLoadingId === item.id + 'retry'} onClick={() => void onDlqAction(item.id, 'retry')}>
                          {tx('重试', 'Retry')}
                        </Button>
                        <Button size="sm" variant="destructive" disabled={actionLoadingId === item.id + 'abandon'} onClick={() => void onDlqAction(item.id, 'abandon')}>
                          {tx('放弃', 'Abandon')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {dlqItems.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        {tx('暂无 DLQ 记录', 'No DLQ items')}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
              <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  {dlqTotal === 0
                    ? tx('暂无记录', 'No records')
                    : tx('第', 'Items') + ' ' + (dlqOffset + 1) + '-' + Math.min(dlqOffset + dlqLimit, dlqTotal) + ' / ' + dlqTotal}
                </span>
                <div className="space-x-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={dlqOffset <= 0}
                    onClick={() => setDlqOffset((value) => Math.max(0, value - dlqLimit))}
                  >
                    {tx('上一页', 'Prev')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={dlqOffset + dlqLimit >= dlqTotal}
                    onClick={() => setDlqOffset((value) => value + dlqLimit)}
                  >
                    {tx('下一页', 'Next')}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="replay" className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>{tx('批量回放查询', 'Bulk Replay Query')}</CardTitle>
              <CardDescription>
                {tx('先查询并预估影响范围，再显式确认执行。单次查询和执行最多处理 1,000 条当前匹配投递。', 'Query and estimate impact before explicitly executing. Each UI batch is limited to 1,000 matching deliveries.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label>{tx('开始日期', 'Start date')}</Label>
                <Input type="date" value={replayStartDate} onChange={(event) => setReplayStartDate(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{tx('结束日期', 'End date')}</Label>
                <Input type="date" value={replayEndDate} onChange={(event) => setReplayEndDate(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{tx('投递状态', 'Delivery status')}</Label>
                <Select value={replayStatus} onValueChange={(value) => setReplayStatus(value as WebhookReplayDeliveryStatus)}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="delivered">delivered</SelectItem>
                    <SelectItem value="failed">failed</SelectItem>
                    <SelectItem value="pending">pending</SelectItem>
                    <SelectItem value="quarantined">quarantined</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{tx('端点', 'Endpoint')}</Label>
                <Select value={replayEndpointId} onValueChange={setReplayEndpointId}>
                  <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{tx('全部端点', 'All endpoints')}</SelectItem>
                    {endpoints.map((endpoint) => <SelectItem key={endpoint.id} value={endpoint.id}>{endpoint.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-[220px] flex-1 space-y-1">
                <Label>{tx('事件类型（逗号分隔）', 'Event types (comma separated)')}</Label>
                <Input value={replayEventTypes} onChange={(event) => setReplayEventTypes(event.target.value)} placeholder="rfq.created, order.updated" />
              </div>
              <Button disabled={replayLoading || !can('webhook.read')} onClick={() => void onQueryReplay()}>
                {replayLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                {tx('查询投递', 'Query deliveries')}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                <span>{tx('待回放投递', 'Replay Candidates')}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  {tx('已选', 'Selected')}: {selectedReplayIds.length} / {replayDeliveries.length}
                </span>
              </CardTitle>
              <CardDescription>
                {replayDeliveries.length > 100
                  ? tx('表格仅展示前 100 条；选择数量包含全部查询结果。', 'Only the first 100 are shown; the selection count covers all query results.')
                  : tx('更改选择后需要重新预估，执行会再次要求确认。', 'Changing the selection requires a new estimate; execution asks for confirmation again.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                  id="replay-select-all"
                  checked={replayDeliveries.length > 0 && selectedReplayIds.length === replayDeliveries.length}
                  onCheckedChange={(checked) => {
                    setSelectedReplayDeliveryIds(checked === true ? new Set(replayDeliveries.map((delivery) => delivery.id)) : new Set());
                    setReplayEstimate(null);
                  }}
                />
                <Label htmlFor="replay-select-all">{tx('选择当前查询的全部投递', 'Select all queried deliveries')}</Label>
                <Button variant="outline" size="sm" disabled={replayLoading || selectedReplayIds.length === 0} onClick={() => void onEstimateReplay()}>
                  {tx('预估影响', 'Estimate impact')}
                </Button>
                {can('webhook.manage') && (
                  <Button size="sm" disabled={replayExecuting || !replayEstimate || selectedReplayIds.length === 0} onClick={() => void onExecuteReplay()}>
                    {replayExecuting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {tx('确认并执行回放', 'Confirm and execute replay')}
                  </Button>
                )}
              </div>

              {replayEstimate && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                  <span>{tx('预估投递数', 'Estimated deliveries')}: {replayEstimate.totalDeliveries}</span>
                  <span className="mx-2">·</span>
                  <span>{tx('受影响端点', 'Affected endpoints')}: {replayEstimate.affectedEndpoints.length}</span>
                  <span className="mx-2">·</span>
                  <span>{tx('预计时长', 'Estimated duration')}: {replayEstimate.estimatedDuration}s</span>
                </div>
              )}

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>{tx('事件', 'Event')}</TableHead>
                    <TableHead>{tx('端点', 'Endpoint')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('原投递时间', 'Original delivery time')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {replayDeliveries.slice(0, 100).map((delivery) => (
                    <TableRow key={delivery.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedReplayDeliveryIds.has(delivery.id)}
                          onCheckedChange={(checked) => toggleReplayDelivery(delivery.id, checked === true)}
                          aria-label={tx(`选择投递 ${delivery.id}`, `Select delivery ${delivery.id}`)}
                        />
                      </TableCell>
                      <TableCell>{delivery.eventType}</TableCell>
                      <TableCell>{endpointMap.get(delivery.endpointId)?.name ?? delivery.endpointId.slice(0, 8)}</TableCell>
                      <TableCell><Badge variant="outline">{delivery.status}</Badge></TableCell>
                      <TableCell>{delivery.deliveredAt ? new Date(delivery.deliveredAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US') : '-'}</TableCell>
                    </TableRow>
                  ))}
                  {replayDeliveries.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{tx('尚未查询到可回放投递', 'No replay candidates queried yet')}</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{tx('回放批次进度', 'Replay Batch Progress')}</CardTitle>
              <CardDescription>{tx('进行中的批次会每两秒自动刷新。', 'In-progress batches refresh automatically every two seconds.')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('批次', 'Batch')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('进度', 'Progress')}</TableHead>
                    <TableHead>{tx('成功/失败/待处理', 'Success / Failed / Pending')}</TableHead>
                    <TableHead>{tx('开始时间', 'Started')}</TableHead>
                    <TableHead>{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {replayBatches.map((batch) => (
                    <TableRow key={batch.batchId}>
                      <TableCell className="font-mono text-xs">{batch.batchId.slice(0, 8)}</TableCell>
                      <TableCell><Badge variant={batch.status === 'COMPLETED' ? 'default' : batch.status === 'FAILED' ? 'destructive' : 'secondary'}>{batch.status}</Badge></TableCell>
                      <TableCell>{batch.progress}% ({batch.totalDeliveries})</TableCell>
                      <TableCell>{batch.succeeded} / {batch.failed} / {batch.pending}</TableCell>
                      <TableCell>{batch.startedAt ? new Date(batch.startedAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US') : '-'}</TableCell>
                      <TableCell>
                        {can('webhook.manage') && batch.status === 'IN_PROGRESS' && (
                          <Button size="sm" variant="destructive" onClick={() => void onCancelReplayBatch(batch.batchId)}>{tx('取消', 'Cancel')}</Button>
                        )}
                        {batch.errorMessage && <span className="ml-2 text-xs text-destructive" title={batch.errorMessage}>{tx('失败详情', 'Failure details')}</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                  {replayBatches.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">{tx('暂无回放批次', 'No replay batches')}</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AlertDialog open={!!deleteEndpointId} onOpenChange={(open) => { if (!open) setDeleteEndpointId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tx('确认删除', 'Confirm Delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tx('确定要删除该端点吗？此操作不可撤销。', 'Are you sure you want to delete this endpoint? This action cannot be undone.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteEndpointId(null)}>{tx('取消', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteEndpoint}>{tx('删除', 'Delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTemplateId} onOpenChange={(open) => { if (!open) setDeleteTemplateId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tx('确认删除', 'Confirm Delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tx('确定要删除此模板吗？此操作不可撤销。', 'Are you sure you want to delete this template? This action cannot be undone.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTemplateId(null)}>{tx('取消', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteTemplate}>{tx('删除', 'Delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tx('测试发送 Webhook', 'Test Send Webhook')}</DialogTitle>
            <DialogDescription>
              {testTarget
                ? `${tx('目标端点', 'Target')}: /${testTarget.urlPath} | ${tx('鉴权', 'Auth')}: ${testTarget.authMethod}`
                : tx('请选择目标端点', 'Select target endpoint')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-md border p-3 text-xs text-muted-foreground">
              <div>POST {testTarget ? `${API_BASE_URL}/inbound-webhooks/${testTarget.urlPath}` : '-'}</div>
              <div className="mt-1">
                {tx('请求头会自动包含 Content-Type，且在 API_KEY/HMAC 时自动注入鉴权头。', 'Headers include Content-Type and auth headers are auto-injected for API_KEY/HMAC.')}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-md border p-2">
              <span className="text-sm text-muted-foreground">
                {selectedTemplate ? selectedTemplate.name : tx('未选择模板', 'No template selected')}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm">{tx('模板', 'Templates')}</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuItem onSelect={saveAsTemplate}>{tx('保存当前内容为模板', 'Save current payload as template')}</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{tx('套用模板', 'Apply template')}</DropdownMenuLabel>
                  {templates.length === 0 ? (
                    <DropdownMenuItem disabled>{tx('暂无模板', 'No templates')}</DropdownMenuItem>
                  ) : (
                    templates.map((tpl) => (
                      <DropdownMenuItem key={tpl.id} onSelect={() => applyTemplate(tpl.id)}>
                        {tpl.name}
                      </DropdownMenuItem>
                    ))
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>{tx('删除模板', 'Delete template')}</DropdownMenuLabel>
                  {templates.length === 0 ? (
                    <DropdownMenuItem disabled>{tx('暂无模板', 'No templates')}</DropdownMenuItem>
                  ) : (
                    templates.map((tpl) => (
                      <DropdownMenuItem key={`del-${tpl.id}`} variant="destructive" onSelect={() => deleteTemplateById(tpl.id)}>
                        {tpl.name}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="space-y-1">
              <Label>{tx('JSON 载荷', 'JSON Payload')}</Label>
              <Textarea
                className="min-h-[260px] font-mono text-xs"
                value={testPayloadText}
                onChange={(e) => setTestPayloadText(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTestDialogOpen(false)}>{tx('取消', 'Cancel')}</Button>
            <Button disabled={!testTarget || actionLoadingId === `test-${testTarget?.id ?? ''}`} onClick={() => void onSendTest()}>
              {tx('发送测试', 'Send Test')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
