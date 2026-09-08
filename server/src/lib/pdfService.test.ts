import { describe, expect, it } from 'vitest';
import { generateOrderHTML, generateQuotationHTML } from './pdfService.js';

const quotationBase = {
  quoteNumber: 'QT-20260908-001',
  customerName: '客户一',
  partNumber: 'LEGACY-PN',
  description: 'legacy row must not drive multi-line output',
  quantity: 999,
  unitPrice: 999,
  totalPrice: 999,
  costPrice: 700,
  margin: 20,
  validityDays: 30,
  createdAt: '2026-09-08 10:00:00',
  expiryDate: '2026-10-08',
};

const orderBase = {
  orderNumber: 'SO-20260908-001',
  customerName: '客户一',
  partNumber: 'LEGACY-PN',
  quantity: 999,
  totalAmount: 999,
  status: 'SO_CREATED',
  createdAt: '2026-09-08 10:00:00',
};

describe('pdfService line-first rendering', () => {
  it('renders all quotation lines and derives the total from those line totals', () => {
    const html = generateQuotationHTML({
      ...quotationBase,
      lineItemsMode: true,
      lines: [
        { lineId: 'ql-1', partNumber: 'PN-100', description: 'First', quantity: 2, unitPrice: 10, lineTotal: 20, currency: 'USD' },
        { lineId: 'ql-2', partNumber: 'PN-200', description: 'Second', quantity: 3, unitPrice: 25, lineTotal: 75, currency: 'USD' },
      ],
    });

    expect(html).toContain('PN-100');
    expect(html).toContain('PN-200');
    expect(html).toContain('$95');
    expect(html).not.toContain('LEGACY-PN');
    expect(html).not.toContain('$999');
  });

  it('keeps line cost data out of customer quotation HTML unless internal info is requested', () => {
    const lines = [{
      lineId: 'ql-1', partNumber: 'PN-100', description: 'First', quantity: 2,
      unitPrice: 10, lineTotal: 20, currency: 'USD', costPrice: 7, margin: 30,
    }];
    const customerHtml = generateQuotationHTML({ ...quotationBase, lineItemsMode: true, lines, includeInternalInfo: false });
    const internalHtml = generateQuotationHTML({ ...quotationBase, lineItemsMode: true, lines, includeInternalInfo: true });

    expect(customerHtml).not.toContain('Cost Price');
    expect(customerHtml).not.toContain('$7');
    expect(internalHtml).toContain('Cost Price');
    expect(internalHtml).toContain('$14');
    expect(internalHtml).toContain('30.00%');
  });

  it('renders current order lines for partial or multi-line orders', () => {
    const html = generateOrderHTML({
      ...orderBase,
      lineItemsMode: true,
      lines: [
        { lineId: 'ol-1', partNumber: 'PN-100', quantity: 1, unitPrice: 10, lineTotal: 10, currency: 'USD' },
        { lineId: 'ol-2', partNumber: 'PN-200', quantity: 2, unitPrice: 15, lineTotal: 30, currency: 'USD' },
      ],
    });

    expect(html).toContain('PN-100');
    expect(html).toContain('PN-200');
    expect(html).toContain('$40');
    expect(html).not.toContain('LEGACY-PN');
    expect(html).not.toContain('$999');
  });

  it('fails closed when a record claims line mode but the current lines were not loaded', () => {
    expect(() => generateQuotationHTML({ ...quotationBase, lineItemsMode: true })).toThrow('多行模式');
    expect(() => generateOrderHTML({ ...orderBase, lineItemsMode: true })).toThrow('多行模式');
  });
});
