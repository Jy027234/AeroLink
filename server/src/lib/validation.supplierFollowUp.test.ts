import { describe, expect, it } from 'vitest';
import { supplierFollowUpLogBatchCreateSchema } from './validation.js';

describe('supplier follow-up validation', () => {
  it('normalizes legacy portal follow-up values into internal record-management values', () => {
    const parsed = supplierFollowUpLogBatchCreateSchema.parse({
      logs: [{
        supplierId: 'supplier-1',
        taskId: 'task-1',
        actionType: 'portal_follow_up',
        outcome: 'portal_message_sent',
      }],
    });

    expect(parsed.logs[0]).toMatchObject({
      actionType: 'recorded_contact_follow_up',
      outcome: 'follow_up_sent',
    });
  });
});
