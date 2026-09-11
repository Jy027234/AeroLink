import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { canReadPurchaseEvidence } from './purchaseEvidenceAccess.js';
import { canReadStoredObject } from '../../routes/files.js';
import { getLegacyUploadDecision } from '../../routes/legacyUploads.js';

const object = { id: 'file', domain: 'purchase_commitment', resourceId: 'purchase', ownerId: 'manager',
  version: 2, sha256: 'a'.repeat(64), status: 'AVAILABLE' };
const evidence = { id: object.id, version: object.version, sha256: object.sha256, status: object.status };
function fixture() {
  const row = { confirmationEvidence: [evidence], lines: [] as Array<{ sourceSnapshot: unknown }>,
    order: { quotation: { createdBy: 'sales', creator: { department: 'Sales' } } } };
  const findUnique = vi.fn().mockResolvedValue(row);
  return { row, findUnique, tx: { purchaseCommitment: { findUnique } } as unknown as Prisma.TransactionClient };
}
describe('purchase commercial document access', () => {
  it('permits finance and current department cost readers for exact bound evidence', async () => {
    const f = fixture();
    for (const actor of [{ id: 'f', role: 'FINANCE' }, { id: 'm', role: 'MANAGER', department: 'Sales' }]) {
      expect(await canReadPurchaseEvidence(f.tx, object, actor)).toBe(true);
    }
    f.row.confirmationEvidence = [];
    f.row.lines = [{ sourceSnapshot: { type: 'MANUAL', evidence: [evidence] } }];
    expect(await canReadPurchaseEvidence(f.tx, object, { id: 'f', role: 'FINANCE' })).toBe(true);
  });
  it('denies former owner without cost rights, quality and managers outside current department', async () => {
    const f = fixture();
    for (const actor of [{ id: 'manager', role: 'SALES' }, { id: 'q', role: 'QUALITY_MANAGER' },
      { id: 'manager', role: 'MANAGER', department: 'Other' }]) {
      expect(await canReadPurchaseEvidence(f.tx, object, actor)).toBe(false);
    }
  });
  it('denies an unreferenced, rebound or changed document even to finance', async () => {
    const f = fixture(); const actor = { id: 'f', role: 'FINANCE' };
    for (const changed of [{ version: 3 }, { sha256: 'b'.repeat(64) }, { id: 'different' },
      { resourceId: null }, { status: 'REVOKED' }, { domain: 'order' }]) {
      expect(await canReadPurchaseEvidence(f.tx, { ...object, ...changed }, actor)).toBe(false);
    }
    f.row.confirmationEvidence = [];
    expect(await canReadPurchaseEvidence(f.tx, object, actor)).toBe(false);
  });
  it('does not allow owner or generic manager privileges to bypass the scoped download route', () => {
    for (const actor of [{ id: 'manager', role: 'MANAGER' }, { id: 'admin', role: 'ADMIN' }]) {
      expect(canReadStoredObject(object, actor)).toBe(false);
      expect(getLegacyUploadDecision(object, actor)).toBe('forbidden');
    }
  });
});
