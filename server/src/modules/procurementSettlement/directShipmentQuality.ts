import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import {
  validateReceiptQuality,
  type ReceiptFulfillmentMode,
  type ReceiptQualityInput,
  type ReceiptQualitySnapshot,
  type ReceiptQualityValidation,
} from './receiptQuality.js';
import { loadPurchasePhysicalFacts } from './stockReceiptFacts.js';

export type DirectShipmentQualityPhase = 'PENDING' | 'APPROVE' | 'DISPATCH';

/**
 * Stable direct-shipment quality facts. Fulfilment counters are intentionally
 * absent: capacity is checked by the direct-shipment command at approval and
 * dispatch, while a previously approved quality result remains valid when a
 * different direct batch is dispatched first.
 */
export type DirectShipmentApprovalSnapshot = {
  schemaVersion: 1;
  chain: {
    order: Omit<ReceiptQualitySnapshot['chain']['order'], 'status'>;
    orderLine: ReceiptQualitySnapshot['chain']['orderLine'];
    quotation: ReceiptQualitySnapshot['chain']['quotation'];
    quotationLine: Omit<ReceiptQualitySnapshot['chain']['quotationLine'], 'acceptedQuantity'>;
    rfqLine: ReceiptQualitySnapshot['chain']['rfqLine'];
    rfq?: ReceiptQualitySnapshot['chain']['rfq'];
  };
  purchase: Omit<
    ReceiptQualitySnapshot['purchase'],
    'cancelledQuantity' | 'receivedQuantity' | 'directShippedQuantity'
  >;
  physical: ReceiptQualitySnapshot['physical'];
  certificates: ReceiptQualitySnapshot['certificates'];
};

export type DirectShipmentQualityValidation = ReceiptQualityValidation & {
  approvalSnapshot: DirectShipmentApprovalSnapshot;
  approvalSnapshotHash: string;
};

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function buildDirectShipmentApprovalSnapshot(
  snapshot: ReceiptQualitySnapshot,
): DirectShipmentApprovalSnapshot {
  const { status: _status, ...order } = snapshot.chain.order;
  const { acceptedQuantity: _acceptedQuantity, ...quotationLine } = snapshot.chain.quotationLine;
  const {
    cancelledQuantity: _cancelledQuantity,
    receivedQuantity: _receivedQuantity,
    directShippedQuantity: _directShippedQuantity,
    ...purchase
  } = snapshot.purchase;
  return {
    schemaVersion: 1,
    chain: {
      order,
      orderLine: { ...snapshot.chain.orderLine },
      quotation: { ...snapshot.chain.quotation },
      quotationLine,
      rfqLine: { ...snapshot.chain.rfqLine },
      ...(snapshot.chain.rfq ? { rfq: { ...snapshot.chain.rfq } } : {}),
    },
    purchase: {
      ...purchase,
      identitySnapshot: { ...purchase.identitySnapshot },
    },
    physical: {
      ...snapshot.physical,
      certificateReferences: snapshot.physical.certificateReferences.map((reference) => ({ ...reference })),
    },
    certificates: snapshot.certificates.map((certificate) => ({ ...certificate })),
  };
}

export function hashDirectShipmentApprovalSnapshot(snapshot: DirectShipmentApprovalSnapshot): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex');
}

/**
 * Rebuild and compare the immutable quality facts before dispatch. The
 * caller separately rechecks current direct capacity; this comparison only
 * protects identity, certificate and other quality requirements.
 */
export function assertDirectShipmentApprovalSnapshot(
  current: DirectShipmentApprovalSnapshot,
  approved: DirectShipmentApprovalSnapshot,
): void {
  if (hashDirectShipmentApprovalSnapshot(current) !== hashDirectShipmentApprovalSnapshot(approved)) {
    throw new AppError('直发质量审批事实已变化，请重新审核', 409, 'QUALITY_REVIEW_STALE');
  }
}

function receiptPhase(phase: DirectShipmentQualityPhase): 'ARRIVAL' | 'ACCEPT' {
  return phase === 'PENDING' ? 'ARRIVAL' : 'ACCEPT';
}

/**
 * Validate a supplier-direct physical fact using the same modern order/RFQ
 * identity and lifetime rules as stock receipt. PENDING returns issues for a
 * review record; APPROVE and DISPATCH fail closed on any issue.
 */
export function validateDirectShipmentQuality(
  input: ReceiptQualityInput,
  options: {
    phase?: DirectShipmentQualityPhase;
    now?: Date | string;
    approvedSnapshot?: DirectShipmentApprovalSnapshot;
  } = {},
): DirectShipmentQualityValidation {
  const phase = options.phase ?? 'PENDING';
  const review = validateReceiptQuality(input, {
    phase: receiptPhase(phase),
    now: options.now,
    expectedFulfillmentMode: 'SUPPLIER_DIRECT',
  });
  const approvalSnapshot = buildDirectShipmentApprovalSnapshot(review.snapshot);
  const approvalSnapshotHash = hashDirectShipmentApprovalSnapshot(approvalSnapshot);
  if (options.approvedSnapshot) {
    assertDirectShipmentApprovalSnapshot(approvalSnapshot, options.approvedSnapshot);
  }
  return { ...review, approvalSnapshot, approvalSnapshotHash };
}

export type DirectShipmentFacts = Awaited<ReturnType<typeof loadDirectShipmentFacts>>;

/**
 * Load the exact relational source and validate it for a direct shipment.
 * `expectedFulfillmentMode` is server-only: callers cannot turn a stock
 * receipt into a direct shipment by changing a request body field.
 */
export async function loadDirectShipmentFacts(
  tx: Prisma.TransactionClient,
  purchaseLineId: string,
  physicalInput: unknown,
  phase: DirectShipmentQualityPhase = 'PENDING',
  now = new Date(),
) {
  const facts = await loadPurchasePhysicalFacts(tx, purchaseLineId, physicalInput);
  const review = validateDirectShipmentQuality(facts.input, { phase, now });
  return {
    line: facts.line,
    physical: facts.physical,
    review,
  };
}

// Keep this import-visible alias useful to integrations that only need to
// document the server-enforced mode without duplicating string literals.
export const DIRECT_SHIPMENT_FULFILLMENT_MODE: ReceiptFulfillmentMode = 'SUPPLIER_DIRECT';
