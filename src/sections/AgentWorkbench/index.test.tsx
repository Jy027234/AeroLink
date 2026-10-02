import { expect, it } from 'vitest';
import type { AgentTask } from '@/types/agent';
import { getAgentTaskSourcingHref } from './sourcingLink';

function task(context: AgentTask['context']): AgentTask {
  return {
    id: 'task-1', trigger: { type: 'manual' }, type: 'sourcing_started', status: 'pending',
    currentStepIndex: 0, steps: [], context, createdAt: new Date('2026-09-22T00:00:00Z'), updatedAt: new Date('2026-09-22T00:00:00Z'),
  };
}

it('deep-links an Agent task to its single explicit demand line', () => {
  expect(getAgentTaskSourcingHref(task({ rfqId: 'rfq-1', selectedSupplier: { rfqLineId: 'line-2' } })))
    .toBe('/sourcing?rfqId=rfq-1&rfqLineId=line-2');
});

it('opens RFQ context without guessing when task evidence spans multiple lines', () => {
  expect(getAgentTaskSourcingHref(task({ rfqId: 'rfq-1', lines: [{ rfqLineId: 'line-1' }, { rfqLineId: 'line-2' }] })))
    .toBe('/sourcing?rfqId=rfq-1');
});
