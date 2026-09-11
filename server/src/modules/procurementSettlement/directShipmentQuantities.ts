/**
 * Pure quantity projections for supplier-direct fulfilment.
 *
 * A direct shipment is a separate delivery fact. It never becomes local OWN
 * inventory, and a customer receipt never changes the purchase line's stock
 * receipt counter. This module only validates immutable facts and derives the
 * counters a command may persist; it performs no database or side effect.
 */

export const DIRECT_SHIPMENT_QUANTITY_MAX = 2_147_483_647 as const;

export type DirectShipmentFulfillmentMode = 'STOCK_RECEIPT' | 'SUPPLIER_DIRECT';
export type DirectShipmentStatus = 'PREPARED' | 'CANCELLED' | 'DISPATCHED' | 'PARTIALLY_RECEIVED' | 'DELIVERED';
export type DirectShipmentReviewStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

export type DirectShipmentPurchaseLine = Readonly<{
  id: string;
  quantity: number;
  cancelledQuantity: number;
  /** Accepted local stock only. Direct customer receipts never enter this field. */
  receivedQuantity: number;
  /** Full quantity of approved, dispatched direct lines. */
  directShippedQuantity: number;
  fulfillmentMode: DirectShipmentFulfillmentMode;
}>;

export type DirectShipmentLine = Readonly<{
  id: string;
  purchaseCommitmentLineId: string;
  quantity: number;
  reviewStatus: DirectShipmentReviewStatus;
  /** Customer receipt quantity for this dispatched direct line. */
  receivedQuantity: number;
}>;

export type DirectShipmentHead = Readonly<{
  id: string;
  status: DirectShipmentStatus;
  lines: readonly DirectShipmentLine[];
}>;

export type DirectShipmentPurchaseProjection = Readonly<{
  purchaseLineId: string;
  purchaseQuantity: number;
  cancelledQuantity: number;
  stockReceivedQuantity: number;
  preparedQuantity: number;
  dispatchedQuantity: number;
  directShippedQuantity: number;
  plannedQuantity: number;
  customerReceivedQuantity: number;
  remainingToPlan: number;
}>;

export type DirectShipmentHeadProjection = Readonly<{
  headId: string;
  status: DirectShipmentStatus;
  lineCount: number;
  plannedQuantity: number;
  dispatchedQuantity: number;
  customerReceivedQuantity: number;
  remainingToReceive: number;
}>;

export type DirectShipmentHeadTotals = Readonly<{
  headCount: number;
  lineCount: number;
  preparedQuantity: number;
  plannedQuantity: number;
  dispatchedQuantity: number;
  customerReceivedQuantity: number;
  cancelledHeadCount: number;
}>;

export type DirectShipmentQuantityProjection = Readonly<{
  perPurchaseLine: readonly DirectShipmentPurchaseProjection[];
  heads: readonly DirectShipmentHeadProjection[];
  headTotals: DirectShipmentHeadTotals;
}>;

export type DirectShipmentQuantityErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_PURCHASE_LINE'
  | 'INVALID_DIRECT_HEAD'
  | 'INVALID_DIRECT_LINE'
  | 'INVALID_STATUS'
  | 'DUPLICATE_PURCHASE_LINE_ID'
  | 'DUPLICATE_DIRECT_HEAD_ID'
  | 'DUPLICATE_DIRECT_LINE_ID'
  | 'UNKNOWN_PURCHASE_LINE'
  | 'FULFILLMENT_MODE_MISMATCH'
  | 'DIRECT_REVIEW_REQUIRED'
  | 'DIRECT_SHIPPED_MISMATCH'
  | 'DIRECT_COVERAGE_EXCEEDED'
  | 'HEAD_STATUS_QUANTITY_MISMATCH'
  | 'INVALID_RECEIVED_QUANTITY'
  | 'QUANTITY_OVERFLOW'
  | 'INVALID_ORDER_LINE'
  | 'ORDER_COVERAGE_EXCEEDED';

