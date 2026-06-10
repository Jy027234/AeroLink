import { useEffect, useState } from 'react';
import {
  Search,
  Plus,
  Eye,
  Edit3,
  Copy,
  Trash2,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  GitBranch,
  Zap,
  Bell,
  UserCog,
  Send,
  History,
  Inbox,
  Settings,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { WorkflowBuilder } from './WorkflowBuilder';
import {
  useWorkflowDefinitions,
  useSaveWorkflowDefinition,
  useDuplicateWorkflowDefinition,
  useDeleteWorkflowDefinition,
  useWorkflowInstances,
  useWorkflowInstance,
  useWorkflowPendingTasks,
  useWorkflowAction,
} from '@/hooks/useApi';
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowInstanceStep,
  WorkflowStepStatus,
  WorkflowStatus,
  WorkflowStepType,
} from '@/types';

const entityTypeOptions = [
  { value: 'RFQ', label: 'RFQ' },
  { value: 'QUOTATION', label: '报价单' },
  { value: 'ORDER', label: '订单' },
  { value: 'CERTIFICATE', label: '证书' },
  { value: 'SUPPLIER', label: '供应商' },
];

const statusConfig: Record<WorkflowStatus, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  RUNNING: { label: '进行中', color: 'text-blue-600', bgColor: 'bg-blue-50', icon: Clock },
  COMPLETED: { label: '已完成', color: 'text-green-600', bgColor: 'bg-green-50', icon: CheckCircle },
  REJECTED: { label: '已驳回', color: 'text-red-600', bgColor: 'bg-red-50', icon: XCircle },
  CANCELLED: { label: '已取消', color: 'text-gray-500', bgColor: 'bg-gray-100', icon: XCircle },
  TIMEOUT: { label: '已超时', color: 'text-orange-600', bgColor: 'bg-orange-50', icon: AlertTriangle },
};

const stepStatusConfig: Record<WorkflowStepStatus, { label: string; color: string; bgColor: string }> = {
  PENDING: { label: '待处理', color: 'text-gray-500', bgColor: 'bg-gray-100' },
  IN_PROGRESS: { label: '进行中', color: 'text-blue-600', bgColor: 'bg-blue-50' },
  APPROVED: { label: '已批准', color: 'text-green-600', bgColor: 'bg-green-50' },
  REJECTED: { label: '已驳回', color: 'text-red-600', bgColor: 'bg-red-50' },
  SKIPPED: { label: '已跳过', color: 'text-gray-400', bgColor: 'bg-gray-50' },
  TIMEOUT: { label: '已超时', color: 'text-orange-600', bgColor: 'bg-orange-50' },
};

const stepTypeConfig: Record<WorkflowStepType, { label: string; icon: React.ElementType; color: string }> = {
  APPROVAL: { label: '审批', icon: UserCog, color: 'text-blue-600' },
  NOTIFICATION: { label: '通知', icon: Bell, color: 'text-green-600' },
  CONDITION: { label: '条件', icon: GitBranch, color: 'text-purple-600' },
  AUTOMATION: { label: '自动化', icon: Zap, color: 'text-orange-600' },
};

function StatusBadge({ status }: { status: WorkflowStatus }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border')}>
      <Icon className="w-3 h-3 mr-1" />
      {config.label}
    </Badge>
  );
}

function StepStatusBadge({ status }: { status: WorkflowStepStatus }) {
  const config = stepStatusConfig[status];
  return (
    <Badge variant="outline" className={cn(config.bgColor, config.color, 'border text-xs')}>
      {config.label}
    </Badge>
  );
}

// ==================== Definition Dialog ====================

