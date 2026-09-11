import type { Prisma } from '@prisma/client';
import type { CapabilityActor } from '../../lib/capabilityPolicy.js';
import { AppError } from '../../middleware/errorHandler.js';
import { assertSettlementOrderScope } from './settlementAccess.js';

type Tx = Prisma.TransactionClient;
export const SETTLEMENT_EVIDENCE_DOMAIN = 'settlement_account';
export type SettlementEvidence = { id: string; version: number; sha256: string; status: 'AVAILABLE' };
const fileSelect = { id: true, ownerId: true, domain: true, resourceId: true, version: true, status: true, sha256: true } as const;
function invalid(): never { throw new AppError('结算凭证缺失、已变化或不属于当前操作人', 409, 'RESOURCE_CONFLICT'); }

/** Evidence is freshly uploaded by the current financial operator and bound once.
 * Historical records keep their original fingerprint even if a file is revoked;
 * corrections use a separate reversal, never silently erase cash movements. */
export async function bindSettlementEvidence(tx: Tx, actor: CapabilityActor, accountId: string, ids: string[]) {
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) invalid();
  const files = await tx.storedObject.findMany({ where: { id: { in: ids } }, select: fileSelect, orderBy: { id: 'asc' } });
  if (files.length !== ids.length) invalid();
  const fingerprints: SettlementEvidence[] = [];
  for (const file of files) {
    if (file.ownerId !== actor.id || file.status !== 'AVAILABLE' || !Number.isInteger(file.version) || file.version < 1
      || !/^[a-f0-9]{64}$/i.test(file.sha256) || file.resourceId !== null
      || (file.domain !== null && !['upload', 'uploads'].includes(file.domain))) invalid();
    const changed = await tx.storedObject.updateMany({ where: { ...file },
      data: { domain: SETTLEMENT_EVIDENCE_DOMAIN, resourceId: accountId, version: { increment: 1 } } });
    if (changed.count !== 1) invalid();
    fingerprints.push({ id: file.id, version: file.version + 1, sha256: file.sha256, status: 'AVAILABLE' });
  }
  return fingerprints;
}

export async function assertCanReadSettlementEvidence(tx: Tx, actor: CapabilityActor, objectId: string) {
  const file = await tx.storedObject.findUnique({ where: { id: objectId }, select: fileSelect });
  if (!file || file.domain !== SETTLEMENT_EVIDENCE_DOMAIN || !file.resourceId || file.status !== 'AVAILABLE') {
    throw new AppError('无权访问此结算凭证', 403, 'AUTH_FORBIDDEN');
  }
  const account = await tx.settlementAccount.findUnique({ where: { id: file.resourceId }, select: {
    orderId: true, side: true, records: { select: { evidence: true } },
  } });
  if (!account) throw new AppError('无权访问此结算凭证', 403, 'AUTH_FORBIDDEN');
  await assertSettlementOrderScope(tx, actor, account.orderId, account.side);
  const matches = account.records.some(record => Array.isArray(record.evidence) && record.evidence.some(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return value.id === file.id && value.version === file.version && value.sha256 === file.sha256 && value.status === file.status;
  }));
  if (!matches) throw new AppError('凭证版本与结算记录不一致', 409, 'RESOURCE_CONFLICT');
}
