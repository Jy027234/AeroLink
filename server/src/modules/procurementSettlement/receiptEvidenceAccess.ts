import type { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/errorHandler.js';
import { hasCapability, type CapabilityActor } from '../../lib/capabilityPolicy.js';

export const STOCK_RECEIPT_EVIDENCE_DOMAIN = 'stock_receipt' as const;

export type ReceiptEvidenceFingerprint = Readonly<{
  id: string;
  version: number;
  sha256: string;
  status: 'AVAILABLE';
}>;

export type BindReceiptEvidenceInput = Readonly<{
  tx: Prisma.TransactionClient;
  actor: CapabilityActor;
  receiptId: string;
  evidenceIds: readonly string[];
}>;

export type ReceiptEvidenceReadContext = Readonly<{
  receiptId: string;
  orderId: string;
}>;

export type ReceiptStoredObject = Readonly<{
  id: string;
  version: number;
  sha256: string;
  status: string;
  ownerId?: string | null;
  domain: string | null;
  resourceId: string | null;
}>;

const RECEIPT_SCOPE_SELECT = {
  id: true,
  evidence: true,
  purchaseCommitment: {
    select: {
      order: {
        select: {
          id: true,
          quotation: {
            select: {
              createdBy: true,
              creator: { select: { department: true } },
            },
          },
        },
      },
    },
  },
} as const satisfies Prisma.StockReceiptSelect;

const STORED_OBJECT_SELECT = {
  id: true,
  version: true,
  sha256: true,
  status: true,
  ownerId: true,
  domain: true,
  resourceId: true,
} as const satisfies Prisma.StoredObjectSelect;

type ReceiptScopeRow = Prisma.StockReceiptGetPayload<{ select: typeof RECEIPT_SCOPE_SELECT }>;
type StoredObjectRow = Prisma.StoredObjectGetPayload<{ select: typeof STORED_OBJECT_SELECT }>;

function evidenceInvalid(message: string): never {
  throw new AppError(message, 409, 'QUALITY_EVIDENCE_INVALID');
}

function forbidden(message: string): never {
  throw new AppError(message, 403, 'AUTH_FORBIDDEN');
}

function notFound(message: string): never {
  throw new AppError(message, 404, 'RESOURCE_NOT_FOUND');
}

function conflict(message: string): never {
  throw new AppError(message, 409, 'RESOURCE_CONFLICT');
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) evidenceInvalid(`${field}不能为空`);
  return value.trim();
}

function normalizeIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) evidenceInvalid('收货证据至少需要一个附件');
  const ids = value.map((item) => text(item, '收货证据附件 id'));
  if (new Set(ids).size !== ids.length) evidenceInvalid('收货证据附件不能重复');
  return ids;
}

function assertActor(actor: CapabilityActor | undefined): asserts actor is CapabilityActor {
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim()) forbidden('缺少有效的当前用户');
}

function assertAvailableRow(row: StoredObjectRow): void {
  if (row.status !== 'AVAILABLE' || !Number.isInteger(row.version) || row.version < 1
    || typeof row.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(row.sha256)) {
    evidenceInvalid('收货证据不存在、已撤销或校验信息无效');
  }
}

function fingerprint(row: StoredObjectRow): ReceiptEvidenceFingerprint {
  assertAvailableRow(row);
  return { id: row.id, version: row.version, sha256: row.sha256, status: 'AVAILABLE' };
}

function exactFingerprint(value: unknown): ReceiptEvidenceFingerprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    evidenceInvalid('收货证据快照格式无效');
  }
  const row = value as Record<string, unknown>;
  const id = text(row.id, '收货证据快照 id');
  if (!Number.isInteger(row.version) || (row.version as number) < 1) evidenceInvalid('收货证据快照版本无效');
  if (typeof row.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(row.sha256)) {
    evidenceInvalid('收货证据快照哈希无效');
  }
  if (row.status !== 'AVAILABLE') evidenceInvalid('收货证据快照必须来自 AVAILABLE 文件');
  return { id, version: row.version as number, sha256: row.sha256, status: 'AVAILABLE' };
}

