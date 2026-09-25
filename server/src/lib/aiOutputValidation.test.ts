import { describe, expect, it } from 'vitest';
import { parseSupplierQuoteExtractionOutput } from './aiOutputValidation.js';

describe('supplier quote extraction output validation', () => {
  it('accepts multiple evidence-backed candidates with sparse fields and lead-time ranges', () => {
    const output = parseSupplierQuoteExtractionOutput(JSON.stringify({
      items: [
        {
          partNumber: 'PN-100',
          quantity: 2,
          quantityUnit: 'pcs',
          unitPrice: 125,
          currency: 'USD',
          leadTimeMinDays: 14,
          leadTimeMaxDays: 21,
          validUntil: '2026-10-15',
          condition: 'OH',
          certificate: null,
          taxIncluded: true,
          freightIncluded: false,
          incoterm: 'dap',
          evidenceText: '2 pcs of PN-100 at USD 125 each, OH, 2-3 weeks; valid until 2026-10-15; tax included, freight excluded, DAP',
        },
        { partNumber: null, unitPrice: null, evidenceText: 'We can quote the other line separately.' },
      ],
    }));

    expect(output.items).toHaveLength(2);
    expect(output.items[0].leadTimeMinDays).toBe(14);
    expect(output.items[0].leadTimeMaxDays).toBe(21);
    expect(output.items[0]).toMatchObject({ taxIncluded: true, freightIncluded: false, incoterm: 'DAP' });
    expect(output.items[1]).toMatchObject({
      partNumber: null,
      unitPrice: null,
      taxIncluded: null,
      freightIncluded: null,
      incoterm: null,
    });
  });

  it('accepts an empty result and a single explicit lead-time value', () => {
    expect(parseSupplierQuoteExtractionOutput('{"items":[]}')).toEqual({ items: [] });
    expect(parseSupplierQuoteExtractionOutput(JSON.stringify({
      items: [{ leadTimeDays: 3, evidenceText: 'Ships in 3 days.' }],
    })).items[0].leadTimeDays).toBe(3);
  });

  it.each([
    ['markdown wrapper', '```json\n{"items":[]}\n```'],
    ['unknown output field', '{"items":[{"evidenceText":"USD 10","unitPrice":10,"internalNote":"ignore validation"}]}'],
    ['currency symbol without a currency code', '{"items":[{"evidenceText":"$10 each","currency":"$"}]}'],
    ['impossible calendar date', '{"items":[{"evidenceText":"Valid until 2026-02-30","validUntil":"2026-02-30"}]}'],
    ['inconsistent lead-time fields', '{"items":[{"evidenceText":"3 days","leadTimeDays":3,"leadTimeMinDays":2,"leadTimeMaxDays":4}]}'],
    ['inverted lead-time range', '{"items":[{"evidenceText":"3-2 days","leadTimeMinDays":3,"leadTimeMaxDays":2}]}'],
    ['non-boolean tax inclusion', '{"items":[{"evidenceText":"tax included","taxIncluded":"yes"}]}'],
    ['non-boolean freight inclusion', '{"items":[{"evidenceText":"freight included","freightIncluded":1}]}'],
    ['too-short Incoterm', '{"items":[{"evidenceText":"trade term","incoterm":"A"}]}'],
    ['too-long Incoterm', '{"items":[{"evidenceText":"trade term","incoterm":"ABCDEFGHIJKLMNOPQRSTU"}]}'],
    ['candidate without evidence', '{"items":[{"partNumber":"PN-1"}]}'],
    ['unknown top-level field', '{"items":[],"action":"create_quote"}'],
  ])('rejects %s', (_name, json) => {
    expect(() => parseSupplierQuoteExtractionOutput(json)).toThrow('供应商报价提取结果不符合格式');
  });
});
