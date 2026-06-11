import { useState, useCallback } from 'react';
import {
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  GripVertical,
  Clock,
  UserCog,
  Bell,
  GitBranch,
  Zap,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { WorkflowStep, WorkflowStepType } from '@/types';

const stepTypeConfig: Record<WorkflowStepType, { label: string; icon: React.ElementType; color: string }> = {
  APPROVAL: { label: '审批', icon: UserCog, color: 'text-blue-600 bg-blue-50' },
  NOTIFICATION: { label: '通知', icon: Bell, color: 'text-green-600 bg-green-50' },
  CONDITION: { label: '条件', icon: GitBranch, color: 'text-purple-600 bg-purple-50' },
  AUTOMATION: { label: '自动化', icon: Zap, color: 'text-orange-600 bg-orange-50' },
};

const roleOptions = [
  { value: 'sales', label: '销售' },
  { value: 'manager', label: '经理' },
  { value: 'finance', label: '财务' },
  { value: 'quality', label: '质量' },
  { value: 'admin', label: '管理员' },
  { value: 'gm', label: '总经理' },
];

const timeoutActionOptions = [
  { value: 'ESCALATE', label: '升级' },
  { value: 'AUTO_APPROVE', label: '自动批准' },
  { value: 'AUTO_REJECT', label: '自动驳回' },
];

interface WorkflowBuilderProps {
  steps: Omit<WorkflowStep, 'id' | 'workflowId' | 'createdAt'>[];
  onChange: (steps: Omit<WorkflowStep, 'id' | 'workflowId' | 'createdAt'>[]) => void;
}

export function WorkflowBuilder({ steps, onChange }: WorkflowBuilderProps) {
  const { locale } = useTranslation();
  const tx = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);

  const addStep = useCallback(() => {
    const newStep: Omit<WorkflowStep, 'id' | 'workflowId' | 'createdAt'> = {
      name: tx('新步骤', 'New Step'),
      stepOrder: steps.length + 1,
      stepType: 'APPROVAL',
      approverRole: 'manager',
      approverUserId: '',
      approverDepartment: '',
      isParallel: false,
      parallelMinCount: undefined,
      timeoutHours: 24,
      timeoutAction: 'ESCALATE',
      conditionExpression: '',
      autoAction: '',
      notificationTemplate: '',
    };
    onChange([...steps, newStep]);
    setExpandedIndex(steps.length);
  }, [steps, onChange, tx]);

  const removeStep = useCallback(
    (index: number) => {
      const newSteps = steps.filter((_, i) => i !== index);
      newSteps.forEach((s, i) => (s.stepOrder = i + 1));
      onChange(newSteps);
      if (expandedIndex === index) setExpandedIndex(null);
    },
    [steps, onChange, expandedIndex]
  );

  const moveStep = useCallback(
    (index: number, direction: -1 | 1) => {
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= steps.length) return;
      const newSteps = [...steps];
      const temp = newSteps[index];
      newSteps[index] = newSteps[newIndex];
      newSteps[newIndex] = temp;
      newSteps.forEach((s, i) => (s.stepOrder = i + 1));
      onChange(newSteps);
      setExpandedIndex(newIndex);
    },
    [steps, onChange]
  );

  const updateStep = useCallback(
    (index: number, updates: Partial<WorkflowStep>) => {
      const newSteps = steps.map((s, i) => (i === index ? { ...s, ...updates } : s));
      onChange(newSteps);
    },
    [steps, onChange]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{tx('流程步骤', 'Workflow Steps')}</Label>
        <Button type="button" size="sm" className="bg-brand-primary hover:bg-brand-primary-hover" onClick={addStep}>
          <Plus className="w-4 h-4 mr-1" />
          {tx('添加步骤', 'Add Step')}
        </Button>
      </div>

      {steps.length === 0 && (
        <div className="text-center py-8 text-gray-400 border-2 border-dashed rounded-lg">
          {tx('暂无步骤，点击上方按钮添加', 'No steps yet. Click the button above to add one.')}
        </div>
      )}

      <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
        {steps.map((step, index) => {
          const config = stepTypeConfig[step.stepType];
          const Icon = config.icon;
          const isExpanded = expandedIndex === index;

          return (
            <Card key={index} className={cn('border', isExpanded && 'border-brand-primary')}> 
              <CardContent className="p-3">
                <div className="flex items-center gap-2">
                  <GripVertical className="w-4 h-4 text-gray-300 cursor-grab" />
                  <Badge className={cn('text-xs', config.color)}>
                    <Icon className="w-3 h-3 mr-1" />
                    {config.label}
                  </Badge>
                  <div
                    className="flex-1 cursor-pointer"
                    onClick={() => setExpandedIndex(isExpanded ? null : index)}
                  >
                    <span className="font-medium text-sm">{step.name}</span>
                    <span className="text-xs text-gray-400 ml-2">
                      #{step.stepOrder} · {step.timeoutHours}h
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={index === 0}
                      onClick={() => moveStep(index, -1)}
                    >
                      <ArrowUp className="w-3 h-3" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={index === steps.length - 1}
                      onClick={() => moveStep(index, 1)}
                    >
                      <ArrowDown className="w-3 h-3" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-500 hover:text-red-600"
                      onClick={() => removeStep(index)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 border-t pt-3">
                    <div className="space-y-1">
                      <Label className="text-xs">{tx('步骤名称', 'Step Name')}</Label>
                      <Input
                        value={step.name}
                        onChange={(e) => updateStep(index, { name: e.target.value })}
                        className="h-8 text-sm"
                      />
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">{tx('步骤类型', 'Step Type')}</Label>
                      <Select
                        value={step.stepType}
                        onValueChange={(v) => updateStep(index, { stepType: v as WorkflowStepType })}
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(stepTypeConfig).map(([key, cfg]) => (
                            <SelectItem key={key} value={key}>
                              <div className="flex items-center gap-2">
                                <cfg.icon className={cn('w-3 h-3', cfg.color.split(' ')[0])} />
                                {cfg.label}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {(step.stepType === 'APPROVAL' || step.stepType === 'NOTIFICATION') && (
                      <>
                        <div className="space-y-1">
                          <Label className="text-xs">{tx('审批角色', 'Approver Role')}</Label>
                          <Select
                            value={step.approverRole || ''}
                            onValueChange={(v) => updateStep(index, { approverRole: v })}
                          >
                            <SelectTrigger className="h-8 text-sm">
                              <SelectValue placeholder={tx('选择角色', 'Select role')} />
                            </SelectTrigger>
                            <SelectContent>
                              {roleOptions.map((r) => (
                                <SelectItem key={r.value} value={r.value}>
                                  {r.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs">{tx('指定用户ID', 'Specific User ID')}</Label>
                          <Input
                            value={step.approverUserId || ''}
                            onChange={(e) => updateStep(index, { approverUserId: e.target.value })}
                            className="h-8 text-sm"
                            placeholder={tx('可选', 'Optional')}
                          />
                        </div>
                      </>
                    )}

                    <div className="space-y-1">
                      <Label className="text-xs">{tx('超时时间(小时)', 'Timeout (hours)')}</Label>
                      <div className="flex items-center gap-2">
                        <Clock className="w-3 h-3 text-gray-400" />
                        <Input
                          type="number"
                          min={1}
                          value={step.timeoutHours}
                          onChange={(e) => updateStep(index, { timeoutHours: parseInt(e.target.value, 10) || 24 })}
                          className="h-8 text-sm"
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs">{tx('超时动作', 'Timeout Action')}</Label>
                      <Select
                        value={step.timeoutAction}
                        onValueChange={(v) => updateStep(index, { timeoutAction: v })}
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {timeoutActionOptions.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {step.stepType === 'CONDITION' && (
                      <div className="space-y-1 md:col-span-2">
                        <Label className="text-xs">{tx('条件表达式', 'Condition Expression')}</Label>
                        <Input
                          value={step.conditionExpression || ''}
                          onChange={(e) => updateStep(index, { conditionExpression: e.target.value })}
                          className="h-8 text-sm"
                          placeholder={tx('例如: amount > 10000', 'e.g. amount > 10000')}
                        />
                      </div>
                    )}

                    {step.stepType === 'AUTOMATION' && (
                      <div className="space-y-1 md:col-span-2">
                        <Label className="text-xs">{tx('自动化动作', 'Auto Action')}</Label>
                        <Input
                          value={step.autoAction || ''}
                          onChange={(e) => updateStep(index, { autoAction: e.target.value })}
                          className="h-8 text-sm"
                          placeholder={tx('例如: send_email, update_status', 'e.g. send_email, update_status')}
                        />
                      </div>
                    )}

                    <div className="flex items-center gap-2 md:col-span-2">
                      <Switch
                        checked={step.isParallel}
                        onCheckedChange={(v) => updateStep(index, { isParallel: v })}
                      />
                      <Label className="text-xs">{tx('并行审批', 'Parallel Approval')}</Label>
                      {step.isParallel && (
                        <div className="flex items-center gap-2 ml-4">
                          <Label className="text-xs">{tx('最少通过人数', 'Min Pass Count')}</Label>
                          <Input
                            type="number"
                            min={1}
                            value={step.parallelMinCount || 1}
                            onChange={(e) => updateStep(index, { parallelMinCount: parseInt(e.target.value, 10) || 1 })}
                            className="h-8 text-sm w-20"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