function receiptEvidence(value: unknown): ReceiptEvidenceFingerprint[] {
  if (!Array.isArray(value)) evidenceInvalid('收货 evidence 必须是附件快照数组');
  const result = value.map(exactFingerprint);
  if (new Set(result.map((item) => item.id)).size !== result.length) evidenceInvalid('收货 evidence 不能包含重复附件');
  return result;
}

function matches(left: ReceiptEvidenceFingerprint, right: ReceiptEvidenceFingerprint): boolean {
  return left.id === right.id && left.version === right.version
    && left.sha256 === right.sha256 && left.status === right.status;
}

function orderScope(row: ReceiptScopeRow) {
  const order = row.purchaseCommitment?.order;
  if (!order?.id || !order.quotation?.createdBy || !order.quotation.creator) {
    evidenceInvalid('收货缺少当前订单归属范围');
  }
  return {
    ownerId: order.quotation.createdBy,
    department: order.quotation.creator.department,
    orderId: order.id,
  };
}

async function loadReceipt(tx: Prisma.TransactionClient, receiptId: string) {
  const id = text(receiptId, 'receiptId');
  const row = await tx.stockReceipt.findUnique({ where: { id }, select: RECEIPT_SCOPE_SELECT });
  if (!row || row.id !== id) notFound('收货记录不存在');
  return { row, evidence: receiptEvidence(row.evidence), scope: orderScope(row) };
}

function assertBindingScope(actor: CapabilityActor, scope: ReturnType<typeof orderScope>): void {
  if (!hasCapability(actor, 'inventory', 'manage', scope)
    || !hasCapability(actor, 'order', 'read', scope)) {
    forbidden('当前用户无权为该订单绑定收货证据');
  }
}

function assertReadingScope(actor: CapabilityActor, scope: ReturnType<typeof orderScope>): void {
  const operational = hasCapability(actor, 'inventory', 'manage', scope);
  const quality = hasCapability(actor, 'quality_review', 'approve', scope);
  if (!hasCapability(actor, 'order', 'read', scope) || (!operational && !quality)) {
    forbidden('当前用户无权读取该收货证据');
  }
}

function assertUnboundUpload(row: StoredObjectRow): void {
  // Uploads start with domain=upload and no resource. A cost-domain object is
  // never eligible for re-homing, even if its resourceId was cleared by a
  // faulty caller.
  if (row.resourceId !== null || (row.domain !== null && !['upload', 'uploads'].includes(row.domain))) {
    evidenceInvalid('附件已绑定其他业务对象，或不是普通上传文件，不能作为收货证据');
  }
}

/**
 * Bind fresh upload files to one StockReceipt. The caller owns the surrounding
 * transaction and should persist the returned fingerprints in StockReceipt.evidence.
 * This helper never writes cost snapshots or purchase-source evidence.
 */
