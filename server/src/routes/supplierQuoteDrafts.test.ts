import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

describe('supplier quote draft routes', () => {
  let app: express.Application;
  let prismaMock: {
    email: { findUnique: ReturnType<typeof vi.fn> };
    inquiry: { findUnique: ReturnType<typeof vi.fn> };
    inquiryEmailLink: { findUnique: ReturnType<typeof vi.fn> };
    inquiryItem: { findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
    supplierQuoteDraft: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findUniqueOrThrow: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    supplierQuote: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    rFQ: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    rfqLine: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    sourcingAiTask: { findFirst: ReturnType<typeof vi.fn> };
    auditLog: { create: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let extractSupplierQuoteEmail: ReturnType<typeof vi.fn>;
  let captureSourcingAiTaskSourceFingerprint: ReturnType<typeof vi.fn>;
  let confirmSupplierQuoteDraftCommand: typeof import('../lib/supplierQuoteDraftConfirmCommand.js')['confirmSupplierQuoteDraftCommand'];
  let actorRole: string;

  const email = {
    id: 'email-1',
    from: 'vendor@example.com',
    fromName: 'Vendor',
    subject: 'Supplier quote',
    body: 'PN-1, USD 50 each, 5 days',
    receivedAt: new Date('2026-07-22T00:00:00.000Z'),
    attachmentRecords: [],
  };
  const inquiryItems = [
    { id: 'item-1', partNumber: 'PN-1', quantity: 4, rfqLineId: null },
    { id: 'item-2', partNumber: 'PN-1', quantity: 4, rfqLineId: null },
    { id: 'item-3', partNumber: 'PN-2', quantity: 2, rfqLineId: null },
  ];
  const inquiry = {
    id: 'inquiry-1',
    inquiryNumber: 'INQ-1',
    supplierId: 'supplier-1',
    rfqId: 'rfq-1',
    supplier: { email: 'vendor@example.com' },
    items: inquiryItems,
  };
  const confirmedLink = { confirmationStatus: 'CONFIRMED' };

  function draftRecord(data: Record<string, unknown>) {
    return {
      id: 'draft-1',
      emailId: 'email-1',
      inquiryId: 'inquiry-1',
      supplierId: 'supplier-1',
      status: 'DRAFT',
      version: 1,
      payloadJson: data.payloadJson as string,
      aiProvider: null,
      aiModel: data.aiModel ?? null,
      aiPromptVersion: data.aiPromptVersion ?? null,
      aiConfidence: null,
      aiMetadataJson: data.aiMetadataJson ?? null,
      confirmedAt: null,
      confirmedById: null,
      createdAt: new Date('2026-07-22T00:00:00.000Z'),
      updatedAt: new Date('2026-07-22T00:00:00.000Z'),
      email,
      inquiry,
      supplier: { id: 'supplier-1', name: 'Vendor', email: 'vendor@example.com' },
      supplierQuotes: [],
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    actorRole = 'sales';
    extractSupplierQuoteEmail = vi.fn();
    captureSourcingAiTaskSourceFingerprint = vi.fn().mockResolvedValue('source-current');
    prismaMock = {
      email: { findUnique: vi.fn() },
      inquiry: { findUnique: vi.fn() },
      inquiryEmailLink: { findUnique: vi.fn() },
      inquiryItem: { findMany: vi.fn(), findUnique: vi.fn() },
      supplierQuoteDraft: {
        findFirst: vi.fn(),
        create: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        updateMany: vi.fn(),
      },
      supplierQuote: { create: vi.fn(), findMany: vi.fn() },
      rFQ: { findUnique: vi.fn(), findFirst: vi.fn() },
      rfqLine: { findUnique: vi.fn(), findMany: vi.fn() },
      sourcingAiTask: { findFirst: vi.fn() },
      auditLog: { create: vi.fn() },
      $transaction: vi.fn(),
    };
    prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(prismaMock));
    prismaMock.email.findUnique.mockResolvedValue(email);
    prismaMock.inquiry.findUnique.mockImplementation(async ({ select }: { select?: Record<string, unknown> }) =>
      select?.supplier || select?.items ? inquiry : { id: 'inquiry-1', rfqId: 'rfq-1', supplierId: 'supplier-1' });
    prismaMock.inquiryEmailLink.findUnique.mockResolvedValue(confirmedLink);
    prismaMock.supplierQuoteDraft.findFirst.mockResolvedValue(null);
    prismaMock.supplierQuoteDraft.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => draftRecord(data));
    prismaMock.supplierQuote.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'quote-created',
      ...data,
    }));
    prismaMock.rfqLine.findMany.mockResolvedValue([]);
    prismaMock.rFQ.findFirst.mockResolvedValue({ id: 'rfq-1', createdBy: 'sales-1', creator: { department: 'Sales' } });
    prismaMock.rFQ.findUnique.mockResolvedValue({
      id: 'rfq-1', partNumber: 'PN-1', quantity: 4, uom: 'EA', alternatePartNumbers: null,
    });
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));
    vi.doMock('../lib/aiService.js', () => ({ extractSupplierQuoteEmail }));
    vi.doMock('../lib/sourcingAiTaskService.js', () => ({
      captureSourcingAiTaskSourceFingerprint,
      SUPPLIER_QUOTE_EXTRACTION_TASK: 'supplier_quote_extraction',
    }));

    ({ confirmSupplierQuoteDraftCommand } = await import('../lib/supplierQuoteDraftConfirmCommand.js'));
    const router = (await import('./supplierQuoteDrafts.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string; email: string; name: string; role: string } }).user = {
        id: 'sales-1',
        email: 'sales@example.com',
        name: 'Sales',
        role: actorRole,
      };
      next();
    });
    app.use('/api/supplier-quote-drafts', router);
    app.use(errorHandler);
  });

  it('stores sparse manual payloads and assigns stable item keys', async () => {
    const response = await request(app)
      .post('/api/supplier-quote-drafts')
      .send({
        emailId: 'email-1',
        inquiryId: 'inquiry-1',
        payload: {
          items: [{
            inquiryItemId: null,
            partNumber: 'PN-1',
            quantity: 2,
            unitPrice: 10,
            currency: null,
            leadTimeMinDays: 3,
            leadTimeMaxDays: 5,
            taxIncluded: false,
            freightIncluded: true,
            incoterm: 'dap',
            evidenceText: 'vendor said 3-5 days',
          }],
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.data.version).toBe(1);
    expect(response.body.data.payload.items[0]).toMatchObject({
      inquiryItemId: null,
      currency: null,
      leadTimeMinDays: 3,
      leadTimeMaxDays: 5,
      taxIncluded: false,
      freightIncluded: true,
      incoterm: 'DAP',
    });
    expect(response.body.data.payload.items[0].itemKey).toBeTruthy();
    expect(JSON.parse(prismaMock.supplierQuoteDraft.create.mock.calls[0][0].data.payloadJson).items[0].itemKey)
      .toBe(response.body.data.payload.items[0].itemKey);
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('rejects invalid commercial terms on a manual draft', async () => {
    const response = await request(app)
      .post('/api/supplier-quote-drafts')
      .send({
        emailId: 'email-1',
        inquiryId: 'inquiry-1',
        payload: { items: [{ incoterm: 'X' }] },
      });

    expect(response.status).toBe(400);
    expect(prismaMock.supplierQuoteDraft.create).not.toHaveBeenCalled();
  });

  it('restores the latest draft for one email and inquiry after a page refresh', async () => {
    prismaMock.supplierQuoteDraft.findFirst.mockResolvedValue(draftRecord({
      payloadJson: JSON.stringify({ items: [{ itemKey: 'saved-item', partNumber: 'PN-1', currency: null }] }),
    }));

    const response = await request(app)
      .get('/api/supplier-quote-drafts')
      .query({ emailId: 'email-1', inquiryId: 'inquiry-1' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: 'draft-1',
      emailId: 'email-1',
      inquiryId: 'inquiry-1',
      payload: { items: [{ itemKey: 'saved-item', partNumber: 'PN-1', currency: null }] },
    });
    expect(prismaMock.supplierQuoteDraft.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { emailId: 'email-1', inquiryId: 'inquiry-1' },
      orderBy: { version: 'desc' },
    }));
  });

  it('checks RFQ read scope before returning latest or by-id draft details', async () => {
    prismaMock.rFQ.findFirst.mockResolvedValue(null);

    const latest = await request(app)
      .get('/api/supplier-quote-drafts')
      .query({ emailId: 'email-1', inquiryId: 'inquiry-1' });

    expect(latest.status).toBe(404);
    expect(prismaMock.supplierQuoteDraft.findFirst).not.toHaveBeenCalled();

    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue({ emailId: 'email-1', inquiryId: 'inquiry-1' });
    const byId = await request(app).get('/api/supplier-quote-drafts/draft-1');

    expect(byId.status).toBe(404);
    expect(prismaMock.supplierQuoteDraft.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.supplierQuoteDraft.findUnique).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      select: { emailId: true, inquiryId: true },
    });
  });

  it('allows unbound legacy inquiries only to all-scope RFQ readers', async () => {
    prismaMock.inquiry.findUnique.mockResolvedValue({ id: 'inquiry-1', rfqId: null, supplierId: 'supplier-1' });

    const scopedReader = await request(app)
      .get('/api/supplier-quote-drafts')
      .query({ emailId: 'email-1', inquiryId: 'inquiry-1' });
    expect(scopedReader.status).toBe(404);
    expect(prismaMock.supplierQuoteDraft.findFirst).not.toHaveBeenCalled();

    actorRole = 'admin';
    const allScopeReader = await request(app)
      .get('/api/supplier-quote-drafts')
      .query({ emailId: 'email-1', inquiryId: 'inquiry-1' });
    expect(allScopeReader.status).toBe(200);
    expect(prismaMock.rFQ.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuoteDraft.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { emailId: 'email-1', inquiryId: 'inquiry-1' },
    }));
  });

  it('requires the confirmed email-to-inquiry link when reading a draft', async () => {
    prismaMock.inquiryEmailLink.findUnique.mockResolvedValue({ confirmationStatus: 'PENDING' });

    const response = await request(app)
      .get('/api/supplier-quote-drafts')
      .query({ emailId: 'email-1', inquiryId: 'inquiry-1' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(prismaMock.supplierQuoteDraft.findFirst).not.toHaveBeenCalled();
  });

  it('blocks manual creation and AI extraction before accessing a foreign RFQ email body', async () => {
    prismaMock.rFQ.findFirst.mockResolvedValue(null);

    const manual = await request(app)
      .post('/api/supplier-quote-drafts')
      .send({ emailId: 'email-1', inquiryId: 'inquiry-1', payload: { items: [{ partNumber: 'PN-1' }] } });
    expect(manual.status).toBe(404);
    expect(prismaMock.supplierQuoteDraft.create).not.toHaveBeenCalled();

    prismaMock.email.findUnique.mockClear();
    const extracted = await request(app)
      .post('/api/supplier-quote-drafts/extract')
      .send({ emailId: 'email-1', inquiryId: 'inquiry-1' });
    expect(extracted.status).toBe(404);
    expect(prismaMock.email.findUnique).not.toHaveBeenCalled();
    expect(extractSupplierQuoteEmail).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuoteDraft.create).not.toHaveBeenCalled();
  });

  it('blocks cross-scope edits and confirmation before changing or replaying supplier quotes', async () => {
    prismaMock.rFQ.findFirst.mockResolvedValue(null);
    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue({
      id: 'draft-1', emailId: 'email-1', inquiryId: 'inquiry-1', supplierId: 'supplier-1',
      status: 'DRAFT', version: 1, payloadJson: JSON.stringify({ items: [] }),
    });

    const patchResponse = await request(app)
      .patch('/api/supplier-quote-drafts/draft-1')
      .send({ expectedVersion: 1, payload: { items: [] } });
    expect(patchResponse.status).toBe(404);
    expect(prismaMock.supplierQuoteDraft.updateMany).not.toHaveBeenCalled();

    const confirmResponse = await request(app)
      .post('/api/supplier-quote-drafts/draft-1/confirm')
      .send({ expectedVersion: 1 });
    expect(confirmResponse.status).toBe(404);
    expect(prismaMock.supplierQuoteDraft.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();

    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue({
      id: 'draft-1', emailId: 'email-1', inquiryId: 'inquiry-1', supplierId: 'supplier-1',
      status: 'CONFIRMED', version: 1, payloadJson: JSON.stringify({ items: [] }),
    });
    const replayResponse = await request(app)
      .post('/api/supplier-quote-drafts/draft-1/confirm')
      .send({ expectedVersion: 1 });
    expect(replayResponse.status).toBe(404);
    expect(prismaMock.supplierQuote.findMany).not.toHaveBeenCalled();
  });

  it('optimistically updates only the requested draft version', async () => {
    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue({
      id: 'draft-1', emailId: 'email-1', inquiryId: 'inquiry-1', status: 'DRAFT', version: 2,
    });
    prismaMock.supplierQuoteDraft.updateMany.mockResolvedValue({ count: 0 });

    const response = await request(app)
      .patch('/api/supplier-quote-drafts/draft-1')
      .send({ expectedVersion: 1, payload: { items: [] } });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('STATE_CONFLICT');
    expect(prismaMock.supplierQuoteDraft.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('keeps commercial terms when a manual draft is patched', async () => {
    let savedPayloadJson = '';
    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue({
      id: 'draft-1', emailId: 'email-1', inquiryId: 'inquiry-1', status: 'DRAFT', version: 1,
    });
    prismaMock.supplierQuoteDraft.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      savedPayloadJson = data.payloadJson as string;
      return { count: 1 };
    });
    prismaMock.supplierQuoteDraft.findUniqueOrThrow.mockImplementation(async () => draftRecord({ payloadJson: savedPayloadJson }));

    const response = await request(app)
      .patch('/api/supplier-quote-drafts/draft-1')
      .send({
        expectedVersion: 1,
        payload: { items: [{ itemKey: 'manual-item', taxIncluded: true, freightIncluded: false, incoterm: 'cpt' }] },
      });

    expect(response.status).toBe(200);
    expect(response.body.data.payload.items[0]).toMatchObject({
      taxIncluded: true,
      freightIncluded: false,
      incoterm: 'CPT',
    });
    expect(JSON.parse(savedPayloadJson).items[0]).toMatchObject({
      taxIncluded: true,
      freightIncluded: false,
      incoterm: 'CPT',
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: 'sales-1', action: 'UPDATE', resourceType: 'SUPPLIER_QUOTE_DRAFT', resourceId: 'draft-1',
      changes: JSON.stringify({ version: { before: 1, after: 2 } }),
    }) });
  });

  it('saves AI candidates as a sparse draft, resolves only unique exact inquiry items, and creates no quotes', async () => {
    extractSupplierQuoteEmail.mockResolvedValue({
      items: [
        {
          partNumber: ' PN-1 ',
          quantity: 2,
          unitPrice: 50,
          currency: 'USD',
          leadTimeMinDays: 3,
          leadTimeMaxDays: 5,
          validUntil: null,
          condition: null,
          certificate: null,
          taxIncluded: true,
          freightIncluded: false,
          incoterm: 'ddp',
          evidenceText: 'USD 50',
        },
        {
          partNumber: 'OTHER',
          quantity: null,
          unitPrice: null,
          currency: null,
          leadTimeDays: null,
          leadTimeMinDays: null,
          leadTimeMaxDays: null,
          validUntil: null,
          condition: null,
          certificate: null,
          evidenceText: 'quote details unavailable',
        },
        {
          partNumber: ' pn-2 ',
          quantity: 1,
          unitPrice: 30,
          currency: 'USD',
          leadTimeDays: 2,
          validUntil: null,
          condition: null,
          certificate: null,
          evidenceText: 'PN-2 USD 30',
        },
      ],
      ai: { agentId: 'agent-quote', promptVersion: 3, model: 'model-x' },
    });

    const response = await request(app)
      .post('/api/supplier-quote-drafts/extract')
      .send({ emailId: 'email-1', inquiryId: 'inquiry-1' });

    expect(response.status).toBe(201);
    expect(extractSupplierQuoteEmail).toHaveBeenCalledWith(
      email.subject,
      email.body,
      expect.objectContaining({
        items: [
          { inquiryItemId: 'item-1', partNumber: 'PN-1', quantity: 4 },
          { inquiryItemId: 'item-2', partNumber: 'PN-1', quantity: 4 },
          { inquiryItemId: 'item-3', partNumber: 'PN-2', quantity: 2 },
        ],
      }),
      { actorId: 'sales-1', action: 'business.extract-supplier-quote-email' },
    );
    expect(response.body.data.payload.items[0]).toMatchObject({
      partNumber: 'PN-1',
      inquiryItemId: null,
      currency: 'USD',
      leadTimeMinDays: 3,
      leadTimeMaxDays: 5,
      taxIncluded: true,
      freightIncluded: false,
      incoterm: 'DDP',
      evidenceText: 'USD 50',
    });
    expect(response.body.data.payload.items[1]).toMatchObject({
      partNumber: 'OTHER',
      inquiryItemId: null,
      quantity: null,
      unitPrice: null,
      currency: null,
      taxIncluded: null,
      freightIncluded: null,
      incoterm: null,
    });
    expect(response.body.data.payload.items[2]).toMatchObject({
      partNumber: 'PN-2',
      inquiryItemId: 'item-3',
      leadTimeDays: 2,
    });
    expect(response.body.data.aiModel).toBe('model-x');
    expect(response.body.data.aiPromptVersion).toBe('3');
    const aiMetadata = JSON.parse(prismaMock.supplierQuoteDraft.create.mock.calls[0][0].data.aiMetadataJson);
    expect(aiMetadata).toMatchObject({ agentId: 'agent-quote', candidateCount: 3 });
    expect(aiMetadata.originalAiCandidates).toMatchObject({
      schemaVersion: 1, candidateCount: 3, truncated: false,
      items: [
        { partNumber: 'PN-1', inquiryItemId: null, quantity: 2, unitPrice: 50, currency: 'USD', leadTimeMinDays: 3, leadTimeMaxDays: 5, taxIncluded: true, freightIncluded: false, incoterm: 'DDP' },
        { partNumber: 'OTHER', quantity: null, unitPrice: null, currency: null },
        { partNumber: 'PN-2', inquiryItemId: 'item-3', quantity: 1, unitPrice: 30, currency: 'USD', leadTimeDays: 2 },
      ],
    });
    expect(JSON.stringify(aiMetadata.originalAiCandidates)).not.toContain('evidenceText');
    expect(JSON.stringify(aiMetadata.originalAiCandidates)).not.toContain('USD 50');
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('refuses to confirm missing USD values or an unnormalized lead-time range', async () => {
    const invalidPayloads = [
      {
        itemKey: 'missing-currency',
        inquiryItemId: 'item-1',
        partNumber: 'PN-1',
        quantity: 2,
        unitPrice: 50,
        leadTimeDays: 5,
      },
      {
        itemKey: 'range',
        inquiryItemId: 'item-1',
        partNumber: 'PN-1',
        quantity: 2,
        unitPrice: 50,
        currency: 'USD',
        leadTimeMinDays: 3,
        leadTimeMaxDays: 5,
      },
      {
        itemKey: 'non-usd',
        inquiryItemId: 'item-1',
        partNumber: 'PN-1',
        quantity: 2,
        unitPrice: 50,
        currency: 'EUR',
        leadTimeDays: 5,
      },
    ];
    for (const item of invalidPayloads.map((candidate) => ({ quantityUnit: 'EA', ...candidate }))) {
      prismaMock.supplierQuoteDraft.findUnique.mockResolvedValueOnce({
        id: 'draft-1',
        emailId: 'email-1',
        inquiryId: 'inquiry-1',
        supplierId: 'supplier-1',
        status: 'DRAFT',
        version: 1,
        payloadJson: JSON.stringify({ items: [item] }),
      });
      const response = await request(app)
        .post('/api/supplier-quote-drafts/draft-1/confirm')
        .send({ expectedVersion: 1 });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    }
    expect(prismaMock.supplierQuoteDraft.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('rejects cross-inquiry items, mismatched part numbers, and quantities above demand', async () => {
    const invalidItems = [
      { itemKey: 'foreign', inquiryItemId: 'foreign-item', partNumber: 'PN-1', quantity: 2, quantityUnit: 'EA', unitPrice: 50, currency: 'USD', leadTimeDays: 5 },
      { itemKey: 'wrong-part', inquiryItemId: 'item-1', partNumber: 'OTHER', quantity: 2, quantityUnit: 'EA', unitPrice: 50, currency: 'USD', leadTimeDays: 5 },
      { itemKey: 'too-many', inquiryItemId: 'item-1', partNumber: 'PN-1', quantity: 5, quantityUnit: 'EA', unitPrice: 50, currency: 'USD', leadTimeDays: 5 },
    ];
    for (const item of invalidItems) {
      prismaMock.supplierQuoteDraft.findUnique.mockResolvedValueOnce({
        id: 'draft-1',
        emailId: 'email-1',
        inquiryId: 'inquiry-1',
        supplierId: 'supplier-1',
        status: 'DRAFT',
        version: 1,
        payloadJson: JSON.stringify({ items: [item] }),
      });
      prismaMock.inquiryItem.findMany.mockResolvedValueOnce(
        item.inquiryItemId === 'foreign-item'
          ? []
          : [{ id: 'item-1', inquiryId: 'inquiry-1', partNumber: 'PN-1', quantity: 4 }],
      );
      const response = await request(app)
        .post('/api/supplier-quote-drafts/draft-1/confirm')
        .send({ expectedVersion: 1 });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('RESOURCE_CONFLICT');
    }
    expect(prismaMock.supplierQuoteDraft.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('requires an explicit unit and rejects a unit that differs from the RFQ demand unit', async () => {
    const draft = {
      id: 'draft-1', emailId: 'email-1', inquiryId: 'inquiry-1', supplierId: 'supplier-1',
      status: 'DRAFT', version: 1,
    };
    const completeItem = {
      itemKey: 'offer-a', inquiryItemId: 'item-1', partNumber: 'PN-1', quantity: 2,
      unitPrice: 50, currency: 'USD', leadTimeDays: 5,
    };
    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValueOnce({
      ...draft, payloadJson: JSON.stringify({ items: [completeItem] }),
    });
    const missingUnit = await request(app)
      .post('/api/supplier-quote-drafts/draft-1/confirm')
      .send({ expectedVersion: 1 });
    expect(missingUnit.status).toBe(409);
    expect(missingUnit.body.code).toBe('VALIDATION_ERROR');

    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValueOnce({
      ...draft, payloadJson: JSON.stringify({ items: [{ ...completeItem, quantityUnit: 'BOX' }] }),
    });
    prismaMock.inquiryItem.findMany.mockResolvedValueOnce([
      { id: 'item-1', inquiryId: 'inquiry-1', partNumber: 'PN-1', quantity: 4 },
    ]);
    prismaMock.inquiryItem.findUnique.mockResolvedValueOnce({
      id: 'item-1', inquiryId: 'inquiry-1', rfqLineId: null, partNumber: 'PN-1', quantity: 4,
      inquiry: { id: 'inquiry-1', rfqId: 'rfq-1', supplierId: 'supplier-1' },
    });
    const mismatch = await request(app)
      .post('/api/supplier-quote-drafts/draft-1/confirm')
      .send({ expectedVersion: 1 });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('RESOURCE_CONFLICT');
    expect(mismatch.body.message).toContain('单位');
    expect(prismaMock.supplierQuoteDraft.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('confirms all lines transactionally and replays the same quote IDs on repeat', async () => {
    const payloadJson = JSON.stringify({
      items: [
        {
          itemKey: 'offer-a',
          inquiryItemId: 'item-1',
          partNumber: 'PN-1',
          quantity: 2,
          quantityUnit: 'eA',
          unitPrice: 50,
          currency: 'USD',
          leadTimeDays: 5,
          validUntil: '2026-08-01',
          taxIncluded: true,
          freightIncluded: false,
          incoterm: 'DAP',
        },
        {
          itemKey: 'offer-b',
          inquiryItemId: 'item-1',
          partNumber: 'PN-1',
          quantity: 1,
          quantityUnit: 'EA',
          unitPrice: 45,
          currency: 'USD',
          leadTimeDays: 8,
        },
      ],
    });
    const draft = {
      id: 'draft-1',
      emailId: 'email-1',
      inquiryId: 'inquiry-1',
      supplierId: 'supplier-1',
      status: 'DRAFT',
      version: 1,
      payloadJson,
    };
    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue(draft);
    prismaMock.inquiryItem.findMany.mockResolvedValue([{ id: 'item-1', inquiryId: 'inquiry-1', partNumber: 'PN-1', quantity: 4 }]);
    prismaMock.inquiryItem.findUnique.mockResolvedValue({
      id: 'item-1',
      inquiryId: 'inquiry-1',
      rfqLineId: null,
      partNumber: 'PN-1',
      quantity: 4,
      inquiry: { id: 'inquiry-1', rfqId: 'rfq-1', supplierId: 'supplier-1' },
    });
    prismaMock.supplierQuoteDraft.updateMany.mockResolvedValue({ count: 1 });
    const quotes = [
      { id: 'quote-a', sourceDraftId: 'draft-1', sourceDraftItemKey: 'offer-a' },
      { id: 'quote-b', sourceDraftId: 'draft-1', sourceDraftItemKey: 'offer-b' },
    ];
    prismaMock.supplierQuote.create
      .mockResolvedValueOnce(quotes[0])
      .mockResolvedValueOnce(quotes[1]);
    prismaMock.supplierQuote.findMany.mockResolvedValue(quotes);

    const first = await request(app)
      .post('/api/supplier-quote-drafts/draft-1/confirm')
      .send({ expectedVersion: 1 });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      reused: false,
      supplierQuoteIds: ['quote-a', 'quote-b'],
      createdSupplierQuoteIds: ['quote-a', 'quote-b'],
      reusedSupplierQuoteIds: [],
    });
    expect(prismaMock.supplierQuote.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.supplierQuote.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceDraftId: 'draft-1',
        sourceDraftItemKey: 'offer-a',
        inquiryId: 'inquiry-1',
        inquiryItemId: 'item-1',
        supplierId: 'supplier-1',
        currency: 'USD',
        currencyReviewStatus: 'VERIFIED',
        quantityUnit: 'eA',
      }),
    }));
    expect(JSON.parse(payloadJson).items[0]).toMatchObject({ taxIncluded: true, freightIncluded: false, incoterm: 'DAP' });
    expect(prismaMock.supplierQuote.create.mock.calls[0][0].data).toMatchObject({
      sourceDraftId: 'draft-1',
      sourceDraftItemKey: 'offer-a',
    });

    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue({ ...draft, status: 'CONFIRMED' });
    const repeated = await request(app)
      .post('/api/supplier-quote-drafts/draft-1/confirm')
      .send({ expectedVersion: 1 });
    expect(repeated.status).toBe(200);
    expect(repeated.body.data).toMatchObject({
      reused: true,
      supplierQuoteIds: ['quote-a', 'quote-b'],
      createdSupplierQuoteIds: [],
      reusedSupplierQuoteIds: ['quote-a', 'quote-b'],
    });
    expect(prismaMock.supplierQuote.create).toHaveBeenCalledTimes(2);
  });

  it('exposes the same authorization-aware confirmation command to non-route callers', async () => {
    const item = {
      itemKey: 'offer-a', inquiryItemId: 'item-1', partNumber: 'PN-1', quantity: 2,
      quantityUnit: 'EA', unitPrice: 50, currency: 'USD', leadTimeDays: 5,
    };
    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue({
      id: 'draft-1', emailId: 'email-1', inquiryId: 'inquiry-1', supplierId: 'supplier-1',
      status: 'DRAFT', version: 3, payloadJson: JSON.stringify({ items: [item] }),
    });
    prismaMock.inquiryItem.findMany.mockResolvedValue([
      { id: 'item-1', inquiryId: 'inquiry-1', rfqLineId: null, partNumber: 'PN-1', quantity: 4 },
    ]);
    prismaMock.inquiryItem.findUnique.mockResolvedValue({
      id: 'item-1', inquiryId: 'inquiry-1', rfqLineId: null, partNumber: 'PN-1', quantity: 4,
      inquiry: { id: 'inquiry-1', rfqId: 'rfq-1', supplierId: 'supplier-1' },
    });
    prismaMock.supplierQuoteDraft.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.supplierQuote.findMany.mockResolvedValue([{ id: 'quote-a' }]);
    prismaMock.sourcingAiTask.findFirst.mockResolvedValue({
      actorId: 'sales-1', type: 'supplier_quote_extraction', emailId: 'email-1', inquiryId: 'inquiry-1',
      status: 'COMPLETED', draftId: 'draft-1', sourceFingerprint: 'source-current',
    });

    const result = await confirmSupplierQuoteDraftCommand(
      { id: 'sales-1', email: 'sales@example.com', name: 'Sales', role: 'sales' },
      'draft-1',
      3,
      { sourcingAiTaskId: 'task-1' },
    );

    expect(result).toMatchObject({
      draftId: 'draft-1',
      status: 'CONFIRMED',
      version: 3,
      reused: false,
      supplierQuoteIds: ['quote-a'],
      createdSupplierQuoteIds: ['quote-a'],
      reusedSupplierQuoteIds: [],
    });
    expect(prismaMock.supplierQuote.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.sourcingAiTask.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1', actorId: 'sales-1' },
    }));
    expect(captureSourcingAiTaskSourceFingerprint).toHaveBeenCalledWith('sales-1', 'email-1', 'inquiry-1', prismaMock);
    expect(prismaMock.supplierQuoteDraft.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'draft-1', status: 'DRAFT', version: 3 },
      data: expect.objectContaining({ confirmedById: 'sales-1' }),
    }));
  });

  it('rejects stale, mismatched or unfinished extraction tasks before formal quote creation', async () => {
    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue({
      id: 'draft-1', emailId: 'email-1', inquiryId: 'inquiry-1', supplierId: 'supplier-1',
      status: 'DRAFT', version: 3, payloadJson: JSON.stringify({ items: [] }),
    });
    const actor = { id: 'sales-1', email: 'sales@example.com', name: 'Sales', role: 'sales' };
    const task = {
      actorId: 'sales-1', type: 'supplier_quote_extraction', emailId: 'email-1', inquiryId: 'inquiry-1',
      status: 'COMPLETED', draftId: 'draft-1', sourceFingerprint: 'source-old',
    };
    prismaMock.sourcingAiTask.findFirst.mockResolvedValue(task);
    await expect(confirmSupplierQuoteDraftCommand(actor, 'draft-1', 3, { sourcingAiTaskId: 'task-1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'STATE_CONFLICT' });
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();

    prismaMock.sourcingAiTask.findFirst.mockResolvedValue({ ...task, sourceFingerprint: 'source-current', draftId: 'other-draft' });
    await expect(confirmSupplierQuoteDraftCommand(actor, 'draft-1', 3, { sourcingAiTaskId: 'task-1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'STATE_CONFLICT' });

    prismaMock.sourcingAiTask.findFirst.mockResolvedValue({ ...task, sourceFingerprint: 'source-current', status: 'RUNNING' });
    await expect(confirmSupplierQuoteDraftCommand(actor, 'draft-1', 3, { sourcingAiTaskId: 'task-1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'STATE_CONFLICT' });
    expect(prismaMock.supplierQuoteDraft.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('rechecks command permissions and expected version without creating quotes', async () => {
    await expect(confirmSupplierQuoteDraftCommand(
      { id: 'viewer-1', email: 'viewer@example.com', name: 'Viewer', role: 'viewer' },
      'draft-1',
      1,
    )).rejects.toMatchObject({ statusCode: 403, code: 'AUTH_FORBIDDEN' });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();

    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue({
      id: 'draft-1', emailId: 'email-1', inquiryId: 'inquiry-1', supplierId: 'supplier-1',
      status: 'DRAFT', version: 2, payloadJson: JSON.stringify({ items: [] }),
    });
    await expect(confirmSupplierQuoteDraftCommand(
      { id: 'sales-1', email: 'sales@example.com', name: 'Sales', role: 'sales' },
      'draft-1',
      1,
    )).rejects.toMatchObject({ statusCode: 409, code: 'STATE_CONFLICT' });
    expect(prismaMock.supplierQuoteDraft.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.supplierQuote.create).not.toHaveBeenCalled();
  });

  it('confirms explicitly bound items from a multi-line RFQ without guessing by part number', async () => {
    const firstLine = { id: 'line-1', rfqId: 'rfq-1', partNumber: 'PN-1', quantity: 4, uom: 'EA', alternatePartNumbers: null };
    const secondLine = { id: 'line-2', rfqId: 'rfq-1', partNumber: 'PN-2', quantity: 2, uom: 'EA', alternatePartNumbers: null };
    const items = [
      { id: 'item-1', inquiryId: 'inquiry-1', rfqLineId: 'line-1', partNumber: 'PN-1', quantity: 4 },
      { id: 'item-3', inquiryId: 'inquiry-1', rfqLineId: 'line-2', partNumber: 'PN-2', quantity: 2 },
    ];
    prismaMock.supplierQuoteDraft.findUnique.mockResolvedValue({
      id: 'draft-1', emailId: 'email-1', inquiryId: 'inquiry-1', supplierId: 'supplier-1',
      status: 'DRAFT', version: 2,
      payloadJson: JSON.stringify({ items: [
        { itemKey: 'offer-1', inquiryItemId: 'item-1', partNumber: 'PN-1', quantity: 2, quantityUnit: 'EA', unitPrice: 50, currency: 'USD', leadTimeDays: 5 },
        { itemKey: 'offer-2', inquiryItemId: 'item-3', partNumber: 'PN-2', quantity: 1, quantityUnit: 'EA', unitPrice: 80, currency: 'USD', leadTimeDays: 8 },
      ] }),
    });
    prismaMock.inquiryItem.findMany.mockResolvedValue(items);
    prismaMock.inquiryItem.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      ...items.find((item) => item.id === where.id),
      inquiry: { id: 'inquiry-1', rfqId: 'rfq-1', supplierId: 'supplier-1' },
    }));
    prismaMock.rfqLine.findMany.mockResolvedValue([firstLine, secondLine]);
    prismaMock.rfqLine.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === firstLine.id ? firstLine : secondLine);
    prismaMock.supplierQuoteDraft.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.supplierQuote.findMany.mockResolvedValue([{ id: 'quote-1' }, { id: 'quote-2' }]);

    const response = await request(app).post('/api/supplier-quote-drafts/draft-1/confirm').send({ expectedVersion: 2 });
    expect(response.status).toBe(200);
    expect(response.body.data.supplierQuoteIds).toEqual(['quote-1', 'quote-2']);
    expect(prismaMock.supplierQuote.create.mock.calls.map(([args]) => args.data.rfqLineId)).toEqual(['line-1', 'line-2']);
    expect(prismaMock.rfqLine.findMany).not.toHaveBeenCalled();
  });
});
