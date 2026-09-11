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

export function parseRfqExtractionOutput(output: string) {
  try {
    const json = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return extractionSchema.parse(JSON.parse(json));
  } catch {
    throw new AppError('模型返回的需求提取结果不符合格式，请核对原文并重试；未创建需求单', 502);
  }
}
