import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import type { AuthRequest } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import prisma from './prisma.js';
import { objectStorage } from './objectStorage.js';
import { inquiryReadScope } from './inquirySendCommand.js';

export const MAX_INQUIRY_ATTACHMENT_COUNT = 10;
export const MAX_INQUIRY_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_INQUIRY_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;

export type InquiryAttachmentSnapshot = {
  id: string;
  storedObjectId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  version: number;
  downloadUrl: string;
};

type InquiryAttachmentTransaction = Pick<Prisma.TransactionClient, 'inquiryAttachment'>;
type InquiryAttachmentActor = NonNullable<AuthRequest['user']>;

function attachmentDownloadUrl(storedObjectId: string) {
  return `/api/files/${encodeURIComponent(storedObjectId)}`;
}

function metadataMatchesSource(row: {
  id: string;
  inquiryId: string;
  storedObjectId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  version: number;
  storedObject: {
    id: string;
    domain: string | null;
    resourceId: string | null;
    status: string;
    originalName: string | null;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    version: number;
  };
}, inquiryId: string) {
  const object = row.storedObject;
  return row.inquiryId === inquiryId
    && row.storedObjectId === object.id
    && object.domain === 'inquiry_attachment'
    && object.resourceId === inquiryId
    && object.status === 'AVAILABLE'
    && object.originalName === row.filename
    && object.mimeType === row.contentType
    && object.sizeBytes === row.sizeBytes
    && object.sha256 === row.sha256
    && object.version === row.version;
}

function toSnapshot(row: {
  id: string;
  storedObjectId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  version: number;
}): InquiryAttachmentSnapshot {
  return {
    id: row.id,
    storedObjectId: row.storedObjectId,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    version: row.version,
    downloadUrl: attachmentDownloadUrl(row.storedObjectId),
  };
}

