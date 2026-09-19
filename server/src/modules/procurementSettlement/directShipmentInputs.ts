import { z } from 'zod';
import { receiptPhysicalSchema } from './receiptQuality.js';

const MAX_INT32 = 2_147_483_647;

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(3).max(4000);
const version = z.number().int().positive().max(MAX_INT32);
const snapshotHash64hex = z.string().regex(/^[0-9a-f]{64}$/i, 'snapshotHash必须是64位十六进制摘要')
  .transform((value) => value.toLowerCase());

function evidenceIds(minimum: 0 | 1) {
  const schema = z.array(id).min(minimum).max(20).refine(
    (values) => new Set(values).size === values.length,
    '证据附件不能重复',
  );
  return minimum === 0 ? schema.default([]) : schema;
}

const directShipmentLineSchema = z.object({
  purchaseCommitmentLineId: id,
  physical: receiptPhysicalSchema,
}).strict();

const directShipmentChecksSchema = z.object({
  identity: z.boolean(),
  documents: z.boolean(),
  conditionAndLife: z.boolean(),
  customerRequirements: z.boolean(),
}).strict();

/** Input for registering a supplier-direct shipment. */
export const createDirectShipmentSchema = z.object({
  purchaseCommitmentId: id,
  purchaseVersion: version,
  carrier: text,
  trackingNumber: text,
  origin: text,
  destination: text,
  reason,
  evidenceIds: evidenceIds(1),
  lines: z.array(directShipmentLineSchema).min(1).max(100),
}).strict();

/** Input for the independent quality decision on a supplier-direct shipment. */
export const reviewDirectShipmentSchema = z.object({
  version,
  snapshotHash: snapshotHash64hex,
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason,
  checks: directShipmentChecksSchema,
  evidenceIds: evidenceIds(0),
}).strict();

/** Input for an action that changes the direct-shipment head state. */
export const directShipmentActionSchema = z.object({
  version,
  reason,
}).strict();

/** Input for recording signed receipt of one direct-shipment line. */
export const directShipmentReceiptSchema = z.object({
  version,
  quantity: z.number().int().positive().max(MAX_INT32),
  signedBy: z.string().trim().min(1).max(200),
  signedAt: z.string().datetime({ offset: true }),
  reason,
  evidenceIds: evidenceIds(1),
}).strict();

export type CreateDirectShipmentInput = z.input<typeof createDirectShipmentSchema>;
export type ReviewDirectShipmentInput = z.input<typeof reviewDirectShipmentSchema>;
export type DirectShipmentActionInput = z.input<typeof directShipmentActionSchema>;
export type DirectShipmentReceiptInput = z.input<typeof directShipmentReceiptSchema>;

// Descriptive aliases keep the public contract readable at command call sites.
export type DirectShipmentCreateInput = CreateDirectShipmentInput;
export type DirectShipmentReviewInput = ReviewDirectShipmentInput;
