import { describe, expect, it } from 'vitest';
import { assessTransactionLineMigration, type LinePreflightInput } from './transactionLinePreflight.js';

const fixture = (): LinePreflightInput => ({
  rfqs: [{ id: 'r1', partNumber: 'P1', quantity: 10, requiredDate: new Date('2026-10-01'), certificateRequired: true, targetPriceCurrency: 'USD' }],
  inquiries: [], inquiryItems: [], supplierQuotes: [],
  quotations: [{ id: 'q1', rfqId: 'r1', partNumber: 'P1', quantity: 4, unitPrice: 0.3333, unitPriceDecimal: '0.3333', totalPrice: 1.3332, totalPriceDecimal: '1.3332', costPrice: 0.1, costPriceDecimal: '0.1', currency: 'USD' }],
  orders: [{ id: 'o1', quotationId: 'q1', partNumber: 'P1', quantity: 2, totalAmount: 0.6666, totalAmountDecimal: '0.6666', outboundQuantity: 1 }],
});
describe('transaction line migration preflight', () => {
  it('preserves valid partial quote/order quantities and exact decimal amounts', () => {
    const data = fixture();
    const before = structuredClone(data);
    expect(assessTransactionLineMigration(data)).toMatchObject({ status: 'PASS', blockers: 0, migrationApplied: false });
    expect(data).toEqual(before);
  });
  it('preserves explicitly requested alternate parts without guessing from prefixes', () => {
    const data = fixture();
    data.rfqs[0].alternatePartNumbers = '["P1-ALT"]';
    data.quotations[0].partNumber = 'P1-ALT';
    data.orders[0].partNumber = 'P1-ALT';
    expect(assessTransactionLineMigration(data).status).toBe('PASS');
    data.quotations[0].partNumber = 'P1-GUESS';
    expect(assessTransactionLineMigration(data).issues).toContainEqual(expect.objectContaining({ code: 'RFQ_PART_MISMATCH' }));
  });
  it('does not authorize source links even for one exact candidate, nor select among duplicates', () => {
    const data = fixture();
    data.inquiries.push({ id: 'i1', supplierId: 's1' });
    data.inquiryItems.push({ ...data.rfqs[0], id: 'ii1', inquiryId: 'i1' });
    expect(assessTransactionLineMigration(data).inquiryCandidates[0]).toEqual({ inquiryId: 'i1', candidateRfqIds: ['r1'], automaticLinkAllowed: false });
    data.rfqs.push({ ...data.rfqs[0], id: 'r2' });
    expect(assessTransactionLineMigration(data).issues).toContainEqual(expect.objectContaining({ code: 'AMBIGUOUS_SOURCE_CANDIDATES', relatedIds: ['r1', 'r2'] }));
  });
  it('blocks duplicate-order aggregate oversell and invalid outbound quantity', () => {
    const data = fixture();
    data.orders.push({ ...data.orders[0], id: 'o2', quantity: 3, outboundQuantity: 4 });
    const report = assessTransactionLineMigration(data);
    expect(report.status).toBe('BLOCKED');
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['ORDERED_QUANTITY_EXCEEDS_QUOTATION', 'INVALID_OUTBOUND_QUANTITY']));
  });
  it('detects conflicting source paths and supplier identities', () => {
    const data = fixture();
    data.inquiries.push({ id: 'i1', supplierId: 'other' });
    data.inquiryItems.push({ id: 'ii1', inquiryId: 'i1', partNumber: 'P1', quantity: 9, requiredDate: new Date('2026-10-01'), certificateRequired: true });
    data.supplierQuotes.push({ ...data.quotations[0], id: 'sq1', supplierId: 's1', inquiryId: 'i1' });
    expect(assessTransactionLineMigration(data).issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['INQUIRY_SUPPLIER_MISMATCH', 'SOURCE_PATH_CONFLICT']));
  });
  it('reports corrupt prices and mismatched shadows without silently repairing them', () => {
    const data = fixture();
    data.quotations[0].unitPriceDecimal = 'NaN';
    data.orders[0].totalAmount = 42;
    const report = assessTransactionLineMigration(data);
    expect(report.status).toBe('BLOCKED');
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['INVALID_UNIT_PRICE', 'TOTAL_AMOUNT_SHADOW_MISMATCH']));
  });
});
