import { describe, expect, it } from 'vitest';
import { canReadGeneratedDocument, containsInternalCommercialData } from './documentAccess.js';
import { buildQuotationRenderSnapshot, canonicalJson, serializeQuotationRenderSnapshot, sha256 } from './documentRenderSnapshot.js';
import { generateQuotationHTML } from './pdfService.js';

const quotation = {
  createdBy: 'sales-1',
  creator: { department: 'Sales' },
};

function publicQuotationSnapshot(commonNote?: string) {
  return buildQuotationRenderSnapshot({
    quotation: {
      id: 'quote-1',
      quoteNumber: 'Q-1',
      partNumber: 'PN-1',
      quantity: 2,
      unitPrice: 10,
      totalPrice: 20,
      validityDays: 30,
      createdAt: '2026-09-08T00:00:00.000Z',
      expiryDate: '2026-10-08T00:00:00.000Z',
      currency: 'USD',
      commonNote,
    },
    customer: { id: 'customer-1', name: 'Customer 1' },
    capturedAt: '2026-09-08T00:00:00.000Z',
  });
}

function publicQuotationDocument(snapshot = publicQuotationSnapshot(), overrides: Record<string, unknown> = {}) {
  const payloadJson = serializeQuotationRenderSnapshot(snapshot);
  return {
    generatedById: 'sales-1',
    quotationId: 'quote-1',
    customerId: 'customer-1',
    orderId: null,
    documentType: 'QUOTATION_PDF',
    quotation,
    contentHtml: generateQuotationHTML({ ...snapshot.renderData, includeInternalInfo: false }),
    payloadJson,
    snapshotHash: snapshot.snapshotHash,
    ...overrides,
  };
}

function withPayloadMutation(payloadJson: string, mutate: (payload: Record<string, unknown>) => void) {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  mutate(payload);
  const { snapshotHash: _ignored, ...withoutHash } = payload;
  payload.snapshotHash = sha256(canonicalJson(withoutHash));
  return JSON.stringify(payload);
}

