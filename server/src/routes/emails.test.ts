import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

describe('email ingestion routes', () => {
  let app: express.Application;
  let prismaMock: {
    email: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    inquiry: { findUnique: ReturnType<typeof vi.fn> };
    inquiryEmailLink: { upsert: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.resetModules();
    prismaMock = {
      email: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
      },
      inquiry: { findUnique: vi.fn() },
      inquiryEmailLink: { upsert: vi.fn() },
    };
    vi.doMock('../lib/prisma.js', () => ({ default: prismaMock }));

    const router = (await import('./emails.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string; role: string } }).user = {
        id: 'sales-1',
        role: 'sales',
      };
      next();
    });
    app.use('/api/emails', router);
    app.use(errorHandler);
  });

  it('paginates on the server, returns database-wide summary and normalizes unknown types', async () => {
    prismaMock.email.findMany.mockResolvedValue([{
      id: 'email-1',
      from: 'buyer@example.com',
      fromName: 'Buyer',
      subject: 'Unknown classification',
      body: 'Need a quote',
      receivedAt: new Date('2026-07-22T00:00:00.000Z'),
      type: 'LEGACY_VALUE',
      isRead: false,
      attachments: null,
      processingStatus: 'PENDING',
      processedAt: null,
      discardedAt: null,
      rfq: null,
    }]);
    prismaMock.email.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);

    const response = await request(app).get('/api/emails?page=1&limit=20&excludeSpam=true');

    expect(response.status).toBe(200);
    expect(response.body.data[0].type).toBe('standard');
    expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    expect(response.body.summary).toEqual({
      total: 5,
      aog: 1,
      standard: 2,
      inquiry: 1,
      unread: 2,
      spam: 1,
    });
  });

  it('filters by inquiry link and returns thread, link, and structured attachment context', async () => {
    prismaMock.email.findMany.mockResolvedValue([{
      id: 'email-linked',
      from: 'vendor@example.com',
      fromName: 'Vendor',
      subject: 'Quote',
      body: 'Attached',
      receivedAt: new Date('2026-07-22T00:00:00.000Z'),
      type: 'STANDARD',
      isRead: false,
      attachments: null,
      processingStatus: 'PENDING',
      processedAt: null,
      discardedAt: null,
      threadMatchStatus: 'AMBIGUOUS',
      threadMatchReason: 'Several inquiry candidates',
      attachmentStatus: 'STORED',
      attachmentError: null,
      inquiryLinks: [{
        id: 'link-1',
        inquiryId: 'inquiry-1',
        method: 'MANUAL',
        confirmationStatus: 'CONFIRMED',
        confirmedAt: new Date('2026-07-22T00:00:00.000Z'),
        confirmedById: 'sales-1',
        manualReason: null,
        createdAt: new Date('2026-07-22T00:00:00.000Z'),
        inquiry: { id: 'inquiry-1', inquiryNumber: 'INQ-1', supplierId: 'supplier-1' },
      }],
      attachmentRecords: [{
        id: 'attachment-1',
        storedObjectId: 'object-1',
        filename: 'quote.pdf',
        contentType: 'application/pdf',
        sizeBytes: 12,
        sha256: 'a'.repeat(64),
        contentId: null,
        createdAt: new Date('2026-07-22T00:00:00.000Z'),
        storedObject: { id: 'object-1', status: 'AVAILABLE' },
      }],
      rfq: null,
    }]);
    prismaMock.email.count.mockResolvedValue(0);

    const response = await request(app).get('/api/emails?inquiryId=inquiry-1');

    expect(response.status).toBe(200);
    expect(prismaMock.email.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { inquiryLinks: { some: { inquiryId: 'inquiry-1' } } },
    }));
    expect(response.body.data[0]).toMatchObject({
      threadMatchStatus: 'AMBIGUOUS',
      threadMatchReason: 'Several inquiry candidates',
      attachmentStatus: 'STORED',
      inquiryLinks: [{ inquiryId: 'inquiry-1', confirmationStatus: 'CONFIRMED' }],
      attachmentRecords: [{
        id: 'attachment-1',
        downloadUrl: '/api/files/object-1',
      }],
    });
  });

  it('returns only unresolved inquiry matches and preserves filtered pagination with database-wide summary', async () => {
    prismaMock.email.findMany.mockResolvedValue([]);
    prismaMock.email.count.mockResolvedValue(0);

    const response = await request(app).get('/api/emails?needsInquiryMatch=true&page=2&limit=5');
    const where = {
      threadMatchStatus: { in: ['UNMATCHED', 'NEEDS_REVIEW'] },
      inquiryLinks: { none: { confirmationStatus: 'CONFIRMED' } },
    };

    expect(response.status).toBe(200);
    expect(prismaMock.email.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 5, take: 5 }));
    expect(prismaMock.email.count).toHaveBeenNthCalledWith(1, { where });
    expect(response.body.data).toEqual([]);
    expect(response.body.pagination).toEqual({ page: 2, limit: 5, total: 0, totalPages: 0 });
    expect(response.body.summary).toEqual({ total: 0, aog: 0, standard: 0, inquiry: 0, unread: 0, spam: 0 });
  });

  it.each(['', 'yes', '1', 'TRUE'])('rejects invalid needsInquiryMatch=%s values', async (value) => {
    const response = await request(app).get(`/api/emails?needsInquiryMatch=${encodeURIComponent(value)}`);

    expect(response.status).toBe(400);
    expect(prismaMock.email.findMany).not.toHaveBeenCalled();
    expect(prismaMock.email.count).not.toHaveBeenCalled();
  });

  it('rejects needsInquiryMatch=true when inquiryId is also supplied', async () => {
    const response = await request(app).get('/api/emails?needsInquiryMatch=true&inquiryId=inquiry-1');

    expect(response.status).toBe(400);
    expect(prismaMock.email.findMany).not.toHaveBeenCalled();
    expect(prismaMock.email.count).not.toHaveBeenCalled();
  });

  it('does not apply the unresolved match filter when needsInquiryMatch=false', async () => {
    prismaMock.email.findMany.mockResolvedValue([]);
    prismaMock.email.count.mockResolvedValue(0);

    const response = await request(app).get('/api/emails?needsInquiryMatch=false');

    expect(response.status).toBe(200);
    expect(prismaMock.email.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it('confirms a matching sender case-insensitively and requires a reason to override a mismatch', async () => {
    const link = {
      id: 'link-1',
      emailId: 'email-1',
      inquiryId: 'inquiry-1',
      method: 'MANUAL',
      confirmationStatus: 'CONFIRMED',
      confirmedAt: new Date('2026-07-22T00:00:00.000Z'),
      confirmedById: 'sales-1',
      manualReason: null,
      createdAt: new Date('2026-07-22T00:00:00.000Z'),
      inquiry: { id: 'inquiry-1', inquiryNumber: 'INQ-1', supplierId: 'supplier-1' },
    };
    prismaMock.email.findUnique.mockResolvedValue({ id: 'email-1', from: 'Vendor <Sales@Example.com>' });
    prismaMock.inquiry.findUnique.mockResolvedValue({
      id: 'inquiry-1',
      supplierId: 'supplier-1',
      supplier: { email: 'sales@example.com' },
    });
    prismaMock.inquiryEmailLink.upsert.mockResolvedValue(link);

    const matching = await request(app)
      .post('/api/emails/email-1/inquiry-links')
      .send({ inquiryId: 'inquiry-1' });
    expect(matching.status).toBe(200);
    expect(matching.body.data).toEqual({
      id: link.id,
      emailId: link.emailId,
      inquiryId: link.inquiryId,
      method: link.method,
      confirmationStatus: link.confirmationStatus,
      confirmedAt: link.confirmedAt.toISOString(),
      confirmedById: link.confirmedById,
      manualReason: link.manualReason,
      createdAt: link.createdAt.toISOString(),
      inquiry: link.inquiry,
    });
    expect(prismaMock.inquiryEmailLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        method: 'MANUAL',
        confirmationStatus: 'CONFIRMED',
        confirmedById: 'sales-1',
        manualReason: null,
      }),
    }));

    prismaMock.email.findMany.mockImplementation(async ({ where }) => (
      where.inquiryLinks?.none?.confirmationStatus === 'CONFIRMED' && link.confirmationStatus === 'CONFIRMED'
        ? []
        : [{ id: link.emailId }]
    ));
    prismaMock.email.count.mockResolvedValue(0);
    const unmatched = await request(app).get('/api/emails?needsInquiryMatch=true');
    expect(unmatched.status).toBe(200);
    expect(unmatched.body.data).toEqual([]);
    expect(prismaMock.email.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ inquiryLinks: { none: { confirmationStatus: 'CONFIRMED' } } }),
    }));

    prismaMock.inquiryEmailLink.upsert.mockClear();
    prismaMock.email.findUnique.mockResolvedValue({ id: 'email-1', from: 'other@example.com' });
    const denied = await request(app)
      .post('/api/emails/email-1/inquiry-links')
      .send({ inquiryId: 'inquiry-1' });
    expect(denied.status).toBe(409);
    expect(prismaMock.inquiryEmailLink.upsert).not.toHaveBeenCalled();

    const overridden = await request(app)
      .post('/api/emails/email-1/inquiry-links')
      .send({ inquiryId: 'inquiry-1', manualReason: 'Supplier used a forwarding contact.' });
    expect(overridden.status).toBe(200);
    expect(prismaMock.inquiryEmailLink.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ manualReason: 'Supplier used a forwarding contact.' }),
      update: expect.objectContaining({ manualReason: 'Supplier used a forwarding contact.' }),
    }));
  });

  it('persists discard state and prevents discarding an email already linked to an RFQ', async () => {
    const baseEmail = {
      id: 'email-2',
      from: 'buyer@example.com',
      fromName: 'Buyer',
      subject: 'RFQ',
      body: 'PN ABC-1',
      receivedAt: new Date('2026-07-22T00:00:00.000Z'),
      type: 'INQUIRY',
      isRead: false,
      attachments: null,
      processingStatus: 'PENDING',
      processedAt: null,
      discardedAt: null,
    };
    prismaMock.email.findUnique.mockResolvedValueOnce({ ...baseEmail, rfq: null });
    prismaMock.email.update.mockImplementation(async ({ data }) => ({ ...baseEmail, ...data }));

    const discarded = await request(app).patch('/api/emails/email-2/discard');
    expect(discarded.status).toBe(200);
    expect(discarded.body.data.processingStatus).toBe('discarded');
    expect(prismaMock.email.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ processingStatus: 'DISCARDED', isRead: true }),
    }));

    prismaMock.email.findUnique.mockResolvedValueOnce({ ...baseEmail, rfq: { id: 'rfq-1' } });
    const conflict = await request(app).patch('/api/emails/email-2/discard');
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('STATE_CONFLICT');
  });
});