export class DirectShipmentQuantityError extends Error {
  readonly code: DirectShipmentQuantityErrorCode;

  constructor(message: string, code: DirectShipmentQuantityErrorCode) {
    super(message);
    this.name = 'DirectShipmentQuantityError';
    this.code = code;
  }
}

function reject(message: string, code: DirectShipmentQuantityErrorCode): never {
  throw new DirectShipmentQuantityError(message, code);
}

function identifier(value: unknown, field: string, code: DirectShipmentQuantityErrorCode): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    reject(`${field}必须是非空标识`, code);
  }
  return value;
}

function integer(value: unknown, field: string, positive: boolean, code: DirectShipmentQuantityErrorCode): number {
  const minimum = positive ? 1 : 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < minimum || value > DIRECT_SHIPMENT_QUANTITY_MAX) {
    reject(`${field}必须是数据库可表示的${positive ? '正' : '非负'}整数`, code);
  }
  return value;
}

function add(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > DIRECT_SHIPMENT_QUANTITY_MAX) {
    reject(`${field}超过安全整数或 Int32 范围`, 'QUANTITY_OVERFLOW');
  }
  return result;
}

function subtract(left: number, right: number, field: string): number {
  const result = left - right;
  if (!Number.isSafeInteger(result) || result < 0) {
    reject(`${field}不能为负数`, 'DIRECT_COVERAGE_EXCEEDED');
  }
  return result;
}

function purchaseMode(value: unknown): DirectShipmentFulfillmentMode {
  if (value === 'STOCK_RECEIPT' || value === 'SUPPLIER_DIRECT') return value;
  reject('采购履约方式必须是 STOCK_RECEIPT 或 SUPPLIER_DIRECT', 'INVALID_PURCHASE_LINE');
}

function headStatus(value: unknown): DirectShipmentStatus {
  if (value === 'PREPARED' || value === 'CANCELLED' || value === 'DISPATCHED'
    || value === 'PARTIALLY_RECEIVED' || value === 'DELIVERED') return value;
  reject('直发头状态无效', 'INVALID_STATUS');
}

function reviewStatus(value: unknown): DirectShipmentReviewStatus {
  if (value === 'PENDING_REVIEW' || value === 'APPROVED' || value === 'REJECTED') return value;
  reject('直发明细复核状态无效', 'INVALID_STATUS');
}

function unique(ids: readonly string[], code: DirectShipmentQuantityErrorCode, label: string): void {
  if (new Set(ids).size !== ids.length) reject(`${label} id 不能重复`, code);
}

function validatePurchaseLine(line: DirectShipmentPurchaseLine): DirectShipmentPurchaseLine {
  if (!line || typeof line !== 'object') reject('采购行事实无效', 'INVALID_PURCHASE_LINE');
  return {
    id: identifier(line.id, '采购行 id', 'INVALID_PURCHASE_LINE'),
    quantity: integer(line.quantity, '采购承诺数量', true, 'INVALID_PURCHASE_LINE'),
    cancelledQuantity: integer(line.cancelledQuantity, '采购取消数量', false, 'INVALID_PURCHASE_LINE'),
    receivedQuantity: integer(line.receivedQuantity, '采购已验收库存数量', false, 'INVALID_PURCHASE_LINE'),
    directShippedQuantity: integer(line.directShippedQuantity, '采购直发数量', false, 'INVALID_PURCHASE_LINE'),
    fulfillmentMode: purchaseMode(line.fulfillmentMode),
  };
}

function validateDirectLine(line: DirectShipmentLine): DirectShipmentLine {
  if (!line || typeof line !== 'object') reject('直发明细事实无效', 'INVALID_DIRECT_LINE');
  return {
    id: identifier(line.id, '直发明细 id', 'INVALID_DIRECT_LINE'),
    purchaseCommitmentLineId: identifier(line.purchaseCommitmentLineId, '直发明细采购行 id', 'INVALID_DIRECT_LINE'),
    quantity: integer(line.quantity, '直发明细数量', true, 'INVALID_DIRECT_LINE'),
    reviewStatus: reviewStatus(line.reviewStatus),
    receivedQuantity: integer(line.receivedQuantity, '客户签收数量', false, 'INVALID_RECEIVED_QUANTITY'),
  };
}

