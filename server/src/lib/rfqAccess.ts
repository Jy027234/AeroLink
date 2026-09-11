import type { Prisma } from '@prisma/client';
import { getCapabilityScope, type CapabilityActor } from './capabilityPolicy.js';

export function buildRfqReadScope(actor: CapabilityActor): Prisma.RFQWhereInput {
  const scope = getCapabilityScope(actor, 'rfq.read');
  if (scope === 'all') return {};
  if (!scope) return { id: { in: [] } };
  const own: Prisma.RFQWhereInput = { createdBy: actor.id };
  const department: Prisma.RFQWhereInput | undefined = actor.department
    ? { creator: { is: { department: actor.department } } } : undefined;
  if (scope === 'department') return department ?? { id: { in: [] } };
  if (scope === 'department_or_own') return department ? { OR: [own, department] } : own;
  return own;
}
