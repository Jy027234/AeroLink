import type { Prisma } from '@prisma/client';
import { hasCapability, type CapabilityActor } from '../../lib/capabilityPolicy.js';

export async function canReadPurchaseEvidence(tx: Prisma.TransactionClient, object: {
  id: string; domain: string | null; resourceId: string | null;
  version: number; sha256: string; status: string;
}, actor: CapabilityActor | undefined) {
  if (!actor || object.domain !== 'purchase_commitment' || !object.resourceId || object.status !== 'AVAILABLE'
    || !hasCapability(actor, 'purchase_commitment', 'view_cost')) return false;
  const purchase = await tx.purchaseCommitment.findUnique({ where: { id: object.resourceId }, select: {
    confirmationEvidence: true, lines: { select: { sourceSnapshot: true } },
    order: { select: { quotation: { select: { createdBy: true, creator: { select: { department: true } } } } } },
  } });
  if (!purchase) return false;
  const quotation = purchase.order.quotation;
  const scope = { ownerId: quotation.createdBy, department: quotation.creator.department };
  if (!hasCapability(actor, 'order', 'read', scope) || !hasCapability(actor, 'purchase_commitment', 'read', scope)
    || !hasCapability(actor, 'purchase_commitment', 'view_cost', scope)) return false;
  const matches = (value: unknown) => Array.isArray(value) && value.some(item => item && typeof item === 'object'
    && item.id === object.id && item.version === object.version && item.sha256 === object.sha256 && item.status === object.status);
  if (matches(purchase.confirmationEvidence)) return true;
  return purchase.lines.some(line => {
    const source = line.sourceSnapshot;
    return source && typeof source === 'object' && !Array.isArray(source) && source.type === 'MANUAL' && matches(source.evidence);
  });
}