function DefinitionDialog({
  definition,
  isOpen,
  onClose,
  onSuccess,
}: {
  definition: WorkflowDefinition | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { mutate: saveDefinition, loading } = useSaveWorkflowDefinition();

  const [formData, setFormData] = useState({
    name: '',
    code: '',
    description: '',
    entityType: 'QUOTATION',
    isActive: true,
    isDefault: false,
    steps: [] as Omit<WorkflowStep, 'id' | 'workflowId' | 'createdAt'>[],
  });

  useEffect(() => {
    if (definition) {
      setFormData({
        name: definition.name,
        code: definition.code,
        description: definition.description || '',
        entityType: definition.entityType,
        isActive: definition.isActive,
        isDefault: definition.isDefault,
        steps:
          definition.steps?.map((s) => ({
            name: s.name,
            stepOrder: s.stepOrder,
            stepType: s.stepType,
            approverRole: s.approverRole,
            approverUserId: s.approverUserId,
            approverDepartment: s.approverDepartment,
            isParallel: s.isParallel,
            parallelMinCount: s.parallelMinCount,
            timeoutHours: s.timeoutHours,
            timeoutAction: s.timeoutAction,
            conditionExpression: s.conditionExpression,
            autoAction: s.autoAction,
            notificationTemplate: s.notificationTemplate,
          })) || [],
      });
    } else {
      setFormData({
        name: '',
        code: '',
        description: '',
        entityType: 'QUOTATION',
        isActive: true,
        isDefault: false,
        steps: [],
      });
    }
  }, [definition, isOpen]);

  const handleSubmit = async () => {
    if (!formData.name || !formData.code) {
      toast.error(tx('名称和编码不能为空', 'Name and code are required'));
      return;
    }
    if (formData.steps.length === 0) {
      toast.error(tx('至少需要一个步骤', 'At least one step is required'));
      return;
    }

    try {
      await saveDefinition({
        id: definition?.id,
        data: formData as Record<string, unknown>,
      });
      toast.success(tx('保存成功', 'Saved successfully'));
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '保存失败';
      toast.error(message);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {definition ? tx('编辑工作流定义', 'Edit Workflow Definition') : tx('新建工作流定义', 'New Workflow Definition')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>{tx('名称', 'Name')}</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={tx('例如: 报价审批流程', 'e.g. Quotation Approval')}
              />
            </div>
            <div className="space-y-1">
              <Label>{tx('编码', 'Code')}</Label>
              <Input
                value={formData.code}
                disabled={!!definition}
                onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                placeholder={tx('唯一标识', 'Unique code')}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>{tx('实体类型', 'Entity Type')}</Label>
              <Select
                value={formData.entityType}
                onValueChange={(v) => setFormData({ ...formData, entityType: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {entityTypeOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{tx('描述', 'Description')}</Label>
              <Input
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder={tx('可选', 'Optional')}
              />
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Switch
                checked={formData.isActive}
                onCheckedChange={(v) => setFormData({ ...formData, isActive: v })}
              />
              <Label className="text-sm">{tx('启用', 'Active')}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={formData.isDefault}
                onCheckedChange={(v) => setFormData({ ...formData, isDefault: v })}
              />
              <Label className="text-sm">{tx('默认流程', 'Default')}</Label>
            </div>
          </div>

          <Separator />

          <WorkflowBuilder
            steps={formData.steps}
            onChange={(steps) => setFormData({ ...formData, steps })}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button className="bg-[#64b5f6] hover:bg-[#42a5f5]" onClick={handleSubmit} disabled={loading}>
            {loading && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            {tx('保存', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ==================== Instance Detail Dialog ====================

function InstanceDetailDialog({
  instanceId,
  isOpen,
  onClose,
}: {
  instanceId: string | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: instance, loading } = useWorkflowInstance(instanceId || '');

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tx('工作流详情', 'Workflow Detail')}</DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-[#64b5f6]" />
          </div>
        )}

        {!loading && instance && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">{instance.definition?.name}</p>
                <p className="text-xs text-gray-400">
                  {instance.entityType} · {instance.entityId}
                </p>
              </div>
              <StatusBadge status={instance.status} />
            </div>

            <Separator />

            {/* Timeline */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <History className="w-4 h-4" />
                {tx('流程时间线', 'Timeline')}
              </h4>
              <div className="space-y-3">
                {instance.steps?.map((step, idx) => {
                  const isLast = idx === (instance.steps?.length || 0) - 1;
                  const stepConfig = stepTypeConfig[step.step?.stepType || 'APPROVAL'];
                  const StepIcon = stepConfig.icon;

                  return (
                    <div key={step.id} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <div
                          className={cn(
                            'w-8 h-8 rounded-full flex items-center justify-center border',
                            step.status === 'APPROVED'
                              ? 'bg-green-50 border-green-200 text-green-600'
                              : step.status === 'REJECTED'
                              ? 'bg-red-50 border-red-200 text-red-600'
                              : step.status === 'IN_PROGRESS'
                              ? 'bg-blue-50 border-blue-200 text-blue-600'
                              : 'bg-gray-50 border-gray-200 text-gray-400'
                          )}
                        >
                          <StepIcon className="w-4 h-4" />
                        </div>
                        {!isLast && <div className="w-px flex-1 bg-gray-200 my-1" />}
                      </div>
                      <div className="flex-1 pb-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium">
                              {step.step?.name || tx('未知步骤', 'Unknown Step')}
                            </p>
                            <p className="text-xs text-gray-400">
                              {stepConfig.label} · {tx('顺序', 'Order')} {step.stepOrder}
                            </p>
                          </div>
                          <StepStatusBadge status={step.status} />
                        </div>
                        {step.assignedTo && (
                          <p className="text-xs text-gray-500 mt-1">
                            {tx('分配给', 'Assigned to')}: {step.assignedTo}
                          </p>
                        )}
                        {step.assignedRole && (
                          <p className="text-xs text-gray-500 mt-1">
                            {tx('角色', 'Role')}: {step.assignedRole}
                          </p>
                        )}
                        {step.result && (
                          <p className="text-xs text-gray-600 mt-1 bg-gray-50 p-2 rounded">
                            {step.result}
                          </p>
                        )}
                        {step.dueAt && step.status === 'IN_PROGRESS' && (
                          <p className="text-xs text-orange-500 mt-1">
                            {tx('截止', 'Due')}: {new Date(step.dueAt).toLocaleString()}
                          </p>
                        )}

                        {/* Actions for this step */}
                        {step.actions && step.actions.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {step.actions.map((action) => (
                              <div
                                key={action.id}
                                className="text-xs text-gray-500 flex items-center gap-2 bg-gray-50 p-1.5 rounded"
                              >
                                <span className="font-medium">{action.actorName || action.actorId}</span>
                                <span className="text-gray-400">·</span>
                                <span>{action.actionType}</span>
                                {action.comment && (
                                  <>
                                    <span className="text-gray-400">·</span>
                                    <span>{action.comment}</span>
                                  </>
                                )}
                                <span className="text-gray-400 ml-auto">
                                  {new Date(action.createdAt).toLocaleString()}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Global actions */}
            {instance.actions && instance.actions.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">{tx('操作记录', 'Action Log')}</h4>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {instance.actions.map((action) => (
                      <div
                        key={action.id}
                        className="text-xs text-gray-500 flex items-center gap-2 p-1.5 rounded hover:bg-gray-50"
                      >
                        <span className="font-medium">{action.actorName || action.actorId}</span>
                        <span className="text-gray-400">·</span>
                        <Badge variant="outline" className="text-xs">
                          {action.actionType}
                        </Badge>
                        {action.comment && <span>{action.comment}</span>}
                        <span className="text-gray-400 ml-auto">
                          {new Date(action.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ==================== Action Dialog ====================

function ActionDialog({
  task,
  actionType,
  isOpen,
  onClose,
  onSuccess,
}: {
  task: WorkflowInstanceStep | null;
  actionType: 'approve' | 'reject' | 'transfer' | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { act, loading } = useWorkflowAction();

  const [comment, setComment] = useState('');
  const [targetUserId, setTargetUserId] = useState('');
  const [targetRole, setTargetRole] = useState('');

  useEffect(() => {
    if (isOpen) {
      setComment('');
      setTargetUserId('');
      setTargetRole('');
    }
  }, [isOpen]);

  const handleSubmit = async () => {
    if (!task) return;
    const instanceId = task.instanceId;

    try {
      if (actionType === 'approve') {
        await act(instanceId, 'approve', { comment });
        toast.success(tx('已批准', 'Approved'));
      } else if (actionType === 'reject') {
        await act(instanceId, 'reject', { comment });
        toast.success(tx('已驳回', 'Rejected'));
      } else if (actionType === 'transfer') {
        if (!targetUserId && !targetRole) {
          toast.error(tx('请指定转交目标', 'Please specify transfer target'));
          return;
        }
        await act(instanceId, 'transfer', { comment, targetUserId, targetRole });
        toast.success(tx('已转交', 'Transferred'));
      }
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : tx('操作失败', 'Action failed');
      toast.error(message);
    }
  };

  const titleMap = {
    approve: tx('批准', 'Approve'),
    reject: tx('驳回', 'Reject'),
    transfer: tx('转交', 'Transfer'),
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {actionType ? titleMap[actionType] : ''} · {task?.step?.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {actionType === 'transfer' && (
            <>
              <div className="space-y-1">
                <Label>{tx('目标用户ID', 'Target User ID')}</Label>
                <Input
                  value={targetUserId}
                  onChange={(e) => setTargetUserId(e.target.value)}
                  placeholder={tx('可选', 'Optional')}
                />
              </div>
              <div className="space-y-1">
                <Label>{tx('目标角色', 'Target Role')}</Label>
                <Select value={targetRole} onValueChange={setTargetRole}>
                  <SelectTrigger>
                    <SelectValue placeholder={tx('选择角色', 'Select role')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sales">销售</SelectItem>
                    <SelectItem value="manager">经理</SelectItem>
                    <SelectItem value="finance">财务</SelectItem>
                    <SelectItem value="quality">质量</SelectItem>
                    <SelectItem value="admin">管理员</SelectItem>
                    <SelectItem value="gm">总经理</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          <div className="space-y-1">
            <Label>{tx('备注', 'Comment')}</Label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={tx('可选备注', 'Optional comment')}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button
            className={cn(
              actionType === 'approve' && 'bg-green-500 hover:bg-green-600',
              actionType === 'reject' && 'bg-red-500 hover:bg-red-600',
              actionType === 'transfer' && 'bg-[#64b5f6] hover:bg-[#42a5f5]'
            )}
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            {actionType ? titleMap[actionType] : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ==================== Main Page ====================

export default function Workflows() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  const [activeTab, setActiveTab] = useState('definitions');

  // Definitions state
  const [defFilter, setDefFilter] = useState({ entityType: '', isActive: '' });
  const [defSearch, setDefSearch] = useState('');
  const [defDialogOpen, setDefDialogOpen] = useState(false);
  const [editingDefinition, setEditingDefinition] = useState<WorkflowDefinition | null>(null);

  const {
    data: definitionsData,
    loading: definitionsLoading,
    refetch: refetchDefinitions,
  } = useWorkflowDefinitions({
    entityType: defFilter.entityType || undefined,
    isActive: defFilter.isActive === '' ? undefined : defFilter.isActive === 'true',
  });

  const { duplicate, loading: duplicateLoading } = useDuplicateWorkflowDefinition();
  const { deleteDefinition, loading: deleteLoading } = useDeleteWorkflowDefinition();

  // Instances state
  const [instFilter, setInstFilter] = useState({ entityType: '', entityId: '', status: '' });
  const [instPage, setInstPage] = useState(1);
  const [instanceDetailId, setInstanceDetailId] = useState<string | null>(null);
  const [instanceDetailOpen, setInstanceDetailOpen] = useState(false);

  const { data: instancesData, loading: instancesLoading } = useWorkflowInstances({
    entityType: instFilter.entityType || undefined,
    entityId: instFilter.entityId || undefined,
    status: instFilter.status || undefined,
    page: instPage,
    limit: 20,
  });

  // Tasks state
  const { data: pendingTasks, loading: tasksLoading, refetch: refetchTasks } = useWorkflowPendingTasks();
  const [actionDialogOpen, setActionDialogOpen] = useState(false);
  const [actionTask, setActionTask] = useState<WorkflowInstanceStep | null>(null);
  const [actionType, setActionType] = useState<'approve' | 'reject' | 'transfer' | null>(null);

  const filteredDefinitions = (definitionsData || []).filter((d) => {
    if (!defSearch) return true;
    const s = defSearch.toLowerCase();
    return d.name.toLowerCase().includes(s) || d.code.toLowerCase().includes(s) || d.entityType.toLowerCase().includes(s);
  });

  const handleDuplicate = async (id: string) => {
    try {
      await duplicate(id);
      toast.success(tx('复制成功', 'Duplicated successfully'));
      refetchDefinitions();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '复制失败';
      toast.error(message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(tx('确定删除此工作流定义？', 'Are you sure you want to delete this workflow definition?'))) return;
    try {
      await deleteDefinition(id);
      toast.success(tx('删除成功', 'Deleted successfully'));
      refetchDefinitions();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '删除失败';
      toast.error(message);
    }
  };

  const openActionDialog = (task: WorkflowInstanceStep, type: 'approve' | 'reject' | 'transfer') => {
    setActionTask(task);
    setActionType(type);
    setActionDialogOpen(true);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{tx('工作流引擎', 'Workflow Engine')}</h1>
          <p className="text-sm text-gray-500">{tx('管理工作流定义、实例和审批任务', 'Manage workflow definitions, instances, and approval tasks')}</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          <TabsTrigger value="definitions" className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            {tx('定义', 'Definitions')}
          </TabsTrigger>
          <TabsTrigger value="instances" className="flex items-center gap-2">
            <GitBranch className="w-4 h-4" />
            {tx('实例', 'Instances')}
          </TabsTrigger>
          <TabsTrigger value="tasks" className="flex items-center gap-2">
            <Inbox className="w-4 h-4" />
            {tx('我的任务', 'My Tasks')}
            {pendingTasks && pendingTasks.length > 0 && (
              <Badge variant="destructive" className="ml-1 text-xs">
                {pendingTasks.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ==================== Definitions Tab ==================== */}
        <TabsContent value="definitions" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-col md:flex-row gap-3 items-start md:items-center justify-between">
                <div className="flex gap-2 flex-1">
                  <div className="relative flex-1 max-w-xs">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
                    <Input
                      placeholder={tx('搜索名称或编码...', 'Search name or code...')}
                      className="pl-9"
                      value={defSearch}
                      onChange={(e) => setDefSearch(e.target.value)}
                    />
                  </div>
                  <Select value={defFilter.entityType} onValueChange={(v) => setDefFilter({ ...defFilter, entityType: v })}>
                    <SelectTrigger className="w-[140px]">
                      <SelectValue placeholder={tx('实体类型', 'Entity Type')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{tx('全部', 'All')}</SelectItem>
                      {entityTypeOptions.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={defFilter.isActive} onValueChange={(v) => setDefFilter({ ...defFilter, isActive: v })}>
                    <SelectTrigger className="w-[120px]">
                      <SelectValue placeholder={tx('状态', 'Status')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{tx('全部', 'All')}</SelectItem>
                      <SelectItem value="true">{tx('启用', 'Active')}</SelectItem>
                      <SelectItem value="false">{tx('禁用', 'Inactive')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  className="bg-[#64b5f6] hover:bg-[#42a5f5]"
                  onClick={() => {
                    setEditingDefinition(null);
                    setDefDialogOpen(true);
                  }}
                >
                  <Plus className="w-4 h-4 mr-1" />
                  {tx('新建定义', 'New Definition')}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('编码', 'Code')}</TableHead>
                    <TableHead>{tx('名称', 'Name')}</TableHead>
                    <TableHead>{tx('实体类型', 'Entity Type')}</TableHead>
                    <TableHead>{tx('步骤数', 'Steps')}</TableHead>
                    <TableHead>{tx('实例数', 'Instances')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead className="text-right">{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {definitionsLoading && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin mx-auto text-[#64b5f6]" />
                      </TableCell>
                    </TableRow>
                  )}
                  {!definitionsLoading && filteredDefinitions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-gray-400">
                        {tx('暂无工作流定义', 'No workflow definitions')}
                      </TableCell>
                    </TableRow>
                  )}
                  {filteredDefinitions.map((def) => (
                    <TableRow key={def.id}>
                      <TableCell className="font-mono text-xs">{def.code}</TableCell>
                      <TableCell>
                        <div className="font-medium">{def.name}</div>
                        {def.description && (
                          <div className="text-xs text-gray-400">{def.description}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{def.entityType}</Badge>
                      </TableCell>
                      <TableCell>{def.steps?.length || 0}</TableCell>
                      <TableCell>{(def as any).instanceCount ?? 0}</TableCell>
                      <TableCell>
                        <Badge variant={def.isActive ? 'default' : 'secondary'}>
                          {def.isActive ? tx('启用', 'Active') : tx('禁用', 'Inactive')}
                        </Badge>
                        {def.isDefault && (
                          <Badge variant="outline" className="ml-1 text-xs">
                            {tx('默认', 'Default')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setEditingDefinition(def);
                              setDefDialogOpen(true);
                            }}
                          >
                            <Edit3 className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDuplicate(def.id)}
                            disabled={duplicateLoading}
                          >
                            <Copy className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-red-500 hover:text-red-600"
                            onClick={() => handleDelete(def.id)}
                            disabled={deleteLoading}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ==================== Instances Tab ==================== */}
        <TabsContent value="instances" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-col md:flex-row gap-3 items-start md:items-center justify-between">
                <div className="flex gap-2 flex-1 flex-wrap">
                  <Select
                    value={instFilter.entityType}
                    onValueChange={(v) => setInstFilter({ ...instFilter, entityType: v })}
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue placeholder={tx('实体类型', 'Entity Type')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{tx('全部', 'All')}</SelectItem>
                      {entityTypeOptions.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder={tx('实体ID', 'Entity ID')}
                    className="w-[180px]"
                    value={instFilter.entityId}
                    onChange={(e) => setInstFilter({ ...instFilter, entityId: e.target.value })}
                  />
                  <Select
                    value={instFilter.status}
                    onValueChange={(v) => setInstFilter({ ...instFilter, status: v })}
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue placeholder={tx('状态', 'Status')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{tx('全部', 'All')}</SelectItem>
                      <SelectItem value="RUNNING">{tx('进行中', 'Running')}</SelectItem>
                      <SelectItem value="COMPLETED">{tx('已完成', 'Completed')}</SelectItem>
                      <SelectItem value="REJECTED">{tx('已驳回', 'Rejected')}</SelectItem>
                      <SelectItem value="CANCELLED">{tx('已取消', 'Cancelled')}</SelectItem>
                      <SelectItem value="TIMEOUT">{tx('已超时', 'Timeout')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('编号', 'Number')}</TableHead>
                    <TableHead>{tx('定义', 'Definition')}</TableHead>
                    <TableHead>{tx('实体', 'Entity')}</TableHead>
                    <TableHead>{tx('当前步骤', 'Current Step')}</TableHead>
                    <TableHead>{tx('状态', 'Status')}</TableHead>
                    <TableHead>{tx('启动时间', 'Started')}</TableHead>
                    <TableHead className="text-right">{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {instancesLoading && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin mx-auto text-[#64b5f6]" />
                      </TableCell>
                    </TableRow>
                  )}
                  {!instancesLoading && (!instancesData?.data || instancesData.data.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-gray-400">
                        {tx('暂无工作流实例', 'No workflow instances')}
                      </TableCell>
                    </TableRow>
                  )}
                  {instancesData?.data.map((inst) => {
                    const currentStep = inst.steps?.find((s) => s.status === 'IN_PROGRESS');
                    const context = (() => {
                      try {
                        return JSON.parse(inst.context || '{}');
                      } catch {
                        return {};
                      }
                    })();

                    return (
                      <TableRow key={inst.id}>
                        <TableCell className="font-mono text-xs">
                          {context.instanceNumber || inst.id.slice(0, 8)}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">{inst.definition?.name}</div>
                          <div className="text-xs text-gray-400">{inst.definition?.code}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{inst.entityType}</Badge>
                          <div className="text-xs text-gray-400 mt-0.5">{inst.entityId}</div>
                        </TableCell>
                        <TableCell>
                          {currentStep ? (
                            <div className="text-sm">{currentStep.step?.name}</div>
                          ) : (
                            <span className="text-xs text-gray-400">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={inst.status} />
                        </TableCell>
                        <TableCell className="text-xs text-gray-500">
                          {new Date(inst.startedAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setInstanceDetailId(inst.id);
                              setInstanceDetailOpen(true);
                            }}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {instancesData && instancesData.pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={instPage <= 1}
                onClick={() => setInstPage(instPage - 1)}
              >
                {tx('上一页', 'Previous')}
              </Button>
              <span className="text-sm text-gray-500">
                {instPage} / {instancesData.pagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={instPage >= instancesData.pagination.totalPages}
                onClick={() => setInstPage(instPage + 1)}
              >
                {tx('下一页', 'Next')}
              </Button>
            </div>
          )}
        </TabsContent>

        {/* ==================== My Tasks Tab ==================== */}
        <TabsContent value="tasks" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Inbox className="w-4 h-4" />
                {tx('待处理审批', 'Pending Approvals')}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tx('工作流', 'Workflow')}</TableHead>
                    <TableHead>{tx('步骤', 'Step')}</TableHead>
                    <TableHead>{tx('实体', 'Entity')}</TableHead>
                    <TableHead>{tx('截止时间', 'Due')}</TableHead>
                    <TableHead className="text-right">{tx('操作', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasksLoading && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin mx-auto text-[#64b5f6]" />
                      </TableCell>
                    </TableRow>
                  )}
                  {!tasksLoading && (!pendingTasks || pendingTasks.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-8 text-gray-400">
                        {tx('暂无待处理任务', 'No pending tasks')}
                      </TableCell>
                    </TableRow>
                  )}
                  {pendingTasks?.map((task) => (
                    <TableRow key={task.id}>
                      <TableCell>
                        <div className="text-sm font-medium">{task.instance?.definition?.name}</div>
                        <div className="text-xs text-gray-400">{task.instance?.definition?.code}</div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{task.step?.name}</div>
                        <div className="text-xs text-gray-400">
                          {tx('顺序', 'Order')} {task.stepOrder}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{task.instance?.entityType}</Badge>
                        <div className="text-xs text-gray-400 mt-0.5">{task.instance?.entityId}</div>
                      </TableCell>
                      <TableCell>
                        {task.dueAt ? (
                          <div className="flex items-center gap-1 text-sm">
                            <Clock className="w-3 h-3 text-orange-500" />
                            <span className={cn(new Date(task.dueAt) < new Date() && 'text-red-500')}>
                              {new Date(task.dueAt).toLocaleString()}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            className="bg-green-500 hover:bg-green-600 h-8"
                            onClick={() => openActionDialog(task, 'approve')}
                          >
                            <CheckCircle className="w-3 h-3 mr-1" />
                            {tx('批准', 'Approve')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-500 border-red-200 hover:bg-red-50 h-8"
                            onClick={() => openActionDialog(task, 'reject')}
                          >
                            <XCircle className="w-3 h-3 mr-1" />
                            {tx('驳回', 'Reject')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8"
                            onClick={() => openActionDialog(task, 'transfer')}
                          >
                            <Send className="w-3 h-3 mr-1" />
                            {tx('转交', 'Transfer')}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <DefinitionDialog
        definition={editingDefinition}
        isOpen={defDialogOpen}
        onClose={() => setDefDialogOpen(false)}
        onSuccess={refetchDefinitions}
      />

      <InstanceDetailDialog
        instanceId={instanceDetailId}
        isOpen={instanceDetailOpen}
        onClose={() => setInstanceDetailOpen(false)}
      />

      <ActionDialog
        task={actionTask}
        actionType={actionType}
        isOpen={actionDialogOpen}
        onClose={() => setActionDialogOpen(false)}
        onSuccess={() => {
          refetchTasks();
          if (activeTab === 'instances') {
            // instances don't auto-refetch in this hook pattern, but we can switch tabs to refresh
          }
        }}
      />
    </div>
  );
}
