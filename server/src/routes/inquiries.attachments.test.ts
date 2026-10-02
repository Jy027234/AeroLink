import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';

const mocks = vi.hoisted(() => ({
  prisma: { $transaction: vi.fn() },
  list: vi.fn(),
  persist: vi.fn(),
}));

describe('inquiry attachment routes', () => {
  let app: express.Application;
  const actor = { id: 'sales-1', email: 'sales@example.test', name: 'Sales', role: 'sales', department: 'Sales' };

  beforeEach(async () => {
    vi.resetModules();
    mocks.prisma.$transaction.mockReset().mockImplementation(async (callback: (tx: unknown) => unknown) => callback(mocks.prisma));
    mocks.list.mockReset().mockResolvedValue([{ id: 'attachment-1', storedObjectId: 'stored-1', filename: 'quote.pdf' }]);
    mocks.persist.mockReset().mockResolvedValue({
      id: 'attachment-1', storedObjectId: 'stored-1', filename: 'quote.pdf', contentType: 'application/pdf',
      sizeBytes: 128, sha256: 'a'.repeat(64), version: 1, downloadUrl: '/api/files/stored-1',
    });
    vi.doMock('../lib/prisma.js', () => ({ default: mocks.prisma }));
    vi.doMock('../lib/inquiryAttachments.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/inquiryAttachments.js')>();
      return {
        ...actual,
        listInquiryAttachmentSnapshots: mocks.list,
        persistInquiryAttachment: mocks.persist,
      };
    });
    const router = (await import('./inquiries.js')).default;
    const { errorHandler } = await import('../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { user: actor }); next(); });
    app.use(router);
    app.use(errorHandler);
  });

  afterEach(() => vi.resetModules());

  it('lists only the inquiry attachment inventory through the scoped service', async () => {
    const response = await request(app).get('/i1/attachments').expect(200);
    expect(response.body.data.attachments).toEqual([{ id: 'attachment-1', storedObjectId: 'stored-1', filename: 'quote.pdf' }]);
    expect(mocks.list).toHaveBeenCalledWith(mocks.prisma, actor, 'i1');
  });

  it('accepts a supported file via multipart, returns the download link and removes the staging copy', async () => {
    let sourcePath = '';
    mocks.persist.mockImplementation(async (input: { sourcePath: string }) => {
      sourcePath = input.sourcePath;
      return {
        id: 'attachment-1', storedObjectId: 'stored-1', filename: 'quote.pdf', contentType: 'application/pdf',
        sizeBytes: 128, sha256: 'a'.repeat(64), version: 1, downloadUrl: '/api/files/stored-1',
      };
    });
    const response = await request(app).post('/i1/attachments')
      .attach('file', Buffer.from('%PDF-1.7\nfixture\n%%EOF'), { filename: 'quote.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(response.body.data.attachment).toMatchObject({
      id: 'attachment-1', storedObjectId: 'stored-1', filename: 'quote.pdf',
      contentType: 'application/pdf', downloadUrl: '/api/files/stored-1',
    });
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({
      inquiryId: 'i1', actor, filename: 'quote.pdf', contentType: 'application/pdf',
    }));
    await expect(fs.access(sourcePath)).rejects.toThrow();
  });

  it('rejects mismatched file extensions and HTML disguised as CSV before persistence', async () => {
    await request(app).post('/i1/attachments')
      .attach('file', Buffer.from('%PDF-1.7\nfixture\n%%EOF'), { filename: 'payload.exe', contentType: 'application/pdf' })
      .expect(400);
    await request(app).post('/i1/attachments')
      .attach('file', Buffer.from('<!doctype html><html>unsafe</html>'), { filename: 'payload.csv', contentType: 'text/csv' })
      .expect(400);
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
