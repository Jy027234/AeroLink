import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';

type Tx = Prisma.TransactionClient;

function blocked(message: string): never {
  throw new AppError(message, 409, 'RESOURCE_CONFLICT');
}

/**
 * A quarantined return is a separate physical custody fact.  Legacy writes
 * must never turn it saleable by changing only InventoryDetail.status or
 * quantity.  The generated Prisma client is part of this contract; a missing
 * returnHold delegate is therefore a programming/configuration error rather
 * than a reason to skip the guard.
 */
export async function assertNoOpenReturnHold(tx: Tx, inventoryDetailId: string) {
  const hold = await tx.returnHold.findFirst({
    where: { inventoryDetailId, status: { not: 'RELEASED' } },
    select: { id: true, status: true },
  });
  if (hold) blocked('库存明细存在待检退货，必须通过退货质量放行处理');
}

/** No delete or identity rewrite is allowed after a return has existed. */
export async function assertNoReturnHistory(tx: Tx, inventoryDetailId: string) {
  const hold = await tx.returnHold.findFirst({
    where: { inventoryDetailId },
    select: { id: true, status: true },
  });
  if (hold) blocked('库存明细已有退货隔离或放行历史，不能删除或重写库存身份');
}

type OutboundCoverage = {
  valid: Array<{ id: string; quantity: number }>;
  invalid: boolean;
};

async function loadOutboundCoverage(tx: Tx, inventoryDetailId: string) {
  const outbounds = await tx.inventoryTransaction.findMany({
    where: { inventoryDetailId, type: 'OUTBOUND' },
    select: { id: true, quantity: true },
  });
  const released = await tx.returnHold.findMany({
    where: { inventoryDetailId, status: 'RELEASED' },
    select: {
      id: true,
      quantity: true,
      returnTransactionId: true,
      shipmentLine: { select: { outboundTransactionId: true } },
      returnTransaction: { select: { id: true, type: true, inventoryDetailId: true, quantity: true } },
    },
  });
  const byOutbound = new Map<string, OutboundCoverage>();
  let orphanReleasedHold = false;
  const get = (outboundId: string) => {
    const existing = byOutbound.get(outboundId);
    if (existing) return existing;
    const created: OutboundCoverage = { valid: [], invalid: false };
    byOutbound.set(outboundId, created);
    return created;
  };

  for (const hold of released) {
    const outboundId = hold.shipmentLine?.outboundTransactionId;
    if (!outboundId) {
      // A released hold without a shipment-line mapping is legacy history that
      // cannot be safely associated with a particular OUTBOUND fact.
      orphanReleasedHold = true;
      for (const outbound of outbounds) get(outbound.id).invalid = true;
      continue;
    }
    if (!outbounds.some((outbound) => outbound.id === outboundId)) {
      orphanReleasedHold = true;
      for (const outbound of outbounds) get(outbound.id).invalid = true;
      continue;
    }
    const coverage = get(outboundId);
    const transaction = hold.returnTransaction;
    const valid = Boolean(
      hold.returnTransactionId
      && transaction?.id === hold.returnTransactionId
      && transaction.type === 'RETURN'
      && transaction.inventoryDetailId === inventoryDetailId
      && Number.isSafeInteger(hold.quantity)
      && hold.quantity > 0
      && transaction.quantity === hold.quantity,
    );
    if (valid) coverage.valid.push({ id: hold.id, quantity: hold.quantity });
    else coverage.invalid = true;
  }
  return { outbounds, byOutbound, orphanReleasedHold };
}

function outboundQuantity(outbound: { id: string; quantity: number }) {
  if (!Number.isSafeInteger(outbound.quantity) || outbound.quantity >= 0) {
    blocked('序号件出库流水数量无效，必须人工核实');
  }
  return Math.abs(outbound.quantity);
}

/**
 * Return receipt/release must refer to an OUTBOUND fact that is still
 * uncovered by a real RELEASED ReturnHold + RETURN pair. For serial stock,
 * the current shipment line must be the only uncovered outbound; no ordering
 * by timestamps or random UUIDs is used.
 */
