import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  loadAcceptedReceiptCertificateReferences,
  loadAcceptedReceiptCertificates,
} from './receiptCertificateSources.js';

const hash1 = 'certificate-hash-1';
const hash2 = 'certificate-hash-2';

function qualitySnapshot(references: Array<{ id: string; fileHash: string }>) {
  return { physical: { certificateReferences: references }, storage: { location: 'A', warehouse: 'W', shelf: null } };
}

function certificate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    certificateNumber: `CERT-${id}`,
    partNumber: 'PN-1',
    serialNumber: null,
    batchNumber: 'B1',
    certificateType: 'FAA-8130-3',
    status: 'ISSUED',
    expiryDate: null,
    fileUrl: `/certificates/${id}.pdf`,
    fileHash: id === 'cert-1' ? hash1 : hash2,
    updatedAt: new Date('2026-09-09T00:00:00Z'),
    supplierId: 'supplier-1', orderId: null, inventoryDetailId: null,
    ...overrides,
  };
}

function fixture(options: {
  lines?: Array<{ id: string; qualitySnapshot: unknown; status?: string }>;
  certificates?: Array<Record<string, unknown>>;
} = {}) {
  const findManyReceiptLines = vi.fn().mockImplementation(async (args: { where?: { status?: string } }) =>
    (options.lines ?? []).filter((line) => !args.where?.status || !line.status || line.status === args.where.status)
      .map(line => ({ ...line, purchaseCommitmentLine: { purchaseCommitment: { supplierId: 'supplier-1', orderId: 'original-order' } } })));
  const findManyCertificates = vi.fn().mockResolvedValue(options.certificates ?? []);
  const tx = {
    stockReceiptLine: { findMany: findManyReceiptLines },
    certificate: { findMany: findManyCertificates },
  } as unknown as Prisma.TransactionClient;
  return { tx, findManyReceiptLines, findManyCertificates };
}

