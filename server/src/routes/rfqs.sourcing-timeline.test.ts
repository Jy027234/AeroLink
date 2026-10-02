import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

describe('RFQ sourcing timeline', () => {
  let prismaMock: {
    rFQ: { findFirst: ReturnType<typeof vi.fn> };
    transactionStatusHistory: { findMany: ReturnType<typeof vi.fn> };
    inquiry: { findMany: ReturnType<typeof vi.fn> };
    supplierQuote: { findMany: ReturnType<typeof vi.fn> };
    sourcingActionTask: { findMany: ReturnType<typeof vi.fn> };
    auditLog: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      rFQ: { findFirst: vi.fn().mockResolvedValue({ id: 'rfq-1', createdBy: 'sales-1', creator: { department: 'Sales' }, lines: [] }) },
      transactionStatusHistory: { findMany: vi.fn().mockResolvedValue([]) },
      inquiry: { findMany: vi.fn().mockResolvedValue([]) },
      supplierQuote: { findMany: vi.fn().mockResolvedValue([]) },
      sourcingActionTask: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
  });

  async function buildApp() {
    const rfqsRouter = (await import('./rfqs.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'sales-1', role: 'sales', department: 'Sales' } });
      next();
    });
    app.use('/api/rfqs', rfqsRouter);
    app.use(errorHandler);
    return app;
  }

  it('returns chronological persisted facts with known actors, line identity, and explicit unknown actors', async () => {
    const at = (minute: number) => new Date(`2026-09-25T08:${String(minute).padStart(2, '0')}:00.000Z`);
    prismaMock.transactionStatusHistory.findMany.mockResolvedValue([{ id: 'history-1', fromStatus: 'PENDING', toStatus: 'SOURCING', createdAt: at(0), actor: { id: 'sales-1', name: 'Sales' } }]);
    prismaMock.rFQ.findFirst.mockResolvedValue({
      id: 'rfq-1', status: 'SOURCING', createdBy: 'sales-1', creator: { department: 'Sales' },
      lines: [{ id: 'line-1', status: 'OPEN', quantity: 10 }],
    });
    prismaMock.inquiry.findMany.mockResolvedValue([{
      id: 'inquiry-1', status: 'SENT', sentAt: at(3), createdAt: at(1), supplier: { name: 'Supplier A' },
      items: [{ id: 'inquiry-item-1', rfqLineId: 'line-1', partNumber: 'PN-1' }],
      outboundEmails: [{ id: 'outbound-1', purpose: 'INQUIRY_SEND', status: 'SENT', createdAt: at(2), sentAt: at(3), withdrawnAt: null }],
      emailLinks: [{ id: 'link-1', confirmationStatus: 'CONFIRMED', confirmedAt: at(5), confirmedBy: { id: 'sales-1', name: 'Sales' }, email: { id: 'email-1', from: 'supplier@example.test', receivedAt: at(4), threadMatchStatus: 'MATCHED' } }],
      sourcingAiTasks: [{ id: 'task-1', type: 'SUPPLIER_QUOTE_EXTRACTION', status: 'COMPLETED', createdAt: at(6), startedAt: at(7), completedAt: at(8), cancelledAt: null, actor: { id: 'sales-1', name: 'Sales' }, emailId: 'email-1', draftId: 'draft-1' }],
      quoteDrafts: [{ id: 'draft-1', status: 'CONFIRMED', payloadJson: JSON.stringify({ items: [] }), aiModel: 'fixture-model', aiMetadataJson: JSON.stringify({
        candidateCount: 1,
        originalAiCandidates: {
          schemaVersion: 1, candidateCount: 1, truncated: false,
          items: [{
            itemKey: 'item-1', inquiryItemId: 'inquiry-item-1', partNumber: 'PN-1', quantity: 2,
            quantityUnit: 'EA', unitPrice: 100, currency: 'USD', leadTimeDays: 5,
            leadTimeMinDays: null, leadTimeMaxDays: null, validUntil: null,
            taxIncluded: true, freightIncluded: false, incoterm: 'FCA', evidenceText: 'private email evidence',
          }],
        },
      }), createdAt: at(8), confirmedAt: at(9), confirmedBy: { id: 'sales-1', name: 'Sales' }, emailId: 'email-1' }],
    }]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([{
      id: 'quote-1', rfqId: 'rfq-1', rfqLineId: 'line-1', inquiryId: 'inquiry-1', inquiryItemId: 'inquiry-item-1', partNumber: 'PN-1', sourceDraftId: 'draft-1', supersededAt: null,
      status: 'accepted', isWinner: true, createdAt: at(10), updatedAt: at(11), supplier: { name: 'Supplier A' },
    }]);
    prismaMock.sourcingActionTask.findMany.mockResolvedValue([{
      id: 'send-task-1', action: 'SEND_INQUIRY', status: 'COMPLETED',
      targetInquiryId: 'inquiry-1', targetSupplierQuoteId: null,
      outboundEmailId: 'outbound-1', resultJson: JSON.stringify({ inquiryId: 'inquiry-1', outboundEmailId: 'outbound-1', outboundEmailStatus: 'QUEUED' }), errorSummary: null,
      createdAt: at(1), updatedAt: at(2), confirmedAt: at(2), cancelledAt: null,
      retryHistoryJson: '[]', actor: { id: 'sales-1', name: 'Sales' },
      confirmedBy: { id: 'sales-1', name: 'Sales' }, cancelledBy: null,
    }, {
      id: 'winner-task-1', action: 'SELECT_WINNER', status: 'COMPLETED',
      targetInquiryId: null, targetSupplierQuoteId: 'quote-1',
      outboundEmailId: null, errorSummary: null,
      createdAt: at(10), updatedAt: at(11), confirmedAt: at(11), cancelledAt: null,
      retryHistoryJson: '[]', actor: { id: 'sales-1', name: 'Sales' },
      confirmedBy: { id: 'sales-1', name: 'Sales' }, cancelledBy: null,
    }]);
    prismaMock.auditLog.findMany.mockImplementation(async ({ where }: { where: { resourceType: string; action: string } }) => {
      if (where.resourceType === 'OUTBOUND_EMAIL') return [{ id: 'send-audit-1', resourceId: 'outbound-1', userId: 'sales-1', userName: 'Sales', createdAt: at(2) }];
      if (where.resourceType === 'SUPPLIER_QUOTE_DRAFT' && where.action === 'UPDATE') {
        return [{ id: 'draft-audit-1', resourceId: 'draft-1', userId: 'sales-1', userName: 'Sales', createdAt: at(9), changes: JSON.stringify({ version: { before: 1, after: 2 } }) }];
      }
      if (where.resourceType === 'SUPPLIER_QUOTE_DRAFT') return [];
      return [{ id: 'winner-audit-1', resourceId: 'quote-1', userId: 'sales-1', userName: 'Sales', createdAt: at(11) }];
    });

    const response = await request(await buildApp()).get('/api/rfqs/rfq-1/sourcing-timeline');
    expect(response.status).toBe(200);
    expect(response.body.data.rfqId).toBe('rfq-1');
    const events = response.body.data.events;
    expect(events.map((event: { occurredAt: string }) => event.occurredAt)).toEqual([...events.map((event: { occurredAt: string }) => event.occurredAt)].sort());
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'RFQ_STATUS', actor: { id: 'sales-1', name: 'Sales', kind: 'user' } }),
      expect.objectContaining({ type: 'INQUIRY_SEND_CONFIRMED', status: 'QUEUED', outboundEmailId: 'outbound-1', actor: { id: 'sales-1', name: 'Sales', kind: 'user' } }),
      expect.objectContaining({ type: 'OUTBOUND_EMAIL', status: 'SENT', inquiryId: 'inquiry-1', rfqLineId: 'line-1', actor: null }),
      expect.objectContaining({ type: 'INBOUND_EMAIL', actor: { id: 'supplier@example.test', name: 'supplier@example.test', kind: 'external_email' } }),
      expect.objectContaining({ type: 'AI_TASK', draftId: 'draft-1' }),
      expect.objectContaining({ type: 'QUOTE_DRAFT', draftId: 'draft-1', summary: 'Supplier A AI 提出 1 条报价候选草稿，待人工核对' }),
      expect.objectContaining({ type: 'QUOTE_DRAFT_REVISED', draftId: 'draft-1', summary: 'Supplier A 报价草稿已人工修订（v2）', actor: { id: 'sales-1', name: 'Sales', kind: 'user' } }),
      expect.objectContaining({ type: 'QUOTE_DRAFT_CONFIRMED', actor: { id: 'sales-1', name: 'Sales', kind: 'user' } }),
      expect.objectContaining({ type: 'WINNER_SELECTED', supplierQuoteId: 'quote-1', rfqLineId: 'line-1', actor: { id: 'sales-1', name: 'Sales', kind: 'user' } }),
      expect.objectContaining({ type: 'ACTION_TASK', actionTaskId: 'send-task-1', status: 'COMPLETED', inquiryId: 'inquiry-1', outboundEmailId: 'outbound-1', actor: { id: 'sales-1', name: 'Sales', kind: 'user' } }),
      expect.objectContaining({ type: 'ACTION_TASK', actionTaskId: 'winner-task-1', status: 'COMPLETED', supplierQuoteId: 'quote-1', rfqLineId: 'line-1' }),
    ]));
    const draftEvent = events.find((event: { type: string }) => event.type === 'QUOTE_DRAFT');
    expect(draftEvent.originalAiCandidates).toMatchObject({
      available: true,
      candidateCount: 1,
      truncated: false,
      items: [{ partNumber: 'PN-1', quantity: 2, unitPrice: 100, currency: 'USD', incoterm: 'FCA' }],
    });
    expect(JSON.stringify(draftEvent.originalAiCandidates)).not.toContain('private email evidence');
    expect(prismaMock.inquiry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { rfqId: 'rfq-1' } }));
    expect(prismaMock.supplierQuote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      OR: [{ rfqId: 'rfq-1' }, { inquiry: { is: { rfqId: 'rfq-1' } } }],
    } }));
    expect(events.filter((event: { type: string }) => event.type === 'WINNER_SELECTED')).toHaveLength(1);
    expect(response.body.data.counts).toEqual({
      lines: [{ rfqLineId: 'line-1', pendingQuoteCount: 0, pendingConfirmationCount: 0 }],
      unassignedNeedsVerification: { pendingQuoteCount: 0, pendingConfirmationCount: 0, supplierQuoteCount: 0, unreadableDraftCount: 0 },
    });
    expect(response.body.data.workflowStates).toEqual([{
      inquiryId: 'inquiry-1', status: 'COMPLETED', nextAction: 'REVIEW_COMPARISON',
    }]);
  });

  it('marks historical AI drafts without a persisted candidate snapshot as unavailable', async () => {
    const createdAt = new Date('2026-09-25T08:08:00.000Z');
    prismaMock.inquiry.findMany.mockResolvedValue([{
      id: 'inquiry-1', status: 'SENT', sentAt: createdAt, createdAt, supplier: { name: 'Supplier A' },
      items: [{ id: 'inquiry-item-1', rfqLineId: 'line-1', partNumber: 'PN-1' }],
      outboundEmails: [], emailLinks: [], sourcingAiTasks: [],
      quoteDrafts: [{
        id: 'old-draft', status: 'DRAFT', payloadJson: JSON.stringify({ items: [] }), aiModel: 'legacy-model',
        aiMetadataJson: JSON.stringify({ candidateCount: 2 }), createdAt, confirmedAt: null, confirmedBy: null, emailId: 'email-1',
      }],
    }]);

    const response = await request(await buildApp()).get('/api/rfqs/rfq-1/sourcing-timeline');

    expect(response.status).toBe(200);
    expect(response.body.data.events).toContainEqual(expect.objectContaining({
      type: 'QUOTE_DRAFT',
      draftId: 'old-draft',
      originalAiCandidates: { available: false, candidateCount: 2, truncated: false, items: [] },
    }));
  });

  it('projects current pending draft items by explicit inquiry item identity without leaking email evidence', async () => {
    const createdAt = new Date('2026-09-25T08:08:00.000Z');
    prismaMock.rFQ.findFirst.mockResolvedValue({
      id: 'rfq-1', status: 'SOURCING', createdBy: 'sales-1', creator: { department: 'Sales' },
      lines: [
        { id: 'line-1', status: 'OPEN', quantity: 10 },
        { id: 'line-2', status: 'OPEN', quantity: 10 },
      ],
    });
    const inquiry = (id: string, supplierName: string, items: Array<{ id: string; rfqLineId: string; partNumber: string }>, quoteDrafts: Array<Record<string, unknown>>) => ({
      id, status: 'SENT', sentAt: createdAt, createdAt, supplier: { name: supplierName }, items,
      outboundEmails: [], emailLinks: [], sourcingAiTasks: [], quoteDrafts: quoteDrafts.map((draft) => ({
        createdAt, confirmedAt: draft.status === 'CONFIRMED' ? createdAt : null, confirmedBy: null, ...draft,
      })),
    });
    prismaMock.inquiry.findMany.mockResolvedValue([
      inquiry('inquiry-a', 'Supplier A', [
        { id: 'item-a1', rfqLineId: 'line-1', partNumber: 'PN-DUP' },
        { id: 'item-a2', rfqLineId: 'line-2', partNumber: 'PN-DUP' },
      ], [{
        id: 'draft-a', version: 4, status: 'DRAFT', emailId: 'email-a', aiModel: 'fixture-model', aiMetadataJson: null,
        payloadJson: JSON.stringify({ items: [
          { inquiryItemId: 'item-a2', partNumber: 'PN-DUP', quantity: 2, quantityUnit: 'EA', unitPrice: 40, currency: 'EUR', leadTimeDays: 7 },
          { inquiryItemId: 'item-a1', partNumber: 'PN-DUP', quantity: 1, unitPrice: 90, currency: 'EUR', condition: 'NE', certificate: '8130-3', freightIncluded: true, evidenceText: 'private supplier email excerpt', notes: 'private note' },
        ] }),
      }]),
      inquiry('inquiry-b', 'Supplier B', [
        { id: 'item-b1', rfqLineId: 'line-1', partNumber: 'PN-DUP' },
      ], [{
        id: 'draft-b', version: 2, status: 'DRAFT', emailId: 'email-b', aiModel: null, aiMetadataJson: null,
        payloadJson: JSON.stringify({ items: [
          { inquiryItemId: 'item-b1', partNumber: 'PN-DUP', quantity: 3, quantityUnit: 'EA', unitPrice: 1200, currency: 'CNY', leadTimeDays: 14, taxIncluded: false },
        ] }),
      }]),
      inquiry('inquiry-c', 'Supplier C', [
        { id: 'item-c1', rfqLineId: 'line-1', partNumber: 'PN-DUP' },
      ], [{
        id: 'draft-c', version: 1, status: 'DRAFT', emailId: 'email-c', aiModel: 'fixture-model', aiMetadataJson: null,
        payloadJson: JSON.stringify({ items: [
          { inquiryItemId: 'item-c1', partNumber: 'PN-DUP', quantity: 1, quantityUnit: 'EA', currency: 'USD', leadTimeMinDays: 10, leadTimeMaxDays: 20 },
        ] }),
      }]),
      inquiry('inquiry-bad', 'Supplier Bad', [
        { id: 'item-bad', rfqLineId: 'line-1', partNumber: 'PN-DUP' },
      ], [{ id: 'draft-bad', version: 1, status: 'DRAFT', emailId: 'email-bad', payloadJson: '{not-json' }]),
      inquiry('inquiry-confirmed', 'Supplier Confirmed', [
        { id: 'item-confirmed', rfqLineId: 'line-1', partNumber: 'PN-DUP' },
      ], [{
        id: 'draft-confirmed', version: 1, status: 'CONFIRMED', emailId: 'email-confirmed',
        payloadJson: JSON.stringify({ items: [
          { inquiryItemId: 'item-confirmed', partNumber: 'PN-DUP', quantity: 1, quantityUnit: 'EA', unitPrice: 1, currency: 'USD', leadTimeDays: 1 },
        ] }),
      }]),
      inquiry('inquiry-unbound', 'Supplier Unbound', [
        { id: 'item-unbound', rfqLineId: 'line-1', partNumber: 'PN-DUP' },
      ], [{
        id: 'draft-unbound', version: 1, status: 'DRAFT', emailId: 'email-unbound', payloadJson: JSON.stringify({ items: [
          { partNumber: 'PN-DUP', quantity: 1, quantityUnit: 'EA', unitPrice: 1, currency: 'USD', leadTimeDays: 1 },
        ] }),
      }]),
    ]);

    const response = await request(await buildApp()).get('/api/rfqs/rfq-1/sourcing-timeline');

    expect(response.status).toBe(200);
    const rows = response.body.data.pendingQuoteRows;
    expect(rows).toHaveLength(4);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rfqLineId: 'line-1', inquiryId: 'inquiry-a', inquiryItemId: 'item-a1', draftId: 'draft-a',
        draftVersion: 4, emailId: 'email-a', supplierName: 'Supplier A', source: 'ai',
        partNumber: 'PN-DUP', quantity: 1, quantityUnit: null, unitPrice: 90, currency: 'EUR',
        leadTimeDays: null, leadTimeMinDays: null, leadTimeMaxDays: null,
        condition: 'NE', certificate: '8130-3', taxIncluded: null, freightIncluded: true, validUntil: null,
      }),
      expect.objectContaining({
        rfqLineId: 'line-2', inquiryId: 'inquiry-a', inquiryItemId: 'item-a2',
        partNumber: 'PN-DUP', currency: 'EUR', leadTimeDays: 7,
      }),
      expect.objectContaining({
        rfqLineId: 'line-1', inquiryId: 'inquiry-b', draftId: 'draft-b', source: 'manual',
        quantity: 3, unitPrice: 1200, currency: 'CNY', taxIncluded: false,
      }),
      expect.objectContaining({
        rfqLineId: 'line-1', inquiryId: 'inquiry-c', draftId: 'draft-c', source: 'ai',
        quantityUnit: 'EA', unitPrice: null, currency: 'USD', leadTimeDays: null,
        leadTimeMinDays: 10, leadTimeMaxDays: 20,
      }),
    ]));
    expect(rows.map((row: { supplierName: string }) => row.supplierName)).not.toContain('Supplier Bad');
    expect(rows.map((row: { supplierName: string }) => row.supplierName)).not.toContain('Supplier Confirmed');
    expect(rows.map((row: { supplierName: string }) => row.supplierName)).not.toContain('Supplier Unbound');
    expect(JSON.stringify(rows)).not.toContain('private supplier email excerpt');
    expect(JSON.stringify(rows)).not.toContain('private note');
  });

  it('projects only unconfirmed rows from a partially confirmed draft and counts them as pending', async () => {
    const createdAt = new Date('2026-09-25T08:08:00.000Z');
    prismaMock.rFQ.findFirst.mockResolvedValue({
      id: 'rfq-1', status: 'SOURCING', createdBy: 'sales-1', creator: { department: 'Sales' },
      lines: [
        { id: 'line-1', status: 'OPEN', quantity: 10 },
        { id: 'line-2', status: 'OPEN', quantity: 10 },
      ],
    });
    prismaMock.inquiry.findMany.mockResolvedValue([{
      id: 'inquiry-1', status: 'SENT', sentAt: createdAt, createdAt,
      supplier: { name: 'Supplier A' },
      items: [
        { id: 'item-1', rfqLineId: 'line-1', partNumber: 'PN-1' },
        { id: 'item-2', rfqLineId: 'line-2', partNumber: 'PN-2' },
      ],
      outboundEmails: [{ id: 'outbound-1', purpose: 'INQUIRY_SEND', status: 'SENT', createdAt, sentAt: createdAt, withdrawnAt: null }],
      emailLinks: [], sourcingAiTasks: [],
      quoteDrafts: [{
        id: 'draft-1', version: 3, status: 'PARTIALLY_CONFIRMED', emailId: 'email-1',
        aiModel: null, aiMetadataJson: null,
        payloadJson: JSON.stringify({ items: [
          { itemKey: 'offer-1', inquiryItemId: 'item-1', partNumber: 'PN-1', quantity: 2, quantityUnit: 'EA', unitPrice: 50, currency: 'USD', leadTimeDays: 5 },
          { itemKey: 'offer-2', inquiryItemId: 'item-2', partNumber: 'PN-2', quantity: 1, quantityUnit: 'EA', unitPrice: null, currency: 'RMB', leadTimeMinDays: 5, leadTimeMaxDays: 10 },
        ] }),
        createdAt, confirmedAt: createdAt, confirmedBy: { id: 'sales-1', name: 'Sales' },
      }],
    }]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([{
      id: 'quote-1', rfqId: 'rfq-1', rfqLineId: 'line-1', inquiryId: 'inquiry-1', inquiryItemId: 'item-1',
      sourceDraftId: 'draft-1', sourceDraftItemKey: 'offer-1', partNumber: 'PN-1', quantity: 2,
      supersededAt: null, status: 'pending', isWinner: false, createdAt, updatedAt: createdAt,
      supplier: { name: 'Supplier A' },
    }]);
    prismaMock.auditLog.findMany.mockImplementation(async ({ where }: { where: { action: string } }) =>
      where.action === 'CONFIRM' ? [{
        id: 'confirm-audit-1', resourceId: 'draft-1', userId: 'sales-1', userName: 'Sales', createdAt,
        changes: JSON.stringify({
          version: 3,
          status: { before: 'DRAFT', after: 'PARTIALLY_CONFIRMED' },
          itemKeys: ['offer-1'], supplierQuoteIds: ['quote-1'],
        }),
      }] : []);

    const response = await request(await buildApp()).get('/api/rfqs/rfq-1/sourcing-timeline');

    expect(response.status).toBe(200);
    expect(response.body.data.pendingQuoteRows).toEqual([expect.objectContaining({
      draftId: 'draft-1', draftVersion: 3, itemKey: 'offer-2',
      inquiryItemId: 'item-2', rfqLineId: 'line-2', currency: 'RMB',
    })]);
    expect(response.body.data.counts.lines).toEqual([
      { rfqLineId: 'line-1', pendingQuoteCount: 0, pendingConfirmationCount: 0 },
      { rfqLineId: 'line-2', pendingQuoteCount: 0, pendingConfirmationCount: 1 },
    ]);
    expect(response.body.data.events).toContainEqual(expect.objectContaining({
      type: 'QUOTE_DRAFT_CONFIRMED', status: 'PARTIALLY_CONFIRMED',
      itemKeys: ['offer-1'], supplierQuoteIds: ['quote-1'],
      summary: 'Supplier A 已人工确认 1 行正式报价，其余行仍待核对',
    }));
  });

  it('counts pending items only by explicit RFQ line/inquiry-item bindings and separates unassignable records', async () => {
    const at = new Date('2026-09-25T08:00:00.000Z');
    prismaMock.rFQ.findFirst.mockResolvedValue({
      id: 'rfq-1', createdBy: 'sales-1', creator: { department: 'Sales' },
      lines: [{ id: 'line-1', status: 'OPEN', quantity: 10 }, { id: 'line-2', status: 'OPEN', quantity: 10 }],
    });
    const inquiryRecord = (
      id: string,
      items: Array<{ id: string; rfqLineId: string | null; partNumber: string }>,
      quoteDrafts: Array<{ id: string; status: string; payloadJson: string }> = [],
    ) => ({
      id, status: 'SENT', sentAt: at, createdAt: at, supplier: { name: `Supplier ${id}` }, items,
      outboundEmails: [{ id: `outbound-${id}`, purpose: 'INQUIRY_SEND', status: 'SENT', createdAt: at, sentAt: at, withdrawnAt: null }],
      emailLinks: [], sourcingAiTasks: [],
      quoteDrafts: quoteDrafts.map((draft) => ({ ...draft, createdAt: at, confirmedAt: null, confirmedBy: null, emailId: null })),
    });
    prismaMock.inquiry.findMany.mockResolvedValue([
      inquiryRecord('inquiry-a', [
        { id: 'item-a1', rfqLineId: 'line-1', partNumber: 'PN-DUP' },
        { id: 'item-a2', rfqLineId: 'line-2', partNumber: 'PN-DUP' },
        { id: 'item-a3', rfqLineId: null, partNumber: 'PN-DUP' },
      ]),
      inquiryRecord('inquiry-b', [
        { id: 'item-b1', rfqLineId: 'line-1', partNumber: 'PN-DUP' },
        { id: 'item-b2', rfqLineId: 'line-2', partNumber: 'PN-DUP' },
      ], [{ id: 'draft-b', status: 'DRAFT', payloadJson: JSON.stringify({ items: [
        { inquiryItemId: 'item-b1', partNumber: 'ALT-PN-DUP', quantity: 1 },
        { partNumber: 'PN-DUP', quantity: 1 },
      ] }) }]),
      inquiryRecord('inquiry-c', [{ id: 'item-c1', rfqLineId: 'line-1', partNumber: 'PN-DUP' }], [
        { id: 'draft-c', status: 'DRAFT', payloadJson: '{not-json' },
      ]),
      inquiryRecord('inquiry-d', [{ id: 'item-d1', rfqLineId: 'line-2', partNumber: 'PN-DUP' }]),
      {
        id: 'inquiry-e', status: 'SENT', sentAt: at, createdAt: at, supplier: { name: 'Supplier inquiry-e' },
        items: [{ id: 'item-e1', rfqLineId: 'line-1', partNumber: 'PN-DUP' }],
        outboundEmails: [{ id: 'outbound-inquiry-e', purpose: 'INQUIRY_SEND', status: 'NEEDS_VERIFICATION', createdAt: at, sentAt: null, withdrawnAt: null }],
        emailLinks: [], sourcingAiTasks: [], quoteDrafts: [],
      },
    ]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([{
      id: 'partial-quote', rfqId: null, rfqLineId: 'line-1', inquiryId: 'inquiry-a', inquiryItemId: 'item-a1',
      partNumber: 'ALT-PN-DUP', quantity: 1, supersededAt: null, status: 'pending', isWinner: false, createdAt: at, updatedAt: at,
      supplier: { name: 'Supplier inquiry-a' },
    }, {
      id: 'old-revision', rfqId: 'rfq-1', rfqLineId: 'line-2', inquiryId: 'inquiry-a', inquiryItemId: 'item-a2',
      partNumber: 'WRONG-OLD-REVISION', quantity: 1, supersededAt: at, status: 'pending', isWinner: false, createdAt: at, updatedAt: at,
      supplier: { name: 'Supplier inquiry-a' },
    }, {
      id: 'current-revision', rfqId: 'rfq-1', rfqLineId: 'line-2', inquiryId: 'inquiry-a', inquiryItemId: 'item-a2',
      partNumber: 'PN-DUP', quantity: 1, supersededAt: null, status: 'pending', isWinner: false, createdAt: at, updatedAt: at,
      supplier: { name: 'Supplier inquiry-a' },
    }, {
      id: 'superseded-only', rfqId: 'rfq-1', rfqLineId: 'line-2', inquiryId: 'inquiry-d', inquiryItemId: 'item-d1',
      partNumber: 'PN-DUP', quantity: 1, supersededAt: at, status: 'pending', isWinner: false, createdAt: at, updatedAt: at,
      supplier: { name: 'Supplier inquiry-d' },
    }]);

    const response = await request(await buildApp()).get('/api/rfqs/rfq-1/sourcing-timeline');
    expect(response.status).toBe(200);
    expect(response.body.data.counts).toEqual({
      lines: [
        { rfqLineId: 'line-1', pendingQuoteCount: 1, pendingConfirmationCount: 1 },
        { rfqLineId: 'line-2', pendingQuoteCount: 2, pendingConfirmationCount: 0 },
      ],
      unassignedNeedsVerification: {
        pendingQuoteCount: 1,
        pendingConfirmationCount: 1,
        supplierQuoteCount: 0,
        unreadableDraftCount: 1,
      },
    });
  });

  it('derives recoverable inquiry workflow states from the latest send, confirmed replies, drafts, and current quotes', async () => {
    const at = (minute: number) => new Date(`2026-09-25T08:${String(minute).padStart(2, '0')}:00.000Z`);
    prismaMock.rFQ.findFirst.mockResolvedValue({
      id: 'rfq-1', status: 'SOURCING', createdBy: 'sales-1', creator: { department: 'Sales' },
      lines: [{ id: 'line-1', status: 'OPEN', quantity: 5 }, { id: 'line-2', status: 'OPEN', quantity: 2 }],
    });
    const sent = (id: string, createdMinute: number, sentMinute: number, status = 'SENT') => ({
      id, purpose: 'INQUIRY_SEND', status, createdAt: at(createdMinute), sentAt: status === 'SENT' ? at(sentMinute) : null, withdrawnAt: null,
    });
    const reply = (id: string, emailMinute: number, status = 'CONFIRMED') => ({
      id: `link-${id}`, confirmationStatus: status, confirmedAt: status === 'CONFIRMED' ? at(emailMinute + 1) : null, confirmedBy: null,
      email: { id, from: `${id}@supplier.test`, receivedAt: at(emailMinute), threadMatchStatus: 'MATCHED' },
    });
    const record = (id: string, options: {
      status?: string; sentAt?: Date | null; emails?: ReturnType<typeof sent>[];
      links?: ReturnType<typeof reply>[]; tasks?: Array<Record<string, unknown>>;
      drafts?: Array<Record<string, unknown>>; itemId?: string; lineId?: string; partNumber?: string;
    } = {}) => ({
      id, status: options.status ?? 'SENT', sentAt: options.sentAt ?? null, createdAt: at(1), supplier: { name: `Supplier ${id}` },
      items: [{ id: options.itemId ?? `item-${id}`, rfqLineId: options.lineId ?? 'line-1', partNumber: options.partNumber ?? 'PN-1' }],
      outboundEmails: options.emails ?? [], emailLinks: options.links ?? [], sourcingAiTasks: options.tasks ?? [],
      quoteDrafts: options.drafts ?? [],
    });
    prismaMock.inquiry.findMany.mockResolvedValue([
      record('failed-send', { emails: [sent('failed-email', 2, 0, 'FAILED')] }),
      record('new-send-old-reply', {
        status: 'RESPONDED', sentAt: at(6), emails: [sent('old-send', 2, 3), sent('new-send', 5, 6)], links: [reply('old-reply', 4)],
      }),
      record('legacy-no-time'),
      record('legacy-old-quote', { sentAt: at(6), lineId: 'line-2' }),
      record('alternate-part', {
        status: 'RESPONDED', sentAt: at(3), emails: [sent('alternate-send', 2, 3)], links: [reply('alternate-reply', 4)], partNumber: 'PN-1',
      }),
      record('missing-source-draft', {
        status: 'RESPONDED', sentAt: at(3), emails: [sent('missing-draft-send', 2, 3)], links: [reply('missing-draft-reply', 4)],
      }),
      record('human-recovery', {
        status: 'RESPONDED', sentAt: at(3), emails: [sent('recovery-send', 2, 3)], links: [reply('recovery-reply', 4)],
        tasks: [{ id: 'failed-ai', type: 'SUPPLIER_QUOTE_EXTRACTION', status: 'FAILED', draftId: null, emailId: 'recovery-reply', createdAt: at(5), updatedAt: at(6), actor: null }],
        drafts: [{ id: 'recovery-draft', emailId: 'recovery-reply', status: 'CONFIRMED', payloadJson: JSON.stringify({ items: [{ inquiryItemId: 'item-human-recovery', partNumber: 'ALT-PN', quantity: 1 }] }), createdAt: at(7), confirmedAt: at(8), confirmedBy: null }],
        partNumber: 'PN-1',
      }),
    ]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([
      { id: 'legacy-quote-no-time', rfqId: 'rfq-1', rfqLineId: 'line-1', inquiryId: 'legacy-no-time', inquiryItemId: 'item-legacy-no-time', sourceDraftId: null, partNumber: 'PN-1', supersededAt: null, createdAt: at(8) },
      { id: 'legacy-quote-old', rfqId: 'rfq-1', rfqLineId: 'line-2', inquiryId: 'legacy-old-quote', inquiryItemId: 'item-legacy-old-quote', sourceDraftId: null, partNumber: 'PN-1', supersededAt: null, createdAt: at(5) },
      { id: 'alternate-formal-quote', rfqId: 'rfq-1', rfqLineId: 'line-1', inquiryId: 'alternate-part', inquiryItemId: 'item-alternate-part', sourceDraftId: null, partNumber: 'ALT-PN', supersededAt: null, createdAt: at(6) },
      { id: 'quote-with-missing-source', rfqId: 'rfq-1', rfqLineId: 'line-1', inquiryId: 'missing-source-draft', inquiryItemId: 'item-missing-source-draft', sourceDraftId: 'missing-draft', partNumber: 'PN-1', supersededAt: null, createdAt: at(6) },
      { id: 'human-confirmed-quote', rfqId: 'rfq-1', rfqLineId: 'line-1', inquiryId: 'human-recovery', inquiryItemId: 'item-human-recovery', sourceDraftId: 'recovery-draft', partNumber: 'ALT-PN', supersededAt: null, createdAt: at(9) },
    ].map((quote) => ({
      ...quote,
      status: 'pending', isWinner: false, quantity: 1,
      updatedAt: quote.createdAt, supplier: { name: 'Supplier' },
    })));

    const response = await request(await buildApp()).get('/api/rfqs/rfq-1/sourcing-timeline');
    expect(response.status).toBe(200);
    const states = response.body.data.workflowStates as Array<{ inquiryId: string; status: string; nextAction: string }>;
    const stateByInquiryId = Object.fromEntries(states.map((state) => [state.inquiryId, state]));
    expect(stateByInquiryId['failed-send']).toMatchObject({ status: 'FAILED', nextAction: 'REVIEW_BEFORE_RESEND' });
    expect(stateByInquiryId['new-send-old-reply']).toMatchObject({ status: 'WAITING_REPLY', nextAction: 'FOLLOW_UP_SUPPLIER' });
    expect(stateByInquiryId['legacy-no-time']).toMatchObject({ status: 'NEEDS_VERIFICATION', nextAction: 'VERIFY_RECORD' });
    expect(stateByInquiryId['legacy-old-quote']).toMatchObject({ status: 'NEEDS_VERIFICATION', nextAction: 'VERIFY_RECORD' });
    expect(stateByInquiryId['alternate-part']).toMatchObject({ status: 'COMPLETED', nextAction: 'REVIEW_COMPARISON' });
    expect(stateByInquiryId['missing-source-draft']).toMatchObject({ status: 'NEEDS_VERIFICATION', nextAction: 'VERIFY_RECORD' });
    expect(stateByInquiryId['human-recovery']).toMatchObject({ status: 'COMPLETED', nextAction: 'REVIEW_COMPARISON' });
  });

  it('keeps unknown delivery ahead of RFQ cancellation and describes cancellation as stopping future sourcing only', async () => {
    const at = new Date('2026-09-25T08:00:00.000Z');
    prismaMock.rFQ.findFirst.mockResolvedValue({
      id: 'rfq-1', status: 'CANCELLED', createdBy: 'sales-1', creator: { department: 'Sales' }, lines: [],
    });
    prismaMock.inquiry.findMany.mockResolvedValue([{
      id: 'uncertain', status: 'SENT', sentAt: null, createdAt: at, supplier: { name: 'Supplier' }, items: [],
      outboundEmails: [{ id: 'outbound-uncertain', purpose: 'INQUIRY_SEND', status: 'NEEDS_VERIFICATION', createdAt: at, sentAt: null, withdrawnAt: null }],
      emailLinks: [], quoteDrafts: [], sourcingAiTasks: [],
    }, {
      id: 'cancelled', status: 'DRAFT', sentAt: null, createdAt: at, supplier: { name: 'Supplier' }, items: [],
      outboundEmails: [], emailLinks: [], quoteDrafts: [], sourcingAiTasks: [],
    }]);

    const response = await request(await buildApp()).get('/api/rfqs/rfq-1/sourcing-timeline');
    expect(response.status).toBe(200);
    const stateByInquiryId = Object.fromEntries(response.body.data.workflowStates.map((state: { inquiryId: string }) => [state.inquiryId, state]));
    expect(stateByInquiryId.uncertain).toMatchObject({ status: 'NEEDS_VERIFICATION', nextAction: 'VERIFY_DELIVERY' });
    expect(stateByInquiryId.cancelled).toMatchObject({ status: 'CANCELLED', nextAction: 'STOP_CANCELLED_RFQ' });
  });

  it('projects current send tasks and outbound facts into inquiry and line stages without treating queueing or quote quantity as fulfillment', async () => {
    const at = (minute: number) => new Date(`2026-09-25T08:${String(minute).padStart(2, '0')}:00.000Z`);
    const lineIds = ['line-draft', 'line-resend-pending', 'line-queued', 'line-sent', 'line-quoted', 'line-old-quote', 'line-partial', 'line-invalid-result', 'line-failed'];
    prismaMock.rFQ.findFirst.mockResolvedValue({
      id: 'rfq-1', status: 'SOURCING', createdBy: 'sales-1', creator: { department: 'Sales' },
      lines: lineIds.map((id) => ({ id, status: 'OPEN', quantity: 500 })),
    });
    const inquiry = (id: string, lineId: string, options: {
      status?: string; emails?: Array<Record<string, unknown>>; sentAt?: Date | null;
    } = {}) => ({
      id, status: options.status ?? 'DRAFT', sentAt: options.sentAt ?? null, createdAt: at(0), supplier: { name: `Supplier ${id}` },
      items: [{ id: `item-${id}`, rfqLineId: lineId, partNumber: `PN-${id}` }],
      outboundEmails: options.emails ?? [], emailLinks: [], quoteDrafts: [], sourcingAiTasks: [],
    });
    const outbound = (id: string, minute: number, status: string) => ({
      id, purpose: 'INQUIRY_SEND', status, createdAt: at(minute), sentAt: status === 'SENT' ? at(minute + 1) : null, withdrawnAt: null,
    });
    prismaMock.inquiry.findMany.mockResolvedValue([
      inquiry('needs-confirmation', 'line-draft'),
      inquiry('resend-needs-confirmation', 'line-resend-pending', {
        status: 'SENT', sentAt: at(3), emails: [outbound('outbound-prior-send', 2, 'SENT')],
      }),
      inquiry('queued', 'line-queued', { status: 'QUEUED', emails: [outbound('outbound-queued', 2, 'QUEUED')] }),
      inquiry('sent', 'line-sent', { status: 'SENT', sentAt: at(4), emails: [outbound('outbound-sent', 3, 'SENT')] }),
      inquiry('quoted', 'line-quoted', { status: 'SENT', sentAt: at(4), emails: [outbound('outbound-quoted', 3, 'SENT')] }),
      inquiry('old-quote-new-send', 'line-old-quote', {
        status: 'SENT', sentAt: at(8), emails: [outbound('outbound-old', 2, 'SENT'), outbound('outbound-new', 7, 'SENT')],
      }),
      inquiry('partial-quoted', 'line-partial', { status: 'SENT', sentAt: at(4), emails: [outbound('outbound-partial', 3, 'SENT')] }),
      inquiry('partial-waiting', 'line-partial', { status: 'SENT', sentAt: at(4), emails: [outbound('outbound-partial-waiting', 3, 'SENT')] }),
      inquiry('invalid-result', 'line-invalid-result', { status: 'SENT', sentAt: at(4), emails: [outbound('outbound-invalid-result', 3, 'SENT')] }),
      inquiry('failed', 'line-failed'),
    ]);
    const sendTask = (id: string, inquiryId: string, status: string, minute: number, options: {
      outboundEmailId?: string | null; resultJson?: string | null;
    } = {}) => ({
      id, action: 'SEND_INQUIRY', status, targetInquiryId: inquiryId, targetSupplierQuoteId: null,
      outboundEmailId: options.outboundEmailId ?? null, resultJson: options.resultJson ?? null,
      errorSummary: null, createdAt: at(minute), updatedAt: at(minute + 1), confirmedAt: status === 'COMPLETED' ? at(minute + 1) : null,
      cancelledAt: null, retryHistoryJson: '[]', actor: { id: 'sales-1', name: 'Sales' },
      confirmedBy: status === 'COMPLETED' ? { id: 'sales-1', name: 'Sales' } : null, cancelledBy: null,
    });
    const taskResult = (inquiryId: string, outboundEmailId: string, outboundEmailStatus = 'QUEUED') => JSON.stringify({
      inquiryId, outboundEmailId, outboundEmailStatus,
    });
    prismaMock.sourcingActionTask.findMany.mockResolvedValue([
      sendTask('task-unconfirmed', 'needs-confirmation', 'WAITING_HUMAN', 1),
      sendTask('task-resend-unconfirmed', 'resend-needs-confirmation', 'WAITING_HUMAN', 4),
      sendTask('task-queued', 'queued', 'COMPLETED', 1, {
        outboundEmailId: 'outbound-queued', resultJson: taskResult('queued', 'outbound-queued'),
      }),
      sendTask('task-sent', 'sent', 'COMPLETED', 1, {
        outboundEmailId: 'outbound-sent', resultJson: taskResult('sent', 'outbound-sent'),
      }),
      sendTask('task-quoted', 'quoted', 'COMPLETED', 1, {
        outboundEmailId: 'outbound-quoted', resultJson: taskResult('quoted', 'outbound-quoted'),
      }),
      sendTask('task-new-send', 'old-quote-new-send', 'COMPLETED', 6, {
        outboundEmailId: 'outbound-new', resultJson: taskResult('old-quote-new-send', 'outbound-new'),
      }),
      sendTask('task-partial', 'partial-quoted', 'COMPLETED', 1, {
        outboundEmailId: 'outbound-partial', resultJson: taskResult('partial-quoted', 'outbound-partial'),
      }),
      sendTask('task-partial-waiting', 'partial-waiting', 'COMPLETED', 1, {
        outboundEmailId: 'outbound-partial-waiting', resultJson: taskResult('partial-waiting', 'outbound-partial-waiting'),
      }),
      sendTask('task-invalid-result', 'invalid-result', 'COMPLETED', 1, {
        outboundEmailId: 'outbound-invalid-result', resultJson: taskResult('invalid-result', 'different-outbound'),
      }),
      sendTask('task-failed', 'failed', 'FAILED', 1),
    ]);
    prismaMock.supplierQuote.findMany.mockResolvedValue([{
      id: 'quote-quoted', rfqId: 'rfq-1', rfqLineId: 'line-quoted', inquiryId: 'quoted', inquiryItemId: 'item-quoted',
      sourceDraftId: null, partNumber: 'ALT-PN', quantity: 1, supersededAt: null, status: 'pending', isWinner: false,
      createdAt: at(6), updatedAt: at(7), supplier: { name: 'Supplier quoted' },
    }, {
      id: 'quote-from-prior-send', rfqId: 'rfq-1', rfqLineId: 'line-old-quote', inquiryId: 'old-quote-new-send', inquiryItemId: 'item-old-quote-new-send',
      sourceDraftId: null, partNumber: 'PN-OLD', quantity: 1, supersededAt: null, status: 'pending', isWinner: false,
      createdAt: at(6), updatedAt: at(6), supplier: { name: 'Supplier old quote' },
    }, {
      id: 'quote-partial', rfqId: 'rfq-1', rfqLineId: 'line-partial', inquiryId: 'partial-quoted', inquiryItemId: 'item-partial-quoted',
      sourceDraftId: null, partNumber: 'ALT-PN', quantity: 1, supersededAt: null, status: 'pending', isWinner: false,
      createdAt: at(6), updatedAt: at(7), supplier: { name: 'Supplier partial' },
    }]);

    const response = await request(await buildApp()).get('/api/rfqs/rfq-1/sourcing-timeline');

    expect(response.status).toBe(200);
    const workflowByInquiryId = Object.fromEntries(response.body.data.workflowStates.map((state: { inquiryId: string }) => [state.inquiryId, state]));
    expect(workflowByInquiryId['needs-confirmation']).toMatchObject({ status: 'WAITING_HUMAN', nextAction: 'SEND_INQUIRY' });
    expect(workflowByInquiryId['resend-needs-confirmation']).toMatchObject({ status: 'WAITING_HUMAN', nextAction: 'SEND_INQUIRY' });
    expect(workflowByInquiryId.queued).toMatchObject({ status: 'PROCESSING', nextAction: 'WAIT_FOR_PROCESSING' });
    // SEND resultJson records that the action queued a message; the later persisted SENT
    // status is what advances the workflow to waiting for a supplier response.
    expect(workflowByInquiryId.sent).toMatchObject({ status: 'WAITING_REPLY', nextAction: 'FOLLOW_UP_SUPPLIER' });
    expect(workflowByInquiryId['invalid-result']).toMatchObject({ status: 'NEEDS_VERIFICATION', nextAction: 'VERIFY_DELIVERY' });
    expect(workflowByInquiryId.failed).toMatchObject({ status: 'FAILED', nextAction: 'REVIEW_BEFORE_RESEND' });

    const lineStates = Object.fromEntries(response.body.data.lineWorkflowStates.map((state: { rfqLineId: string }) => [state.rfqLineId, state]));
    expect(lineStates['line-draft']).toMatchObject({ status: 'WAITING_HUMAN', inquiryIds: ['needs-confirmation'] });
    expect(lineStates['line-resend-pending']).toMatchObject({ status: 'WAITING_HUMAN', inquiryIds: ['resend-needs-confirmation'] });
    expect(lineStates['line-queued']).toMatchObject({ status: 'PROCESSING' });
    expect(lineStates['line-sent']).toMatchObject({ status: 'WAITING_REPLY' });
    expect(lineStates['line-quoted']).toMatchObject({
      status: 'COMPLETED', nextAction: 'REVIEW_COMPARISON', inquiryIds: ['quoted'],
      quoteCoverage: {
        currentFormalQuoteCount: 1, activeInquiryItemCount: 1, quotedInquiryItemCount: 1,
        basis: 'CURRENT_FORMAL_QUOTE_RECORDS_ONLY', quantitySufficiencyAssessed: false, purchasingCommitted: false,
      },
    });
    expect(lineStates['line-old-quote']).toMatchObject({
      status: 'WAITING_REPLY',
      quoteCoverage: { currentFormalQuoteCount: 1, activeInquiryItemCount: 1, quotedInquiryItemCount: 0 },
    });
    expect(lineStates['line-partial']).toMatchObject({
      status: 'WAITING_REPLY', inquiryIds: ['partial-quoted', 'partial-waiting'],
      quoteCoverage: { currentFormalQuoteCount: 1, activeInquiryItemCount: 2, quotedInquiryItemCount: 1 },
    });
    expect(lineStates['line-invalid-result']).toMatchObject({ status: 'NEEDS_VERIFICATION' });
    expect(lineStates['line-failed']).toMatchObject({ status: 'FAILED' });
  });

  it('does not query sourcing records when the RFQ is outside the read scope', async () => {
    prismaMock.rFQ.findFirst.mockResolvedValue(null);
    const response = await request(await buildApp()).get('/api/rfqs/other-rfq/sourcing-timeline');
    expect(response.status).toBe(404);
    expect(prismaMock.inquiry.findMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.findMany).not.toHaveBeenCalled();
  });
});
