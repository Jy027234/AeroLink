import { describe, expect, it } from 'vitest';
import {
  assertImmutableDocumentArtifact,
  assertQuotationRenderSnapshot,
  buildQuotationRenderSnapshot,
  canonicalJson,
  parseQuotationRenderSnapshot,
  serializeQuotationRenderSnapshot,
  sha256,
} from './documentRenderSnapshot.js';

const quotation = {
  id: 'quotation-1',
  quoteNumber: 'QT-001',
  partNumber: 'PN-100',
  quantity: 2,
  unitPrice: 125,
  totalPrice: 250,
  costPrice: 70,
  margin: 44,
  costSourceType: 'INVENTORY_DETAIL',
  costSourceId: 'inventory-1',
  validityDays: 7,
  saleType: 'Sale',
  incoterm: 'EXW',
  incotermLocation: 'Shanghai',
  leadTimeDays: 5,
  leadTimeBasis: 'WORKING_DAYS',
  taxIncluded: true,
  warrantyDays: 90,
  commonNote: 'Frozen terms',
  certificateFiles: 'certificate-a.pdf,certificate-b.pdf',
  createdAt: new Date('2026-09-08T02:00:00.000Z'),
  expiryDate: new Date('2026-09-15T02:00:00.000Z'),
  currency: 'USD',
  commercialRevision: 3,
  version: 8,
};

const customer = { id: 'customer-1', name: '原客户' };

describe('document render snapshots', () => {
  it('captures customer-visible values and strips every cost/source field', () => {
    const snapshot = buildQuotationRenderSnapshot({
      quotation: { ...quotation, lineItemsMode: true },
      customer,
      lines: [{
        id: 'line-1',
        partNumber: 'PN-100',
        description: 'Original description',
        quantity: 2,
        unitPrice: 125,
        lineTotal: 250,
        currency: 'USD',
        costPrice: 70,
        marginAmount: 110,
        marginPercent: 44,
        costSourceType: 'INVENTORY_DETAIL',
        costSourceId: 'inventory-1',
        costSourceSnapshotJson: '{"unitCost":70}',
      }],
      template: {
        id: 'quotation-template-v3',
        version: 3,
        bodyTemplate: 'customer body',
      },
      capturedAt: '2026-09-08T02:30:00.000Z',
    });

    expect(snapshot.source).toMatchObject({
      quotationId: 'quotation-1',
      customerId: 'customer-1',
      commercialRevision: 3,
      quotationVersion: 8,
      capturedAt: '2026-09-08T02:30:00.000Z',
    });
    expect(snapshot.template).toMatchObject({ id: 'quotation-template-v3', version: 3 });
    expect(snapshot.renderData).toMatchObject({ quoteNumber: 'QT-001', customerName: '原客户', includeInternalInfo: false });
    expect(snapshot.renderData.lines?.[0]).toEqual({
      lineId: 'line-1',
      partNumber: 'PN-100',
      description: 'Original description',
      quantity: 2,
      unitPrice: 125,
      lineTotal: 250,
      currency: 'USD',
    });
    expect(JSON.stringify(snapshot)).not.toContain('costPrice');
    expect(JSON.stringify(snapshot)).not.toContain('margin');
    expect(JSON.stringify(snapshot)).not.toContain('inventory-1');
    expect(snapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the hash stable across object key order and detects customer/template changes', () => {
    const first = buildQuotationRenderSnapshot({
      quotation,
      customer,
      capturedAt: '2026-09-08T02:30:00.000Z',
      template: { id: 'template-1', version: 1, bodyTemplate: 'body-a' },
    });
    const reordered = buildQuotationRenderSnapshot({
      quotation: { ...quotation, quoteNumber: 'QT-001' },
      customer: { name: '原客户', id: 'customer-1' },
      capturedAt: '2026-09-08T02:30:00.000Z',
      template: { bodyTemplate: 'body-a', version: 1, id: 'template-1' },
    });
    expect(reordered.snapshotHash).toBe(first.snapshotHash);

    const changedCustomer = buildQuotationRenderSnapshot({
      quotation,
      customer: { id: 'customer-2', name: '最新客户' },
      capturedAt: '2026-09-08T02:30:00.000Z',
      template: { id: 'template-1', version: 1, bodyTemplate: 'body-a' },
    });
    const changedTemplate = buildQuotationRenderSnapshot({
      quotation,
      customer,
      capturedAt: '2026-09-08T02:30:00.000Z',
      template: { id: 'template-1', version: 2, bodyTemplate: 'body-b' },
    });
    expect(changedCustomer.snapshotHash).not.toBe(first.snapshotHash);
    expect(changedTemplate.snapshotHash).not.toBe(first.snapshotHash);
  });

  it('round-trips canonical JSON and rejects a modified historical value', () => {
    const snapshot = buildQuotationRenderSnapshot({ quotation, customer, capturedAt: '2026-09-08T02:30:00.000Z' });
    const serialized = serializeQuotationRenderSnapshot(snapshot);
    expect(parseQuotationRenderSnapshot(serialized)).toEqual(snapshot);

    const tampered = JSON.parse(serialized) as typeof snapshot;
    tampered.renderData.customerName = '最新客户';
    expect(() => assertQuotationRenderSnapshot(tampered)).toThrow('hash mismatch');
  });

  it('rejects cost fields even when an attacker recomputes the snapshot hash', () => {
    const snapshot = buildQuotationRenderSnapshot({ quotation, customer, capturedAt: '2026-09-08T02:30:00.000Z' });
    const tampered = {
      ...snapshot,
      renderData: { ...snapshot.renderData, costPrice: 70 } as typeof snapshot.renderData,
    };
    const { snapshotHash: _ignored, ...withoutHash } = tampered;
    tampered.snapshotHash = sha256(canonicalJson(withoutHash));
    expect(() => assertQuotationRenderSnapshot(tampered)).toThrow('internal cost information');
  });

  it('requires actual lines for a modern quotation', () => {
    expect(() => buildQuotationRenderSnapshot({
      quotation: { ...quotation, lineItemsMode: true },
      customer,
    })).toThrow('缺少明细');
  });

  it('does not silently interpret a historical unknown currency as USD', () => {
    expect(() => buildQuotationRenderSnapshot({
      quotation: { ...quotation, currency: null },
      customer,
    })).toThrow('缺少可核实的 USD 币种');
    expect(() => buildQuotationRenderSnapshot({
      quotation: { ...quotation, currency: 'EUR' },
      customer,
    })).toThrow('缺少可核实的 USD 币种');
    expect(() => buildQuotationRenderSnapshot({
      quotation: { ...quotation, lineItemsMode: true },
      customer,
      lines: [{ partNumber: 'PN-100', quantity: 1, unitPrice: 10, lineTotal: 10 }],
    })).toThrow('报价行缺少可核实的 USD 币种');
  });

  it('verifies immutable PDF bytes and the snapshot reference before use', () => {
    const content = Buffer.from('frozen-pdf');
    const artifact = {
      filename: 'QT-001.pdf',
      content,
      contentType: 'application/pdf' as const,
      sha256: sha256(content),
      sizeBytes: content.byteLength,
      snapshotHash: 'snapshot-hash',
    };

    expect(assertImmutableDocumentArtifact(artifact, {
      sha256: artifact.sha256,
      snapshotHash: artifact.snapshotHash,
    })).toBe(artifact);
    expect(() => assertImmutableDocumentArtifact(artifact, { sha256: 'wrong' })).toThrow('metadata');
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});
