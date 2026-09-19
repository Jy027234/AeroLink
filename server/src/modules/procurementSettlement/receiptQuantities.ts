/**
 * Pure quantity rules for purchase receipts.
 *
 * A receipt line is an immutable fact about one physical arrival batch or
 * serial-numbered unit.  The database command that records the fact is out
 * of scope here; this module only validates the facts and derives the
 * projection used by that command.  In particular, REJECTED history is kept
 * for audit but never counts as available stock, current purchase occupancy,
 * or a supplier return/refund.
 */

export const RECEIPT_QUANTITY_MAX = 2_147_483_647 as const;

export type ReceiptLineStatus = 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED';

export type PurchaseReceiptPurchaseLine = Readonly<{
  id: string;
  quantity: number;
  cancelledQuantity: number;
  /** Derived accepted receipt quantity stored on PurchaseCommitmentLine. */
  receivedQuantity: number;
  directShippedQuantity: number;
}>;

export type PurchaseReceiptLine = Readonly<{
  id: string;
  /** Explicit source identity; a receipt must never be matched by part number. */
  purchaseLineId: string;
  quantity: number;
  status: ReceiptLineStatus;
}>;

export type DeriveReceiptQuantitiesInput = Readonly<{
  purchaseLines: readonly PurchaseReceiptPurchaseLine[];
  receiptLines: readonly PurchaseReceiptLine[];
}>;

export type ReceiptPurchaseProjection = Readonly<{
  purchaseLineId: string;
  purchaseQuantity: number;
  cancelledQuantity: number;
  directShippedQuantity: number;
  /** Quantity still expected after cancellations, direct shipment and review. */
  outstandingArrival: number;
  pendingReview: number;
  /** Accepted receipt quantity; must equal PurchaseCommitmentLine.receivedQuantity. */
  accepted: number;
  /** Rejected history only; it does not reduce outstandingArrival. */
  rejected: number;
}>;

export type ReceiptHeadTotals = Readonly<{
  purchaseQuantity: number;
  cancelledQuantity: number;
  directShippedQuantity: number;
  outstandingArrival: number;
  pendingReview: number;
  accepted: number;
  rejected: number;
  receiptLineCount: number;
}>;

export type ReceiptQuantityProjection = Readonly<{
  perPurchaseLine: readonly ReceiptPurchaseProjection[];
  headTotals: ReceiptHeadTotals;
}>;

export type ReceiptQuantityErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_PURCHASE_LINE'
  | 'INVALID_RECEIPT_LINE'
  | 'INVALID_RECEIPT_STATUS'
  | 'DUPLICATE_PURCHASE_LINE_ID'
  | 'DUPLICATE_RECEIPT_LINE_ID'
  | 'UNKNOWN_PURCHASE_LINE'
  | 'RECEIPT_COVERAGE_EXCEEDED'
  | 'RECEIVED_QUANTITY_MISMATCH'
  | 'QUANTITY_OVERFLOW'
  | 'INVALID_DECISION';

export class ReceiptQuantityError extends Error {
  readonly code: ReceiptQuantityErrorCode;

  constructor(message: string, code: ReceiptQuantityErrorCode) {
    super(message);
    this.name = 'ReceiptQuantityError';
    this.code = code;
  }
}

function reject(message: string, code: ReceiptQuantityErrorCode): never {
  throw new ReceiptQuantityError(message, code);
}

function identifier(value: unknown, field: string, code: ReceiptQuantityErrorCode): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    reject(`${field}必须是非空标识`, code);
  }
  return value;
}

function integer(value: unknown, field: string, positive: boolean, code: ReceiptQuantityErrorCode): number {
  const minimum = positive ? 1 : 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < minimum || value > RECEIPT_QUANTITY_MAX) {
    reject(`${field}必须是数据库可表示的${positive ? '正' : '非负'}整数`, code);
  }
  return value;
}

function add(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) reject(`${field}超过安全整数范围`, 'QUANTITY_OVERFLOW');
  return result;
}

function status(value: unknown): ReceiptLineStatus {
  if (value === 'PENDING_REVIEW' || value === 'ACCEPTED' || value === 'REJECTED') return value;
  reject('收货行状态必须是 PENDING_REVIEW、ACCEPTED 或 REJECTED', 'INVALID_RECEIPT_STATUS');
}

function validatePurchaseLine(line: PurchaseReceiptPurchaseLine): PurchaseReceiptPurchaseLine {
  if (!line || typeof line !== 'object') reject('采购行事实无效', 'INVALID_PURCHASE_LINE');
  const id = identifier(line.id, '采购行 id', 'INVALID_PURCHASE_LINE');
  const quantity = integer(line.quantity, '采购承诺数量', true, 'INVALID_PURCHASE_LINE');
  const cancelledQuantity = integer(line.cancelledQuantity, '采购取消数量', false, 'INVALID_PURCHASE_LINE');
  const receivedQuantity = integer(line.receivedQuantity, '采购已收货数量', false, 'INVALID_PURCHASE_LINE');
  const directShippedQuantity = integer(line.directShippedQuantity, '采购直发数量', false, 'INVALID_PURCHASE_LINE');
  if (add(cancelledQuantity, directShippedQuantity, '采购取消及直发数量') > quantity) {
    reject('采购取消及直发数量超过采购承诺', 'RECEIPT_COVERAGE_EXCEEDED');
  }
  return { id, quantity, cancelledQuantity, receivedQuantity, directShippedQuantity };
}