export async function assertShipmentOutboundUnreturned(
  tx: Tx,
  args: { inventoryDetailId: string; outboundTransactionId: string; requireUniqueUncovered?: boolean },
) {
  const { outbounds, byOutbound, orphanReleasedHold } = await loadOutboundCoverage(tx, args.inventoryDetailId);
  if (orphanReleasedHold) blocked('退货历史无法映射到真实出库事实，必须人工核实');
  const targets = outbounds.filter((outbound) => outbound.id === args.outboundTransactionId);
  if (targets.length !== 1) blocked('退货对应的出库事实不存在或不唯一，必须人工核实');
  const target = targets[0];
  const targetCoverage = byOutbound.get(target.id) ?? { valid: [], invalid: false };
  const targetQuantity = outboundQuantity(target);
  const targetCovered = targetCoverage.valid.reduce((sum, hold) => sum + hold.quantity, 0);
  if (targetCoverage.invalid || targetCovered >= targetQuantity) {
    blocked('该出库事实已被退货放行覆盖，不能重复授权');
  }
  if (targetCovered < 0 || targetCovered > targetQuantity) {
    blocked('出库事实的退货覆盖数量无效，必须人工核实');
  }

  if (args.requireUniqueUncovered) {
    const uncovered = [] as string[];
    for (const outbound of outbounds) {
      const coverage = byOutbound.get(outbound.id) ?? { valid: [], invalid: false };
      const quantity = outboundQuantity(outbound);
      if (quantity !== 1) {
        blocked('序号件出库数量不是单件，必须人工核实');
      }
      const covered = coverage.valid.reduce((sum, hold) => sum + hold.quantity, 0);
      if (coverage.invalid || covered > quantity) {
        blocked('序号件历史出库退货映射无效，必须人工核实');
      }
      if (covered < quantity) uncovered.push(outbound.id);
    }
    if (uncovered.length !== 1 || uncovered[0] !== target.id) {
      blocked('序号件退货必须对应唯一尚未被受控退货覆盖的出库事实');
    }
  }
}

/**
 * Serial stock may be reused only after every historical OUTBOUND has exactly
 * one quantity-one released return and matching RETURN ledger row.
 */
export async function assertSerialReentryAllowed(
  tx: Tx,
  args: { inventoryDetailId: string; trackingType?: unknown; serialNumber?: unknown },
) {
  const serial = String(args.trackingType ?? '').trim().toUpperCase() === 'SERIAL'
    || (typeof args.serialNumber === 'string' && args.serialNumber.trim().length > 0);
  if (!serial) return;

  const { outbounds, byOutbound, orphanReleasedHold } = await loadOutboundCoverage(tx, args.inventoryDetailId);
  if (orphanReleasedHold) blocked('退货历史无法映射到真实出库事实，必须人工核实');
  for (const outbound of outbounds) {
    if (outboundQuantity(outbound) !== 1) {
      blocked('序号件历史出库数量不是单件，必须人工核实');
    }
    const coverage = byOutbound.get(outbound.id) ?? { valid: [], invalid: false };
    if (coverage.invalid || coverage.valid.length !== 1 || coverage.valid[0].quantity !== 1) {
      blocked('序号件已有未被唯一受控退货覆盖的出库事实，不能再次分配');
    }
  }
}

/** Shared guard for both D12 modern reserve and legacy reserve/outbound. */
export async function assertInventoryUseAllowed(
  tx: Tx,
  detail: { id: string; serialNumber?: unknown; inventoryItem?: { trackingType?: unknown } | null },
) {
  const serial = String(detail.inventoryItem?.trackingType ?? '').trim().toUpperCase() === 'SERIAL'
    || (typeof detail.serialNumber === 'string' && detail.serialNumber.trim().length > 0);
  // A batch return is physically isolated by quantity: the quarantined
  // amount is not in InventoryDetail.quantity, so existing saleable batch
  // stock may continue to move. A serial return must freeze the detail.
  if (serial) await assertNoOpenReturnHold(tx, detail.id);
  await assertSerialReentryAllowed(tx, {
    inventoryDetailId: detail.id,
    serialNumber: detail.serialNumber,
    trackingType: detail.inventoryItem?.trackingType,
  });
}

/**
 * Releasing a legacy reservation does not consume or re-enter stock. A
 * batch detail can therefore release the unrelated saleable reservation while
 * another quantity is quarantined; serial details remain isolated.
 */
export async function assertReservationReleaseAllowed(
  tx: Tx,
  detail: { id: string; serialNumber?: unknown; inventoryItem?: { trackingType?: unknown } | null },
) {
  const serial = String(detail.inventoryItem?.trackingType ?? '').trim().toUpperCase() === 'SERIAL'
    || (typeof detail.serialNumber === 'string' && detail.serialNumber.trim().length > 0);
  if (serial) await assertNoOpenReturnHold(tx, detail.id);
}
