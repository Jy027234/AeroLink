import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';

// A receipt snapshot is a source of fulfillment evidence only while the
// current certificate is explicitly issued.  Unknown/future states must not
// become usable merely because they are absent from an invalid-state list.
const USABLE_CERTIFICATE_STATUS = 'ISSUED';

export type ReceiptCertificateReference = Readonly<{
  id: string;
  fileHash: string;
}>;

export type ReceiptCertificateRow = Readonly<{
  id: string;
  certificateNumber: string;
  partNumber: string;
  serialNumber: string | null;
  batchNumber: string | null;
  certificateType: string;
  status: string;
  expiryDate: Date | null;
  fileUrl: string | null;
  fileHash: string | null;
  updatedAt: Date;
}>;

const RECEIPT_LINE_SOURCE_SELECT = {
  id: true,
  qualitySnapshot: true,
  purchaseCommitmentLine: { select: { purchaseCommitment: { select: { supplierId: true, orderId: true } } } },
} as const satisfies Prisma.StockReceiptLineSelect;

export const RECEIPT_CERTIFICATE_SELECT = {
  id: true,
  certificateNumber: true,
  partNumber: true,
  serialNumber: true,
  batchNumber: true,
  certificateType: true,
  status: true,
  expiryDate: true,
  fileUrl: true,
  fileHash: true,
  updatedAt: true,
  supplierId: true,
  orderId: true,
  inventoryDetailId: true,
} as const satisfies Prisma.CertificateSelect;

type ReceiptLineSourceRow = Prisma.StockReceiptLineGetPayload<{ select: typeof RECEIPT_LINE_SOURCE_SELECT }>;
export type ReceiptCertificateCurrentRow = Prisma.CertificateGetPayload<{ select: typeof RECEIPT_CERTIFICATE_SELECT }>;

function stale(message: string): never {
  throw new AppError(message, 409, 'QUALITY_REVIEW_STALE');
}

function inconsistent(message: string): never {
  throw new AppError(message, 409, 'ALLOCATION_INCONSISTENT');
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) inconsistent(`${label}不能为空`);
  return value.trim();
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) inconsistent(`${label}格式无效`);
  return value as Record<string, unknown>;
}

function parseReferences(row: ReceiptLineSourceRow): ReceiptCertificateReference[] {
  const snapshot = object(row.qualitySnapshot, `收货行 ${row.id} qualitySnapshot`);
  const physical = object(snapshot.physical, `收货行 ${row.id} physical 快照`);
  const rawReferences = physical.certificateReferences;
  if (!Array.isArray(rawReferences)) inconsistent(`收货行 ${row.id} 缺少证书引用数组`);
  const references = rawReferences.map((value, index) => {
    const reference = object(value, `收货行 ${row.id} 证书引用 ${index + 1}`);
    return {
      id: text(reference.id, `收货行 ${row.id} 证书引用 id`),
      fileHash: text(reference.fileHash, `收货行 ${row.id} 证书引用 fileHash`),
    };
  });
  if (new Set(references.map((reference) => reference.id)).size !== references.length) {
    inconsistent(`收货行 ${row.id} 证书引用不能重复`);
  }
  return references;
}

function currentStatus(row: ReceiptCertificateCurrentRow): string {
  return row.status.trim().toUpperCase();
}

function assertCurrentCertificate(
  reference: ReceiptCertificateReference,
  row: ReceiptCertificateCurrentRow | undefined,
  now: Date,
): asserts row is ReceiptCertificateCurrentRow {
  if (!row) stale(`收货来源证书 ${reference.id} 当前记录不存在`);
  if (!row.fileHash || row.fileHash !== reference.fileHash) {
    stale(`收货来源证书 ${reference.id} 文件指纹已变化，请重新审核`);
  }
  if (currentStatus(row) !== USABLE_CERTIFICATE_STATUS) {
    stale(`收货来源证书 ${reference.id} 当前状态不可用于履约`);
  }
  if (row.expiryDate && row.expiryDate.getTime() <= now.getTime()) {
    stale(`收货来源证书 ${reference.id} 已过期，请重新审核`);
  }
}

/**
 * Read certificate identities only from accepted receipt lines for one
 * inventory detail.  The reference ids and file hashes are immutable facts
 * captured in the receipt quality snapshot; no part-number lookup is used.
 */
async function loadSourceLines(
  tx: Prisma.TransactionClient,
  inventoryDetailId: string,
) {
  const detailId = text(inventoryDetailId, 'inventoryDetailId');
  return tx.stockReceiptLine.findMany({
    where: { inventoryDetailId: detailId, status: 'ACCEPTED' },
    orderBy: { id: 'asc' },
    select: RECEIPT_LINE_SOURCE_SELECT,
  });
}

function referencesFromLines(lines: ReceiptLineSourceRow[]) {
  const byId = new Map<string, ReceiptCertificateReference>();
  for (const line of lines) {
    for (const reference of parseReferences(line)) {
      const previous = byId.get(reference.id);
      if (previous && previous.fileHash !== reference.fileHash) {
        inconsistent(`收货来源证书 ${reference.id} 在多个已验收快照中的文件指纹冲突`);
      }
      byId.set(reference.id, reference);
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadAcceptedReceiptCertificateReferences(tx: Prisma.TransactionClient, inventoryDetailId: string) {
  return referencesFromLines(await loadSourceLines(tx, inventoryDetailId));
}

/**
 * Resolve those exact references to current Certificate rows and fail closed
 * if a certificate disappeared, was revoked/expired, or its file hash changed.
 * The caller can merge the returned rows into its existing quality projection.
 */
export async function loadAcceptedReceiptCertificates(
  tx: Prisma.TransactionClient,
  inventoryDetailId: string,
  now = new Date(),
): Promise<ReceiptCertificateCurrentRow[]> {
  const lines = await loadSourceLines(tx, inventoryDetailId);
  const references = referencesFromLines(lines);
  if (references.length === 0) return [];
  const rows = await tx.certificate.findMany({
    where: { id: { in: references.map((reference) => reference.id) } },
    orderBy: { id: 'asc' },
    select: RECEIPT_CERTIFICATE_SELECT,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const reference of references) assertCurrentCertificate(reference, byId.get(reference.id), now);
  for (const line of lines) {
    const purchase = line.purchaseCommitmentLine.purchaseCommitment;
    for (const reference of parseReferences(line)) {
      const certificate = byId.get(reference.id)!;
      if (certificate.supplierId !== purchase.supplierId
        || (certificate.orderId !== null && certificate.orderId !== purchase.orderId)
        || (certificate.inventoryDetailId !== null && certificate.inventoryDetailId !== inventoryDetailId)) {
        stale(`收货来源证书 ${reference.id} 当前归属与原采购实物不一致`);
      }
    }
  }
  return references.map((reference) => byId.get(reference.id)!);
}
