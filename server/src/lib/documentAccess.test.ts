import { describe, expect, it } from 'vitest';
import { canReadGeneratedDocument, containsInternalCommercialData } from './documentAccess.js';

const quotation = {
  createdBy: 'sales-1',
  creator: { department: 'Sales' },
};

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
