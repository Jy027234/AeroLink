import { z } from 'zod';
import { AppError } from '../middleware/errorHandler.js';

const extractionSchema = z.object({
  type: z.enum(['AOG', 'STANDARD', 'INQUIRY', 'SPAM']),
  partNumbers: z.array(z.string().trim().min(1).max(120)).max(50),
  quantities: z.array(z.number().int().positive().max(1_000_000_000)).max(50),
  urgency: z.enum(['AOG', 'URGENT', 'STANDARD']),
  aircraftType: z.string().max(200).optional(),
  requiredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((value) => value.partNumbers.length === value.quantities.length);

const optionalNullableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const optionalNullableNumber = (minimum: number) => z.number().finite().min(minimum).max(1_000_000_000).nullable().optional();
const optionalNullablePositiveNumber = () => z.number().finite().positive().max(1_000_000_000).nullable().optional();
const nullableBoolean = z.boolean().nullable().default(null);
const nullableIncoterm = z.string().trim().min(2).max(20).transform((value) => value.toUpperCase()).nullable().default(null);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}).nullable().optional();

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
    return extractionSchema.parse(JSON.parse(json));
  } catch {
    throw new AppError('模型返回的需求提取结果不符合格式，请核对原文并重试；未创建需求单', 502);
  }
}

export function parseSupplierQuoteExtractionOutput(output: string): SupplierQuoteExtractionOutput {
  try {
    return supplierQuoteExtractionSchema.parse(JSON.parse(output.trim()));
  } catch {
    throw new AppError('模型返回的供应商报价提取结果不符合格式，请核对原文并重试；未创建报价记录', 502);
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
  const source = normalizeEvidenceText(`${subject}\n${body}`);
  if (output.items.some((item) => !source.includes(normalizeEvidenceText(item.evidenceText)))) {
    throw new AppError('模型返回的报价依据无法在原邮件中定位，请核对原文并重试；未创建报价记录', 502);
  }
  return output;
}
