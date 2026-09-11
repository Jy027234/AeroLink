/**
 * Pure reconciliation for supplier-direct delivery projections.
 *
 * Supplier-direct shipments do not create local inventory transactions.  Their
 * quantity therefore has to be reconciled against the purchase line, the
 * order line/header, and (when available) local shipment receipt facts without
 * folding the direct quantity into the local outbound ledger.
 */

export const ACTIVE_DIRECT_SHIPMENT_STATUSES = new Set([
  'DISPATCHED',
  'PARTIALLY_RECEIVED',
  'DELIVERED',
]);

export type DirectDeliveryReconciliationIssue = {
  entity: string;
  id: string;
  code: string;
  severity: 'BLOCKER';
  relatedIds?: string[];
  expected?: number | string;
  actual?: number | string;
};

export type DirectDeliveryOrderLine = {
  id: string;
  orderId: string;
  quantity: number;
  outboundQuantity: number;
  directShippedQuantity?: number;
};

export type DirectDeliveryOrder = {
  id: string;
  quantity: number;
  outboundQuantity: number;
  directShippedQuantity?: number;
  lineItemsMode?: boolean;
  status?: string;
  lines: DirectDeliveryOrderLine[];
};

export type DirectDeliveryPurchaseLine = {
  id: string;
  purchaseCommitmentId: string;
  orderLineId: string;
  quantity: number;
  cancelledQuantity: number;
  receivedQuantity: number;
  directShippedQuantity: number;
  fulfillmentMode: string;
};

export type DirectDeliveryLine = {
  id: string;
  shipmentId: string;
  shipmentStatus: string;
  orderId: string;
  orderLineId: string;
  purchaseCommitmentId: string;
  purchaseCommitmentLineId: string;
  quantity: number;
  receivedQuantity: number;
  reviewStatus: string;
};

export type DirectDeliveryLocalReceipt = {
  orderLineId: string;
  receivedQuantity: number;
};

export type DirectDeliveryReconciliationInput = {
  orders: DirectDeliveryOrder[];
  purchaseLines?: DirectDeliveryPurchaseLine[];
  directLines: DirectDeliveryLine[];
  localReceipts?: DirectDeliveryLocalReceipt[];
};

export type DirectDeliveryAggregate = {
  orderId: string;
  orderLineId: string;
  directShippedQuantity: number;
  directReceivedQuantity: number;
  localReceivedQuantity: number;
  totalReceivedQuantity: number;
  requiredQuantity: number;
  complete: boolean;
};

export type DirectPurchaseLineAggregate = {
  purchaseCommitmentLineId: string;
  directShippedQuantity: number;
  activeLineIds: string[];
};

export type DirectDeliveryReconciliationResult = {
  status: 'PASS' | 'BLOCKED';
  blockers: number;
  issues: DirectDeliveryReconciliationIssue[];
  byOrderLine: DirectDeliveryAggregate[];
  byPurchaseLine: DirectPurchaseLineAggregate[];
};

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function addIssue(
  issues: DirectDeliveryReconciliationIssue[],
  entity: string,
  id: string,
  code: string,
  relatedIds?: string[],
  expected?: number | string,
  actual?: number | string,
): void {
  issues.push({
    entity,
    id,
    code,
    severity: 'BLOCKER',
    ...(relatedIds?.length ? { relatedIds } : {}),
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  });
}

/**
 * Reconcile direct delivery facts.  The function is deliberately strict when
 * direct facts are present, while an omitted optional direct projection is
 * treated as the legacy zero value for old fixtures and old rows.
 */
