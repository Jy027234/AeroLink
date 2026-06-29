import { useState } from 'react';
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
import {
  BadgeCheck,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Edit3,
  Loader2,
  Plus,
  Trash2,
  Users,
  Shield,
  Bell,
  Zap,
  GripVertical,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from '@/i18n';
import {
  useWorkflowDefinitions,
  useSaveWorkflowDefinition,
  useDeleteWorkflowDefinition,
  useAgents,
} from '@/hooks/useApi';
import { toast } from 'sonner';
import type { WorkflowDefinition, WorkflowStep } from '@/types';

// 步骤类型配置
type StepTypeConfig = {
  value: WorkflowStep['stepType'];
  labelZh: string;
  labelEn: string;
  icon: React.ReactNode;
};

const stepTypeOptions: StepTypeConfig[] = [
  { value: 'APPROVAL', labelZh: '人工审批', labelEn: 'Manual Approval', icon: <Shield className="w-4 h-4" /> },
  { value: 'AUTOMATION', labelZh: 'AI Agent', labelEn: 'AI Agent', icon: <Bot className="w-4 h-4" /> },
  { value: 'NOTIFICATION', labelZh: '通知', labelEn: 'Notification', icon: <Bell className="w-4 h-4" /> },
  { value: 'CONDITION', labelZh: '条件判断', labelEn: 'Condition', icon: <Zap className="w-4 h-4" /> },
];

// 审批角色选项
const approverRoleOptions = [
  { value: 'gm', labelZh: '总经理', labelEn: 'General Manager' },
  { value: 'manager', labelZh: '销售经理', labelEn: 'Sales Manager' },
  { value: 'finance', labelZh: '财务', labelEn: 'Finance' },
  { value: 'sales', labelZh: '销售', labelEn: 'Sales' },
  { value: 'admin', labelZh: '管理员', labelEn: 'Admin' },
];

// 超时动作选项
const timeoutActionOptions = [
  { value: 'ESCALATE', labelZh: '升级上级', labelEn: 'Escalate' },
  { value: 'AUTO_APPROVE', labelZh: '自动通过', labelEn: 'Auto Approve' },
  { value: 'AUTO_REJECT', labelZh: '自动拒绝', labelEn: 'Auto Reject' },
];

// 审批人方式
const approverModeOptions = [
  { value: 'role', labelZh: '按角色', labelEn: 'By Role' },
  { value: 'user', labelZh: '指定用户', labelEn: 'By User' },
  { value: 'department', labelZh: '按部门', labelEn: 'By Department' },
  { value: 'agent', labelZh: 'AI Agent', labelEn: 'AI Agent' },
];

function getStepTypeConfig(type: string) {
  return stepTypeOptions.find((o) => o.value === type) || stepTypeOptions[0];
}

function getApproverMode(step: WorkflowStep): string {
  if (step.agentId) return 'agent';
  if (step.approverUserId) return 'user';
  if (step.approverDepartment) return 'department';
  return 'role';
}

function getApproverLabel(step: WorkflowStep, locale: string): string {
  if (step.agentId) return `Agent: ${step.agentId.slice(0, 8)}...`;
  if (step.approverUserId) return `User: ${step.approverUserId.slice(0, 8)}...`;
  if (step.approverDepartment) return `Dept: ${step.approverDepartment}`;
  const role = approverRoleOptions.find((r) => r.value === step.approverRole);
  if (role) return locale === 'zh-CN' ? role.labelZh : role.labelEn;
  return step.approverRole || '-';
}

export function ApprovalWorkflowSettings() {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const { data: workflows, loading, refetch } = useWorkflowDefinitions();
  const { data: agents } = useAgents();
  const saveWorkflow = useSaveWorkflowDefinition();
  const { deleteDefinition, loading: deleteLoading } = useDeleteWorkflowDefinition();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<WorkflowDefinition | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  // 基础表单
  const [baseForm, setBaseForm] = useState({
    name: '',
    code: '',
    description: '',
    entityType: 'QUOTATION',
    isActive: true,
  });

  // 步骤列表
  const [steps, setSteps] = useState<WorkflowStep[]>([]);

  const resetForm = () => {
    setBaseForm({
      name: '',
      code: '',
      description: '',
      entityType: 'QUOTATION',
      isActive: true,
    });
    setSteps([]);
  };

  const handleOpenCreate = () => {
    setEditingWorkflow(null);
    resetForm();
    setIsFormOpen(true);
  };

  const handleOpenEdit = (workflow: WorkflowDefinition) => {
    setEditingWorkflow(workflow);
    setBaseForm({
      name: workflow.name,
      code: workflow.code,
      description: workflow.description || '',
      entityType: workflow.entityType,
      isActive: workflow.isActive,
    });
    setSteps(
      (workflow.steps || []).map((s) => ({
        ...s,
        // 确保编辑时有完整字段
        approverRole: s.approverRole || undefined,
        approverUserId: s.approverUserId || undefined,
        approverDepartment: s.approverDepartment || undefined,
        agentId: s.agentId || undefined,
      }))
    );
    setIsFormOpen(true);
  };

  const handleAddStep = () => {
    const newStep: WorkflowStep = {
      id: `temp-${Date.now()}`,
      workflowId: editingWorkflow?.id || '',
      name: tx(`步骤 ${steps.length + 1}`, `Step ${steps.length + 1}`),
      stepOrder: steps.length + 1,
      stepType: 'APPROVAL',
      approverRole: 'manager',
      isParallel: false,
      timeoutHours: 24,
      timeoutAction: 'ESCALATE',
      createdAt: new Date().toISOString(),
    };
    setSteps([...steps, newStep]);
  };

  const handleRemoveStep = (index: number) => {
    const next = steps.filter((_, i) => i !== index);
    // 重新排序
    next.forEach((s, i) => (s.stepOrder = i + 1));
    setSteps(next);
  };

  const handleUpdateStep = (index: number, patch: Partial<WorkflowStep>) => {
    const next = [...steps];
    next[index] = { ...next[index], ...patch };
    setSteps(next);
  };

  const handleChangeApproverMode = (index: number, mode: string) => {
    const next = [...steps];
    const step = { ...next[index] };
    // 清除所有审批人字段
    step.approverRole = undefined;
    step.approverUserId = undefined;
    step.approverDepartment = undefined;
    step.agentId = undefined;

    // 根据模式设置默认值
    if (mode === 'role') step.approverRole = 'manager';
    if (mode === 'user') step.approverUserId = '';
    if (mode === 'department') step.approverDepartment = '';
    if (mode === 'agent') step.agentId = agents?.[0]?.id || '';

    next[index] = step;
    setSteps(next);
  };

  const handleSubmit = async () => {
    if (!baseForm.name || !baseForm.code) {
      toast.warning(tx('请填写名称和编码', 'Please fill in name and code'));
      return;
    }
    if (steps.length === 0) {
      toast.warning(tx('请至少添加一个审批步骤', 'Please add at least one approval step'));
      return;
    }

    // 构建提交数据
    const payload = {
      ...baseForm,
      steps: steps.map((s, i) => ({
        id: s.id.startsWith('temp-') ? undefined : s.id,
        name: s.name,
        stepOrder: i + 1,
        stepType: s.stepType,
        approverRole: s.approverRole || null,
        approverUserId: s.approverUserId || null,
        approverDepartment: s.approverDepartment || null,
        agentId: s.agentId || null,
        isParallel: s.isParallel,
        parallelMinCount: s.parallelMinCount || null,
        timeoutHours: s.timeoutHours,
        timeoutAction: s.timeoutAction,
        conditionExpression: s.conditionExpression || null,
        autoAction: s.autoAction || null,
        notificationTemplate: s.notificationTemplate || null,
      })),
    };

    try {
      await saveWorkflow.mutate({
        id: editingWorkflow?.id,
        data: payload,
      });
      toast.success(
        tx(editingWorkflow ? '流程已更新' : '流程已创建', editingWorkflow ? 'Workflow updated' : 'Workflow created')
      );
      setIsFormOpen(false);
      resetForm();
      await refetch();
    } catch (_error) {
      toast.error(tx('保存失败', 'Save failed'));
    }
  };

  const handleToggleStatus = async (workflow: WorkflowDefinition) => {
    try {
      await saveWorkflow.mutate({
        id: workflow.id,
        data: { isActive: !workflow.isActive },
      });
      toast.success(tx('状态已更新', 'Status updated'));
      await refetch();
    } catch (_error) {
      toast.error(tx('更新失败', 'Update failed'));
    }
  };

  const handleDelete = async (id: string) => {
    setDeleteTargetId(id);
  };

  const confirmDelete = async () => {
    if (!deleteTargetId) return;
    try {
      await deleteDefinition(deleteTargetId);
      toast.success(tx('已删除', 'Deleted'));
      await refetch();
    } catch (_error) {
      toast.error(tx('删除失败', 'Delete failed'));
    } finally {
      setDeleteTargetId(null);
    }
  };

  const workflowList = workflows || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{tx('审批流程配置', 'Approval Workflow Configuration')}</h3>
          <p className="text-sm text-gray-500">{tx('管理报价与订单审批流程', 'Manage approval flows for quotes and orders')}</p>
        </div>
        <Button className="bg-brand-primary hover:bg-brand-primary-hover" onClick={handleOpenCreate}>
          <Plus className="w-4 h-4 mr-1" />
          {tx('新建流程', 'New Workflow')}
        </Button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8 text-gray-500">
          <Loader2 className="w-6 h-6 animate-spin mr-2" />
          {tx('加载中...', 'Loading...')}
        </div>
      )}

      <div className="grid gap-4">
        {workflowList.map((workflow) => {
          const sortedSteps = (workflow.steps || []).sort((a, b) => a.stepOrder - b.stepOrder);
          return (
            <Card key={workflow.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setExpandedId(expandedId === workflow.id ? null : workflow.id)}
                    >
                      {expandedId === workflow.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </Button>
                    <div>
                      <CardTitle className="text-base">{workflow.name}</CardTitle>
                      <CardDescription>
                        {workflow.description || workflow.code}
                        <Badge variant="outline" className="ml-2 text-xs">{workflow.entityType}</Badge>
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={workflow.isActive} onCheckedChange={() => handleToggleStatus(workflow)} />
                    <Badge variant={workflow.isActive ? 'default' : 'secondary'}>
                      {workflow.isActive ? tx('启用', 'Enabled') : tx('禁用', 'Disabled')}
                    </Badge>
                    <Button variant="ghost" size="icon" onClick={() => handleOpenEdit(workflow)}>
                      <Edit3 className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(workflow.id)} disabled={deleteLoading}>
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              </CardHeader>

              {expandedId === workflow.id && (
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-gray-500">
                      <BadgeCheck className="w-4 h-4" />
                      {tx('审批步骤', 'Approval Steps')}
                      <span className="text-xs text-gray-400">({sortedSteps.length})</span>
                    </div>
                    {sortedSteps.length === 0 ? (
                      <p className="text-sm text-gray-400">{tx('暂无审批步骤', 'No approval steps')}</p>
                    ) : (
                      <div className="space-y-2">
                        {sortedSteps.map((step, index) => {
                          const typeConfig = getStepTypeConfig(step.stepType);
                          return (
                            <div key={step.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                              <div className="flex items-center justify-center w-7 h-7 bg-blue-100 text-blue-600 rounded-full text-xs font-bold">
                                {index + 1}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-gray-400">{typeConfig.icon}</span>
                                  <span className="font-medium">{step.name}</span>
                                  <Badge variant="outline" className="text-[10px]">
                                    {locale === 'zh-CN' ? typeConfig.labelZh : typeConfig.labelEn}
                                  </Badge>
                                </div>
                                <p className="text-sm text-gray-500 mt-0.5">
                                  {step.stepType === 'APPROVAL' || step.stepType === 'AUTOMATION' ? (
                                    <>
                                      {tx('审批人', 'Approver')}: {getApproverLabel(step, locale)}
                                      {step.isParallel && (
                                        <span className="ml-2 text-blue-600">
                                          ({tx('并行', 'Parallel')} {step.parallelMinCount || 1}/{tx('通过', 'pass')})
                                        </span>
                                      )}
                                    </>
                                  ) : step.stepType === 'CONDITION' ? (
                                    <>{tx('条件', 'Condition')}: {step.conditionExpression || '-'}</>
                                  ) : (
                                    <>{tx('通知模板', 'Template')}: {step.notificationTemplate || '-'}</>
                                  )}
                                  <span className="ml-2 text-gray-400">
                                    <Clock className="w-3 h-3 inline mr-0.5" />
                                    {step.timeoutHours}h
                                  </span>
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })}

        {!loading && workflowList.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <p>{tx('暂无审批流程', 'No workflows yet')}</p>
            <p className="text-sm text-gray-400 mt-1">{tx('点击右上角新建流程', 'Click New Workflow to create one')}</p>
          </div>
        )}
      </div>

      {/* Form Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingWorkflow ? tx('编辑流程', 'Edit Workflow') : tx('新建流程', 'New Workflow')}
            </DialogTitle>
            <DialogDescription className="sr-only">{tx('配置审批工作流', 'Configure approval workflow')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* 基础信息 */}
            <div className="space-y-4">
              <h4 className="text-sm font-medium text-gray-500">{tx('基础信息', 'Basic Info')}</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{tx('名称', 'Name')} *</Label>
                  <Input
                    value={baseForm.name}
                    onChange={(e) => setBaseForm({ ...baseForm, name: e.target.value })}
                    placeholder={tx('例如：报价审批流程', 'e.g. Quotation Approval')}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{tx('编码', 'Code')} *</Label>
                  <Input
                    value={baseForm.code}
                    onChange={(e) => setBaseForm({ ...baseForm, code: e.target.value })}
                    placeholder={tx('例如：QUOTE_APPROVAL', 'e.g. QUOTE_APPROVAL')}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{tx('适用对象', 'Entity Type')}</Label>
                  <Select
                    value={baseForm.entityType}
                    onValueChange={(value) => setBaseForm({ ...baseForm, entityType: value })}
                  >
                    <SelectTrigger className="w-full h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="QUOTATION">{tx('报价单', 'Quotation')}</SelectItem>
                      <SelectItem value="ORDER">{tx('订单', 'Order')}</SelectItem>
                      <SelectItem value="RFQ">{tx('需求单', 'RFQ')}</SelectItem>
                      <SelectItem value="CERTIFICATE">{tx('证书', 'Certificate')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{tx('描述', 'Description')}</Label>
                  <Input
                    value={baseForm.description}
                    onChange={(e) => setBaseForm({ ...baseForm, description: e.target.value })}
                    placeholder={tx('流程说明...', 'Workflow description...')}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={baseForm.isActive} onCheckedChange={(v) => setBaseForm({ ...baseForm, isActive: v })} />
                <Label className="cursor-pointer">{tx('启用', 'Enabled')}</Label>
              </div>
            </div>

            {/* 审批步骤 */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-gray-500">
                  {tx('审批步骤', 'Approval Steps')}
                  <span className="text-xs text-gray-400 ml-1">({steps.length})</span>
                </h4>
                <Button variant="outline" size="sm" onClick={handleAddStep}>
                  <Plus className="w-4 h-4 mr-1" />
                  {tx('添加步骤', 'Add Step')}
                </Button>
              </div>

              {steps.length === 0 && (
                <div className="text-center py-6 border border-dashed rounded-lg text-gray-400">
                  <Users className="w-8 h-8 mx-auto mb-2" />
                  <p className="text-sm">{tx('暂无步骤，点击上方添加', 'No steps yet, click Add Step above')}</p>
                </div>
              )}

              <div className="space-y-3">
                {steps.map((step, index) => {
                  const mode = getApproverMode(step);
                  return (
                    <div key={step.id} className="border rounded-lg p-4 space-y-3">
                      {/* 步骤头部 */}
                      <div className="flex items-center gap-3">
                        <GripVertical className="w-4 h-4 text-gray-300" />
                        <div className="flex items-center justify-center w-7 h-7 bg-blue-100 text-blue-600 rounded-full text-xs font-bold">
                          {index + 1}
                        </div>
                        <div className="flex-1">
                          <Input
                            value={step.name}
                            onChange={(e) => handleUpdateStep(index, { name: e.target.value })}
                            className="h-8 text-sm font-medium"
                            placeholder={tx('步骤名称', 'Step name')}
                          />
                        </div>
                        <Select
                          value={step.stepType}
                          onValueChange={(value) => handleUpdateStep(index, { stepType: value as WorkflowStep['stepType'] })}
                        >
                          <SelectTrigger className="h-8 text-sm w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {stepTypeOptions.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {locale === 'zh-CN' ? o.labelZh : o.labelEn}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleRemoveStep(index)}>
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>

                      {/* 步骤配置 */}
                      <div className="grid grid-cols-3 gap-3 pl-7">
                        {/* 审批人配置（仅审批和自动化类型） */}
                        {(step.stepType === 'APPROVAL' || step.stepType === 'AUTOMATION') && (
                          <>
                            <div className="space-y-1">
                              <Label className="text-xs">{tx('审批方式', 'Approver Mode')}</Label>
                              <Select
                                value={mode}
                                onValueChange={(value) => handleChangeApproverMode(index, value)}
                              >
                                <SelectTrigger className="h-8 text-sm w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {approverModeOptions.map((o) => (
                                    <SelectItem key={o.value} value={o.value}>
                                      {locale === 'zh-CN' ? o.labelZh : o.labelEn}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            {/* 根据模式显示不同输入 */}
                            {mode === 'role' && (
                              <div className="space-y-1">
                                <Label className="text-xs">{tx('审批角色', 'Role')}</Label>
                              <Select
                                value={step.approverRole || ''}
                                onValueChange={(value) => handleUpdateStep(index, { approverRole: value })}
                              >
                                <SelectTrigger className="h-8 text-sm w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {approverRoleOptions.map((o) => (
                                    <SelectItem key={o.value} value={o.value}>
                                      {locale === 'zh-CN' ? o.labelZh : o.labelEn}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              </div>
                            )}

                            {mode === 'user' && (
                              <div className="space-y-1">
                                <Label className="text-xs">{tx('用户ID', 'User ID')}</Label>
                                <Input
                                  value={step.approverUserId || ''}
                                  onChange={(e) => handleUpdateStep(index, { approverUserId: e.target.value })}
                                  className="h-8 text-sm"
                                  placeholder="uuid"
                                />
                              </div>
                            )}

                            {mode === 'department' && (
                              <div className="space-y-1">
                                <Label className="text-xs">{tx('部门', 'Department')}</Label>
                                <Input
                                  value={step.approverDepartment || ''}
                                  onChange={(e) => handleUpdateStep(index, { approverDepartment: e.target.value })}
                                  className="h-8 text-sm"
                                  placeholder={tx('销售部', 'Sales')}
                                />
                              </div>
                            )}

                            {mode === 'agent' && (
                              <div className="space-y-1">
                                <Label className="text-xs flex items-center gap-1">
                                  <Bot className="w-3 h-3" />
                                  {tx('AI Agent', 'AI Agent')}
                                </Label>
                              <Select
                                value={step.agentId || ''}
                                onValueChange={(value) => handleUpdateStep(index, { agentId: value })}
                              >
                                <SelectTrigger className="h-8 text-sm w-full">
                                  <SelectValue placeholder={tx('请选择', 'Select')} />
                                </SelectTrigger>
                                <SelectContent>
                                  {agents?.map((agent) => (
                                    <SelectItem key={agent.id} value={agent.id}>
                                      {agent.name} {agent.isActive ? '' : `(${tx('已禁用', 'Disabled')})`}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              </div>
                            )}

                            {/* 并行审批 */}
                            <div className="space-y-1">
                              <Label className="text-xs">{tx('并行审批', 'Parallel')}</Label>
                              <div className="flex items-center gap-2">
                                <Switch
                                  checked={step.isParallel}
                                  onCheckedChange={(v) => handleUpdateStep(index, { isParallel: v })}
                                />
                                {step.isParallel && (
                                  <Input
                                    type="number"
                                    min={1}
                                    value={step.parallelMinCount || 1}
                                    onChange={(e) => handleUpdateStep(index, { parallelMinCount: parseInt(e.target.value) })}
                                    className="h-8 w-16 text-sm"
                                  />
                                )}
                              </div>
                            </div>
                          </>
                        )}

                        {/* 条件表达式（仅条件类型） */}
                        {step.stepType === 'CONDITION' && (
                          <div className="space-y-1 col-span-2">
                            <Label className="text-xs">{tx('条件表达式', 'Condition')}</Label>
                            <Input
                              value={step.conditionExpression || ''}
                              onChange={(e) => handleUpdateStep(index, { conditionExpression: e.target.value })}
                              className="h-8 text-sm"
                              placeholder={tx('例如：amount > 10000', 'e.g. amount > 10000')}
                            />
                          </div>
                        )}

                        {/* 通知模板（仅通知类型） */}
                        {step.stepType === 'NOTIFICATION' && (
                          <div className="space-y-1 col-span-2">
                            <Label className="text-xs">{tx('通知模板', 'Template')}</Label>
                            <Input
                              value={step.notificationTemplate || ''}
                              onChange={(e) => handleUpdateStep(index, { notificationTemplate: e.target.value })}
                              className="h-8 text-sm"
                              placeholder={tx('模板编码', 'Template code')}
                            />
                          </div>
                        )}

                        {/* 超时设置 */}
                        <div className="space-y-1">
                          <Label className="text-xs flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {tx('超时(小时)', 'Timeout(h)')}
                          </Label>
                          <Input
                            type="number"
                            min={1}
                            value={step.timeoutHours}
                            onChange={(e) => handleUpdateStep(index, { timeoutHours: parseInt(e.target.value) || 24 })}
                            className="h-8 text-sm"
                          />
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs">{tx('超时动作', 'Timeout Action')}</Label>
                        <Select
                          value={step.timeoutAction}
                          onValueChange={(value) => handleUpdateStep(index, { timeoutAction: value })}
                        >
                          <SelectTrigger className="h-8 text-sm w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {timeoutActionOptions.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {locale === 'zh-CN' ? o.labelZh : o.labelEn}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>
              {tx('取消', 'Cancel')}
            </Button>
            <Button onClick={handleSubmit} disabled={saveWorkflow.loading}>
              {saveWorkflow.loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {tx('保存', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTargetId} onOpenChange={(open) => { if (!open) setDeleteTargetId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tx('确认删除', 'Confirm Delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tx('确定要删除此审批流程吗？此操作不可撤销。', 'Are you sure you want to delete this workflow? This action cannot be undone.')}
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
