import { AppError } from '../../middleware/errorHandler.js';

/**
 * A positive quantity from one immutable OUTBOUND transaction.
 *
 * InventoryTransaction stores OUTBOUND quantities as negative ledger deltas.
 * Callers must pass the positive magnitude here so this module cannot silently
 * turn an inbound or malformed row into a shippable quantity.
 */
export type OutboundTransactionQuantity = {
  id: string;
  quantity: number;
};

/** One immutable shipment-line slice bound to one actual OUTBOUND transaction. */
export type ShipmentOutboundSlice = {
  id: string;
  outboundTransactionId: string;
  quantity: number;
};

export type ShippableTransactionQuantity = {
  outboundTransactionId: string;
  actualOutboundQuantity: number;
  boundShipmentQuantity: number;
  shippableQuantity: number;
};

export type ShippableQuantityResult = {
  actualOutboundQuantity: number;
  boundShipmentQuantity: number;
  shippableQuantity: number;
  byOutboundTransaction: ShippableTransactionQuantity[];
};

/** Cumulative quantity facts for one shipment line. */
export type ShipmentLineQuantityFacts = {
  shipmentLineId: string;
  shippedQuantity: number;
  receivedQuantity: number;
  returnedQuantity: number;
};

export type ShipmentLineQuantityResult = ShipmentLineQuantityFacts & {
  remainingToReceive: number;
  remainingToReturn: number;
  fullyReceived: boolean;
};

/** Cumulative receipt facts for one order line. */
export type OrderLineDeliveryQuantity = {
  orderLineId: string;
  quantity: number;
  receivedQuantity: number;
};

export type OrderLineDeliveryProgress = OrderLineDeliveryQuantity & {
  remainingQuantity: number;
  fullyReceived: boolean;
};

export type OrderDeliveryProgress = {
  requiredQuantity: number;
  receivedQuantity: number;
  remainingQuantity: number;
  complete: boolean;
  lines: OrderLineDeliveryProgress[];
};

const inconsistent = (message: string): never => {
  throw new AppError(message, 409, 'ALLOCATION_INCONSISTENT');
};

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    inconsistent(`${label}无效`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    inconsistent(`${label}必须是非空标识`);
  }
}

function assertSafeNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    inconsistent(`${label}必须是非负安全整数`);
  }
}

function assertSafePositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    inconsistent(`${label}必须是正安全整数`);
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    inconsistent(`${label}超出安全整数范围`);
  }
  return result;
}

function safeDifference(left: number, right: number, label: string): number {
  const result = left - right;
  if (!Number.isSafeInteger(result) || result < 0) {
    inconsistent(`${label}不能为负数或超出安全整数范围`);
  }
  return result;
}

/**
 * Calculate the quantity that can still be bound to shipments.
 *
 * A shipment may split one OUTBOUND transaction across several shipment
 * lines, but the slices together can never exceed that transaction's actual
 * OUTBOUND magnitude. The result remains per transaction so a later command
 * can choose a real source instead of treating an order-level total as stock.
 */
export function calculateShippableQuantities(
  outboundTransactions: readonly OutboundTransactionQuantity[],
  shipmentSlices: readonly ShipmentOutboundSlice[],
): ShippableQuantityResult {
  if (!Array.isArray(outboundTransactions) || !Array.isArray(shipmentSlices)) {
    inconsistent('OUTBOUND流水和发运切片必须是数组');
  }

  const transactionQuantities = new Map<string, number>();
  let actualOutboundQuantity = 0;
  for (const [index, transaction] of outboundTransactions.entries()) {
    assertRecord(transaction, `outboundTransactions[${index}]`);
    assertIdentifier(transaction.id, `outboundTransactions[${index}].id`);
    assertSafePositiveInteger(transaction.quantity, `outboundTransactions[${index}].quantity`);
    if (transactionQuantities.has(transaction.id)) {
      inconsistent(`OUTBOUND流水标识重复：${transaction.id}`);
    }
    transactionQuantities.set(transaction.id, transaction.quantity);
    actualOutboundQuantity = safeAdd(actualOutboundQuantity, transaction.quantity, '实际OUTBOUND总量');
  }

  const boundByTransaction = new Map<string, number>();
  const sliceIds = new Set<string>();
  let boundShipmentQuantity = 0;
  for (const [index, slice] of shipmentSlices.entries()) {
    assertRecord(slice, `shipmentSlices[${index}]`);
    assertIdentifier(slice.id, `shipmentSlices[${index}].id`);
    assertIdentifier(slice.outboundTransactionId, `shipmentSlices[${index}].outboundTransactionId`);
    assertSafePositiveInteger(slice.quantity, `shipmentSlices[${index}].quantity`);
    if (sliceIds.has(slice.id)) {
      inconsistent(`发运切片标识重复：${slice.id}`);
    }
    sliceIds.add(slice.id);
    if (!transactionQuantities.has(slice.outboundTransactionId)) {
      inconsistent(`发运切片引用不存在的OUTBOUND流水：${slice.outboundTransactionId}`);
    }

    const nextBound = safeAdd(
      boundByTransaction.get(slice.outboundTransactionId) ?? 0,
      slice.quantity,
      `流水${slice.outboundTransactionId}已绑定发运量`,
    );
    const actual = transactionQuantities.get(slice.outboundTransactionId)!;
    if (nextBound > actual) {
      inconsistent(`流水${slice.outboundTransactionId}绑定发运量超过实际OUTBOUND量`);
    }
    boundByTransaction.set(slice.outboundTransactionId, nextBound);
    boundShipmentQuantity = safeAdd(boundShipmentQuantity, slice.quantity, '已绑定发运总量');
  }

  const byOutboundTransaction = [...transactionQuantities.entries()].map(([id, actual]) => {
    const bound = boundByTransaction.get(id) ?? 0;
    return {
      outboundTransactionId: id,
      actualOutboundQuantity: actual,
      boundShipmentQuantity: bound,
      shippableQuantity: safeDifference(actual, bound, `流水${id}可发运量`),
    };
  });

  return {
    actualOutboundQuantity,
    boundShipmentQuantity,
    shippableQuantity: safeDifference(actualOutboundQuantity, boundShipmentQuantity, '订单可发运总量'),
    byOutboundTransaction,
  };
}