describe('accepted stock receipt certificate sources', () => {
  it('reads only accepted receipt lines for the exact inventory detail and deduplicates identical references', async () => {
    const f = fixture({ lines: [
      { id: 'receipt-line-1', qualitySnapshot: qualitySnapshot([{ id: 'cert-2', fileHash: hash2 }, { id: 'cert-1', fileHash: hash1 }]) },
      { id: 'receipt-line-2', qualitySnapshot: qualitySnapshot([{ id: 'cert-1', fileHash: hash1 }]) },
    ] });
    await expect(loadAcceptedReceiptCertificateReferences(f.tx, 'detail-1')).resolves.toEqual([
      { id: 'cert-1', fileHash: hash1 }, { id: 'cert-2', fileHash: hash2 },
    ]);
    expect(f.findManyReceiptLines).toHaveBeenCalledWith({
      where: { inventoryDetailId: 'detail-1', status: 'ACCEPTED' },
      orderBy: { id: 'asc' },
      select: { id: true, qualitySnapshot: true,
        purchaseCommitmentLine: { select: { purchaseCommitment: { select: { supplierId: true, orderId: true } } } } },
    });
  });

  it('returns no source certificates when no accepted receipt line is linked', async () => {
    const f = fixture({ lines: [{ id: 'pending', status: 'PENDING_REVIEW', qualitySnapshot: qualitySnapshot([{ id: 'cert-1', fileHash: hash1 }]) }] });
    await expect(loadAcceptedReceiptCertificates(f.tx, 'detail-1')).resolves.toEqual([]);
    expect(f.findManyCertificates).not.toHaveBeenCalled();
  });

  it('resolves current Certificate rows by exact ids and captured file hashes', async () => {
    const f = fixture({
      lines: [{ id: 'receipt-line-1', qualitySnapshot: qualitySnapshot([{ id: 'cert-1', fileHash: hash1 }, { id: 'cert-2', fileHash: hash2 }]) }],
      certificates: [certificate('cert-2'), certificate('cert-1')],
    });
    await expect(loadAcceptedReceiptCertificates(f.tx, 'detail-1')).resolves.toMatchObject([
      { id: 'cert-1', fileHash: hash1 }, { id: 'cert-2', fileHash: hash2 },
    ]);
    expect(f.findManyCertificates).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['cert-1', 'cert-2'] } } }));
  });

  it('fails closed for missing, changed, non-issued, or expired current certificates', async () => {
    const cases = [
      { certificates: [], code: 'QUALITY_REVIEW_STALE' },
      { certificates: [certificate('cert-1', { fileHash: 'changed-hash' })], code: 'QUALITY_REVIEW_STALE' },
      { certificates: [certificate('cert-1', { status: 'REVOKED' })], code: 'QUALITY_REVIEW_STALE' },
      { certificates: [certificate('cert-1', { status: 'DRAFT' })], code: 'QUALITY_REVIEW_STALE' },
      { certificates: [certificate('cert-1', { expiryDate: new Date('2020-01-01T00:00:00Z') })], code: 'QUALITY_REVIEW_STALE' },
    ];
    for (const testCase of cases) {
      const f = fixture({
        lines: [{ id: 'receipt-line-1', qualitySnapshot: qualitySnapshot([{ id: 'cert-1', fileHash: hash1 }]) }],
        certificates: testCase.certificates,
      });
      await expect(loadAcceptedReceiptCertificates(f.tx, 'detail-1', new Date('2026-09-09T00:00:00Z')))
        .rejects.toMatchObject({ code: testCase.code });
    }
  });

  it('rejects malformed snapshots and conflicting hashes instead of guessing a source', async () => {
    const malformed = fixture({ lines: [{ id: 'receipt-line-1', qualitySnapshot: { physical: {} } }] });
    await expect(loadAcceptedReceiptCertificateReferences(malformed.tx, 'detail-1'))
      .rejects.toMatchObject({ code: 'ALLOCATION_INCONSISTENT' });

    const conflict = fixture({ lines: [
      { id: 'receipt-line-1', qualitySnapshot: qualitySnapshot([{ id: 'cert-1', fileHash: hash1 }]) },
      { id: 'receipt-line-2', qualitySnapshot: qualitySnapshot([{ id: 'cert-1', fileHash: 'other-hash' }]) },
    ] });
    await expect(loadAcceptedReceiptCertificateReferences(conflict.tx, 'detail-1'))
      .rejects.toMatchObject({ code: 'ALLOCATION_INCONSISTENT' });
  });

  it('rejects duplicate references within one immutable receipt snapshot', async () => {
    const f = fixture({ lines: [{ id: 'receipt-line-1', qualitySnapshot: qualitySnapshot([
      { id: 'cert-1', fileHash: hash1 }, { id: 'cert-1', fileHash: hash1 },
    ]) }] });
    await expect(loadAcceptedReceiptCertificateReferences(f.tx, 'detail-1'))
      .rejects.toMatchObject({ code: 'ALLOCATION_INCONSISTENT' });
  });

  it('rejects changed certificate ownership even when the exact id and file hash remain valid', async () => {
    for (const changed of [{ supplierId: 'another-supplier' }, { orderId: 'another-order' }, { inventoryDetailId: 'another-detail' }]) {
      const f = fixture({ lines: [{ id: 'receipt-line-1', qualitySnapshot: qualitySnapshot([{ id: 'cert-1', fileHash: hash1 }]) }],
        certificates: [certificate('cert-1', changed)] });
      await expect(loadAcceptedReceiptCertificates(f.tx, 'detail-1')).rejects.toMatchObject({ code: 'QUALITY_REVIEW_STALE' });
    }
    const matched = fixture({ lines: [{ id: 'receipt-line-1', qualitySnapshot: qualitySnapshot([{ id: 'cert-1', fileHash: hash1 }]) }],
      certificates: [certificate('cert-1', { orderId: 'original-order', inventoryDetailId: 'detail-1' })] });
    await expect(loadAcceptedReceiptCertificates(matched.tx, 'detail-1')).resolves.toHaveLength(1);
  });
});