export function bindReceiptEvidence(input: BindReceiptEvidenceInput): Promise<ReceiptEvidenceFingerprint[]>;
export function bindReceiptEvidence(
  tx: Prisma.TransactionClient,
  actor: CapabilityActor,
  evidenceIds: readonly string[],
  receiptId: string,
): Promise<ReceiptEvidenceFingerprint[]>;
export async function bindReceiptEvidence(
  inputOrTx: BindReceiptEvidenceInput | Prisma.TransactionClient,
  actorArg?: CapabilityActor,
  evidenceIdsArg?: readonly string[],
  receiptIdArg?: string,
): Promise<ReceiptEvidenceFingerprint[]> {
  const input: BindReceiptEvidenceInput = 'tx' in inputOrTx
    ? inputOrTx
    : { tx: inputOrTx, actor: actorArg!, evidenceIds: evidenceIdsArg!, receiptId: receiptIdArg! };
  assertActor(input.actor);
  const receipt = await loadReceipt(input.tx, input.receiptId);
  assertBindingScope(input.actor, receipt.scope);
  const ids = normalizeIds(input.evidenceIds);
  const rows = await input.tx.storedObject.findMany({
    where: { id: { in: ids } },
    orderBy: { id: 'asc' },
    select: STORED_OBJECT_SELECT,
  });
  if (rows.length !== ids.length) evidenceInvalid('收货证据不存在或不完整');
  const byId = new Map(rows.map((row) => [row.id, row]));
  const orderedRows: StoredObjectRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) evidenceInvalid('收货证据不存在或不完整');
    assertAvailableRow(row);
    assertUnboundUpload(row);
    if (row.ownerId !== input.actor.id) forbidden('只能绑定当前用户本人上传的收货证据');
    orderedRows.push(row);
  }

  const result: ReceiptEvidenceFingerprint[] = [];
  for (const row of orderedRows) {
    const claimed = await input.tx.storedObject.updateMany({
      where: {
        id: row.id,
        status: 'AVAILABLE',
        ownerId: input.actor.id,
        version: row.version,
        resourceId: null,
        domain: row.domain,
      },
      data: {
        domain: STOCK_RECEIPT_EVIDENCE_DOMAIN,
        resourceId: receipt.row.id,
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) conflict('收货证据已被其他业务对象或用户占用，请刷新后重试');
    result.push({ id: row.id, version: row.version + 1, sha256: row.sha256, status: 'AVAILABLE' });
  }
  return result;
}

/**
 * Read the receipt's persisted evidence snapshots and revalidate every current
 * StoredObject version, hash, status, domain and resource binding.
 */
export async function readReceiptEvidence(
  tx: Prisma.TransactionClient,
  actor: CapabilityActor,
  receiptId: string,
): Promise<ReceiptEvidenceFingerprint[]> {
  const receipt = await loadReceipt(tx, receiptId);
  assertReadingScope(actor, receipt.scope);
  if (receipt.evidence.length === 0) return [];
  const rows = await tx.storedObject.findMany({
    where: { id: { in: receipt.evidence.map((item) => item.id) } },
    orderBy: { id: 'asc' },
    select: STORED_OBJECT_SELECT,
  });
  if (rows.length !== receipt.evidence.length) evidenceInvalid('收货证据文件不存在或已不可用');
  const byId = new Map(rows.map((row) => [row.id, row]));
  return receipt.evidence.map((expected) => {
    const row = byId.get(expected.id);
    if (!row) evidenceInvalid('收货证据文件不存在或已不可用');
    const current = fingerprint(row);
    if (row.domain !== STOCK_RECEIPT_EVIDENCE_DOMAIN || row.resourceId !== receipt.row.id
      || !matches(current, expected)) {
      evidenceInvalid('收货证据版本、哈希或归属已变化，请重新核对');
    }
    return current;
  });
}

/**
 * Download ACL for a single StoredObject. It derives the receipt from the
 * object's exact resourceId and persisted evidence snapshot, so an uploader
 * cannot bypass current order scope merely by owning the file. No view_cost
 * capability is consulted or granted here.
 */
export async function assertCanReadReceiptEvidence(
  tx: Prisma.TransactionClient,
  object: ReceiptStoredObject,
  actor: CapabilityActor | undefined,
): Promise<ReceiptEvidenceReadContext> {
  assertActor(actor);
  if (object.domain !== STOCK_RECEIPT_EVIDENCE_DOMAIN || !object.resourceId) {
    forbidden('无权访问此收货证据');
  }
  if (object.status !== 'AVAILABLE' || !Number.isInteger(object.version) || object.version < 1
    || !/^[a-f\d]{64}$/i.test(object.sha256)) {
    forbidden('无权访问此收货证据');
  }
  let receipt: Awaited<ReturnType<typeof loadReceipt>>;
  try {
    receipt = await loadReceipt(tx, object.resourceId);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) forbidden('无权访问此收货证据');
    throw error;
  }
  assertReadingScope(actor, receipt.scope);
  const expected = receipt.evidence.find((item) => item.id === object.id);
  if (!expected || !matches(expected, { id: object.id, version: object.version, sha256: object.sha256, status: 'AVAILABLE' })) {
    forbidden('无权访问此收货证据');
  }
  return { receiptId: receipt.row.id, orderId: receipt.scope.orderId };
}
