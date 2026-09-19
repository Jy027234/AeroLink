import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { hasCapability, type CapabilityAction, type CapabilityActor } from '../../lib/capabilityPolicy.js';
import { deriveSettlementAmounts, type SettlementEvent } from './settlementAmounts.js';

type Tx = Prisma.TransactionClient;
export async function assertSettlementOrderScope(tx: Tx, actor: CapabilityActor, orderId: string,
  side?: 'RECEIVABLE' | 'PAYABLE', action: CapabilityAction = 'read') {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: {
    id: true, orderNumber: true, lineItemsMode: true, status: true, version: true, totalAmountDecimal: true,
    customerId: true, customer: { select: { name: true } },
    quotation: { select: { currency: true, createdBy: true, creator: { select: { department: true } } } },
  } });
  if (!order) throw new AppError('销售订单不存在', 404, 'RESOURCE_NOT_FOUND');
  const scope = { ownerId: order.quotation.createdBy, department: order.quotation.creator.department };
  const canViewCost = hasCapability(actor, 'settlement', 'view_cost', scope);
  if (!hasCapability(actor, 'order', 'read', scope) || !hasCapability(actor, 'settlement', action, scope)
    || (side === 'PAYABLE' && !canViewCost)) {
    throw new AppError('无权处理此交易的结算记录', 403, 'AUTH_FORBIDDEN');
  }
  if (!order.lineItemsMode) throw new AppError('旧订单需先核实并迁移交易来源，不能自动建立结算事实', 409, 'RESOURCE_CONFLICT');
  return { order, scope, canViewCost };
}

export const settlementReadInclude = {
  records: { orderBy: { accountVersion: 'asc' as const }, include: { actor: { select: { name: true } } } },
} satisfies Prisma.SettlementAccountInclude;
type Account = Prisma.SettlementAccountGetPayload<{ include: typeof settlementReadInclude }>;

export function settlementBalance(account: Pick<Account, 'side' | 'initialAmount' | 'records'>) {
  const events: SettlementEvent[] = account.records.filter(record => !['OPEN', 'TERMS'].includes(record.kind)).map(record => ({
    id: record.id, kind: record.kind as SettlementEvent['kind'], side: account.side,
    amount: record.amount!, currency: 'USD', reversalOfId: record.reversalOfId,
  }));
  const amounts = deriveSettlementAmounts({ currency: 'USD',
    initialReceivable: account.side === 'RECEIVABLE' ? account.initialAmount : '0',
    initialPayable: account.side === 'PAYABLE' ? account.initialAmount : '0', events });
  return account.side === 'RECEIVABLE' ? amounts.receivable : amounts.payable;
}

/** Construct a side-specific response after current scope and cost authorization.
 * Cached command results contain IDs only; never cache this financial projection. */
export function projectSettlementAccount(account: Account) {
  const amounts = settlementBalance(account);
  return {
    id: account.id, side: account.side, orderId: account.orderId, purchaseCommitmentId: account.purchaseCommitmentId,
    currency: account.currency, initialAmount: account.initialAmount.toFixed(4), sourceSnapshot: account.sourceSnapshot,
    dueDate: account.dueDate, version: account.version, createdAt: account.createdAt,
    amounts: Object.fromEntries(Object.entries(amounts).map(([key, amount]) => [key, amount.toFixed(4)])),
    records: account.records.map(record => ({
      id: record.id, kind: record.kind, version: record.accountVersion, amount: record.amount?.toFixed(4) ?? null,
      dueDate: record.dueDate, occurredAt: record.occurredAt, externalSystem: record.externalSystem,
      voucherNumber: record.voucherNumber, voucherLine: record.voucherLine, reason: record.reason,
      evidence: record.evidence, reversalOfId: record.reversalOfId, actorName: record.actor.name, createdAt: record.createdAt,
    })),
  };
}

export async function getSettlementAccount(tx: Tx, actor: CapabilityActor, accountId: string) {
  const account = await tx.settlementAccount.findUnique({ where: { id: accountId }, include: settlementReadInclude });
  if (!account) throw new AppError('结算记录不存在', 404, 'RESOURCE_NOT_FOUND');
  await assertSettlementOrderScope(tx, actor, account.orderId, account.side);
  return projectSettlementAccount(account);
}

export async function getOrderSettlements(tx: Tx, actor: CapabilityActor, orderId: string) {
  const access = await assertSettlementOrderScope(tx, actor, orderId);
  const accounts = await tx.settlementAccount.findMany({
    where: { orderId, ...(!access.canViewCost ? { side: 'RECEIVABLE' as const } : {}) },
    include: settlementReadInclude, orderBy: { createdAt: 'asc' },
  });
  return { orderId, accounts: accounts.map(projectSettlementAccount) };
}
