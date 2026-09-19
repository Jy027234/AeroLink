import { AppError } from '../../middleware/errorHandler.js';

export type PurchaseQuantityFact = {
  id: string;
  quantity: number;
  cancelledQuantity: number;
  /** Accepted, usable receipt quantity; excludes arrival-only, quarantine and rejection. */
  receivedQuantity: number;
  directShippedQuantity: number;
};

export type ProcurementStockAssignment = {
  id: string;
  purchaseLineId: string | null;
  assignedQuantity: number;
  releasedQuantity: number;
  consumedQuantity: number;
};

function invalid(message: string): never {
  throw new AppError(message, 409, 'ALLOCATION_INCONSISTENT');
}

function quantity(value: number, label: string, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > 2147483647) {
    invalid(`${label}必须是数据库可表示的${positive ? '正' : '非负'}整数`);
  }
  return value;
}

function sum(values: number[], label: string) {
  return values.reduce((total, value) => quantity(total + value, label), 0);
}

function uniqueIds(rows: Array<{ id: string }>, label: string) {
  if (rows.some(row => typeof row.id !== 'string' || !row.id.trim())
    || new Set(rows.map(row => row.id)).size !== rows.length) invalid(`${label}标识为空或重复`);
}

/**
 * One sales line can be covered by existing stock or by a purchase commitment.
 * Stock originating from that commitment remains part of the same coverage;
 * receiving and assigning it must not count the demand a second time.
 * Quantities are immutable/cumulative facts. Returns do not erase consumption.
 */
export function deriveProcurementCoverage(input: {
  orderQuantity: number;
  purchases: PurchaseQuantityFact[];
  assignments: ProcurementStockAssignment[];
}) {
  quantity(input.orderQuantity, '销售行数量', true);
  if (!Array.isArray(input.purchases) || !Array.isArray(input.assignments)) invalid('采购和分配事实必须是数组');
  uniqueIds(input.purchases, '采购行');
  uniqueIds(input.assignments, '分配');
  const byPurchase = new Map(input.purchases.map(line => [line.id, line]));
  const purchaseAssigned = new Map<string, number>();
  const purchaseConsumed = new Map<string, number>();
  let ownStockCoverage = 0;
  let stockConsumed = 0;
  for (const assignment of input.assignments) {
    quantity(assignment.assignedQuantity, '分配初始数量', true);
    quantity(assignment.releasedQuantity, '分配已释放数量');
    quantity(assignment.consumedQuantity, '分配已出库数量');
    if (assignment.releasedQuantity + assignment.consumedQuantity > assignment.assignedQuantity) invalid('释放及出库超过分配初始数量');
    const covered = assignment.assignedQuantity - assignment.releasedQuantity;
    stockConsumed = sum([stockConsumed, assignment.consumedQuantity], '库存出库合计');
    if (assignment.purchaseLineId !== null) {
      if (!byPurchase.has(assignment.purchaseLineId)) invalid('分配引用未知采购行');
      purchaseAssigned.set(assignment.purchaseLineId, sum([purchaseAssigned.get(assignment.purchaseLineId) ?? 0, covered], '采购分配数量'));
      purchaseConsumed.set(assignment.purchaseLineId, sum([purchaseConsumed.get(assignment.purchaseLineId) ?? 0, assignment.consumedQuantity], '采购库存出库数量'));
    } else ownStockCoverage = sum([ownStockCoverage, covered], '自有库存覆盖量');
  }
  const purchases = input.purchases.map(line => {
    quantity(line.quantity, '采购初始数量', true);
    quantity(line.cancelledQuantity, '采购取消数量');
    quantity(line.receivedQuantity, '采购收货数量');
    quantity(line.directShippedQuantity, '供应商直发数量');
    if (line.cancelledQuantity + line.receivedQuantity + line.directShippedQuantity > line.quantity) {
      invalid('取消、收货及直发数量超过采购承诺');
    }
    const assigned = purchaseAssigned.get(line.id) ?? 0;
    if (assigned > line.receivedQuantity) invalid('采购库存分配超过实际收货数量');
    return {
      purchaseLineId: line.id,
      committedQuantity: line.quantity - line.cancelledQuantity,
      outstandingQuantity: line.quantity - line.cancelledQuantity - line.receivedQuantity - line.directShippedQuantity,
      receivedQuantity: line.receivedQuantity,
      directShippedQuantity: line.directShippedQuantity,
      assignedReceivedQuantity: assigned,
      consumedReceivedQuantity: purchaseConsumed.get(line.id) ?? 0,
      unassignedReceivedQuantity: line.receivedQuantity - assigned,
    };
  });
  const committedPurchaseQuantity = sum(purchases.map(line => line.committedQuantity), '采购承诺合计');
  const coveredQuantity = sum([ownStockCoverage, committedPurchaseQuantity], '销售需求覆盖量');
  if (coveredQuantity > input.orderQuantity) invalid('库存及采购承诺合计超过销售行数量');
  const fulfilledQuantity = sum([stockConsumed, ...purchases.map(line => line.directShippedQuantity)], '实际履约合计');
  return {
    orderQuantity: input.orderQuantity,
    ownStockCoverage,
    committedPurchaseQuantity,
    coveredQuantity,
    uncoveredQuantity: input.orderQuantity - coveredQuantity,
    fulfilledQuantity,
    remainingToFulfill: input.orderQuantity - fulfilledQuantity,
    purchases,
  };
}