export function reconcileDirectDeliveryProjection(
  input: DirectDeliveryReconciliationInput,
): DirectDeliveryReconciliationResult {
  const issues: DirectDeliveryReconciliationIssue[] = [];
  const orderById = new Map(input.orders.map(order => [order.id, order]));
  const orderLineById = new Map<string, DirectDeliveryOrderLine>();
  const orderByLineId = new Map<string, DirectDeliveryOrder>();
  for (const order of input.orders) {
    for (const line of order.lines) {
      if (orderLineById.has(line.id)) addIssue(issues, 'orderLines', line.id, 'DUPLICATE_ORDER_LINE_ID');
      orderLineById.set(line.id, line);
      orderByLineId.set(line.id, order);
      if (line.orderId !== order.id) addIssue(issues, 'orderLines', line.id, 'ORDER_OWNER_MISMATCH');
    }
  }

  const purchaseLineById = new Map<string, DirectDeliveryPurchaseLine>();
  for (const line of input.purchaseLines ?? []) {
    if (purchaseLineById.has(line.id)) addIssue(issues, 'purchaseCommitmentLines', line.id, 'DUPLICATE_PURCHASE_LINE_ID');
    purchaseLineById.set(line.id, line);
    if (!isNonNegativeSafeInteger(line.quantity) || line.quantity <= 0) {
      addIssue(issues, 'purchaseCommitmentLines', line.id, 'INVALID_PURCHASE_LINE_QUANTITY');
    }
    if (!isNonNegativeSafeInteger(line.cancelledQuantity)
      || !isNonNegativeSafeInteger(line.receivedQuantity)
      || !isNonNegativeSafeInteger(line.directShippedQuantity)) {
      addIssue(issues, 'purchaseCommitmentLines', line.id, 'INVALID_PURCHASE_LINE_COUNTER');
    }
    if (line.fulfillmentMode === 'SUPPLIER_DIRECT' && line.receivedQuantity !== 0) {
      addIssue(issues, 'purchaseCommitmentLines', line.id, 'DIRECT_PURCHASE_LINE_RECEIVED_NOT_ZERO', undefined, 0, line.receivedQuantity);
    }
  }

  const activeDirectByOrderLine = new Map<string, number>();
  const activeDirectReceivedByOrderLine = new Map<string, number>();
  const activeDirectByPurchaseLine = new Map<string, number>();
  const activeDirectIdsByPurchaseLine = new Map<string, string[]>();
  const activeDirectByOrder = new Map<string, number>();
  const activeDirectByShipment = new Map<string, { status: string; quantity: number; receivedQuantity: number; lineIds: string[] }>();
  const seenDirectLineIds = new Set<string>();

  for (const directLine of input.directLines) {
    if (seenDirectLineIds.has(directLine.id)) addIssue(issues, 'supplierDirectShipmentLines', directLine.id, 'DUPLICATE_DIRECT_LINE_ID');
    seenDirectLineIds.add(directLine.id);
    const active = ACTIVE_DIRECT_SHIPMENT_STATUSES.has(directLine.shipmentStatus);
    if (!active) continue;

    if (directLine.reviewStatus !== 'APPROVED') {
      addIssue(issues, 'supplierDirectShipmentLines', directLine.id, 'ACTIVE_DIRECT_LINE_NOT_APPROVED');
    }
    if (!isNonNegativeSafeInteger(directLine.quantity) || directLine.quantity <= 0) {
      addIssue(issues, 'supplierDirectShipmentLines', directLine.id, 'INVALID_DIRECT_LINE_QUANTITY');
      continue;
    }
    if (!isNonNegativeSafeInteger(directLine.receivedQuantity) || directLine.receivedQuantity > directLine.quantity) {
      addIssue(issues, 'supplierDirectShipmentLines', directLine.id, 'INVALID_DIRECT_LINE_RECEIVED_QUANTITY');
    }
    const orderLine = orderLineById.get(directLine.orderLineId);
    const order = orderById.get(directLine.orderId);
    if (!order || !orderLine || orderLine.orderId !== directLine.orderId) {
      addIssue(issues, 'supplierDirectShipmentLines', directLine.id, 'DIRECT_LINE_ORDER_OWNER_MISMATCH', [directLine.orderId, directLine.orderLineId]);
    }
    const purchaseLine = purchaseLineById.get(directLine.purchaseCommitmentLineId);
    if (!purchaseLine) {
      addIssue(issues, 'supplierDirectShipmentLines', directLine.id, 'MISSING_DIRECT_PURCHASE_LINE', [directLine.purchaseCommitmentLineId]);
    } else {
      if (purchaseLine.purchaseCommitmentId !== directLine.purchaseCommitmentId) {
        addIssue(issues, 'supplierDirectShipmentLines', directLine.id, 'DIRECT_PURCHASE_OWNER_MISMATCH', [purchaseLine.id, directLine.purchaseCommitmentId]);
      }
      if (purchaseLine.orderLineId !== directLine.orderLineId) {
        addIssue(issues, 'supplierDirectShipmentLines', directLine.id, 'DIRECT_PURCHASE_ORDER_LINE_MISMATCH', [purchaseLine.id, directLine.orderLineId]);
      }
      if (purchaseLine.fulfillmentMode !== 'SUPPLIER_DIRECT') {
        addIssue(issues, 'supplierDirectShipmentLines', directLine.id, 'DIRECT_PURCHASE_MODE_MISMATCH', [purchaseLine.id]);
      }
    }

    activeDirectByOrderLine.set(directLine.orderLineId,
      (activeDirectByOrderLine.get(directLine.orderLineId) ?? 0) + directLine.quantity);
    activeDirectReceivedByOrderLine.set(directLine.orderLineId,
      (activeDirectReceivedByOrderLine.get(directLine.orderLineId) ?? 0) + Math.min(directLine.receivedQuantity, directLine.quantity));
    activeDirectByOrder.set(directLine.orderId, (activeDirectByOrder.get(directLine.orderId) ?? 0) + directLine.quantity);
    const shipmentAggregate = activeDirectByShipment.get(directLine.shipmentId) ?? {
      status: directLine.shipmentStatus,
      quantity: 0,
      receivedQuantity: 0,
      lineIds: [],
    };
    shipmentAggregate.quantity += directLine.quantity;
    shipmentAggregate.receivedQuantity += Math.min(directLine.receivedQuantity, directLine.quantity);
    shipmentAggregate.lineIds.push(directLine.id);
    activeDirectByShipment.set(directLine.shipmentId, shipmentAggregate);
    activeDirectByPurchaseLine.set(directLine.purchaseCommitmentLineId,
      (activeDirectByPurchaseLine.get(directLine.purchaseCommitmentLineId) ?? 0) + directLine.quantity);
    activeDirectIdsByPurchaseLine.set(directLine.purchaseCommitmentLineId, [
      ...(activeDirectIdsByPurchaseLine.get(directLine.purchaseCommitmentLineId) ?? []),
      directLine.id,
    ]);
  }

  for (const [shipmentId, shipment] of activeDirectByShipment) {
    const fullyReceived = shipment.quantity > 0 && shipment.receivedQuantity === shipment.quantity;
    const partiallyReceived = shipment.receivedQuantity > 0 && !fullyReceived;
    const statusMatches = shipment.status === 'DISPATCHED' ? shipment.receivedQuantity === 0
      : shipment.status === 'PARTIALLY_RECEIVED' ? partiallyReceived
        : shipment.status === 'DELIVERED' ? fullyReceived : true;
    if (!statusMatches) {
      addIssue(issues, 'supplierDirectShipments', shipmentId, 'DIRECT_SHIPMENT_STATUS_MISMATCH', shipment.lineIds);
    }
  }

  for (const purchaseLine of input.purchaseLines ?? []) {
    const actual = activeDirectByPurchaseLine.get(purchaseLine.id) ?? 0;
    const relevant = purchaseLine.fulfillmentMode === 'SUPPLIER_DIRECT'
      || actual > 0
      || purchaseLine.directShippedQuantity > 0;
    if (!relevant) continue;
    if (purchaseLine.directShippedQuantity !== actual) {
      addIssue(issues, 'purchaseCommitmentLines', purchaseLine.id, 'DIRECT_SHIPPED_PURCHASE_LINE_MISMATCH',
        activeDirectIdsByPurchaseLine.get(purchaseLine.id), purchaseLine.directShippedQuantity, actual);
    }
    if (actual + purchaseLine.cancelledQuantity + purchaseLine.receivedQuantity > purchaseLine.quantity) {
      addIssue(issues, 'purchaseCommitmentLines', purchaseLine.id, 'DIRECT_PURCHASE_CAPACITY_EXCEEDED',
        activeDirectIdsByPurchaseLine.get(purchaseLine.id), purchaseLine.quantity,
        actual + purchaseLine.cancelledQuantity + purchaseLine.receivedQuantity);
    }
  }

  const localReceivedByOrderLine = new Map<string, number>();
  for (const receipt of input.localReceipts ?? []) {
    if (!isNonNegativeSafeInteger(receipt.receivedQuantity)) {
      addIssue(issues, 'orderLines', receipt.orderLineId, 'INVALID_LOCAL_RECEIVED_QUANTITY');
      continue;
    }
    localReceivedByOrderLine.set(receipt.orderLineId,
      (localReceivedByOrderLine.get(receipt.orderLineId) ?? 0) + receipt.receivedQuantity);
  }

  const byOrderLine: DirectDeliveryAggregate[] = [];
  for (const order of input.orders) {
    const orderDirectProjection = order.directShippedQuantity ?? 0;
    const expectedLineDirect = order.lines.reduce((sum, line) => sum + (line.directShippedQuantity ?? 0), 0);
    const actualOrderDirect = activeDirectByOrder.get(order.id) ?? 0;
    if (!isNonNegativeSafeInteger(orderDirectProjection) || orderDirectProjection > order.quantity) {
      addIssue(issues, 'orders', order.id, 'INVALID_DIRECT_SHIPPED_QUANTITY');
    }
    if (orderDirectProjection !== expectedLineDirect) {
      addIssue(issues, 'orders', order.id, 'DIRECT_SHIPPED_HEADER_MISMATCH', undefined, expectedLineDirect, orderDirectProjection);
    }
    if (orderDirectProjection !== actualOrderDirect) {
      addIssue(issues, 'orders', order.id, 'DIRECT_SHIPPED_ACTIVE_HEADER_MISMATCH', undefined, actualOrderDirect, orderDirectProjection);
    }
    if (!isNonNegativeSafeInteger(order.outboundQuantity) || order.outboundQuantity + orderDirectProjection > order.quantity) {
      addIssue(issues, 'orders', order.id, 'LOCAL_DIRECT_QUANTITY_OVERLAP', undefined, order.quantity,
        order.outboundQuantity + orderDirectProjection);
    }

    let complete = order.lines.length > 0;
    for (const line of order.lines) {
      const direct = line.directShippedQuantity ?? 0;
      const actualDirect = activeDirectByOrderLine.get(line.id) ?? 0;
      const directReceived = activeDirectReceivedByOrderLine.get(line.id) ?? 0;
      const localReceived = localReceivedByOrderLine.get(line.id) ?? 0;
      const totalReceived = directReceived + localReceived;
      if (!isNonNegativeSafeInteger(direct) || direct > line.quantity) {
        addIssue(issues, 'orderLines', line.id, 'INVALID_DIRECT_SHIPPED_QUANTITY');
      }
      if (direct !== actualDirect) {
        addIssue(issues, 'orderLines', line.id, 'DIRECT_SHIPPED_LINE_MISMATCH', undefined, actualDirect, direct);
      }
      if (!isNonNegativeSafeInteger(line.outboundQuantity) || line.outboundQuantity + direct > line.quantity) {
        addIssue(issues, 'orderLines', line.id, 'LOCAL_DIRECT_QUANTITY_OVERLAP', undefined, line.quantity,
          line.outboundQuantity + direct);
      }
      if (localReceived > line.outboundQuantity) {
        addIssue(issues, 'orderLines', line.id, 'LOCAL_RECEIVED_EXCEEDS_OUTBOUND', undefined, line.outboundQuantity, localReceived);
      }
      if (directReceived > actualDirect) {
        addIssue(issues, 'orderLines', line.id, 'DIRECT_RECEIVED_EXCEEDS_SHIPPED', undefined, actualDirect, directReceived);
      }
      if (totalReceived > line.quantity) {
        addIssue(issues, 'orderLines', line.id, 'MIXED_RECEIVED_QUANTITY_EXCEEDED', undefined, line.quantity, totalReceived);
      }
      const lineComplete = totalReceived === line.quantity;
      complete = complete && lineComplete;
      byOrderLine.push({
        orderId: order.id,
        orderLineId: line.id,
        directShippedQuantity: actualDirect,
        directReceivedQuantity: directReceived,
        localReceivedQuantity: localReceived,
        totalReceivedQuantity: totalReceived,
        requiredQuantity: line.quantity,
        complete: lineComplete,
      });
    }
    const hasReceiptEvidence = order.lines.some(line => localReceivedByOrderLine.has(line.id));
    if (order.status !== undefined && (order.lineItemsMode === true || actualOrderDirect > 0 || hasReceiptEvidence)) {
      const terminal = order.status === 'DELIVERED' || order.status === 'COMPLETED';
      if (complete !== terminal) addIssue(issues, 'orders', order.id, 'MIXED_DELIVERY_STATUS_MISMATCH');
    }
  }

  const byPurchaseLine = [...activeDirectByPurchaseLine.entries()].map(([purchaseCommitmentLineId, directShippedQuantity]) => ({
    purchaseCommitmentLineId,
    directShippedQuantity,
    activeLineIds: activeDirectIdsByPurchaseLine.get(purchaseCommitmentLineId) ?? [],
  }));
  return {
    status: issues.length ? 'BLOCKED' : 'PASS',
    blockers: issues.length,
    issues,
    byOrderLine,
    byPurchaseLine,
  };
}
