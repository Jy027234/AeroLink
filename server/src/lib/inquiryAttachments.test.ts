import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  assertFrozenInquiryAttachments,
  freezeInquiryAttachments,
  inquiryAttachmentSnapshotHash,
  MAX_INQUIRY_ATTACHMENT_BYTES,
} from './inquiryAttachments.js';

function row(id: string, overrides: Record<string, unknown> = {}) {
  const attachment = {
    id,
    inquiryId: 'inquiry-1',
    storedObjectId: `object-${id}`,
    filename: `${id}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 100,
    sha256: id.padStart(64, 'a').slice(-64),
    version: 3,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    storedObject: {
      id: `object-${id}`,
      domain: 'inquiry_attachment',
      resourceId: 'inquiry-1',
      status: 'AVAILABLE',
      originalName: `${id}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 100,
      sha256: id.padStart(64, 'a').slice(-64),
      version: 3,
    },
  };
  return { ...attachment, ...overrides };
}

function txWithRows(rows: ReturnType<typeof row>[]) {
  return {
    inquiryAttachment: { findMany: vi.fn().mockResolvedValue(rows) },
  } as unknown as Prisma.TransactionClient;
}

describe('inquiry attachment snapshots', () => {
  it('freezes metadata and preserves the requested selection order', async () => {
    const tx = txWithRows([row('a'), row('b')]);
    const snapshots = await freezeInquiryAttachments(tx, 'inquiry-1', ['b', 'a']);

    expect(snapshots.map((attachment) => attachment.id)).toEqual(['b', 'a']);
    expect(snapshots[0]).toMatchObject({
      storedObjectId: 'object-b', filename: 'b.pdf', contentType: 'application/pdf',
      sizeBytes: 100, version: 3, downloadUrl: '/api/files/object-b',
    });
    expect(inquiryAttachmentSnapshotHash(snapshots)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects an ID that was not found under the target inquiry', async () => {
    const tx = txWithRows([]);
    await expect(freezeInquiryAttachments(tx, 'inquiry-1', ['from-other-inquiry']))
      .rejects.toMatchObject({ statusCode: 404, code: 'RESOURCE_NOT_FOUND' });
    expect(tx.inquiryAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['from-other-inquiry'] }, inquiryId: 'inquiry-1' },
    }));
  });

  it('rejects duplicate selections, altered StoredObject metadata, and an oversized total', async () => {
    const duplicateTx = txWithRows([]);
    await expect(freezeInquiryAttachments(duplicateTx, 'inquiry-1', ['a', 'a']))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(duplicateTx.inquiryAttachment.findMany).not.toHaveBeenCalled();

    const altered = row('a');
    altered.storedObject.sha256 = 'f'.repeat(64);
    await expect(freezeInquiryAttachments(txWithRows([altered]), 'inquiry-1', ['a']))
      .rejects.toMatchObject({ statusCode: 409, code: 'STATE_CONFLICT' });

    const largeRows = [row('a'), row('b'), row('c')].map((attachment) => ({
      ...attachment,
      sizeBytes: 7 * 1024 * 1024,
      storedObject: { ...attachment.storedObject, sizeBytes: 7 * 1024 * 1024 },
    }));
    await expect(freezeInquiryAttachments(txWithRows(largeRows), 'inquiry-1', ['a', 'b', 'c']))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(MAX_INQUIRY_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('requires the frozen metadata and source version to remain identical', async () => {
    const tx = txWithRows([row('a')]);
    const frozen = await freezeInquiryAttachments(tx, 'inquiry-1', ['a']);
    await expect(assertFrozenInquiryAttachments(tx, 'inquiry-1', frozen)).resolves.toEqual(frozen);
    await expect(assertFrozenInquiryAttachments(tx, 'inquiry-1', [{ ...frozen[0], version: 4 }]))
      .rejects.toMatchObject({ statusCode: 409, code: 'STATE_CONFLICT' });
  });
});