/** Load only objects bound to this inquiry, then preserve the user's selection order. */
export async function freezeInquiryAttachments(
  tx: InquiryAttachmentTransaction,
  inquiryId: string,
  attachmentIds: string[] = [],
): Promise<InquiryAttachmentSnapshot[]> {
  if (attachmentIds.length > MAX_INQUIRY_ATTACHMENT_COUNT
    || new Set(attachmentIds).size !== attachmentIds.length
    || attachmentIds.some((id) => !id.trim())) {
    throw new AppError('附件数量或选择无效', 400, 'VALIDATION_ERROR');
  }
  if (attachmentIds.length === 0) return [];

  const rows = await tx.inquiryAttachment.findMany({
    where: { id: { in: attachmentIds }, inquiryId },
    include: {
      storedObject: {
        select: {
          id: true,
          domain: true,
          resourceId: true,
          status: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          sha256: true,
          version: true,
        },
      },
    },
  });
  if (rows.length !== attachmentIds.length) {
    throw new AppError('附件不存在或不属于此询价', 404, 'RESOURCE_NOT_FOUND');
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const selected = attachmentIds.map((id) => byId.get(id)!);
  if (selected.some((row) => !metadataMatchesSource(row, inquiryId)
    || row.sizeBytes <= 0 || row.sizeBytes > MAX_INQUIRY_ATTACHMENT_BYTES)) {
    throw new AppError('附件已变化或不可用，请重新选择', 409, 'STATE_CONFLICT');
  }
  const totalBytes = selected.reduce((total, row) => total + row.sizeBytes, 0);
  if (totalBytes > MAX_INQUIRY_ATTACHMENTS_TOTAL_BYTES) {
    throw new AppError('附件总大小不能超过 20 MB', 400, 'VALIDATION_ERROR');
  }
  return selected.map(toSnapshot);
}

export async function assertFrozenInquiryAttachments(
  tx: InquiryAttachmentTransaction,
  inquiryId: string,
  snapshots: InquiryAttachmentSnapshot[],
) {
  const current = await freezeInquiryAttachments(tx, inquiryId, snapshots.map((snapshot) => snapshot.id));
  if (JSON.stringify(current) !== JSON.stringify(snapshots)) {
    throw new AppError('任务中的附件版本已变化，请重新创建任务', 409, 'STATE_CONFLICT');
  }
  return current;
}

export function inquiryAttachmentSnapshotHash(snapshots: InquiryAttachmentSnapshot[]) {
  return createHash('sha256').update(JSON.stringify(snapshots)).digest('hex');
}

export function serializeInquiryAttachment(snapshot: InquiryAttachmentSnapshot) {
  return snapshot;
}

export async function listInquiryAttachmentSnapshots(
  tx: Prisma.TransactionClient,
  actor: InquiryAttachmentActor,
  inquiryId: string,
) {
  const inquiry = await tx.inquiry.findFirst({
    where: { id: inquiryId, ...inquiryReadScope(actor) },
    select: { id: true },
  });
  if (!inquiry) throw new AppError('询价单不存在或当前无权访问', 404, 'RESOURCE_NOT_FOUND');
  const rows = await tx.inquiryAttachment.findMany({
    where: { inquiryId, storedObject: { status: 'AVAILABLE' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      storedObjectId: true,
      filename: true,
      contentType: true,
      sizeBytes: true,
      sha256: true,
      version: true,
    },
  });
  return rows.map(toSnapshot);
}

export async function persistInquiryAttachment(input: {
  sourcePath: string;
  inquiryId: string;
  actor: InquiryAttachmentActor;
  filename: string;
  contentType: string;
}) {
  const objectKey = `inquiry/${input.inquiryId}/${randomUUID()}`;
  let uploadedKey: string | null = null;
  try {
    const metadata = await objectStorage.putFile({
      sourcePath: input.sourcePath,
      objectKey,
      mimeType: input.contentType,
      originalName: input.filename,
      domain: 'inquiry_attachment',
      resourceId: input.inquiryId,
      ownerId: input.actor.id,
    });
    uploadedKey = metadata.objectKey;
    const attachment = await prisma.$transaction(async (tx) => {
      const inquiry = await tx.inquiry.findFirst({
        where: { id: input.inquiryId, status: 'DRAFT', ...inquiryReadScope(input.actor) },
        select: { id: true },
      });
      if (!inquiry) {
        const visible = await tx.inquiry.findFirst({
          where: { id: input.inquiryId, ...inquiryReadScope(input.actor) },
          select: { id: true },
        });
        if (!visible) throw new AppError('询价单不存在或当前无权访问', 404, 'RESOURCE_NOT_FOUND');
        throw new AppError('只有草稿询价可以上传附件', 409, 'STATE_CONFLICT');
      }
      const storedObject = await tx.storedObject.create({
        data: {
          objectKey: metadata.objectKey,
          version: metadata.version,
          sha256: metadata.sha256,
          sizeBytes: metadata.sizeBytes,
          mimeType: metadata.mimeType,
          originalName: metadata.originalName,
          domain: metadata.domain,
          resourceId: metadata.resourceId,
          ownerId: metadata.ownerId,
        },
        select: { id: true },
      });
      const created = await tx.inquiryAttachment.create({
        data: {
          inquiryId: input.inquiryId,
          storedObjectId: storedObject.id,
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: metadata.sizeBytes,
          sha256: metadata.sha256,
          version: metadata.version,
          createdById: input.actor.id,
        },
        select: {
          id: true,
          storedObjectId: true,
          filename: true,
          contentType: true,
          sizeBytes: true,
          sha256: true,
          version: true,
        },
      });
      return toSnapshot(created);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return attachment;
  } catch (error) {
    if (uploadedKey) await objectStorage.delete(uploadedKey).catch(() => undefined);
    throw error;
  } finally {
    await fs.unlink(input.sourcePath).catch(() => undefined);
  }
}