/**
 * Calculate receipt and return headroom for one shipment line.
 *
 * Receipt and return quantities are independent cumulative facts. A refused
 * shipment may return before any customer receipt is recorded, so return
 * headroom is bounded by the original shipped quantity rather than receipt.
 * The order's delivered state remains derived from cumulative receipt facts.
 */
export function calculateShipmentLineQuantities(
  facts: ShipmentLineQuantityFacts,
): ShipmentLineQuantityResult {
  assertRecord(facts, 'shipmentLine');
  assertIdentifier(facts.shipmentLineId, 'shipmentLine.shipmentLineId');
  assertSafePositiveInteger(facts.shippedQuantity, 'shipmentLine.shippedQuantity');
  assertSafeNonNegativeInteger(facts.receivedQuantity, 'shipmentLine.receivedQuantity');
  assertSafeNonNegativeInteger(facts.returnedQuantity, 'shipmentLine.returnedQuantity');

  if (facts.receivedQuantity > facts.shippedQuantity) {
    inconsistent('累计签收量不能超过发运行数量');
  }
  if (facts.returnedQuantity > facts.shippedQuantity) {
    inconsistent('累计退货量不能超过发运行数量');
  }

  return {
    ...facts,
    remainingToReceive: safeDifference(facts.shippedQuantity, facts.receivedQuantity, '待签收量'),
    remainingToReturn: safeDifference(facts.shippedQuantity, facts.returnedQuantity, '可退货量'),
    fullyReceived: facts.receivedQuantity === facts.shippedQuantity,
  };
}

/**
 * Derive the order-level delivered flag from order-line quantities.
 *
 * `receivedQuantity` is cumulative customer receipt. It is intentionally
 * separate from OUTBOUND/shipped and from returns: an order is delivered only
 * when every non-empty order-line quantity has been fully received.
 */
export function deriveOrderDeliveryProgress(
  orderLines: readonly OrderLineDeliveryQuantity[],
): OrderDeliveryProgress {
  if (!Array.isArray(orderLines)) {
    inconsistent('订单行必须是数组');
  }

  const lineIds = new Set<string>();
  let requiredQuantity = 0;
  let receivedQuantity = 0;
  const lines = orderLines.map((line, index) => {
    assertRecord(line, `orderLines[${index}]`);
    assertIdentifier(line.orderLineId, `orderLines[${index}].orderLineId`);
    assertSafePositiveInteger(line.quantity, `orderLines[${index}].quantity`);
    assertSafeNonNegativeInteger(line.receivedQuantity, `orderLines[${index}].receivedQuantity`);
    if (lineIds.has(line.orderLineId)) {
      inconsistent(`订单行标识重复：${line.orderLineId}`);
    }
    lineIds.add(line.orderLineId);
    if (line.receivedQuantity > line.quantity) {
      inconsistent(`订单行${line.orderLineId}累计签收量超过应交量`);
    }

    requiredQuantity = safeAdd(requiredQuantity, line.quantity, '订单应交总量');
    receivedQuantity = safeAdd(receivedQuantity, line.receivedQuantity, '订单累计签收总量');
    return {
      ...line,
      remainingQuantity: safeDifference(line.quantity, line.receivedQuantity, `订单行${line.orderLineId}待签收量`),
      fullyReceived: line.receivedQuantity === line.quantity,
    };
  });

  return {
    requiredQuantity,
    receivedQuantity,
    remainingQuantity: safeDifference(requiredQuantity, receivedQuantity, '订单待签收总量'),
    complete: lines.length > 0 && lines.every((line) => line.fullyReceived),
    lines,
  };
}
