import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import type { CapabilityActor } from '../../lib/capabilityPolicy.js';

export type ShipmentEvidence = {
  id: string;
  version: number;
  sha256: string;
  status: string;
};

const storedObjectSelect = {
  id: true,
  version: true,
  sha256: true,
  status: true,
  ownerId: true,
  domain: true,
  resourceId: true,
} as const satisfies Prisma.StoredObjectSelect;

type StoredObjectEvidenceRow = Prisma.StoredObjectGetPayload<{ select: typeof storedObjectSelect }>;

function evidenceError(message: string): never {
  throw new AppError(message, 409, 'QUALITY_EVIDENCE_INVALID');
}

function forbidden(message: string): never {
  throw new AppError(message, 403, 'AUTH_FORBIDDEN');
}

function conflict(message: string): never {
  throw new AppError(message, 409, 'RESOURCE_CONFLICT');
}

function normalizeEvidenceIds(evidenceIds: string[]): string[] {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0
    || evidenceIds.some(id => typeof id !== 'string' || id.trim().length === 0)) {
    evidenceError('至少提供一个有效的交付证据附件');
  }

  const normalized = evidenceIds.map(id => id.trim());
  if (new Set(normalized).size !== normalized.length) {
    evidenceError('交付证据附件不能重复');
  }
  return normalized;
}

function assertAvailableEvidence(row: StoredObjectEvidenceRow): void {
  if (row.status !== 'AVAILABLE' || !Number.isInteger(row.version) || row.version < 1
    || typeof row.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(row.sha256)) {
    evidenceError('交付证据不存在、已撤销或校验信息无效');
  }
}

function isOrderResource(row: StoredObjectEvidenceRow, orderId: string): boolean {
  return row.resourceId === orderId && (row.domain === 'order' || row.domain === 'orders');
}

/**
 * Validate and bind documents used by a new shipment/return command.
 *
 * The caller owns the surrounding Serializable transaction. Every new
 * submission must still be made by the document owner, including reuse of a
 * document already bound to this order. An unbound document is claimed with
 * a versioned CAS, while a document already bound to this order is left
 * untouched. A document bound to any other business object is never re-homed.
 */
export async function bindShipmentEvidence(
  tx: Prisma.TransactionClient,
  actor: CapabilityActor,
  evidenceIds: string[],
  orderId: string,
): Promise<ShipmentEvidence[]> {
  const ids = normalizeEvidenceIds(evidenceIds);
  if (typeof orderId !== 'string' || orderId.trim().length === 0) {
    evidenceError('订单标识无效，不能绑定交付证据');
  }
  if (!actor || typeof actor.id !== 'string' || actor.id.trim().length === 0) {
    forbidden('缺少有效的当前用户，不能绑定交付证据');
  }

  const rows = await tx.storedObject.findMany({
    where: { id: { in: ids } },
    orderBy: { id: 'asc' },
    select: storedObjectSelect,
  });

  if (rows.length !== ids.length) {
    evidenceError('交付证据不存在、已撤销或校验信息无效');
  }

  const rowById = new Map(rows.map(row => [row.id, row]));
  const orderedRows: StoredObjectEvidenceRow[] = [];
  for (const id of ids) {
    const row = rowById.get(id);
    if (!row) evidenceError('交付证据不存在、已撤销或校验信息无效');
    orderedRows.push(row);
  }

  for (const row of orderedRows) {
    assertAvailableEvidence(row);

    // This helper is only for a new shipment/return submission. Historical
    // evidence reads deliberately use a separate read path, so admin cannot
    // bypass ownership here, even when the document is already order-scoped.
    if (row.ownerId !== actor.id) {
      forbidden('只能提交当前用户本人上传的交付证据');
    }

    if (row.resourceId !== null && !isOrderResource(row, orderId)) {
      evidenceError('交付证据已绑定其他业务对象，不能复用到当前订单');
    }

  }

  const result: ShipmentEvidence[] = [];
  for (const row of orderedRows) {
    if (isOrderResource(row, orderId)) {
      result.push({ id: row.id, version: row.version, sha256: row.sha256, status: row.status });
      continue;
    }

    const claimed = await tx.storedObject.updateMany({
      where: {
        id: row.id,
        status: 'AVAILABLE',
        ownerId: actor.id,
        version: row.version,
        resourceId: null,
      },
      data: {
        domain: 'order',
        resourceId: orderId,
        version: { increment: 1 },
      },
    });

    if (claimed.count !== 1) {
      conflict('交付证据已被其他订单或用户占用，请刷新后重新选择');
    }

    result.push({ id: row.id, version: row.version + 1, sha256: row.sha256, status: row.status });
  }

  return result;
}