type ValidatedHead = {
  id: string;
  status: DirectShipmentStatus;
  lines: DirectShipmentLine[];
};

function validateDirectHead(head: DirectShipmentHead): ValidatedHead {
  if (!head || typeof head !== 'object' || !Array.isArray(head.lines) || head.lines.length === 0) {
    reject('直发头必须包含至少一条明细', 'INVALID_DIRECT_HEAD');
  }
  return {
    id: identifier(head.id, '直发头 id', 'INVALID_DIRECT_HEAD'),
    status: headStatus(head.status),
    lines: head.lines.map(validateDirectLine),
  };
}

function validateHeadQuantities(head: ValidatedHead): {
  plannedQuantity: number;
  dispatchedQuantity: number;
  customerReceivedQuantity: number;
} {
  let quantity = 0;
  let customerReceivedQuantity = 0;
  for (const line of head.lines) {
    quantity = add(quantity, line.quantity, '直发头数量');
    if (line.receivedQuantity > line.quantity) {
      reject(`直发明细 ${line.id} 的签收量超过发运量`, 'INVALID_RECEIVED_QUANTITY');
    }
    customerReceivedQuantity = add(customerReceivedQuantity, line.receivedQuantity, '客户签收数量');
  }

  if (head.status === 'PREPARED') {
    if (customerReceivedQuantity !== 0) reject('PREPARED 直发不能有客户签收量', 'INVALID_RECEIVED_QUANTITY');
    const plannedQuantity = head.lines.reduce((total, line) => (
      line.reviewStatus === 'REJECTED' ? total : add(total, line.quantity, '已计划直发数量')
    ), 0);
    return { plannedQuantity, dispatchedQuantity: 0, customerReceivedQuantity: 0 };
  }

  if (head.status === 'CANCELLED') {
    if (customerReceivedQuantity !== 0) reject('CANCELLED 直发不能有客户签收量', 'INVALID_RECEIVED_QUANTITY');
    return { plannedQuantity: 0, dispatchedQuantity: 0, customerReceivedQuantity: 0 };
  }

  if (head.lines.some(line => line.reviewStatus !== 'APPROVED')) {
    reject(`${head.status} 直发的全部明细必须已 APPROVED`, 'DIRECT_REVIEW_REQUIRED');
  }
  if (head.status === 'DISPATCHED' && customerReceivedQuantity !== 0) {
    reject('DISPATCHED 直发只能有 0 签收量，部分签收必须改为 PARTIALLY_RECEIVED', 'HEAD_STATUS_QUANTITY_MISMATCH');
  }
  if (head.status === 'PARTIALLY_RECEIVED' && (customerReceivedQuantity <= 0 || customerReceivedQuantity >= quantity)) {
    reject('PARTIALLY_RECEIVED 必须有部分但未全部签收', 'HEAD_STATUS_QUANTITY_MISMATCH');
  }
  if (head.status === 'DELIVERED' && customerReceivedQuantity !== quantity) {
    reject('DELIVERED 直发必须全部签收', 'HEAD_STATUS_QUANTITY_MISMATCH');
  }
  return { plannedQuantity: quantity, dispatchedQuantity: quantity, customerReceivedQuantity };
}

/**
 * Validate direct shipment heads and reconcile them to purchase lines.
 * PREPARED non-rejected lines reserve planning capacity. Only approved lines
 * on DISPATCHED/PARTIALLY_RECEIVED/DELIVERED heads become direct-shipped
 * quantity; stock receipt and direct shipment are mutually exclusive per
 * purchase line.
 */