describe('generated document access', () => {
  it('rechecks current quotation ownership and department scope', () => {
    const document = { generatedById: 'sales-1', quotationId: 'quote-1', orderId: null, quotation };

    expect(canReadGeneratedDocument({ id: 'sales-1', role: 'sales', department: 'Sales' }, document)).toBe(true);
    expect(canReadGeneratedDocument({ id: 'sales-2', role: 'sales', department: 'Sales' }, document)).toBe(false);
    expect(canReadGeneratedDocument({ id: 'manager-1', role: 'manager', department: 'Sales' }, document)).toBe(true);
    expect(canReadGeneratedDocument({ id: 'manager-2', role: 'manager', department: 'Operations' }, document)).toBe(false);
  });

  it('requires every current relation when a document is linked to quotation and order', () => {
    const document = {
      generatedById: 'sales-1',
      quotationId: 'quote-1',
      orderId: 'order-1',
      quotation,
      order: { quotation },
    };

    expect(canReadGeneratedDocument({ id: 'finance-1', role: 'finance' }, document)).toBe(true);
    expect(canReadGeneratedDocument({ id: 'sales-1', role: 'sales', department: 'Sales' }, document)).toBe(true);
    expect(canReadGeneratedDocument({ id: 'sales-1', role: 'sales', department: 'Sales' }, {
      ...document,
      order: { quotation: { createdBy: 'sales-2', creator: { department: 'Operations' } } },
    })).toBe(false);
  });

  it('limits unlinked documents to creator or global admin and does not fall back when relation is stale', () => {
    const standalone = { generatedById: 'creator-1', quotationId: null, orderId: null };
    expect(canReadGeneratedDocument({ id: 'creator-1', role: 'viewer' }, standalone)).toBe(true);
    expect(canReadGeneratedDocument({ id: 'other-1', role: 'admin' }, standalone)).toBe(true);
    expect(canReadGeneratedDocument({ id: 'other-1', role: 'gm' }, standalone)).toBe(false);
    expect(canReadGeneratedDocument({ id: 'manager-1', role: 'manager' }, standalone)).toBe(false);

    expect(canReadGeneratedDocument({ id: 'creator-1', role: 'sales', department: 'Sales' }, {
      generatedById: 'creator-1',
      quotationId: 'quote-missing',
      orderId: null,
      quotation: null,
    })).toBe(false);
  });

  it('allows sales to read a verified customer-facing quotation snapshot', () => {
    const document = publicQuotationDocument();
    expect(containsInternalCommercialData(document)).toBe(false);
    expect(canReadGeneratedDocument({ id: 'sales-1', role: 'sales', department: 'Sales' }, document)).toBe(true);
  });

  it('does not reject a verified customer note merely because it mentions cost', () => {
    const document = publicQuotationDocument(publicQuotationSnapshot('客户承担运输成本'));
    expect(containsInternalCommercialData(document)).toBe(false);
    expect(canReadGeneratedDocument({ id: 'sales-1', role: 'sales', department: 'Sales' }, document)).toBe(true);
  });

  it('rejects quotation snapshots with cost fields even when their inner hash is recomputed', () => {
    const base = publicQuotationDocument();
    const payloadJson = withPayloadMutation(base.payloadJson, payload => {
      const renderData = payload.renderData as Record<string, unknown>;
      renderData.costPrice = 4;
    });
    const document = { ...base, payloadJson, snapshotHash: (JSON.parse(payloadJson) as { snapshotHash: string }).snapshotHash };

    expect(containsInternalCommercialData(document)).toBe(true);
    expect(canReadGeneratedDocument({ id: 'sales-1', role: 'sales', department: 'Sales' }, document)).toBe(false);
  });

  it('rejects a tampered quotation snapshot or rendered HTML', () => {
    const base = publicQuotationDocument();
    const tamperedPayload = withPayloadMutation(base.payloadJson, payload => {
      const renderData = payload.renderData as Record<string, unknown>;
      renderData.quoteNumber = 'Q-TAMPERED';
    });
    expect(containsInternalCommercialData({
      ...base,
      payloadJson: tamperedPayload,
      snapshotHash: (JSON.parse(tamperedPayload) as { snapshotHash: string }).snapshotHash,
    })).toBe(true);

    const unknownPayload = withPayloadMutation(base.payloadJson, payload => {
      const renderData = payload.renderData as Record<string, unknown>;
      renderData.unexpected = 'must remain denied';
    });
    expect(containsInternalCommercialData({
      ...base,
      payloadJson: unknownPayload,
      snapshotHash: (JSON.parse(unknownPayload) as { snapshotHash: string }).snapshotHash,
    })).toBe(true);

    expect(containsInternalCommercialData({
      ...base,
      contentHtml: '<p>Internal gross margin: 20%</p>',
    })).toBe(true);
    expect(canReadGeneratedDocument({ id: 'sales-1', role: 'sales', department: 'Sales' }, {
      ...base,
      contentHtml: '<p>Internal gross margin: 20%</p>',
    })).toBe(false);
  });

  it('requires cost capability for custom internal content or unknown payload snapshots', () => {
    const sales = { id: 'sales-1', role: 'sales', department: 'Sales' };
    const finance = { id: 'finance-1', role: 'finance' };
    const sensitive = {
      generatedById: 'sales-1',
      quotationId: 'quote-1',
      orderId: null,
      quotation,
      contentHtml: '<p>Internal gross margin: 20%</p>',
      payloadJson: JSON.stringify({ quotation: { margin: 20 } }),
    };

    expect(containsInternalCommercialData(sensitive)).toBe(true);
    expect(canReadGeneratedDocument(sales, sensitive)).toBe(false);
    expect(canReadGeneratedDocument(finance, sensitive)).toBe(true);
    expect(canReadGeneratedDocument(sales, {
      ...sensitive,
      contentHtml: '<p>customer-facing contract</p>',
      payloadJson: JSON.stringify({ quotation: { quoteNumber: 'Q-1' } }),
    })).toBe(true);
  });
});
