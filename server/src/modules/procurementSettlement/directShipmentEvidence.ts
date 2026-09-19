import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { hasCapability, type CapabilityActor } from '../../lib/capabilityPolicy.js';
import { assertDirectShipmentOrderScope } from './directShipmentAccess.js';

type Tx = Prisma.TransactionClient;
export type DirectShipmentEvidence = { id: string; version: number; sha256: string; status: 'AVAILABLE' };
function invalid(message: string): never { throw new AppError(message, 409, 'QUALITY_EVIDENCE_INVALID'); }
function forbidden(): never { throw new AppError('无权访问此供应商直发证据', 403, 'AUTH_FORBIDDEN'); }
const select = { id: true, ownerId: true, domain: true, resourceId: true, status: true, version: true, sha256: true } as const;

function fingerprint(file: { id: string; version: number; sha256: string; status: string }): DirectShipmentEvidence {
  if (file.status !== 'AVAILABLE' || !Number.isInteger(file.version) || file.version < 1 || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
    invalid('供应商直发证据缺失、撤销或文件指纹无效');
  }
  return { id: file.id, version: file.version, sha256: file.sha256, status: 'AVAILABLE' };
}
function parse(value: unknown): DirectShipmentEvidence[] {
  if (!Array.isArray(value)) invalid('供应商直发证据快照无效');
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.sha256 !== 'string') invalid('供应商直发证据快照无效');
    return fingerprint(item);
  });
}
function same(a: DirectShipmentEvidence, b: DirectShipmentEvidence) {
  return a.id === b.id && a.version === b.version && a.sha256 === b.sha256 && a.status === b.status;
}
async function context(tx: Tx, actor: CapabilityActor, shipmentId: string, action: 'manage' | 'review' | 'evidence-read') {
  const shipment = await tx.supplierDirectShipment.findUnique({ where: { id: shipmentId }, select: { id: true, orderId: true } });
  if (!shipment) throw new AppError('供应商直发记录不存在', 404, 'RESOURCE_NOT_FOUND');
  if (action === 'evidence-read') {
    const access = await assertDirectShipmentOrderScope(tx, actor, shipment.orderId);
    if (!hasCapability(actor, 'inventory', 'manage', access.scope) && !hasCapability(actor, 'quality_review', 'approve', access.scope)) forbidden();
  } else await assertDirectShipmentOrderScope(tx, actor, shipment.orderId, action);
  return shipment;
}

/** Explicitly bind only the current actor's available uploads. Cost-domain
 * files cannot be reclassified as operational delivery evidence. */
export async function bindDirectShipmentEvidence(tx: Tx, actor: CapabilityActor, shipmentId: string,
  ids: string[], action: 'manage' | 'review'): Promise<DirectShipmentEvidence[]> {
  await context(tx, actor, shipmentId, action);
  if (ids.length > 20 || new Set(ids).size !== ids.length) invalid('直发证据数量过多或重复');
  const files = await tx.storedObject.findMany({ where: { id: { in: ids } }, select, orderBy: { id: 'asc' } });
  if (files.length !== ids.length) invalid('直发证据记录不存在');
  const result: DirectShipmentEvidence[] = [];
  for (const file of files) {
    fingerprint(file);
    if (file.ownerId !== actor.id) forbidden();
    if (file.domain === 'supplier_direct_shipment' && file.resourceId === shipmentId) {
      result.push(fingerprint(file)); continue;
    }
    if (file.resourceId !== null || (file.domain !== null && file.domain !== 'upload')) forbidden();
    const changed = await tx.storedObject.updateMany({ where: { id: file.id, ownerId: actor.id, status: 'AVAILABLE',
      version: file.version, sha256: file.sha256, domain: file.domain, resourceId: null },
      data: { domain: 'supplier_direct_shipment', resourceId: shipmentId, version: { increment: 1 } } });
    if (changed.count !== 1) invalid('直发证据在绑定期间已变化');
    result.push({ ...fingerprint(file), version: file.version + 1 });
  }
  return result;
}

export async function validateDirectShipmentEvidence(tx: Tx, actor: CapabilityActor, shipmentId: string, value: unknown) {
  await context(tx, actor, shipmentId, 'evidence-read');
  const expected = parse(value);
  if (new Set(expected.map(item => item.id)).size !== expected.length) invalid('直发证据快照重复');
  const files = await tx.storedObject.findMany({ where: { id: { in: expected.map(item => item.id) } }, select });
  for (const reference of expected) {
    const file = files.find(row => row.id === reference.id);
    if (!file || file.domain !== 'supplier_direct_shipment' || file.resourceId !== shipmentId || !same(reference, fingerprint(file))) {
      invalid('直发证据版本、归属或文件指纹已变化');
    }
  }
  return expected;
}

export async function assertCanReadDirectShipmentEvidence(tx: Tx, actor: CapabilityActor, objectId: string) {
  const file = await tx.storedObject.findUnique({ where: { id: objectId }, select });
  if (!file || file.domain !== 'supplier_direct_shipment' || !file.resourceId) forbidden();
  await context(tx, actor, file.resourceId, 'evidence-read');
  const shipment = await tx.supplierDirectShipment.findUniqueOrThrow({ where: { id: file.resourceId }, select: {
    evidence: true, lines: { select: { reviewEvidence: true } }, events: { select: { data: true } },
  } });
  const snapshots = [shipment.evidence, ...shipment.lines.map(line => line.reviewEvidence), ...shipment.events.map(event => {
    const data = event.data as Record<string, unknown> | null;
    return data && Array.isArray(data.evidence) ? data.evidence : [];
  })];
  const current = fingerprint(file);
  if (!snapshots.some(snapshot => parse(snapshot).some(reference => same(reference, current)))) forbidden();
}