function validateReceiptLine(line: PurchaseReceiptLine): PurchaseReceiptLine {
  if (!line || typeof line !== 'object') reject('收货行事实无效', 'INVALID_RECEIPT_LINE');
  const id = identifier(line.id, '收货行 id', 'INVALID_RECEIPT_LINE');
  const purchaseLineId = identifier(line.purchaseLineId, '收货行 purchaseLineId', 'INVALID_RECEIPT_LINE');
  const quantity = integer(line.quantity, '收货数量', true, 'INVALID_RECEIPT_LINE');
  const lineStatus = status(line.status);
  return { id, purchaseLineId, quantity, status: lineStatus };
}

function requireUnique(ids: readonly string[], code: ReceiptQuantityErrorCode, label: string) {
  if (new Set(ids).size !== ids.length) reject(`${label} id 不能重复`, code);
}

/**
 * Derive purchase receipt quantities from immutable purchase and receipt
 * facts.  A purchase line may have any number of receipt lines.  Rejected
 * arrivals remain in the rejected total but can be followed by a replacement
 * arrival because they do not consume the purchase quantity.
 */
export function deriveReceiptQuantities(input: DeriveReceiptQuantitiesInput): ReceiptQuantityProjection {
  if (!input || !Array.isArray(input.purchaseLines) || !Array.isArray(input.receiptLines)) {
    reject('采购行和收货行事实必须是数组', 'INVALID_INPUT');
  }

  const purchases = input.purchaseLines.map(validatePurchaseLine);
  requireUnique(purchases.map(line => line.id), 'DUPLICATE_PURCHASE_LINE_ID', '采购行');
  const purchaseById = new Map(purchases.map(line => [line.id, line]));

  const receipts = input.receiptLines.map(validateReceiptLine);
  requireUnique(receipts.map(line => line.id), 'DUPLICATE_RECEIPT_LINE_ID', '收货行');

  const buckets = new Map<string, { pendingReview: number; accepted: number; rejected: number }>();
  for (const purchase of purchases) buckets.set(purchase.id, { pendingReview: 0, accepted: 0, rejected: 0 });

  for (const receipt of receipts) {
    if (!purchaseById.has(receipt.purchaseLineId)) {
      reject(`收货行 ${receipt.id} 引用未知采购行 ${receipt.purchaseLineId}`, 'UNKNOWN_PURCHASE_LINE');
    }
    const bucket = buckets.get(receipt.purchaseLineId)!;
    bucket[receipt.status === 'PENDING_REVIEW' ? 'pendingReview' : receipt.status === 'ACCEPTED' ? 'accepted' : 'rejected'] =
      add(bucket[receipt.status === 'PENDING_REVIEW' ? 'pendingReview' : receipt.status === 'ACCEPTED' ? 'accepted' : 'rejected'], receipt.quantity, '收货数量累计');
  }

  const perPurchaseLine = purchases.map(purchase => {
    const bucket = buckets.get(purchase.id)!;
    const active = add(add(bucket.accepted, bucket.pendingReview, '已验收及待审收货数量'),
      add(purchase.cancelledQuantity, purchase.directShippedQuantity, '采购取消及直发数量'), '采购占用数量');
    if (active > purchase.quantity) {
      reject(`采购行 ${purchase.id} 的验收、待审、取消及直发数量超过采购承诺`, 'RECEIPT_COVERAGE_EXCEEDED');
    }
    if (bucket.accepted !== purchase.receivedQuantity) {
      reject(`采购行 ${purchase.id} 的 accepted 收货数量与 receivedQuantity 不一致`, 'RECEIVED_QUANTITY_MISMATCH');
    }
    return {
      purchaseLineId: purchase.id,
      purchaseQuantity: purchase.quantity,
      cancelledQuantity: purchase.cancelledQuantity,
      directShippedQuantity: purchase.directShippedQuantity,
      outstandingArrival: purchase.quantity - active,
      pendingReview: bucket.pendingReview,
      accepted: bucket.accepted,
      rejected: bucket.rejected,
    } satisfies ReceiptPurchaseProjection;
  });

  const headTotals = perPurchaseLine.reduce<ReceiptHeadTotals>((totals, line) => ({
    purchaseQuantity: add(totals.purchaseQuantity, line.purchaseQuantity, '采购承诺合计'),
    cancelledQuantity: add(totals.cancelledQuantity, line.cancelledQuantity, '采购取消合计'),
    directShippedQuantity: add(totals.directShippedQuantity, line.directShippedQuantity, '采购直发合计'),
    outstandingArrival: add(totals.outstandingArrival, line.outstandingArrival, '待收货合计'),
    pendingReview: add(totals.pendingReview, line.pendingReview, '待审收货合计'),
    accepted: add(totals.accepted, line.accepted, '已验收合计'),
    rejected: add(totals.rejected, line.rejected, '拒收历史合计'),
    receiptLineCount: totals.receiptLineCount,
  }), {
    purchaseQuantity: 0, cancelledQuantity: 0, directShippedQuantity: 0, outstandingArrival: 0,
    pendingReview: 0, accepted: 0, rejected: 0, receiptLineCount: receipts.length,
  });

  return { perPurchaseLine, headTotals };
}

/**
 * Pure status projection for a pending receipt.  It returns a new fact and
 * never mutates the historical input.  Callers must run
 * `deriveReceiptQuantities` again with the projected fact before persisting a
 * decision, so aggregate coverage and receivedQuantity are checked together.
 */
export function deriveReceiptDecision(
  line: PurchaseReceiptLine,
  decision: Exclude<ReceiptLineStatus, 'PENDING_REVIEW'>,
): PurchaseReceiptLine {
  const current = validateReceiptLine(line);
  if (current.status !== 'PENDING_REVIEW') {
    reject('只有待审核收货行可以验收或拒收', 'INVALID_DECISION');
  }
  if (decision !== 'ACCEPTED' && decision !== 'REJECTED') {
    reject('收货决定必须是 ACCEPTED 或 REJECTED', 'INVALID_DECISION');
  }
  return { ...current, status: decision };
}
