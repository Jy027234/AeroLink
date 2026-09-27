import type { AgentTask } from '@/types/agent';

function collectTaskFieldValues(value: unknown, field: string, depth = 0): string[] {
  if (depth > 4 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectTaskFieldValues(item, field, depth + 1));
  const record = value as Record<string, unknown>;
  const ownValue = typeof record[field] === 'string' && record[field].trim() ? [record[field].trim()] : [];
  return [...ownValue, ...Object.values(record).flatMap((nested) => collectTaskFieldValues(nested, field, depth + 1))];
}

export function getAgentTaskSourcingHref(task: AgentTask): string | null {
  const taskRecords = [task.context, task.confirmationNode?.data, task.result, ...(task.steps ?? []).flatMap((step) => [step.params, step.result])];
  const rfqIds = [...new Set(taskRecords.flatMap((record) => collectTaskFieldValues(record, 'rfqId')))];
  if (rfqIds.length !== 1) return null;
  const lineIds = [...new Set(taskRecords.flatMap((record) => collectTaskFieldValues(record, 'rfqLineId')))];
  const params = new URLSearchParams({ rfqId: rfqIds[0] });
  if (lineIds.length === 1) params.set('rfqLineId', lineIds[0]);
  return `/sourcing?${params.toString()}`;
}
