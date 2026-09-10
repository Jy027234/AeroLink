import { Prisma } from '@prisma/client';
import { z } from 'zod';

const MAX_INT32 = 2_147_483_647;
const MAX_DECIMAL_18_4 = new Prisma.Decimal('99999999999999.9999');

const id = z.string().trim().min(1).max(200);
const shortText = (max: number) => z.string().trim().min(1).max(max);
const reason = z.string().trim().min(3).max(4000);
const version = z.number().int().positive().max(MAX_INT32);
const isoDateTime = z.string().datetime({ offset: true });

/**
 * External settlement amounts stay as strings until the command loads its
 * source facts. This rejects JavaScript number rounding and Decimal exponent
 * notation at the API boundary.
 */
const positiveUsdDecimal = z.string().trim()
  .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/, '金额必须是普通十进制字符串，最多四位小数')
  .refine((value) => {
    try {
      const decimal = new Prisma.Decimal(value);
      return decimal.gt(0) && decimal.lte(MAX_DECIMAL_18_4);
    } catch {
      return false;
    }
  }, '金额必须大于零且在 Decimal(18,4) 范围内');

function pastDateTime(value: string, ctx: z.RefinementCtx, path: string) {
  if (new Date(value).getTime() > Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: '发生时间不能晚于当前时间' });
  }
}

function evidenceIds() {
  return z.array(id).min(1).max(20).refine(
    (values) => new Set(values).size === values.length,
    '证据附件不能重复',
  );
}

const settlementMetadata = {
  externalSystem: shortText(100),
  voucherNumber: shortText(200),
  voucherLine: shortText(200),
  reason,
  evidenceIds: evidenceIds(),
};

/** Input for opening a settlement account; the base amount is derived from source facts. */
export const createSettlementAccountSchema = z.object({
  side: z.enum(['RECEIVABLE', 'PAYABLE']),
  orderId: id,
  purchaseCommitmentId: id.optional(),
  dueDate: isoDateTime,
  occurredAt: isoDateTime,
  ...settlementMetadata,
}).strict().superRefine((value, ctx) => {
  pastDateTime(value.occurredAt, ctx, 'occurredAt');
  if (value.side === 'PAYABLE' && !value.purchaseCommitmentId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['purchaseCommitmentId'], message: '应付账户必须关联采购承诺' });
  }
  if (value.side === 'RECEIVABLE' && value.purchaseCommitmentId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['purchaseCommitmentId'], message: '应收账户不能关联采购承诺' });
  }
});

/** Input for an immutable settlement record attached to an existing account. */
export const settlementRecordSchema = z.object({
  version,
  kind: z.enum(['PAYMENT', 'CREDIT', 'REFUND', 'REVERSAL', 'TERMS']),
  amount: positiveUsdDecimal.optional(),
  reversalOfId: id.optional(),
  dueDate: isoDateTime.optional(),
  occurredAt: isoDateTime,
  ...settlementMetadata,
}).strict().superRefine((value, ctx) => {
  pastDateTime(value.occurredAt, ctx, 'occurredAt');
  if (value.kind === 'PAYMENT' || value.kind === 'CREDIT' || value.kind === 'REFUND') {
    if (value.amount === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: `${value.kind} 必须提供金额` });
    }
    if (value.reversalOfId !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reversalOfId'], message: `${value.kind} 不能引用冲销目标` });
    }
    if (value.dueDate !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueDate'], message: `${value.kind} 不能修改截止日期` });
    }
    return;
  }

  if (value.kind === 'REVERSAL') {
    if (value.reversalOfId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reversalOfId'], message: '冲销记录必须指定原记录' });
    }
    if (value.amount !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: '冲销金额必须从原记录读取' });
    }
    if (value.dueDate !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueDate'], message: '冲销记录不能修改截止日期' });
    }
    return;
  }

  if (value.dueDate === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueDate'], message: '条款记录必须提供截止日期' });
  }
  if (value.amount !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: '条款记录不能提供金额' });
  }
  if (value.reversalOfId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reversalOfId'], message: '条款记录不能引用冲销目标' });
  }
});

export type CreateSettlementAccountInput = z.input<typeof createSettlementAccountSchema>;
export type SettlementRecordInput = z.input<typeof settlementRecordSchema>;

// Descriptive aliases keep command call sites explicit without widening the schema.
export type SettlementAccountCreateInput = CreateSettlementAccountInput;
export type SettlementRecordCreateInput = SettlementRecordInput;
