import { describe, expect, it } from 'vitest';
import { assertPurchaseApprovalActor, buildPurchaseApprovalSnapshot, purchaseApprovalFingerprint, type PurchasePolicySource } from './purchasePolicy.js';

function source(amount = '5000'): PurchasePolicySource {
  return { orderId: 'order', supplierId: 'supplier', currency: 'USD', totalCost: amount, paymentTerms: 'Net 30',
    lines: [{ id: 'line', lineNo: 1, orderLineId: 'order-line', sourceSupplierQuoteId: 'supplier-quote',
      quantity: 1, unitCost: amount, lineTotal: amount, currency: 'USD', promisedDate: '2027-01-01T00:00:00Z',
      fulfillmentMode: 'STOCK_RECEIPT', partNumber: 'PN-1', uom: 'EA',
      identitySnapshot: { schemaVersion: 1, orderLineId: 'order-line', quotationLineId: 'quote-line', rfqLineId: 'rfq-line',
        partNumber: 'PN-1', uom: 'EA', conditionCode: 'NE', serialNumber: null, batchNumber: null, certificateRequired: false, certificateType: null },
      sourceSnapshot: { schemaVersion: 1, type: 'SUPPLIER_QUOTE', id: 'supplier-quote', currency: 'USD',
        supplierId: 'supplier', rfqLineId: 'rfq-line', partNumber: 'PN-1', quantity: 1, unitCost: amount, validUntil: '2027-01-01T00:00:00Z' } }] };
}
const approve = (role: string, amount = '5000') => assertPurchaseApprovalActor({ actor: { id: 'approver', role }, createdById: 'buyer', source: source(amount) });

describe('procurement approval authority and snapshots', () => {
  it.each([['MANAGER', '5000', 'MANAGER'], ['FINANCE', '5000.0001', 'FINANCE'], ['FINANCE', '50000', 'FINANCE'],
    ['GM', '50000.0001', 'GM'], ['GM', '99999999999999.9999', 'GM']])('uses the shared USD boundary for %s / %s', (role, amount, level) => {
    expect(approve(role, amount).level).toBe(level);
  });
  it('does not treat system administration or AOG urgency as commercial approval authority', () => {
    expect(() => approve('ADMIN')).toThrow(/无权审批/);
    expect(() => approve('MANAGER', '5000.0001')).toThrow(/无权审批/);
    expect(() => approve('FINANCE', '50000.0001')).toThrow(/无权审批/);
  });
  it('forbids both the creator and submitter from self approval', () => {
    expect(() => assertPurchaseApprovalActor({ actor: { id: 'buyer', role: 'GM' }, createdById: 'buyer', source: source() })).toThrow(/不能审批自己/);
    expect(() => assertPurchaseApprovalActor({ actor: { id: 'submitter', role: 'GM' }, createdById: 'buyer', submittedById: 'submitter', source: source() })).toThrow(/不能审批自己/);
  });
  it('keeps exact decimal strings in the immutable snapshot and rejects rounded or inconsistent money', () => {
    expect(buildPurchaseApprovalSnapshot(source('0.0001')).totalCost).toBe('0.0001');
    expect(() => buildPurchaseApprovalSnapshot(source('0.00001'))).toThrow(/Decimal/);
    expect(() => buildPurchaseApprovalSnapshot({ ...source(), totalCost: '1' })).toThrow(/合计/);
    const bad = source(); bad.lines[0].quantity = 2;
    expect(() => buildPurchaseApprovalSnapshot(bad)).toThrow(/行金额/);
  });
  it('binds supplier, source, delivery promise and cost while ignoring object-key order', () => {
    const original = source();
    const hash = purchaseApprovalFingerprint(original);
    const reordered = source(); reordered.lines[0].sourceSnapshot = Object.fromEntries(Object.entries(reordered.lines[0].sourceSnapshot as object).reverse());
    expect(purchaseApprovalFingerprint(reordered)).toBe(hash);
    expect(() => purchaseApprovalFingerprint({ ...original, supplierId: 'different' })).toThrow(/供应商/);
    const changed = source(); changed.lines[0].promisedDate = '2027-02-01';
    expect(purchaseApprovalFingerprint(changed)).not.toBe(hash);
  });
  it('rejects unsupported currency, missing sources, duplicate demand and invalid dates', () => {
    expect(() => buildPurchaseApprovalSnapshot({ ...source(), currency: 'EUR' })).toThrow(/USD/);
    const empty = source(); empty.lines[0].sourceSnapshot = null;
    expect(() => buildPurchaseApprovalSnapshot(empty)).toThrow(/来源快照/);
    const duplicate = source(); duplicate.lines.push({ ...duplicate.lines[0], id: 'line-2', lineNo: 2 });
    expect(() => buildPurchaseApprovalSnapshot(duplicate)).toThrow(/重复/);
    const badDate = source(); badDate.lines[0].promisedDate = 'not a date';
    expect(() => buildPurchaseApprovalSnapshot(badDate)).toThrow(/日期/);
  });
  it.each([{ id: 'different' }, { currency: 'EUR' }, { rfqLineId: 'other' }, { unitCost: '1' }, { quantity: 0 }])
  ('rejects a source snapshot contradicting its canonical purchase line %#', change => {
    const item = source(); Object.assign(item.lines[0].sourceSnapshot as object, change);
    expect(() => buildPurchaseApprovalSnapshot(item)).toThrow();
  });
  it('allows evidenced manual cost without inventing a supplier quote', () => {
    const item = source();
    item.lines[0].sourceSupplierQuoteId = null;
    item.lines[0].sourceSnapshot = { ...(item.lines[0].sourceSnapshot as object), type: 'MANUAL', id: null,
      reason: 'Supplier signed cost confirmation', evidence: [{ id: 'proof', version: 1, sha256: 'a'.repeat(64), status: 'AVAILABLE' }] };
    expect(buildPurchaseApprovalSnapshot(item).totalCost).toBe('5000.0000');
    (item.lines[0].sourceSnapshot as { evidence: unknown[] }).evidence = [];
    expect(() => buildPurchaseApprovalSnapshot(item)).toThrow(/人工采购成本/);
  });
});