export function deriveDirectShipmentQuantities(input: Readonly<{
  purchaseLines: readonly DirectShipmentPurchaseLine[];
  /** SupplierDirectShipment rows, named shipments to match the service/API model. */
  shipments: readonly DirectShipmentHead[];
}>): DirectShipmentQuantityProjection {
  if (!input || !Array.isArray(input.purchaseLines) || !Array.isArray(input.shipments)) {
    reject('采购行和供应商直发事实必须是数组', 'INVALID_INPUT');
  }
  const purchaseLines = input.purchaseLines.map(validatePurchaseLine);
  unique(purchaseLines.map(line => line.id), 'DUPLICATE_PURCHASE_LINE_ID', '采购行');
  const purchaseById = new Map(purchaseLines.map(line => [line.id, line]));
  for (const line of purchaseLines) {
    if (add(add(line.cancelledQuantity, line.receivedQuantity, '采购取消及库存收货数量'), line.directShippedQuantity, '采购履约数量') > line.quantity) {
      reject(`采购行 ${line.id} 的取消、库存收货及直发数量超过采购承诺`, 'DIRECT_COVERAGE_EXCEEDED');
    }
  }

  const heads = input.shipments.map(validateDirectHead);
  unique(heads.map(head => head.id), 'DUPLICATE_DIRECT_HEAD_ID', '直发头');
  const seenLineIds: string[] = [];
  const preparedByPurchase = new Map<string, number>();
  const dispatchedByPurchase = new Map<string, number>();
  const receivedByPurchase = new Map<string, number>();
  for (const purchase of purchaseLines) {
    preparedByPurchase.set(purchase.id, 0);
    dispatchedByPurchase.set(purchase.id, 0);
    receivedByPurchase.set(purchase.id, 0);
  }

  const headProjection = heads.map((head) => {
    const quantities = validateHeadQuantities(head);
    for (const line of head.lines) {
      if (!purchaseById.has(line.purchaseCommitmentLineId)) {
        reject(`直发明细 ${line.id} 引用未知采购行 ${line.purchaseCommitmentLineId}`, 'UNKNOWN_PURCHASE_LINE');
      }
      seenLineIds.push(line.id);
      const purchase = purchaseById.get(line.purchaseCommitmentLineId)!;
      if (purchase.fulfillmentMode === 'STOCK_RECEIPT') {
        reject(`STOCK_RECEIPT 采购行 ${purchase.id} 不能存在直发明细`, 'FULFILLMENT_MODE_MISMATCH');
      }
      if (head.status === 'PREPARED' && line.reviewStatus !== 'REJECTED') {
        preparedByPurchase.set(purchase.id, add(preparedByPurchase.get(purchase.id)!, line.quantity, '采购计划直发数量'));
      }
      if (head.status === 'DISPATCHED' || head.status === 'PARTIALLY_RECEIVED' || head.status === 'DELIVERED') {
        dispatchedByPurchase.set(purchase.id, add(dispatchedByPurchase.get(purchase.id)!, line.quantity, '采购已发直发数量'));
        receivedByPurchase.set(purchase.id, add(receivedByPurchase.get(purchase.id)!, line.receivedQuantity, '采购直发签收数量'));
      }
    }
    const remainingToReceive = subtract(quantities.dispatchedQuantity, quantities.customerReceivedQuantity, '直发头待签收数量');
    return {
      headId: head.id,
      status: head.status,
      lineCount: head.lines.length,
      plannedQuantity: quantities.plannedQuantity,
      dispatchedQuantity: quantities.dispatchedQuantity,
      customerReceivedQuantity: quantities.customerReceivedQuantity,
      remainingToReceive,
    } satisfies DirectShipmentHeadProjection;
  });
  unique(seenLineIds, 'DUPLICATE_DIRECT_LINE_ID', '直发明细');

  const perPurchaseLine = purchaseLines.map((purchase) => {
    const preparedQuantity = preparedByPurchase.get(purchase.id)!;
    const dispatchedQuantity = dispatchedByPurchase.get(purchase.id)!;
    const customerReceivedQuantity = receivedByPurchase.get(purchase.id)!;
    if (purchase.directShippedQuantity !== dispatchedQuantity) {
      reject(`采购行 ${purchase.id} 的 directShippedQuantity 与已发直发明细不一致`, 'DIRECT_SHIPPED_MISMATCH');
    }
    if (purchase.fulfillmentMode === 'SUPPLIER_DIRECT' && purchase.receivedQuantity !== 0) {
      reject(`SUPPLIER_DIRECT 采购行 ${purchase.id} 不能有库存收货`, 'FULFILLMENT_MODE_MISMATCH');
    }
    const plannedQuantity = add(preparedQuantity, dispatchedQuantity, '直发计划数量');
    const occupied = add(add(add(preparedQuantity, dispatchedQuantity, '直发计划与发运数量'), purchase.receivedQuantity, '直发与库存收货数量'), purchase.cancelledQuantity, '采购总占用数量');
    if (occupied > purchase.quantity) {
      reject(`采购行 ${purchase.id} 的计划、直发、库存收货及取消数量超过采购承诺`, 'DIRECT_COVERAGE_EXCEEDED');
    }
    return {
      purchaseLineId: purchase.id,
      purchaseQuantity: purchase.quantity,
      cancelledQuantity: purchase.cancelledQuantity,
      stockReceivedQuantity: purchase.receivedQuantity,
      preparedQuantity,
      dispatchedQuantity,
      directShippedQuantity: purchase.directShippedQuantity,
      plannedQuantity,
      customerReceivedQuantity,
      remainingToPlan: purchase.quantity - occupied,
    } satisfies DirectShipmentPurchaseProjection;
  });

  const headTotals = headProjection.reduce<DirectShipmentHeadTotals>((totals, head) => ({
    headCount: totals.headCount + 1,
    lineCount: add(totals.lineCount, head.lineCount, '直发明细总数'),
    preparedQuantity: add(totals.preparedQuantity, head.status === 'PREPARED' ? head.plannedQuantity : 0, '直发待发计划总数'),
    plannedQuantity: add(totals.plannedQuantity, head.plannedQuantity, '直发计划总数'),
    dispatchedQuantity: add(totals.dispatchedQuantity, head.dispatchedQuantity, '直发总发运数'),
    customerReceivedQuantity: add(totals.customerReceivedQuantity, head.customerReceivedQuantity, '直发客户签收总数'),
    cancelledHeadCount: totals.cancelledHeadCount + (head.status === 'CANCELLED' ? 1 : 0),
  }), {
    headCount: 0, lineCount: 0, preparedQuantity: 0, plannedQuantity: 0,
    dispatchedQuantity: 0, customerReceivedQuantity: 0, cancelledHeadCount: 0,
  });

  return { perPurchaseLine, heads: headProjection, headTotals };
}

