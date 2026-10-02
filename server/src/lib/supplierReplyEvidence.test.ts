import { describe, expect, it } from 'vitest';
import { supplierReplyBody, evidencedOfferQuantity } from './supplierReplyEvidence.js';

describe('supplier reply evidence boundary', () => {
  it.each([
    'Latest PN-1 USD 50\nOn Monday, Buyer wrote:\nPN-1 Qty 2 EA USD 10',
    'Latest PN-1 USD 50\n-----Original Message-----\nPN-1 Qty 2 EA USD 10',
    'Latest PN-1 USD 50\n发件人：buyer@example.invalid\n发送时间：Monday\nPN-1 Qty 2 EA USD 10',
    'Latest PN-1 USD 50<div class="gmail_quote">PN-1 Qty 2 EA USD 10</div>',
    'Latest PN-1 USD 50<div id="divRplyFwdMsg">PN-1 Qty 2 EA USD 10</div>',
  ])('excludes recognizable trailing history: %s', body => {
    expect(supplierReplyBody(body).trim()).toBe('Latest PN-1 USD 50');
  });
  it('removes nested quoted blocks but retains subsequent unquoted reply', () => {
    expect(supplierReplyBody('New<blockquote>Old<blockquote>Older</blockquote>Old end</blockquote>More')).toBe('NewMore');
    expect(supplierReplyBody('New<blockquote>Unclosed old')).toBe('New');
    expect(supplierReplyBody('New\n> Old line\nMore')).toBe('New\nMore');
  });
  it.each([
    [2, 'M3-TEST-PN-001，库存数量 2，报价150元人民币；'],
    [2, 'PN-1\n需求数量 2\n库存数量 6\n单价 845.20\n币种 USD\n交期 2周'],
    [4, 'PN-1 stock 4, USD 50 each'],
    [2, 'PN-1 USD 2 each'],
  ])('does not treat inventory, demand or price as offer quantity', (quantity, evidence) => {
    expect(evidencedOfferQuantity(quantity as number, evidence as string)).toBe(false);
  });
  it.each([
    'We can offer 2 pcs of PN-1 at USD 50 each',
    'PN-1 Qty: 2 EA at USD 50',
    'PN-1 库存数量 6，承诺数量 2 EA，USD 50',
    'PN-1 可供数量：2 EA，库存数量6',
    '2 pcs of PN-1 at USD 50 each',
  ])('keeps explicit supplier quantity: %s', evidence => {
    expect(evidencedOfferQuantity(2, evidence)).toBe(true);
    expect(evidencedOfferQuantity(3, evidence)).toBe(false);
  });
});
