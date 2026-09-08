import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { createRfqAggregate } from '../modules/rfqSourcing/index.js';
import { createQuotationAggregate, submitQuotationAggregate, approveQuotationAggregate,
  acceptQuotationAggregate, sendQuotationAggregate } from '../modules/quotationOrder/service.js';
import { reviseQuotationAggregate } from '../modules/quotationOrder/revisionService.js';
import { ensureOrderContractDocument } from '../lib/documentTemplateService.js';
import { quotationDocumentPdf } from '../lib/quotationDocumentService.js';
import { closeBrowser } from '../lib/pdfService.js';
import { reserveInventoryForQuotation } from '../modules/inventoryQuality/index.js';

const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/');
if (process.env.AEROLINK_REVISION_INTEGRATION !== 'true'
  || !['127.0.0.1', 'localhost'].includes(url.hostname)
  || !/^\/aerolink_revision_test_[a-z0-9_]+$/.test(url.pathname)) {
  throw new Error('Explicit opt-in and local aerolink_revision_test_* database required');
}
const db = new PrismaClient();
const transaction = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(run, {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000,
});
const suffix = randomUUID().slice(0, 8);
try {
  const [owner, manager, customer] = await Promise.all([
    db.user.create({ data: { name: 'Revision owner', email: `revision-owner-${suffix}@example.invalid`, password: 'unusable', role: 'SALES' } }),
    db.user.create({ data: { name: 'Revision approver', email: `revision-manager-${suffix}@example.invalid`, password: 'unusable', role: 'MANAGER' } }),
    db.customer.create({ data: { name: `Revision customer ${suffix}`, contactName: 'Synthetic buyer', email: 'revision@example.invalid' } }),
  ]);
  const approve = async (id: string) => {
    await transaction(tx => submitQuotationAggregate({ tx, quotationId: id, actorId: owner.id }));
    return transaction(tx => approveQuotationAggregate({ tx, quotationId: id, actorId: manager.id, actorRole: 'MANAGER', action: 'approve' }));
  };
  const revise = (id: string, version: number, quotation: Parameters<typeof reviseQuotationAggregate>[0]['quotation']) =>
    transaction(tx => reviseQuotationAggregate({ tx, quotationId: id, actorId: owner.id, version,
      reason: 'Synthetic negotiated terms update', quotation, authorize: () => {}, authorizeRfq: () => {} }));
  const accept = (id: string, version: number, lines?: Array<{ quotationLineId: string; quantity: number }>) =>
    transaction(tx => acceptQuotationAggregate({ tx, quotationId: id, actorId: owner.id, expectedVersion: version,
      lines, ensureContractDocument: ensureOrderContractDocument }));
  const legacyRfq = await transaction(tx => createRfqAggregate(tx, { customerId: customer.id, createdBy: owner.id,
    partNumber: `REV-LEGACY-${suffix}`, quantity: 3, requiredDate: new Date('2027-01-15') }, owner.id));
  const legacyInput = { rfqId: legacyRfq.id, customerId: customer.id, partNumber: legacyRfq.partNumber,
    quantity: 3, unitPrice: 100, costPrice: 50, costSourceType: 'MANUAL', costSourceReason: 'Synthetic priced evidence',
    validityDays: 7, currency: 'USD' };
  const initial = await transaction(tx => createQuotationAggregate({ tx, actorId: owner.id, ...legacyInput }));
  const historicalUnfrozen = await db.generatedDocument.create({ data: {
    quotationId: initial.quotation.id, customerId: customer.id, documentType: 'QUOTATION_PDF',
    title: 'Synthetic unverified legacy file', contentHtml: '<p>Historical content</p>', generatedById: owner.id,
  } });
  await assert.rejects(approve(initial.quotation.id), /没有冻结的历史文件/);
  assert.equal((await db.quotation.findUniqueOrThrow({ where: { id: initial.quotation.id } })).status, 'PENDING_APPROVAL');
  assert.equal(await db.approval.count({ where: { quotationId: initial.quotation.id, action: 'APPROVE' } }), 0);
  await db.generatedDocument.delete({ where: { id: historicalUnfrozen.id } });
  const approved = await transaction(tx => approveQuotationAggregate({ tx, quotationId: initial.quotation.id,
    actorId: manager.id, actorRole: 'MANAGER', action: 'approve' }));
  const firstPdf = await quotationDocumentPdf(db, initial.quotation.id);
  assert.equal(firstPdf.content.subarray(0, 4).toString(), '%PDF');
  await assert.rejects(db.generatedDocument.update({ where: { id: firstPdf.document.id }, data: { contentHtml: '<p>Replaced history</p>' } }), /Frozen document/);
  const originalEvidence = await db.approval.findMany({ where: { quotationId: initial.quotation.id } });
  const inventory = await db.inventoryDetail.create({ data: { quantity: 3, unitCost: 50, type: 'OWN', location: 'TEST',
    inventoryItem: { create: { partNumber: legacyRfq.partNumber, description: 'Synthetic reserved revision inventory' } } } });
  await transaction(tx => reserveInventoryForQuotation(tx, { inventoryDetailId: inventory.id, quotationId: initial.quotation.id, quantity: 2, actorId: owner.id }));
  const reservedQuote = await db.quotation.findUniqueOrThrow({ where: { id: initial.quotation.id } });
  await assert.rejects(revise(initial.quotation.id, reservedQuote.version, { ...legacyInput, costSourceType: 'INVENTORY_DETAIL', costSourceId: 'missing-source' }), /成本来源不存在/);
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: inventory.id } })).status, 'RESERVED');
  assert.equal((await db.quotation.findUniqueOrThrow({ where: { id: initial.quotation.id } })).reservedQuantity, 2);
  assert.equal(await db.quotation.count({ where: { revisionOfId: initial.quotation.id } }), 0);
  await assert.rejects(transaction(tx => approveQuotationAggregate({ tx, quotationId: initial.quotation.id,
    actorId: manager.id, actorRole: 'MANAGER', action: 'approve', costSourceType: 'MANUAL', costSourceReason: 'Replace evidence in place' })), /商业修订/);
  const second = await revise(initial.quotation.id, reservedQuote.version, { ...legacyInput, unitPrice: 120, warrantyDays: 180,
    eSignature: 'old-signature-must-not-transfer', eSignatureStatus: 'Signed' });
  assert.equal(second.quotation.eSignature, null);
  assert.equal(second.quotation.eSignatureStatus, 'Unsigned');
  assert.equal((await db.inventoryDetail.findUniqueOrThrow({ where: { id: inventory.id } })).status, 'AVAILABLE');
  assert.equal(second.quotation.commercialRevision, 2);
  assert.equal(second.quotation.revisionOfId, initial.quotation.id);
  assert.equal(second.quotation.quoteNumber, `${initial.quotation.quoteNumber}-R2`);
  assert.equal(second.quotation.status, 'DRAFT');
  assert.equal(await db.approval.count({ where: { quotationId: second.quotation.id } }), 0);
  const original = await db.quotation.findUniqueOrThrow({ where: { id: initial.quotation.id } });
  assert(original.supersededAt);
  assert.equal(original.reservedQuantity, 0);
  await assert.rejects(transaction(tx => reserveInventoryForQuotation(tx, { inventoryDetailId: inventory.id, quotationId: original.id, quantity: 1, actorId: owner.id })), /新的商业版次/);
  assert.equal(original.unitPrice, 100);
  assert.equal(original.expiryDate.toISOString(), initial.quotation.expiryDate.toISOString());
  assert.deepEqual(await db.approval.findMany({ where: { quotationId: initial.quotation.id } }), originalEvidence);
  await db.customer.update({ where: { id: customer.id }, data: { name: 'Synthetic later customer rename' } });
  const historicalPdf = await quotationDocumentPdf(db, initial.quotation.id);
  assert.deepEqual(historicalPdf.content, firstPdf.content);
  assert.equal(historicalPdf.document.pdfSha256, firstPdf.document.pdfSha256);
  assert(historicalPdf.document.contentHtml.includes(customer.name));
  assert(!historicalPdf.document.contentHtml.includes('Synthetic later customer rename'));
  await assert.rejects(accept(original.id, original.version), /新的商业版次/);
  await assert.rejects(transaction(tx => sendQuotationAggregate({ tx, quotationId: original.id, actorId: owner.id,
    getDefaultOutboundAccount: async () => { throw new Error('must not resolve account'); } })), /新的商业版次/);
  await assert.rejects(accept(second.quotation.id, second.quotation.version), /审批|状态|不能/);
  const secondApproved = await approve(second.quotation.id);
  await quotationDocumentPdf(db, second.quotation.id);
  // No worker is started by this script. The synthetic account is inactive
  // and points at localhost:1; successful enqueue is cancelled below.
  const account = await db.emailAccount.create({ data: { email: `revision-account-${suffix}@example.invalid`,
    imapServer: '127.0.0.1', imapPort: '1', smtpServer: '127.0.0.1', smtpPort: '1',
    authCode: 'synthetic-unusable', isActive: false } });
  const pendingFixture = await db.outboundEmail.create({ data: { quotationId: second.quotation.id, customerId: customer.id,
    accountId: account.id, purpose: 'QUOTATION_SEND', status: 'PENDING', toEmail: 'synthetic@example.invalid', subject: 'Synthetic pending fixture', textBody: 'No outbox is created for this fixture' } });
  await assert.rejects(revise(second.quotation.id, secondApproved.quotation.version, { ...legacyInput, unitPrice: 130 }), /仍在投递/);
  await db.outboundEmail.delete({ where: { id: pendingFixture.id } });
  const sendAndRevise = await Promise.allSettled([
    transaction(tx => sendQuotationAggregate({ tx, quotationId: second.quotation.id, actorId: owner.id,
      getDefaultOutboundAccount: async () => ({ id: account.id }) })),
    revise(second.quotation.id, secondApproved.quotation.version, { ...legacyInput, unitPrice: 130 }),
  ]);
  assert.equal(sendAndRevise.filter(result => result.status === 'fulfilled').length, 1);
  if (sendAndRevise[0].status === 'fulfilled') {
    const current = await db.quotation.findUniqueOrThrow({ where: { id: second.quotation.id } });
    await assert.rejects(revise(current.id, current.version, { ...legacyInput, unitPrice: 130 }), /仍在投递/);
    await db.outboxEvent.updateMany({ where: { aggregateId: current.id, channel: 'EMAIL' }, data: { status: 'CANCELLED' } });
    await db.outboundEmail.updateMany({ where: { quotationId: current.id, status: 'PENDING' }, data: { status: 'FAILED', errorMessage: 'Synthetic test cancelled before delivery' } });
  } else {
    assert.equal(await db.outboundEmail.count({ where: { quotationId: second.quotation.id } }), 0);
  }

  const demands = [4, 3].map((quantity, index) => ({ partNumber: `REV-LINE-${suffix}-${index}`, quantity, requiredDate: new Date('2027-01-15') }));
  const modernRfq = await transaction(tx => createRfqAggregate(tx, { customerId: customer.id, createdBy: owner.id, ...demands[0], lines: demands }, owner.id));
  const modernInput = { rfqId: modernRfq.id, customerId: customer.id, currency: 'USD', validityDays: 7,
    lines: modernRfq.lines.map(line => ({ rfqLineId: line.id, partNumber: line.partNumber, quantity: line.quantity,
      unitPrice: 100, costPrice: 50, costSourceType: 'MANUAL', costSourceReason: 'Synthetic original line cost' })) };
  const modern = await transaction(tx => createQuotationAggregate({ tx, actorId: owner.id, ...modernInput }));
  const modernApproved = await approve(modern.quotation.id);
  const quoteLine = await db.quotationLine.findFirstOrThrow({ where: { quotationId: modern.quotation.id, lineNo: 1 } });
  const partial = await accept(modern.quotation.id, modernApproved.quotation.version, [{ quotationLineId: quoteLine.id, quantity: 2 }]);
  const orderBefore = await db.order.findUniqueOrThrow({ where: { id: partial.order.id }, include: { lines: true } });
  const contractBefore = await db.generatedDocument.findUniqueOrThrow({ where: { id: partial.generatedDocument.id } });
  const remainingInput = { ...modernInput, lines: modernInput.lines.map((line, i) => ({ ...line, quantity: i ? 3 : 2, unitPrice: 125 })) };
  await assert.rejects(revise(modern.quotation.id, partial.quotation.version, modernInput), /未成交数量/);
  assert.equal((await db.quotation.findUniqueOrThrow({ where: { id: modern.quotation.id } })).supersededAt, null);
  const replacement = await revise(modern.quotation.id, partial.quotation.version, remainingInput);
  assert.equal(replacement.quotation.totalPriceDecimal?.toString(), '625');
  assert.deepEqual(await db.order.findUniqueOrThrow({ where: { id: partial.order.id }, include: { lines: true } }), orderBefore);
  assert.deepEqual(await db.generatedDocument.findUniqueOrThrow({ where: { id: partial.generatedDocument.id } }), contractBefore);
  const contenders = await Promise.allSettled([1, 2].map(() => revise(replacement.quotation.id, replacement.quotation.version, remainingInput)));
  assert.equal(contenders.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await db.quotation.count({ where: { revisionOfId: replacement.quotation.id } }), 1);
  assert.equal(await db.quotation.count({ where: { revisionRootId: modern.quotation.id } }), 2);
  console.log(JSON.stringify({ result: 'PASS', legacyRoot: original.id, modernRoot: modern.quotation.id,
    checks: ['new draft and required reapproval', 'original terms and decisions unchanged', 'old offer cannot send or accept',
      'partial order and contract unchanged', 'remaining quantity enforced', 'single concurrent revision', 'cost evidence cannot be replaced in place',
      'PDF bytes unchanged after revision and customer rename', 'database rejects frozen HTML replacement',
      'reservation release and failed revision rollback', 'superseded offer cannot reserve stock',
      'send and revision race has one winner; pending delivery blocks revision'] }, null, 2));
} finally { await db.$disconnect(); await closeBrowser(); }