export const deriveDirectShipmentProjection = deriveDirectShipmentQuantities;

export type MixedOrderDeliveryLine = Readonly<{
  id: string;
  quantity: number;
  localOutbound: number;
  directShipped: number;
  localReceived: number;
  directReceived: number;
}>;

export type MixedOrderDeliveryLineProjection = Readonly<{
  orderLineId: string;
  quantity: number;
  localOutbound: number;
  directShipped: number;
  localReceived: number;
  directReceived: number;
  remainingToDispatch: number;
  remainingLocalToReceive: number;
  remainingDirectToReceive: number;
  remainingToReceive: number;
  fullyDispatched: boolean;
  fullyReceived: boolean;
}>;

export type MixedOrderDeliveryProjection = Readonly<{
  lines: readonly MixedOrderDeliveryLineProjection[];
  totals: {
    quantity: number;
    localOutbound: number;
    directShipped: number;
    localReceived: number;
    directReceived: number;
    remainingToDispatch: number;
    remainingToReceive: number;
    fullyDispatched: boolean;
    fullyReceived: boolean;
  };
}>;

/**
 * Project an order that may combine local inventory and supplier-direct
 * fulfilment. The two paths stay separate in both validation and output.
 */
export function deriveMixedOrderDeliveryProjection(input: Readonly<{
  orderLines: readonly MixedOrderDeliveryLine[];
}>): MixedOrderDeliveryProjection {
  if (!input || !Array.isArray(input.orderLines) || input.orderLines.length === 0) {
    reject('订单行事实必须是非空数组', 'INVALID_INPUT');
  }
  const seen = new Set<string>();
  const lines = input.orderLines.map((line) => {
    if (!line || typeof line !== 'object') reject('订单行事实无效', 'INVALID_ORDER_LINE');
    const id = identifier(line.id, '订单行 id', 'INVALID_ORDER_LINE');
    if (seen.has(id)) reject(`订单行 ${id} 重复`, 'DUPLICATE_PURCHASE_LINE_ID');
    seen.add(id);
    const quantity = integer(line.quantity, '订单行数量', true, 'INVALID_ORDER_LINE');
    const localOutbound = integer(line.localOutbound, '本地出库数量', false, 'INVALID_ORDER_LINE');
    const directShipped = integer(line.directShipped, '直发数量', false, 'INVALID_ORDER_LINE');
    const localReceived = integer(line.localReceived, '本地签收数量', false, 'INVALID_ORDER_LINE');
    const directReceived = integer(line.directReceived, '直发签收数量', false, 'INVALID_ORDER_LINE');
    if (add(localOutbound, directShipped, '订单行本地出库及直发数量') > quantity) {
      reject(`订单行 ${id} 的本地出库及直发数量超过应交数量`, 'ORDER_COVERAGE_EXCEEDED');
    }
    if (localReceived > localOutbound || directReceived > directShipped) {
      reject(`订单行 ${id} 的签收数量超过对应发运来源`, 'ORDER_COVERAGE_EXCEEDED');
    }
    const dispatched = add(localOutbound, directShipped, '订单行已发总数');
    const received = add(localReceived, directReceived, '订单行已签收总数');
    return {
      orderLineId: id,
      quantity,
      localOutbound,
      directShipped,
      localReceived,
      directReceived,
      remainingToDispatch: quantity - dispatched,
      remainingLocalToReceive: localOutbound - localReceived,
      remainingDirectToReceive: directShipped - directReceived,
      remainingToReceive: quantity - received,
      fullyDispatched: dispatched === quantity,
      fullyReceived: received === quantity,
    } satisfies MixedOrderDeliveryLineProjection;
  });
  const totals = lines.reduce<MixedOrderDeliveryProjection['totals']>((total, line) => ({
    quantity: add(total.quantity, line.quantity, '订单应交总数'),
    localOutbound: add(total.localOutbound, line.localOutbound, '本地出库总数'),
    directShipped: add(total.directShipped, line.directShipped, '直发总数'),
    localReceived: add(total.localReceived, line.localReceived, '本地签收总数'),
    directReceived: add(total.directReceived, line.directReceived, '直发签收总数'),
    remainingToDispatch: add(total.remainingToDispatch, line.remainingToDispatch, '订单待发总数'),
    remainingToReceive: add(total.remainingToReceive, line.remainingToReceive, '订单待签收总数'),
    fullyDispatched: false,
    fullyReceived: false,
  }), {
    quantity: 0, localOutbound: 0, directShipped: 0, localReceived: 0, directReceived: 0,
    remainingToDispatch: 0, remainingToReceive: 0, fullyDispatched: false, fullyReceived: false,
  });
  return {
    lines,
    totals: {
      ...totals,
      fullyDispatched: lines.every(line => line.fullyDispatched),
      fullyReceived: lines.every(line => line.fullyReceived),
    },
  };
}

/** Convenience form for callers that already have the order-line list. */
export function deriveMixedOrderDelivery(lines: readonly MixedOrderDeliveryLine[]): MixedOrderDeliveryProjection {
  return deriveMixedOrderDeliveryProjection({ orderLines: lines });
}
