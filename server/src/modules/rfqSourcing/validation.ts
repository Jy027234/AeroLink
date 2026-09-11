import { z } from 'zod';

/**
 * The demand facts that belong to one RFQ line.  The server assigns the line
 * id and line number; neither is accepted from a create request.
 *
 * Alternate part numbers are kept in the same JSON string representation as
 * the legacy RFQ columns.  This keeps the compatibility projection lossless
 * while letting the HTTP API accept the array form used by the UI.
 */
const alternatePartNumbersSchema = z.union([z.string(), z.array(z.string())]).optional().transform((value) => {
  if (Array.isArray(value)) return JSON.stringify(value);
  return value;
});

const lineFields = {
  partNumber: z.string().trim().min(1, '件号不能为空'),
  quantity: z.number().int().min(1, '数量必须大于0'),
  uom: z.string().trim().min(1).max(32).default('EA'),
  conditionCode: z.string().trim().min(1).max(32).default('NE'),
  description: z.string().optional(),
  serialNumber: z.string().optional(),
  batchNumber: z.string().optional(),
  ataChapter: z.string().optional(),
  aircraftType: z.string().optional(),
  aircraftModel: z.string().optional(),
  alternatePartNumbers: alternatePartNumbersSchema,
  targetPrice: z.number().finite().min(0).optional(),
  targetPriceCurrency: z.string().trim().min(1).max(8).toUpperCase().default('USD'),
  certificateRequired: z.boolean().default(true),
  certificateType: z.string().optional(),
  requiredDate: z.string().trim().min(1, '需求日期不能为空'),
  leadTimeDays: z.number().int().min(0).optional(),
};

/** Input for a new line. IDs are intentionally absent from this schema. */
export const rfqLineCreateSchema = z.object(lineFields).strict();

/** Input for editing a line in an existing RFQ. */
export const rfqLineUpdateSchema = z.object({
  id: z.string().min(1).optional(),
  ...lineFields,
}).strict();

const rfqContextFields = {
  customerId: z.string().min(1, '客户ID不能为空'),
  responseDeadline: z.string().optional(),
  urgency: z.enum(['AOG', 'URGENT', 'STANDARD']).default('STANDARD'),
  urgencyJustification: z.string().optional(),
  notes: z.string().optional(),
  emailId: z.string().optional(),
};

/**
 * Modern multi-line create.  Demand fields are line-only so a stale header
 * cannot silently overwrite one of the selected rows.
 */
const modernRfqCreateSchema = z.object({
  ...rfqContextFields,
  lines: z.array(rfqLineCreateSchema).min(1, '至少需要一条需求行').max(100, '需求行不能超过100条'),
}).strict();

/** Legacy single-line create kept for existing clients and email ingestion. */
const legacyRfqCreateSchema = z.object({
  ...rfqContextFields,
  partNumber: z.string().trim().min(1, '件号不能为空'),
  quantity: z.number().int().min(1, '数量必须大于0'),
  uom: z.string().trim().min(1).max(32).default('EA'),
  conditionCode: z.string().trim().min(1).max(32).default('NE'),
  description: z.string().optional(),
  serialNumber: z.string().optional(),
  batchNumber: z.string().optional(),
  ataChapter: z.string().optional(),
  aircraftType: z.string().optional(),
  aircraftModel: z.string().optional(),
  alternatePartNumbers: alternatePartNumbersSchema,
  targetPrice: z.number().finite().min(0).optional(),
  targetPriceCurrency: z.string().trim().min(1).max(8).toUpperCase().default('USD'),
  certificateRequired: z.boolean().default(true),
  certificateType: z.string().optional(),
  requiredDate: z.string().optional(),
  leadTimeDays: z.number().int().min(0).optional(),
}).strict();

export const rfqCreateSchema = z.union([modernRfqCreateSchema, legacyRfqCreateSchema]);

const rfqUpdateFields = {
  ...rfqContextFields,
  customerId: rfqContextFields.customerId.optional(),
  responseDeadline: rfqContextFields.responseDeadline,
  urgency: z.enum(['AOG', 'URGENT', 'STANDARD']).optional(),
  urgencyJustification: rfqContextFields.urgencyJustification,
  notes: rfqContextFields.notes,
  emailId: rfqContextFields.emailId,
  partNumber: z.string().trim().min(1).optional(),
  quantity: z.number().int().min(1).optional(),
  uom: z.string().trim().min(1).max(32).optional(),
  conditionCode: z.string().trim().min(1).max(32).optional(),
  description: z.string().optional(),
  serialNumber: z.string().optional(),
  batchNumber: z.string().optional(),
  ataChapter: z.string().optional(),
  aircraftType: z.string().optional(),
  aircraftModel: z.string().optional(),
  alternatePartNumbers: alternatePartNumbersSchema,
  targetPrice: z.number().finite().min(0).optional(),
  targetPriceCurrency: z.string().trim().min(1).max(8).toUpperCase().optional(),
  certificateRequired: z.boolean().optional(),
  certificateType: z.string().optional(),
  requiredDate: z.string().optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  lines: z.array(rfqLineUpdateSchema).min(1, '至少需要一条需求行').max(100, '需求行不能超过100条').optional(),
};

/**
 * PATCH accepts either legacy header fields or a complete line collection.
 * Mixing line collection and legacy demand fields is rejected so an old form
 * cannot accidentally overwrite the first row of a multi-line RFQ.
 */
export const rfqUpdateSchema = z.object(rfqUpdateFields).strict().superRefine((value, context) => {
  if (!value.lines) return;
  const legacyDemandFields = [
    'partNumber', 'quantity', 'uom', 'conditionCode', 'description', 'serialNumber', 'batchNumber',
    'ataChapter', 'aircraftType', 'aircraftModel', 'alternatePartNumbers', 'targetPrice',
    'targetPriceCurrency', 'certificateRequired', 'certificateType', 'requiredDate', 'leadTimeDays',
  ] as const;
  if (legacyDemandFields.some((field) => field in value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lines'],
      message: '提交需求行时不能同时提交旧版头部需求字段',
    });
  }
});

export type RfqCreateInput = z.infer<typeof rfqCreateSchema>;
export type RfqUpdateInput = z.infer<typeof rfqUpdateSchema>;
export type RfqLineCreateInput = z.infer<typeof rfqLineCreateSchema>;
export type RfqLineUpdateInput = z.infer<typeof rfqLineUpdateSchema>;
