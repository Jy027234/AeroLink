import { AppError } from '../../middleware/errorHandler.js';

export type ReceiptStockSource = {
  id: string; purchaseCommitmentLineId: string; orderLineId: string;
  inventoryDetailId: string | null; quantity: number; status: 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED';
};
export type ReturnedStockSource = {
  id: string; inventoryDetailId: string; quantity: number; status: string;
};
export type SourcedAllocation = {
  id: string; inventoryDetailId: string; stockReceiptLineId: string | null; sourceReturnHoldId: string | null;
  allocatedQuantity: number; releasedQuantity: number; consumedQuantity: number;
  assignments: Array<{ id: string; orderLineId: string; assignedQuantity: number; releasedQuantity: number; consumedQuantity: number }>;
};
function invalid(message: string): never { throw new AppError(message, 409, 'ALLOCATION_INCONSISTENT'); }
function count(value: number, positive = false) {
  if (!Number.isInteger(value) || value < (positive ? 1 : 0) || value > 2147483647) invalid('库存来源数量必须为有效整数');
  return value;
}
function unique(rows: Array<{ id: string }>, name: string) {
  if (rows.some(row => typeof row.id !== 'string' || !row.id.trim()) || new Set(rows.map(row => row.id)).size !== rows.length) invalid(`${name}标识为空或重复`);
}

/** Preserve physical source separately from sales-demand coverage. A received
 * purchase unit occupies its original purchase demand only once. After a real
 * released return, resale consumes a separate return pool and covers new OWN
 * demand; it never replenishes the historical procurement receipt pool. */
export function deriveReceiptAllocationSources(input: {
  receipts: ReceiptStockSource[]; returns: ReturnedStockSource[]; allocations: SourcedAllocation[];
}) {
  unique(input.receipts, '收货行'); unique(input.returns, '退货行'); unique(input.allocations, '分配');
  const receipts = new Map(input.receipts.map(row => [row.id, row]));
  const returns = new Map(input.returns.map(row => [row.id, row]));
  const receiptDetailIds = new Set(input.receipts.map(row => row.inventoryDetailId).filter(Boolean));
  const usedReceipts = new Map<string, number>(); const usedReturns = new Map<string, number>();
  for (const row of input.receipts) count(row.quantity, true);
  for (const row of input.returns) count(row.quantity, true);
  const assignments = [] as Array<{ assignmentId: string; purchaseLineId: string | null; orderLineId: string }>;
  for (const allocation of input.allocations) {
    count(allocation.allocatedQuantity, true); count(allocation.releasedQuantity); count(allocation.consumedQuantity);
    if (allocation.releasedQuantity + allocation.consumedQuantity > allocation.allocatedQuantity) invalid('库存分配释放及消费超过初始量');
    if (allocation.stockReceiptLineId && allocation.sourceReturnHoldId) invalid('一次分配不能同时消费原始采购和退货池');
    let purchaseLineId: string | null = null;
    let originOrderLineId: string | null = null;
    const used = allocation.allocatedQuantity - allocation.releasedQuantity;
    if (allocation.stockReceiptLineId) {
      const receipt = receipts.get(allocation.stockReceiptLineId);
      if (!receipt || receipt.status !== 'ACCEPTED' || !receipt.inventoryDetailId
        || receipt.inventoryDetailId !== allocation.inventoryDetailId) invalid('分配缺少同一实物的验收收货来源');
      purchaseLineId = receipt.purchaseCommitmentLineId; originOrderLineId = receipt.orderLineId;
      const total = count((usedReceipts.get(receipt.id) ?? 0) + used);
      if (total > receipt.quantity) invalid('原始采购库存分配超过验收量，退货不能补回采购来源池');
      usedReceipts.set(receipt.id, total);
    } else if (allocation.sourceReturnHoldId) {
      const returned = returns.get(allocation.sourceReturnHoldId);
      if (!returned || returned.status !== 'RELEASED' || returned.inventoryDetailId !== allocation.inventoryDetailId) invalid('分配缺少同一实物的已放行退货来源');
      const total = count((usedReturns.get(returned.id) ?? 0) + used);
      if (total > returned.quantity) invalid('退货复售分配超过真实放行退货量');
      usedReturns.set(returned.id, total);
    } else if (receiptDetailIds.has(allocation.inventoryDetailId)) invalid('采购来源库存不能省略收货或退货来源');
    unique(allocation.assignments, '订单分配');
    let assigned = 0; let consumed = 0;
    for (const assignment of allocation.assignments) {
      count(assignment.assignedQuantity, true); count(assignment.releasedQuantity); count(assignment.consumedQuantity);
      if (assignment.releasedQuantity + assignment.consumedQuantity > assignment.assignedQuantity) invalid('订单分配释放及消费超过初始量');
      if (originOrderLineId && assignment.orderLineId !== originOrderLineId) invalid('原始采购库存只能履约对应的销售行');
      assigned = count(assigned + assignment.assignedQuantity - assignment.releasedQuantity);
      consumed = count(consumed + assignment.consumedQuantity);
      assignments.push({ assignmentId: assignment.id, purchaseLineId, orderLineId: assignment.orderLineId });
    }
    if (assigned > used || consumed !== allocation.consumedQuantity) invalid('来源分配与订单分配数量不一致');
    if (originOrderLineId && (allocation.assignments.length === 0 || assigned !== used)) {
      invalid('采购收货分配必须完整绑定原销售行，不能留下未关联数量');
    }
  }
  unique(assignments.map(row => ({ id: row.assignmentId })), '订单分配');
  return { assignments,
    receipts: input.receipts.map(row => ({ receiptLineId: row.id, committedQuantity: usedReceipts.get(row.id) ?? 0,
      remainingQuantity: row.status === 'ACCEPTED' ? row.quantity - (usedReceipts.get(row.id) ?? 0) : 0 })),
    returns: input.returns.map(row => ({ returnHoldId: row.id, committedQuantity: usedReturns.get(row.id) ?? 0,
      remainingQuantity: row.status === 'RELEASED' ? row.quantity - (usedReturns.get(row.id) ?? 0) : 0 })),
  };
}
