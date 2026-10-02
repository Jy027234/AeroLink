import { z } from 'zod';
import { AppError } from '../middleware/errorHandler.js';
import { evidencedOfferQuantity, supplierReplyBody } from './supplierReplyEvidence.js';

const extractionBase = {
  type: z.enum(['AOG', 'STANDARD', 'INQUIRY', 'SPAM']),
  urgency: z.enum(['AOG', 'URGENT', 'STANDARD']),
  aircraftType: z.string().max(200).optional(),
};
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

// Published v1 prompts can still return parallel arrays. Keep reading them,
// but never invent a missing quantity when converting to reviewable rows.
const legacyExtractionSchema = z.object({
  ...extractionBase,
  partNumbers: z.array(z.string().trim().min(1).max(120)).max(50),
  quantities: z.array(z.number().int().positive().max(1_000_000_000)).max(50),
  requiredDate: calendarDate.optional(),
}).strict().refine((value) => value.partNumbers.length === value.quantities.length);

const extractionItemSchema = z.object({
  partNumber: z.string().trim().min(1).max(120),
  quantity: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  quantityUnit: z.string().trim().min(1).max(80).nullable().optional(),
  requiredDate: calendarDate.nullable().optional(),
  evidenceText: z.string().trim().min(1).max(3000),
}).strict();
const itemExtractionSchema = z.object({
  ...extractionBase,
  items: z.array(extractionItemSchema).max(50),
}).strict();

const optionalNullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const optionalNullableNumber = (minimum: number) => z.number().finite().min(minimum).max(1_000_000_000).nullable().optional();
const optionalNullablePositiveNumber = () => z.number().finite().positive().max(1_000_000_000).nullable().optional();
const nullableBoolean = z.boolean().nullable().default(null);
const nullableIncoterm = z.string().trim().min(2).max(20).transform((value) => value.toUpperCase()).nullable().default(null);
const isoDate = calendarDate.nullable().optional();

const supplierQuoteItemSchema = z.object({
  partNumber: optionalNullableText(120),
  quantity: optionalNullablePositiveNumber(),
  quantityUnit: optionalNullableText(80),
  unitPrice: optionalNullableNumber(0),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  leadTimeDays: optionalNullableNumber(0),
  leadTimeMinDays: optionalNullableNumber(0),
  leadTimeMaxDays: optionalNullableNumber(0),
  validUntil: isoDate,
  condition: optionalNullableText(1000),
  certificate: optionalNullableText(1000),
  taxIncluded: nullableBoolean,
  freightIncluded: nullableBoolean,
  incoterm: nullableIncoterm,
  evidenceText: z.string().trim().min(1).max(3000),
}).strict().superRefine((item, context) => {
  const hasRange = item.leadTimeMinDays != null || item.leadTimeMaxDays != null;
  if (item.leadTimeDays != null && hasRange) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['leadTimeDays'], message: '单一交期不能与交期范围同时填写' });
  }
  if (item.leadTimeMinDays != null && item.leadTimeMaxDays != null && item.leadTimeMinDays > item.leadTimeMaxDays) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['leadTimeMaxDays'], message: '交期范围最大值不能小于最小值' });
  }
});

const supplierQuoteExtractionSchema = z.object({
  items: z.array(supplierQuoteItemSchema).max(100),
}).strict();

export type SupplierQuoteExtractionOutput = z.infer<typeof supplierQuoteExtractionSchema>;

export function parseRfqExtractionOutput(output: string) {
  try {
    const json = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const value: unknown = JSON.parse(json);
    const modern = itemExtractionSchema.safeParse(value);
    if (modern.success) {
      return {
        ...modern.data,
        partNumbers: modern.data.items.map((item) => item.partNumber),
        quantities: modern.data.items.map((item) => item.quantity ?? null),
      };
    }
    const legacy = legacyExtractionSchema.parse(value);
    return {
      ...legacy,
      items: legacy.partNumbers.map((partNumber, index) => ({
        partNumber,
        quantity: legacy.quantities[index],
        quantityUnit: null,
        requiredDate: legacy.requiredDate ?? null,
        evidenceText: null,
      })),
    };
  } catch {
    throw new AppError('模型返回的需求提取结果不符合格式，请核对原文并重试；未创建需求单', 502);
  }
}

export function assertRfqExtractionEvidence(
  output: ReturnType<typeof parseRfqExtractionOutput>,
  subject: unknown,
  body: unknown,
) {
  if (output.items.some((item) => item.evidenceText !== null)) {
    if (typeof subject !== 'string' || typeof body !== 'string') {
      throw new AppError('需求提取需要邮件主题和正文', 400, 'VALIDATION_ERROR');
    }
    const source = normalizeEvidenceText(`${subject}\n${body}`);
    if (output.items.some((item) => item.evidenceText !== null && (
      !source.includes(normalizeEvidenceText(item.evidenceText))
      || !item.evidenceText.toLocaleUpperCase().includes(item.partNumber.toLocaleUpperCase())
    ))) {
      throw new AppError('模型返回的需求依据无法在原邮件中定位，请核对原文并重试；未创建需求单', 502);
    }
  }
  return output;
}

export function parseSupplierQuoteExtractionOutput(output: string): SupplierQuoteExtractionOutput {
  try {
    return supplierQuoteExtractionSchema.parse(JSON.parse(output.trim()));
  } catch {
    throw new AppError('模型返回的供应商报价提取结果不符合格式，请核对原文并重试；未创建报价记录', 502, 'AI_QUOTE_OUTPUT_INVALID');
  }
}

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function assertSupplierQuoteEvidence(
  output: SupplierQuoteExtractionOutput,
  subject: unknown,
  body: unknown,
): SupplierQuoteExtractionOutput {
  if (typeof subject !== 'string' || typeof body !== 'string') {
    throw new AppError('供应商报价提取需要邮件主题和正文', 400, 'VALIDATION_ERROR');
  }
  const source = normalizeEvidenceText(`${subject}\n${supplierReplyBody(body)}`);
  if (output.items.some((item) => !source.includes(normalizeEvidenceText(item.evidenceText)))) {
    throw new AppError('模型返回的报价依据无法在原邮件中定位，或仅来自引用历史；请核对本次回信或手工建稿，未创建报价记录', 502, 'AI_QUOTE_EVIDENCE_INVALID');
  }
  return { ...output, items: output.items.map(item => evidencedOfferQuantity(item.quantity, item.evidenceText)
    ? item : { ...item, quantity: null, quantityUnit: null }) };
}
