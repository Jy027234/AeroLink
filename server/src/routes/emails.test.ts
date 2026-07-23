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
